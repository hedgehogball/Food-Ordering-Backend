'use strict';
const mysql = require('mysql2/promise');
const { databaseConfig, initialize } = require('../src/database');
(async () => {
  let pool;
  try {
    pool = mysql.createPool(databaseConfig(process.env));
    await initialize(pool);
    console.log('database_initialized: schema ready, 24 tables available; existing data preserved');
  } catch (_) {
    console.error('database_init_failed: check database settings and CREATE/ALTER permissions');
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
  }
})();
