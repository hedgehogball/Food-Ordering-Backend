'use strict';
const crypto = require('node:crypto');
const { fail, present } = require('./dining/domain');
const { decode, transaction } = require('./database');
const { createAcceptance } = require('./acceptance');
const DAY = 86400000;
const OFFSET = 8 * 3600000;
const STAGES = ['new', 'cooking', 'ready'];
function defaultSettings() {
  return { version: 1, open: true, useHours: false, openTime: '10:00', closeTime: '23:00', weekdays: [1, 2, 3, 4, 5, 6, 7], leadMinutes: 15, advanceDays: 7 };
}
function validateSettings(input) {
  if (!input || typeof input.open !== 'boolean' || typeof input.useHours !== 'boolean') fail('SETTINGS_INVALID', '请检查营业设置');
  const time = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (!time(input.openTime) || !time(input.closeTime) || (input.useHours && input.openTime === input.closeTime)) fail('SETTINGS_INVALID', '请设置有效的开始与结束营业时间');
  if (!Array.isArray(input.weekdays) || !input.weekdays.length || input.weekdays.length > 7 || input.weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7) || new Set(input.weekdays).size !== input.weekdays.length) fail('SETTINGS_INVALID', '请选择有效营业日期');
  if (!Number.isInteger(input.leadMinutes) || input.leadMinutes < 0 || input.leadMinutes > 180 || !Number.isInteger(input.advanceDays) || input.advanceDays < 1 || input.advanceDays > 7) fail('SETTINGS_INVALID', '取餐准备时间为 0–180 分钟，预约范围为 1–7 天');
  return { open: input.open, useHours: input.useHours, openTime: input.openTime, closeTime: input.closeTime, weekdays: [...input.weekdays].sort((a, b) => a - b), leadMinutes: input.leadMinutes, advanceDays: input.advanceDays };
}
function accepting(settings, now = Date.now()) {
  if (!settings.open) return false;
  if (!settings.useHours) return true;
  const local = new Date(now + OFFSET);
  const day = local.getUTCDay() || 7;
  const previousDay = day === 1 ? 7 : day - 1;
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const start = minutes(settings.openTime), end = minutes(settings.closeTime);
  if (start < end) return settings.weekdays.includes(day) && minute >= start && minute < end;
  // An overnight service belongs to the weekday on which it starts.
  return (minute >= start && settings.weekdays.includes(day)) || (minute < end && settings.weekdays.includes(previousDay));
}
function dateRange(from, to) {
  const parse = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('DATE_INVALID', '请选择有效统计日期');
    const date = new Date(value + 'T00:00:00+08:00');
    if (!Number.isFinite(date.getTime()) || new Date(date.getTime() + OFFSET).toISOString().slice(0, 10) !== value) fail('DATE_INVALID', '请选择有效统计日期');
    return date.getTime();
  };
  const start = parse(from), end = parse(to) + DAY;
  if (end <= start || end - start > 31 * DAY) fail('DATE_INVALID', '每次最多查询连续 31 天');
  return { start, end };
}
function createRoles({ appId, cashierIds = [], cashierOpenids = [], ownerIds = [] }) {
  return (id, context = {}) => {
    const trustedId = context.OPENID ? crypto.createHash('sha256').update(appId + ':' + context.OPENID).digest('hex') : id;
    if (ownerIds.includes(trustedId)) return 'owner';
    if (cashierIds.includes(trustedId) || cashierOpenids.includes(context.OPENID)) return 'cashier';
    return 'customer';
  };
}
function stage(order) { return order.fulfillment || 'new'; }
function advanceOrder(order, expected, next, now) {
  if (!['new', 'cooking'].includes(expected) || STAGES.indexOf(next) !== STAGES.indexOf(expected) + 1) fail('STAGE_INVALID', '请按接单、制作、出餐顺序操作');
  const current = stage(order);
  if (current === next) return false; // Lost-response retry remains safe.
  if (current !== expected) fail('STATE_CHANGED', '制作状态已变化，请刷新后重试');
  order.fulfillment = next; order.fulfillmentUpdatedAt = now;
  return true;
}
function ticket(kind, source, session, now, reprint = false) {
  const id = crypto.randomUUID();
  const sourceId = kind === 'dinein' ? `${session.id}:${source.id}` : source.id;
  const localTime = timestamp => new Date(timestamp + OFFSET).toISOString().replace('T', ' ').slice(0, 16);
  return { id, kind, sourceId, status: 'queued', createdAt: now,
    lines: ['链家烧烤 · 厨房小票', reprint ? '补打小票（请核对，避免重复制作）' : '新订单',
      kind === 'dinein' ? `桌号：${session.table} 桌 · ${source.guest || '食客'}` : `自取号：${source.pickup} · ${source.name}`,
      `下单：${localTime(source.createdAt)}`, ...(kind === 'takeaway' ? [`取餐：${localTime(source.pickupAt)}`] : []),
      ...source.items.map(item => `${item.name} ${item.option} × ${item.quantity}${item.unit}`),
      `备注：${source.note || '无'}`, `金额：¥${(source.total / 100).toFixed(2)}`, `订单：${source.id}`] };
}
function summarizeStats(submitted, paid, start, end, truncated = false) {
  const inRange = time => Number.isSafeInteger(time) && time >= start && time < end;
  const orders = submitted.filter(entry => inRange(entry.order.createdAt));
  const receipts = paid.filter(entry => inRange(entry.paidAt));
  const dishes = new Map();
  for (const { order } of orders) for (const item of order.items) {
    const key = item.dishId || item.name;
    const aggregate = dishes.get(key) || { name: item.name, quantity: 0, total: 0 };
    aggregate.quantity += item.quantity; aggregate.total += item.price * item.quantity;
    dishes.set(key, aggregate);
  }
  const sum = rows => rows.reduce((total, row) => total + row.total, 0);
  return { submittedOrders: orders.length, submittedTotal: orders.reduce((total, entry) => total + entry.order.total, 0),
    paidOrders: receipts.length, paidTotal: sum(receipts), dineinPaidTotal: sum(receipts.filter(row => row.mode === 'dinein')),
    takeawayPaidTotal: sum(receipts.filter(row => row.mode === 'takeaway')), pendingOrders: orders.filter(entry => !entry.paid).length,
    topDishes: [...dishes.values()].sort((a, b) => b.quantity - a.quantity || b.total - a.total),
    receipts: receipts.sort((a, b) => b.paidAt - a.paidAt), truncated };
}
function createOperations(pool, { roleOf = () => 'customer', now = () => Date.now() } = {}) {
  const acceptance = createAcceptance(pool, { now });
  async function readSettings(sql = pool, lock = false) {
    const [rows] = await sql.execute('SELECT document FROM lj_settings WHERE id=?' + (lock ? ' FOR UPDATE' : ''), ['shop']);
    return rows.length ? { ...defaultSettings(), ...decode(rows[0].document) } : defaultSettings();
  }
  async function beforeNewSubmit(event, tx, timestamp = now()) {
    const settings = await readSettings(tx && tx.sql ? tx.sql : (tx || pool), true);
    if (!accepting(settings, timestamp)) fail('SHOP_CLOSED', '门店暂未营业或已暂停接单，请联系店员');
    if (event.pickupAt !== undefined) {
      if (!Number.isSafeInteger(event.pickupAt) || event.pickupAt < timestamp + settings.leadMinutes * 60000 || event.pickupAt > timestamp + settings.advanceDays * DAY) fail('PICKUP_INVALID', `请预约至少 ${settings.leadMinutes} 分钟后、${settings.advanceDays} 天内取餐`);
      if (!accepting(settings, event.pickupAt)) fail('PICKUP_INVALID', '所选取餐时间不在营业时段，请重新选择');
    }
  }
  async function enqueue(sql, kind, source, session, reprint = false, requestId) {
    const job = ticket(kind, source, session, now(), reprint);
    const sourceKey = `${kind}:${job.sourceId}` + (reprint ? `:${requestId}` : '');
    await sql.execute('INSERT IGNORE INTO lj_print_jobs (id,source_key,status,created_at,document) VALUES (?,?,?,?,?)', [job.id, sourceKey, job.status, job.createdAt, JSON.stringify(job)]);
    const [rows] = await sql.execute('SELECT document FROM lj_print_jobs WHERE source_key=?', [sourceKey]);
    return decode(rows[0].document);
  }
  async function discoverTickets(sessions, pickups) {
    const candidates = [...sessions.flatMap(session => session.orders.map(order => ticket('dinein', order, session, now()))), ...pickups.map(order => ticket('takeaway', order, null, now()))];
    if (!candidates.length) return;
    const known = new Set();
    for (let offset = 0; offset < candidates.length; offset += 500) {
      const keys = candidates.slice(offset, offset + 500).map(job => `${job.kind}:${job.sourceId}`);
      const [rows] = await pool.execute(`SELECT source_key FROM lj_print_jobs WHERE source_key IN (${keys.map(() => '?').join(',')})`, keys);
      rows.forEach(row => known.add(row.source_key));
    }
    const missing = candidates.filter(job => !known.has(`${job.kind}:${job.sourceId}`));
    if (!missing.length) return;
    await transaction(pool, async sql => {
      for (let offset = 0; offset < missing.length; offset += 50) {
        const jobs = missing.slice(offset, offset + 50);
        await sql.execute(`INSERT IGNORE INTO lj_print_jobs (id,source_key,status,created_at,document) VALUES ${jobs.map(() => '(?,?,?,?,?)').join(',')}`, jobs.flatMap(job => [job.id, `${job.kind}:${job.sourceId}`, job.status, job.createdAt, JSON.stringify(job)]));
      }
    });
  }
  async function dashboard(role) {
    const [diningRows] = await pool.query("SELECT s.document FROM lj_dining_tables t JOIN lj_dining_sessions s ON s.id=CONVERT(JSON_UNQUOTE(JSON_EXTRACT(t.document,'$.sessionId')) USING ascii) COLLATE ascii_bin WHERE t.id BETWEEN '01' AND '24' ORDER BY t.id");
    const sessions = diningRows.map(row => decode(row.document)).filter(session => session.status !== 'paid');
    let tablesTruncated = false;
    // The staff queue shows the oldest actionable batches first; completed kitchen batches
    // remain in the original bill and are still available through staffGet.
    const workSessions = sessions.map(session => {
      const active = session.orders.filter(order => stage(order) !== 'ready');
      if (active.length > 20) tablesTruncated = true;
      return { ...session, orders: active.slice(0, 20) };
    });
    const [pickupRows] = await pool.query("SELECT document FROM lj_takeaway WHERE JSON_UNQUOTE(JSON_EXTRACT(document,'$.order.status'))='pending' ORDER BY created_at LIMIT 201");
    const pickups = pickupRows.slice(0, 200).map(row => ({ ...decode(row.document).order, fulfillment: stage(decode(row.document).order) }));
    // Queue creation is durable and source-unique even when multiple staff refresh together.
    await discoverTickets(workSessions, pickups);
    const [jobs] = await pool.query("SELECT document FROM lj_print_jobs ORDER BY (status='queued') DESC, CASE WHEN status='queued' THEN created_at ELSE -created_at END ASC LIMIT 201");
    const settings = await readSettings();
    const stripImages = order => ({ ...order, items: order.items.map(({ image, ...item }) => item) });
    const response = { role, settings, acceptingNow: accepting(settings, now()), tables: workSessions.map(session => {
      const result = present(session, '', true); result.orders = result.orders.map(stripImages); return result;
    }), pickupOrders: pickups.map(stripImages), newOrderIds: [...workSessions.flatMap(session => session.orders.filter(order => stage(order) === 'new').map(order => `dinein:${session.id}:${order.id}`)), ...pickups.filter(order => stage(order) === 'new').map(order => `takeaway:${order.id}`)],
      printJobs: jobs.slice(0, 200).map(row => { const { lines, acknowledgedBy, ...job } = decode(row.document); return job; }), truncated: tablesTruncated || pickupRows.length > 200 || jobs.length > 200 };
    // Keep the cloud response bounded as well as frontend setData. Full kitchen item
    // snapshots are reachable through getTicket even when the queue is very large.
    const candidates = [...response.tables.flatMap(session => session.orders.map(order => ({ session, order }))), ...response.pickupOrders.map(order => ({ session: null, order }))].sort((a, b) => a.order.createdAt - b.order.createdAt);
    response.tables.forEach(session => { session.orders = []; }); response.pickupOrders = []; response.newOrderIds = [];
    let bytes = Buffer.byteLength(JSON.stringify(response), 'utf8');
    for (const candidate of candidates) {
      const key = candidate.session ? `dinein:${candidate.session.id}:${candidate.order.id}` : `takeaway:${candidate.order.id}`;
      const size = Buffer.byteLength(JSON.stringify(candidate.order), 'utf8') + Buffer.byteLength(key, 'utf8') + 20;
      if (bytes + size > 600000) { response.truncated = true; continue; }
      bytes += size;
      if (candidate.session) candidate.session.orders.push(candidate.order); else response.pickupOrders.push(candidate.order);
      if (stage(candidate.order) === 'new') response.newOrderIds.push(key);
    }
    return response;
  }
  async function handle(event, actor, context = {}) {
    if (event.action === 'publicSettings') {
      const settings = await readSettings(); return { settings, acceptingNow: accepting(settings, now()) };
    }
    const role = roleOf(actor, context);
    if (!['cashier', 'owner'].includes(role)) fail('FORBIDDEN', '仅门店店员可以使用此功能');
    if (['acceptanceGet', 'acceptanceSave'].includes(event.action)) return acceptance.handle(event, actor, role);
    if (event.action === 'dashboard') return dashboard(role);
    if (event.action === 'saveSettings') {
      if (role !== 'owner') fail('FORBIDDEN', '仅店主可以修改营业设置');
      const next = validateSettings(event.settings);
      return transaction(pool, async sql => {
        const previous = await readSettings(sql, true);
        if (event.expectedVersion !== previous.version) fail('SETTINGS_CHANGED', '营业设置已更新，请刷新后重新修改');
        const settings = { ...next, version: previous.version + 1 };
        await sql.execute('UPDATE lj_settings SET document=? WHERE id=?', [JSON.stringify(settings), 'shop']);
        return { settings, acceptingNow: accepting(settings, now()) };
      });
    }
    if (['advance', 'requestPrint'].includes(event.action)) {
      if (!['dinein', 'takeaway'].includes(event.kind)) fail('ORDER_INVALID', '请选择有效订单');
      if (event.reprint !== undefined && typeof event.reprint !== 'boolean') fail('PRINT_INVALID', '请检查打印参数');
      if (event.reprint === true && (typeof event.requestId !== 'string' || !/^[a-zA-Z0-9:_-]{8,100}$/.test(event.requestId))) fail('TOKEN_INVALID', '补打小票需要有效请求标识');
      return transaction(pool, async sql => {
        let source, session, doc;
        if (event.kind === 'dinein') {
          const [rows] = await sql.execute('SELECT document FROM lj_dining_sessions WHERE id=? FOR UPDATE', [String(event.sessionId || '')]);
          if (!rows.length) fail('NOT_FOUND', '订单不存在');
          session = decode(rows[0].document); source = session.orders.find(order => order.id === event.orderId);
        } else {
          const [rows] = await sql.execute('SELECT document FROM lj_takeaway WHERE id=? FOR UPDATE', [String(event.orderId || '')]);
          if (!rows.length) fail('NOT_FOUND', '订单不存在');
          doc = decode(rows[0].document); source = doc.order;
        }
        if (!source) fail('NOT_FOUND', '订单不存在');
        if (event.action === 'requestPrint') return { job: await enqueue(sql, event.kind, source, session, event.reprint === true, event.requestId) };
        if ((session && session.status === 'paid') || (doc && source.status === 'completed')) fail('STATE_CHANGED', '订单已结束，请刷新');
        if (advanceOrder(source, event.expectedStage, event.nextStage, now())) {
          if (session) {
            session.revision += 1; session.updatedAt = now();
            await sql.execute('UPDATE lj_dining_sessions SET document=? WHERE id=?', [JSON.stringify(session), session.id]);
          } else await sql.execute('UPDATE lj_takeaway SET document=? WHERE id=?', [JSON.stringify(doc), source.id]);
        }
        return { fulfillment: stage(source), orderId: source.id };
      });
    }
    if (['getPrintJob', 'getTicket'].includes(event.action)) {
      const [rows] = await pool.execute('SELECT document FROM lj_print_jobs WHERE id=?', [String(event.jobId || '')]);
      if (!rows.length) fail('NOT_FOUND', '小票任务不存在');
      const { acknowledgedBy, ...job } = decode(rows[0].document); return { job };
    }
    if (event.action === 'markPrinted') {
      return transaction(pool, async sql => {
        const [rows] = await sql.execute('SELECT document FROM lj_print_jobs WHERE id=? FOR UPDATE', [String(event.jobId || '')]);
        if (!rows.length) fail('NOT_FOUND', '小票任务不存在');
        const job = decode(rows[0].document);
        if (job.status !== 'printed') {
          job.status = 'printed'; job.printedAt = now(); job.acknowledgedBy = actor;
          await sql.execute('UPDATE lj_print_jobs SET status=?,document=? WHERE id=?', ['printed', JSON.stringify(job), job.id]);
        }
        const { acknowledgedBy, ...safe } = job; return { job: safe };
      });
    }
    if (event.action === 'stats') {
      const { start, end } = dateRange(event.dateFrom, event.dateTo);
      const report = summarizeStats([], [], start, end);
      const deadline = Date.now() + 5000;
      const dishes = new Map();
      const includeOrder = (order, paid) => {
        if (order.createdAt < start || order.createdAt >= end) return;
        report.submittedOrders++; report.submittedTotal += order.total;
        if (!paid) report.pendingOrders++;
        for (const item of order.items) {
          const key = item.dishId || item.name;
          const dish = dishes.get(key) || { name: item.name, quantity: 0, total: 0 };
          dish.quantity += item.quantity; dish.total += item.quantity * item.price; dishes.set(key, dish);
        }
      };
      // Read small pages rather than retaining potentially 2,000 large JSON bills in memory.
      for (const [table, filter, params, kind] of [
        ['lj_dining_sessions', 'created_at<? AND updated_at>=?', [end, start], 'dinein'],
        ['lj_takeaway', 'created_at>=? AND created_at<?', [start, end], 'takeaway']
      ]) {
        let lastId = '';
        for (let count = 0; count < 2000; count += 5) {
          if (Date.now() > deadline) { report.truncated = true; break; }
          const [rows] = await pool.execute(`SELECT id,document FROM ${table} WHERE ${filter} AND id>? ORDER BY id LIMIT 5`, [...params, lastId]);
          for (const row of rows) {
            const doc = decode(row.document);
            if (kind === 'dinein') doc.orders.forEach(order => includeOrder(order, doc.status === 'paid'));
            else includeOrder(doc.order, doc.order.status === 'completed');
          }
          if (rows.length < 5) break;
          lastId = rows[rows.length - 1].id;
          if (count === 1995) {
            const [remaining] = await pool.execute(`SELECT id FROM ${table} WHERE ${filter} AND id>? LIMIT 1`, [...params, lastId]);
            if (remaining.length) report.truncated = true;
          }
        }
      }
      for (const [table, kind, totalPath] of [['lj_dining_sessions', 'dinein', '$.total'], ['lj_takeaway', 'takeaway', '$.order.total']]) {
        const [aggregate] = await pool.execute(`SELECT COUNT(*) AS count, COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(document,'${totalPath}')) AS UNSIGNED)),0) AS total FROM ${table} WHERE paid_at>=? AND paid_at<?`, [start, end]);
        report.paidOrders += Number(aggregate[0].count); report.paidTotal += Number(aggregate[0].total);
        report[kind === 'dinein' ? 'dineinPaidTotal' : 'takeawayPaidTotal'] = Number(aggregate[0].total);
        const fields = kind === 'dinein' ? "id, paid_at, JSON_UNQUOTE(JSON_EXTRACT(document,'$.table')) AS label" : "id, paid_at, JSON_UNQUOTE(JSON_EXTRACT(document,'$.order.pickup')) AS label";
        const [rows] = await pool.execute(`SELECT ${fields}, CAST(JSON_UNQUOTE(JSON_EXTRACT(document,'${totalPath}')) AS UNSIGNED) AS total FROM ${table} WHERE paid_at>=? AND paid_at<? ORDER BY paid_at DESC LIMIT 201`, [start, end]);
        if (rows.length > 200) report.truncated = true;
        report.receipts.push(...rows.slice(0, 200).map(row => ({ id: row.id, mode: kind, table: kind === 'dinein' ? row.label : '', pickup: kind === 'takeaway' ? row.label : '', total: Number(row.total), paidAt: Number(row.paid_at) })));
      }
      report.receipts.sort((a, b) => b.paidAt - a.paidAt);
      if (report.receipts.length > 200) report.truncated = true;
      report.receipts = report.receipts.slice(0, 200);
      report.topDishes = [...dishes.values()].sort((a, b) => b.quantity - a.quantity || b.total - a.total).slice(0, 100);
      return report;
    }
    fail('ACTION_INVALID', '不支持的操作');
  }
  return { handle, beforeNewSubmit };
}
module.exports = { createOperations, createRoles, defaultSettings, validateSettings, accepting, dateRange, advanceOrder, ticket, summarizeStats };
