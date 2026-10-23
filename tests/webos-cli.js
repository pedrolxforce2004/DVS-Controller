const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dvs-webos-cli-"));
process.env.DVS_MANAGED_SERVICE = "1";
process.env.DVS_DATA_DIR = path.join(directory, "data");
process.env.DVS_WEBOS_NODE = process.execPath;
process.env.DVS_SKIP_ACL_HARDENING = "1";
process.env.NODE_ENV = "test";
const manager = require("../lib/webos-manager");
const managerSource = fs.readFileSync(path.join(root, "lib", "webos-manager.js"), "utf8");
assert.match(managerSource, /icacls\.exe/);
assert.match(managerSource, /S-1-5-18:\(OI\)\(CI\)F/);
assert.doesNotMatch(managerSource, /S-1-5-32-545:\(OI\)\(CI\)M/);
assert.match(managerSource, /DVS_WEBOS_STRICT_ACL/);
assert.match(managerSource, /function relaxVaultAccess/);
assert.match(managerSource, /\/inheritance:r/);
assert.match(managerSource, /function prepareCliProfile/);
assert.match(managerSource, /function restoreDeviceList/);
assert.match(managerSource, /function diagnosePathAccess/);
assert.match(managerSource, /function grantCurrentProcessAccess/);
assert.match(managerSource, /function prepareSshVault/);
assert.match(managerSource, /resetKey && fs\.existsSync\(keyFile\)/);
assert.match(managerSource, /whoami\.exe/);
assert.ok(manager._test && manager._test.prepareCliProfile);

async function main() {
  const appData = path.join(directory, "data", "webos-home", "AppData", "Roaming");
  const webosProfile = path.join(appData, ".webos", "tv");
  const deviceFile = path.join(webosProfile, "novacom-devices.json");
  fs.mkdirSync(webosProfile, { recursive: true });
  fs.writeFileSync(deviceFile, "{ invalid json");
  fs.chmodSync(deviceFile, 0o400);
  manager._test.prepareCliProfile(appData);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(deviceFile, "utf8")));
  fs.accessSync(deviceFile, fs.constants.W_OK);

  const status = await manager.cliStatus();
  assert.equal(status.available, true, status.error);
  assert.match(status.version, /3\.2\.5/);
  fs.cpSync(path.join(root, "webos-client"), path.join(directory, "webos-client"), { recursive: true });
  const packaged = await manager.packageClient(directory);
  assert.ok(fs.existsSync(packaged.packagePath));
  assert.match(path.basename(packaged.packagePath), /^com\.decode\.dvscontroller_.*_all\.ipk$/);
  fs.rmSync(directory, { recursive: true, force: true });
  console.log(`CLI webOS: ${status.version}; empacotamento IPK: OK`);
}

main().catch((error) => { console.error(error); process.exit(1); });
