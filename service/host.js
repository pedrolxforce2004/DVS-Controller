const fs = require("fs");
const http = require("http");
const https = require("https");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const configStore = require("../lib/config-store");

const ROOT = path.resolve(__dirname, "..");
const WORKING_DIR = ROOT.toLowerCase().includes(".asar") ? process.cwd() : ROOT;
const DATA_DIR = configStore.dataDirectory();
const POSTGRES_SERVICE = process.env.DVS_POSTGRES_SERVICE || "DVSControllerPostgreSQL";
const LOG_FILE = path.join(DATA_DIR, "service-host.log");
const MAX_LOG_BYTES = Math.max(1024 * 1024, Number(process.env.DVS_MAX_LOG_MB || 5) * 1024 * 1024);
let config = configStore.load();
let application = null;
let applicationStartedAt = 0;
let stopping = false;
let restartTimer = null;
let lastExit = null;

function rotateLog() {
  try {
    if (!fs.existsSync(LOG_FILE) || fs.statSync(LOG_FILE).size < MAX_LOG_BYTES) return;
    fs.rmSync(`${LOG_FILE}.2`, { force: true });
    if (fs.existsSync(`${LOG_FILE}.1`)) fs.renameSync(`${LOG_FILE}.1`, `${LOG_FILE}.2`);
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch (_) {}
}

function log(message, error) {
  rotateLog();
  const line = `[${new Date().toISOString()}] ${String(message).trim()}\n`;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFile(LOG_FILE, line, () => {});
  (error ? process.stderr : process.stdout).write(line);
}

function applicationEnvironment() {
  config = configStore.load();
  const packagedBrowsers = path.join(process.resourcesPath || path.join(process.cwd(), "resources"), "playwright-browsers");
  return {
    ...process.env,
    PORT: String(config.serverPort),
    DVS_DATA_DIR: DATA_DIR,
    DVS_DB_MODE: "postgres",
    DATABASE_URL: configStore.databaseUrl(config),
    DVS_MANAGED_SERVICE: "1",
    TLS_CERT_PATH: config.tlsCertPath || "",
    TLS_KEY_PATH: config.tlsKeyPath || "",
    DVS_REQUIRE_ADMIN_TLS: config.requireAdminTls ? "1" : "0",
    TIZEN_STUDIO: config.tizenStudioPath || process.env.TIZEN_STUDIO || "",
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || packagedBrowsers
  };
}

function startApplication() {
  if (stopping || application) return;
  const child = spawn(process.execPath, [path.join(ROOT, "launcher.js")], {
    cwd: WORKING_DIR,
    env: applicationEnvironment(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  application = child;
  applicationStartedAt = Date.now();
  child.stdout.on("data", (chunk) => log(chunk.toString()));
  child.stderr.on("data", (chunk) => log(chunk.toString(), true));
  child.on("error", (error) => log(`[application] Falha ao iniciar: ${error.message}`, true));
  child.on("exit", (code, signal) => {
    if (application === child) application = null;
    lastExit = { code, signal: signal || "", at: new Date().toISOString() };
    log(`[application] Processo encerrado (codigo ${code}, sinal ${signal || "nenhum"}).`, code !== 0);
    if (!stopping && !restartTimer) {
      restartTimer = setTimeout(() => { restartTimer = null; startApplication(); }, 3000);
    }
  });
  child.once("spawn", () => log(`[application] DVS iniciado (PID ${child.pid}, porta ${config.serverPort}).`));
}

function stopApplication() {
  return new Promise((resolve) => {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    const child = application;
    if (!child) return resolve();
    application = null;
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    child.once("exit", finish);
    try { child.kill("SIGTERM"); } catch (_) { finish(); }
    setTimeout(() => {
      if (done || !child.pid) return;
      if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else { try { child.kill("SIGKILL"); } catch (_) {} }
      finish();
    }, 5000).unref();
  });
}

async function restartApplication() {
  await stopApplication();
  startApplication();
}

function serviceState(name) {
  if (process.platform !== "win32") return "unsupported";
  const result = spawnSync("sc.exe", ["query", name], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return "not-installed";
  const match = String(result.stdout).match(/STATE\s*:\s*\d+\s+(\w+)/i);
  return match ? match[1].toLowerCase() : "unknown";
}

function controlWindowsService(action, name) {
  if (process.platform !== "win32") throw httpError(501, "Controle de servicos disponivel apenas no Windows");
  const result = spawnSync("sc.exe", [action, name], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0 && !/service has not been started|servi.o n.o foi iniciado/i.test(String(result.stdout) + String(result.stderr))) {
    throw httpError(500, `Falha ao executar ${action} em ${name}`);
  }
}

function tcpCheck(port, host = "127.0.0.1", timeout = 1000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function httpCheck(port) {
  return new Promise((resolve) => {
    const secure = Boolean(config.tlsCertPath && config.tlsKeyPath);
    const transport = secure ? https : http;
    const request = transport.get({ hostname: "127.0.0.1", port, path: "/api/health", timeout: 1500, agent: false, rejectUnauthorized: false }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("timeout", () => { request.destroy(); resolve(false); });
    request.on("error", () => resolve(false));
  });
}

async function status() {
  const [appHealthy, postgresReachable] = await Promise.all([
    httpCheck(config.serverPort), tcpCheck(config.databasePort, config.databaseHost)
  ]);
  return {
    machine: require("os").hostname(),
    platform: `${process.platform} ${require("os").release()}`,
    managerUptime: Math.round(process.uptime()),
    config: {
      serverPort: config.serverPort,
      managerPort: config.managerPort,
      databasePort: config.databasePort,
      databaseHost: config.databaseHost,
      databaseName: config.databaseName,
      tizenStudioPath: config.tizenStudioPath || ""
      ,tlsEnabled: Boolean(config.tlsCertPath && config.tlsKeyPath)
      ,requireAdminTls: Boolean(config.requireAdminTls)
      ,tlsCertPath: config.tlsCertPath || ""
      ,tlsKeyPath: config.tlsKeyPath || ""
    },
    services: [
      {
        id: "dvs",
        name: "DVS Server",
        description: "Servidor de TVs, painel administrativo e streaming",
        port: config.serverPort,
        status: application && appHealthy ? "running" : application ? "starting" : "stopped",
        pid: application && application.pid || null,
        uptime: application ? Math.round((Date.now() - applicationStartedAt) / 1000) : 0,
        lastExit
      },
      {
        id: "postgresql",
        name: "PostgreSQL",
        description: "Banco de dados de configuracao e cadastro das TVs",
        port: config.databasePort,
        status: postgresReachable ? "running" : serviceState(POSTGRES_SERVICE) === "start_pending" ? "starting" : "stopped",
        windowsState: serviceState(POSTGRES_SERVICE)
      },
      {
        id: "manager",
        name: "Gerenciador DVS",
        description: "Supervisor e API local de controle dos servicos",
        port: config.managerPort,
        status: "running",
        pid: process.pid,
        uptime: Math.round(process.uptime())
      }
    ]
  };
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let value = "";
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.on("data", (chunk) => {
      if (settled) return;
      value += chunk;
      if (Buffer.byteLength(value) > 32768) fail(httpError(413, "Corpo da requisicao muito grande"));
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      try { resolve(value ? JSON.parse(value) : {}); } catch (_) { reject(httpError(400, "JSON invalido")); }
    });
    request.on("error", fail);
  });
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function send(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function updateConfiguration(body) {
  const previous = config;
  const next = configStore.normalize({
    ...config,
    serverPort: body.serverPort === undefined ? config.serverPort : body.serverPort,
    databasePort: body.databasePort === undefined ? config.databasePort : body.databasePort
    ,tlsCertPath: body.tlsCertPath === undefined ? config.tlsCertPath : body.tlsCertPath
    ,tlsKeyPath: body.tlsKeyPath === undefined ? config.tlsKeyPath : body.tlsKeyPath
    ,requireAdminTls: body.requireAdminTls === undefined ? config.requireAdminTls : body.requireAdminTls
  });
  if (Boolean(next.tlsCertPath) !== Boolean(next.tlsKeyPath)) throw httpError(400, "Informe o certificado e a chave TLS em conjunto");
  if (next.tlsCertPath && (!path.isAbsolute(next.tlsCertPath) || !fs.existsSync(next.tlsCertPath))) throw httpError(400, "Arquivo de certificado TLS nao encontrado");
  if (next.tlsKeyPath && (!path.isAbsolute(next.tlsKeyPath) || !fs.existsSync(next.tlsKeyPath))) throw httpError(400, "Arquivo de chave TLS nao encontrado");
  if (next.requireAdminTls && !next.tlsCertPath) throw httpError(400, "Configure certificado e chave antes de exigir HTTPS");
  if (next.serverPort === next.managerPort || next.databasePort === next.managerPort || next.serverPort === next.databasePort) {
    throw httpError(409, "As portas do servidor, gerenciador e banco devem ser diferentes");
  }
  if (next.databasePort !== config.databasePort) {
    const postgresConfig = path.join(DATA_DIR, "postgres", "postgresql.conf");
    if (!fs.existsSync(postgresConfig)) throw httpError(409, "Configuracao do PostgreSQL instalado nao foi encontrada");
    const content = fs.readFileSync(postgresConfig, "utf8");
    const changed = /^\s*port\s*=.*$/m.test(content)
      ? content.replace(/^\s*port\s*=.*$/m, `port = ${next.databasePort}`)
      : `${content}\nport = ${next.databasePort}\n`;
    fs.writeFileSync(postgresConfig, changed);
  }
  config = configStore.save(next);
  if (next.databasePort !== previous.databasePort) {
    controlWindowsService("stop", POSTGRES_SERVICE);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    controlWindowsService("start", POSTGRES_SERVICE);
  }
  await restartApplication();
  return status();
}

async function handle(request, response) {
  try {
    if (request.headers.authorization !== `Bearer ${config.controlToken}`) throw httpError(401, "Nao autorizado");
    const url = new URL(request.url, `http://127.0.0.1:${config.managerPort}`);
    if (request.method === "GET" && url.pathname === "/v1/status") return send(response, 200, await status());
    if (request.method === "PUT" && url.pathname === "/v1/config") return send(response, 200, await updateConfiguration(await readJson(request)));
    if (request.method === "POST" && url.pathname === "/v1/services/all/stop") {
      await stopApplication();
      controlWindowsService("stop", POSTGRES_SERVICE);
      return send(response, 200, await status());
    }
    const match = url.pathname.match(/^\/v1\/services\/(dvs|postgresql)\/(start|stop|restart)$/);
    if (request.method === "POST" && match) {
      const [, service, action] = match;
      if (service === "dvs") {
        if (action === "start") startApplication();
        if (action === "stop") await stopApplication();
        if (action === "restart") await restartApplication();
      } else {
        if (action === "restart") {
          controlWindowsService("stop", POSTGRES_SERVICE);
          await new Promise((resolve) => setTimeout(resolve, 1000));
          controlWindowsService("start", POSTGRES_SERVICE);
        } else controlWindowsService(action, POSTGRES_SERVICE);
        if (action !== "stop") await restartApplication();
      }
      return send(response, 200, await status());
    }
    send(response, 404, { error: "Rota nao encontrada" });
  } catch (error) {
    log(`[api] ${error.stack || error.message}`, true);
    send(response, Number(error.status || 500), { error: error.message });
  }
}

const controlServer = http.createServer(handle);
controlServer.listen(config.managerPort, "127.0.0.1", () => {
  log(`[manager] API local ativa em 127.0.0.1:${config.managerPort}.`);
  startApplication();
});
controlServer.on("error", (error) => { log(`[manager] ${error.stack || error.message}`, true); process.exit(1); });

async function shutdown() {
  if (stopping) return;
  stopping = true;
  await stopApplication();
  controlServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 7000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (error) => { log(`[fatal] ${error.stack || error.message}`, true); shutdown(); });
process.on("unhandledRejection", (error) => { log(`[fatal] ${error && error.stack || error}`, true); shutdown(); });
