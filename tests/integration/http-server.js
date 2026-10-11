'use strict';
// Smoke-test the independent entry point against a newly created local test DB.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const mysql = require('mysql2/promise');
const { decode } = require('../../src/database');
(async () => {
  const admin = await mysql.createConnection({ host: '127.0.0.1', port: 33308, user: 'root' });
  const database = 'lj_http_test_' + Date.now();
  const username = 'lj_http_' + crypto.randomBytes(6).toString('hex');
  const password = crypto.randomBytes(24).toString('hex');
  let child, createdUser = false;
  try {
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await admin.query('CREATE USER ?@? IDENTIFIED BY ?', [username, '127.0.0.1', password]); createdUser = true;
    await admin.query(`GRANT ALL PRIVILEGES ON ${database}.* TO ?@?`, [username, '127.0.0.1']);
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const appId = 'wx0000000000000000';
    const ownerOpenid = 'local-test-owner-001';
    const ownerId = crypto.createHash('sha256').update(appId + ':' + ownerOpenid).digest('hex');
    const env = { ...process.env, PORT: String(port), WX_APPID: appId,
      MYSQL_ADDRESS: '127.0.0.1:33308', MYSQL_USERNAME: username, MYSQL_PASSWORD: password, MYSQL_DATABASE: database,
      OWNER_USER_IDS: ownerId, CASHIER_USER_IDS: '', CASHIER_OPENIDS: '' };
    const cwd = path.join(__dirname, '../..');
    const output = execFileSync(process.execPath, ['--env-file-if-exists=.env', 'scripts/init-db.js'], { cwd, env, encoding: 'utf8', timeout: 10000 });
    assert.match(output, /database_initialized/);
    child = spawn(process.execPath, ['--env-file-if-exists=.env', 'src/server.js'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', () => {});
    const url = 'http://127.0.0.1:' + port;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { ready = (await (await fetch(url + '/healthz')).json()).ok === true; } catch (_) {}
      if (ready) break;
      if (child.exitCode !== null) throw new Error('Packaged server exited before healthy');
      await delay(100);
    }
    assert.equal(ready, true, 'packaged server becomes healthy');
    const request = async (route, body, openid = 'local-test-customer-001') => (await fetch(url + route, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-wx-source': 'wx_client', 'x-wx-appid': appId, 'x-wx-openid': openid }, body: JSON.stringify(body)
    })).json();
    assert.equal((await request('/api/login', { action: 'login' })).user.role, 'customer');
    assert.equal((await request('/api/login', { action: 'login' }, ownerOpenid)).user.role, 'owner');
    assert.equal((await request('/api/operations', { action: 'dashboard' })).code, 'FORBIDDEN');
    assert.equal((await request('/api/operations', { action: 'dashboard' }, ownerOpenid)).ok, true);
    const join = await request('/api/table-order', { action: 'join', table: '01' });
    assert.equal(join.ok, true);
    const submit = await request('/api/table-order', { action: 'submit', table: '01', sessionId: join.session.id,
      requestId: 'http:smoke-order-001', items: [{ dishId: 'lamb-skewer', option: '微辣', quantity: 10 }], expectedTotal: 1300, note: '少盐' });
    assert.equal(submit.ok, true); assert.equal(submit.session.total, 1300);
    const [rows] = await admin.query(`SELECT document FROM ${database}.lj_dining_sessions WHERE id=?`, [join.session.id]);
    assert.equal(decode(rows[0].document).orders.length, 1);
    console.log('PASS packaged server: db:init, environment config, real HTTP login/roles, health check and durable ordering');
  } finally {
    if (child && child.exitCode === null) {
      const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped;
    }
    if (createdUser) await admin.query('DROP USER ?@?', [username, '127.0.0.1']);
    await admin.end();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
