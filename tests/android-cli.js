const assert = require("assert");
const fs = require("fs");
const path = require("path");
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
    console.log(`ADB Android TV: ignorado (${status.error || "platform-tools ausente"})`);
    return;
  }
  assert.match(status.version, /Android Debug Bridge/i);
  console.log(`ADB Android TV: ${status.version.split(/\r?\n/)[0]}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
