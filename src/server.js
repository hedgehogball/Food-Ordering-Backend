'use strict';
const http = require('node:http');
const mysql = require('mysql2/promise');
const { createDatabase, initialize, databaseConfig } = require('./database');
const { createService } = require('./dining/service');
const { createApp } = require('./app');
const { createTakeaway } = require('./takeaway');
const { createOperations, createRoles } = require('./operations');
async function start() {
  const appId = (process.env.WX_APPID || '').trim();
  if (!/^wx[A-Za-z0-9]{16}$/.test(appId)) throw new Error('WX_APPID configuration is missing or invalid');
  const pool = mysql.createPool(databaseConfig(process.env));
  await initialize(pool);
  const staff = (process.env.CASHIER_OPENIDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const staffUsers = (process.env.CASHIER_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const owners = (process.env.OWNER_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const userId = openid => require('node:crypto').createHash('sha256').update(appId + ':' + openid).digest('hex');
  const roleOf = createRoles({ appId, cashierIds: staffUsers, cashierOpenids: staff, ownerIds: owners });
  const allStaffUsers = [...new Set([...staffUsers, ...owners, ...staff.map(userId)])];
  const operations = createOperations(pool, { roleOf });
  const db = createDatabase(pool);
  const app = createApp({
    appId,
    roleOf,
    operations: operations.handle,
    dining: (event, actor) => {
      const id = userId(actor);
      return createService(db, allStaffUsers.includes(id) ? [...staff, actor] : staff, { beforeNewSubmit: operations.beforeNewSubmit })(event, actor);
    },
    takeaway: createTakeaway(pool, allStaffUsers, { beforeNewSubmit: operations.beforeNewSubmit }),
    health: () => pool.query('SELECT 1'),
    users: id => pool.execute('INSERT INTO lj_users (id,first_seen,last_seen) VALUES (?,?,?) ON DUPLICATE KEY UPDATE last_seen=VALUES(last_seen)', [id, Date.now(), Date.now()])
  });
  const server = http.createServer({ requestTimeout: 15000, headersTimeout: 10000 }, app);
  server.on('error', error => { console.error('server_listen_failed', error.code); process.exit(1); });
  server.listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log('lianjia_order_api_ready'));
  process.on('SIGTERM', () => {
    server.close(async () => { await pool.end(); process.exit(0); });
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
start().catch(() => { console.error('startup_failed_check_database_configuration'); process.exit(1); });
