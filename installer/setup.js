const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { updatePostgresConfiguration } = require("./postgres-config");

const action = process.argv[2];
const installDir = path.resolve(process.argv[3] || ".");
const dataDir = path.resolve(process.argv[4] || path.join(process.env.ProgramData || installDir, "DVS Controller"));
const postgresRoot = path.resolve(process.argv[5] || path.join(installDir, "resources", "postgresql"));
const serviceName = "DVSControllerPostgreSQL";
const appServiceName = "DVSControllerService";
const installLogPath = path.resolve(process.env.DVS_INSTALL_LOG || path.join(process.env.TEMP || installDir, "DVS-Controller-Setup.log"));

function installLog(message) {
  try {
    fs.mkdirSync(path.dirname(installLogPath), { recursive: true });
    fs.appendFileSync(installLogPath, `[${new Date().toISOString()}] ${String(message)}\n`);
  } catch (_) {}
}

function run(executable, args, options = {}) {
  const { quietOutput = false, ...spawnOptions } = options;
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true, ...spawnOptions });
  const output = quietOutput ? "" : `\n${String(result.stdout || "").trim()}\n${String(result.stderr || "").trim()}`;
  installLog(`${path.basename(executable)} ${args.join(" ")} -> ${result.status}${output}`.trim());
  if (result.status !== 0 && !options.ignoreError) {
    throw new Error(`${path.basename(executable)} ${args.join(" ")} falhou (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result;
}

function writeConfig() {
  migrateLegacyData();
  fs.mkdirSync(dataDir, { recursive: true });
  const target = path.join(dataDir, "service-config.json");
  let config = {};
  if (fs.existsSync(target)) config = JSON.parse(fs.readFileSync(target, "utf8"));
  if (fs.existsSync(target)) {
    const backups = path.join(dataDir, "backups", "upgrade-0.6.9-" + Date.now());
    fs.mkdirSync(backups, { recursive: true });
    for (const file of ["service-config.json", "db.json", ".secret"]) {
      const source = path.join(dataDir, file);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(backups, file));
    }
  }
  config = {
    ...config,
    serverPort: Number(config.serverPort || 3080),
    managerPort: Number(config.managerPort || 3091),
    databasePort: Number(config.databasePort || 5432),
    databaseHost: String(config.databaseHost || "127.0.0.1"),
    databaseName: String(config.databaseName || "dvs_controller"),
    databaseUser: String(config.databaseUser || "dvs_service"),
    databasePassword: String(config.databasePassword || crypto.randomBytes(24).toString("base64url")),
    controlToken: String(config.controlToken || crypto.randomBytes(32).toString("hex")),
    tizenStudioPath: detectTizenStudio(config.tizenStudioPath),
    tlsCertPath: String(config.tlsCertPath || ""),
    tlsKeyPath: String(config.tlsKeyPath || ""),
    requireAdminTls: Boolean(config.requireAdminTls)
  };
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return config;
}

function applyDataDirectoryAcl(installerSid) {
  if (!fs.existsSync(dataDir)) return;
  if (process.platform !== "win32") {
    fs.chmodSync(dataDir, 0o775);
    return;
  }
  run("takeown.exe", ["/F", dataDir, "/A", "/R", "/D", "Y"], { quietOutput: true });
  run("icacls.exe", [dataDir, "/inheritance:e", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "*S-1-5-11:(OI)(CI)M", `*${installerSid}:(OI)(CI)M`, "/Q"]);
  if (fs.readdirSync(dataDir).length) run("icacls.exe", [path.join(dataDir, "*"), "/reset", "/T", "/C", "/Q"]);
}

function currentUserSid() {
  const result = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
  const match = String(result.stdout || "").match(/S-1-5-(?:\d+-)+\d+/);
  if (result.status !== 0 || !match) throw new Error("DVS_INSTALL_USER_SID: nao foi possivel identificar o SID do instalador");
  return match[0];
}

function finalizeDataDirectoryAccess(installerSid) {
  applyDataDirectoryAcl(installerSid);
  run("icacls.exe", [dataDir, "/setowner", "*S-1-5-32-544", "/T", "/C", "/Q"]);
}

function withInstallerAccess(callback) {
  if (!fs.existsSync(dataDir) || process.platform !== "win32") return callback();
  const installerSid = currentUserSid();
  applyDataDirectoryAcl(installerSid);
  try {
    return callback();
  } finally {
    finalizeDataDirectoryAccess(installerSid);
  }
}

function migrateLegacyData() {
  const legacy = process.env.APPDATA && path.resolve(process.env.APPDATA, "DVS Controller");
  if (!legacy || legacy.toLowerCase() === dataDir.toLowerCase() || !fs.existsSync(legacy) || fs.existsSync(dataDir)) return;
  fs.mkdirSync(path.dirname(dataDir), { recursive: true });
  fs.cpSync(legacy, dataDir, { recursive: true, errorOnExist: false });
}

function detectTizenStudio(configured) {
  const candidates = [
    configured,
    process.env.TIZEN_STUDIO,
    "C:\\tizen-studio",
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Tizen Studio"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Tizen Studio")
  ].filter(Boolean);
  return candidates.find((root) => fs.existsSync(path.join(root, "tools", "sdb.exe")) && fs.existsSync(path.join(root, "tools", "ide", "bin", "tizen.bat"))) || "";
}

function installPostgres(config) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.databaseName) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.databaseUser)) throw new Error("Nome do banco ou usuario invalido");
  if (!["localhost", "127.0.0.1", "::1"].includes(config.databaseHost)) throw new Error("Banco externo: atualize o servidor manualmente preservando a configuracao existente");
  const bin = path.join(postgresRoot, "bin");
  const databaseDir = path.join(dataDir, "postgres");
  const initdb = path.join(bin, "initdb.exe");
  const versionFile = path.join(databaseDir, "PG_VERSION");
  if (!fs.existsSync(initdb)) throw new Error(`Runtime PostgreSQL nao encontrado em ${postgresRoot}`);
  let credentialDirectory = "";
  try {
    if (fs.existsSync(versionFile)) {
      const existingMajor = fs.readFileSync(versionFile, "utf8").trim();
      const version = run(path.join(bin, "postgres.exe"), ["--version"]);
      const match = String(version.stdout).match(/PostgreSQL\) (\d+)/);
      if (!match || match[1] !== existingMajor) throw new Error("Atualizacao de versao principal PostgreSQL requer migracao dedicada; dados preservados");
    } else {
      if (fs.existsSync(databaseDir)) {
        if (fs.readdirSync(databaseDir).length) {
          throw new Error(`DVS_INSTALL_PG_PARTIAL: ${databaseDir} contem uma inicializacao incompleta; preserve para diagnostico ou remova apos backup`);
        }
        fs.rmSync(databaseDir, { recursive: true, force: true });
      }
      credentialDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "dvs-pg-init-"));
      const passwordFile = path.join(credentialDirectory, "password.txt");
      fs.writeFileSync(passwordFile, `${config.databasePassword}\n`, { mode: 0o600 });
      run(initdb, ["-D", databaseDir, "-U", config.databaseUser, "--pwfile", passwordFile, "--auth-host=scram-sha-256", "--auth-local=trust", "--encoding=UTF8", "--locale=C"]);
    }
    updatePostgresConfiguration(databaseDir, config);
  } finally {
    if (credentialDirectory) fs.rmSync(credentialDirectory, { recursive: true, force: true });
  }
  const serviceQuery = run("sc.exe", ["query", serviceName], { ignoreError: true });
  if (serviceQuery.status !== 0) run(path.join(bin, "pg_ctl.exe"), ["register", "-N", serviceName, "-D", databaseDir, "-S", "auto"]);
  run("sc.exe", ["description", serviceName, "PostgreSQL do DVS Controller"], { ignoreError: true });
}

function startPostgresAndPrepareDatabase(config) {
  const bin = path.join(postgresRoot, "bin");
  run("sc.exe", ["start", serviceName], { ignoreError: true });
  const env = { ...process.env, PGPASSWORD: config.databasePassword, PGHOST: "127.0.0.1", PGPORT: String(config.databasePort), PGUSER: config.databaseUser };
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const check = run(path.join(bin, "pg_isready.exe"), ["-d", "postgres"], { env, ignoreError: true });
    if (check.status === 0) { ready = true; break; }
    spawnSync("ping", ["127.0.0.1", "-n", "2"], { windowsHide: true, stdio: "ignore" });
  }
  if (!ready) throw new Error("PostgreSQL nao ficou pronto dentro do prazo de instalacao");
  const exists = run(path.join(bin, "psql.exe"), ["-d", "postgres", "-tAc", `SELECT 1 FROM pg_database WHERE datname='${config.databaseName}'`], { env });
  if (String(exists.stdout).trim() !== "1") run(path.join(bin, "createdb.exe"), [config.databaseName], { env });
}

function xmlEscape(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function serviceExists(name) {
  return run("sc.exe", ["query", name], { ignoreError: true }).status === 0;
}

function waitForServiceAbsent(name) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!serviceExists(name)) return;
    spawnSync("ping", ["127.0.0.1", "-n", "2"], { windowsHide: true, stdio: "ignore" });
  }
  throw new Error(`O servico ${name} continuou registrado apos remocao`);
}

function removeExistingService(name, wrapper, xml) {
  if (wrapper && xml && fs.existsSync(wrapper)) {
    run(wrapper, ["stop", xml], { ignoreError: true });
    run(wrapper, ["uninstall", xml], { ignoreError: true });
  }
  if (!serviceExists(name)) return;
  run("sc.exe", ["stop", name], { ignoreError: true });
  run("sc.exe", ["delete", name], { ignoreError: true });
  waitForServiceAbsent(name);
}

function installApplicationService(config) {
  const serviceDir = path.join(dataDir, "service");
  fs.mkdirSync(serviceDir, { recursive: true });
  const wrapperSource = path.join(installDir, "resources", "WinSW-x64.exe");
  const wrapper = path.join(serviceDir, `${appServiceName}.exe`);
  const xml = path.join(serviceDir, `${appServiceName}.xml`);
  if (!fs.existsSync(wrapperSource)) throw new Error("WinSW nao foi incluido no instalador");
  removeExistingService(appServiceName, wrapper, xml);
  fs.copyFileSync(wrapperSource, wrapper);
  fs.writeFileSync(xml, `<?xml version="1.0" encoding="UTF-8"?>
<service>
  <id>${appServiceName}</id>
  <name>DVS Controller Service</name>
  <description>Supervisor do DVS Server e API local de gerenciamento.</description>
  <executable>${xmlEscape(path.join(installDir, "DVS Controller.exe"))}</executable>
  <arguments>&quot;${xmlEscape(path.join(installDir, "resources", "app.asar", "service", "host.js"))}&quot;</arguments>
  <workingdirectory>${xmlEscape(installDir)}</workingdirectory>
  <env name="ELECTRON_RUN_AS_NODE" value="1"/>
  <env name="DVS_DATA_DIR" value="${xmlEscape(dataDir)}"/>
  <env name="DVS_POSTGRES_SERVICE" value="${serviceName}"/>
  <env name="TIZEN_STUDIO" value="${xmlEscape(config.tizenStudioPath || "")}"/>
  <env name="PLAYWRIGHT_BROWSERS_PATH" value="${xmlEscape(path.join(installDir, "resources", "playwright-browsers"))}"/>
  <env name="DVS_ENABLE_ADMIN_AUTH" value="1"/>
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
  <onfailure action="restart" delay="5 sec"/>
  <onfailure action="restart" delay="15 sec"/>
  <resetfailure>1 hour</resetfailure>
  <logpath>${xmlEscape(path.join(dataDir, "logs"))}</logpath>
  <log mode="roll-by-size"><sizeThreshold>2097152</sizeThreshold><keepFiles>5</keepFiles></log>
</service>\n`);
  run(wrapper, ["install", xml]);
}

function startApplicationService() {
  const serviceDir = path.join(dataDir, "service");
  const wrapper = path.join(serviceDir, `${appServiceName}.exe`);
  const xml = path.join(serviceDir, `${appServiceName}.xml`);
  run(wrapper, ["start", xml]);
}

function waitForTcpPort(port, label) {
  const script = `$deadline=(Get-Date).AddSeconds(45); do { $client=$null; try { $client=[Net.Sockets.TcpClient]::new(); $client.Connect('127.0.0.1',${Number(port)}); $client.Dispose(); exit 0 } catch { if ($client) { $client.Dispose() }; Start-Sleep -Milliseconds 500 } } while ((Get-Date) -lt $deadline); exit 1`;
  const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { ignoreError: true });
  if (result.status !== 0) throw new Error(`${label} nao respondeu na porta ${port} dentro do prazo de instalacao`);
}

function validateInstalledServices(config) {
  waitForTcpPort(config.databasePort, "PostgreSQL");
  waitForTcpPort(config.managerPort, "Supervisor DVS");
  waitForTcpPort(config.serverPort, "Servidor DVS");
  spawnSync("ping", ["127.0.0.1", "-n", "7"], { windowsHide: true, stdio: "ignore" });
  for (const name of [serviceName, appServiceName]) {
    const state = run("sc.exe", ["query", name]);
    if (!/\bRUNNING\b/i.test(String(state.stdout))) throw new Error(`O servico ${name} nao permaneceu em execucao`);
  }
  waitForTcpPort(config.databasePort, "PostgreSQL");
  waitForTcpPort(config.serverPort, "Servidor DVS");
  installLog("Validacao pos-instalacao concluida: PostgreSQL, supervisor e servidor DVS ativos");
}

function stopServiceAndWait(name) {
  run("sc.exe", ["stop", name], { ignoreError: true });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = run("sc.exe", ["query", name], { ignoreError: true });
    if (state.status !== 0 || /\bSTOPPED\b/i.test(String(state.stdout))) return;
    spawnSync("ping", ["127.0.0.1", "-n", "2"], { windowsHide: true, stdio: "ignore" });
  }
  throw new Error(`O servico ${name} nao parou dentro do prazo de seguranca`);
}

function stopInstalledServices() {
  if (process.platform !== "win32") return;
  stopServiceAndWait(appServiceName);
  stopServiceAndWait(serviceName);
}

function uninstall() {
  const wrapper = path.join(dataDir, "service", `${appServiceName}.exe`);
  const xml = path.join(dataDir, "service", `${appServiceName}.xml`);
  if (fs.existsSync(wrapper)) {
    run(wrapper, ["stop", xml], { ignoreError: true });
    run(wrapper, ["uninstall", xml], { ignoreError: true });
  }
  run("sc.exe", ["stop", serviceName], { ignoreError: true });
  run("sc.exe", ["delete", serviceName], { ignoreError: true });
  // Os dados e backups permanecem em ProgramData para permitir reinstalacao segura.
}

try {
  installLog(`Inicio action=${action} installDir=${installDir} dataDir=${dataDir}`);
  if (action === "install") {
    stopInstalledServices();
    migrateLegacyData();
    fs.mkdirSync(dataDir, { recursive: true });
    let config;
    withInstallerAccess(() => {
      config = writeConfig();
      installPostgres(config);
      installApplicationService(config);
    });
    startPostgresAndPrepareDatabase(config);
    startApplicationService();
    validateInstalledServices(config);
  } else if (action === "uninstall") {
    stopInstalledServices();
    withInstallerAccess(uninstall);
  }
  else throw new Error("Acao esperada: install ou uninstall");
  installLog(`Concluido action=${action}`);
} catch (error) {
  installLog(error.stack || error.message);
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
}
