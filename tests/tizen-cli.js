const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.DVS_TIZEN_SDK_LINK = path.join(os.tmpdir(), "DVSController", "TizenSdk");
const manager = require("../lib/tizen-manager");

async function main() {
  assert.equal(manager.APP_ID, "DVSCTRL001.DVSReceiver");
  assert.equal(manager.PACKAGE_ID, "DVSCTRL001");
  assert.equal(manager.PACKAGE_FILE, "DVSReceiver.wgt");

  const config = fs.readFileSync(path.join(__dirname, "..", "tizen-client", "config.xml"), "utf8");
  assert.match(config, /DVSCTRL001\.DVSReceiver/);
  assert.match(config, /tizen\.org\/privilege\/internet/);
  assert.match(config, /tizen\.org\/privilege\/power/);
  assert.match(config, /tizen\.org\/privilege\/tv\.inputdevice/);
  assert.match(config, /<tizen:profile\s+name="tv"\s*\/>/);
  assert.doesNotMatch(config, /tizen\.org\/privilege\/network\.get/);
  const managerSource = fs.readFileSync(path.join(__dirname, "..", "lib", "tizen-manager.js"), "utf8");
  assert.match(managerSource, /vd_appinstall/);
  assert.equal(manager._internals.isInstallClosedAfterPush(new Error([
    "pushed DVS Receiver.wgt -> 100%",
    "1 file(s) pushed. 0 file(s) skipped.",
    "C:\\ProgramData\\DVS Controller\\tizen\\tizen-client\\.buildResult\\DVS Receiver.wgt",
    "closed"
  ].join("\n"))), true);
  assert.doesNotMatch(manager._internals.cleanOutput([
    "WARNING: Your data are to be sent over an unencrypted",
    "connection and could be read by others.",
    "ok"
  ].join("\n")), /unencrypted|read by others/i);
  assert.equal(manager._internals.packageIsStale(__dirname, null), true);
  let connectAttempts = 0;
  const retryOutput = await manager._internals.connectWithRetry(
    { host: "192.168.193.177", port: 26101 },
    async function (args) {
      if (args[0] === "start-server") return { code: 0, output: "SDB iniciado" };
      connectAttempts += 1;
      if (connectAttempts === 1) {
        const error = new Error("failed to connect");
        error.output = "failed to connect";
        error.exitCode = 1;
        throw error;
      }
      return { code: 0, output: "connected" };
    },
    async function () {
      return connectAttempts < 2 ? [] : [{ serial: "192.168.193.177:26101", state: "device", name: "Samsung TV" }];
    },
    async function () {}
  );
  assert.equal(connectAttempts, 2);
  assert.match(retryOutput, /192\.168\.193\.177:26101 conectado/);
  const localSdk = path.resolve(__dirname, "..", "tools", "tizen-studio");
  if (fs.existsSync(localSdk)) assert.equal(manager.validateSdkRoot(localSdk).valid, true);
  assert.equal(manager.validateSdkRoot(path.join(__dirname, "missing-sdk")).valid, false);

  const status = await manager.cliStatus();
  if (!status.available) {
    const sdkCandidates = [
      path.resolve(__dirname, "..", "tools", "tizen-studio"),
      path.resolve(__dirname, "..", "..", "tools", "tizen-studio")
    ];
    if (process.env.TIZEN_STUDIO || sdkCandidates.some((candidate) => fs.existsSync(candidate))) {
      throw new Error(status.error || "Tizen Studio indisponivel");
    }
    console.log(`CLI Tizen: ignorada (${status.error || "SDK ausente"})`);
    return;
  }
  assert.match(status.sdb, /Smart Development Bridge/i);
  assert.match(status.tizen, /Tizen CLI/i);
  console.log(`CLI Tizen: ${status.sdb}; ${status.tizen}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
