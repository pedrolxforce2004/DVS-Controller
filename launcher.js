const fs = require("fs");
const http = require("http");
const path = require("path");
const { fork, spawn } = require("child_process");

const WORKING_DIR = __dirname.toLowerCase().includes(".asar") ? process.cwd() : __dirname;

const HEARTBEAT_TIMEOUT_MS = Math.max(15000, Number(process.env.WATCHDOG_TIMEOUT_MS || 30000));
const RESTART_DELAY_MS = Math.max(1000, Number(process.env.WATCHDOG_RESTART_MS || 3000));
const MAX_WORKER_RSS = Math.max(256, Number(process.env.MAX_WORKER_RSS_MB || 1200)) * 1024 * 1024;
const DATA_DIR = path.resolve(process.env.DVS_DATA_DIR || path.join(__dirname, "data"));
const PID_FILE = path.join(DATA_DIR, "dvs-supervisor.pid");
const LOG_FILE = path.join(DATA_DIR, "dvs.log");
const MAX_LOG_BYTES = Math.max(1024 * 1024, Number(process.env.DVS_MAX_LOG_MB || 5) * 1024 * 1024);

let worker = null;
let lastHeartbeat = 0;
let stopping = false;
let restartTimer = null;
let workerStartedAt = 0;
let rapidExitCount = 0;
let memoryBreaches = 0;
let healthFailures = 0;
let healthCheckInFlight = false;

function rotateLog() {
  try {
    if (!fs.existsSync(LOG_FILE) || fs.statSync(LOG_FILE).size < MAX_LOG_BYTES) return;
    fs.rmSync(`${LOG_FILE}.2`, { force: true });
    if (fs.existsSync(`${LOG_FILE}.1`)) fs.renameSync(`${LOG_FILE}.1`, `${LOG_FILE}.2`);
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch (_) {}
}

function log(message, isError) {
  rotateLog();
  const line = String(message).trimEnd().split(/\r?\n/).map((part) => `[${new Date().toISOString()}] ${part}`).join("\n") + "\n";
  if (isError) process.stderr.write(line);
  else process.stdout.write(line);
  fs.appendFile(LOG_FILE, line, () => {});
}

function scheduleStart(delayMs) {
  if (stopping || restartTimer) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startWorker();
  }, delayMs || RESTART_DELAY_MS);
}

function startWorker() {
  if (stopping || worker) return;
  lastHeartbeat = Date.now();
  workerStartedAt = Date.now();
  memoryBreaches = 0;
  healthFailures = 0;
  const child = fork(path.join(__dirname, "server.js"), [], {
    cwd: WORKING_DIR,
    env: { ...process.env, DVS_SUPERVISED: "1" },
    stdio: ["inherit", "pipe", "pipe", "ipc"],
    windowsHide: true
  });
  worker = child;
  child.stdout.on("data", (chunk) => log(chunk.toString()));
  child.stderr.on("data", (chunk) => log(chunk.toString(), true));

  child.on("message", (message) => {
    if (!message || message.type !== "dvs-heartbeat") return;
    lastHeartbeat = Date.now();
    if (Number(message.memory || 0) > MAX_WORKER_RSS) memoryBreaches += 1;
    else memoryBreaches = 0;
  });
  child.on("exit", (code, signal) => {
    if (worker === child) worker = null;
    if (stopping) return;
    const runtime = Date.now() - workerStartedAt;
    rapidExitCount = runtime < 30000 ? rapidExitCount + 1 : 0;
    const delay = Math.min(30000, RESTART_DELAY_MS * Math.pow(2, Math.min(rapidExitCount, 4)));
    log(`[watchdog] Servidor encerrou (codigo ${code}, sinal ${signal || "nenhum"}). Reiniciando...`, true);
    scheduleStart(delay);
  });
  child.on("error", (err) => {
    log(`[watchdog] Falha ao iniciar servidor: ${err.message}`, true);
  });
}

function terminateWorker(child, force) {
  if (!child || !child.pid) return;
  if (force && process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
    killer.on("error", () => { try { child.kill(); } catch (_) {} });
    return;
  }
  try { child.kill(); } catch (_) {}
}

function restartUnresponsiveWorker() {
  const child = worker;
  if (!child) return;
  const heartbeatExpired = Date.now() - lastHeartbeat > HEARTBEAT_TIMEOUT_MS;
  const memoryExceeded = memoryBreaches >= 3;
  const healthFailed = healthFailures >= 3;
  if (!heartbeatExpired && !memoryExceeded && !healthFailed) return;
  const reason = heartbeatExpired
    ? `sem heartbeat por mais de ${HEARTBEAT_TIMEOUT_MS / 1000}s`
    : memoryExceeded
      ? `memoria acima de ${Math.round(MAX_WORKER_RSS / 1024 / 1024)} MB`
      : "sem resposta HTTP em tres verificacoes";
  log(`[watchdog] Servidor ${reason}. Reiniciando o processo...`, true);
  worker = null;
  child.removeAllListeners("exit");
  terminateWorker(child, true);
  scheduleStart(RESTART_DELAY_MS);
}

function checkHttpHealth() {
  if (!worker || healthCheckInFlight || Date.now() - workerStartedAt < 5000) return;
  healthCheckInFlight = true;
  let completed = false;
  const finish = (ok) => {
    if (completed) return;
    completed = true;
    healthCheckInFlight = false;
    healthFailures = ok ? 0 : healthFailures + 1;
  };
  const transport = process.env.TLS_CERT_PATH && process.env.TLS_KEY_PATH ? require("https") : http;
  const request = transport.get({
    hostname: "127.0.0.1",
    port: Number(process.env.PORT || 3080),
    path: "/api/health",
    agent: false,
    rejectUnauthorized: false,
    timeout: 3000
  }, (response) => {
    response.resume();
    finish(response.statusCode === 200);
  });
  request.on("timeout", () => { request.destroy(); finish(false); });
  request.on("error", () => finish(false));
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (!worker) return process.exit(0);
  const child = worker;
  child.once("exit", () => process.exit(0));
  terminateWorker(child, false);
  setTimeout(() => terminateWorker(child, true), 2500).unref();
  setTimeout(() => process.exit(0), 4000).unref();
}

function removePidFile() {
  try {
    if (fs.readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) fs.rmSync(PID_FILE, { force: true });
  } catch (_) {}
}

setInterval(restartUnresponsiveWorker, 5000).unref();
setInterval(checkHttpHealth, 5000).unref();
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", removePidFile);
fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
rotateLog();
fs.writeFileSync(PID_FILE, String(process.pid));
log(`[watchdog] Supervisor iniciado (PID ${process.pid}).`);
startWorker();
