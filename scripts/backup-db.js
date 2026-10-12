'use strict';
const { backupDatabase } = require('./db-backup-tools');
backupDatabase().then(({ manifestPath, manifest }) => {
  console.log('Backup completed: ' + manifestPath);
  console.log('Six tables, ' + manifest.bytes + ' bytes; SHA256 ' + manifest.sha256);
}).catch(() => {
  console.error('Backup failed. Check MySQL configuration, SELECT permissions, client binaries and backup-directory permissions. No password is logged.');
  process.exitCode = 1;
});
