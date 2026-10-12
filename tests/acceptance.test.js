'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createAcceptance, CHECKS } = require('../src/acceptance');
const { createOperations, createRoles } = require('../src/operations');
const account = openid => crypto.createHash('sha256').update('app:' + openid).digest('hex');
const OWNER = account('owner-openid');

// Transactional test double exercises the settings row and transaction boundaries,
// including competing first writes and rollback, without connecting to a real store.
function memoryPool() {
  let documents = new Map(), tail = Promise.resolve();
  const calls = { read: 0, begin: 0, commit: 0, rollback: 0, released: 0 };
  let failUpdate = false;
  function execute(map, sql, params) {
    if (sql.startsWith('SELECT document FROM lj_settings WHERE id=?')) {
      calls.read++; const doc = map.get(params[0]);
      return [doc ? [{ document: JSON.stringify(doc) }] : []];
    }
    if (sql === 'INSERT IGNORE INTO lj_settings (id,document) VALUES (?,?)') {
      if (!map.has(params[0])) map.set(params[0], JSON.parse(params[1]));
      return [{ affectedRows: 1 }];
    }
    if (sql === 'UPDATE lj_settings SET document=? WHERE id=?') {
      if (failUpdate) { failUpdate = false; throw new Error('simulated storage failure'); }
      map.set(params[1], JSON.parse(params[0])); return [{ affectedRows: 1 }];
    }
    throw new Error('Unexpected SQL: ' + sql);
  }
  return {
    calls, failNextUpdate() { failUpdate = true; },
    async execute(sql, params) { return execute(documents, sql, params); },
    async getConnection() {
      let working, unlock;
      return {
        async beginTransaction() {
          const previous = tail;
          tail = new Promise(resolve => { unlock = resolve; });
          await previous; calls.begin++;
          working = new Map([...documents].map(([key, value]) => [key, JSON.parse(JSON.stringify(value))]));
        },
        async execute(sql, params) { return execute(working, sql, params); },
        async commit() { documents = working; calls.commit++; },
        async rollback() { calls.rollback++; },
        release() { calls.released++; if (unlock) unlock(); }
      };
    }
  };
}
function save(itemId, expectedVersion = 1, extra = {}) {
  return { action: 'acceptanceSave', itemId, expectedVersion, status: 'pass', notes: '两部真机由值班店主实际检查，结果符合步骤', manualConfirmation: true, ...extra };
}

test('a missing acceptance record contains only pending manual checks and read does not initialize SQL', async () => {
  const pool = memoryPool();
  const api = createAcceptance(pool);
  for (const role of ['owner', 'cashier']) {
    const result = await api.handle({ action: 'acceptanceGet' }, OWNER, role);
    assert.deepEqual(result.summary, { total: 10, passed: 0, failed: 0, pending: 10 });
    assert.equal(result.acceptance.evidenceType, 'manual');
    assert.equal(result.acceptance.version, 1);
    assert.equal(result.acceptance.updatedAt, 0);
    assert.equal(result.acceptance.audit.length, 0);
    assert.equal(result.acceptance.duty.confirmedAt, 0);
    assert.deepEqual(result.acceptance.items.map(item => item.id), CHECKS.map(item => item.id));
    result.acceptance.items.forEach(item => {
      assert.equal(typeof item.instructions, 'string');
      assert.equal(item.status, 'pending'); assert.equal(item.serverConfirmedAt, 0); assert.equal(item.verifiedBy, '');
    });
  }
  assert.equal(pool.calls.begin, 0);
});

test('operations derive acceptance privileges from trusted identity and ignore caller roles', async () => {
  const pool = memoryPool();
  const roleOf = createRoles({ appId: 'app', ownerIds: [OWNER], cashierIds: [account('cashier-openid')] });
  const operations = createOperations(pool, { roleOf });
  for (const action of ['acceptanceGet', 'acceptanceSave']) {
    await assert.rejects(operations.handle({ ...save('identity'), action, role: 'owner' }, OWNER, { OPENID: 'customer-openid' }), { code: 'FORBIDDEN' });
  }
  await assert.rejects(operations.handle(save('identity'), account('cashier-openid'), { OPENID: 'cashier-openid' }), { code: 'FORBIDDEN' });
  assert.equal(pool.calls.read, 0); assert.equal(pool.calls.begin, 0);
  const result = await operations.handle({ action: 'acceptanceGet' }, 'forged', { OPENID: 'owner-openid' });
  assert.equal(result.role, 'owner');
});

test('passing or failing requires an explicit manual confirmation and bounded evidence', async () => {
  const pool = memoryPool(); const api = createAcceptance(pool);
  for (const extra of [{ manualConfirmation: false }, { manualConfirmation: undefined }, { notes: '  ' }, { status: 'fail', notes: '' }]) {
    await assert.rejects(api.handle(save('identity', 1, extra), OWNER, 'owner'), { code: 'MANUAL_EVIDENCE_REQUIRED' });
  }
  for (const extra of [{ itemId: 'unknown' }, { status: 'complete' }, { notes: '字'.repeat(201) }, { notes: null }, { expectedVersion: '1' }, { expectedVersion: 0 }]) {
    await assert.rejects(api.handle(save('identity', 1, extra), OWNER, 'owner'), { code: 'ACCEPTANCE_INVALID' });
  }
  await assert.rejects(api.handle(save('identity'), 'raw-openid', 'owner'), { code: 'UNAUTHENTICATED' });
  assert.equal(pool.calls.begin, 0);
});

test('confirmation timestamp and pseudonymous verifier are server created and persist across readers', async () => {
  const pool = memoryPool(); const api = createAcceptance(pool, { now: () => 1800000000000 });
  const result = await api.handle(save('identity', 1, { notes: '  两台手机的顾客与店主权限均正确  ', verifiedBy: 'forged-openid', serverConfirmedAt: 1 }), OWNER, 'owner');
  const item = result.acceptance.items.find(entry => entry.id === 'identity');
  assert.equal(item.notes, '两台手机的顾客与店主权限均正确');
  assert.equal(item.serverConfirmedAt, 1800000000000);
  assert.match(item.verifiedBy, /^owner:[a-f0-9]{12}$/);
  assert.doesNotMatch(JSON.stringify(result), /owner-openid|forged-openid/);
  assert.equal(JSON.stringify(result).includes(OWNER), false);
  assert.equal(result.acceptance.version, 2); assert.equal(result.acceptance.updatedAt, 1800000000000);
  assert.equal(result.summary.passed, 1);
  assert.deepEqual((await api.handle({ action: 'acceptanceGet' }, account('cashier'), 'cashier')).acceptance, result.acceptance);
});

test('stale saves preserve recorded evidence and competing first saves cannot overwrite each other', async () => {
  const pool = memoryPool(); const api = createAcceptance(pool);
  const attempts = await Promise.allSettled([
    api.handle(save('identity'), OWNER, 'owner'),
    api.handle(save('table-access'), OWNER, 'owner')
  ]);
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  const rejected = attempts.find(item => item.status === 'rejected');
  assert.equal(rejected.reason.code, 'ACCEPTANCE_CHANGED');
  const first = await api.handle({ action: 'acceptanceGet' }, OWNER, 'owner');
  assert.equal(first.summary.passed, 1); assert.equal(first.acceptance.audit.length, 1);
  const other = first.acceptance.items.find(item => item.status === 'pending').id;
  const result = await api.handle(save(other, 2), OWNER, 'owner');
  assert.equal(result.summary.passed, 2); assert.equal(result.acceptance.version, 3);
  assert.equal(pool.calls.rollback, 1);
});

test('resetting a manual check clears its approval and audit history is capped at 50 changes', async () => {
  const pool = memoryPool(); let time = 1800000000000;
  const api = createAcceptance(pool, { now: () => ++time });
  let result;
  for (let expectedVersion = 1; expectedVersion <= 55; expectedVersion++) {
    result = await api.handle(save('identity', expectedVersion), OWNER, 'owner');
  }
  assert.equal(result.acceptance.audit.length, 50);
  assert.equal(result.acceptance.audit[0].version, 7);
  assert.equal(result.acceptance.audit.at(-1).version, 56);
  result = await api.handle(save('identity', 56, { status: 'pending', notes: '', manualConfirmation: false }), OWNER, 'owner');
  const item = result.acceptance.items.find(entry => entry.id === 'identity');
  assert.equal(item.serverConfirmedAt, 0); assert.equal(item.verifiedBy, '');
  assert.equal(result.summary.passed, 0); assert.equal(result.acceptance.audit.at(-1).status, 'pending');
});

test('dedicated phone duty is confirmed only by the specific manual field check', async () => {
  const pool = memoryPool(); const api = createAcceptance(pool, { now: () => 1800000000000 });
  let result = await api.handle(save('new-order'), OWNER, 'owner');
  assert.equal(result.acceptance.duty.confirmedAt, 0);
  result = await api.handle(save('duty-device', 2), OWNER, 'owner');
  assert.equal(result.acceptance.duty.device, '专用手机');
  assert.equal(result.acceptance.duty.confirmedAt, 1800000000000);
  result = await api.handle(save('duty-device', 3, { status: 'fail', notes: '专用手机未能持续保持前台，需要重测' }), OWNER, 'owner');
  assert.equal(result.acceptance.duty.confirmedAt, 0); assert.equal(result.summary.failed, 1);
});

test('a storage failure rolls back the first acceptance record and retry starts from the original version', async () => {
  const pool = memoryPool(); const api = createAcceptance(pool);
  pool.failNextUpdate();
  await assert.rejects(api.handle(save('identity'), OWNER, 'owner'), /simulated storage failure/);
  const after = await api.handle({ action: 'acceptanceGet' }, OWNER, 'owner');
  assert.equal(after.acceptance.version, 1); assert.equal(after.summary.passed, 0); assert.equal(after.acceptance.audit.length, 0);
  const result = await api.handle(save('identity'), OWNER, 'owner');
  assert.equal(result.acceptance.version, 2); assert.equal(result.summary.passed, 1);
  assert.equal(pool.calls.rollback, 1); assert.equal(pool.calls.released, 2);
});
