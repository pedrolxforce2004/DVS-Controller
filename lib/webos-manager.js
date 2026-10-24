const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const APP_ID = "com.decode.dvscontroller";
let cachedCliNode = "";

function cliRoot() {
  const resourcesPath = typeof process.resourcesPath === "string" ? process.resourcesPath : path.resolve(__dirname, "..", "..");
  const external = resourcesPath && path.join(resourcesPath, "webos-node-modules", "@webos-tools", "cli");
  if (external && fs.existsSync(path.join(external, "bin", "ares.js"))) return external;
  const isolated = path.resolve(__dirname, "..", "vendor", "webos-cli-runtime", "node_modules", "@webos-tools", "cli");
  if (fs.existsSync(path.join(isolated, "bin", "ares.js"))) return isolated;
  return path.resolve(__dirname, "..", "node_modules", "@webos-tools", "cli");
}

function cliNodeExecutable() {
  if (cachedCliNode && fs.existsSync(cachedCliNode)) return cachedCliNode;
  const resourcesPath = typeof process.resourcesPath === "string" ? process.resourcesPath : path.resolve(__dirname, "..", "..");
  const candidates = [
    process.env.DVS_WEBOS_NODE,
    resourcesPath && path.join(resourcesPath, "webos-node.exe"),
    path.join(path.dirname(process.execPath), "resources", "webos-node.exe"),
    process.platform === "win32" && process.env.ProgramFiles && path.join(process.env.ProgramFiles, "nodejs", "node.exe"),
    path.basename(process.execPath).toLowerCase() === "node.exe" ? process.execPath : ""
  ].filter(Boolean);
  cachedCliNode = candidates.find((candidate) => fs.existsSync(candidate)) || "";
  if (!cachedCliNode) {
    throw new Error("Runtime Node dedicado da CLI webOS nao encontrado. Reinstale o DVS Controller.");
  }
  return cachedCliNode;
}

function cliEnvironment() {
  const env = { ...process.env };
  if (process.env.DVS_MANAGED_SERVICE !== "1") return env;
  const dataDir = path.resolve(process.env.DVS_DATA_DIR || path.join(__dirname, "..", "data"));
  const home = path.join(dataDir, "webos-home");
  const appData = path.join(home, "AppData", "Roaming");
  fs.mkdirSync(appData, { recursive: true });
  grantCurrentProcessAccess(home);
  prepareSshVault(home);
  prepareCliProfile(appData);
  relaxVaultAccess(home);
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = appData;
  env.NODE_NO_WARNINGS = "1";
  return env;
}

function prepareCliProfile(appData) {
  const workDir = path.join(appData, ".webos", "tv");
  const deviceFile = path.join(workDir, "novacom-devices.json");
  const source = path.join(cliRoot(), "files", "conf", "novacom-devices.json");
  try {
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    grantCurrentProcessAccess(workDir);
    resetReadonly(workDir);
    makeWritable(workDir, 0o700);
    if (fs.existsSync(deviceFile)) makeWritable(deviceFile, 0o600);
    let valid = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(deviceFile, "utf8"));
      valid = Array.isArray(parsed);
    } catch (_) {
      valid = false;
    }
    if (!valid && fs.existsSync(source)) {
      restoreDeviceList(source, deviceFile);
    }
  } catch (err) {
    throw new Error(`Nao foi possivel preparar os dispositivos da CLI webOS em ${deviceFile}: ${err.message}${diagnosePathAccess(workDir, deviceFile)}`);
  }
}

function makeWritable(target, mode) {
  try {
    fs.chmodSync(target, mode);
  } catch (_) {}
}

function restoreDeviceList(source, deviceFile) {
  const content = fs.readFileSync(source, "utf8");
  const directory = path.dirname(deviceFile);
  const temporary = path.join(directory, `novacom-devices.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600 });
    makeWritable(temporary, 0o600);
    resetReadonly(deviceFile);
    try { fs.rmSync(deviceFile, { force: true }); } catch (_) {}
    fs.renameSync(temporary, deviceFile);
  } catch (atomicError) {
    try {
      resetReadonly(deviceFile);
      fs.writeFileSync(deviceFile, content, { mode: 0o600 });
      try { fs.rmSync(temporary, { force: true }); } catch (_) {}
    } catch (directError) {
      try { fs.rmSync(temporary, { force: true }); } catch (_) {}
      throw new Error(`${directError.message}; tentativa atomica anterior: ${atomicError.message}`);
    }
  }
  makeWritable(deviceFile, 0o600);
}

function resetReadonly(target) {
  if (process.platform !== "win32" || !target || !fs.existsSync(target)) return;
  spawnSync("attrib.exe", ["-R", target, "/S", "/D"], {
    encoding: "utf8",
    windowsHide: true,
    shell: false
  });
}

function prepareSshVault(home, alias, resetKey) {
  if (!home) return;
  const keyDir = path.join(home, ".ssh");
  try {
    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    grantCurrentProcessAccess(keyDir);
    resetReadonly(keyDir);
    makeWritable(keyDir, 0o700);
    if (alias) {
      const keyFile = path.join(keyDir, `${String(alias).replace(/\s+/g, "_")}_webos`);
      grantCurrentProcessAccess(keyFile);
      resetReadonly(keyFile);
      makeWritable(keyFile, 0o600);
      if (resetKey && fs.existsSync(keyFile)) fs.rmSync(keyFile, { force: true });
    }
  } catch (err) {
    const keyFile = alias ? path.join(keyDir, `${String(alias).replace(/\s+/g, "_")}_webos`) : "";
    throw new Error(`Nao foi possivel preparar o cofre SSH webOS em ${keyDir}: ${err.message}${diagnosePathAccess(keyDir, keyFile)}`);
  }
}

function currentProcessSid() {
  if (process.platform !== "win32") return "";
  const result = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
    shell: false
  });
  const match = String(result.stdout || "").match(/S-1-5-(?:\d+-)+\d+/);
  return result.status === 0 && match ? match[0] : "";
}

function grantCurrentProcessAccess(home) {
  if (process.env.DVS_WEBOS_STRICT_ACL !== "1") return;
  if (process.env.DVS_SKIP_ACL_HARDENING === "1") return;
  if (process.platform !== "win32" || !home || !fs.existsSync(home)) return;
  const sid = currentProcessSid();
  const grants = ["*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"];
  if (sid && sid !== "S-1-5-18") grants.push(`*${sid}:(OI)(CI)F`);
  const result = spawnSync("icacls.exe", [home, "/inheritance:r", "/remove:g", "*S-1-5-32-545", "*S-1-1-0", "*S-1-5-11", "/grant:r"].concat(grants, ["/T", "/C", "/Q"]), {
    encoding: "utf8",
    windowsHide: true,
    shell: false
  });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `codigo ${result.status}`).trim());
  }
}

function diagnosePathAccess(workDir, deviceFile) {
  if (process.platform !== "win32") return "";
  const details = [currentProcessSid() && `sid=${currentProcessSid()}`].filter(Boolean);
  for (const target of [workDir, deviceFile]) {
    if (!target || !fs.existsSync(target)) continue;
    const result = spawnSync("icacls.exe", [target], {
      encoding: "utf8",
      windowsHide: true,
      shell: false
    });
    details.push(`${target}: ${String(result.stdout || result.stderr || "").trim() || `icacls codigo ${result.status}`}`);
  }
  return details.length ? `\nDiagnostico ACL: ${details.join(" | ")}` : "";
}

function relaxVaultAccess(home) {
  if (process.env.DVS_WEBOS_STRICT_ACL !== "1") return;
  if (process.env.DVS_SKIP_ACL_HARDENING === "1") return;
  if (!home || !fs.existsSync(home)) return;
  try {
    fs.chmodSync(home, 0o700);
    if (process.platform === "win32") {
      const sid = currentProcessSid();
      const grants = ["*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"];
      if (sid && sid !== "S-1-5-18") grants.push(`*${sid}:(OI)(CI)F`);
      const result = spawnSync("icacls.exe", [home, "/inheritance:r", "/remove:g", "*S-1-5-32-545", "*S-1-1-0", "*S-1-5-11", "/grant:r"].concat(grants, ["/T", "/C", "/Q"]), {
        encoding: "utf8",
        windowsHide: true,
        shell: false
      });
      if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || `codigo ${result.status}`).trim());
    }
  } catch (err) {
    throw new Error(`Nao foi possivel liberar o cofre SSH da CLI webOS: ${err.message}`);
  }
}

function cliScript(command) {
  const local = path.join(cliRoot(), "bin", `${command}.js`);
  if (fs.existsSync(local)) return local;
  const appData = process.env.APPDATA || "";
  const global = path.join(appData, "npm", "node_modules", "@webos-tools", "cli", "bin", `${command}.js`);
  return fs.existsSync(global) ? global : null;
}

function ensureCliBootstrap(env) {
  const userProfile = env.USERPROFILE || env.HOME || "";
  const localSource = path.join(cliRoot(), "files", "conf", "webos_emul");
  const globalSource = path.join(env.APPDATA || "", "npm", "node_modules", "@webos-tools", "cli", "files", "conf", "webos_emul");
  const source = fs.existsSync(localSource) ? localSource : globalSource;
  const keyDir = path.join(userProfile, ".ssh");
  const target = path.join(keyDir, "webos_emul");
  if (!userProfile || !fs.existsSync(source) || fs.existsSync(target)) return;
  try {
    fs.mkdirSync(keyDir, { recursive: true });
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o600);
  } catch (err) {
    throw new Error(`Nao foi possivel preparar a chave da CLI webOS em ${target}: ${err.message}`);
  }
}

function run(command, args, options) {
  options = options || {};
  return new Promise((resolve, reject) => {
    const env = cliEnvironment();
    try {
      ensureCliBootstrap(env);
    } catch (err) {
      reject(err);
      return;
    }
    const script = cliScript(command);
    let executable;
    try {
      executable = script ? cliNodeExecutable() : command;
    } catch (err) {
      reject(err);
      return;
    }
    const finalArgs = script ? [script].concat(args) : args;
    const child = spawn(executable, finalArgs, {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
      env
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let stdinSent = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill();
      setTimeout(() => {
        finishError(new Error(`${command} excedeu o limite de ${Math.round((options.timeout || 60000) / 1000)}s`));
      }, 1000).unref();
    }, options.timeout || 60000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (options.stdin && options.stdinPrompt && !stdinSent && stdout.includes(options.stdinPrompt)) {
        stdinSent = true;
        child.stdin.write(`${options.stdin}\n`);
        child.stdin.end();
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", finishError);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      const output = `${stdout}\n${stderr}`.trim();
      if (code === 0) resolve({ code, output });
      else reject(commandError(output, command, code));
    });
    if (options.stdin && !options.stdinPrompt) {
      stdinSent = true;
      child.stdin.write(`${options.stdin}\n`);
      child.stdin.end();
    }

    function finishError(err) {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      reject(err);
    }
  });
}

function cleanOutput(value) {
  return String(value || "").replace(/\u001b\[[0-9;]*m/g, "").trim().slice(-4000);
}

function commandError(output, command, code) {
  const cleaned = cleanOutput(output);
  if (/All configured authentication methods failed/i.test(cleaned)) {
    return new Error(`A autenticacao SSH da TV falhou. Ative o Key Server e use "Parear novamente" com a passphrase atual.\n${cleaned}`);
  }
  if (/Unknown DH group/i.test(cleaned)) {
    return new Error(`A CLI webOS foi executada por um runtime SSH incompativel com esta TV antiga. Reinstale o DVS Controller para restaurar o Node dedicado.\n${cleaned}`);
  }
  if (/ECONNREFUSED|Connection refused/i.test(cleaned)) {
    return new Error(`A TV recusou a conexao. Confirme o IP e deixe o Key Server ativado.\n${cleaned}`);
  }
  if (/ETIMEDOUT|timed out|Timeout/i.test(cleaned)) {
    return new Error(`A TV nao respondeu no tempo esperado. Confirme rede, IP e Developer Mode.\n${cleaned}`);
  }
  return new Error(cleaned || `${command} terminou com codigo ${code}`);
}

async function cliStatus() {
  try {
    const result = await run("ares", ["-V"], { timeout: 15000 });
    return { available: true, version: cleanOutput(result.output) };
  } catch (err) {
    return { available: false, version: "", error: err.message };
  }
}

async function ensureDevice(device) {
  const args = ["-i", `username=${device.username || "prisoner"}`, "-i", `host=${device.host}`, "-i", `port=${device.port || 9922}`, "-i", `description=DVS Controller - ${device.name}`];
  try {
    await run("ares-setup-device", ["--add", device.alias].concat(args), { timeout: 20000 });
  } catch (addError) {
    try {
      await run("ares-setup-device", ["--modify", device.alias].concat(args), { timeout: 20000 });
    } catch (modifyError) {
      throw new Error(cleanOutput(modifyError.message || addError.message));
    }
  }
}

async function pair(device, passphrase) {
  if (!String(passphrase || "").trim()) throw new Error("Informe a passphrase exibida no Key Server da TV");
  const env = cliEnvironment();
  prepareSshVault(env.USERPROFILE || env.HOME, device.alias, true);
  await ensureDevice(device);
  const result = await run("ares-novacom", ["--device", device.alias, "--getkey"], {
    stdin: String(passphrase).trim(),
    stdinPrompt: "input passphrase:",
    timeout: 45000
  });
  relaxVaultAccess(env.USERPROFILE || env.HOME);
  const verification = await deviceInfo(device);
  return `${cleanOutput(result.output) || "Chave SSH recebida"}\nConexao autenticada com sucesso.\n${verification}`.trim();
}

async function deviceInfo(device) {
  await ensureDevice(device);
  const result = await run("ares-device", ["--device", device.alias, "--system-info"], { timeout: 30000 });
  return cleanOutput(result.output);
}

async function launch(device) {
  await ensureDevice(device);
  const result = await run("ares-launch", ["--device", device.alias, APP_ID], { timeout: 30000 });
  return cleanOutput(result.output) || "Aplicacao iniciada";
}

async function close(device) {
  await ensureDevice(device);
  const result = await run("ares-launch", ["--device", device.alias, "--close", APP_ID], { timeout: 30000 });
  return cleanOutput(result.output) || "Aplicacao encerrada";
}

function latestPackage(baseDir) {
  return fs.readdirSync(baseDir)
    .filter((name) => name.startsWith(`${APP_ID}_`) && name.endsWith("_all.ipk"))
    .map((name) => ({ path: path.join(baseDir, name), stat: fs.statSync(path.join(baseDir, name)) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];
}

async function packageClient(baseDir) {
  const result = await run("ares-package", ["-o", baseDir, path.join(baseDir, "webos-client")], {
    cwd: baseDir,
    timeout: 120000
  });
  const pkg = latestPackage(baseDir);
  if (!pkg) throw new Error("O pacote IPK nao foi gerado");
  return { packagePath: pkg.path, output: cleanOutput(result.output) };
}

async function install(device, baseDir, buildFirst) {
  await ensureDevice(device);
  let pkg = latestPackage(baseDir);
  if (buildFirst || !pkg) {
    const built = await packageClient(baseDir);
    pkg = { path: built.packagePath };
  }
  const result = await run("ares-install", ["--device", device.alias, pkg.path], { cwd: baseDir, timeout: 120000 });
  return `${cleanOutput(result.output) || "Aplicacao instalada"}\n${path.basename(pkg.path)}`.trim();
}

async function readDevToken(device) {
  await ensureDevice(device);
  const result = await run("ares-novacom", ["--device", device.alias, "--run", "cat /var/luna/preferences/devmode_enabled"], { timeout: 30000 });
  const matches = cleanOutput(result.output).match(/[a-fA-F0-9]{24,}/g);
  if (!matches || !matches.length) throw new Error("Token do Developer Mode nao encontrado. Ative o Developer Mode e o Key Server na TV.");
  return matches[matches.length - 1];
}

async function renewDeveloperMode(device) {
  await ensureDevice(device);
  try {
    const result = await run("ares-extend-dev", ["-d", device.alias], { timeout: 45000 });
    return cleanOutput(result.output) || "Sessao do Developer Mode renovada pela CLI oficial";
  } catch (officialError) {
    if (!/ENOENT|not recognized|nao.*encontrado|spawn/i.test(String(officialError.message || ""))) throw officialError;
  }
  const token = await readDevToken(device);
  const endpoint = `https://developer.lge.com/secure/ResetDevModeSession.dev?sessionToken=${encodeURIComponent(token)}`;
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(20000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`LG respondeu HTTP ${response.status}`);
  let payload;
  try { payload = JSON.parse(text); } catch (_) { payload = { result: text }; }
  if (String(payload.result || "").toLowerCase() !== "success") {
    throw new Error(payload.errorMsg || payload.result || "A LG nao confirmou a renovacao");
  }
  return `${payload.errorMsg || "Sessao do Developer Mode renovada"} (fallback compativel)`;
}

async function lunaSend(device, servicePath, payload, timeout) {
  await ensureDevice(device);
  const body = JSON.stringify(payload || {});
  const result = await run("ares-novacom", ["--device", device.alias, "--run", `luna-send -n 1 -f ${servicePath} '${body}'`], { timeout: timeout || 45000 });
  return cleanOutput(result.output);
}

async function checkSystemUpdate(device) {
  const current = await lunaSend(device, "luna://com.webos.service.update/getCurrentSWInformation", {}, 45000);
  let available = "";
  try {
    available = await lunaSend(device, "luna://com.webos.service.update/checkForUpdate", {}, 120000);
  } catch (err) {
    available = `Verificacao online nao confirmada pela TV: ${err.message}`;
  }
  return [current && `Versao atual:\n${current}`, available && `Atualizacao:\n${available}`].filter(Boolean).join("\n\n");
}

async function startSystemUpdate(device) {
  const output = await lunaSend(device, "luna://com.webos.service.update/startSoftwareUpdate", {}, 120000);
  return output || "Comando de atualizacao do sistema enviado para a TV.";
}

async function removeDevice(device) {
  try {
    await run("ares-setup-device", ["--remove", device.alias], { timeout: 20000 });
  } catch (_) {
    // The DVS record can still be removed if the CLI no longer has this alias.
  }
}

module.exports = {
  APP_ID,
  cliStatus,
  pair,
  deviceInfo,
  launch,
  close,
  packageClient,
  install,
  renewDeveloperMode,
  checkSystemUpdate,
  startSystemUpdate,
  removeDevice,
  _test: process.env.NODE_ENV === "test" ? { prepareCliProfile } : undefined
};
