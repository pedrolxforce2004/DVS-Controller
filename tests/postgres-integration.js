const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { Client } = require("pg");

const root = path.resolve(__dirname, "..");
const pgBin = path.join(root, "vendor", "postgresql", "bin");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dvs-pg-test-"));
const cluster = path.join(temp, "postgres");
const appData = path.join(temp, "data");
let server;
let postgresProcess;

function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.listen(0, "127.0.0.1", () => { const port = socket.address().port; socket.close(() => resolve(port)); });
    socket.on("error", reject);
  });
}

function run(name, args) {
  const result = spawnSync(path.join(pgBin, `${name}.exe`), args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`${name} falhou: ${result.stderr || result.stdout}`);
}

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? JSON.stringify(options.body) : "";
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method: options.method || "GET", headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {} }, (res) => {
      let value = "";
      res.on("data", (chunk) => { value += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: value ? JSON.parse(value) : {} }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForPort(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(250);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
      socket.once("error", () => resolve(false));
    });
    if (connected) {
      const ready = spawnSync(path.join(pgBin, "pg_isready.exe"), ["-h", "127.0.0.1", "-p", String(port), "-d", "postgres"], { windowsHide: true, stdio: "ignore" });
      if (ready.status === 0) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("PostgreSQL temporario nao iniciou no prazo");
}

async function waitForServer(port) {
  for (let i = 0; i < 60; i += 1) {
    try { const response = await request(port, "/api/health"); if (response.status === 200) return response; } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Servidor PostgreSQL integrado nao iniciou no prazo");
}

async function main() {
  if (!fs.existsSync(path.join(pgBin, "initdb.exe"))) return console.log("PostgreSQL integrado: ignorado (runtime ausente)");
  const databasePort = await freePort();
  const serverPort = await freePort();
  run("initdb", ["-D", cluster, "-U", "dvs_service", "--auth=trust", "--encoding=UTF8", "--locale=C"]);
  const logFd = fs.openSync(path.join(temp, "postgres.log"), "a");
  postgresProcess = spawn(path.join(pgBin, "postgres.exe"), ["-D", cluster, "-p", String(databasePort), "-h", "127.0.0.1"], { windowsHide: true, stdio: ["ignore", logFd, logFd] });
  fs.closeSync(logFd);
  await waitForPort(databasePort);
  const admin = new Client({ host: "127.0.0.1", port: databasePort, user: "dvs_service", database: "postgres" });
  await admin.connect();
  await admin.query("CREATE DATABASE dvs_controller");
  await admin.end();
  server = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(serverPort), HOST: "127.0.0.1", DVS_DATA_DIR: appData, DVS_DB_MODE: "postgres",
      DATABASE_URL: `postgresql://dvs_service@127.0.0.1:${databasePort}/dvs_controller`
    }
  });
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk; });
  server.stderr.on("data", (chunk) => { output += chunk; });
  const health = await waitForServer(serverPort);
  assert.equal(health.body.ok, true);
  const registered = await request(serverPort, "/api/tv/register", { method: "POST", body: { name: "TV Teste PostgreSQL", model: "LG 55UL3J", platform: "LG webOS", appVersion: "0.5.0" } });
  assert.equal(registered.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const database = new Client({ host: "127.0.0.1", port: databasePort, user: "dvs_service", database: "dvs_controller" });
  await database.connect();
  const saved = await database.query("SELECT name, model, app_version FROM dvs_televisions WHERE id = $1", [registered.body.tv.id]);
  await database.end();
  assert.deepEqual(saved.rows[0], { name: "TV Teste PostgreSQL", model: "LG 55UL3J", app_version: "0.5.0" });
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  server = null;
  run("pg_ctl", ["stop", "-D", cluster, "-m", "fast", "-w"]);
  postgresProcess = null;
  fs.rmSync(temp, { recursive: true, force: true });
  console.log("PostgreSQL integrado: OK");
}

main().catch((error) => {
  if (server) server.kill("SIGKILL");
  if (postgresProcess) postgresProcess.kill("SIGKILL");
  try { run("pg_ctl", ["stop", "-D", cluster, "-m", "immediate", "-w"]); } catch (_) {}
  console.error(error);
  process.exit(1);
});
