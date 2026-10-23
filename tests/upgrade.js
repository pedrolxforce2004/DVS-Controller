const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dvs-upgrade-'));
const data = path.join(root, 'existing-data');
fs.mkdirSync(data);
const config = { serverPort: 8443, managerPort: 9091, databasePort: 5544, databaseHost: '127.0.0.1', databaseName: 'existing_db', databaseUser: 'existing_user', databasePassword: 'preserved-password', controlToken: 'preserved-token', requireAdminTls: true, tlsCertPath: 'certificate-path', tlsKeyPath: 'key-path', customOption: 'preserved' };
fs.writeFileSync(path.join(data, 'service-config.json'), JSON.stringify(config));
const database = JSON.stringify({ tvs: [{ id: 'tv-existing', tokenHash: 'existing-hash' }], panels: [{ id: 'panel-existing', authSecret: 'encrypted-value' }], users: [{ id: 'user-existing' }] });
fs.writeFileSync(path.join(data, 'db.json'), database);
const secret = crypto.randomBytes(32); fs.writeFileSync(path.join(data, '.secret'), secret);
// Run the real setup functions against an isolated existing installation, without executing services.
const code = fs.readFileSync(path.join(__dirname, '../installer/setup.js'), 'utf8').replace(/\r\n/g, '\n').split('\ntry {\n  installLog(`Inicio')[0];
const setupRequire = createRequire(path.join(__dirname, '../installer/setup.js'));
const context = vm.createContext({ require: setupRequire, console, process: { argv: ['node', 'setup.js', 'install', root, data, path.join(root, 'postgresql')], env: {}, platform: 'linux', pid: process.pid } });
try {
  vm.runInContext(code + '\nwriteConfig();', context);
  const upgraded = JSON.parse(fs.readFileSync(path.join(data, 'service-config.json')));
  for (const key of Object.keys(config)) assert.deepEqual(upgraded[key], config[key], `preserve ${key}`);
  assert.equal(fs.readFileSync(path.join(data, 'db.json'), 'utf8'), database);
  assert.deepEqual(fs.readFileSync(path.join(data, '.secret')), secret);
  const backup = path.join(data, 'backups', fs.readdirSync(path.join(data, 'backups'))[0]);
  assert.equal(fs.readFileSync(path.join(backup, 'db.json'), 'utf8'), database);
  assert.deepEqual(fs.readFileSync(path.join(backup, '.secret')), secret);
  fs.writeFileSync(path.join(data, 'service-config.json'), '{broken');
  assert.throws(() => vm.runInContext('writeConfig()', context));
  assert.equal(fs.readFileSync(path.join(data, 'service-config.json'), 'utf8'), '{broken');
  console.log('Upgrade 0.6.7: existing configuration, identities, database, encryption key, backup and corrupt-file fail-closed OK');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
