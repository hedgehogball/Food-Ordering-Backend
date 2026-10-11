'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createOperations, createRoles, defaultSettings, validateSettings, accepting, dateRange, advanceOrder, ticket, summarizeStats } = require('../src/operations');
const { createService } = require('../src/dining/service');
const { database } = require('./helpers/cloud-database');

test('Shanghai business hours enforce weekday and overnight boundaries', () => {
  const settings = { ...defaultSettings(), useHours: true, openTime: '22:00', closeTime: '02:00', weekdays: [5] };
  assert.equal(accepting(settings, Date.parse('2026-10-09T22:00:00+08:00')), true);
  assert.equal(accepting(settings, Date.parse('2026-10-10T01:59:59+08:00')), true);
  assert.equal(accepting(settings, Date.parse('2026-10-10T02:00:00+08:00')), false);
  assert.equal(accepting(settings, Date.parse('2026-10-10T22:00:00+08:00')), false);
  assert.equal(accepting({ ...settings, open: false }, Date.parse('2026-10-09T23:00:00+08:00')), false);
  const regular = { ...settings, openTime: '10:00', closeTime: '23:00' };
  assert.equal(accepting(regular, Date.parse('2026-10-09T23:00:00+08:00')), false);
});
test('settings validation refuses ambiguous schedules and invalid reservation limits', () => {
  const settings = defaultSettings();
  assert.throws(() => validateSettings({ ...settings, openTime: '24:00' }), { code: 'SETTINGS_INVALID' });
  assert.throws(() => validateSettings({ ...settings, useHours: true, closeTime: settings.openTime }), { code: 'SETTINGS_INVALID' });
  assert.throws(() => validateSettings({ ...settings, weekdays: [1, 1] }), { code: 'SETTINGS_INVALID' });
  assert.throws(() => validateSettings({ ...settings, leadMinutes: 181 }), { code: 'SETTINGS_INVALID' });
  assert.throws(() => validateSettings({ ...settings, advanceDays: 8 }), { code: 'SETTINGS_INVALID' });
  assert.equal(dateRange('2026-10-01', '2026-10-31').end - dateRange('2026-10-01', '2026-10-31').start, 31 * 86400000);
  assert.throws(() => dateRange('2026-02-30', '2026-03-01'), { code: 'DATE_INVALID' });
  assert.throws(() => dateRange('2026-10-01', '2026-11-01'), { code: 'DATE_INVALID' });
});
test('roles use trusted gateway identity and operations reject customers before touching SQL', async () => {
  const id = openid => crypto.createHash('sha256').update('app:' + openid).digest('hex');
  const roleOf = createRoles({ appId: 'app', ownerIds: [id('owner')], cashierIds: [id('cashier')], cashierOpenids: ['legacy'] });
  assert.equal(roleOf('forged', { OPENID: 'owner' }), 'owner');
  assert.equal(roleOf(id('owner'), { OPENID: 'customer' }), 'customer');
  assert.equal(roleOf('forged', { OPENID: 'legacy' }), 'cashier');
  const operations = createOperations({ execute() { throw new Error('SQL must not be called'); } }, { roleOf });
  for (const action of ['dashboard', 'saveSettings', 'stats', 'advance', 'requestPrint', 'getTicket', 'markPrinted']) {
    await assert.rejects(operations.handle({ action, role: 'owner' }, id('customer')), { code: 'FORBIDDEN' });
  }
  await assert.rejects(operations.handle({ action: 'saveSettings', settings: defaultSettings() }, id('cashier')), { code: 'FORBIDDEN' });
});
test('fulfillment progresses separately from payment and retries never regress a stage', () => {
  const order = { status: 'pending' };
  assert.equal(advanceOrder(order, 'new', 'cooking', 1), true);
  assert.equal(order.status, 'pending');
  assert.equal(advanceOrder(order, 'new', 'cooking', 2), false);
  assert.equal(order.fulfillmentUpdatedAt, 1);
  assert.equal(advanceOrder(order, 'cooking', 'ready', 3), true);
  assert.throws(() => advanceOrder(order, 'new', 'cooking', 4), { code: 'STATE_CHANGED' });
  assert.throws(() => advanceOrder(order, 'ready', 'new', 4), { code: 'STAGE_INVALID' });
});
test('closing rejects new dining orders but preserves ambiguous-submit recovery', async () => {
  let open = true, checks = 0;
  const handle = createService(database(), [], { beforeNewSubmit: () => { checks++; if (!open) { const error = new Error('closed'); error.code = 'SHOP_CLOSED'; throw error; } } });
  const session = await handle({ action: 'join', table: '03' }, 'guest');
  const input = { action: 'submit', table: '03', sessionId: session.id, requestId: 'closing:test', note: '', expectedTotal: 1300, items: [{ dishId: 'lamb-skewer', option: '微辣', quantity: 10 }] };
  await handle(input, 'guest'); open = false;
  const restored = await handle(input, 'guest'); assert.equal(restored.orders.length, 1); assert.equal(checks, 1);
  await assert.rejects(handle({ ...input, requestId: 'closing:new' }, 'guest'), { code: 'SHOP_CLOSED' });
  await assert.rejects(handle({ ...input, note: 'changed' }, 'guest'), { code: 'TOKEN_REUSED' });
});
test('reports separate submitted value from verified receipts and tickets omit private contact data', () => {
  const order = { id: 'test-order', name: '客人', phone: '13800000000', pickup: 'ABC123', pickupAt: 1000, createdAt: 100, note: '', total: 1300, items: [{ dishId: 'lamb', name: '羊肉串', option: '微辣', quantity: 10, price: 130, unit: '串' }] };
  const report = summarizeStats([{ order, paid: false }], [], 0, 200);
  assert.equal(report.submittedTotal, 1300); assert.equal(report.paidTotal, 0); assert.equal(report.pendingOrders, 1);
  assert.equal(report.topDishes[0].quantity, 10);
  const printed = ticket('takeaway', order, null, 200);
  assert.equal(printed.status, 'queued'); assert.doesNotMatch(JSON.stringify(printed), /13800000000/);
  order.items[0].quantity = 99;
  assert.match(printed.lines.join('\n'), /× 10串/);
});
