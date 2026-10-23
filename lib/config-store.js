const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULTS = Object.freeze({
  serverPort: 3080,
  managerPort: 3091,
  databasePort: 5432,
  databaseHost: "127.0.0.1",
  databaseName: "dvs_controller",
  databaseUser: "dvs_service",
  databasePassword: "",
  controlToken: "",
  tizenStudioPath: "",
  tlsCertPath: "",
  tlsKeyPath: "",
  requireAdminTls: false
});

function dataDirectory() {
  return path.resolve(process.env.DVS_DATA_DIR || path.join(__dirname, "..", "data"));
}

function configPath() {
  return path.join(dataDirectory(), "service-config.json");
}

function validPort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

function normalize(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ...DEFAULTS,
    ...source,
    serverPort: validPort(source.serverPort, DEFAULTS.serverPort),
    managerPort: validPort(source.managerPort, DEFAULTS.managerPort),
    databasePort: validPort(source.databasePort, DEFAULTS.databasePort),
    databaseHost: String(source.databaseHost || DEFAULTS.databaseHost),
    databaseName: String(source.databaseName || DEFAULTS.databaseName),
    databaseUser: String(source.databaseUser || DEFAULTS.databaseUser),
    databasePassword: String(source.databasePassword || ""),
    controlToken: String(source.controlToken || ""),
    tizenStudioPath: String(source.tizenStudioPath || "").trim(),
    tlsCertPath: String(source.tlsCertPath || "").trim(),
    tlsKeyPath: String(source.tlsKeyPath || "").trim(),
    requireAdminTls: Boolean(source.requireAdminTls)
  };
}

function load() {
  fs.mkdirSync(dataDirectory(), { recursive: true });
  let parsed = {};
  if (fs.existsSync(configPath())) {
    parsed = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Configuracao invalida: restaure service-config.json de um backup");
  }
  const config = normalize(parsed);
  if (!config.controlToken) config.controlToken = crypto.randomBytes(32).toString("hex");
  if (!config.databasePassword) config.databasePassword = crypto.randomBytes(24).toString("base64url");
  if (JSON.stringify(parsed) !== JSON.stringify(config)) save(config);
  return config;
}

function save(value) {
  const config = normalize(value);
  fs.mkdirSync(dataDirectory(), { recursive: true });
  const target = configPath();
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return config;
}

function databaseUrl(config) {
  const value = config || load();
  return `postgresql://${encodeURIComponent(value.databaseUser)}:${encodeURIComponent(value.databasePassword)}@${value.databaseHost}:${value.databasePort}/${encodeURIComponent(value.databaseName)}`;
}

module.exports = { DEFAULTS, configPath, dataDirectory, databaseUrl, load, normalize, save, validPort };
