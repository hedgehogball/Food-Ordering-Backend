'use strict';
const { restoreForCheck } = require('./db-backup-tools');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--manifest') {
  console.error('Usage: npm run db:check-restore -- --manifest .artifacts/backups/backup-....manifest.json');
  process.exitCode = 1;
} else restoreForCheck(args[1]).then(({ reportPath, report }) => {
  console.log('Isolated restore verified: ' + reportPath);
  console.log('New loopback test database: ' + report.database + '; six tables readable. No production database was restored.');
}).catch(() => {
  console.error('Restore check failed. Verify the backup hash, local test MySQL on 127.0.0.1:33308 and CREATE permissions. Production restoration is not supported.');
  process.exitCode = 1;
});
