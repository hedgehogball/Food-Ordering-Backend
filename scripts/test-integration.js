'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
// All test programs connect only to the dedicated loopback MySQL port 33308.
for (const file of ['schema.js', 'dining.js', 'operations.js', 'acceptance.js', 'backup-restore.js', 'http-server.js']) {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'tests', 'integration', file)], { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error('integration_test_failed:', file);
    process.exit(result.status || 1);
  }
}
