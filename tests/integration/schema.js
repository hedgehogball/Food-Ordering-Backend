'use strict';
// Fixed loopback endpoint: never use deployment environment variables here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { initialize, decode } = require('../../src/database');
const { defaultSettings } = require('../../src/operations');
const endpoint = { host: '127.0.0.1', port: 33308, user: 'root' };
const tables = ['lj_dining_tables', 'lj_dining_sessions', 'lj_users', 'lj_takeaway', 'lj_settings', 'lj_print_jobs'];
async function metadata(pool, table) {
  const [columns] = await pool.query(`SHOW FULL COLUMNS FROM ${table}`);
  const [indexes] = await pool.query(`SHOW INDEX FROM ${table}`);
  return {
    columns: columns.map(row => ({ name: row.Field, type: row.Type, collation: row.Collation, nullable: row.Null, extra: row.Extra, default: row.Default })).sort((a, b) => a.name.localeCompare(b.name)),
    indexes: indexes.map(row => ({ name: row.Key_name, unique: row.Non_unique === 0, sequence: row.Seq_in_index, column: row.Column_name })).sort((a, b) => a.name.localeCompare(b.name) || a.sequence - b.sequence)
  };
}
(async () => {
  const suffix = Date.now();
  const sqlName = 'lj_schema_test_' + suffix;
  const startupName = 'lj_startup_test_' + suffix;
  const admin = await mysql.createConnection(endpoint);
  try {
    for (const name of [sqlName, startupName]) await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally { await admin.end(); }
  // Multiple statements are enabled only for the checked-in static SQL files.
  const sql = mysql.createPool({ ...endpoint, database: sqlName, multipleStatements: true });
  const startup = mysql.createPool({ ...endpoint, database: startupName });
  const schema = fs.readFileSync(path.join(__dirname, '../../database/schema.sql'), 'utf8');
  const seed = fs.readFileSync(path.join(__dirname, '../../database/seed.sql'), 'utf8');
  try {
    await sql.query(schema); await sql.query(seed);
    await initialize(startup);
    for (const table of tables) assert.deepEqual(await metadata(sql, table), await metadata(startup, table), 'SQL and startup schema must match: ' + table);
    const [defaults] = await sql.query('SELECT document FROM lj_settings WHERE id="shop"');
    assert.deepEqual(decode(defaults[0].document), defaultSettings());
    const [seats] = await sql.query('SELECT id,document FROM lj_dining_tables ORDER BY id');
    assert.equal(seats.length, 36);
    seats.forEach((row, index) => assert.deepEqual(decode(row.document), { id: String(index + 1).padStart(2, '0'), sessionId: '' }));
    for (const table of ['lj_users', 'lj_dining_sessions', 'lj_takeaway', 'lj_print_jobs']) {
      const [rows] = await sql.query(`SELECT COUNT(*) AS total FROM ${table}`);
      assert.equal(rows[0].total, 0, 'seed contains no customer/order data');
    }
    await sql.execute('UPDATE lj_dining_tables SET document=? WHERE id=?', [JSON.stringify({ id: '03', sessionId: 'keep-session' }), '03']);
    await sql.execute('UPDATE lj_settings SET document=? WHERE id=?', [JSON.stringify({ ...defaultSettings(), version: 2, open: false }), 'shop']);
    await sql.query(schema); await sql.query(seed); await initialize(sql);
    const [preserved] = await sql.query('SELECT document FROM lj_dining_tables WHERE id="03"');
    assert.equal(decode(preserved[0].document).sessionId, 'keep-session');
    const [settings] = await sql.query('SELECT document FROM lj_settings WHERE id="shop"');
    assert.equal(decode(settings[0].document).version, 2); assert.equal(decode(settings[0].document).open, false);
    const doc = { createdAt: 1000, updatedAt: 2000, checkout: { paidAt: null } };
    await sql.execute('INSERT INTO lj_dining_sessions (id,document) VALUES (?,?)', ['schema-generated-column', JSON.stringify(doc)]);
    let [dates] = await sql.query('SELECT created_at,updated_at,paid_at FROM lj_dining_sessions');
    assert.deepEqual(dates[0], { created_at: 1000, updated_at: 2000, paid_at: null });
    doc.checkout.paidAt = 3000;
    await sql.execute('UPDATE lj_dining_sessions SET document=? WHERE id=?', [JSON.stringify(doc), 'schema-generated-column']);
    [dates] = await sql.query('SELECT paid_at FROM lj_dining_sessions'); assert.equal(dates[0].paid_at, 3000);
    const pickup = { order: { settledAt: null } };
    await sql.execute('INSERT INTO lj_takeaway (id,actor,request_id,created_at,document) VALUES (?,?,?,?,?)', ['schema-takeaway', 'a'.repeat(64), 'schema:request-001', 1000, JSON.stringify(pickup)]);
    const [unpaid] = await sql.query('SELECT paid_at FROM lj_takeaway'); assert.equal(unpaid[0].paid_at, null);
    pickup.order.settledAt = 4000;
    await sql.execute('UPDATE lj_takeaway SET document=? WHERE id=?', [JSON.stringify(pickup), 'schema-takeaway']);
    const [paid] = await sql.query('SELECT paid_at FROM lj_takeaway'); assert.equal(paid[0].paid_at, 4000);
    console.log('PASS MySQL schema: SQL/startup parity, 36 default tables, no customer data, repeat-safe initialization, existing state preserved, generated payment dates');
  } finally { await sql.end(); await startup.end(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
