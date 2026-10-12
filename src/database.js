'use strict';
// Small document adapter keeps the existing, tested dining rules unchanged.
const TABLES = { dining_tables: 'lj_dining_tables', dining_sessions: 'lj_dining_sessions' };
function document(connection, collection, id) {
  const table = TABLES[collection];
  if (!table || typeof id !== 'string' || id.length > 100) throw new Error('Invalid document');
  return {
    async get() {
      const [rows] = await connection.execute(`SELECT document FROM ${table} WHERE id=? FOR UPDATE`, [id]);
      return { data: rows.length ? decode(rows[0].document) : null };
    },
    async set({ data }) {
      await connection.execute(`INSERT INTO ${table} (id,document) VALUES (?,?) ON DUPLICATE KEY UPDATE document=VALUES(document)`, [id, JSON.stringify(data)]);
    },
    async update({ data }) {
      const existing = await this.get();
      if (!existing.data) throw new Error('Missing document');
      await this.set({ data: { ...existing.data, ...data } });
    }
  };
}
function decode(value) { return typeof value === 'string' ? JSON.parse(value) : value; }
function createDatabase(pool) {
  return {
    async runTransaction(fn) {
      for (let attempt = 0; ; attempt++) {
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          const result = await fn({ sql: connection, collection: name => ({ doc: id => document(connection, name, id) }) });
          await connection.commit();
          return result;
        } catch (error) {
          await connection.rollback();
          if (!['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code) || attempt >= 3) throw error;
        } finally { connection.release(); }
      }
    }
  };
}
async function initialize(pool) {
  for (const table of Object.values(TABLES)) {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, document JSON NOT NULL) ENGINE=InnoDB`);
  }
  await pool.query('CREATE TABLE IF NOT EXISTS lj_users (id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, first_seen BIGINT NOT NULL, last_seen BIGINT NOT NULL) ENGINE=InnoDB');
  await pool.query('CREATE TABLE IF NOT EXISTS lj_takeaway (id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, actor CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, request_id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, created_at BIGINT NOT NULL, document JSON NOT NULL, UNIQUE KEY request_once (actor,request_id), KEY user_history (actor,created_at)) ENGINE=InnoDB');
  await pool.query('CREATE TABLE IF NOT EXISTS lj_settings (id VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, document JSON NOT NULL) ENGINE=InnoDB');
  await pool.execute('INSERT IGNORE INTO lj_settings (id,document) VALUES (?,?)', ['shop', JSON.stringify(require('./operations').defaultSettings())]);
  await pool.query("CREATE TABLE IF NOT EXISTS lj_print_jobs (id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, source_key VARCHAR(200) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, status VARCHAR(16) NOT NULL, created_at BIGINT NOT NULL, document JSON NOT NULL, UNIQUE KEY source_once (source_key), KEY queue_status (status,created_at)) ENGINE=InnoDB");
  // Existing installations keep their order JSON; generated indexed dates make reports bounded by dates.
  for (const [table, columns] of Object.entries({
    lj_dining_sessions: { created_at: '$.createdAt', updated_at: '$.updatedAt', paid_at: '$.checkout.paidAt' },
    lj_takeaway: { paid_at: '$.order.settledAt' }
  })) {
    const [existing] = await pool.query(`SHOW COLUMNS FROM ${table}`);
    for (const [column, path] of Object.entries(columns)) {
      if (!existing.some(item => item.Field === column)) {
        try {
          await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} BIGINT GENERATED ALWAYS AS (CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(document,'${path}')),'null') AS UNSIGNED)) STORED, ADD INDEX report_${column} (${column})`);
        } catch (error) {
          if (error.code !== 'ER_DUP_FIELDNAME') throw error;
          const [verified] = await pool.query(`SHOW COLUMNS FROM ${table}`);
          if (!verified.some(item => item.Field === column)) throw error;
        }
      }
      const [indexes] = await pool.query(`SHOW INDEX FROM ${table}`);
      if (!indexes.some(index => index.Key_name === `report_${column}`)) {
        try { await pool.query(`ALTER TABLE ${table} ADD INDEX report_${column} (${column})`); }
        catch (error) {
          if (error.code !== 'ER_DUP_KEYNAME') throw error;
          const [verified] = await pool.query(`SHOW INDEX FROM ${table}`);
          if (!verified.some(index => index.Key_name === `report_${column}`)) throw error;
        }
      }
    }
  }
  for (let n = 1; n <= 24; n++) {
    const id = String(n).padStart(2, '0');
    await pool.execute('INSERT IGNORE INTO lj_dining_tables (id,document) VALUES (?,?)', [id, JSON.stringify({ id, sessionId: '' })]);
  }
}
async function transaction(pool, fn) {
  for (let attempt = 0; ; attempt++) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await fn(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      if (!['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code) || attempt >= 3) throw error;
    } finally { connection.release(); }
  }
}
function databaseConfig(env) {
  const [host, port = '3306'] = (env.MYSQL_ADDRESS || '').split(':');
  if (!host || !env.MYSQL_USERNAME || !env.MYSQL_PASSWORD) throw new Error('MySQL configuration is missing');
  return { host, port: Number(port), user: env.MYSQL_USERNAME, password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE || 'nodejs_demo', charset: 'utf8mb4', connectionLimit: 5,
    // mysql2 only starts its idle reaper when maxIdle is below connectionLimit.
    // Retire free sockets before the cloud gateway can silently expire them.
    maxIdle: 2, idleTimeout: 30000, enableKeepAlive: true, keepAliveInitialDelay: 10000,
    connectTimeout: 10000, waitForConnections: true, queueLimit: 100, multipleStatements: false };
}
module.exports = { createDatabase, initialize, databaseConfig, decode, transaction };
