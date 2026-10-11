'use strict';
const crypto = require('node:crypto');
const { fail, newSession, join, submit } = require('./dining/domain');
const { decode, transaction } = require('./database');
function validate(event, actor, now) {
  const name = typeof event.name === 'string' ? event.name.trim() : '';
  const phone = typeof event.phone === 'string' ? event.phone.trim() : '';
  if (!name || name.length > 20) fail('NAME_INVALID', '请填写取餐人姓名（20 字以内）');
  if (!/^1[3-9]\d{9}$/.test(phone)) fail('PHONE_INVALID', '请填写正确的手机号码');
  if (!Number.isSafeInteger(event.pickupAt) || event.pickupAt <= now || event.pickupAt > now + 7 * 86400000) fail('PICKUP_INVALID', '请选择未来 7 天内的取餐时间');
  const session = newSession('01', 'takeaway', now);
  join(session, actor); submit(session, actor, event, now);
  const priced = session.orders[0];
  const id = crypto.randomUUID();
  return { id, createdAt: now, mode: 'takeaway', table: '', name, phone, pickupAt: event.pickupAt,
    note: priced.note, items: priced.items, subtotal: priced.total, packing: 0, total: priced.total,
    status: 'pending', fulfillment: 'new', demo: false, pickup: id.slice(0, 8).toUpperCase(), settledAt: null };
}
function hash(event) {
  return crypto.createHash('sha256').update(JSON.stringify([event.items, event.note, event.expectedTotal, event.name, event.phone, event.pickupAt])).digest('hex');
}
function createTakeaway(pool, staffIds = [], options = {}) {
  return async (event, actor) => {
    if (event.action === 'list') {
      const [rows] = await pool.execute('SELECT document FROM lj_takeaway WHERE actor=? ORDER BY created_at DESC LIMIT 200', [actor]);
      return { orders: rows.map(row => decode(row.document).order) };
    }
    if (event.action === 'staffList') {
      if (!staffIds.includes(actor)) fail('FORBIDDEN', '仅门店店员可以查看待取餐订单');
      const [rows] = await pool.query("SELECT document FROM lj_takeaway WHERE JSON_UNQUOTE(JSON_EXTRACT(document,'$.order.status'))='pending' ORDER BY created_at LIMIT 200");
      return { orders: rows.map(row => decode(row.document).order) };
    }
    if (event.action === 'complete') {
      if (!staffIds.includes(actor)) fail('FORBIDDEN', '仅门店店员可以确认收款及取餐');
      return transaction(pool, async connection => {
        const [rows] = await connection.execute('SELECT document FROM lj_takeaway WHERE id=? FOR UPDATE', [String(event.id || '')]);
        if (!rows.length) fail('NOT_FOUND', '订单不存在');
        const doc = decode(rows[0].document);
        if (event.expectedTotal !== doc.order.total) fail('PRICE_CHANGED', '请刷新并核对订单金额');
        if (doc.order.status !== 'completed') {
          doc.order.status = 'completed'; doc.order.settledAt = Date.now();
          await connection.execute('UPDATE lj_takeaway SET document=? WHERE id=?', [JSON.stringify(doc), doc.order.id]);
        }
        return { order: doc.order };
      });
    }
    if (event.action !== 'submit') fail('ACTION_INVALID', '不支持的操作');
    if (typeof event.requestId !== 'string' || !/^[a-zA-Z0-9:_-]{8,100}$/.test(event.requestId)) fail('TOKEN_INVALID', '请重新提交');
    const fingerprint = hash(event);
    const existing = async (sql = pool) => {
      const [rows] = await sql.execute('SELECT document FROM lj_takeaway WHERE actor=? AND request_id=?', [actor, event.requestId]);
      if (!rows.length) return null;
      const doc = decode(rows[0].document);
      if (doc.fingerprint !== fingerprint) fail('TOKEN_REUSED', '提交内容已变化，请核对订单');
      return doc.order;
    };
    const previous = await existing();
    if (previous) return { order: previous };
    try {
      return await transaction(pool, async sql => {
        const recovered = await existing(sql);
        if (recovered) return { order: recovered };
        const now = Date.now();
        if (options.beforeNewSubmit) await options.beforeNewSubmit(event, sql, now);
        const order = validate(event, actor, now);
        await sql.execute('INSERT INTO lj_takeaway (id,actor,request_id,created_at,document) VALUES (?,?,?,?,?)', [order.id, actor, event.requestId, order.createdAt, JSON.stringify({ fingerprint, order })]);
        return { order };
      });
    } catch (error) { if (error.code !== 'ER_DUP_ENTRY') throw error; return { order: await existing() }; }
  };
}
module.exports = { createTakeaway, validate };
