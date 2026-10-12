'use strict';
const crypto = require('node:crypto');
const { fail } = require('./dining/domain');
const { decode, transaction } = require('./database');

// These are human field checks. Automated tests must never mark an item passed.
const CHECKS = [
  { id: 'identity', title: '两台手机登录与权限', instructions: '分别用店主和顾客微信登录两台手机；顾客只能看到自己的订单，不能打开工作台、收银或验收数据；店主退出重登后仍有权限。记录设备与结果，不记录密码或 OpenID。' },
  { id: 'table-access', title: '24 桌扫码、换桌与隔离', instructions: '真机检查选桌为 01–24，25–36 无法加入；按桌码或预览场景进入指定桌号。两台手机加入不同桌，下单后互不可见；换桌确认后只显示新桌账单。' },
  { id: 'same-table', title: '同桌多人同时加菜', instructions: '两台手机加入同一桌并同时提交不同菜品，刷新两端账单；数量、金额和食客记录均正确，既不丢单也不重复。核对 1.3 元菜品 10 串起购及 ±10 串。' },
  { id: 'retry', title: '断网重试与重进恢复', instructions: '在测试订单提交后立即断网，再联网重试、退出并重进；先核对原单，确认同一提交只产生一份订单，账单与购物车恢复符合预期。' },
  { id: 'takeaway', title: '到店自取全流程', instructions: '用真机选择自取，检查取餐时间和联系信息，提交一份标注“验收”的订单；店员接单、出餐，实际交付后完成取餐。核对不收打包费及顾客订单记录。' },
  { id: 'new-order', title: '新单提示与手机震动', instructions: '专用值守手机保持工作台前台开启，另一手机提交测试订单；确认自动刷新、醒目新单提示和震动，刷新或重进不会把旧单误报成新单。切到后台后需回到工作台核对漏看的订单。' },
  { id: 'kitchen-ticket', title: '厨房状态与人工小票', instructions: '测试单依次接单、制作、出餐；核对厨房小票桌号/自取号、菜品、数量、口味、备注和金额。未购买打印机，实际抄写或人工登记后再确认小票；重复点击不重复制作。' },
  { id: 'checkout', title: '现场收款与营业统计', instructions: '以一笔已实际收款的验收订单验证堂食结账或自取完成；核对实收、账单、历史记录和当天统计一致。未收款不得确认收银，重复确认不能重复记收入，本版不接微信在线支付。' },
  { id: 'duty-device', title: '专用手机接单值守', instructions: '指定值班人员与交接人员，确认专用手机接电、网络稳定、工作台保持前台并能提示和震动；开店核单、营业期间值守、交班核对未完成单、关店核单。备注填写设备和负责人。' },
  { id: 'maintenance', title: '备份、恢复与数据维护', instructions: '确认云数据库备份计划、保留期限和维护负责人；执行一次备份，将备份恢复到独立测试数据库并验证 24 桌、用户、订单、小票及验收记录。记录备份时间、恢复结果和数据保留方案，不在生产库做恢复演练。' }
];
const STATUSES = ['pending', 'pass', 'fail'];

function defaultAcceptance() {
  return { version: 1, evidenceType: 'manual', updatedAt: 0,
    items: CHECKS.map(check => ({ ...check, status: 'pending', notes: '', serverConfirmedAt: 0, verifiedBy: '' })),
    audit: [], duty: { device: '专用手机', plan: '营业时保持工作台前台开启，确认新单提示和震动', confirmedAt: 0 } };
}
function presentAcceptance(document) {
  const result = defaultAcceptance();
  if (document) {
    result.version = document.version;
    result.updatedAt = document.updatedAt || 0;
    for (const item of result.items) {
      const saved = (document.items || []).find(entry => entry.id === item.id);
      if (saved) {
        item.status = STATUSES.includes(saved.status) ? saved.status : 'pending';
        item.notes = String(saved.notes || '').slice(0, 200);
        item.serverConfirmedAt = saved.serverConfirmedAt || 0;
        item.verifiedBy = saved.verifiedBy || '';
      }
    }
    result.audit = (document.audit || []).slice(-50);
    result.duty.confirmedAt = result.items.find(item => item.id === 'duty-device' && item.status === 'pass')?.serverConfirmedAt || 0;
  }
  const count = status => result.items.filter(item => item.status === status).length;
  return { acceptance: result, summary: { total: CHECKS.length, passed: count('pass'), failed: count('fail'), pending: count('pending') } };
}
function validateSave(event) {
  if (!CHECKS.some(item => item.id === event.itemId) || !STATUSES.includes(event.status)) fail('ACCEPTANCE_INVALID', '请选择有效验收项目和状态');
  if (!Number.isSafeInteger(event.expectedVersion) || event.expectedVersion < 1) fail('ACCEPTANCE_INVALID', '请先刷新验收进度');
  if (typeof event.notes !== 'string' || event.notes.length > 200) fail('ACCEPTANCE_INVALID', '验收备注最多 200 字');
  const notes = event.notes.trim();
  if (event.status !== 'pending' && (event.manualConfirmation !== true || !notes)) fail('MANUAL_EVIDENCE_REQUIRED', '请实际执行验收，填写结果并确认后再保存');
  return notes;
}
function createAcceptance(pool, { now = () => Date.now() } = {}) {
  async function read(sql = pool, lock = false) {
    const [rows] = await sql.execute('SELECT document FROM lj_settings WHERE id=?' + (lock ? ' FOR UPDATE' : ''), ['acceptance']);
    return rows.length ? decode(rows[0].document) : defaultAcceptance();
  }
  async function handle(event, actor, role) {
    if (!['owner', 'cashier'].includes(role)) fail('FORBIDDEN', '仅门店店员可以查看验收进度');
    if (event.action === 'acceptanceGet') return { role, ...presentAcceptance(await read()), technicalValidation: require('./verification-report.json') };
    if (event.action !== 'acceptanceSave') fail('ACTION_INVALID', '不支持的验收操作');
    if (role !== 'owner') fail('FORBIDDEN', '仅店主可以确认验收结果');
    if (typeof actor !== 'string' || !/^[a-f0-9]{64}$/.test(actor)) fail('UNAUTHENTICATED', '请通过微信登录后再确认验收');
    const notes = validateSave(event);
    return transaction(pool, async sql => {
      // A missing record is initialized inside the transaction so two first saves serialize.
      await sql.execute('INSERT IGNORE INTO lj_settings (id,document) VALUES (?,?)', ['acceptance', JSON.stringify(defaultAcceptance())]);
      const previous = await read(sql, true);
      if (event.expectedVersion !== previous.version) fail('ACCEPTANCE_CHANGED', '验收进度已更新，请刷新后核对再保存');
      const { acceptance } = presentAcceptance(previous);
      const item = acceptance.items.find(entry => entry.id === event.itemId);
      const timestamp = now();
      // The server creates an audit pseudonym; no OpenID or caller-provided verifier is exposed.
      const verifier = 'owner:' + crypto.createHash('sha256').update(actor).digest('hex').slice(0, 12);
      item.status = event.status; item.notes = notes;
      item.serverConfirmedAt = event.status === 'pending' ? 0 : timestamp;
      item.verifiedBy = event.status === 'pending' ? '' : verifier;
      acceptance.version = previous.version + 1; acceptance.updatedAt = timestamp;
      acceptance.audit = [...acceptance.audit, { version: acceptance.version, itemId: item.id, status: item.status, notes, serverRecordedAt: timestamp, verifiedBy: verifier, evidenceType: 'manual' }].slice(-50);
      acceptance.duty.confirmedAt = acceptance.items.find(entry => entry.id === 'duty-device' && entry.status === 'pass')?.serverConfirmedAt || 0;
      await sql.execute('UPDATE lj_settings SET document=? WHERE id=?', [JSON.stringify(acceptance), 'acceptance']);
      return { role, ...presentAcceptance(acceptance), technicalValidation: require('./verification-report.json') };
    });
  }
  return { handle };
}
module.exports = { CHECKS, defaultAcceptance, presentAcceptance, validateSave, createAcceptance };
