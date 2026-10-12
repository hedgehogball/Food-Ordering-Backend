'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { createInterface } = require('node:readline');

const TABLES = ['lj_dining_tables', 'lj_dining_sessions', 'lj_users', 'lj_takeaway', 'lj_settings', 'lj_print_jobs'];
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BACKUP_DIR = path.join(PROJECT_ROOT, '.artifacts', 'backups');
function reject(message) { throw new Error(message); }
function secureBackupDirectory() {
  for (const directory of [path.join(PROJECT_ROOT, '.artifacts'), BACKUP_DIR]) {
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) reject('Backup directory must not be a link');
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(PROJECT_ROOT), resolved = fs.realpathSync(BACKUP_DIR);
  if (!resolved.startsWith(root + path.sep)) reject('Backup directory is outside the project');
  if (process.platform === 'win32') {
    // Rebuild the DACL from the current Windows identity; no shared inherited access.
    const command = [
      '$ErrorActionPreference = "Stop"',
      '$taskAcl = New-Object System.Security.AccessControl.DirectorySecurity',
      '$taskAcl.SetAccessRuleProtection($true, $false)',
      '$taskSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
      '$taskRule = New-Object System.Security.AccessControl.FileSystemAccessRule($taskSid, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")',
      '$taskAcl.AddAccessRule($taskRule)',
      '[System.IO.Directory]::SetAccessControl($env:LJ_BACKUP_SECURE_PATH, $taskAcl)'
    ].join('; ');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true, stdio: 'ignore', env: { ...process.env, LJ_BACKUP_SECURE_PATH: BACKUP_DIR }
    });
    if (result.error || result.status !== 0) reject('Cannot restrict Windows backup permissions');
  } else fs.chmodSync(BACKUP_DIR, 0o700);
  return BACKUP_DIR;
}
function sourceConfig(env = process.env) {
  const address = String(env.MYSQL_ADDRESS || '');
  const match = /^([A-Za-z0-9_.-]+)(?::(\d{1,5}))?$/.exec(address);
  if (!match || !env.MYSQL_USERNAME || env.MYSQL_PASSWORD === undefined || !/^[A-Za-z0-9_]{1,64}$/.test(env.MYSQL_DATABASE || '')) reject('Set MYSQL_ADDRESS, MYSQL_USERNAME, MYSQL_PASSWORD and MYSQL_DATABASE');
  const port = Number(match[2] || 3306);
  if (port < 1 || port > 65535) reject('Invalid MySQL port');
  if (!env.MYSQL_PASSWORD && !(match[1] === '127.0.0.1' && port === 33308)) reject('An empty password is allowed only on the isolated local test server');
  return { host: match[1], port, user: env.MYSQL_USERNAME, password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE };
}
function tool(name, env) {
  const directory = env.MYSQL_CLIENT_BIN || (process.platform === 'win32' ? 'D:\\phpstudy_pro\\Extensions\\MySQL5.7.26\\bin' : '');
  return directory ? path.resolve(directory, name + (process.platform === 'win32' ? '.exe' : '')) : name;
}
function iniValue(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\0/g, '\\0') + '"';
}
async function withCredentials(config, env, fn) {
  secureBackupDirectory();
  const credentialFile = path.join(BACKUP_DIR, '.credentials-' + crypto.randomUUID() + '.cnf');
  fs.writeFileSync(credentialFile, '[client]\n' + Object.entries({ host: config.host, port: config.port, user: config.user, password: config.password, protocol: 'TCP', 'default-character-set': 'utf8mb4' }).map(([key, value]) => key + '=' + iniValue(value)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  try { return await fn(credentialFile); }
  finally { fs.unlinkSync(credentialFile); }
}
async function runTool(executable, args, env, { inputFile, outputFile } = {}) {
  const childEnv = { ...env }; delete childEnv.MYSQL_PWD;
  const child = spawn(executable, args, { windowsHide: true, shell: false, cwd: BACKUP_DIR, env: childEnv, stdio: ['pipe', 'pipe', 'ignore'] });
  const ended = new Promise((resolve, rejectPromise) => {
    child.once('error', () => rejectPromise(new Error('MySQL client could not start; check MYSQL_CLIENT_BIN')));
    child.once('close', code => code === 0 ? resolve() : rejectPromise(new Error('MySQL client failed; verify connection and permissions (exit ' + code + ')')));
  });
  const tasks = [ended];
  let text = '';
  if (outputFile) tasks.push(pipeline(child.stdout, fs.createWriteStream(outputFile, { flags: 'wx', mode: 0o600 })));
  else child.stdout.on('data', chunk => { if (text.length < 1024 * 1024) text += chunk.toString('utf8'); });
  if (inputFile) tasks.push(pipeline(fs.createReadStream(inputFile), child.stdin));
  else child.stdin.end();
  await Promise.all(tasks);
  return text;
}
async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function backupDatabase(env = process.env) {
  const config = sourceConfig(env);
  return withCredentials(config, env, async credentials => {
    const name = 'backup-' + new Date().toISOString().replace(/[-:.]/g, '') + '-' + crypto.randomBytes(4).toString('hex');
    const file = path.join(BACKUP_DIR, name + '.sql');
    // Relative ASCII filenames also work with older Windows mysql clients in a Chinese project path.
    const args = ['--defaults-extra-file=./' + path.basename(credentials), '--single-transaction', '--quick', '--skip-lock-tables', '--skip-add-locks', '--skip-triggers', '--skip-comments', '--skip-add-drop-table', '--complete-insert', '--hex-blob', '--no-tablespaces', '--set-gtid-purged=OFF', config.database, ...TABLES];
    // mysql 8 adds column statistics unsupported by MySQL 5.7; probe client capabilities only.
    const help = spawnSync(tool('mysqldump', env), ['--help'], { windowsHide: true, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    if (help.error || help.status !== 0) reject('mysqldump is unavailable; check MYSQL_CLIENT_BIN');
    if (help.stdout.includes('--column-statistics')) args.splice(1, 0, '--column-statistics=0');
    try {
      await runTool(tool('mysqldump', env), args, env, { outputFile: file });
      const manifest = { version: 1, createdAt: new Date().toISOString(), file: path.basename(file), sha256: await sha256(file), bytes: fs.statSync(file).size, tables: TABLES };
      if (!manifest.bytes) reject('Backup is empty');
      const manifestPath = path.join(BACKUP_DIR, name + '.manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      return { manifest, manifestPath };
    } catch (error) { if (fs.existsSync(file)) fs.unlinkSync(file); throw error; }
  });
}
async function validateBackup(manifestPath) {
  const directory = secureBackupDirectory();
  const resolvedManifest = path.resolve(manifestPath);
  if (path.dirname(resolvedManifest) !== directory || !/\.manifest\.json$/.test(resolvedManifest) || fs.lstatSync(resolvedManifest).isSymbolicLink()) reject('Select a manifest directly inside .artifacts/backups');
  const manifest = JSON.parse(fs.readFileSync(resolvedManifest, 'utf8'));
  if (manifest.version !== 1 || typeof manifest.file !== 'string' || !/^backup-[A-Za-z0-9TZ_-]+\.sql$/.test(manifest.file) || !/^[a-f0-9]{64}$/.test(manifest.sha256 || '') || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || JSON.stringify(manifest.tables) !== JSON.stringify(TABLES)) reject('Invalid backup manifest');
  const sqlPath = path.join(directory, manifest.file);
  if (fs.lstatSync(sqlPath).isSymbolicLink() || fs.statSync(sqlPath).size !== manifest.bytes || await sha256(sqlPath) !== manifest.sha256) reject('Backup hash or size does not match');
  const lines = createInterface({ input: fs.createReadStream(sqlPath), crlfDelay: Infinity });
  // Only the project's own mysqldump output is accepted; it contains no database switch.
  for await (const line of lines) {
    if (/^\s*(?:USE\b|(?:CREATE|DROP|ALTER)\s+(?:DATABASE|SCHEMA)\b|SOURCE\b|CONNECT\b|\\[!.])/i.test(line)) reject('Backup contains an unsafe database-switch command');
    const command = /^\s*(?:CREATE TABLE|INSERT INTO|DROP TABLE(?: IF EXISTS)?|ALTER TABLE)\s+`([^`]+)`/i.exec(line);
    if (command && !TABLES.includes(command[1])) reject('Backup contains an unexpected table');
  }
  return { manifest, sqlPath };
}
async function restoreForCheck(manifestPath, env = process.env) {
  const { manifest, sqlPath } = await validateBackup(manifestPath);
  // No deployment MYSQL_* host or credentials are read for restoration.
  const config = { host: '127.0.0.1', port: 33308, user: env.RESTORE_TEST_USER || 'root', password: env.RESTORE_TEST_PASSWORD || '' };
  const database = 'lj_restore_test_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
  return withCredentials(config, env, async credentials => {
    const client = tool('mysql', env), defaults = '--defaults-extra-file=./' + path.basename(credentials);
    await runTool(client, [defaults, '--batch', '--skip-column-names', '--execute=CREATE DATABASE `' + database + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'], env);
    await runTool(client, [defaults, '--batch', database], env, { inputFile: sqlPath });
    const counts = await runTool(client, [defaults, '--batch', '--skip-column-names', database, '--execute=' + TABLES.map(table => "SELECT '" + table + "',COUNT(*) FROM `" + table + '`').join(' UNION ALL ')], env);
    const rows = Object.fromEntries(counts.trim().split(/\r?\n/).map(line => { const [name, count] = line.split('\t'); return [name, Number(count)]; }));
    if (TABLES.some(table => !Number.isSafeInteger(rows[table]) || rows[table] < 0)) reject('Restored table verification failed');
    const report = { version: 1, restoredAt: new Date().toISOString(), database, sourceSha256: manifest.sha256, tables: rows, scope: 'isolated-local-restore-only', manualProductionAcceptance: false };
    const reportPath = path.join(BACKUP_DIR, database + '.report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { report, reportPath };
  });
}
module.exports = { TABLES, PROJECT_ROOT, BACKUP_DIR, sourceConfig, backupDatabase, validateBackup, restoreForCheck, secureBackupDirectory };
