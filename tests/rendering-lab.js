const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dvs-render-lab-"));
const panelUrl = process.env.DVS_RENDER_TEST_URL || "https://painelmv.unimeduberaba.com.br/";
let server;
let output = "";

function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}

async function waitForServer(baseUrl) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Servidor de laboratorio nao iniciou.\n${output}`);
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const contentType = response.headers.get("content-type") || "";
  if (contentType.startsWith("application/json")) return { response, body: await response.json() };
  return { response, body: Buffer.from(await response.arrayBuffer()) };
}

async function main() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DVS_DATA_DIR: dataDir,
      RENDER_FPS: "2",
      RENDER_TIMEOUT_MS: "45000",
      PLAYWRIGHT_BROWSERS_PATH: path.join(root, "vendor", "playwright-browsers")
    }
  });
  server.stdout.on("data", (chunk) => { output += chunk.toString(); });
  server.stderr.on("data", (chunk) => { output += chunk.toString(); });
  await waitForServer(baseUrl);

  let result = await request(baseUrl, "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ user: "admin", password: "admin" })
  });
  assert.equal(result.response.status, 200);
  let cookie = String(result.response.headers.get("set-cookie") || "").split(";")[0];
  result = await request(baseUrl, "/api/me", { headers: { cookie } });
  let csrfToken = result.body.csrfToken;
  result = await request(baseUrl, "/api/change-password", {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: baseUrl, "x-dvs-csrf": csrfToken },
    body: JSON.stringify({ currentPassword: "admin", newPassword: "RenderingLab123!", confirmPassword: "RenderingLab123!" })
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  cookie = String(result.response.headers.get("set-cookie") || "").split(";")[0];
  csrfToken = result.body.csrfToken;
  const adminHeaders = { cookie, "content-type": "application/json", origin: baseUrl, "x-dvs-csrf": csrfToken };

  result = await request(baseUrl, "/api/panels", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ name: "Painel MV - Laboratorio", url: panelUrl, mode: "server_image", zoom: 0.65, width: 1280, height: 720 })
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  const panelId = result.body.panel.id;

  const first = await request(baseUrl, `/panel-image/${panelId}`, { headers: { cookie } });
  assert.equal(first.response.status, 200, Buffer.isBuffer(first.body) ? "" : JSON.stringify(first.body));
  assert.equal(first.body[0], 0xff);
  assert.equal(first.body[1], 0xd8);
  assert(first.body.length > 10000, `Quadro JPEG inesperadamente pequeno: ${first.body.length}`);

  await new Promise((resolve) => setTimeout(resolve, 1500));
  const second = await request(baseUrl, `/panel-image/${panelId}`, { headers: { cookie } });
  assert.equal(second.response.status, 200);
  assert.notEqual(crypto.createHash("sha256").update(first.body).digest("hex"), crypto.createHash("sha256").update(second.body).digest("hex"), "O painel nao produziu um novo quadro");

  const controller = new AbortController();
  const stream = await fetch(`${baseUrl}/panel-mjpeg/${panelId}`, { headers: { cookie }, signal: controller.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type") || "", /multipart\/x-mixed-replace/);
  const reader = stream.body.getReader();
  let received = Buffer.alloc(0);
  const deadline = Date.now() + 15000;
  while (received.length < 20000 && Date.now() < deadline) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received = Buffer.concat([received, Buffer.from(chunk.value)]);
  }
  controller.abort();
  assert(received.includes(Buffer.from("--dvsframe")), "Limite MJPEG nao encontrado");
  assert(received.includes(Buffer.from([0xff, 0xd8])), "Quadro JPEG nao encontrado no MJPEG");

  result = await request(baseUrl, "/api/diagnostics", { headers: { cookie } });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.renderer.connected, true);
  assert(result.body.renderer.pages >= 1);
  const rssMb = Math.round(result.body.memory.rss / 1024 / 1024);
  console.log(`Renderizacao: 2 quadros JPEG e MJPEG aprovados (${panelUrl}, zoom 65%, RSS ${rssMb} MB, event loop p99 ${result.body.eventLoopP99Ms} ms, JPEG ${first.body.length}/${second.body.length} bytes)`);
}

(async () => {
  try {
    await main();
  } catch (error) {
    console.error(error.stack || error.message);
    console.error(output);
    process.exitCode = 1;
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await new Promise((resolve) => server.once("exit", resolve));
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})();
