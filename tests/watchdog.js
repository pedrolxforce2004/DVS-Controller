const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dvs-watchdog-"));
const port = 32000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
let supervisor;
let adminPassword = "admin";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function waitForHealth(expectedPid, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let cookie = "";
  while (Date.now() < deadline) {
    try {
      const health = await request("/api/health");
      if (!health.response.ok) throw new Error("health indisponivel");
      const login = await request("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user: "admin", password: adminPassword })
      });
      if (!login.response.ok) throw new Error("login indisponivel");
      cookie = (login.response.headers.get("set-cookie") || "").split(";")[0];
      const me = await request("/api/me", { headers: { cookie } });
      if (me.body.mustChangePassword) {
        const changed = await request("/api/change-password", {
          method: "POST",
          headers: { cookie, "content-type": "application/json", origin: baseUrl, "x-dvs-csrf": me.body.csrfToken },
          body: JSON.stringify({ currentPassword: adminPassword, newPassword: "Watchdog123!", confirmPassword: "Watchdog123!" })
        });
        if (!changed.response.ok) throw new Error("troca de senha indisponivel");
        adminPassword = "Watchdog123!";
        cookie = (changed.response.headers.get("set-cookie") || "").split(";")[0];
      }
      const diagnostics = await request("/api/diagnostics", { headers: { cookie } });
      if (diagnostics.response.ok && diagnostics.body.pid && diagnostics.body.pid !== expectedPid) {
        return diagnostics.body.pid;
      }
    } catch (_) {}
    await sleep(250);
  }
  throw new Error("watchdog nao restaurou um worker saudavel no prazo");
}

async function terminateProcess(pid) {
  try {
    process.kill(pid);
  } catch (err) {
    if (err.code !== "ESRCH") throw err;
  }
}

async function main() {
  supervisor = spawn(process.execPath, [path.join(root, "launcher.js")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DVS_DATA_DIR: dataDir,
      DVS_ENABLE_ADMIN_AUTH: "1",
      WATCHDOG_RESTART_MS: "1000",
      WATCHDOG_TIMEOUT_MS: "15000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const firstPid = await waitForHealth(0);
  await sleep(500);
  await terminateProcess(firstPid);
  const secondPid = await waitForHealth(firstPid);
  assert.notStrictEqual(secondPid, firstPid, "o watchdog deve iniciar outro worker");
  console.log(`Watchdog validado: worker ${firstPid} substituido por ${secondPid}.`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
}).finally(async () => {
  if (supervisor && supervisor.pid) await terminateProcess(supervisor.pid);
  await sleep(500);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
