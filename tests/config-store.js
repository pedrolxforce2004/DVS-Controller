const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dvs-config-"));
process.env.DVS_DATA_DIR = directory;
const store = require("../lib/config-store");

const created = store.load();
assert.equal(created.serverPort, 3080);
assert.equal(created.databasePort, 5432);
assert.equal(created.controlToken.length, 64);
assert.ok(created.databasePassword.length >= 24);
const saved = store.save({ ...created, serverPort: 8088, databasePort: 5544, tizenStudioPath: "C:\\tizen-studio", tlsCertPath: "C:\\tls\\server.crt", tlsKeyPath: "C:\\tls\\server.key", requireAdminTls: true });
assert.equal(saved.serverPort, 8088);
assert.equal(store.load().databasePort, 5544);
assert.equal(store.load().tizenStudioPath, "C:\\tizen-studio");
assert.equal(store.load().tlsCertPath, "C:\\tls\\server.crt");
assert.equal(store.load().requireAdminTls, true);
assert.match(store.databaseUrl(saved), /^postgresql:\/\/dvs_service:/);
assert.equal(store.normalize({ serverPort: 70000 }).serverPort, 3080);
fs.rmSync(directory, { recursive: true, force: true });
console.log("Config store: OK");
