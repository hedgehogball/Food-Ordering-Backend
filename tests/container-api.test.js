const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/app');
const { validate } = require('../src/takeaway');
test('container rejects forged identities, validates HTTP and does not leak failures', async t => {
  let invoked = 0;
  const app = createApp({ appId: 'wx-test', health: async () => {}, users: async () => {},
    takeaway: async () => ({}), dining: async (_input, actor) => { invoked++; return { actor }; } });
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = 'http://127.0.0.1:' + server.address().port;
  const headers = { 'content-type': 'application/json', 'x-wx-openid': 'test-openid-12345', 'x-wx-appid': 'wx-test', 'x-wx-source': 'wx_client' };
  const request = async (path, body, h = headers) => (await fetch(url + path, { method: 'POST', headers: h, body: JSON.stringify(body) })).json();
  assert.equal((await request('/api/login', { action: 'login', OPENID: 'victim' }, { 'content-type': 'application/json' })).code, 'UNAUTHENTICATED');
  assert.equal((await request('/api/login', { action: 'login' }, { ...headers, 'x-wx-appid': 'other' })).code, 'UNAUTHENTICATED');
  const user = await request('/api/login', { action: 'login' });
  assert.match(user.user.id, /^[a-f0-9]{64}$/);
  assert.equal((await request('/api/table-order', { actor: 'victim' })).session.actor, 'test-openid-12345');
  assert.equal(invoked, 1);
  assert.equal((await request('/api/table-order', [])).code, 'INVALID_REQUEST');
  assert.equal((await fetch(url + '/healthz')).status, 200);
  assert.equal((await fetch(url + '/api/login')).status, 405);
});
test('takeaway is priced on server, requires minimum quantities and valid contact/time', () => {
  const now = Date.now();
  const event = { requestId: 'test:pickup', name: '测试', phone: '13800000000', pickupAt: now + 60000,
    note: '', items: [{ dishId: 'lamb-skewer', option: '微辣', quantity: 10 }], expectedTotal: 1300 };
  assert.equal(validate(event, 'actor', now).total, 1300);
  assert.equal(validate(event, 'actor', now).packing, 0);
  assert.throws(() => validate({ ...event, expectedTotal: 1 }, 'actor', now), { code: 'PRICE_CHANGED' });
  assert.throws(() => validate({ ...event, items: [{ ...event.items[0], quantity: 9 }] }, 'actor', now), { code: 'MIN_QUANTITY' });
  assert.throws(() => validate({ ...event, pickupAt: now - 1 }, 'actor', now), { code: 'PICKUP_INVALID' });
});
