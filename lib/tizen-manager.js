const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const APP_ID = "DVSCTRL001.DVSReceiver";
const PACKAGE_ID = "DVSCTRL001";
const PACKAGE_FILE = "DVSReceiver.wgt";

function copyClient(source, target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, {
    recursive: true,
    filter: (entry) => path.basename(entry) !== ".buildResult"
  });
}

function cliWorkspace(baseDir) {
  const source = path.join(baseDir, "tizen-client");
  if (!fs.existsSync(source)) throw new Error(`Cliente Tizen nao encontrado em ${source}`);
  if (!/\s/.test(baseDir)) return { baseDir, source, staged: false };
  const root = writableWorkspaceRoot();
  if (/\s/.test(root)) throw new Error("DVS_TIZEN_WORKSPACE deve apontar para um caminho sem espacos");
  const stagedSource = path.join(root, "tizen-client");
  copyClient(source, stagedSource);
  return { baseDir: root, source: stagedSource, staged: true };
}

function writableWorkspaceRoot() {
  const candidates = [
    process.env.DVS_TIZEN_WORKSPACE,
    path.join(os.tmpdir(), "DVSControllerTizenWorkspace"),
    path.join(process.env.ProgramData || "C:\\ProgramData", "DVSController", "TizenWorkspace")
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (/\s/.test(candidate)) continue;
    try {
      fs.mkdirSync(candidate, { recursive: true });
      const probe = path.join(candidate, `.probe-${process.pid}`);
      fs.writeFileSync(probe, "ok");
      fs.rmSync(probe, { force: true });
      return candidate;
    } catch (_) {}
  }
  return candidates[0];
}

function sdkRoots() {
  const resourcesPath = typeof process.resourcesPath === "string" ? process.resourcesPath : "";
  const roots = Array.from(new Set([
    process.env.TIZEN_STUDIO,
    "C:\\tizen-studio",
    resourcesPath && path.join(resourcesPath, "tizen-studio"),
    "C:\\DVS\\tizen-studio",
    path.resolve(__dirname, "..", "tools", "tizen-studio"),
    path.resolve(__dirname, "..", "..", "tools", "tizen-studio"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Tizen Studio"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Tizen Studio"),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, "tizen-studio")
  ].filter(Boolean).map((root) => path.resolve(root))));
  return roots.sort((left, right) => Number(/\s/.test(left)) - Number(/\s/.test(right)));
}

function validateSdkRoot(root) {
  const resolved = path.resolve(String(root || ""));
  const sdb = path.join(resolved, "tools", process.platform === "win32" ? "sdb.exe" : "sdb");
  const tizen = path.join(resolved, "tools", "ide", "bin", process.platform === "win32" ? "tizen.bat" : "tizen");
  return { valid: fs.existsSync(sdb) && fs.existsSync(tizen), root: resolved, sdb, tizen };
}

function cliCompatibleRoot(root) {
  if (!/\s/.test(root)) return root;
  const bridge = process.env.DVS_TIZEN_SDK_LINK || path.join(process.env.ProgramData || "C:\\ProgramData", "DVSController", "TizenSdk");
  try {
    if (!fs.existsSync(bridge)) {
      fs.mkdirSync(path.dirname(bridge), { recursive: true });
      fs.symlinkSync(root, bridge, "junction");
    }
    const validation = validateSdkRoot(bridge);
    return validation.valid ? bridge : root;
  } catch (_) {
    return root;
  }
}

function findExecutable(relativePaths) {
  for (const root of sdkRoots()) {
    const direct = validateSdkRoot(root);
    if (!direct.valid) continue;
    const commandRoot = cliCompatibleRoot(root);
    for (const relativePath of relativePaths) {
      const candidate = path.join(commandRoot, relativePath);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return "";
}

function sdbExecutable() {
  return findExecutable(["tools/sdb.exe", "tools/sdb"]);
}

function tizenExecutable() {
  return findExecutable(["tools/ide/bin/tizen.bat", "tools/ide/bin/tizen"]);
}

function cmdArgument(value) {
  const text = String(value);
  if (/[&|<>^%!"\r\n]/.test(text)) throw new Error("Parametro Tizen contem caracteres de comando invalidos");
  return `"${text}"`;
}

function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (!executable) return reject(new Error("Tizen Studio nao encontrado. Configure TIZEN_STUDIO ou instale o SDK."));
    let command = executable;
    let commandArgs = args;
    let windowsVerbatimArguments = false;
    if (process.platform === "win32" && /\.bat$/i.test(executable)) {
      let commandLine;
      try {
        commandLine = `"${[executable].concat(args).map(cmdArgument).join(" ")}"`;
      } catch (error) {
        return reject(error);
      }
      command = process.env.ComSpec || "cmd.exe";
      commandArgs = ["/d", "/s", "/c", commandLine];
      windowsVerbatimArguments = true;
    }
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
      windowsVerbatimArguments,
      env: { ...process.env, ...(options.env || {}) }
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      finish(new Error(`Comando Tizen excedeu ${Math.round((options.timeout || 60000) / 1000)}s`));
    }, options.timeout || 60000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", finish);
    child.on("close", (code) => {
      if (settled) return;
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

function cleanOutput(value) {
  const lines = String(value || "").replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/);
  const filtered = [];
  let skipStack = 0;
  for (const line of lines) {
    if (/FileManager \(C:\\tizen-studio-data\\cli\\logs\\cli\.log\)|unable to create manager for \[C:\\tizen-studio-data\\cli\\logs\\cli\.log\]/i.test(line)) {
      skipStack = 8;
      continue;
    }
    if (/org\.apache\.logging\.log4j|FileOutputStream|FileAppender|FileManager|Main\.<init>|Main\.main/i.test(line)) continue;
    if (/WARNING: Your data are to be sent over an unencrypted|connection and could be read by others/i.test(line)) continue;
    if (skipStack > 0 && /^\s+at\s+/.test(line)) {
      skipStack -= 1;
      continue;
    }
    filtered.push(line);
    skipStack = 0;
  }
  return filtered.join("\n").trim().slice(-5000);
}

function tizenError(message, output, code) {
  const error = new Error(message);
  error.output = output;
  error.exitCode = code;
  return error;
}

function commandError(output, code) {
  if (/device unauthorized|unauthorized/i.test(output)) return tizenError(`Autorize este computador na TV Samsung.\n${output}`, output, code);
  if (/device not found|no devices|offline/i.test(output)) return tizenError(`Dispositivo Tizen indisponivel. Confirme o IP e o modo Developer.\n${output}`, output, code);
  if (/Author password|ConsolePrompter\.password|NullPointerException/i.test(output)) {
    return tizenError(`O Tizen Studio nao conseguiu ler a senha salva do perfil Samsung. Informe a senha do certificado Samsung ao gerar/atualizar o WGT ou recrie o perfil no Certificate Manager.\n${output}`, output, code);
  }
  if (/certificate|signature|author/i.test(output)) return tizenError(`O pacote precisa de um perfil de certificado Samsung valido para esta TV.\n${output}`, output, code);
  if (/failed to connect|connection refused|timeout/i.test(output)) return tizenError(`A TV Samsung nao respondeu na porta SDB. Confirme o IP, a porta 26101 e o modo Developer.\n${output}`, output, code);
  return tizenError(output || `Comando Tizen terminou com codigo ${code}`, output, code);
}

function target(device) {
  return String(device.serial || `${device.host}:${device.port || 26101}`).trim();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cliStatus() {
  const sdb = sdbExecutable();
  const tizen = tizenExecutable();
  if (!sdb || !tizen) return {
    available: false,
    sdb: Boolean(sdb),
    tizen: Boolean(tizen),
    checkedRoots: sdkRoots(),
    error: "Tizen Studio nao encontrado. Instale o SDK oficial ou configure o caminho abaixo."
  };
  try {
    const [sdbVersion, tizenVersion] = await Promise.all([
      run(sdb, ["version"], { timeout: 15000 }),
      run(tizen, ["version"], { timeout: 20000 })
    ]);
    return { available: true, sdb: cleanOutput(sdbVersion.output), tizen: cleanOutput(tizenVersion.output), sdk: path.resolve(path.dirname(sdb), ".."), checkedRoots: sdkRoots() };
  } catch (error) {
    return { available: false, sdb: Boolean(sdb), tizen: Boolean(tizen), error: error.message };
  }
}

async function certificateProfiles() {
  const result = await run(tizenExecutable(), ["security-profiles", "list"], { timeout: 30000 });
  const names = [];
  result.output.split(/\r?\n/).forEach((line) => {
    const match = line.match(/(?:profile\s+name|name)\s*[:=]\s*([A-Za-z0-9_.-]+)/i)
      || line.match(/^\s*\*?\s*([A-Za-z0-9_.-]+)\s+(?:active|author|distributor|O)\b/i);
    if (match && !names.includes(match[1])) names.push(match[1]);
  });
  return { profiles: names, output: result.output || "Nenhum perfil encontrado" };
}

function sdkDataPath() {
  for (const root of sdkRoots()) {
    const infoPath = path.join(root, "sdk.info");
    if (!fs.existsSync(infoPath)) continue;
    const content = fs.readFileSync(infoPath, "utf8");
    const match = content.match(/^TIZEN_SDK_DATA_PATH=(.+)$/m);
    if (match) return match[1].trim();
  }
  return process.env.TIZEN_SDK_DATA_PATH || "C:\\tizen-studio-data";
}

function xmlAttribute(source, name) {
  const match = String(source || "").match(new RegExp(`${name}="([^"]*)"`, "i"));
  return match ? match[1] : "";
}

function signingProfile(profile) {
  const profilesPath = path.join(sdkDataPath(), "profile", "profiles.xml");
  if (!fs.existsSync(profilesPath)) throw new Error(`profiles.xml do Tizen nao encontrado em ${profilesPath}`);
  const xml = fs.readFileSync(profilesPath, "utf8");
  const profilePattern = new RegExp(`<profile\\s+[^>]*name="${profile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([\\s\\S]*?)<\\/profile>`, "i");
  const block = xml.match(profilePattern);
  if (!block) throw new Error(`Perfil Tizen '${profile}' nao encontrado em ${profilesPath}`);
  const items = {};
  const itemPattern = /<profileitem\b[^>]*>/gi;
  let match;
  while ((match = itemPattern.exec(block[1]))) {
    const item = match[0];
    items[xmlAttribute(item, "distributor") || "0"] = {
      key: xmlAttribute(item, "key"),
      password: xmlAttribute(item, "password"),
      ca: xmlAttribute(item, "ca"),
      rootca: xmlAttribute(item, "rootca")
    };
  }
  const author = items["0"];
  const distributor = items["1"];
  for (const entry of [author, distributor]) {
    if (!entry || !entry.key || !fs.existsSync(entry.key)) throw new Error(`Certificado do perfil Tizen '${profile}' nao encontrado ou incompleto`);
  }
  return { profilesPath, author, distributor };
}

async function withTemporarySigningProfile(profile, options, callback) {
  const authorPassword = String(options.authorPassword || options.certificatePassword || process.env.DVS_TIZEN_AUTHOR_PASSWORD || process.env.DVS_TIZEN_CERT_PASSWORD || "");
  const distributorPassword = String(options.distributorPassword || options.certificatePassword || process.env.DVS_TIZEN_DIST_PASSWORD || process.env.DVS_TIZEN_CERT_PASSWORD || "");
  if (!authorPassword && !distributorPassword) return callback(profile);
  if (!authorPassword || !distributorPassword) throw new Error("Informe a senha Author e Distributor do certificado Samsung, ou use a mesma senha nos dois campos.");
  const signing = signingProfile(profile);
  const tempProfile = `DVS_${profile}_${Date.now()}_${process.pid}`.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
  const args = [
    "security-profiles", "add",
    "-n", tempProfile,
    "-a", signing.author.key,
    "-p", authorPassword,
    "-d", signing.distributor.key,
    "-dp", distributorPassword
  ];
  await run(tizenExecutable(), args, { timeout: 30000 });
  try {
    return await callback(tempProfile);
  } finally {
    try { await run(tizenExecutable(), ["security-profiles", "remove", "-n", tempProfile], { timeout: 30000 }); } catch (_) {}
  }
}

function needsTemporarySigningProfile(error) {
  const output = String(error && (error.output || error.message) || "");
  return /Author password|ConsolePrompter\.password|NullPointerException|password/i.test(output);
}

async function packageWithSigningProfile(buildDir, cliBaseDir, profile, options) {
  try {
    return await run(tizenExecutable(), ["package", "-t", "wgt", "-s", profile, "--", buildDir], { cwd: cliBaseDir, timeout: 120000 });
  } catch (error) {
    if (!options || !String(options.certificatePassword || options.authorPassword || options.distributorPassword || "").trim() || !needsTemporarySigningProfile(error)) throw error;
    const fallback = await withTemporarySigningProfile(profile, options, (signProfile) => {
      return run(tizenExecutable(), ["package", "-t", "wgt", "-s", signProfile, "--", buildDir], { cwd: cliBaseDir, timeout: 120000 });
    });
    fallback.output = `${fallback.output || ""}\nAssinatura feita por perfil temporario porque o Tizen CLI recusou a senha salva do perfil original.`.trim();
    return fallback;
  }
}

async function connectWithRetry(device, execute, readDevices, pause = delay) {
  const serial = target(device);
  const output = [];
  let lastError = null;
  try {
    const started = await execute(["start-server"], 15000);
    if (started && started.output) output.push(started.output);
  } catch (error) {
    lastError = error;
    output.push(error.output || error.message || "Falha ao iniciar servidor SDB");
  }
  await pause(400);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await execute(["connect", serial], 30000);
      if (result && result.output) output.push(result.output);
    } catch (error) {
      lastError = error;
      output.push(error.output || error.message || `Tentativa SDB ${attempt} falhou`);
    }

    let devices = [];
    try {
      devices = await readDevices();
    } catch (error) {
      lastError = error;
      output.push(error.output || error.message || "Falha ao consultar dispositivos SDB");
    }
    const connected = devices.find((item) => item.serial === serial || item.serial.startsWith(`${device.host}:`));
    if (connected && connected.state === "device") {
      return `${output.filter(Boolean).join("\n")}\n${connected.serial} conectado`.trim();
    }
    if (connected && /unauthorized/i.test(connected.state)) {
      throw commandError(`device unauthorized: ${connected.serial}`, 1);
    }
    if (attempt < 3) await pause(750 * attempt);
  }

  const detail = cleanOutput(output.join("\n"));
  if (lastError) {
    throw tizenError(`${lastError.message}\nSDB nao confirmou ${serial} apos 3 tentativas. Reinicie a TV depois de salvar novamente o IP do servidor no modo Developer.`, detail, lastError.exitCode);
  }
  throw tizenError(`SDB nao confirmou ${serial} apos 3 tentativas. Reinicie a TV depois de salvar novamente o IP do servidor no modo Developer.`, detail, 1);
}

async function connect(device) {
  const sdb = sdbExecutable();
  return connectWithRetry(
    device,
    (args, timeout) => run(sdb, args, { timeout }),
    () => listDevices(),
    delay
  );
}

async function listDevices() {
  const result = await run(sdbExecutable(), ["devices"], { timeout: 15000 });
  return result.output.split(/\r?\n/).slice(1).map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length >= 2).map((parts) => ({ serial: parts[0], state: parts[1], name: parts.slice(2).join(" ") }));
}

async function deviceInfo(device) {
  await connect(device);
  const serial = target(device);
  const result = await run(sdbExecutable(), ["-s", serial, "capability"], { timeout: 30000 });
  return cleanOutput(result.output) || `${serial} conectado`;
}

function latestPackage(baseDir) {
  const roots = [baseDir, path.join(baseDir, "tizen-client", ".buildResult")];
  const packages = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (!name.toLowerCase().endsWith(".wgt")) continue;
      const packagePath = path.join(root, name);
      packages.push({ path: packagePath, stat: fs.statSync(packagePath) });
    }
  }
  return packages.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0];
}

function stablePackagePath(packagePath) {
  return path.join(path.dirname(packagePath), PACKAGE_FILE);
}

function normalizePackageFileName(packagePath) {
  const targetPath = stablePackagePath(packagePath);
  if (path.resolve(packagePath) === path.resolve(targetPath)) return packagePath;
  fs.copyFileSync(packagePath, targetPath);
  return targetPath;
}

function newestClientSourceMtime(baseDir) {
  const source = path.join(baseDir, "tizen-client");
  let newest = 0;
  function walk(root) {
    if (!fs.existsSync(root)) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.name === ".buildResult") continue;
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.isFile()) {
        newest = Math.max(newest, fs.statSync(entryPath).mtimeMs);
      }
    }
  }
  walk(source);
  return newest;
}

function packageIsStale(baseDir, pkg) {
  if (!pkg || !pkg.stat) return true;
  return newestClientSourceMtime(baseDir) > pkg.stat.mtimeMs;
}

async function packageClient(baseDir, profile, options = {}) {
  profile = String(profile || "").trim();
  if (!profile) throw new Error("Selecione um perfil de certificado Tizen/Samsung para assinar o WGT");
  if (!/^[A-Za-z0-9_.-]+$/.test(profile)) throw new Error("O nome do perfil Tizen deve usar apenas letras, numeros, ponto, hifen ou sublinhado");
  const profileInfo = signingProfile(profile);
  for (const filePath of [profileInfo.author.password, profileInfo.distributor.password].filter(Boolean)) {
    if (!fs.existsSync(filePath)) throw new Error(`Arquivo de senha do perfil Tizen nao encontrado: ${filePath}`);
  }
  const requestedBaseDir = path.resolve(baseDir);
  const projectRoot = path.resolve(__dirname, "..");
  const junctionRoot = "C:\\DVS\\project";
  const preferredBaseDir = requestedBaseDir === projectRoot && fs.existsSync(junctionRoot) ? junctionRoot : requestedBaseDir;
  const workspace = cliWorkspace(preferredBaseDir);
  const cliBaseDir = workspace.baseDir;
  const source = workspace.source;
  const buildDir = path.join(source, ".buildResult");
  await run(tizenExecutable(), ["build-web", "--output", buildDir, "--", source], { cwd: cliBaseDir, timeout: 120000 });
  for (const name of fs.readdirSync(buildDir)) {
    if (name.toLowerCase().endsWith(".wgt")) fs.rmSync(path.join(buildDir, name), { force: true });
  }
  const result = await packageWithSigningProfile(buildDir, cliBaseDir, profile, options);
  let pkg = latestPackage(cliBaseDir);
  if (!pkg) throw new Error("O pacote WGT nao foi gerado");
  pkg = { path: normalizePackageFileName(pkg.path) };
  if (workspace.staged) {
    const outputDir = path.join(requestedBaseDir, "tizen-client", ".buildResult");
    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, PACKAGE_FILE);
    fs.copyFileSync(pkg.path, outputPath);
    pkg = { path: outputPath };
  }
  return { packagePath: pkg.path, output: result.output };
}

function installOutputLooksPushed(output) {
  return /file\(s\)\s+pushed/i.test(output || "") && /\.wgt\b/i.test(output || "");
}

function isInstallClosedAfterPush(error) {
  const output = error && (error.output || error.message);
  return /(?:^|\n)\s*closed\s*$/i.test(output || "") && installOutputLooksPushed(output);
}

async function installPackage(device, pkg) {
  const remotePath = `/home/owner/share/tmp/sdk_tools/${PACKAGE_FILE}`;
  const pushed = await run(sdbExecutable(), ["-s", target(device), "push", pkg.path, remotePath], { cwd: path.dirname(pkg.path), timeout: 180000 });
  const installed = await run(sdbExecutable(), ["-s", target(device), "shell", "0", "vd_appinstall", APP_ID, remotePath], { timeout: 180000 });
  return {
    code: installed.code,
    output: [pushed.output, installed.output].filter(Boolean).join("\n")
  };
}

async function bestEffortCloseInstalledApp(device) {
  try {
    await run(sdbExecutable(), ["-s", target(device), "shell", "0", "kill", APP_ID], { timeout: 30000 });
  } catch (_) {}
}

async function bestEffortUninstallPackage(device) {
  try {
    await run(sdbExecutable(), ["-s", target(device), "uninstall", PACKAGE_ID], { timeout: 90000 });
  } catch (_) {}
}

async function reinstallAfterClosedPush(device, pkg, firstError) {
  await bestEffortCloseInstalledApp(device);
  await bestEffortUninstallPackage(device);
  try {
    const result = await installPackage(device, pkg);
    const note = "Reinstalacao automatica aplicada apos a TV fechar a primeira tentativa.";
    return { code: result.code, output: `${result.output || "Aplicacao instalada"}\n${note}`.trim() };
  } catch (retryError) {
    const firstOutput = firstError && (firstError.output || firstError.message);
    const retryOutput = retryError && (retryError.output || retryError.message);
    throw tizenError(
      `O WGT foi enviado para a TV, mas o SDB fechou antes de concluir a instalacao. O DVS tentou fechar/remover a versao anterior e reinstalar automaticamente, mas a TV ainda recusou.\nPrimeira tentativa:\n${firstOutput || "sem saida"}\nNova tentativa:\n${retryOutput || "sem saida"}`,
      `${firstOutput || ""}\n${retryOutput || ""}`.trim(),
      retryError && retryError.exitCode
    );
  }
}

async function install(device, baseDir, buildFirst, profile, options = {}) {
  await connect(device);
  let pkg = latestPackage(baseDir);
  if (buildFirst || !pkg || packageIsStale(baseDir, pkg)) pkg = { path: (await packageClient(baseDir, profile || device.profile, options)).packagePath };
  let result;
  try {
    result = await installPackage(device, pkg);
  } catch (error) {
    if (!isInstallClosedAfterPush(error)) throw error;
    result = await reinstallAfterClosedPush(device, pkg, error);
  }
  return `${result.output || "Aplicacao instalada"}\n${path.basename(pkg.path)}`.trim();
}

async function launch(device) {
  await connect(device);
  const result = await run(sdbExecutable(), ["-s", target(device), "shell", "0", "execute", APP_ID], { timeout: 45000 });
  return result.output || "DVS Receiver iniciado";
}

async function close(device) {
  await connect(device);
  const result = await run(sdbExecutable(), ["-s", target(device), "shell", "0", "kill", APP_ID], { timeout: 30000 });
  return result.output || "DVS Receiver encerrado";
}

async function uninstall(device) {
  await connect(device);
  const result = await run(sdbExecutable(), ["-s", target(device), "uninstall", PACKAGE_ID], { timeout: 90000 });
  return result.output || "DVS Receiver removido";
}

async function disconnect(device) {
  try { await run(sdbExecutable(), ["disconnect", target(device)], { timeout: 15000 }); } catch (_) {}
}

module.exports = {
  APP_ID,
  PACKAGE_ID,
  PACKAGE_FILE,
  cliStatus,
  certificateProfiles,
  connect,
  listDevices,
  deviceInfo,
  packageClient,
  install,
  launch,
  close,
  uninstall,
  disconnect,
  latestPackage,
  sdkRoots,
  validateSdkRoot,
  signingProfile,
  _internals: { cleanOutput, commandError, connectWithRetry, isInstallClosedAfterPush, newestClientSourceMtime, packageIsStale, normalizePackageFileName }
};
