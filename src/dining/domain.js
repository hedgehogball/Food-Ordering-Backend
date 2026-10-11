const crypto = require('node:crypto');
const { dishes } = require('./menu');
class BusinessError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function fail(code, message) { throw new BusinessError(code, message); }
function tableNumber(value) {
  const text = String(value || '');
  if (!/^\d{1,2}$/.test(text) || Number(text) < 1 || Number(text) > 36) fail('TABLE_INVALID', '请选择有效桌号（01–36 桌）');
  return text.padStart(2, '0');
}
function member(session, actor) {
  const found = session.members.find(item => item.actor === actor);
  if (!found) fail('FORBIDDEN', '请先扫描本桌二维码加入点单');
  return found;
}
function newSession(table, id, now) {
  return { id, table, status: 'open', revision: 0, members: [], orders: [], total: 0, count: 0, createdAt: now, updatedAt: now, checkout: null };
}
function join(session, actor) {
  if (session.members.some(item => item.actor === actor)) return false;
  if (session.status === 'paid') fail('SESSION_CLOSED', '本次用餐已结账，请重新加入');
  if (session.members.length >= 50) fail('TABLE_FULL', '本桌加入人数已达上限，请联系店员');
  session.members.push({ actor, label: '食客 ' + (session.members.length + 1) });
  return true;
}
function priceItems(input) {
  if (!Array.isArray(input) || !input.length || input.length > 152) fail('CART_INVALID', '请选择有效菜品');
  const keys = new Set();
  const items = input.map(line => {
    if (!line || typeof line !== 'object') fail('CART_INVALID', '请选择有效菜品');
    const dish = dishes.find(item => item.id === line.dishId);
    if (!dish || dish.soldOut) fail('DISH_UNAVAILABLE', '部分菜品已下架或售罄，请重新选择');
    if (!dish.options.includes(line.option)) fail('OPTION_INVALID', '菜品口味已变更，请重新选择');
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 99) fail('QUANTITY_INVALID', '每种口味请选择 1–99 的整数数量');
    const key = dish.id + ':' + line.option;
    if (keys.has(key)) fail('CART_INVALID', '请合并相同菜品和口味后提交');
    keys.add(key);
    return { key, dishId: dish.id, name: dish.name, image: dish.image, unit: dish.unit, price: dish.price, option: line.option, quantity: line.quantity };
  });
  for (const dish of dishes) {
    const quantity = items.filter(item => item.dishId === dish.id).reduce((sum, item) => sum + item.quantity, 0);
    if (quantity > 0 && quantity < (dish.minQuantity || 1)) fail('MIN_QUANTITY', dish.name + '至少选' + dish.minQuantity + dish.unit + '，可混选口味');
  }
  return items;
}
function fingerprint(event) {
  return crypto.createHash('sha256').update(JSON.stringify({ items: event.items, note: event.note, expectedTotal: event.expectedTotal })).digest('hex');
}
function submit(session, actor, event, now) {
  const guest = member(session, actor);
  if (typeof event.requestId !== 'string' || !/^[a-zA-Z0-9:_-]{8,100}$/.test(event.requestId)) fail('TOKEN_INVALID', '请重新打开提交页面');
  const hash = fingerprint(event);
  const previous = session.orders.find(order => order.actor === actor && order.requestId === event.requestId);
  // 先查幂等结果，即使已经申请结账，也能恢复网络中断时的提交结果。
  if (previous) {
    if (previous.fingerprint !== hash) fail('TOKEN_REUSED', '提交内容已变化，请先核对本桌订单');
    return false;
  }
  if (session.status !== 'open') fail('TABLE_LOCKED', session.status === 'paid' ? '本桌已结账，请重新加入后点单' : '本桌正在结账，暂不能加菜');
  if (typeof event.note !== 'string' || event.note.length > 100) fail('NOTE_INVALID', '备注最多 100 字');
  const items = priceItems(event.items);
  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  if (event.expectedTotal !== total) fail('PRICE_CHANGED', '菜品价格已更新，请返回菜单核对后重新提交');
  if (session.orders.length >= 200) fail('ORDER_LIMIT', '本桌提交次数已达上限，请联系店员');
  session.orders.push({ id: crypto.randomUUID(), actor, guest: guest.label, requestId: event.requestId, fingerprint: hash, items, note: event.note.trim(), total, createdAt: now, fulfillment: 'new' });
  session.total += total;
  session.count += items.reduce((sum, item) => sum + item.quantity, 0);
  if (Buffer.byteLength(JSON.stringify(session), 'utf8') > 700000) fail('ORDER_LIMIT', '本桌菜品记录已达上限，请联系店员');
  return true;
}
function requestCheckout(session, actor, event, now) {
  member(session, actor);
  if (session.status === 'checkout') return false;
  if (session.status !== 'open') fail('SESSION_CLOSED', '本桌已结账');
  if (!session.orders.length) fail('EMPTY_TABLE', '本桌还没有提交菜品');
  if (event.revision !== session.revision) fail('BILL_CHANGED', '本桌账单已更新，请核对新金额后再结账');
  session.status = 'checkout';
  session.checkout = { actor, total: session.total, requestedAt: now, method: 'counter' };
  return true;
}
function cancelCheckout(session, actor, event, isStaff) {
  if (!isStaff) member(session, actor);
  if (session.status !== 'checkout') fail('STATE_CHANGED', '结账状态已变化，请刷新');
  if (!isStaff && session.checkout.actor !== actor) fail('FORBIDDEN', '请由申请结账的人或店员恢复点单');
  if (event.revision !== session.revision) fail('BILL_CHANGED', '本桌状态已更新，请刷新后重试');
  session.status = 'open'; session.checkout = null;
  return true;
}
function confirmPaid(session, actor, event, now, isStaff) {
  if (!isStaff) fail('FORBIDDEN', '仅门店收银员可以确认收款');
  if (session.status === 'paid') return false;
  if (session.status !== 'checkout' || event.revision !== session.revision || event.expectedTotal !== session.total) fail('BILL_CHANGED', '账单或结账状态已变化，请核对后重新确认');
  session.status = 'paid';
  session.checkout.paidAt = now; session.checkout.confirmedBy = actor;
  return true;
}
function present(session, actor, isStaff = false) {
  const guest = session.members.find(item => item.actor === actor);
  if (!guest && !isStaff) fail('FORBIDDEN', '请先扫描本桌二维码加入点单');
  return {
    id: session.id, table: session.table, status: session.status, revision: session.revision,
    total: session.total, count: session.count, createdAt: session.createdAt, updatedAt: session.updatedAt,
    memberCount: session.members.length, myLabel: guest ? guest.label : '收银员',
    canCancelCheckout: session.status === 'checkout' && (isStaff || session.checkout.actor === actor),
    checkout: session.checkout ? { total: session.checkout.total, requestedAt: session.checkout.requestedAt, paidAt: session.checkout.paidAt || null, mine: session.checkout.actor === actor } : null,
    orders: session.orders.map(order => ({ id: order.id, guest: order.guest, mine: order.actor === actor, items: order.items, note: order.note, total: order.total, createdAt: order.createdAt, fulfillment: order.fulfillment || 'new' }))
  };
}
module.exports = { BusinessError, fail, tableNumber, member, newSession, join, submit, requestCheckout, cancelCheckout, confirmPaid, present };
