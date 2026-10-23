const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const APP_ID = "br.com.decode.dvsreceiver";
const MAIN_ACTIVITY = `${APP_ID}/.MainActivity`;

function cleanOutput(value) {
  return String(value || "").replace(/\u001b\[[0-9;]*m/g, "").trim().slice(-5000);
}

function adbCandidates() {
  const resourcesPath = typeof process.resourcesPath === "string" ? process.resourcesPath : "";
  return Array.from(new Set([
    process.env.ADB,
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb"),
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb"),
    path.resolve(__dirname, "..", "artifacts", "toolchain", "android-sdk", "platform-tools", process.platform === "win32" ? "adb.exe" : "adb"),
    resourcesPath && path.join(resourcesPath, "android-sdk", "platform-tools", process.platform === "win32" ? "adb.exe" : "adb"),
    resourcesPath && path.join(resourcesPath, "android-sdk", "platform-tools", process.platform === "win32" ? "adb.exe" : "adb"),
    "adb"
  ].filter(Boolean)));
}

function adbExecutable() {
  const direct = adbCandidates().find((candidate) => candidate === "adb" || fs.existsSync(candidate));
  return direct || "";
}

function adbEnvironment(extra) {
  const candidates = [
    process.env.DVS_ANDROID_HOME,
    process.env.DVS_DATA_DIR && !/\s/.test(process.env.DVS_DATA_DIR) && path.join(process.env.DVS_DATA_DIR, "android-home"),
    path.join(process.env.ProgramData || path.join(__dirname, "..", "data"), "DVS Controller", "android-home"),
    path.join(os.tmpdir(), "DVSControllerAndroidHome")
  ].filter(Boolean).map((item) => path.resolve(item));
  let home = candidates[candidates.length - 1];
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(path.join(candidate, ".android"), { recursive: true });
      fs.mkdirSync(path.join(candidate, "AppData", "Roaming"), { recursive: true });
      fs.mkdirSync(path.join(candidate, "AppData", "Local"), { recursive: true });
      home = candidate;
      break;
    } catch (_) {}
  }
  const drive = path.parse(home).root.replace(/[\\/]$/, "") || process.env.HOMEDRIVE || "C:";
  const homePath = home.slice(drive.length) || "\\";
  return {
    ...process.env,
    ANDROID_USER_HOME: home,
    ANDROID_SDK_HOME: home,
    ANDROID_ADB_HOME: home,
    USERPROFILE: home,
    HOME: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    HOMEDRIVE: drive,
    HOMEPATH: homePath,
    ...(extra || {})
  };
}

function target(device) {
  return String(device.serial || `${device.host}:${device.port || 5555}`).trim();
}

function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    const adb = adbExecutable();
    if (!adb) return reject(new Error("ADB nao encontrado. Instale Android Platform Tools ou mantenha artifacts/toolchain/android-sdk/platform-tools."));
    const child = spawn(adb, args, { cwd: options.cwd, windowsHide: true, shell: false, env: adbEnvironment(options.env) });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      finish(new Error(`ADB excedeu ${Math.round((options.timeout || 60000) / 1000)}s`));
    }, options.timeout || 60000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", finish);
    child.on("close", (code) => {
      const output = cleanOutput(`${stdout}\n${stderr}`);
      if (code === 0) finish(null, { code, output });
      else finish(commandError(output, code));
    });
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    }
  });
}

function commandError(output, code) {
  if (/unauthorized/i.test(output)) return new Error(`Autorize a depuracao USB/Rede nesta Android TV.\n${output}`);
  if (/failed to connect|unable to connect|No route|timed out|cannot connect/i.test(output)) return new Error(`Android TV indisponivel. Confirme IP, porta 5555 e Depuracao ADB pela rede.\n${output}`);
  if (/INSTALL_FAILED/i.test(output)) return new Error(`Falha ao instalar o APK na Android TV.\n${output}`);
  return new Error(output || `ADB terminou com codigo ${code}`);
}

async function cliStatus() {
  try {
    const result = await run(["version"], { timeout: 15000 });
    return { available: true, version: result.output, adb: adbExecutable(), checkedPaths: adbCandidates() };
  } catch (error) {
    return { available: false, version: "", error: error.message, checkedPaths: adbCandidates() };
  }
}

async function connect(device) {
  const serial = target(device);
  const result = await run(["connect", serial], { timeout: 30000 });
  const devices = await listDevices();
  const connected = devices.find((item) => item.serial === serial && item.state === "device");
  if (!connected) throw new Error(`ADB nao confirmou conexao com ${serial}.\n${result.output}`);
  return `${result.output || "Conexao ADB solicitada"}\n${serial} conectado`.trim();
}

async function listDevices() {
  const result = await run(["devices"], { timeout: 15000 });
  return result.output.split(/\r?\n/).slice(1).map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length >= 2).map((parts) => ({ serial: parts[0], state: parts[1] }));
}

async function deviceInfo(device) {
  await connect(device);
  const serial = target(device);
  const [model, release, sdk] = await Promise.all([
    run(["-s", serial, "shell", "getprop", "ro.product.model"], { timeout: 15000 }),
    run(["-s", serial, "shell", "getprop", "ro.build.version.release"], { timeout: 15000 }),
    run(["-s", serial, "shell", "getprop", "ro.build.version.sdk"], { timeout: 15000 })
  ]);
  return `Modelo: ${model.output || "Android TV"}\nAndroid: ${release.output || "?"} (SDK ${sdk.output || "?"})`;
}

function latestPackage(baseDir) {
  const resourcesPath = typeof process.resourcesPath === "string" ? process.resourcesPath : "";
  const roots = [
    resourcesPath,
    resourcesPath && path.join(resourcesPath, "android"),
    path.join(baseDir, "dist"),
    path.join(baseDir, "android-client", "app", "build", "outputs", "apk", "release"),
    path.join(baseDir, "android-client", "app", "build", "outputs", "apk", "debug")
  ].filter(Boolean);
  const packages = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (!name.toLowerCase().endsWith(".apk")) continue;
      const packagePath = path.join(root, name);
      packages.push({ path: packagePath, stat: fs.statSync(packagePath) });
    }
  }
  return packages.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0];
}

async function install(device, baseDir) {
  await connect(device);
  const pkg = latestPackage(baseDir);
  if (!pkg) throw new Error("APK Android nao encontrado. Gere DVS-Receiver-0.6.8.apk antes de instalar.");
  const result = await run(["-s", target(device), "install", "-r", pkg.path], { timeout: 180000 });
  return `${result.output || "Aplicacao instalada"}\n${path.basename(pkg.path)}`.trim();
}

async function launch(device) {
  await connect(device);
  const result = await run(["-s", target(device), "shell", "am", "start", "-n", MAIN_ACTIVITY], { timeout: 30000 });
  return result.output || "DVS Receiver iniciado";
}

async function close(device) {
  await connect(device);
  const result = await run(["-s", target(device), "shell", "am", "force-stop", APP_ID], { timeout: 30000 });
  return result.output || "DVS Receiver encerrado";
}

async function setAutoLaunch(device, enabled) {
  await connect(device);
  const value = enabled ? "true" : "false";
  const result = await run(["-s", target(device), "shell", "cmd", "package", "set-component-enabled-setting", `${APP_ID}/.BootReceiver`, enabled ? "enabled" : "disabled"], { timeout: 30000 }).catch(() => ({ output: "" }));
  await run(["-s", target(device), "shell", "am", "broadcast", "-a", `${APP_ID}.SET_AUTO_LAUNCH`, "--ez", "enabled", value, "-n", `${APP_ID}/.SettingsReceiver`], { timeout: 30000 }).catch(() => ({ output: "" }));
  return result.output || `Inicializacao automatica ${enabled ? "ativada" : "desativada"}`;
}

async function configureReceiver(device, options = {}) {
  await connect(device);
  const server = String(options.server || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/?#]+$/i.test(server)) throw new Error("URL publica do servidor Android invalida para configurar o receiver");
  const args = [
    "-s", target(device), "shell", "am", "broadcast",
    "-a", `${APP_ID}.SET_AUTO_LAUNCH`,
    "--ez", "enabled", device.autoLaunch ? "true" : "false",
    "--es", "server", server,
    "--es", "name", String(options.name || device.name || "Android TV"),
    "--ez", "http", /^http:\/\//i.test(server) ? "true" : "false",
    "-n", `${APP_ID}/.SettingsReceiver`
  ];
  const result = await run(args, { timeout: 30000 });
  return result.output || "Receiver Android configurado";
}

async function uninstall(device) {
  await connect(device);
  const result = await run(["-s", target(device), "uninstall", APP_ID], { timeout: 90000 });
  return result.output || "DVS Receiver removido";
}

async function disconnect(device) {
  try { await run(["disconnect", target(device)], { timeout: 15000 }); } catch (_) {}
}

module.exports = { APP_ID, MAIN_ACTIVITY, cliStatus, connect, listDevices, deviceInfo, install, launch, close, setAutoLaunch, configureReceiver, uninstall, disconnect, latestPackage, _test: { adbCandidates, target, adbEnvironment } };
