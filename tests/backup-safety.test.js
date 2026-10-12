'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TABLES, BACKUP_DIR, sourceConfig, validateBackup, secureBackupDirectory } = require('../scripts/db-backup-tools');

test('backup configuration requires an explicit database and empty passwords are local-test only', () => {
  const config = { MYSQL_ADDRESS: '127.0.0.1:33308', MYSQL_USERNAME: 'root', MYSQL_PASSWORD: '', MYSQL_DATABASE: 'lj_test' };
  assert.equal(sourceConfig(config).port, 33308);
  for (const overrides of [{ MYSQL_ADDRESS: 'production-host:3306' }, { MYSQL_ADDRESS: '127.0.0.1:0' }, { MYSQL_DATABASE: 'db;DROP' }, { MYSQL_DATABASE: '' }, { MYSQL_USERNAME: '' }, { MYSQL_PASSWORD: undefined }]) {
    assert.throws(() => sourceConfig({ ...config, ...overrides }));
  }
  const secret = 'test-only-\"-password';
  assert.equal(sourceConfig({ ...config, MYSQL_ADDRESS: 'private-host:3306', MYSQL_PASSWORD: secret }).password, secret);
});

test('restore accepts only local backup manifests with an intact hash and the six expected tables', async () => {
  secureBackupDirectory();
  const stem = 'backup-fixture-' + crypto.randomBytes(8).toString('hex');
  const sql = path.join(BACKUP_DIR, stem + '.sql');
  const manifestPath = path.join(BACKUP_DIR, stem + '.manifest.json');
  async function write(content, changes = {}) {
    fs.writeFileSync(sql, content, { mode: 0o600 });
    const manifest = { version: 1, file: path.basename(sql), bytes: Buffer.byteLength(content), sha256: crypto.createHash('sha256').update(content).digest('hex'), tables: TABLES, ...changes };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  }
  try {
    await write('CREATE TABLE `lj_settings` (`document` JSON);\n');
    assert.equal((await validateBackup(manifestPath)).sqlPath, sql);
    fs.appendFileSync(sql, 'changed');
    await assert.rejects(validateBackup(manifestPath), /hash or size/);
    await write('CREATE TABLE `lj_settings` (`document` JSON);\n', { tables: ['lj_users'] });
    await assert.rejects(validateBackup(manifestPath), /manifest/);
    await write('CREATE TABLE `lj_settings` (`document` JSON);\n', { file: '../outside.sql' });
    await assert.rejects(validateBackup(manifestPath), /manifest/);
    await assert.rejects(validateBackup(path.join(BACKUP_DIR, '..', 'external.manifest.json')), /inside/);
    for (const content of ['USE production;\n', 'DROP DATABASE production;\n', 'CREATE DATABASE production;\n', 'SOURCE another.sql\n', 'CREATE TABLE `other_store` (`id` INT);\n']) {
      await write(content);
      await assert.rejects(validateBackup(manifestPath), /unsafe|unexpected/);
    }
  } finally {
    for (const file of [sql, manifestPath]) if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});
