'use strict';
// Only a new database on the dedicated loopback test server is used here.
// Fixture passes are simulated evidence for API tests, never live field acceptance.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { initialize } = require('../../src/database');
const { createOperations, createRoles } = require('../../src/operations');
const APP = 'test-app';
const context = openid => ({ OPENID: openid, APPID: APP });
const actor = openid => crypto.createHash('sha256').update(APP + ':' + openid).digest('hex');
const OWNER = actor('fixture-owner');
const CASHIER = actor('fixture-cashier');
const roleOf = createRoles({ appId: APP, ownerIds: [OWNER], cashierIds: [CASHIER] });
(async () => {
  const admin = await mysql.createConnection({ host: '127.0.0.1', port: 33308, user: 'root' });
  const database = 'lj_acceptance_test_' + Date.now();
  await admin.query(`CREATE DATABASE ${database}`); await admin.end();
  const config = { host: '127.0.0.1', port: 33308, user: 'root', database, connectionLimit: 5 };
  let pool = mysql.createPool(config);
  try {
    await initialize(pool);
    let operations = createOperations(pool, { roleOf });
    const get = () => operations.handle({ action: 'acceptanceGet' }, OWNER, context('fixture-owner'));
    const initial = await get();
    assert.equal(initial.summary.pending, 10); assert.equal(initial.acceptance.duty.confirmedAt, 0);
    const event = itemId => ({ action: 'acceptanceSave', itemId, status: 'pass', notes: '测试库模拟人工记录，仅用于验证 API 和持久化', expectedVersion: 1, manualConfirmation: true });
    await assert.rejects(operations.handle(event('identity'), CASHIER, context('fixture-cashier')), { code: 'FORBIDDEN' });
    await assert.rejects(operations.handle({ action: 'acceptanceGet', role: 'owner' }, OWNER, context('fixture-customer')), { code: 'FORBIDDEN' });
    const attempts = await Promise.allSettled([
      operations.handle(event('identity'), OWNER, context('fixture-owner')),
      operations.handle(event('table-access'), OWNER, context('fixture-owner'))
    ]);
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'ACCEPTANCE_CHANGED');
    const first = await get();
    assert.equal(first.acceptance.version, 2); assert.equal(first.summary.passed, 1); assert.equal(first.acceptance.audit.length, 1);
    await operations.handle({ ...event('duty-device'), expectedVersion: 2 }, OWNER, context('fixture-owner'));
    const [[count]] = await pool.query('SELECT (SELECT COUNT(*) FROM lj_dining_sessions)+(SELECT COUNT(*) FROM lj_takeaway)+(SELECT COUNT(*) FROM lj_users)+(SELECT COUNT(*) FROM lj_print_jobs) AS count');
    assert.equal(Number(count.count), 0, 'acceptance must not create or pay customer orders');
    const [[saved]] = await pool.execute('SELECT document FROM lj_settings WHERE id=?', ['acceptance']);
    const serialized = typeof saved.document === 'string' ? saved.document : JSON.stringify(saved.document);
    assert.equal(serialized.includes('fixture-owner'), false); assert.equal(serialized.includes(OWNER), false);
    await pool.end(); pool = mysql.createPool(config); operations = createOperations(pool, { roleOf });
    const persisted = await operations.handle({ action: 'acceptanceGet' }, CASHIER, context('fixture-cashier'));
    assert.equal(persisted.acceptance.version, 3); assert.equal(persisted.summary.passed, 2);
    assert.ok(persisted.acceptance.duty.confirmedAt > 0); assert.equal(persisted.acceptance.audit.length, 2);
    console.log('PASS MySQL acceptance: missing record remains pending, trusted roles, serialized first saves, persistent manual evidence, anonymous audit, no customer order writes');
  } finally { await pool.end(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
