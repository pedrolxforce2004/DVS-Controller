const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const data = fs.mkdtempSync(path.join(os.tmpdir(), "dvs-adb-cli-"));
process.env.DVS_ANDROID_HOME = path.join(data, "android-home");
const manager = require("../lib/android-manager");

async function main() {
  assert.equal(manager.APP_ID, "br.com.decode.dvsreceiver");
  assert.equal(manager.MAIN_ACTIVITY, "br.com.decode.dvsreceiver/.MainActivity");
  assert.equal(manager._test.target({ host: "192.0.2.50", port: 5555 }), "192.0.2.50:5555");
  assert.ok(manager._test.adbCandidates().some((candidate) => /platform-tools[\\/]adb(?:\.exe)?$/i.test(candidate) || candidate === "adb"));
  assert.match(manager._test.adbEnvironment().ANDROID_USER_HOME, /(android-home|DVSControllerAndroidHome)$/);

  const manifest = fs.readFileSync(path.join(__dirname, "..", "android-client", "app", "src", "main", "AndroidManifest.xml"), "utf8");
  assert.match(manifest, /android\.permission\.RECEIVE_BOOT_COMPLETED/);
  assert.match(manifest, /\.BootReceiver/);
  assert.match(manifest, /\.SettingsReceiver/);
  const settings = fs.readFileSync(path.join(__dirname, "..", "android-client", "app", "src", "main", "java", "br", "com", "decode", "dvsreceiver", "SettingsReceiver.java"), "utf8");
  assert.match(settings, /putString\("server"/);
  assert.match(settings, /putBoolean\("autoLaunch"/);

  const mainActivity = fs.readFileSync(path.join(__dirname, "..", "android-client", "app", "src", "main", "java", "br", "com", "decode", "dvsreceiver", "MainActivity.java"), "utf8");
  assert.match(mainActivity, /DVS Receiver/);
  assert.match(mainActivity, /Problema no Link do Painel/);
  assert.match(mainActivity, /focusBackground/);

  const status = await manager.cliStatus();
  if (!status.available) {
    throw new Error(status.error || "Runtime ADB empacotado ausente");
  }
  assert.match(status.version, /Android Debug Bridge/i);
  console.log(`ADB Android TV: ${status.version.split(/\r?\n/)[0]}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => fs.rmSync(data, { recursive: true, force: true }));
