const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dvs-security-"));
const port = 35000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
let output = "";
const server = spawn(process.execPath, [path.join(root, "server.js")], {
  cwd: root,
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DVS_DATA_DIR: dataDir, TRUST_PROXY: "1", DVS_ENABLE_ADMIN_AUTH: "1" },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"]
});
server.stdout.on("data", (chunk) => { output += chunk.toString(); });
server.stderr.on("data", (chunk) => { output += chunk.toString(); });

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch (_) { body = { text }; }
  return { response, body, text };
}

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { if ((await request("/api/health")).response.ok) return; } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Servidor de seguranca nao iniciou.\n${output}`);
}

async function main() {
  await waitForServer();

  let result = await request("/api/ping?callback=steal", { headers: { origin: "http://evil.invalid" } });
  assert.equal(result.response.status, 200);
  assert.match(result.response.headers.get("content-type") || "", /^application\/json/);
  assert.equal(result.response.headers.get("access-control-allow-origin"), null);
  assert.doesNotMatch(result.text, /^steal\(/);

  result = await request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.10", "x-forwarded-proto": "http" },
    body: JSON.stringify({ user: "admin", password: "admin" })
  });
  assert.equal(result.response.status, 426);
  assert.equal(result.body.code, "DVS_ADMIN_TLS_REQUIRED");
  assert.equal(result.response.headers.get("set-cookie"), null);

  result = await request("/dashboard", { headers: { "x-forwarded-for": "192.0.2.10", "x-forwarded-proto": "http" } });
  assert.equal(result.response.status, 200);
  assert.match(result.text, /DVS Controller - Dashboard TV/);

  result = await request("/api/state", { headers: { "x-forwarded-for": "192.0.2.10", "x-forwarded-proto": "http" } });
  assert.equal(result.response.status, 200);
  assert.equal(Array.isArray(result.body.panels), true);

  result = await request("/api/groups", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.10", "x-forwarded-proto": "http" },
    body: JSON.stringify({ name: "Aberto indevido" })
  });
  assert.equal(result.response.status, 426);
  assert.equal(result.body.code, "DVS_ADMIN_TLS_REQUIRED");

  result = await request("/api/me", { headers: { cookie: "dvs_session=%ZZ" } });
  assert.equal(result.response.status, 401);

  result = await request("/api/tv/register?id=legacy&name=Legacy");
  assert.equal(result.response.status, 410);

  result = await request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "null" },
    body: JSON.stringify({ user: "admin", password: "admin" })
  });
  assert.equal(result.response.status, 403);

  result = await request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "DVS-Security-A" },
    body: JSON.stringify({ user: "admin' OR '1'='1", password: "anything" })
  });
  assert.equal(result.response.status, 401);
  assert.equal(result.body.error, "Usuario ou senha invalidos");

  result = await request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "DVS-Security-A" },
    body: JSON.stringify({ user: "admin", password: "admin" })
  });
  assert.equal(result.response.status, 200);
  const setCookie = String(result.response.headers.get("set-cookie") || "");
  const cookie = setCookie.split(";")[0];
  const token = cookie.slice(cookie.indexOf("=") + 1);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.doesNotMatch(setCookie, /Max-Age/i);

  result = await request("/api/me", { headers: { cookie, "user-agent": "DVS-Security-B" } });
  assert.equal(result.response.status, 401);

  result = await request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "DVS-Security-A" },
    body: JSON.stringify({ user: "admin", password: "admin" })
  });
  const activeCookie = String(result.response.headers.get("set-cookie") || "").split(";")[0];
  result = await request("/api/me", { headers: { cookie: activeCookie, "user-agent": "DVS-Security-A" } });
  const csrfToken = result.body.csrfToken;
  assert.match(csrfToken, /^[A-Za-z0-9_-]{43}$/);

  result = await request("/api/change-password", {
    method: "POST",
    headers: { cookie: activeCookie, "content-type": "application/json", origin: baseUrl, "user-agent": "DVS-Security-A" },
    body: JSON.stringify({ currentPassword: "admin", newPassword: "123456789012", confirmPassword: "123456789012" })
  });
  assert.equal(result.response.status, 403);
  assert.equal(result.body.code, "DVS_CSRF_TOKEN_INVALID");

  result = await request("/api/change-password", {
    method: "POST",
    headers: { cookie: activeCookie, "content-type": "application/json", origin: baseUrl, "user-agent": "DVS-Security-A", "x-dvs-csrf": csrfToken },
    body: JSON.stringify({ currentPassword: "admin", newPassword: "123456789012", confirmPassword: "123456789012" })
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.code, "DVS_AUTH_WEAK_PASSWORD");

  result = await request("/api/change-password", {
    method: "POST",
    headers: { cookie: activeCookie, "content-type": "application/json", origin: baseUrl, "user-agent": "DVS-Security-A", "x-dvs-csrf": csrfToken },
    body: JSON.stringify({ currentPassword: "admin", newPassword: "SecurityLab123!", confirmPassword: "DifferentLab123!" })
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.code, "DVS_AUTH_PASSWORD_CONFIRMATION_MISMATCH");

  result = await request("/api/change-password", {
    method: "POST",
    headers: { cookie: activeCookie, "content-type": "application/json", origin: baseUrl, "user-agent": "DVS-Security-A", "x-dvs-csrf": csrfToken },
    body: JSON.stringify({ currentPassword: "admin", newPassword: "SecurityLab123!", confirmPassword: "SecurityLab123!" })
  });
  assert.equal(result.response.status, 200);
  const secureCookie = String(result.response.headers.get("set-cookie") || "").split(";")[0];
  const secureCsrf = result.body.csrfToken;

  const xssPayload = '<img src=x onerror="fetch(\'/stolen\')">';
  result = await request("/api/groups", {
    method: "POST",
    headers: { cookie: secureCookie, "content-type": "application/json", origin: baseUrl, "user-agent": "DVS-Security-A", "x-dvs-csrf": secureCsrf },
    body: JSON.stringify({ name: xssPayload })
  });
  assert.equal(result.response.status, 200);
  result = await request("/api/state", { headers: { cookie: secureCookie, "user-agent": "DVS-Security-A" } });
  assert.equal(result.body.groups.some((group) => group.name === xssPayload), true);

  result = await request("/admin", { headers: { cookie: secureCookie, "user-agent": "DVS-Security-A" } });
  assert.equal(result.response.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(result.response.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.match(result.response.headers.get("content-security-policy") || "", /object-src 'none'/);

  console.log("Seguranca DVS 0.6.9: OK");
}

(async () => {
  try {
    await main();
  } catch (error) {
    console.error(error.stack || error.message);
    console.error(output);
    process.exitCode = 1;
  } finally {
    try { server.kill(); } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})();
