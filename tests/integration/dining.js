// Run only against a dedicated local test database, never the cloud production DB.
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { initialize, createDatabase } = require('../../src/database');
const { createService } = require('../../src/dining/service');
const { createTakeaway } = require('../../src/takeaway');
(async () => {
  const connection = await mysql.createConnection({ host: '127.0.0.1', port: 33308, user: 'root' });
  const name = 'lj_test_' + Date.now(); await connection.query(`CREATE DATABASE ${name}`); await connection.end();
  const options = { host: '127.0.0.1', port: 33308, user: 'root', database: name, connectionLimit: 10 };
  let pool = mysql.createPool(options);
  try {
    await initialize(pool);
    let handle = createService(createDatabase(pool), ['staff']);
    const guests = Array.from({ length: 20 }, (_, n) => 'guest-' + n);
    const sessions = await Promise.all(guests.map(actor => handle({ action: 'join', table: '08' }, actor)));
    assert.equal(new Set(sessions.map(s => s.id)).size, 1);
    const items = [{ dishId: 'lamb-skewer', option: '微辣', quantity: 10 }];
    const payload = { action: 'submit', table: '08', sessionId: sessions[0].id, note: '', items, expectedTotal: 1300 };
    await Promise.all(guests.flatMap((actor, n) => [1, 2].map(() => handle({ ...payload, requestId: 'request:' + n }, actor))));
    let bill = await handle({ action: 'get', table: '08', sessionId: sessions[0].id }, guests[0]);
    assert.equal(bill.orders.length, 20); assert.equal(bill.total, 26000);
    await assert.rejects(handle({ action: 'get', table: '08', sessionId: bill.id }, 'outsider'), { code: 'FORBIDDEN' });
    await pool.end(); pool = mysql.createPool(options); await initialize(pool);
    handle = createService(createDatabase(pool), ['staff']);
    bill = await handle({ action: 'get', table: '08', sessionId: bill.id }, guests[0]);
    assert.equal(bill.total, 26000);
    const pickup = createTakeaway(pool, ['staff']);
    const input = { action: 'submit', requestId: 'pickup:repeat', name: '测试', phone: '13800000000', pickupAt: Date.now() + 3600000, note: '', items, expectedTotal: 1300 };
    const orders = await Promise.all(Array.from({ length: 10 }, () => pickup(input, 'a'.repeat(64))));
    assert.equal(new Set(orders.map(r => r.order.id)).size, 1);
    assert.equal((await pickup({ action: 'list' }, 'a'.repeat(64))).orders.length, 1);
    assert.equal((await pickup({ action: 'list' }, 'b'.repeat(64))).orders.length, 0);
    await assert.rejects(pickup({ ...input, note: 'changed' }, 'a'.repeat(64)), { code: 'TOKEN_REUSED' });
    await assert.rejects(pickup({ action: 'complete', id: orders[0].order.id, expectedTotal: 1300 }, 'a'.repeat(64)), { code: 'FORBIDDEN' });
    await pickup({ action: 'complete', id: orders[0].order.id, expectedTotal: 1300 }, 'staff');
    assert.equal((await pickup({ action: 'list' }, 'a'.repeat(64))).orders[0].status, 'completed');
    console.log('PASS MySQL: 20 simultaneous guests, duplicate submissions, persistence across pool restart, private history and staff permissions');
  } finally { await pool.end(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
