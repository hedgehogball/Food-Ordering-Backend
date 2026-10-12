'use strict';
// A fixed isolated MySQL server and synthetic records are used; no production data.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const mysql = require('mysql2/promise');
const { initialize, createDatabase, decode } = require('../../src/database');
const { createService } = require('../../src/dining/service');
const { createTakeaway } = require('../../src/takeaway');
const { createOperations } = require('../../src/operations');
const { defaultAcceptance } = require('../../src/acceptance');
const { TABLES, BACKUP_DIR, backupDatabase, restoreForCheck } = require('../../scripts/db-backup-tools');
(async () => {
  const endpoint = { host: '127.0.0.1', port: 33308, user: 'root' };
  const database = 'lj_backup_fixture_' + Date.now();
  const admin = await mysql.createConnection(endpoint);
  await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); await admin.end();
  const pool = mysql.createPool({ ...endpoint, database });
  const backupUser = 'backup_fixture_' + crypto.randomBytes(6).toString('hex');
  // Exercise quoted/backslash passwords without placing them in child argv or output.
  const backupPassword = crypto.randomBytes(16).toString('hex') + '\\"\'!';
  let restored, userCreated = false;
  try {
    await initialize(pool);
    const dining = createService(createDatabase(pool), ['test-staff']);
    const takeaway = createTakeaway(pool, ['test-staff']);
    const operations = createOperations(pool, { roleOf: value => value === 'test-staff' ? 'cashier' : 'customer' });
    const joined = await dining({ action: 'join', table: '24' }, 'synthetic-guest');
    const items = [{ dishId: 'lamb-skewer', option: '微辣', quantity: 10 }];
    const bill = await dining({ action: 'submit', table: '24', sessionId: joined.id, requestId: 'backup:fixture-dining', note: '仅隔离测试库备份恢复验证', items, expectedTotal: 1300 }, 'synthetic-guest');
    const userId = crypto.createHash('sha256').update('synthetic-backup-user').digest('hex');
    const pickup = (await takeaway({ action: 'submit', requestId: 'backup:fixture-pickup', name: '测试记录', phone: '13800000000', pickupAt: Date.now() + 3600000, note: '虚构订单，未实际收款', items, expectedTotal: 1300 }, userId)).order;
    await pool.execute('INSERT INTO lj_users (id,first_seen,last_seen) VALUES (?,?,?)', [userId, Date.now(), Date.now()]);
    await pool.execute('INSERT INTO lj_settings (id,document) VALUES (?,?)', ['acceptance', JSON.stringify(defaultAcceptance())]);
    const queue = await operations.handle({ action: 'dashboard' }, 'test-staff');
    assert.equal(queue.printJobs.length, 2);
    await pool.query(`CREATE USER '${backupUser}'@'127.0.0.1' IDENTIFIED BY ?`, [backupPassword]); userCreated = true;
    await pool.query(`GRANT SELECT ON \`${database}\`.* TO '${backupUser}'@'127.0.0.1'`);
    const backup = await backupDatabase({ ...process.env, MYSQL_ADDRESS: '127.0.0.1:33308', MYSQL_USERNAME: backupUser, MYSQL_PASSWORD: backupPassword, MYSQL_DATABASE: database });
    assert.equal(backup.manifest.tables.length, 6);
    assert.equal(backup.manifest.sha256.length, 64);
    assert.equal(JSON.stringify(backup.manifest).includes(database), false);
    assert.equal(JSON.stringify(backup.manifest).includes(userId), false);
    const result = await restoreForCheck(backup.manifestPath, { ...process.env, MYSQL_ADDRESS: 'production-invalid:3306', MYSQL_USERNAME: 'unused-production-user', MYSQL_PASSWORD: 'unused-production-password', RESTORE_TEST_USER: 'root', RESTORE_TEST_PASSWORD: '' });
    assert.match(result.report.database, /^lj_restore_test_\d+_[a-f0-9]{8}$/);
    assert.equal(result.report.manualProductionAcceptance, false);
    restored = mysql.createPool({ ...endpoint, database: result.report.database });
    for (const table of TABLES) {
      const [[sourceCount]] = await pool.query(`SELECT COUNT(*) AS count FROM ${table}`);
      const [[restoredCount]] = await restored.query(`SELECT COUNT(*) AS count FROM ${table}`);
      assert.equal(Number(restoredCount.count), Number(sourceCount.count), table + ' row count');
      assert.equal(result.report.tables[table], Number(sourceCount.count));
    }
    for (const [table, id] of [['lj_dining_sessions', bill.id], ['lj_takeaway', pickup.id], ['lj_settings', 'acceptance'], ['lj_settings', 'shop'], ['lj_print_jobs', queue.printJobs[0].id]]) {
      const [[source]] = await pool.execute(`SELECT document FROM ${table} WHERE id=?`, [id]);
      const [[copy]] = await restored.execute(`SELECT document FROM ${table} WHERE id=?`, [id]);
      assert.deepEqual(decode(copy.document), decode(source.document), table + ' representative document');
    }
    assert.equal(fs.readdirSync(BACKUP_DIR).some(file => file.startsWith('.credentials-')), false, 'temporary credential file is removed');
    console.log('PASS isolated backup/restore: six tables and representative dining, pickup, kitchen tickets, settings and pending acceptance preserved; SHA256 verified; deployment host ignored; no production writes');
    console.log('Backup manifest: ' + backup.manifestPath);
    console.log('Restore report: ' + result.reportPath);
  } finally {
    if (userCreated) await pool.query(`DROP USER '${backupUser}'@'127.0.0.1'`);
    await pool.end(); if (restored) await restored.end();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
