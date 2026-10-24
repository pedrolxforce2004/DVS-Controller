const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dvs-profile-'));
  const modulePath = path.resolve(__dirname, '../lib/tizen-manager.js');
  const calls = [];
  let fallback = false, firstPackage = true;
  const context = vm.createContext({ require: createRequire(modulePath), module: { exports: {} }, __dirname: path.dirname(modulePath), process, console, setTimeout, clearTimeout, fixtureRoot: temp, execute: async (cmd, args) => {
    calls.push(args);
    const buildDir = path.join(temp, 'tizen-client/.buildResult');
    if (args[0] === 'build-web') fs.mkdirSync(buildDir, { recursive: true });
    if (args[0] === 'package') {
      if (fallback && firstPackage) { firstPackage = false; throw new Error('Author password unavailable'); }
      fs.writeFileSync(path.join(buildDir, 'DVSReceiver.wgt'), 'fixture-only-not-signed');
    }
    return { output: 'fixture OK' };
  } });
  try {
    vm.runInContext(fs.readFileSync(modulePath, 'utf8') + `
      run = execute;
      signingProfile = () => ({ author: { key: 'fixture-author' }, distributor: { key: 'fixture-dist' } });
      cliWorkspace = () => ({ baseDir: fixtureRoot, source: require('path').join(fixtureRoot, 'tizen-client'), staged: false });
      tizenExecutable = () => 'fixture-tizen';
    `, context);
    for (const useFallback of [false, true]) {
      fallback = useFallback; firstPackage = true;
      const result = await context.module.exports.packageClient(temp, 'INFRA', useFallback ? { certificatePassword: 'fixture-password' } : {});
      assert.equal(result.profile, 'INFRA');
      const metadata = JSON.parse(fs.readFileSync(result.packagePath + '.json', 'utf8'));
      assert.equal(metadata.profile, 'INFRA'); assert.equal(metadata.version, '0.6.9');
      assert.ok(!JSON.stringify(metadata).includes('fixture-password'));
    }
    assert.ok(calls.some(args => args[0] === 'security-profiles' && args[1] === 'remove'));
    console.log('Perfil Tizen: fluxo de empacotamento e fallback com CLI simulado mantem INFRA no resultado/metadado e removem perfil temporario: OK');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(err => { console.error(err); process.exitCode = 1; });
