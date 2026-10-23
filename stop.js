const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const dataDir = path.resolve(process.env.DVS_DATA_DIR || path.join(__dirname, "data"));
const pidFile = path.join(dataDir, "dvs-supervisor.pid");
let pid = 0;
try { pid = Number(fs.readFileSync(pidFile, "utf8").trim()); } catch (_) {}

if (!Number.isInteger(pid) || pid <= 0) {
  console.log("Supervisor do DVS Controller nao encontrado.");
  process.exit(0);
}

let stopped = true;
if (process.platform === "win32") {
  const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "inherit", windowsHide: true });
  if (result.status !== 0) {
    stopped = false;
    process.exitCode = result.status || 1;
  }
} else {
  try { process.kill(pid, "SIGTERM"); } catch (err) {
    if (err.code !== "ESRCH") throw err;
  }
}

if (stopped) {
  try { fs.rmSync(pidFile, { force: true }); } catch (_) {}
}
