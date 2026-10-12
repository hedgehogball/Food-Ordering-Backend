const { test } = require('node:test');
const assert = require('node:assert/strict');
const { database } = require('./helpers/cloud-database');
const { createService } = require('../src/dining/service');
const { dishes } = require('../src/dining/menu');
function setup() { const db = database(); return { db, handle: createService(db, ['cashier']) }; }
function order(session, requestId, quantity = 10, option = '微辣') {
  return { action: 'submit', table: session.table, sessionId: session.id, requestId, note: '', items: [{ dishId: 'lamb-skewer', option, quantity }], expectedTotal: 130 * quantity };
}
const rejected = code => error => error.code === code;
test('simultaneous scans create one shared session, each WeChat user joins once', async () => {
  const { db, handle } = setup();
  const joined = await Promise.all(['alice', 'bob', 'alice', 'carol'].map(actor => handle({ action: 'join', table: '08' }, actor)));
  assert.equal(new Set(joined.map(value => value.id)).size, 1);
  const session = await handle({ action: 'get', table: '08', sessionId: joined[0].id }, 'alice');
  assert.equal(session.memberCount, 3);
  assert.equal(session.myLabel, '食客 1');
  assert.ok(db.conflicts > 0, 'exercise transaction conflicts');
  assert.equal([...db.values.keys()].filter(key => key.startsWith('dining_sessions/')).length, 1);
});
test('twenty guests submit concurrently without lost dishes or merged ownership', async () => {
  const { handle, db } = setup();
  const guests = Array.from({ length: 20 }, (_, i) => 'guest-' + i);
  const joined = await Promise.all(guests.map(actor => handle({ action: 'join', table: '08' }, actor)));
  await Promise.all(guests.map((actor, i) => handle(order(joined[i], 'request:' + i, i + 10, i % 2 ? '不辣' : '微辣'), actor)));
  const session = await handle({ action: 'get', table: '08', sessionId: joined[0].id }, guests[0]);
  assert.equal(session.orders.length, 20);
  assert.equal(session.count, 390); assert.equal(session.total, 50700);
  assert.equal(session.orders.filter(value => value.mine).length, 1);
  assert.equal(session.orders.filter(value => value.items[0].option === '不辣').length, 10);
  assert.ok(db.conflicts > 20);
});
test('repeated request is idempotent, including response lost before checkout', async () => {
  const { handle } = setup();
  const session = await handle({ action: 'join', table: '08' }, 'alice');
  const input = order(session, 'request:repeat', 12);
  await Promise.all([handle(input, 'alice'), handle(input, 'alice')]);
  const bill = await handle({ action: 'get', table: '08', sessionId: session.id }, 'alice');
  await handle({ action: 'checkout', table: '08', sessionId: session.id, revision: bill.revision }, 'alice');
  const replay = await handle(input, 'alice');
  assert.equal(replay.orders.length, 1); assert.equal(replay.total, 1560); assert.equal(replay.status, 'checkout');
  await assert.rejects(handle(Object.assign({}, input, { note: 'changed' }), 'alice'), rejected('TOKEN_REUSED'));
});
test('trusted identity, table isolation and private identifiers are enforced', async () => {
  const { handle } = setup();
  const session = await handle({ action: 'join', table: '08' }, 'alice');
  await handle(order(session, 'request:privacy'), 'alice');
  await assert.rejects(handle({ action: 'get', table: '08', sessionId: session.id, actor: 'alice' }, 'mallory'), rejected('FORBIDDEN'));
  await assert.rejects(handle({ action: 'get', table: '09', sessionId: session.id }, 'alice'), rejected('SESSION_INVALID'));
  await assert.rejects(handle(order(session, 'request:outsider'), 'mallory'), rejected('FORBIDDEN'));
  assert.equal((await handle({ action: 'join', table: '24' }, 'alice')).table, '24');
  for (const table of ['25','36','37']) await assert.rejects(handle({ action: 'join', table }, 'alice'), rejected('TABLE_INVALID'));
  await assert.rejects(handle({ action: 'join', table: '08', actor: 'alice' }, ''), rejected('UNAUTHENTICATED'));
  const publicValue = JSON.stringify(await handle({ action: 'get', table: '08', sessionId: session.id }, 'alice'));
  assert.doesNotMatch(publicValue, /alice|fingerprint|requestId|"actor"/);
});
test('retired table recovery only returns an existing matching submission and allows protected settlement', async () => {
  const { handle, db } = setup();
  const domain = require('../src/dining/domain');
  const legacy = domain.newSession('36', 'legacy-session-36', Date.now());domain.join(legacy, 'alice');
  const original = order(legacy, 'legacy:original');domain.submit(legacy, 'alice', original, Date.now());
  db.values.set('dining_tables/36', { sessionId: legacy.id });db.values.set('dining_sessions/' + legacy.id, legacy);
  const recovered = await handle(original, 'alice');assert.equal(recovered.orders.length, 1);assert.equal(recovered.total, 1300);
  await assert.rejects(handle({ action: 'join', table: '36', sessionId: legacy.id }, 'alice'), rejected('TABLE_INVALID'));
  await assert.rejects(handle(order(legacy, 'legacy:new'), 'alice'), rejected('TABLE_RETIRED_NOT_COMMITTED'));
  await assert.rejects(handle({ ...original, sessionId: 'legacy-missing' }, 'alice'), rejected('TABLE_RETIRED_NOT_COMMITTED'));
  await assert.rejects(handle({ ...original, note: 'changed' }, 'alice'), rejected('TOKEN_REUSED'));
  await assert.rejects(handle(original, 'mallory'), rejected('FORBIDDEN'));
  await assert.rejects(handle({ action: 'get', table: '36' }, 'alice'), rejected('TABLE_INVALID'));
  assert.equal((await handle({ action: 'get', table: '36', sessionId: legacy.id }, 'alice')).orders.length, 1);
  const checkout = await handle({ action: 'checkout', table: '36', sessionId: legacy.id, revision: recovered.revision }, 'alice');
  const confirm = { action: 'confirmPaid', table: '36', sessionId: legacy.id, revision: checkout.revision, expectedTotal: checkout.total };
  await assert.rejects(handle(confirm, 'alice'), rejected('FORBIDDEN'));
  await assert.rejects(handle({ action: 'cancelCheckout', table: '36', sessionId: legacy.id, revision: checkout.revision }, 'alice'), rejected('FORBIDDEN'));
  assert.equal((await handle({ action: 'staffGet', table: '36' }, 'cashier')).id, legacy.id);
  const paid = await handle(confirm, 'cashier');assert.equal(paid.status, 'paid');
  assert.equal((await handle(original, 'alice')).orders.length, 1);
  assert.equal(db.values.get('dining_sessions/' + legacy.id).orders.length, 1);
});
test('server recomputes price and rejects invalid cart, options and sold-out items', async () => {
  const { handle } = setup();
  const session = await handle({ action: 'join', table: '08' }, 'alice');
  await assert.rejects(handle(Object.assign(order(session, 'request:price'), { expectedTotal: 1 }), 'alice'), rejected('PRICE_CHANGED'));
  await assert.rejects(handle(order(session, 'request:fraction', 1.5), 'alice'), rejected('QUANTITY_INVALID'));
  await assert.rejects(handle(order(session, 'request:option', 1, '不存在'), 'alice'), rejected('OPTION_INVALID'));
  const duplicate = order(session, 'request:duplicate'); duplicate.items.push(duplicate.items[0]);
  await assert.rejects(handle(duplicate, 'alice'), rejected('CART_INVALID'));
  const sold = dishes.find(dish => dish.id === 'lamb-skewer'); sold.soldOut = true;
  try { await assert.rejects(handle(order(session, 'request:sold'), 'alice'), rejected('DISH_UNAVAILABLE')); }
  finally { sold.soldOut = false; }
  const bad = order(session, 'request:bad'); bad.items = [null];
  await assert.rejects(handle(bad, 'alice'), rejected('CART_INVALID'));
  const forged = order(session, 'request:forged'); forged.items[0].price = 1;
  const bill = await handle(forged, 'alice'); assert.equal(bill.total, 1300); assert.equal(bill.orders[0].items[0].price, 130);
});
test('any member can request whole-table checkout; new order makes stale bill fail', async () => {
  const { handle } = setup();
  const a = await handle({ action: 'join', table: '08' }, 'alice');
  const b = await handle({ action: 'join', table: '08' }, 'bob');
  const first = await handle(order(a, 'request:alice', 12), 'alice');
  const current = await handle(order(b, 'request:bob', 13), 'bob');
  await assert.rejects(handle({ action: 'checkout', table: '08', sessionId: a.id, revision: first.revision }, 'bob'), rejected('BILL_CHANGED'));
  const locked = await handle({ action: 'checkout', table: '08', sessionId: a.id, revision: current.revision }, 'bob');
  assert.equal(locked.checkout.total, 3250); assert.equal(locked.canCancelCheckout, true);
  await assert.rejects(handle(order(a, 'request:late'), 'alice'), rejected('TABLE_LOCKED'));
  await assert.rejects(handle({ action: 'cancelCheckout', table: '08', sessionId: a.id, revision: locked.revision }, 'alice'), rejected('FORBIDDEN'));
  const open = await handle({ action: 'cancelCheckout', table: '08', sessionId: a.id, revision: locked.revision }, 'bob');
  assert.equal(open.status, 'open');
});
test('checkout racing with submit either includes the dish or rejects the late submit', async () => {
  const { handle } = setup();
  const a = await handle({ action: 'join', table: '08' }, 'alice');
  await handle({ action: 'join', table: '08' }, 'bob');
  const bill = await handle(order(a, 'request:first'), 'alice');
  const results = await Promise.allSettled([
    handle(order(a, 'request:racing'), 'bob'),
    handle({ action: 'checkout', table: '08', sessionId: a.id, revision: bill.revision }, 'alice')
  ]);
  assert.equal(results.filter(value => value.status === 'rejected').length, 1);
  const final = await handle({ action: 'get', table: '08', sessionId: a.id }, 'alice');
  assert.equal(final.total, final.orders.reduce((sum, value) => sum + value.total, 0));
  if (final.status === 'checkout') assert.equal(final.checkout.total, final.total);
});
test('only cashier confirms actual receipt; paid meal isolated from next guests', async () => {
  const { handle } = setup();
  const session = await handle({ action: 'join', table: '08' }, 'alice');
  const bill = await handle(order(session, 'request:paid'), 'alice');
  const checkout = await handle({ action: 'checkout', table: '08', sessionId: session.id, revision: bill.revision }, 'alice');
  const confirm = { action: 'confirmPaid', table: '08', sessionId: session.id, revision: checkout.revision, expectedTotal: 1300 };
  await assert.rejects(handle(confirm, 'alice'), rejected('FORBIDDEN'));
  await assert.rejects(handle(Object.assign({}, confirm, { expectedTotal: 1 }), 'cashier'), rejected('BILL_CHANGED'));
  await assert.rejects(handle({ action: 'staffGet', table: '08' }, 'alice'), rejected('FORBIDDEN'));
  const paid = await handle(confirm, 'cashier'); assert.equal(paid.status, 'paid');
  assert.equal((await handle(confirm, 'cashier')).revision, paid.revision);
  const next = await handle({ action: 'join', table: '08' }, 'bob');
  assert.notEqual(next.id, session.id); assert.equal(next.total, 0); assert.equal(next.memberCount, 1);
  const old = await handle({ action: 'join', table: '08', sessionId: session.id }, 'alice');
  assert.equal(old.status, 'paid'); assert.equal(old.total, 1300);
  await assert.rejects(handle(order(session, 'request:stale'), 'alice'), rejected('TABLE_LOCKED'));
  const staff = await handle({ action: 'staffGet', table: '08' }, 'cashier'); assert.equal(staff.id, next.id);
});
