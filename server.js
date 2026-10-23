const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const os = require("os");
const { spawn } = require("child_process");
const { URL } = require("url");
const { monitorEventLoopDelay } = require("perf_hooks");
const webosManager = require("./lib/webos-manager");
const tizenManager = require("./lib/tizen-manager");
const androidManager = require("./lib/android-manager");
const mediaManager = require("./lib/media-manager");
const configStore = require("./lib/config-store");
const { PostgresStore } = require("./lib/postgres-store");

const { PanelHealth } = require("./lib/panel-health");
const panelHealth = new PanelHealth();

const PORT = Number(process.env.PORT || 3080);
const HOST = process.env.HOST || "0.0.0.0";
const RENDER_FPS = Math.max(1, Math.min(10, Number(process.env.RENDER_FPS || 1)));
const RENDER_IDLE_MS = Math.max(10000, Number(process.env.RENDER_IDLE_MS || 30000));
const RENDER_STALL_MS = Math.max(10000, Number(process.env.RENDER_STALL_MS || 20000));
const RENDER_TIMEOUT_MS = Math.max(15000, Number(process.env.RENDER_TIMEOUT_MS || 30000));
const PREVIEW_CACHE_MS = Math.max(1000, Number(process.env.PREVIEW_CACHE_MS || 15000));
const BASE_DIR = __dirname;
const PUBLIC_DIR = path.join(BASE_DIR, "public");
const DATA_DIR = path.resolve(process.env.DVS_DATA_DIR || path.join(BASE_DIR, "data"));
const DB_PATH = path.join(DATA_DIR, "db.json");
const SECRET_PATH = path.join(DATA_DIR, ".secret");
const MEDIA_DIR = path.join(DATA_DIR, "media");
const STREAM_DIR = path.join(DATA_DIR, "streams");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const WEBOS_DIR = process.env.DVS_MANAGED_SERVICE === "1" ? path.join(DATA_DIR, "webos") : BASE_DIR;
const TIZEN_DIR = process.env.DVS_MANAGED_SERVICE === "1" ? path.join(DATA_DIR, "tizen") : BASE_DIR;
const ANDROID_DIR = BASE_DIR;
const MAX_BODY_BYTES = Math.max(16384, Number(process.env.MAX_BODY_BYTES || 1024 * 1024));
const MAX_UPLOAD_BYTES = Math.max(1024 * 1024, Number(process.env.MAX_UPLOAD_BYTES || 2 * 1024 * 1024 * 1024));
const MAX_MJPEG_STREAMS = Math.max(1, Number(process.env.MAX_MJPEG_STREAMS || 64));
const MAX_MJPEG_PER_IP = Math.max(1, Number(process.env.MAX_MJPEG_PER_IP || 4));
const MJPEG_MAX_AGE_MS = Math.max(30000, Number(process.env.MJPEG_MAX_AGE_MS || 24 * 60 * 60 * 1000));
const SESSION_IDLE_MS = Math.max(5 * 60 * 1000, Number(process.env.SESSION_IDLE_MS || 30 * 60 * 1000));
const SESSION_ABSOLUTE_MS = Math.max(SESSION_IDLE_MS, Number(process.env.SESSION_ABSOLUTE_MS || 8 * 60 * 60 * 1000));
const MAX_SESSIONS = Math.max(10, Number(process.env.MAX_SESSIONS || 100));
const MAX_LOGIN_TRACKERS = Math.max(100, Number(process.env.MAX_LOGIN_TRACKERS || 10000));
const SESSION_BIND_IP = process.env.SESSION_BIND_IP !== "0";
const REQUIRE_TLS = process.env.DVS_REQUIRE_TLS === "1";
const REQUIRE_ADMIN_TLS = process.env.DVS_REQUIRE_ADMIN_TLS === "1";
const ALLOW_INSECURE_REMOTE_ADMIN = process.env.DVS_ALLOW_INSECURE_REMOTE_ADMIN === "1";
const ALLOW_LEGACY_TV_QUERY_AUTH = process.env.DVS_ALLOW_LEGACY_TV_QUERY_AUTH === "1";
const ADMIN_AUTH_ENABLED = process.env.DVS_ENABLE_ADMIN_AUTH === "1";
const MAX_TVS = Math.max(1, Number(process.env.MAX_TVS || 1000));
const MAX_PANELS = Math.max(1, Number(process.env.MAX_PANELS || 500));
const MAX_GROUPS = Math.max(1, Number(process.env.MAX_GROUPS || 100));
const MAX_USERS = Math.max(2, Number(process.env.MAX_USERS || 100));
const OPEN_ADMIN_USER = { id: "open-admin", username: "admin", displayName: "Administrador", role: "supervisor", enabled: true, mustChangePassword: false };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t"
};

const sseClients = new Map();
const sessions = new Map();
const loginAttempts = new Map();
const activeMjpegByIp = new Map();
const activePreviewByIp = new Map();
const serverSockets = new Set();
const captureState = new Map();
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
let dbCache = null;
let dbRevision = 0;
let dbWriteTimer = null;
let dbWriteChain = Promise.resolve();
let dbPendingSnapshot = null;
let dbPersistenceError = null;
let postgresStore = null;
let databaseBackend = "json";
const renderer = {
  browser: null,
  pages: new Map(),
  pageMeta: new Map(),
  pending: new Map(),
  activeStreams: new Map(),
  frameCache: new Map(),
  previewQueue: Promise.resolve()
};
let previousCpuSnapshot = null;
let systemMetrics = {
  cpuPercent: 0,
  memory: { total: os.totalmem(), free: os.freemem(), used: os.totalmem() - os.freemem(), percent: 0 },
  network: { bytesPerSecond: null, receivedBytesPerSecond: null, sentBytesPerSecond: null, available: false },
  sampledAt: now()
};

function now() {
  return new Date().toISOString();
}

function sortByName(list) {
  return (list || []).slice().sort((left, right) => String(left.name || "").localeCompare(String(right.name || ""), "pt-BR", { sensitivity: "base", numeric: true }));
}

function sampleCpuPercent() {
  const cpus = os.cpus();
  const snapshot = cpus.reduce((acc, cpu) => {
    acc.idle += cpu.times.idle;
    acc.total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return acc;
  }, { idle: 0, total: 0 });
  if (!previousCpuSnapshot) {
    previousCpuSnapshot = snapshot;
    return 0;
  }
  const idle = snapshot.idle - previousCpuSnapshot.idle;
  const total = snapshot.total - previousCpuSnapshot.total;
  previousCpuSnapshot = snapshot;
  return total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : 0;
}

function queryWindowsNetworkMetrics() {
  if (process.platform !== "win32") return Promise.resolve(null);
  const script = [
    "$items = Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface | Where-Object { $_.Name -notmatch 'Loopback|isatap|Teredo' };",
    "$rx = ($items | Measure-Object BytesReceivedPersec -Sum).Sum;",
    "$tx = ($items | Measure-Object BytesSentPersec -Sum).Sum;",
    "[Console]::Out.Write((@{rx=[double]$rx;tx=[double]$tx} | ConvertTo-Json -Compress))"
  ].join(" ");
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true, shell: false });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 3500);
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      try {
        const parsed = JSON.parse(output || "{}");
        resolve({
          receivedBytesPerSecond: Math.max(0, Number(parsed.rx || 0)),
          sentBytesPerSecond: Math.max(0, Number(parsed.tx || 0))
        });
      } catch (_) {
        resolve(null);
      }
    });
  });
}

async function refreshSystemMetrics() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = Math.max(0, total - free);
  const network = await queryWindowsNetworkMetrics().catch(() => null);
  systemMetrics = {
    cpuPercent: Math.round(sampleCpuPercent() * 10) / 10,
    memory: {
      total,
      free,
      used,
      percent: total ? Math.round(used / total * 1000) / 10 : 0
    },
    network: network ? {
      bytesPerSecond: network.receivedBytesPerSecond + network.sentBytesPerSecond,
      receivedBytesPerSecond: network.receivedBytesPerSecond,
      sentBytesPerSecond: network.sentBytesPerSecond,
      available: true
    } : { bytesPerSecond: null, receivedBytesPerSecond: null, sentBytesPerSecond: null, available: false },
    sampledAt: now()
  };
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function authToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function clientIp(req) {
  const forwarded = process.env.TRUST_PROXY === "1" ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
  return String(forwarded || req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
}

function applySecurityHeaders(req, res) {
  res.dvsRequestId = /^[A-Za-z0-9_-]{8,80}$/.test(String(req.headers["x-request-id"] || ""))
    ? String(req.headers["x-request-id"])
    : crypto.randomBytes(8).toString("hex");
  res.setHeader("x-request-id", res.dvsRequestId);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("cross-origin-resource-policy", "same-origin");
  res.setHeader("x-dns-prefetch-control", "off");
  res.setHeader("x-download-options", "noopen");
  res.setHeader("origin-agent-cluster", "?1");
  if (isSecureRequest(req)) res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
}

function isSecureRequest(req) {
  return Boolean(req.socket.encrypted) || (process.env.TRUST_PROXY === "1" && String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https");
}

function isLoopbackRequest(req) {
  const address = clientIp(req).toLowerCase();
  return address === "127.0.0.1" || address === "::1" || address === "localhost";
}

function validRequestOrigin(req) {
  if (String(req.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") return false;
  const origin = String(req.headers.origin || "");
  if (!origin) return true;
  if (origin === "null") return false;
  try {
    return new URL(origin).host === String(req.headers.host || "");
  } catch (_) {
    return false;
  }
}

function passwordPolicyError(password, username) {
  password = String(password || "");
  username = String(username || "").toLowerCase();
  if (password.length < 12) return "A senha precisa ter pelo menos 12 caracteres";
  if (password.length > 128) return "A senha pode ter no maximo 128 caracteres";
  const normalized = password.toLowerCase().replace(/[^a-z0-9]/g, "");
  const blocked = ["admin", "administrator", "password", "senha", "qwerty", "1234567890", "123456789012", "letmein", "dvscontroller"];
  if (/^\d+$/.test(password) || blocked.some((value) => normalized === value || normalized.startsWith(value) && normalized.length <= value.length + 2)) {
    return "A senha e previsivel. Use uma frase longa e exclusiva";
  }
  if (username.length >= 3 && normalized.includes(username.replace(/[^a-z0-9]/g, ""))) return "A senha nao pode conter o nome do usuario";
  return "";
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function verifyTvToken(tv, token) {
  if (!tv || !token) return false;
  return tv.tokenHash ? safeEqual(tv.tokenHash, tokenHash(token)) : safeEqual(tv.token, token);
}

function redactUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl, "http://localhost");
    for (const key of ["token", "callback"]) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, "[redacted]");
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch (_) {
    return String(rawUrl || "").split("?")[0];
  }
}

function ensureData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, "captures"), { recursive: true });
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  fs.mkdirSync(STREAM_DIR, { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (WEBOS_DIR !== BASE_DIR) prepareWebosWorkspace();
  if (TIZEN_DIR !== BASE_DIR) prepareTizenWorkspace();
  if (!fs.existsSync(DB_PATH)) {
    const db = defaultDb();
    db.updatedAt = now();
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    dbCache = cloneDb(db);
  }
}

function prepareTizenWorkspace() {
  fs.mkdirSync(TIZEN_DIR, { recursive: true });
  const source = path.join(BASE_DIR, "tizen-client");
  const target = path.join(TIZEN_DIR, "tizen-client");
  if (fs.existsSync(source)) copyDirectory(source, target);
  for (const name of fs.readdirSync(BASE_DIR).filter((item) => item.toLowerCase().endsWith(".wgt"))) {
    fs.copyFileSync(path.join(BASE_DIR, name), path.join(TIZEN_DIR, name));
  }
}

function prepareWebosWorkspace() {
  fs.mkdirSync(WEBOS_DIR, { recursive: true });
  const clientSource = path.join(BASE_DIR, "webos-client");
  const clientTarget = path.join(WEBOS_DIR, "webos-client");
  if (fs.existsSync(clientSource)) copyDirectory(clientSource, clientTarget);
  for (const name of fs.readdirSync(BASE_DIR).filter((item) => item.endsWith(".ipk"))) {
    fs.copyFileSync(path.join(BASE_DIR, name), path.join(WEBOS_DIR, name));
  }
}

function copyDirectory(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) copyDirectory(sourcePath, targetPath);
    else if (entry.isFile()) fs.copyFileSync(sourcePath, targetPath);
  }
}

function defaultDb() {
  const initialAuth = makeAuth(process.env.DVS_INITIAL_PASSWORD || "admin", "admin");
  return {
    tvs: [],
    groups: [{ id: "default", name: "Principal" }],
    panels: [],
    webosDevices: [],
    tizenDevices: [],
    androidDevices: [],
    media: [],
    playlists: [],
    panelPlaylists: [],
    events: [],
    auth: initialAuth,
    users: [{ id: "user_admin", username: "admin", displayName: "Administrador", role: "supervisor", ...initialAuth }],
    createdAt: now(),
    updatedAt: now()
  };
}

function cloneDb(db) {
  return structuredClone(db);
}

function dbSnapshot() {
  const snapshot = cloneDb(dbCache);
  Object.defineProperty(snapshot, "_dvsRevision", { value: dbRevision, enumerable: false });
  Object.defineProperty(snapshot, "_dvsBase", { value: cloneDb(dbCache), enumerable: false });
  return snapshot;
}

function mergeCollection(baseItems, incomingItems, currentItems) {
  const base = new Map((baseItems || []).map((item) => [item.id, item]));
  const incoming = new Map((incomingItems || []).map((item) => [item.id, item]));
  const current = new Map((currentItems || []).map((item) => [item.id, item]));
  for (const item of baseItems || []) {
    if (!incoming.has(item.id)) current.delete(item.id);
  }
  for (const item of incomingItems || []) {
    const original = base.get(item.id);
    if (!original || JSON.stringify(original) !== JSON.stringify(item)) current.set(item.id, cloneDb(item));
  }
  const ordered = [];
  for (const item of incomingItems || []) {
    if (current.has(item.id)) {
      ordered.push(current.get(item.id));
      current.delete(item.id);
    }
  }
  return ordered.concat(Array.from(current.values()));
}

function mergeDbChanges(base, incoming, current) {
  const merged = cloneDb(current);
  for (const key of ["tvs", "groups", "panels", "webosDevices", "tizenDevices", "androidDevices", "media", "playlists", "panelPlaylists", "events", "users"]) {
    merged[key] = mergeCollection(base[key], incoming[key], current[key]);
  }
  if (JSON.stringify(base.auth) !== JSON.stringify(incoming.auth)) merged.auth = cloneDb(incoming.auth);
  return merged;
}

function normalizeDb(db) {
  db = db && typeof db === "object" ? db : {};
  db.tvs = Array.isArray(db.tvs) ? db.tvs : [];
  db.groups = Array.isArray(db.groups) && db.groups.length ? db.groups : [{ id: "default", name: "Principal" }];
  db.panels = Array.isArray(db.panels) ? db.panels : [];
  db.webosDevices = Array.isArray(db.webosDevices) ? db.webosDevices : [];
  db.tizenDevices = Array.isArray(db.tizenDevices) ? db.tizenDevices : [];
  db.androidDevices = Array.isArray(db.androidDevices) ? db.androidDevices : [];
  db.media = Array.isArray(db.media) ? db.media : [];
  db.playlists = Array.isArray(db.playlists) ? db.playlists : [];
  db.panelPlaylists = Array.isArray(db.panelPlaylists) ? db.panelPlaylists : [];
  for (const playlist of db.playlists) {
    if (!Array.isArray(playlist.items) || !playlist.items.length) continue;
    try { ensurePlaylistPlaybackPanel(db, playlist, "playlist"); } catch (_) {}
  }
  for (const playlist of db.panelPlaylists) {
    if (!Array.isArray(playlist.items) || !playlist.items.length) continue;
    try { ensurePlaylistPlaybackPanel(db, playlist, "panel_playlist"); } catch (_) {}
  }
  db.events = Array.isArray(db.events) ? db.events : [];
  db.tvs.forEach((tv) => {
    if (!tv.tokenHash && tv.token) tv.tokenHash = tokenHash(tv.token);
    delete tv.token;
  });
  db.auth = db.auth && db.auth.passwordHash && db.auth.salt ? db.auth : makeAuth("admin");
  if (!Array.isArray(db.users) || !db.users.length) {
    db.users = [{ id: "user_admin", username: "admin", displayName: "Administrador", role: "supervisor", ...db.auth }];
  }
  db.users = db.users.filter((user) => user && user.passwordHash && user.salt).map((user) => ({
    ...user,
    id: String(user.id || id("user")),
    username: String(user.username || user.user || "").trim().toLowerCase(),
    displayName: String(user.displayName || user.username || user.user || "Usuario").trim(),
    role: ["supervisor", "technician", "operator"].includes(user.role) ? user.role : "operator",
    enabled: user.enabled !== false
  })).filter((user) => /^[a-z0-9._-]{3,40}$/.test(user.username));
  if (!db.users.some((user) => user.role === "supervisor")) {
    db.users.push({ id: "user_admin", username: "admin", displayName: "Administrador", role: "supervisor", enabled: true, ...db.auth });
  }
  const legacyAdmin = db.users.find((user) => user.username === "admin") || db.users.find((user) => user.role === "supervisor");
  if (legacyAdmin) db.auth = { user: legacyAdmin.username, salt: legacyAdmin.salt, algorithm: legacyAdmin.algorithm, passwordHash: legacyAdmin.passwordHash, mustChangePassword: legacyAdmin.mustChangePassword, updatedAt: legacyAdmin.updatedAt };
  return db;
}

function loadDb() {
  ensureData();
  if (dbCache) return dbSnapshot();
  const raw = fs.readFileSync(DB_PATH, "utf8").trim();
  if (!raw) {
    const db = defaultDb();
    saveDb(db);
    return dbSnapshot();
  }
  try {
    dbCache = cloneDb(normalizeDb(JSON.parse(raw)));
    return dbSnapshot();
  } catch (err) {
    const backupPath = path.join(DATA_DIR, `db-corrupt-${Date.now()}.json`);
    fs.copyFileSync(DB_PATH, backupPath);
    let db = null;
    let restoredBackup = "";
    const backups = fs.readdirSync(BACKUP_DIR).filter((name) => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().reverse();
    for (const name of backups) {
      try {
        db = normalizeDb(JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, name), "utf8")));
        restoredBackup = name;
        break;
      } catch (_) {}
    }
    db = db || defaultDb();
    logEvent(db, "db_recovered", restoredBackup ? "Banco recuperado pelo ultimo backup valido" : "Banco reiniciado apos JSON invalido", { backupPath, restoredBackup, error: err.message });
    saveDb(db);
    return dbSnapshot();
  }
}

async function initializeDatabase() {
  ensureData();
  const localState = loadDb();
  const connectionString = String(process.env.DATABASE_URL || "").trim();
  const postgresRequired = process.env.DVS_DB_MODE === "postgres";
  if (!connectionString) {
    if (postgresRequired) throw new Error("DATABASE_URL nao foi configurada para o modo PostgreSQL");
    cleanupOrphanedCaptures(localState);
    return;
  }
  try {
    postgresStore = new PostgresStore({ connectionString });
    await postgresStore.connect();
    const persisted = await postgresStore.load();
    if (persisted && persisted.payload) {
      dbCache = cloneDb(normalizeDb(persisted.payload));
      dbRevision = Number(persisted.revision || 0);
    } else {
      await postgresStore.save(localState, dbRevision);
    }
    databaseBackend = "postgresql";
    cleanupOrphanedCaptures(dbCache);
    console.log("[database] PostgreSQL conectado e esquema validado.");
  } catch (error) {
    if (postgresStore) await postgresStore.close().catch(() => {});
    postgresStore = null;
    if (postgresRequired) throw error;
    databaseBackend = "json-fallback";
    dbPersistenceError = null;
    cleanupOrphanedCaptures(localState);
    console.error(`[database] PostgreSQL indisponivel; usando contingencia JSON: ${error.message}`);
  }
}

function cleanupOrphanedCaptures(db) {
  const capturesDir = path.join(DATA_DIR, "captures");
  const activeFiles = new Set(db.panels.filter((panel) => panel.mode === "server_image").map((panel) => `${panel.id}.jpg`));
  for (const entry of fs.readdirSync(capturesDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".tmp") || (entry.name.endsWith(".jpg") && !activeFiles.has(entry.name))) {
      fs.rmSync(path.join(capturesDir, entry.name), { force: true });
    }
  }
}

function encryptionKey() {
  ensureData();
  if (!fs.existsSync(SECRET_PATH)) {
    const backupSecret = path.join(BACKUP_DIR, "encryption.secret");
    if (fs.existsSync(backupSecret)) fs.copyFileSync(backupSecret, SECRET_PATH);
    else fs.writeFileSync(SECRET_PATH, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  const raw = fs.readFileSync(SECRET_PATH, "utf8").trim();
  if (!/^[a-fA-F0-9]{64}$/.test(raw)) throw new Error("Chave de criptografia invalida; restaure data/backups/encryption.secret");
  return Buffer.from(raw, "hex");
}

function encryptSecret(payload) {
  if (!payload) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}

function decryptSecret(value) {
  if (!value) return null;
  try {
    const parts = value.split(".");
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(parts[0], "base64"));
    decipher.setAuthTag(Buffer.from(parts[1], "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[2], "base64")), decipher.final()]).toString("utf8"));
  } catch (_) {
    return null;
  }
}

function makeAuth(password, username) {
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    user: String(username || "admin").toLowerCase(),
    salt,
    algorithm: "scrypt-v2",
    passwordHash: crypto.scryptSync(String(password), salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("hex"),
    mustChangePassword: String(password) === "admin",
    updatedAt: now()
  };
}

function legacyPasswordHash(password, salt) {
  return crypto.createHash("sha256").update(`${salt}:${password}`).digest("hex");
}

function verifyPassword(auth, password) {
  if (!auth || !auth.salt || !auth.passwordHash) return false;
  let actual;
  if (auth.algorithm === "scrypt-v2") {
    actual = crypto.scryptSync(String(password), auth.salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("hex");
  } else if (auth.algorithm === "scrypt-v1") {
    actual = crypto.scryptSync(String(password), auth.salt, 64).toString("hex");
  } else {
    actual = legacyPasswordHash(String(password), auth.salt);
  }
  const expectedBuffer = Buffer.from(String(auth.passwordHash), "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function parseCookies(req) {
  const cookies = {};
  String(req.headers.cookie || "").split(";").forEach((part) => {
    const index = part.indexOf("=");
    if (index < 1) return;
    const name = part.slice(0, index).trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) return;
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch (_) {
      // Ignore malformed cookie values instead of turning unauthenticated input into a server error.
    }
  });
  return cookies;
}

function makeRoomForLoginTracker() {
  if (loginAttempts.size < MAX_LOGIN_TRACKERS) return;
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, attempt] of loginAttempts.entries()) {
    if (attempt.blockedUntil < Date.now() && !attempt.failures.some((at) => at > cutoff)) loginAttempts.delete(key);
    if (loginAttempts.size < MAX_LOGIN_TRACKERS) return;
  }
  const oldestKey = loginAttempts.keys().next().value;
  if (oldestKey) loginAttempts.delete(oldestKey);
}

function currentSession(req) {
  const cookies = parseCookies(req);
  const token = isSecureRequest(req) ? (cookies["__Host-dvs_session"] || cookies.dvs_session) : cookies.dvs_session;
  const session = token ? sessions.get(token) : null;
  if (!session) return null;
  const expired = Date.now() - session.at > SESSION_IDLE_MS || Date.now() - session.createdAt > SESSION_ABSOLUTE_MS;
  const clientHash = crypto.createHash("sha256").update(`${SESSION_BIND_IP ? clientIp(req) : "*"}|${String(req.headers["user-agent"] || "")}`).digest("hex");
  if (expired || !safeEqual(session.clientHash, clientHash)) {
    sessions.delete(token);
    return null;
  }
  session.at = Date.now();
  return session;
}

function isAuthed(req) { return Boolean(currentSession(req)); }

function adminUserForRequest(req, db) {
  if (!ADMIN_AUTH_ENABLED) return OPEN_ADMIN_USER;
  const session = currentSession(req);
  if (!session) return null;
  return db.users.find((item) => item.id === session.userId && item.enabled !== false) || null;
}

function setSession(req, res, user) {
  const cookies = parseCookies(req);
  for (const oldToken of [cookies["__Host-dvs_session"], cookies.dvs_session]) {
    if (oldToken) sessions.delete(oldToken);
  }
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = Array.from(sessions.entries()).sort((left, right) => left[1].at - right[1].at)[0];
    if (oldest) sessions.delete(oldest[0]);
  }
  const token = authToken();
  const secure = isSecureRequest(req);
  const createdAt = Date.now();
  const clientHash = crypto.createHash("sha256").update(`${SESSION_BIND_IP ? clientIp(req) : "*"}|${String(req.headers["user-agent"] || "")}`).digest("hex");
  const session = { at: createdAt, createdAt, clientHash, csrfToken: authToken(), userId: user.id, username: user.username, displayName: user.displayName, role: user.role };
  sessions.set(token, session);
  const name = secure ? "__Host-dvs_session" : "dvs_session";
  const cookie = `${name}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/${secure ? "; Secure" : ""}`;
  res.setHeader("set-cookie", cookie);
  return session;
}

function clearSession(req, res) {
  const cookies = parseCookies(req);
  for (const token of [cookies["__Host-dvs_session"], cookies.dvs_session]) {
    if (token) sessions.delete(token);
  }
  res.setHeader("set-cookie", [
    "dvs_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    "__Host-dvs_session=; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=0"
  ]);
}

function validCsrf(req, session) {
  return Boolean(session && session.csrfToken && safeEqual(req.headers["x-dvs-csrf"], session.csrfToken));
}

function invalidateUserSessions(userId) {
  for (const [token, session] of sessions.entries()) {
    if (session.userId === userId) sessions.delete(token);
  }
}

function isTvApi(url) {
  return url.pathname === "/api/ping" || url.pathname === "/api/health" ||
    url.pathname.startsWith("/api/tv/");
}

function isDashboardReadOnlyApi(req, url) {
  return req.method === "GET" && (url.pathname === "/api/state" || url.pathname === "/api/events");
}

function publicServerOrigin(req) {
  const configured = String(process.env.DVS_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  if (/^https?:\/\/[^/?#]+$/i.test(configured)) return configured;
  const protocol = isSecureRequest(req) ? "https" : "http";
  const hostHeader = String(req.headers.host || "").trim();
  if (hostHeader && !/^localhost(?::|$)|^127\.0\.0\.1(?::|$)|^\[::1\](?::|$)/i.test(hostHeader)) return `${protocol}://${hostHeader}`;
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const item of entries || []) {
      if (item && item.family === "IPv4" && !item.internal) return `${protocol}://${item.address}:${PORT}`;
    }
  }
  return `${protocol}://localhost:${PORT}`;
}

function saveDb(db) {
  db.updatedAt = now();
  const base = db && db._dvsBase;
  const revision = db && db._dvsRevision;
  const next = base && revision !== dbRevision ? mergeDbChanges(base, db, dbCache) : db;
  next.updatedAt = db.updatedAt;
  dbCache = cloneDb(normalizeDb(next));
  dbRevision += 1;
  dbPendingSnapshot = { revision: dbRevision, json: JSON.stringify(dbCache, null, 2) };
  if (!dbWriteTimer) dbWriteTimer = setTimeout(queueDbWrite, 50);
}

function queueDbWrite() {
  if (dbWriteTimer) clearTimeout(dbWriteTimer);
  dbWriteTimer = null;
  const snapshot = dbPendingSnapshot;
  dbPendingSnapshot = null;
  if (!snapshot) return dbWriteChain;
  dbWriteChain = dbWriteChain.then(async () => {
    const tmpPath = `${DB_PATH}.${process.pid}.${snapshot.revision}.tmp`;
    await fs.promises.writeFile(tmpPath, snapshot.json);
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await fs.promises.rename(tmpPath, DB_PATH);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
    if (lastError) {
      await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
      throw lastError;
    }
    if (postgresStore) await postgresStore.save(JSON.parse(snapshot.json), snapshot.revision);
    dbPersistenceError = null;
  }).catch((err) => {
    dbPersistenceError = err;
    console.error(`[database] Falha ao persistir revisao ${snapshot.revision}: ${err.stack || err.message}`);
  });
  return dbWriteChain;
}

async function flushDb() {
  queueDbWrite();
  await dbWriteChain;
  if (dbPendingSnapshot) {
    queueDbWrite();
    await dbWriteChain;
  }
  if (dbPersistenceError) throw dbPersistenceError;
}

async function backupDatabase() {
  try {
    await flushDb();
    const date = new Date().toISOString().slice(0, 10);
    await fs.promises.copyFile(DB_PATH, path.join(BACKUP_DIR, `db-${date}.json`));
    if (fs.existsSync(SECRET_PATH)) await fs.promises.copyFile(SECRET_PATH, path.join(BACKUP_DIR, "encryption.secret"));
    const backups = (await fs.promises.readdir(BACKUP_DIR)).filter((name) => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().reverse();
    await Promise.all(backups.slice(7).map((name) => fs.promises.rm(path.join(BACKUP_DIR, name), { force: true })));
  } catch (err) {
    console.error(`[backup] Falha ao criar backup: ${err.message}`);
  }
}

function publicState(db) {
  return {
    tvs: sortByName(db.tvs).map((tv) => ({
      id: tv.id,
      name: tv.name,
      groupId: tv.groupId,
      model: tv.model,
      platform: tv.platform,
      appVersion: tv.appVersion,
      currentPanelId: tv.currentPanelId,
      playbackMode: tv.playbackMode || "direct",
      zoom: Number(tv.zoom || 1),
      status: getTvStatus(tv),
      lastSeen: tv.lastSeen,
      lastError: tv.lastError || "",
      ip: tv.ip || ""
    })),
    groups: sortByName(db.groups),
    panels: sortByName(db.panels).map(publicPanel),
    webosDevices: sortByName(db.webosDevices).map((device) => ({
      id: device.id,
      name: device.name,
      host: device.host,
      port: device.port,
      username: device.username,
      linkedTvId: device.linkedTvId || "",
      autoRenew: Boolean(device.autoRenew),
      autoLaunch: Boolean(device.autoLaunch),
      powerState: device.powerState || "unknown",
      lastAutoLaunchAt: device.lastAutoLaunchAt || "",
      lastAction: device.lastAction || "",
      lastResult: device.lastResult || "",
      lastError: device.lastError || "",
      lastRenewedAt: device.lastRenewedAt || "",
      lastSystemUpdateCheckAt: device.lastSystemUpdateCheckAt || "",
      systemUpdateStatus: device.systemUpdateStatus || "",
      scheduledSystemUpdateAt: device.scheduledSystemUpdateAt || "",
      updatedAt: device.updatedAt
    })),
    tizenDevices: sortByName(db.tizenDevices).map((device) => ({
      id: device.id,
      name: device.name,
      host: device.host,
      port: device.port,
      serial: device.serial || "",
      profile: device.profile || "",
      linkedTvId: device.linkedTvId || "",
      autoLaunch: Boolean(device.autoLaunch),
      lastAction: device.lastAction || "",
      lastResult: device.lastResult || "",
      lastError: device.lastError || "",
      updatedAt: device.updatedAt
    })),
    androidDevices: sortByName(db.androidDevices).map((device) => ({
      id: device.id,
      name: device.name,
      host: device.host,
      port: device.port,
      serial: device.serial || "",
      linkedTvId: device.linkedTvId || "",
      autoLaunch: Boolean(device.autoLaunch),
      lastAction: device.lastAction || "",
      lastResult: device.lastResult || "",
      lastError: device.lastError || "",
      updatedAt: device.updatedAt
    })),
    media: sortByName(db.media).map((item) => ({
      id: item.id,
      name: item.name,
      fileName: item.fileName,
      mime: item.mime,
      size: item.size,
      createdAt: item.createdAt,
      url: `/media/${item.id}`
    })),
    playlists: sortByName(db.playlists).map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      items: playlist.items,
      loop: playlist.loop !== false,
      panelId: linkedPlaybackPanel(db, playlist, "playlist")?.id || "",
      updatedAt: playlist.updatedAt
    })),
    panelPlaylists: sortByName(db.panelPlaylists).map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      items: Array.isArray(playlist.items) ? playlist.items.map((item) => ({
        panelId: item.panelId,
        durationSeconds: Math.max(5, Math.min(86400, Number(item.durationSeconds || 30)))
      })) : [],
      loop: playlist.loop !== false,
      panelId: linkedPlaybackPanel(db, playlist, "panel_playlist")?.id || "",
      updatedAt: playlist.updatedAt
    })),
    serverMetrics: systemMetrics,
    serverTime: now()
  };
}

function linkedPlaybackPanel(db, playlist, mode) {
  if (!playlist) return null;
  const referenceKey = mode === "playlist" ? "playlistId" : "panelPlaylistId";
  return db.panels.find((panel) => panel.id === playlist.panelId && panel.mode === mode)
    || db.panels.find((panel) => panel.mode === mode && panel[referenceKey] === playlist.id)
    || null;
}

function ensurePlaylistPlaybackPanel(db, playlist, mode) {
  const referenceKey = mode === "playlist" ? "playlistId" : "panelPlaylistId";
  let panel = linkedPlaybackPanel(db, playlist, mode);
  if (!panel) {
    if (db.panels.length >= MAX_PANELS) throw new Error("Limite de paineis atingido");
    panel = {
      id: id("panel"),
      name: playlist.name,
      url: "",
      mode,
      playlistId: "",
      panelPlaylistId: "",
      mediaId: "",
      loop: true,
      sourceSecret: "",
      refreshSeconds: 1,
      width: 1920,
      height: 1080,
      renderDelayMs: 100,
      zoom: 1,
      authSecret: "",
      managedBy: "playlist",
      managedResourceId: playlist.id,
      updatedAt: now()
    };
    db.panels.push(panel);
  }
  panel[referenceKey] = playlist.id;
  if (panel.managedBy === "playlist") {
    panel.name = playlist.name;
    panel.managedResourceId = playlist.id;
    panel.updatedAt = now();
  }
  playlist.panelId = panel.id;
  return panel;
}

function assignPanelToTv(db, tvId, panel) {
  if (!tvId) return null;
  const tv = db.tvs.find((item) => item.id === tvId);
  if (!tv) throw new Error("TV selecionada nao foi encontrada");
  tv.currentPanelId = panel.id;
  tv.playbackMode = panel.mode || "direct";
  const command = { type: "setPanel", panelId: panel.id, playbackMode: tv.playbackMode, tvZoom: Number(tv.zoom || 1), id: id("cmd"), at: now() };
  tv.currentCommandId = command.id;
  tv.pendingCommand = command;
  return { tv, command };
}

function publicPanel(panel) {
  const auth = decryptSecret(panel.authSecret);
  const copy = { ...panel };
  delete copy.authSecret;
  delete copy.sourceSecret;
  if (panel.mode === "rtsp") {
    copy.url = "";
    copy.hasSource = Boolean(panel.sourceSecret);
  }
  copy.auth = {
    enabled: Boolean(auth && auth.enabled),
    username: auth && auth.username ? String(auth.username).replace(/^(.).*(.)$/, "$1***$2") : "",
    usernameSelector: auth && auth.usernameSelector || "",
    passwordSelector: auth && auth.passwordSelector || "",
    submitSelector: auth && auth.submitSelector || ""
  };
  copy.renderStatus = captureState.get(panel.id) || null;
  if (panel.mode === "rtsp") copy.streamStatus = mediaManager.status(panel.id);
  return copy;
}

function getTvStatus(tv) {
  if (!tv.lastSeen) return "offline";
  const age = Date.now() - new Date(tv.lastSeen).getTime();
  if (age < 20000) return "online";
  if (age < 90000) return "stale";
  return "offline";
}

function logEvent(db, type, message, meta) {
  db.events.unshift({ id: id("evt"), type, message, meta: meta || {}, at: now() });
  db.events = db.events.slice(0, 200);
}

function defaultErrorCode(status) {
  if (status === 400) return "DVS_VALIDATION_ERROR";
  if (status === 401) return "DVS_AUTH_REQUIRED";
  if (status === 403) return "DVS_FORBIDDEN";
  if (status === 404) return "DVS_NOT_FOUND";
  if (status === 409) return "DVS_CONFLICT";
  if (status === 413) return "DVS_PAYLOAD_TOO_LARGE";
  if (status === 429) return "DVS_RATE_LIMITED";
  if (status === 502) return "DVS_UPSTREAM_ERROR";
  if (status === 503) return "DVS_UNAVAILABLE";
  return status >= 500 ? "DVS_INTERNAL_ERROR" : "DVS_REQUEST_ERROR";
}

function sendJson(res, status, payload) {
  if (res.headersSent || res.destroyed) return;
  if (payload && typeof payload.error === "string") {
    payload = { ...payload, code: payload.code || defaultErrorCode(status), requestId: res.dvsRequestId || "" };
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendApi(res, url, status, payload) {
  sendJson(res, status, payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        fail(Object.assign(new Error("Payload muito grande"), { statusCode: 413, code: "DVS_PAYLOAD_TOO_LARGE" }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(Object.assign(new Error("JSON invalido"), { statusCode: 400, code: "DVS_INVALID_JSON" }));
      }
    });
    req.on("error", fail);
  });
}

function readUpload(req, targetPath, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let failed = false;
    const output = fs.createWriteStream(targetPath, { flags: "wx" });
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes && !failed) {
        failed = true;
        req.unpipe(output);
        output.destroy();
        req.resume();
        reject(Object.assign(new Error(`Video maior que o limite de ${Math.round(maxBytes / 1024 / 1024)} MB`), { statusCode: 413, code: "DVS_MEDIA_TOO_LARGE" }));
      }
    });
    req.on("aborted", () => { if (!failed) reject(Object.assign(new Error("Upload interrompido"), { code: "DVS_UPLOAD_ABORTED" })); });
    req.on("error", (err) => { if (!failed) reject(err); });
    output.on("error", (err) => { if (!failed) reject(err); });
    output.on("finish", () => {
      if (!failed) resolve(size);
    });
    req.pipe(output);
  });
}

async function validateMediaFile(filePath, extension) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (!bytesRead) return false;
    if (extension === ".mp4") return buffer.subarray(4, 8).toString("ascii") === "ftyp";
    if (extension === ".webm") return buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (extension === ".ogv") return buffer.subarray(0, 4).toString("ascii") === "OggS";
    return false;
  } finally {
    await handle.close();
  }
}

function serveRangeFile(req, res, filePath, mime) {
  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, {
      "content-type": mime,
      "content-length": stat.size,
      "accept-ranges": "bytes",
      "cache-control": "public, max-age=3600"
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return sendJson(res, 416, { error: "Faixa de video invalida" });
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
  if (start > end || start >= stat.size) {
    res.writeHead(416, { "content-range": `bytes */${stat.size}` });
    res.end();
    return;
  }
  res.writeHead(206, {
    "content-type": mime,
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${stat.size}`,
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=3600"
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

function safeStaticPath(root, pathname) {
  const decoded = decodeURIComponent(pathname);
  const clean = decoded.replace(/^\/+/, "");
  const resolved = path.resolve(root, clean);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}

function serveFile(res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      sendJson(res, 404, { error: "Arquivo nao encontrado" });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const dynamicAsset = ext === ".html" || ext === ".js" || ext === ".css";
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "content-length": stat.size,
      "cache-control": dynamicAsset ? "no-store, no-cache, must-revalidate" : "public, max-age=60"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function authTv(db, tvId, token) {
  const tv = db.tvs.find((item) => item.id === tvId);
  if (!verifyTvToken(tv, token)) return null;
  return tv;
}

function tvRequestToken(req, url, tvId) {
  const headerToken = String(req.headers["x-dvs-tv-token"] || "");
  if (headerToken) return headerToken;
  const queryToken = ALLOW_LEGACY_TV_QUERY_AUTH && url && url.searchParams.get("token") || "";
  if (queryToken) return queryToken;
  const credential = String(parseCookies(req).dvs_tv_auth || "");
  const separator = credential.indexOf(".");
  if (separator < 1 || credential.slice(0, separator) !== String(tvId || "")) return "";
  return credential.slice(separator + 1);
}

function setTvCookie(req, res, tvId, token) {
  const secure = isSecureRequest(req);
  res.setHeader("set-cookie", `dvs_tv_auth=${encodeURIComponent(`${tvId}.${token}`)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure ? "; Secure" : ""}`);
}

function authorizePlayback(req, url) {
  if (isAuthed(req)) return true;
  const cookieCredential = String(parseCookies(req).dvs_tv_auth || "");
  const separator = cookieCredential.indexOf(".");
  const tvId = url.searchParams.get("tvId") || (separator > 0 ? cookieCredential.slice(0, separator) : "");
  const token = tvRequestToken(req, url, tvId);
  return Boolean(tvId && token && authTv(loadDb(), tvId, token));
}

function pushCommand(tvId, command) {
  const client = sseClients.get(tvId);
  return writeSse(client, `event: command\ndata: ${JSON.stringify(command)}\n\n`);
}

function writeSse(client, payload) {
  if (!client || client.destroyed || client.writableEnded || client.dvsBackpressured) return false;
  const accepted = client.write(payload);
  if (!accepted) {
    client.dvsBackpressured = true;
    client.once("drain", () => { client.dvsBackpressured = false; });
  }
  return true;
}

function desiredPanelCommand(tv) {
  if (!tv.currentPanelId) return null;
  return {
    id: tv.currentCommandId || `current:${tv.currentPanelId}:${tv.playbackMode || "direct"}`,
    type: "setPanel",
    panelId: tv.currentPanelId,
    playbackMode: tv.playbackMode || "direct",
    tvZoom: Number(tv.zoom || 1),
    at: now()
  };
}

function commandsForTv(tv) {
  const commands = [];
  const desired = desiredPanelCommand(tv);
  if (desired) commands.push(desired);
  if (tv.pendingCommand && !commands.some((command) => command.id === tv.pendingCommand.id)) {
    commands.push(tv.pendingCommand);
  }
  return commands;
}

function acknowledgePendingCommand(tv, reportedPanelId, reportedZoom) {
  const command = tv.pendingCommand;
  if (!command) return;
  if (command.type === "setPanel" && reportedPanelId === command.panelId) tv.pendingCommand = null;
  else if (command.type === "setZoom" && Math.abs(Number(reportedZoom || 1) - Number(command.zoom || 1)) < 0.001) tv.pendingCommand = null;
  else if (command.type !== "setPanel" && command.type !== "setZoom") tv.pendingCommand = null;
}

function broadcastAdmin() {
  for (const [tvId, client] of sseClients.entries()) {
    if (tvId.startsWith("admin:")) {
      writeSse(client, `event: state\ndata: ${JSON.stringify(publicState(loadDb()))}\n\n`);
    }
  }
}

function validateUrl(value) {
  try {
    if (!value || String(value).length > 4096) return false;
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
  } catch (_) {
    return false;
  }
}

function urlValue(rawUrl, name) {
  try {
    return new URL(rawUrl, "http://localhost").searchParams.get(name) || "";
  } catch (_) {
    return "";
  }
}

function normalizeIp(value) {
  return String(value || "").replace(/^::ffff:/, "");
}

function videowallBase(panelUrl) {
  const parsed = new URL(panelUrl);
  parsed.pathname = parsed.pathname.replace(/\/wall\/?$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function legacyWallHtml(panelId, authQuery) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DVS Legacy VideoWall</title>
<style>
html,body{width:100%;height:100%;margin:0;background:#000;color:#fff;font-family:Arial,sans-serif;overflow:hidden}
#wall{position:fixed;left:0;top:0;width:100%;height:100%;display:grid;gap:2px;background:#000}
.tile{position:relative;background:#111;overflow:hidden}.tile img{width:100%;height:100%;object-fit:contain;display:block}
.tile span,#badge{position:absolute;background:rgba(0,0,0,.65);color:#fff;font-size:12px;padding:5px 8px}
.tile span{left:0;top:0}#badge{position:fixed;right:12px;top:12px;color:#20c997;z-index:2}
#empty{position:fixed;left:0;top:45%;width:100%;text-align:center;color:#aab5c2;font-size:22px}
</style></head><body><div id="wall"></div><div id="empty">Aguardando cameras do servidor...</div><div id="badge">CONECTANDO</div>
<script>
(function(){
var panelId=${JSON.stringify(panelId)}, authQuery=${JSON.stringify(authQuery || "")}, revision=null, wall=document.getElementById('wall'), empty=document.getElementById('empty'), badge=document.getElementById('badge');
function xhr(url, cb){var r=new XMLHttpRequest();r.open('GET',url,true);r.onreadystatechange=function(){if(r.readyState===4){if(r.status>=200&&r.status<300){try{cb(null,JSON.parse(r.responseText));}catch(e){cb(e);}}else cb(new Error('HTTP '+r.status));}};r.onerror=function(){cb(new Error('rede'));};r.send(null);}
function enc(v){return encodeURIComponent(v);}
function imgUrl(id){return '/legacy-wall/'+enc(panelId)+'/stream/'+enc(id)+'?'+authQuery+'&t='+(new Date().getTime());}
function refreshImages(){var imgs=document.getElementsByTagName('img');for(var i=0;i<imgs.length;i++){(function(img,delay){setTimeout(function(){img.src=imgUrl(img.getAttribute('data-camera-id'));},delay);})(imgs[i],i*350);}}
function render(layout){if(!layout)return;badge.innerHTML='AO VIVO';wall.style.gridTemplateColumns='repeat('+(layout.columns||1)+',1fr)';wall.style.gridTemplateRows='repeat('+(layout.rows||1)+',1fr)';if(revision===layout.revision)return;revision=layout.revision;wall.innerHTML='';if(!layout.tiles||!layout.tiles.length){empty.style.display='block';return;}empty.style.display='none';for(var i=0;i<layout.tiles.length;i++){var tile=layout.tiles[i], box=document.createElement('div'), img=document.createElement('img'), label=document.createElement('span');box.className='tile';box.style.gridRow=String(tile.row+1);box.style.gridColumn=String(tile.col+1);img.setAttribute('data-camera-id',tile.camera_id);img.onerror=function(){var self=this;badge.innerHTML='RECONECTANDO';setTimeout(function(){self.src=imgUrl(self.getAttribute('data-camera-id'));},1500);};label.textContent=tile.camera_id;box.appendChild(img);box.appendChild(label);wall.appendChild(box);img.src=imgUrl(tile.camera_id);}}
function poll(){xhr('/legacy-wall/'+enc(panelId)+'/layout?'+authQuery+'&t='+(new Date().getTime()),function(err,data){if(err){badge.innerHTML='RECONECTANDO';return;}render(data);});}
poll();setInterval(poll,5000);setInterval(refreshImages,90000);
})();
</script></body></html>`;
}

async function maybeCapturePanel(panel) {
  if (!panel) return null;
  const targetPath = path.join(DATA_DIR, "captures", `${panel.id}.jpg`);
  const current = captureState.get(panel.id);
  const minInterval = Math.round(1000 / RENDER_FPS);
  if (current && !current.error && Date.now() - current.at < minInterval && fs.existsSync(targetPath)) {
    return targetPath;
  }
  if (renderer.pending.has(panel.id)) {
    return renderer.pending.get(panel.id);
  }

  const pending = capturePanelWithDeadline(panel, targetPath);
  renderer.pending.set(panel.id, pending);
  pending.then(
    () => { if (renderer.pending.get(panel.id) === pending) renderer.pending.delete(panel.id); },
    () => { if (renderer.pending.get(panel.id) === pending) renderer.pending.delete(panel.id); }
  );
  return pending;
}

async function capturePanelWithDeadline(panel, targetPath) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), RENDER_TIMEOUT_MS);
  });
  const capture = capturePanel(panel, targetPath).then((value) => ({ value }));
  const result = await Promise.race([capture, timeout]);
  clearTimeout(timer);
  if (!result.timedOut) return result.value;

  captureState.set(panel.id, { at: Date.now(), error: `Renderizacao excedeu ${RENDER_TIMEOUT_MS / 1000}s; Chromium reiniciado` });
  console.error(`[renderer] Painel ${panel.name || panel.id} excedeu ${RENDER_TIMEOUT_MS / 1000}s. Reiniciando Chromium.`);
  const stalledBrowser = renderer.browser;
  renderer.browser = null;
  renderer.pages.clear();
  renderer.pageMeta.clear();
  renderer.pending.clear();
  if (stalledBrowser) stalledBrowser.close().catch(() => {});
  return fs.existsSync(targetPath) ? targetPath : null;
}

async function ensureRendererBrowser(playwright) {
  if (renderer.browser && renderer.browser.isConnected()) return renderer.browser;
  if (renderer.browser) await renderer.browser.close().catch(() => {});
  renderer.browser = null;
  renderer.pages.clear();
  renderer.pageMeta.clear();
  const browser = await playwright.chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-sandbox", "--autoplay-policy=no-user-gesture-required"]
  });
  renderer.browser = browser;
  browser.on("disconnected", () => {
    if (renderer.browser !== browser) return;
    renderer.browser = null;
    renderer.pages.clear();
    renderer.pageMeta.clear();
    renderer.pending.clear();
  });
  return browser;
}

async function savePageCapture(page, targetPath, quality) {
  const image = await page.screenshot({ type: "jpeg", quality, fullPage: false });
  const tempPath = `${targetPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.promises.writeFile(tempPath, image);
  try {
    await fs.promises.rename(tempPath, targetPath);
  } catch (err) {
    await fs.promises.copyFile(tempPath, targetPath);
    await fs.promises.rm(tempPath, { force: true });
  }
  renderer.frameCache.set(targetPath, image);
  return crypto.createHash("sha1").update(image).digest("hex");
}

function frameBuffer(filePath) {
  const cached = renderer.frameCache.get(filePath);
  if (cached) return cached;
  const image = fs.readFileSync(filePath);
  renderer.frameCache.set(filePath, image);
  return image;
}

function renderViewportSize(width, height, zoom) {
  const safeZoom = Math.max(0.25, Math.min(3, Number(zoom || 1)));
  return {
    width: Math.max(320, Math.round(Number(width || 1920) / safeZoom)),
    height: Math.max(180, Math.round(Number(height || 1080) / safeZoom)),
    zoom: safeZoom
  };
}

async function capturePanel(panel, targetPath) {
  let playwright;
  try {
    playwright = require("playwright");
  } catch (_) {
    captureState.set(panel.id, { at: Date.now(), error: "Playwright nao instalado" });
    return null;
  }

  try {
    await ensureRendererBrowser(playwright);
    let page = renderer.pages.get(panel.id);
    let meta = renderer.pageMeta.get(panel.id) || {};
    const width = Number(panel.width || 1920);
    const height = Number(panel.height || 1080);
    const viewport = renderViewportSize(width, height, panel.zoom);
    if (!page || page.isClosed()) {
      page = await renderer.browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
      renderer.pages.set(panel.id, page);
      meta = {};
    } else {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    }
    page.setDefaultTimeout(15000);
    if (meta.url !== panel.url) {
      const response = await page.goto(panel.url, { waitUntil: "domcontentloaded", timeout: 20000 });
      if (response && response.status() >= 400) throw new Error(`Problema no Link do Painel: HTTP ${response.status()}`);
      meta.loadedAt = Date.now();
      meta.authApplied = "";
    }
    const panelAuth = decryptSecret(panel.authSecret);
    const authSignature = panel.authSecret ? crypto.createHash("sha256").update(panel.authSecret).digest("hex") : "";
    if (panelAuth && panelAuth.enabled) {
      const usernameSelector = panelAuth.usernameSelector || 'input[name="username"], input[name="email"], input[type="email"], input[type="text"]';
      const passwordSelector = panelAuth.passwordSelector || 'input[name="password"], input[type="password"]';
      const submitSelector = panelAuth.submitSelector || 'button[type="submit"], input[type="submit"]';
      const usernameField = page.locator(usernameSelector).first();
      const passwordField = page.locator(passwordSelector).first();
      const loginVisible = await passwordField.isVisible().catch(() => false);
      if ((meta.authApplied !== authSignature || loginVisible) && await usernameField.count() && await passwordField.count()) {
        await usernameField.fill(panelAuth.username || "");
        await passwordField.fill(panelAuth.password || "");
        if (await page.locator(submitSelector).count()) await page.locator(submitSelector).first().click();
        else await passwordField.press("Enter");
        await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
        meta.authApplied = authSignature;
      }
    }
    await page.evaluate(() => {
      document.documentElement.style.zoom = "";
      document.body.style.zoom = "";
    }).catch(() => {});
    meta.url = panel.url;
    meta.zoom = viewport.zoom;
    meta.width = width;
    meta.height = height;
    meta.viewportWidth = viewport.width;
    meta.viewportHeight = viewport.height;
    meta.capturedAt = Date.now();
    meta.lastAccess = Date.now();
    await page.waitForTimeout(Math.max(0, Math.min(5000, Number(panel.renderDelayMs || 100))));
    const captureHash = await savePageCapture(page, targetPath, 78);
    if (meta.captureHash === captureHash) meta.sameFrameSince = meta.sameFrameSince || Date.now();
    else meta.sameFrameSince = 0;
    meta.captureHash = captureHash;
    renderer.pageMeta.set(panel.id, meta);
    captureState.set(panel.id, { at: Date.now(), error: "", path: `/panel-image/${panel.id}` });
    return targetPath;
  } catch (err) {
    captureState.set(panel.id, { at: Date.now(), error: err.message });
    if (renderer.pages.has(panel.id)) {
      const page = renderer.pages.get(panel.id);
      renderer.pages.delete(panel.id);
      renderer.pageMeta.delete(panel.id);
      if (page && !page.isClosed()) await page.close().catch(() => {});
    }
    if (renderer.browser && !renderer.browser.isConnected()) renderer.browser = null;
    if (fs.existsSync(targetPath)) return targetPath;
    return null;
  }
}

async function interactWithPanel(panel, action) {
  const targetPath = path.join(DATA_DIR, "captures", `${panel.id}.jpg`);
  if (renderer.pending.has(panel.id)) await renderer.pending.get(panel.id);
  await maybeCapturePanel(panel);

  const operation = (async () => {
    const page = renderer.pages.get(panel.id);
    if (!page || page.isClosed()) throw new Error("Sessao renderizada indisponivel");
    const type = String(action.type || "");
    if (type === "click") {
      const viewport = page.viewportSize();
      const x = Math.max(0, Math.min(viewport.width, Number(action.x || 0) * viewport.width));
      const y = Math.max(0, Math.min(viewport.height, Number(action.y || 0) * viewport.height));
      await page.mouse.click(x, y);
    } else if (type === "type") {
      if (action.replace) await page.keyboard.press("Control+A");
      await page.keyboard.insertText(String(action.text || "").slice(0, 2000));
    } else if (type === "key") {
      const allowed = ["Enter", "Escape", "Tab", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"];
      if (!allowed.includes(action.key)) throw new Error("Tecla nao permitida");
      await page.keyboard.press(action.key);
    } else if (type === "scroll") {
      await page.mouse.wheel(0, Math.max(-3000, Math.min(3000, Number(action.deltaY || 0))));
    } else if (type === "reload") {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
    } else {
      throw new Error("Acao de interacao invalida");
    }
    await page.waitForTimeout(120);
    await savePageCapture(page, targetPath, 82);
    captureState.set(panel.id, { at: Date.now(), error: "", path: `/panel-image/${panel.id}` });
  })();

  const captureLock = operation.then(() => targetPath, () => null);
  renderer.pending.set(panel.id, captureLock);
  try {
    await operation;
    return { ok: true, at: now() };
  } finally {
    if (renderer.pending.get(panel.id) === captureLock) renderer.pending.delete(panel.id);
  }
}

async function handleApi(req, res, url) {
  const db = loadDb();
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "POST" && url.pathname === "/api/login") {
    if (!ADMIN_AUTH_ENABLED) {
      sendJson(res, 200, { ok: true, user: { username: OPEN_ADMIN_USER.username, displayName: OPEN_ADMIN_USER.displayName, role: OPEN_ADMIN_USER.role } });
      return;
    }
    if (!validRequestOrigin(req)) {
      sendJson(res, 403, { error: "Origem da requisicao nao permitida", code: "DVS_CSRF_ORIGIN_REJECTED" });
      return;
    }
    const body = await readBody(req);
    const username = String(body.user || "").trim().toLowerCase();
    const ip = clientIp(req);
    const attemptKey = `${ip}:${username}`;
    const attempt = loginAttempts.get(attemptKey) || { failures: [], blockedUntil: 0 };
    attempt.failures = attempt.failures.filter((at) => Date.now() - at < 5 * 60 * 1000);
    if (attempt.blockedUntil > Date.now()) {
      res.setHeader("retry-after", String(Math.ceil((attempt.blockedUntil - Date.now()) / 1000)));
      sendJson(res, 429, { error: "Muitas tentativas de login. Aguarde e tente novamente.", code: "DVS_AUTH_RATE_LIMITED" });
      return;
    }
    const password = String(body.password || "");
    const user = db.users.find((item) => item.username === username && item.enabled !== false);
    if (!user || !verifyPassword(user, password)) {
      attempt.failures.push(Date.now());
      if (attempt.failures.length >= 5) attempt.blockedUntil = Date.now() + 5 * 60 * 1000;
      if (!loginAttempts.has(attemptKey)) makeRoomForLoginTracker();
      loginAttempts.set(attemptKey, attempt);
      sendJson(res, 401, { error: "Usuario ou senha invalidos", code: "DVS_AUTH_INVALID_CREDENTIALS" });
      return;
    }
    loginAttempts.delete(attemptKey);
    if (user.algorithm !== "scrypt-v2") {
      Object.assign(user, makeAuth(password, user.username));
      if (user.username === "admin") db.auth = { ...user };
      saveDb(db);
    }
    setSession(req, res, user);
    sendJson(res, 200, { ok: true, user: { username: user.username, displayName: user.displayName, role: user.role } });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    if (!ADMIN_AUTH_ENABLED) {
      sendJson(res, 200, { ok: true });
      return;
    }
    const logoutSession = currentSession(req);
    if (!validRequestOrigin(req) || !validCsrf(req, logoutSession)) {
      sendJson(res, 403, { error: "Token de seguranca ausente ou invalido", code: "DVS_CSRF_TOKEN_INVALID" });
      return;
    }
    clearSession(req, res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (ADMIN_AUTH_ENABLED && !["GET", "HEAD", "OPTIONS"].includes(req.method) && !isTvApi(url) && !isDashboardReadOnlyApi(req, url) && !validRequestOrigin(req)) {
    sendJson(res, 403, { error: "Origem da requisicao nao permitida", code: "DVS_CSRF_ORIGIN_REJECTED" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/me") {
    const session = ADMIN_AUTH_ENABLED ? currentSession(req) : null;
    const user = ADMIN_AUTH_ENABLED ? session && db.users.find((item) => item.id === session.userId && item.enabled !== false) : OPEN_ADMIN_USER;
    sendJson(res, user ? 200 : 401, user ? { ok: true, user: user.username, displayName: user.displayName, role: user.role, mustChangePassword: Boolean(user.mustChangePassword), csrfToken: session ? session.csrfToken : "", authEnabled: ADMIN_AUTH_ENABLED } : { ok: false, authEnabled: ADMIN_AUTH_ENABLED });
    return;
  }

  if (ADMIN_AUTH_ENABLED && !isTvApi(url) && !isDashboardReadOnlyApi(req, url) && !isAuthed(req)) {
    sendJson(res, 401, { error: "Nao autenticado", code: "DVS_AUTH_REQUIRED" });
    return;
  }

  const session = ADMIN_AUTH_ENABLED ? currentSession(req) : null;
  const sessionUser = adminUserForRequest(req, db);
  if (ADMIN_AUTH_ENABLED && !isTvApi(url) && !isDashboardReadOnlyApi(req, url) && !sessionUser) {
    clearSession(req, res);
    sendJson(res, 401, { error: "Usuario removido ou desativado", code: "DVS_AUTH_REQUIRED" });
    return;
  }

  if (ADMIN_AUTH_ENABLED && !isTvApi(url) && !isDashboardReadOnlyApi(req, url) && !["GET", "HEAD", "OPTIONS"].includes(req.method) && !validCsrf(req, session)) {
    sendJson(res, 403, { error: "Token de seguranca ausente ou invalido", code: "DVS_CSRF_TOKEN_INVALID" });
    return;
  }

  if (ADMIN_AUTH_ENABLED && sessionUser && sessionUser.mustChangePassword && !["/api/me", "/api/change-password", "/api/logout"].includes(url.pathname)) {
    sendJson(res, 403, { error: "Altere a senha temporaria antes de continuar", code: "DVS_AUTH_PASSWORD_CHANGE_REQUIRED" });
    return;
  }

  if (sessionUser && sessionUser.role === "operator" && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const operatorAction = (req.method === "POST" && url.pathname === "/api/panels") || (req.method === "PATCH" && /^\/api\/tvs\/[^/]+$/.test(url.pathname)) ||
      (req.method === "POST" && /^\/api\/tvs\/[^/]+\/command$/.test(url.pathname)) ||
      (req.method === "POST" && /^\/api\/panels\/[^/]+\/interact$/.test(url.pathname)) ||
      url.pathname === "/api/change-password" || url.pathname === "/api/logout";
    if (!operatorAction) {
      sendJson(res, 403, { error: "O perfil Operador nao possui permissao para esta acao", code: "DVS_AUTH_FORBIDDEN" });
      return;
    }
  }

  if (url.pathname.startsWith("/api/users") && sessionUser && sessionUser.role !== "supervisor") {
    sendJson(res, 403, { error: "Somente Supervisores podem administrar usuarios", code: "DVS_AUTH_FORBIDDEN" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/change-password") {
    const body = await readBody(req);
    if (!verifyPassword(sessionUser, String(body.currentPassword || ""))) {
      sendJson(res, 400, { error: "Senha atual incorreta", code: "DVS_AUTH_CURRENT_PASSWORD_INVALID" });
      return;
    }
    if (String(body.newPassword || "") !== String(body.confirmPassword || "")) {
      sendJson(res, 400, { error: "A confirmacao da nova senha nao confere", code: "DVS_AUTH_PASSWORD_CONFIRMATION_MISMATCH" });
      return;
    }
    const policyError = passwordPolicyError(body.newPassword, sessionUser.username);
    if (policyError) return sendJson(res, 400, { error: policyError, code: "DVS_AUTH_WEAK_PASSWORD" });
    if (verifyPassword(sessionUser, String(body.newPassword || ""))) return sendJson(res, 400, { error: "A nova senha deve ser diferente da senha atual", code: "DVS_AUTH_PASSWORD_REUSED" });
    const replacement = makeAuth(String(body.newPassword), sessionUser.username);
    Object.assign(sessionUser, replacement, { mustChangePassword: false });
    if (sessionUser.username === "admin") db.auth = { ...replacement, mustChangePassword: false };
    saveDb(db);
    invalidateUserSessions(sessionUser.id);
    const nextSession = setSession(req, res, sessionUser);
    sendJson(res, 200, { ok: true, csrfToken: nextSession.csrfToken });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/users") {
    sendJson(res, 200, { users: db.users.map((user) => ({ id: user.id, username: user.username, displayName: user.displayName, role: user.role, enabled: user.enabled !== false, mustChangePassword: Boolean(user.mustChangePassword), updatedAt: user.updatedAt || "" })) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/users") {
    const body = await readBody(req);
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    const role = String(body.role || "operator");
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) return sendJson(res, 400, { error: "Usuario deve ter de 3 a 40 caracteres: letras minusculas, numeros, ponto, traco ou sublinhado", code: "DVS_USER_INVALID" });
    if (db.users.some((user) => user.username === username)) return sendJson(res, 409, { error: "Nome de usuario ja cadastrado", code: "DVS_USER_EXISTS" });
    if (db.users.length >= MAX_USERS) return sendJson(res, 409, { error: "Limite de usuarios atingido", code: "DVS_USER_LIMIT_REACHED" });
    const policyError = passwordPolicyError(password, username);
    if (policyError) return sendJson(res, 400, { error: policyError, code: "DVS_AUTH_WEAK_PASSWORD" });
    if (!["supervisor", "technician", "operator"].includes(role)) return sendJson(res, 400, { error: "Perfil de acesso invalido", code: "DVS_USER_ROLE_INVALID" });
    const auth = makeAuth(password, username);
    const user = { id: id("user"), username, displayName: String(body.displayName || username).trim().slice(0, 80), role, enabled: true, createdAt: now(), ...auth, mustChangePassword: Boolean(body.mustChangePassword) };
    db.users.push(user);
    logEvent(db, "user_created", `Usuario ${username} criado`, { userId: user.id, role, actor: sessionUser.username });
    saveDb(db);
    sendJson(res, 201, { user: { id: user.id, username, displayName: user.displayName, role, enabled: true } });
    return;
  }

  if (parts[0] === "api" && parts[1] === "users" && parts[2] && req.method === "PATCH") {
    const body = await readBody(req);
    const user = db.users.find((item) => item.id === parts[2]);
    if (!user) return sendJson(res, 404, { error: "Usuario nao encontrado", code: "DVS_USER_NOT_FOUND" });
    const nextRole = body.role === undefined ? user.role : String(body.role);
    const nextEnabled = body.enabled === undefined ? user.enabled !== false : Boolean(body.enabled);
    if (!["supervisor", "technician", "operator"].includes(nextRole)) return sendJson(res, 400, { error: "Perfil de acesso invalido", code: "DVS_USER_ROLE_INVALID" });
    const activeSupervisors = db.users.filter((item) => item.role === "supervisor" && item.enabled !== false && item.id !== user.id).length;
    if (user.role === "supervisor" && user.enabled !== false && (nextRole !== "supervisor" || !nextEnabled) && activeSupervisors === 0) return sendJson(res, 409, { error: "O sistema precisa manter pelo menos um Supervisor ativo", code: "DVS_USER_LAST_SUPERVISOR" });
    if (body.password !== undefined && String(body.password) !== String(body.confirmPassword || "")) return sendJson(res, 400, { error: "A confirmacao da nova senha nao confere", code: "DVS_AUTH_PASSWORD_CONFIRMATION_MISMATCH" });
    const policyError = body.password === undefined ? "" : passwordPolicyError(body.password, user.username);
    if (policyError) return sendJson(res, 400, { error: policyError, code: "DVS_AUTH_WEAK_PASSWORD" });
    user.displayName = body.displayName === undefined ? user.displayName : String(body.displayName || user.username).trim().slice(0, 80);
    user.role = nextRole;
    user.enabled = nextEnabled;
    if (body.password !== undefined) Object.assign(user, makeAuth(String(body.password), user.username), { mustChangePassword: Boolean(body.mustChangePassword) });
    user.updatedAt = now();
    if (user.username === "admin") db.auth = { user: user.username, salt: user.salt, algorithm: user.algorithm, passwordHash: user.passwordHash, mustChangePassword: user.mustChangePassword, updatedAt: user.updatedAt };
    logEvent(db, "user_updated", `Usuario ${user.username} atualizado`, { userId: user.id, role: user.role, actor: sessionUser.username });
    saveDb(db);
    invalidateUserSessions(user.id);
    sendJson(res, 200, { user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role, enabled: user.enabled } });
    return;
  }

  if (parts[0] === "api" && parts[1] === "users" && parts[2] && req.method === "DELETE") {
    const user = db.users.find((item) => item.id === parts[2]);
    if (!user) return sendJson(res, 404, { error: "Usuario nao encontrado", code: "DVS_USER_NOT_FOUND" });
    if (user.id === sessionUser.id) return sendJson(res, 409, { error: "Nao e permitido excluir o usuario da sessao atual", code: "DVS_USER_SELF_DELETE" });
    if (user.role === "supervisor" && user.enabled !== false && db.users.filter((item) => item.role === "supervisor" && item.enabled !== false).length <= 1) return sendJson(res, 409, { error: "O sistema precisa manter pelo menos um Supervisor ativo", code: "DVS_USER_LAST_SUPERVISOR" });
    db.users = db.users.filter((item) => item.id !== user.id);
    logEvent(db, "user_deleted", `Usuario ${user.username} excluido`, { userId: user.id, actor: sessionUser.username });
    saveDb(db);
    invalidateUserSessions(user.id);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    sendApi(res, url, 200, publicState(db));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/ping") {
    sendApi(res, url, 200, { ok: true, serverTime: now(), app: "DVS Controller" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendApi(res, url, dbPersistenceError ? 503 : 200, { ok: !dbPersistenceError, app: "DVS Controller", uptime: Math.round(process.uptime()), serverTime: now() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/diagnostics") {
    const memory = process.memoryUsage();
    sendJson(res, 200, {
      ok: true,
      pid: process.pid,
      node: process.version,
      uptime: Math.round(process.uptime()),
      memory: { rss: memory.rss, heapUsed: memory.heapUsed, external: memory.external },
      eventLoopP99Ms: Math.round(eventLoopDelay.percentile(99) / 1e6),
      database: { backend: databaseBackend, revision: dbRevision, pending: Boolean(dbPendingSnapshot || dbWriteTimer), error: dbPersistenceError && dbPersistenceError.message || "" },
      renderer: { connected: Boolean(renderer.browser && renderer.browser.isConnected()), pages: renderer.pages.size, captures: renderer.pending.size, streams: Array.from(renderer.activeStreams.values()).reduce((sum, count) => sum + count, 0) },
      connections: { sse: sseClients.size, sessions: sessions.size },
      serverTime: now()
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    const key = `admin:${id("sse")}`;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive"
    });
    writeSse(res, `event: state\ndata: ${JSON.stringify(publicState(db))}\n\n`);
    sseClients.set(key, res);
    req.on("close", () => sseClients.delete(key));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tv/register") {
    const body = await readBody(req);
    registerTv(req, res, db, body);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/tv/register") {
    if (!ALLOW_LEGACY_TV_QUERY_AUTH) return sendJson(res, 410, { error: "Registro legado por URL desativado", code: "DVS_TV_LEGACY_AUTH_DISABLED" });
    const body = {
      id: url.searchParams.get("id") || "",
      token: url.searchParams.get("token") || "",
      name: url.searchParams.get("name") || "",
      groupId: url.searchParams.get("groupId") || "",
      model: url.searchParams.get("model") || "",
      platform: url.searchParams.get("platform") || "LG webOS",
      appVersion: url.searchParams.get("appVersion") || ""
    };
    registerTv(req, res, db, body);
    return;
  }

  function registerTv(req, res, db, body) {
    const name = String(body.name || "").trim() || "TV sem nome";
    let tv = body.id ? db.tvs.find((item) => item.id === body.id) : null;
    const existingTv = Boolean(tv);
    let responseToken = String(body.token || "");
    if (body.id && !tv) {
      sendApi(res, url, 401, { error: "Cadastro da TV nao reconhecido", code: "DVS_TV_REGISTRATION_INVALID" });
      return;
    }
    if (tv && !verifyTvToken(tv, body.token)) {
      sendApi(res, url, 401, { error: "Token da TV invalido", code: "DVS_TV_TOKEN_INVALID" });
      return;
    }
    if (!tv) {
      if (db.tvs.length >= MAX_TVS) {
        sendApi(res, url, 409, { error: "Limite de TVs cadastradas atingido", code: "DVS_TV_LIMIT_REACHED" });
        return;
      }
      responseToken = authToken();
      tv = {
        id: id("tv"),
        tokenHash: tokenHash(responseToken),
        name,
        groupId: body.groupId || "default",
        currentPanelId: "",
        playbackMode: "direct",
        zoom: 1,
        createdAt: now()
      };
      db.tvs.push(tv);
      logEvent(db, "tv_registered", `TV cadastrada: ${name}`, { tvId: tv.id });
    }
    if (!existingTv || !tv.name) tv.name = name.slice(0, 80);
    tv.groupId = body.groupId || tv.groupId || "default";
    tv.model = String(body.model || tv.model || "");
    tv.platform = String(body.platform || tv.platform || "webOS");
    tv.appVersion = String(body.appVersion || tv.appVersion || "");
    tv.ip = normalizeIp(req.socket.remoteAddress);
    tv.zoom = Number(body.zoom || tv.zoom || 1);
    tv.lastSeen = now();
    db.webosDevices.forEach((device) => {
      if (!device.linkedTvId && normalizeIp(device.host) === tv.ip) device.linkedTvId = tv.id;
    });
    db.tizenDevices.forEach((device) => {
      if (!device.linkedTvId && normalizeIp(device.host) === tv.ip) device.linkedTvId = tv.id;
    });
    db.androidDevices.forEach((device) => {
      if (!device.linkedTvId && normalizeIp(device.host) === tv.ip) device.linkedTvId = tv.id;
    });
    saveDb(db);
    broadcastAdmin();
    const responseTv = { ...tv, token: responseToken };
    delete responseTv.tokenHash;
    setTvCookie(req, res, tv.id, responseToken);
    sendApi(res, url, 200, { tv: responseTv });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "tv" && parts[3] === "heartbeat") {
    const tv = authTv(db, parts[2], tvRequestToken(req, url, parts[2]));
    if (!tv) return sendJson(res, 401, { error: "TV nao autorizada" });
    const body = await readBody(req);
    tv.lastSeen = now();
    tv.ip = normalizeIp(req.socket.remoteAddress);
    const reportedPanelId = body.currentPanelId || "";
    const reportedZoom = body.zoom || tv.zoom || 1;
    tv.currentPanelId = reportedPanelId || tv.currentPanelId || "";
    tv.lastError = String(body.lastError || "").slice(0, 500);
    tv.playbackMode = body.playbackMode || tv.playbackMode || "direct";
    tv.zoom = Number(reportedZoom);
    acknowledgePendingCommand(tv, reportedPanelId, reportedZoom);
    saveDb(db);
    sendJson(res, 200, { ok: true, serverTime: now() });
    return;
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "tv" && parts[3] === "heartbeat") {
    if (!ALLOW_LEGACY_TV_QUERY_AUTH) return sendJson(res, 410, { error: "Heartbeat legado por URL desativado", code: "DVS_TV_LEGACY_AUTH_DISABLED" });
    const tv = authTv(db, parts[2], tvRequestToken(req, url, parts[2]));
    if (!tv) return sendApi(res, url, 401, { error: "TV nao autorizada" });
    tv.lastSeen = now();
    tv.ip = normalizeIp(req.socket.remoteAddress);
    const reportedPanelId = url.searchParams.get("currentPanelId") || "";
    const reportedZoom = url.searchParams.get("zoom") || tv.zoom || 1;
    tv.currentPanelId = reportedPanelId || tv.currentPanelId || "";
    tv.lastError = String(url.searchParams.get("lastError") || "").slice(0, 500);
    tv.playbackMode = url.searchParams.get("playbackMode") || tv.playbackMode || "direct";
    tv.zoom = Number(reportedZoom);
    acknowledgePendingCommand(tv, reportedPanelId, reportedZoom);
    saveDb(db);
    sendApi(res, url, 200, { ok: true, serverTime: now() });
    return;
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "tv" && parts[3] === "events") {
    const tv = authTv(db, parts[2], tvRequestToken(req, url, parts[2]));
    if (!tv) return sendApi(res, url, 401, { error: "TV nao autorizada" });
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive"
    });
    const previousClient = sseClients.get(tv.id);
    if (previousClient && previousClient !== res && !previousClient.destroyed) previousClient.end();
    writeSse(res, `event: hello\ndata: ${JSON.stringify({ tvId: tv.id, at: now() })}\n\n`);
    sseClients.set(tv.id, res);
    const startupCommands = commandsForTv(tv);
    for (const command of startupCommands) writeSse(res, `event: command\ndata: ${JSON.stringify(command)}\n\n`);
    req.on("close", () => {
      if (sseClients.get(tv.id) === res) sseClients.delete(tv.id);
    });
    return;
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "tv" && parts[3] === "panel-health") {
    const tv = authTv(db, parts[2], tvRequestToken(req, url, parts[2]));
    if (!tv) return sendJson(res, 401, { error: "TV nao autorizada" });
    const panel = db.panels.find(item => item.id === tv.currentPanelId);
    if (panel && panel.mode === "server_image") {
      const capture = captureState.get(panel.id);
      return sendJson(res, 200, { panelId: panel.id, status: capture ? capture.error ? "error" : "reachable" : "unknown", reason: capture && capture.error ? "Renderizacao indisponivel" : "" });
    }
    if (!panel || !["direct", "legacy_videowall"].includes(panel.mode || "direct")) return sendJson(res, 200, { status: "unknown" });
    return sendJson(res, 200, { panelId: panel.id, ...await panelHealth.check(panel) });
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "tv" && parts[3] === "state") {
    const tv = authTv(db, parts[2], tvRequestToken(req, url, parts[2]));
    if (!tv) return sendApi(res, url, 401, { error: "TV nao autorizada", code: "DVS_TV_TOKEN_INVALID" });
    const panel = db.panels.find(item => item.id === tv.currentPanelId);
    const playlist = panel && db.playlists.find(item => item.id === panel.playlistId);
    const panelPlaylist = panel && db.panelPlaylists.find(item => item.id === panel.panelPlaylistId);
    const panelIds = new Set([panel && panel.id, ...(panelPlaylist && panelPlaylist.items || []).map(item => item.panelId)]);
    const panelPayload = db.panels.filter(item => panelIds.has(item.id)).map(publicPanel);
    const playlistPanelIds = new Set((panelPlaylist && panelPlaylist.items || []).map(item => item.panelId));
    const playlistIds = new Set([playlist && playlist.id]);
    const mediaIds = new Set([panel && panel.mediaId, ...(playlist && playlist.items || []).map(item => typeof item === "string" ? item : item.mediaId)]);
    db.panels.forEach((item) => {
      if (!playlistPanelIds.has(item.id)) return;
      if (item.mediaId) mediaIds.add(item.mediaId);
      const nestedPlaylist = db.playlists.find(entry => entry.id === item.playlistId);
      if (nestedPlaylist) playlistIds.add(nestedPlaylist.id);
      (nestedPlaylist && nestedPlaylist.items || []).forEach(mediaId => mediaIds.add(mediaId));
    });
    sendApi(res, url, 200, { panels: panelPayload, playlists: db.playlists.filter(item => playlistIds.has(item.id)), panelPlaylists: panelPlaylist ? [panelPlaylist] : [], media: db.media.filter(item => mediaIds.has(item.id)).map(item => ({ id: item.id, name: item.name, mime: item.mime, url: `/media/${item.id}` })), serverTime: now() });
    return;
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "tv" && parts[3] === "poll") {
    const tv = authTv(db, parts[2], tvRequestToken(req, url, parts[2]));
    if (!tv) return sendJson(res, 401, { error: "TV nao autorizada" });
    tv.lastSeen = now();
    saveDb(db);
    const commands = commandsForTv(tv);
    sendApi(res, url, 200, { command: commands[0] || null, commands, serverTime: now() });
    return;
  }

  if (req.method === "PATCH" && parts[0] === "api" && parts[1] === "tvs" && parts[2]) {
    const body = await readBody(req);
    const tv = db.tvs.find((item) => item.id === parts[2]);
    if (!tv) return sendJson(res, 404, { error: "TV nao encontrada" });
    if (body.name !== undefined) tv.name = String(body.name || "").trim() || tv.name;
    if (body.groupId !== undefined) {
      const groupExists = db.groups.some((group) => group.id === body.groupId);
      tv.groupId = groupExists ? body.groupId : "default";
    }
    saveDb(db);
    broadcastAdmin();
    sendJson(res, 200, { tv });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/webos/devices") {
    const body = await readBody(req);
    const host = String(body.host || "").trim();
    if (!/^[A-Za-z0-9.-]+$/.test(host)) return sendJson(res, 400, { error: "IP ou host invalido" });
    let device = body.id ? db.webosDevices.find((item) => item.id === body.id) : null;
    if (!device) {
      device = { id: id("webos"), alias: `dvs_${crypto.randomBytes(5).toString("hex")}`, createdAt: now() };
      db.webosDevices.push(device);
    }
    device.name = String(body.name || "TV LG").trim().slice(0, 80);
    device.host = host;
    device.port = Math.max(1, Math.min(65535, Number(body.port || 9922)));
    device.username = String(body.username || "prisoner").trim() || "prisoner";
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(device.username)) return sendJson(res, 400, { error: "Usuario SSH invalido", code: "DVS_WEBOS_USERNAME_INVALID" });
    const matchedTv = db.tvs.find((tv) => normalizeIp(tv.ip) === normalizeIp(host));
    device.linkedTvId = db.tvs.some((tv) => tv.id === body.linkedTvId) ? body.linkedTvId : matchedTv && matchedTv.id || "";
    device.autoRenew = Boolean(body.autoRenew);
    device.autoLaunch = Boolean(body.autoLaunch);
    device.updatedAt = now();
    saveDb(db);
    if (body.passphrase) {
      try {
        const output = await webosManager.pair(device, body.passphrase);
        const fresh = loadDb();
        const saved = fresh.webosDevices.find((item) => item.id === device.id);
        saved.lastAction = "pair";
        saved.lastResult = output;
        saved.lastError = "";
        saveDb(fresh);
      } catch (err) {
        const fresh = loadDb();
        const saved = fresh.webosDevices.find((item) => item.id === device.id);
        saved.lastAction = "pair";
        saved.lastError = err.message;
        saveDb(fresh);
        return sendJson(res, 502, { error: err.message, device: saved });
      }
    }
    broadcastAdmin();
    sendJson(res, 200, { device });
    return;
  }

  if (req.method === "PATCH" && parts[0] === "api" && parts[1] === "webos" && parts[2] === "devices" && parts[3]) {
    const body = await readBody(req);
    const device = db.webosDevices.find((item) => item.id === parts[3]);
    if (!device) return sendJson(res, 404, { error: "Dispositivo webOS nao encontrado" });
    if (body.autoRenew !== undefined) device.autoRenew = Boolean(body.autoRenew);
    if (body.autoLaunch !== undefined) device.autoLaunch = Boolean(body.autoLaunch);
    if (body.linkedTvId !== undefined) device.linkedTvId = db.tvs.some((tv) => tv.id === body.linkedTvId) ? body.linkedTvId : "";
    if (body.scheduledSystemUpdateAt !== undefined) {
      const schedule = String(body.scheduledSystemUpdateAt || "").trim();
      if (schedule && Number.isNaN(new Date(schedule).getTime())) return sendJson(res, 400, { error: "Horario de atualizacao invalido", code: "DVS_WEBOS_UPDATE_SCHEDULE_INVALID" });
      device.scheduledSystemUpdateAt = schedule;
    }
    device.updatedAt = now();
    saveDb(db);
    broadcastAdmin();
    sendJson(res, 200, { device });
    return;
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "webos" && parts[2] === "devices" && parts[3] && parts[4] === "action") {
    const body = await readBody(req);
    const device = db.webosDevices.find((item) => item.id === parts[3]);
    if (!device) return sendJson(res, 404, { error: "Dispositivo webOS nao encontrado" });
    const action = String(body.action || "");
    try {
      let output;
      if (action !== "pair" && body.passphrase) {
        output = await webosManager.pair(device, body.passphrase);
      }
      if (action === "pair") output = await webosManager.pair(device, body.passphrase);
      else if (action === "test") output = [output, await webosManager.deviceInfo(device)].filter(Boolean).join("\n");
      else if (action === "install") output = [output, await webosManager.install(device, WEBOS_DIR, false)].filter(Boolean).join("\n");
      else if (action === "update") {
        output = [output, await webosManager.install(device, WEBOS_DIR, true)].filter(Boolean).join("\n");
        output += `\n${await webosManager.launch(device)}`;
      } else if (action === "launch") output = [output, await webosManager.launch(device)].filter(Boolean).join("\n");
      else if (action === "close") output = [output, await webosManager.close(device)].filter(Boolean).join("\n");
      else if (action === "renew") output = [output, await webosManager.renewDeveloperMode(device)].filter(Boolean).join("\n");
      else if (action === "check-system-update") output = [output, await webosManager.checkSystemUpdate(device)].filter(Boolean).join("\n");
      else if (action === "start-system-update") output = [output, await webosManager.startSystemUpdate(device)].filter(Boolean).join("\n");
      else if (action === "schedule-system-update") {
        const schedule = String(body.scheduledAt || "").trim();
        const scheduledAt = new Date(schedule).getTime();
        if (!schedule || Number.isNaN(scheduledAt) || scheduledAt <= Date.now()) return sendJson(res, 400, { error: "Informe um horario futuro para agendar a atualizacao", code: "DVS_WEBOS_UPDATE_SCHEDULE_INVALID" });
        const fresh = loadDb();
        const saved = fresh.webosDevices.find((item) => item.id === device.id);
        let scheduleResult = "Atualizacao agendada";
        if (saved) {
          saved.scheduledSystemUpdateAt = new Date(scheduledAt).toISOString();
          saved.lastAction = action;
          saved.lastResult = `Atualizacao do sistema agendada para ${new Date(scheduledAt).toLocaleString("pt-BR")}`;
          scheduleResult = saved.lastResult;
          saved.lastError = "";
          saved.updatedAt = now();
          saveDb(fresh);
        }
        broadcastAdmin();
        return sendJson(res, 200, { ok: true, output: scheduleResult });
      }
      else return sendJson(res, 400, { error: "Acao webOS invalida" });
      const fresh = loadDb();
      const saved = fresh.webosDevices.find((item) => item.id === device.id);
      if (saved) {
        saved.lastAction = action;
        saved.lastResult = output;
        saved.lastError = "";
        saved.updatedAt = now();
        if (action === "renew") saved.lastRenewedAt = now();
        if (action === "check-system-update") {
          saved.lastSystemUpdateCheckAt = now();
          saved.systemUpdateStatus = output;
        }
        if (action === "start-system-update") saved.scheduledSystemUpdateAt = "";
        saveDb(fresh);
      }
      broadcastAdmin();
      sendJson(res, 200, { ok: true, output });
    } catch (err) {
      const fresh = loadDb();
      const saved = fresh.webosDevices.find((item) => item.id === device.id);
      if (saved) {
        saved.lastAction = action;
        saved.lastError = err.message;
        saved.updatedAt = now();
        saveDb(fresh);
      }
      broadcastAdmin();
      const needsPair = /All configured authentication methods failed|autenticacao SSH/i.test(String(err.message || ""));
      sendJson(res, 502, { error: err.message, code: needsPair ? "DVS_WEBOS_AUTH_FAILED" : "DVS_UPSTREAM_ERROR", needsPair });
    }
    return;
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "webos" && parts[2] === "devices" && parts[3]) {
    const device = db.webosDevices.find((item) => item.id === parts[3]);
    if (!device) return sendJson(res, 404, { error: "Dispositivo webOS nao encontrado" });
    await webosManager.removeDevice(device);
    const fresh = loadDb();
    fresh.webosDevices = fresh.webosDevices.filter((item) => item.id !== device.id);
    saveDb(fresh);
    broadcastAdmin();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/webos/status") {
    const status = await webosManager.cliStatus();
    const pkg = fs.readdirSync(WEBOS_DIR).filter((name) => name.endsWith(".ipk")).sort().pop() || "";
    sendJson(res, 200, { ...status, package: pkg, appId: webosManager.APP_ID });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tizen/devices") {
    const body = await readBody(req);
    const host = String(body.host || "").trim();
    if (!/^[A-Za-z0-9.-]+$/.test(host)) return sendApi(res, url, 400, { error: "IP ou host invalido", code: "DVS_TIZEN_HOST_INVALID" });
    let device = body.id ? db.tizenDevices.find((item) => item.id === body.id) : null;
    if (!device) {
      device = { id: id("tizen"), createdAt: now() };
      db.tizenDevices.push(device);
    }
    device.name = (String(body.name || "TV Samsung").trim() || "TV Samsung").slice(0, 80);
    device.host = host;
    device.port = Math.max(1, Math.min(65535, Number(body.port || 26101)));
    device.serial = String(body.serial || `${host}:${device.port}`).trim();
    if (!/^[A-Za-z0-9.:[\]-]{3,100}$/.test(device.serial) || device.serial.startsWith("-")) return sendJson(res, 400, { error: "Identificador SDB invalido", code: "DVS_TIZEN_SERIAL_INVALID" });
    device.profile = String(body.profile || device.profile || "").trim();
    if (device.profile && !/^[A-Za-z0-9_.-]{1,80}$/.test(device.profile)) return sendJson(res, 400, { error: "Perfil de certificado invalido", code: "DVS_TIZEN_PROFILE_INVALID" });
    const matchedTv = db.tvs.find((tv) => normalizeIp(tv.ip) === normalizeIp(host));
    device.linkedTvId = db.tvs.some((tv) => tv.id === body.linkedTvId) ? body.linkedTvId : matchedTv && matchedTv.id || "";
    device.autoLaunch = Boolean(body.autoLaunch);
    device.updatedAt = now();
    saveDb(db);
    try {
      const output = await tizenManager.connect(device);
      const fresh = loadDb();
      const saved = fresh.tizenDevices.find((item) => item.id === device.id);
      saved.lastAction = "connect";
      saved.lastResult = output;
      saved.lastError = "";
      saveDb(fresh);
    } catch (error) {
      const fresh = loadDb();
      const saved = fresh.tizenDevices.find((item) => item.id === device.id);
      saved.lastAction = "connect";
      saved.lastError = error.message;
      saveDb(fresh);
      broadcastAdmin();
      return sendApi(res, url, 502, { error: error.message, code: "DVS_TIZEN_CONNECT_FAILED", device: saved });
    }
    broadcastAdmin();
    sendApi(res, url, 200, { device });
    return;
  }

  if (req.method === "PATCH" && parts[0] === "api" && parts[1] === "tizen" && parts[2] === "devices" && parts[3]) {
    const body = await readBody(req);
    const device = db.tizenDevices.find((item) => item.id === parts[3]);
    if (!device) return sendApi(res, url, 404, { error: "Dispositivo Tizen nao encontrado", code: "DVS_TIZEN_NOT_FOUND" });
    if (body.name !== undefined) device.name = String(body.name || "").trim() || device.name;
    if (body.profile !== undefined) device.profile = String(body.profile || "").trim();
    if (body.autoLaunch !== undefined) device.autoLaunch = Boolean(body.autoLaunch);
    if (body.linkedTvId !== undefined) device.linkedTvId = db.tvs.some((tv) => tv.id === body.linkedTvId) ? body.linkedTvId : "";
    device.updatedAt = now();
    saveDb(db);
    broadcastAdmin();
    sendApi(res, url, 200, { device });
    return;
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "tizen" && parts[2] === "devices" && parts[3] && parts[4] === "action") {
    const body = await readBody(req);
    const device = db.tizenDevices.find((item) => item.id === parts[3]);
    if (!device) return sendApi(res, url, 404, { error: "Dispositivo Tizen nao encontrado", code: "DVS_TIZEN_NOT_FOUND" });
    const action = String(body.action || "");
    const signingOptions = {
      certificatePassword: String(body.certificatePassword || ""),
      authorPassword: String(body.authorPassword || ""),
      distributorPassword: String(body.distributorPassword || "")
    };
    try {
      let output;
      if (action === "connect") output = await tizenManager.connect(device);
      else if (action === "test") output = await tizenManager.deviceInfo(device);
      else if (action === "install") output = await tizenManager.install(device, TIZEN_DIR, false, body.profile || device.profile, signingOptions);
      else if (action === "update") {
        output = await tizenManager.install(device, TIZEN_DIR, true, body.profile || device.profile, signingOptions);
        output += `\n${await tizenManager.launch(device)}`;
      } else if (action === "package") {
        const built = await tizenManager.packageClient(TIZEN_DIR, body.profile || device.profile, signingOptions);
        output = `${built.output}\n${path.basename(built.packagePath)}`.trim();
      } else if (action === "launch") output = await tizenManager.launch(device);
      else if (action === "close") output = await tizenManager.close(device);
      else if (action === "uninstall") output = await tizenManager.uninstall(device);
      else return sendApi(res, url, 400, { error: "Acao Tizen invalida", code: "DVS_TIZEN_ACTION_INVALID" });
      const fresh = loadDb();
      const saved = fresh.tizenDevices.find((item) => item.id === device.id);
      if (saved) {
        saved.lastAction = action;
        saved.lastResult = output;
        saved.lastError = "";
        saved.updatedAt = now();
        saveDb(fresh);
      }
      broadcastAdmin();
      sendApi(res, url, 200, { ok: true, output });
    } catch (error) {
      const fresh = loadDb();
      const saved = fresh.tizenDevices.find((item) => item.id === device.id);
      if (saved) {
        saved.lastAction = action;
        saved.lastError = error.message;
        saved.updatedAt = now();
        saveDb(fresh);
      }
      broadcastAdmin();
      sendApi(res, url, 502, { error: error.message, code: "DVS_TIZEN_ACTION_FAILED" });
    }
    return;
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "tizen" && parts[2] === "devices" && parts[3]) {
    const device = db.tizenDevices.find((item) => item.id === parts[3]);
    if (!device) return sendApi(res, url, 404, { error: "Dispositivo Tizen nao encontrado", code: "DVS_TIZEN_NOT_FOUND" });
    await tizenManager.disconnect(device);
    const fresh = loadDb();
    fresh.tizenDevices = fresh.tizenDevices.filter((item) => item.id !== device.id);
    saveDb(fresh);
    broadcastAdmin();
    sendApi(res, url, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/tizen/status") {
    const status = await tizenManager.cliStatus();
    const pkg = tizenManager.latestPackage(TIZEN_DIR);
    sendApi(res, url, 200, { ...status, package: pkg ? path.basename(pkg.path) : "", appId: tizenManager.APP_ID });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tizen/sdk") {
    const body = await readBody(req);
    const validation = tizenManager.validateSdkRoot(body.path);
    if (!validation.valid) return sendApi(res, url, 400, {
      error: "O caminho nao contem tools\\sdb.exe e tools\\ide\\bin\\tizen.bat",
      code: "DVS_TIZEN_SDK_INVALID"
    });
    const config = configStore.load();
    config.tizenStudioPath = validation.root;
    configStore.save(config);
    process.env.TIZEN_STUDIO = validation.root;
    const status = await tizenManager.cliStatus();
    sendApi(res, url, 200, { ...status, restartRequired: false });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/tizen/profiles") {
    try {
      sendApi(res, url, 200, await tizenManager.certificateProfiles());
    } catch (error) {
      sendApi(res, url, 502, { error: error.message, code: "DVS_TIZEN_PROFILE_CHECK_FAILED" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/android/devices") {
    const body = await readBody(req);
    const host = String(body.host || "").trim();
    if (!/^[A-Za-z0-9.-]+$/.test(host)) return sendApi(res, url, 400, { error: "IP ou host invalido", code: "DVS_ANDROID_HOST_INVALID" });
    let device = body.id ? db.androidDevices.find((item) => item.id === body.id) : null;
    if (!device) {
      device = { id: id("android"), createdAt: now() };
      db.androidDevices.push(device);
    }
    device.name = (String(body.name || "Android TV").trim() || "Android TV").slice(0, 80);
    device.host = host;
    device.port = Math.max(1, Math.min(65535, Number(body.port || 5555)));
    device.serial = String(body.serial || `${host}:${device.port}`).trim();
    if (!/^[A-Za-z0-9.:[\]-]{3,100}$/.test(device.serial) || device.serial.startsWith("-")) return sendJson(res, 400, { error: "Identificador ADB invalido", code: "DVS_ANDROID_SERIAL_INVALID" });
    const matchedTv = db.tvs.find((tv) => normalizeIp(tv.ip) === normalizeIp(host));
    device.linkedTvId = db.tvs.some((tv) => tv.id === body.linkedTvId) ? body.linkedTvId : matchedTv && matchedTv.id || "";
    device.autoLaunch = Boolean(body.autoLaunch);
    device.updatedAt = now();
    saveDb(db);
    try {
      let output = await androidManager.connect(device);
      output += `\n${await androidManager.configureReceiver(device, { server: publicServerOrigin(req), name: device.name })}`;
      const fresh = loadDb();
      const saved = fresh.androidDevices.find((item) => item.id === device.id);
      saved.lastAction = "connect";
      saved.lastResult = output;
      saved.lastError = "";
      saveDb(fresh);
    } catch (error) {
      const fresh = loadDb();
      const saved = fresh.androidDevices.find((item) => item.id === device.id);
      saved.lastAction = "connect";
      saved.lastError = error.message;
      saveDb(fresh);
      broadcastAdmin();
      return sendApi(res, url, 502, { error: error.message, code: "DVS_ANDROID_CONNECT_FAILED", device: saved });
    }
    broadcastAdmin();
    sendApi(res, url, 200, { device });
    return;
  }

  if (req.method === "PATCH" && parts[0] === "api" && parts[1] === "android" && parts[2] === "devices" && parts[3]) {
    const body = await readBody(req);
    const device = db.androidDevices.find((item) => item.id === parts[3]);
    if (!device) return sendApi(res, url, 404, { error: "Dispositivo Android TV nao encontrado", code: "DVS_ANDROID_NOT_FOUND" });
    if (body.name !== undefined) device.name = String(body.name || "").trim() || device.name;
    if (body.autoLaunch !== undefined) device.autoLaunch = Boolean(body.autoLaunch);
    if (body.linkedTvId !== undefined) device.linkedTvId = db.tvs.some((tv) => tv.id === body.linkedTvId) ? body.linkedTvId : "";
    device.updatedAt = now();
    saveDb(db);
    if (body.autoLaunch !== undefined) {
      androidManager.setAutoLaunch(device, device.autoLaunch).catch((error) => {
        const fresh = loadDb();
        const saved = fresh.androidDevices.find((item) => item.id === device.id);
        if (saved) {
          saved.lastAction = "autoLaunch";
          saved.lastError = error.message;
          saved.updatedAt = now();
          saveDb(fresh);
          broadcastAdmin();
        }
      });
    }
    broadcastAdmin();
    sendApi(res, url, 200, { device });
    return;
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "android" && parts[2] === "devices" && parts[3] && parts[4] === "action") {
    const body = await readBody(req);
    const device = db.androidDevices.find((item) => item.id === parts[3]);
    if (!device) return sendApi(res, url, 404, { error: "Dispositivo Android TV nao encontrado", code: "DVS_ANDROID_NOT_FOUND" });
    const action = String(body.action || "");
    try {
      let output;
      if (action === "connect") output = await androidManager.connect(device);
      else if (action === "test") output = await androidManager.deviceInfo(device);
      else if (action === "install") {
        output = await androidManager.install(device, ANDROID_DIR);
        output += `\n${await androidManager.configureReceiver(device, { server: publicServerOrigin(req), name: device.name })}`;
      }
      else if (action === "update") {
        output = await androidManager.install(device, ANDROID_DIR);
        output += `\n${await androidManager.configureReceiver(device, { server: publicServerOrigin(req), name: device.name })}`;
        output += `\n${await androidManager.launch(device)}`;
      } else if (action === "launch") output = await androidManager.launch(device);
      else if (action === "close") output = await androidManager.close(device);
      else if (action === "enable-auto-launch") {
        device.autoLaunch = true;
        output = await androidManager.setAutoLaunch(device, true);
      } else if (action === "disable-auto-launch") {
        device.autoLaunch = false;
        output = await androidManager.setAutoLaunch(device, false);
      } else if (action === "uninstall") output = await androidManager.uninstall(device);
      else return sendApi(res, url, 400, { error: "Acao Android TV invalida", code: "DVS_ANDROID_ACTION_INVALID" });
      const fresh = loadDb();
      const saved = fresh.androidDevices.find((item) => item.id === device.id);
      if (saved) {
        saved.lastAction = action;
        saved.lastResult = output;
        saved.lastError = "";
        saved.autoLaunch = device.autoLaunch;
        saved.updatedAt = now();
        saveDb(fresh);
      }
      broadcastAdmin();
      sendApi(res, url, 200, { ok: true, output });
    } catch (error) {
      const fresh = loadDb();
      const saved = fresh.androidDevices.find((item) => item.id === device.id);
      if (saved) {
        saved.lastAction = action;
        saved.lastError = error.message;
        saved.updatedAt = now();
        saveDb(fresh);
      }
      broadcastAdmin();
      sendApi(res, url, 502, { error: error.message, code: "DVS_ANDROID_ACTION_FAILED" });
    }
    return;
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "android" && parts[2] === "devices" && parts[3]) {
    const device = db.androidDevices.find((item) => item.id === parts[3]);
    if (!device) return sendApi(res, url, 404, { error: "Dispositivo Android TV nao encontrado", code: "DVS_ANDROID_NOT_FOUND" });
    await androidManager.disconnect(device);
    const fresh = loadDb();
    fresh.androidDevices = fresh.androidDevices.filter((item) => item.id !== device.id);
    saveDb(fresh);
    broadcastAdmin();
    sendApi(res, url, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/android/status") {
    const status = await androidManager.cliStatus();
    const pkg = androidManager.latestPackage(ANDROID_DIR);
    sendApi(res, url, 200, { ...status, package: pkg ? path.basename(pkg.path) : "", appId: androidManager.APP_ID });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/media/upload") {
    const originalName = path.basename(String(url.searchParams.get("name") || "video.mp4").trim()).slice(0, 240);
    const extension = path.extname(originalName).toLowerCase();
    const allowed = { ".mp4": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg" };
    if (!allowed[extension]) return sendJson(res, 400, { error: "Formato invalido. Use MP4, WebM ou OGV. Para TVs LG, prefira MP4 H.264." });
    const mediaId = id("media");
    const storedName = `${mediaId}${extension}`;
    const targetPath = path.join(MEDIA_DIR, storedName);
    try {
      const size = await readUpload(req, targetPath, MAX_UPLOAD_BYTES);
      if (!await validateMediaFile(targetPath, extension)) {
        throw Object.assign(new Error("O conteudo do arquivo nao corresponde ao formato informado"), { code: "DVS_MEDIA_SIGNATURE_INVALID" });
      }
      const item = {
        id: mediaId,
        name: String(url.searchParams.get("title") || path.basename(originalName, extension)).trim().slice(0, 160),
        fileName: originalName,
        storedName,
        mime: allowed[extension],
        size,
        createdAt: now()
      };
      const fresh = loadDb();
      fresh.media.push(item);
      logEvent(fresh, "media_uploaded", `Video enviado: ${item.name}`, { mediaId: item.id, size });
      saveDb(fresh);
      broadcastAdmin();
      sendJson(res, 200, { media: { ...item, storedName: undefined, url: `/media/${item.id}` } });
    } catch (err) {
      if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "media" && parts[2]) {
    const item = db.media.find((media) => media.id === parts[2]);
    if (!item) return sendJson(res, 404, { error: "Video nao encontrado" });
    const targetPath = path.join(MEDIA_DIR, item.storedName);
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    db.media = db.media.filter((media) => media.id !== item.id);
    db.playlists.forEach((playlist) => { playlist.items = playlist.items.filter((mediaId) => mediaId !== item.id); });
    db.panels.forEach((panel) => { if (panel.mediaId === item.id) panel.mediaId = ""; });
    saveDb(db);
    broadcastAdmin();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/playlists") {
    const body = await readBody(req);
    const items = Array.isArray(body.items) ? body.items.filter((mediaId) => db.media.some((media) => media.id === mediaId)) : [];
    if (!items.length) return sendJson(res, 400, { error: "Selecione pelo menos um video" });
    const existingPlaylist = body.id ? db.playlists.find((item) => item.id === body.id) : null;
    const playlist = {
      ...(existingPlaylist || {}),
      id: existingPlaylist ? existingPlaylist.id : id("playlist"),
      name: String(body.name || "Lista de reproducao").trim().slice(0, 120),
      items,
      loop: body.loop !== false,
      updatedAt: now()
    };
    const index = db.playlists.findIndex((item) => item.id === playlist.id);
    if (index >= 0) db.playlists[index] = playlist;
    else db.playlists.push(playlist);
    let panel;
    let assignment;
    try {
      panel = ensurePlaylistPlaybackPanel(db, playlist, "playlist");
      assignment = assignPanelToTv(db, String(body.targetTvId || ""), panel);
    } catch (err) {
      return sendJson(res, err.message.includes("Limite") ? 409 : 400, { error: err.message });
    }
    logEvent(db, "playlist_saved", `Playlist salva: ${playlist.name}`, { playlistId: playlist.id, panelId: panel.id, tvId: assignment?.tv.id || "" });
    saveDb(db);
    const delivered = assignment ? pushCommand(assignment.tv.id, assignment.command) : false;
    broadcastAdmin();
    sendJson(res, 200, { playlist, panel: publicPanel(panel), assignedTvId: assignment?.tv.id || "", delivered });
    return;
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "playlists" && parts[2]) {
    const playlist = db.playlists.find((item) => item.id === parts[2]);
    if (!playlist) return sendJson(res, 404, { error: "Playlist nao encontrada" });
    const linkedPanel = linkedPlaybackPanel(db, playlist, "playlist");
    db.playlists = db.playlists.filter((item) => item.id !== parts[2]);
    if (linkedPanel && linkedPanel.managedBy === "playlist") {
      db.panels = db.panels.filter((panel) => panel.id !== linkedPanel.id);
      db.tvs.forEach((tv) => {
        if (tv.currentPanelId === linkedPanel.id) tv.currentPanelId = "";
        if (tv.pendingCommand?.panelId === linkedPanel.id) tv.pendingCommand = null;
      });
    } else {
      db.panels.forEach((panel) => { if (panel.playlistId === parts[2]) panel.playlistId = ""; });
    }
    saveDb(db);
    broadcastAdmin();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/panel-playlists") {
    const body = await readBody(req);
    const existingPlaylist = body.id ? db.panelPlaylists.find((item) => item.id === body.id) : null;
    const items = Array.isArray(body.items) ? body.items.map((item) => ({
      panelId: String(item.panelId || ""),
      durationSeconds: Math.max(5, Math.min(86400, Number(item.durationSeconds || 30)))
    })).filter((item) => db.panels.some((panel) => panel.id === item.panelId && panel.mode !== "panel_playlist")) : [];
    if (!items.length) return sendJson(res, 400, { error: "Selecione pelo menos um painel para a playlist" });
    const playlist = {
      ...(existingPlaylist || {}),
      id: existingPlaylist ? existingPlaylist.id : id("panel_playlist"),
      name: String(body.name || "Playlist de paineis").trim().slice(0, 120),
      items,
      loop: body.loop !== false,
      updatedAt: now()
    };
    const index = db.panelPlaylists.findIndex((item) => item.id === playlist.id);
    if (index >= 0) db.panelPlaylists[index] = playlist;
    else db.panelPlaylists.push(playlist);
    let panel;
    let assignment;
    try {
      panel = ensurePlaylistPlaybackPanel(db, playlist, "panel_playlist");
      assignment = assignPanelToTv(db, String(body.targetTvId || ""), panel);
    } catch (err) {
      return sendJson(res, err.message.includes("Limite") ? 409 : 400, { error: err.message });
    }
    logEvent(db, "panel_playlist_saved", `Playlist de paineis salva: ${playlist.name}`, { playlistId: playlist.id, panelId: panel.id, tvId: assignment?.tv.id || "" });
    saveDb(db);
    const delivered = assignment ? pushCommand(assignment.tv.id, assignment.command) : false;
    broadcastAdmin();
    sendJson(res, 200, { playlist, panel: publicPanel(panel), assignedTvId: assignment?.tv.id || "", delivered });
    return;
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "panel-playlists" && parts[2]) {
    const playlist = db.panelPlaylists.find((item) => item.id === parts[2]);
    if (!playlist) return sendJson(res, 404, { error: "Playlist de paineis nao encontrada" });
    const linkedPanel = linkedPlaybackPanel(db, playlist, "panel_playlist");
    db.panelPlaylists = db.panelPlaylists.filter((item) => item.id !== parts[2]);
    if (linkedPanel && linkedPanel.managedBy === "playlist") {
      db.panels = db.panels.filter((panel) => panel.id !== linkedPanel.id);
      db.tvs.forEach((tv) => {
        if (tv.currentPanelId === linkedPanel.id) tv.currentPanelId = "";
        if (tv.pendingCommand?.panelId === linkedPanel.id) tv.pendingCommand = null;
      });
    } else {
      db.panels.forEach((panel) => { if (panel.panelPlaylistId === parts[2]) panel.panelPlaylistId = ""; });
    }
    saveDb(db);
    broadcastAdmin();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "panels" && parts[2] && parts[3] === "interact") {
    const body = await readBody(req);
    const panel = db.panels.find((item) => item.id === parts[2]);
    if (!panel) return sendJson(res, 404, { error: "Painel nao encontrado" });
    if (panel.mode !== "server_image") return sendJson(res, 400, { error: "A interacao requer renderizacao no servidor" });
    try {
      sendJson(res, 200, await interactWithPanel(panel, body));
    } catch (err) {
      sendJson(res, 502, { error: err.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/panels") {
    const body = await readBody(req);
    const requestedMode = String(body.mode || "direct");
    const existingPanel = body.id ? db.panels.find((item) => item.id === body.id) : null;
    if (sessionUser.role === "operator" && body.id) return sendJson(res, 403, { error: "Operador pode cadastrar novos paineis; edicao exige Tecnico ou Supervisor" });
    if (!existingPanel && db.panels.length >= MAX_PANELS) return sendJson(res, 409, { error: "Limite de paineis atingido", code: "DVS_PANEL_LIMIT_REACHED" });
    if (requestedMode === "playlist" && !db.playlists.some((playlist) => playlist.id === body.playlistId)) {
      return sendJson(res, 400, { error: "Lista de reproducao invalida" });
    }
    if (requestedMode === "panel_playlist" && !db.panelPlaylists.some((playlist) => playlist.id === body.panelPlaylistId)) {
      return sendJson(res, 400, { error: "Playlist de paineis invalida" });
    }
    if (requestedMode === "video" && !db.media.some((media) => media.id === body.mediaId)) {
      return sendJson(res, 400, { error: "Video invalido" });
    }
    if (requestedMode === "rtsp" && !/^rtsps?:\/\//i.test(String(body.url || "")) && !(existingPanel && existingPanel.sourceSecret)) {
      return sendJson(res, 400, { error: "Informe uma URL RTSP valida" });
    }
    if (!["playlist", "panel_playlist", "video", "rtsp"].includes(requestedMode) && !validateUrl(body.url)) return sendJson(res, 400, { error: "URL invalida" });
    if (["width", "height", "zoom"].some(key => body[key] !== undefined && !Number.isFinite(Number(body[key])))) return sendJson(res, 400, { error: "Dimensoes ou zoom invalidos" });
    const oldAuth = existingPanel ? decryptSecret(existingPanel.authSecret) : null;
    const authBody = body.auth || {};
    const usesWebAuth = Boolean(authBody.enabled && !["playlist", "video", "rtsp"].includes(requestedMode));
    let authSecret = existingPanel && existingPanel.authSecret || "";
    if (usesWebAuth) {
      authSecret = encryptSecret({
        enabled: true,
        username: String(authBody.username || oldAuth && oldAuth.username || "").slice(0, 256),
        password: String(authBody.password || oldAuth && oldAuth.password || "").slice(0, 1024),
        usernameSelector: String(authBody.usernameSelector || "").slice(0, 500),
        passwordSelector: String(authBody.passwordSelector || "").slice(0, 500),
        submitSelector: String(authBody.submitSelector || "").slice(0, 500)
      });
    } else if (body.auth) {
      authSecret = "";
    }
    let sourceSecret = existingPanel && existingPanel.sourceSecret || "";
    if (requestedMode === "rtsp" && body.url) sourceSecret = encryptSecret({ url: String(body.url).trim() });
    const panel = {
      id: existingPanel ? existingPanel.id : id("panel"),
      name: String(body.name || "Painel").trim().slice(0, 120),
      url: ["playlist", "panel_playlist", "video", "rtsp"].includes(requestedMode) ? "" : String(body.url || "").trim(),
      mode: usesWebAuth ? "server_image" : ["server_image", "legacy_videowall", "playlist", "panel_playlist", "video", "rtsp"].includes(requestedMode) ? requestedMode : "direct",
      playlistId: requestedMode === "playlist" ? String(body.playlistId || "") : "",
      panelPlaylistId: requestedMode === "panel_playlist" ? String(body.panelPlaylistId || "") : "",
      mediaId: requestedMode === "video" ? String(body.mediaId || "") : "",
      loop: requestedMode === "video" ? body.loop !== false : true,
      sourceSecret: requestedMode === "rtsp" ? sourceSecret : "",
      refreshSeconds: 1,
      width: Math.max(320, Math.min(7680, Number(body.width || 1920))),
      height: Math.max(180, Math.min(4320, Number(body.height || 1080))),
      renderDelayMs: 100,
      zoom: Math.max(0.25, Math.min(3, Number(body.zoom || 1))),
      authSecret,
      updatedAt: now()
    };
    const index = db.panels.findIndex((item) => item.id === panel.id);
    if (index >= 0) db.panels[index] = { ...db.panels[index], ...panel };
    else db.panels.push(panel);
    logEvent(db, "panel_saved", `Painel salvo: ${panel.name}`, { panelId: panel.id });
    saveDb(db);
    broadcastAdmin();
    sendJson(res, 200, { panel: publicPanel(panel) });
    return;
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "panels" && parts[2]) {
    const page = renderer.pages.get(parts[2]);
    renderer.pages.delete(parts[2]);
    renderer.pageMeta.delete(parts[2]);
    if (page && !page.isClosed()) await page.close().catch(() => {});
    const fresh = loadDb();
    mediaManager.stop(parts[2]);
    captureState.delete(parts[2]);
    const capturePath = path.join(DATA_DIR, "captures", `${parts[2]}.jpg`);
    renderer.frameCache.delete(capturePath);
    fs.rmSync(capturePath, { force: true });
    fresh.panels = fresh.panels.filter((item) => item.id !== parts[2]);
    fresh.playlists.forEach((playlist) => { if (playlist.panelId === parts[2]) playlist.panelId = ""; });
    fresh.panelPlaylists.forEach((playlist) => { if (playlist.panelId === parts[2]) playlist.panelId = ""; });
    fresh.tvs.forEach((tv) => {
      if (tv.currentPanelId === parts[2]) tv.currentPanelId = "";
      if (tv.pendingCommand?.panelId === parts[2]) tv.pendingCommand = null;
    });
    saveDb(fresh);
    broadcastAdmin();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/groups") {
    const body = await readBody(req);
    const existingGroup = body.id ? db.groups.find((item) => item.id === body.id) : null;
    const group = { id: existingGroup ? existingGroup.id : id("group"), name: String(body.name || "Grupo").trim().slice(0, 80) };
    const index = db.groups.findIndex((item) => item.id === group.id);
    if (index < 0 && db.groups.length >= MAX_GROUPS) return sendJson(res, 409, { error: "Limite de grupos atingido", code: "DVS_GROUP_LIMIT_REACHED" });
    if (index >= 0) db.groups[index] = group;
    else db.groups.push(group);
    saveDb(db);
    broadcastAdmin();
    sendJson(res, 200, { group });
    return;
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "groups" && parts[2]) {
    if (parts[2] === "default") return sendJson(res, 400, { error: "O grupo Principal nao pode ser removido" });
    db.groups = db.groups.filter((item) => item.id !== parts[2]);
    db.tvs.forEach((tv) => {
      if (tv.groupId === parts[2]) tv.groupId = "default";
    });
    saveDb(db);
    broadcastAdmin();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "tvs" && parts[2] && parts[3] === "command") {
    const body = await readBody(req);
    const tv = db.tvs.find((item) => item.id === parts[2]);
    if (!tv) return sendJson(res, 404, { error: "TV nao encontrada" });
    const commandType = String(body.type || "");
    if (!["setPanel", "setZoom", "reload", "identify"].includes(commandType)) return sendJson(res, 400, { error: "Comando de TV invalido", code: "DVS_TV_COMMAND_INVALID" });
    let commandPayload = { type: commandType };
    if (body.type === "setPanel") {
      const panel = db.panels.find((item) => item.id === body.panelId);
      if (!panel) return sendJson(res, 400, { error: "Painel nao encontrado" });
      tv.currentPanelId = panel.id;
      tv.playbackMode = panel.mode || "direct";
      commandPayload = { type: commandType, panelId: panel.id, playbackMode: tv.playbackMode };
    }
    if (body.type === "setZoom") {
      const zoom = Number(body.zoom);
      if (!Number.isFinite(zoom)) return sendJson(res, 400, { error: "Zoom invalido", code: "DVS_TV_ZOOM_INVALID" });
      tv.zoom = Math.max(0.5, Math.min(2, zoom));
      commandPayload = { type: commandType, zoom: tv.zoom };
    }
    const command = { ...commandPayload, id: id("cmd"), at: now() };
    if (command.type === "setPanel") command.tvZoom = Number(tv.zoom || 1);
    if (command.type === "setPanel") tv.currentCommandId = command.id;
    tv.pendingCommand = command;
    logEvent(db, "command", `Comando enviado para ${tv.name}`, { tvId: tv.id, type: body.type });
    saveDb(db);
    const delivered = pushCommand(tv.id, command);
    broadcastAdmin();
    sendJson(res, 200, { ok: true, delivered, command });
    return;
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "tvs" && parts[2]) {
    db.tvs = db.tvs.filter((item) => item.id !== parts[2]);
    saveDb(db);
    broadcastAdmin();
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "Rota nao encontrada" });
}

async function handlePanelImage(req, res, panelId) {
  const db = loadDb();
  const panel = db.panels.find((item) => item.id === panelId);
  if (!panel) return sendJson(res, 404, { error: "Painel nao encontrado" });
  const filePath = await maybeCapturePanel(panel);
  if (!filePath || !fs.existsSync(filePath)) {
    const status = captureState.get(panel.id);
    return sendJson(res, 503, {
      error: "Renderizacao no servidor indisponivel",
      detail: status && status.error ? status.error : "",
      hint: "Instale/atualize o navegador do Playwright com: npx playwright install chromium"
    });
  }
  serveFile(res, filePath);
}

async function handlePanelMjpeg(req, res, panelId) {
  const db = loadDb();
  let panel = db.panels.find((item) => item.id === panelId);
  if (!panel || panel.mode !== "server_image") return sendJson(res, 404, { error: "Painel renderizado nao encontrado" });
  const ip = clientIp(req);
  const totalStreams = Array.from(renderer.activeStreams.values()).reduce((sum, count) => sum + count, 0);
  const ipStreams = activeMjpegByIp.get(ip) || 0;
  if (totalStreams >= MAX_MJPEG_STREAMS || ipStreams >= MAX_MJPEG_PER_IP) {
    res.setHeader("retry-after", "5");
    return sendJson(res, 429, { error: "Limite de fluxos de imagem atingido", code: "DVS_STREAM_LIMIT_REACHED" });
  }
  res.writeHead(200, {
    "content-type": "multipart/x-mixed-replace; boundary=dvsframe",
    "cache-control": "no-store, no-cache, must-revalidate",
    connection: "keep-alive"
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  if (res.socket) res.socket.setNoDelay(true);
  let closed = false;
  let lastPanelRefresh = Date.now();
  let lifetimeTimer = null;
  renderer.activeStreams.set(panelId, (renderer.activeStreams.get(panelId) || 0) + 1);
  activeMjpegByIp.set(ip, ipStreams + 1);
  function closeStream() {
    if (closed) return;
    closed = true;
    const count = Math.max(0, (renderer.activeStreams.get(panelId) || 1) - 1);
    if (count) renderer.activeStreams.set(panelId, count);
    else renderer.activeStreams.delete(panelId);
    const remainingForIp = Math.max(0, (activeMjpegByIp.get(ip) || 1) - 1);
    if (remainingForIp) activeMjpegByIp.set(ip, remainingForIp);
    else activeMjpegByIp.delete(ip);
    if (lifetimeTimer) clearTimeout(lifetimeTimer);
  }
  req.on("close", closeStream);
  res.on("close", closeStream);
  res.on("error", closeStream);
  lifetimeTimer = setTimeout(() => {
    closeStream();
    if (!res.destroyed) res.destroy();
  }, MJPEG_MAX_AGE_MS);

  function waitForDrain() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (drained) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        res.removeListener("drain", onDrain);
        res.removeListener("close", onClose);
        resolve(drained);
      };
      const onDrain = () => finish(true);
      const onClose = () => finish(false);
      const timer = setTimeout(() => finish(false), 5000);
      res.once("drain", onDrain);
      res.once("close", onClose);
    });
  }

  async function sendFrame() {
    if (closed || res.destroyed) return;
    try {
      if (Date.now() - lastPanelRefresh >= 5000) {
        panel = loadDb().panels.find((item) => item.id === panelId);
        lastPanelRefresh = Date.now();
      }
      if (!panel) {
        closeStream();
        return res.end();
      }
      const filePath = await maybeCapturePanel(panel);
      if (!closed && !res.destroyed && filePath && fs.existsSync(filePath)) {
        const image = frameBuffer(filePath);
        const header = Buffer.from(`--dvsframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${image.length}\r\n\r\n`);
        const frame = Buffer.concat([header, image, Buffer.from("\r\n")]);
        if (!res.write(frame) && !await waitForDrain()) {
          closeStream();
          if (!res.destroyed) res.destroy();
          return;
        }
      }
    } catch (_) {}
    if (!closed) setTimeout(sendFrame, Math.round(1000 / RENDER_FPS));
  }
  sendFrame();
}

function handleMediaFile(req, res, mediaId) {
  const db = loadDb();
  const item = db.media.find((media) => media.id === mediaId);
  if (!item) return sendJson(res, 404, { error: "Video nao encontrado" });
  const filePath = path.join(MEDIA_DIR, item.storedName);
  if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: "Arquivo de video ausente" });
  serveRangeFile(req, res, filePath, item.mime || "application/octet-stream");
}

async function ensureRtsp(panel) {
  const source = decryptSecret(panel.sourceSecret);
  if (!source || !/^rtsps?:\/\//i.test(source.url || "")) throw new Error("Fonte RTSP nao configurada");
  return mediaManager.startRtsp(panel.id, source.url, STREAM_DIR);
}

async function handleRtspStream(req, res, parts) {
  const panelId = parts[1];
  const fileName = parts[2] || "index.m3u8";
  if (!/^(index\.m3u8|segment\d+\.ts)$/.test(fileName)) return sendJson(res, 404, { error: "Segmento invalido" });
  const panel = loadDb().panels.find((item) => item.id === panelId && item.mode === "rtsp");
  if (!panel) return sendJson(res, 404, { error: "Fonte RTSP nao encontrada" });
  const stream = await ensureRtsp(panel);
  const filePath = path.join(stream.directory, fileName);
  if (fileName === "index.m3u8" && !fs.existsSync(filePath)) await mediaManager.waitForFile(filePath, 10000);
  if (!fs.existsSync(filePath)) {
    return sendJson(res, 503, { error: "RTSP iniciando", detail: stream.error || stream.log || "Aguardando os primeiros segmentos" });
  }
  if (fileName === "index.m3u8") {
    const authQuery = `tvId=${encodeURIComponent(urlValue(req.url, "tvId"))}&token=${encodeURIComponent(urlValue(req.url, "token"))}`;
    const manifest = fs.readFileSync(filePath, "utf8").split(/\r?\n/).map((line) => {
      if (!line || line.startsWith("#")) return line;
      return `${line}?${authQuery}`;
    }).join("\n");
    res.writeHead(200, {
      "content-type": MIME[".m3u8"],
      "content-length": Buffer.byteLength(manifest),
      "cache-control": "no-store"
    });
    res.end(manifest);
    return;
  }
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    "content-type": MIME[path.extname(filePath)] || "application/octet-stream",
    "content-length": stat.size,
    "cache-control": fileName.endsWith(".m3u8") ? "no-store" : "public, max-age=10"
  });
  fs.createReadStream(filePath).pipe(res);
}

async function handlePanelPreview(req, res, panelId, url) {
  const db = loadDb();
  const panel = db.panels.find((item) => item.id === panelId);
  if (!panel) return sendJson(res, 404, { error: "Painel nao encontrado" });
  const ip = clientIp(req);
  const ipPreviews = activePreviewByIp.get(ip) || 0;
  if (ipPreviews >= 2) {
    res.setHeader("retry-after", "3");
    return sendJson(res, 429, { error: "Muitos previews simultaneos", code: "DVS_PREVIEW_LIMIT_REACHED" });
  }
  activePreviewByIp.set(ip, ipPreviews + 1);
  let previewFinished = false;
  const finishPreview = () => {
    if (previewFinished) return;
    previewFinished = true;
    const remaining = Math.max(0, (activePreviewByIp.get(ip) || 1) - 1);
    if (remaining) activePreviewByIp.set(ip, remaining);
    else activePreviewByIp.delete(ip);
  };
  res.on("close", finishPreview);
  res.on("error", finishPreview);
  try {
  if (panel.mode === "rtsp") {
    try {
      const stream = await ensureRtsp(panel);
      if (!fs.existsSync(stream.previewPath)) await mediaManager.waitForFile(stream.previewPath, 10000);
      if (!fs.existsSync(stream.previewPath)) return sendJson(res, 503, { error: "Preview RTSP iniciando", detail: stream.error || stream.log });
      return serveFile(res, stream.previewPath);
    } catch (err) {
      return sendJson(res, 503, { error: "Preview RTSP indisponivel", detail: err.message });
    }
  }
  const targetPath = path.join(DATA_DIR, "captures", `${panel.id}.jpg`);
  const interactive = url && url.searchParams.get("interactive") === "1";
  let filePath = fs.existsSync(targetPath) && (interactive || Date.now() - fs.statSync(targetPath).mtimeMs < PREVIEW_CACHE_MS) ? targetPath : null;
  if (interactive && filePath) maybeCapturePanel(panel).catch(() => {});
  if (!filePath) {
    if (interactive) filePath = await maybeCapturePanel(panel);
    else {
      renderer.previewQueue = renderer.previewQueue.catch(() => {}).then(() => maybeCapturePanel(panel));
      filePath = await renderer.previewQueue;
    }
  }
  if (!filePath || !fs.existsSync(filePath)) {
    const status = captureState.get(panel.id);
    return sendJson(res, 503, {
      error: "Preview indisponivel",
      detail: status && status.error ? status.error : ""
    });
  }
  serveFile(res, filePath);
  } finally {
    finishPreview();
  }
}

async function handleLegacyWall(req, res, parts, url) {
  const db = loadDb();
  const panel = db.panels.find((item) => item.id === parts[1]);
  if (!panel) return sendJson(res, 404, { error: "Painel nao encontrado" });
  if (parts.length === 2) {
    const authQuery = `tvId=${encodeURIComponent(url.searchParams.get("tvId") || "")}`;
    const body = legacyWallHtml(panel.id, authQuery);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store"
    });
    res.end(body);
    return;
  }
  const base = videowallBase(panel.url);
  if (parts[2] === "layout") {
    const upstream = await fetch(`${base}/api/layout?t=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(10000) });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": "no-store"
    });
    res.end(text);
    return;
  }
  if (parts[2] === "stream" && parts[3]) {
    const cameraId = decodeURIComponent(parts[3]);
    const upstream = await fetch(`${base}/stream/${encodeURIComponent(cameraId)}?client=dvs-${panel.id}&t=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "image/jpeg",
      "cache-control": "no-store"
    });
    try {
      if (upstream.body && upstream.body.pipeTo) {
        const { Writable } = require("stream");
        await upstream.body.pipeTo(Writable.toWeb(res));
      } else {
        const buffer = Buffer.from(await upstream.arrayBuffer());
        res.end(buffer);
      }
    } catch (_) {
      if (!res.destroyed) res.destroy();
    }
    return;
  }
  sendJson(res, 404, { error: "Rota legacy nao encontrada" });
}

const requestHandler = async (req, res) => {
  try {
    applySecurityHeaders(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204, { allow: "GET, HEAD, POST, PATCH, DELETE, OPTIONS" });
      res.end();
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (REQUIRE_TLS && !isSecureRequest(req) && url.pathname !== "/api/health") {
      sendJson(res, 426, { error: "HTTPS obrigatorio neste servidor", code: "DVS_TLS_REQUIRED" });
      return;
    }
    const adminSensitive = url.pathname === "/" || url.pathname === "/admin" ||
      url.pathname.startsWith("/api/") && !isTvApi(url) && !isDashboardReadOnlyApi(req, url);
    const remoteAdminRequiresTls = ADMIN_AUTH_ENABLED && !ALLOW_INSECURE_REMOTE_ADMIN && !isLoopbackRequest(req);
    if ((REQUIRE_ADMIN_TLS || remoteAdminRequiresTls) && adminSensitive && !isSecureRequest(req)) {
      sendJson(res, 426, { error: "HTTPS obrigatorio para administracao", code: "DVS_ADMIN_TLS_REQUIRED" });
      return;
    }
    const protectedPlayback = ["/panel-image/", "/panel-mjpeg/", "/panel-preview/", "/media/", "/stream/", "/legacy-wall/"]
      .some((prefix) => url.pathname.startsWith(prefix));
    if (protectedPlayback && !authorizePlayback(req, url)) {
      sendJson(res, 401, { error: "Acesso ao conteudo nao autorizado", code: "DVS_PLAYBACK_UNAUTHORIZED" });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    if (url.pathname.startsWith("/panel-image/")) {
      await handlePanelImage(req, res, url.pathname.split("/").pop());
      return;
    }
    if (url.pathname.startsWith("/panel-mjpeg/")) {
      await handlePanelMjpeg(req, res, url.pathname.split("/").pop());
      return;
    }
    if (url.pathname.startsWith("/panel-preview/")) {
      await handlePanelPreview(req, res, url.pathname.split("/").pop(), url);
      return;
    }
    if (url.pathname.startsWith("/media/")) {
      handleMediaFile(req, res, url.pathname.split("/").pop());
      return;
    }
    if (url.pathname.startsWith("/stream/")) {
      await handleRtspStream(req, res, url.pathname.split("/").filter(Boolean));
      return;
    }
    if (url.pathname.startsWith("/legacy-wall/")) {
      await handleLegacyWall(req, res, url.pathname.split("/").filter(Boolean), url);
      return;
    }
    if (url.pathname === "/" || url.pathname === "/admin") {
      res.setHeader("content-security-policy", "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-src http: https:; style-src 'self'; script-src 'self'");
      res.setHeader("x-frame-options", "SAMEORIGIN");
      if (ADMIN_AUTH_ENABLED && !isAuthed(req)) {
        serveFile(res, path.join(PUBLIC_DIR, "login.html"));
        return;
      }
      serveFile(res, path.join(PUBLIC_DIR, "admin", "index.html"));
      return;
    }
    if (url.pathname === "/dashboard") {
      res.setHeader("content-security-policy", "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; img-src 'self' data:; connect-src 'self'; style-src 'self'; script-src 'self'");
      res.setHeader("x-frame-options", "SAMEORIGIN");
      serveFile(res, path.join(PUBLIC_DIR, "dashboard", "index.html"));
      return;
    }
    if (url.pathname === "/receiver") {
      res.setHeader("content-security-policy", "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self' chrome-extension:; form-action 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-src http: https:; style-src 'self'; script-src 'self'");
      serveFile(res, path.join(PUBLIC_DIR, "receiver", "index.html"));
      return;
    }
    if (url.pathname === "/tv-app") {
      res.setHeader("content-security-policy", "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self' chrome-extension:; form-action 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-src http: https:; style-src 'self'; script-src 'self'");
      serveFile(res, path.join(PUBLIC_DIR, "receiver", "index.html"));
      return;
    }
    const staticPath = safeStaticPath(PUBLIC_DIR, url.pathname);
    if (!staticPath) return sendJson(res, 403, { error: "Caminho invalido" });
    serveFile(res, staticPath);
  } catch (err) {
    if (res.headersSent) {
      if (!res.destroyed) res.destroy();
      return;
    }
    const status = Number(err.statusCode || 500);
    console.error(`[request:${res.dvsRequestId || "unknown"}] ${req.method} ${redactUrl(req.url)}: ${err.stack || err.message}`);
    sendJson(res, status, { error: status >= 500 ? "Erro interno do servidor" : err.message, code: err.code || defaultErrorCode(status) });
  }
};

let server;
if (process.env.TLS_CERT_PATH && process.env.TLS_KEY_PATH) {
  const https = require("https");
  server = https.createServer({
    cert: fs.readFileSync(path.resolve(process.env.TLS_CERT_PATH)),
    key: fs.readFileSync(path.resolve(process.env.TLS_KEY_PATH))
  }, requestHandler);
} else {
  server = http.createServer(requestHandler);
}

server.headersTimeout = 15000;
server.requestTimeout = Math.max(30000, Number(process.env.REQUEST_TIMEOUT_MS || 30 * 60 * 1000));
server.keepAliveTimeout = 5000;
server.maxRequestsPerSocket = 1000;
server.maxConnections = Math.max(50, Number(process.env.MAX_CONNECTIONS || 1000));
server.on("connection", (socket) => {
  serverSockets.add(socket);
  socket.on("close", () => serverSockets.delete(socket));
});
server.on("clientError", (err, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

ensureData();
loadDb();
const renewingDevices = new Set();
const systemUpdatingDevices = new Set();
const autoLaunchDevices = new Map();
const tizenAutoLaunchDevices = new Map();
let automaticLaunchScanRunning = false;

function canConnect(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: Number(port || 9922) });
    let finished = false;
    const finish = (reachable) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs || 2500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function runAutomaticLaunches() {
  if (automaticLaunchScanRunning) return;
  automaticLaunchScanRunning = true;
  try {
  const db = loadDb();
  const devices = db.webosDevices.filter((device) => device.autoLaunch);
  const activeIds = new Set(devices.map((device) => device.id));
  for (const deviceId of autoLaunchDevices.keys()) {
    if (!activeIds.has(deviceId)) autoLaunchDevices.delete(deviceId);
  }

  for (const device of devices) {
    const tracker = autoLaunchDevices.get(device.id) || {
      onlineChecks: 0,
      offlineChecks: 0,
      launched: false,
      launching: false,
      retryAt: 0,
      lastAttemptAt: 0
    };
    autoLaunchDevices.set(device.id, tracker);
    const reachable = await canConnect(device.host, device.port, 2500);

    if (!reachable) {
      tracker.onlineChecks = 0;
      tracker.offlineChecks += 1;
      if (tracker.offlineChecks >= 2) tracker.launched = false;
      if (device.powerState !== "offline" && tracker.offlineChecks >= 2) {
        const fresh = loadDb();
        const saved = fresh.webosDevices.find((item) => item.id === device.id);
        if (saved) {
          saved.powerState = "offline";
          saved.updatedAt = now();
          saveDb(fresh);
        }
        broadcastAdmin();
      }
      continue;
    }

    tracker.offlineChecks = 0;
    tracker.onlineChecks += 1;
    if (device.powerState !== "online" && tracker.onlineChecks >= 2) {
      const fresh = loadDb();
      const saved = fresh.webosDevices.find((item) => item.id === device.id);
      if (saved) {
        saved.powerState = "online";
        saved.updatedAt = now();
        saveDb(fresh);
      }
      broadcastAdmin();
    }
    const linkedTv = device.linkedTvId ? db.tvs.find((tv) => tv.id === device.linkedTvId) : null;
    const receiverConfirmed = linkedTv && getTvStatus(linkedTv) === "online";
    if (tracker.launched && receiverConfirmed) continue;
    if (tracker.launched && Date.now() - tracker.lastAttemptAt < 60000) continue;
    if (tracker.onlineChecks < 2 || tracker.launching || Date.now() < tracker.retryAt) continue;

    tracker.launching = true;
    tracker.lastAttemptAt = Date.now();
    try {
      const output = await webosManager.launch(device);
      tracker.launched = Boolean(receiverConfirmed || !device.linkedTvId);
      const fresh = loadDb();
      const saved = fresh.webosDevices.find((item) => item.id === device.id);
      if (saved) {
        saved.powerState = "online";
        saved.lastAction = "auto-launch";
        saved.lastResult = device.linkedTvId && !receiverConfirmed
          ? `${output}\nAguardando confirmacao do receiver; uma nova tentativa ocorrera automaticamente.`
          : output;
        saved.lastError = "";
        saved.lastAutoLaunchAt = now();
        saved.updatedAt = now();
        logEvent(fresh, "webos_auto_launch", `DVS Receiver iniciado automaticamente em ${saved.name}`, { deviceId: saved.id });
        saveDb(fresh);
      }
      broadcastAdmin();
    } catch (err) {
      tracker.launched = false;
      tracker.retryAt = Date.now() + 30000;
      const fresh = loadDb();
      const saved = fresh.webosDevices.find((item) => item.id === device.id);
      if (saved) {
        saved.lastAction = "auto-launch";
        saved.lastError = err.message;
        saved.updatedAt = now();
        saveDb(fresh);
      }
      broadcastAdmin();
    } finally {
      tracker.launching = false;
    }
  }
  } finally {
    automaticLaunchScanRunning = false;
  }
}

async function runAutomaticTizenLaunches() {
  const db = loadDb();
  const devices = db.tizenDevices.filter((device) => device.autoLaunch);
  const activeIds = new Set(devices.map((device) => device.id));
  for (const deviceId of tizenAutoLaunchDevices.keys()) {
    if (!activeIds.has(deviceId)) tizenAutoLaunchDevices.delete(deviceId);
  }
  for (const device of devices) {
    const tracker = tizenAutoLaunchDevices.get(device.id) || { online: false, launched: false, retryAt: 0 };
    tizenAutoLaunchDevices.set(device.id, tracker);
    const reachable = await canConnect(device.host, device.port || 26101, 2500);
    if (!reachable) {
      tracker.online = false;
      tracker.launched = false;
      continue;
    }
    if (!tracker.online) tracker.launched = false;
    tracker.online = true;
    if (tracker.launched || Date.now() < tracker.retryAt) continue;
    try {
      const output = await tizenManager.launch(device);
      tracker.launched = true;
      const fresh = loadDb();
      const saved = fresh.tizenDevices.find((item) => item.id === device.id);
      if (saved) {
        saved.lastAction = "auto-launch";
        saved.lastResult = output;
        saved.lastError = "";
        saved.updatedAt = now();
        logEvent(fresh, "tizen_auto_launch", `DVS Receiver iniciado automaticamente em ${saved.name}`, { deviceId: saved.id });
        saveDb(fresh);
      }
      broadcastAdmin();
    } catch (error) {
      tracker.retryAt = Date.now() + 60000;
      const fresh = loadDb();
      const saved = fresh.tizenDevices.find((item) => item.id === device.id);
      if (saved) {
        saved.lastAction = "auto-launch";
        saved.lastError = error.message;
        saved.updatedAt = now();
        saveDb(fresh);
      }
      broadcastAdmin();
    }
  }
}

async function cleanupIdleRendererPages() {
  const cutoff = Date.now() - RENDER_IDLE_MS;
  for (const [panelId, page] of renderer.pages.entries()) {
    const meta = renderer.pageMeta.get(panelId) || {};
    if (renderer.activeStreams.has(panelId) || renderer.pending.has(panelId) || Number(meta.lastAccess || meta.capturedAt || 0) > cutoff) continue;
    renderer.pages.delete(panelId);
    renderer.pageMeta.delete(panelId);
    if (page && !page.isClosed()) await page.close().catch(() => {});
  }
}

setInterval(cleanupIdleRendererPages, 10000).unref();

async function runAutomaticRenewals() {
  const db = loadDb();
  const due = db.webosDevices.filter((device) => {
    if (!device.autoRenew || renewingDevices.has(device.id)) return false;
    const last = device.lastRenewedAt ? new Date(device.lastRenewedAt).getTime() : 0;
    return !last || Date.now() - last >= 24 * 60 * 60 * 1000;
  });
  for (const device of due) {
    renewingDevices.add(device.id);
    try {
      const result = await webosManager.renewDeveloperMode(device);
      const fresh = loadDb();
      const saved = fresh.webosDevices.find((item) => item.id === device.id);
      if (saved) {
        saved.lastAction = "auto-renew";
        saved.lastResult = result;
        saved.lastError = "";
        saved.lastRenewedAt = now();
        saveDb(fresh);
      }
    } catch (err) {
      const fresh = loadDb();
      const saved = fresh.webosDevices.find((item) => item.id === device.id);
      if (saved) {
        saved.lastAction = "auto-renew";
        saved.lastError = err.message;
        saveDb(fresh);
      }
    } finally {
      renewingDevices.delete(device.id);
    }
  }
  if (due.length) broadcastAdmin();
}

async function runScheduledSystemUpdates() {
  const db = loadDb();
  const due = db.webosDevices.filter((device) => {
    if (!device.scheduledSystemUpdateAt || systemUpdatingDevices.has(device.id)) return false;
    const scheduledAt = new Date(device.scheduledSystemUpdateAt).getTime();
    return Number.isFinite(scheduledAt) && scheduledAt <= Date.now();
  });
  for (const device of due) {
    systemUpdatingDevices.add(device.id);
    try {
      const result = await webosManager.startSystemUpdate(device);
      const fresh = loadDb();
      const saved = fresh.webosDevices.find((item) => item.id === device.id);
      if (saved) {
        saved.lastAction = "scheduled-system-update";
        saved.lastResult = result;
        saved.lastError = "";
        saved.scheduledSystemUpdateAt = "";
        saved.updatedAt = now();
        logEvent(fresh, "webos_system_update", `Atualizacao de sistema enviada para ${saved.name}`, { deviceId: saved.id });
        saveDb(fresh);
      }
    } catch (err) {
      const fresh = loadDb();
      const saved = fresh.webosDevices.find((item) => item.id === device.id);
      if (saved) {
        saved.lastAction = "scheduled-system-update";
        saved.lastError = err.message;
        saved.updatedAt = now();
        saveDb(fresh);
      }
    } finally {
      systemUpdatingDevices.delete(device.id);
    }
  }
  if (due.length) broadcastAdmin();
}

refreshSystemMetrics().catch(() => {});
setInterval(() => { refreshSystemMetrics().then(broadcastAdmin).catch(() => {}); }, 5000).unref();
setTimeout(runAutomaticRenewals, 30000);
setInterval(runAutomaticRenewals, 60 * 60 * 1000);
setTimeout(runScheduledSystemUpdates, 15000).unref();
setInterval(runScheduledSystemUpdates, 60 * 1000).unref();
setTimeout(runAutomaticLaunches, 3000).unref();
setInterval(runAutomaticLaunches, 10000).unref();
setTimeout(runAutomaticTizenLaunches, 5000).unref();
setInterval(runAutomaticTizenLaunches, 10000).unref();
setTimeout(backupDatabase, 60000).unref();
setInterval(backupDatabase, 6 * 60 * 60 * 1000).unref();

setInterval(() => {
  for (const [key, client] of sseClients.entries()) {
    if (!writeSse(client, `: keepalive ${Date.now()}\n\n`) && (client.destroyed || client.writableEnded)) {
      sseClients.delete(key);
    }
  }
}, 15000).unref();

setInterval(() => {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  for (const [token, session] of sessions.entries()) {
    if (session.at < cutoff) sessions.delete(token);
  }
  const loginCutoff = Date.now() - 10 * 60 * 1000;
  for (const [ip, attempt] of loginAttempts.entries()) {
    if (attempt.blockedUntil < Date.now() && !attempt.failures.some((at) => at > loginCutoff)) loginAttempts.delete(ip);
  }
}, 10 * 60 * 1000).unref();

if (process.send) {
  setInterval(() => {
    try {
      process.send({
        type: "dvs-heartbeat",
        at: Date.now(),
        memory: process.memoryUsage().rss,
        eventLoopP99Ms: Math.round(eventLoopDelay.percentile(99) / 1e6),
        sockets: serverSockets.size
      });
    } catch (_) {}
  }, 2000).unref();
  process.on("disconnect", shutdown);
}

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`A porta ${PORT} ja esta em uso. Encerre a instancia anterior ou defina outra porta com PORT.`);
    process.exit(1);
  }
  console.error(err);
});
async function bootstrap() {
  try {
    await initializeDatabase();
    server.listen(PORT, HOST, () => {
      const protocol = process.env.TLS_CERT_PATH && process.env.TLS_KEY_PATH ? "https" : "http";
      console.log(`DVS Controller rodando em ${protocol}://localhost:${PORT}`);
      console.log(`Painel admin: ${protocol}://localhost:${PORT}/admin`);
      console.log(`Cliente TV:   ${protocol}://localhost:${PORT}/receiver`);
    });
  } catch (error) {
    console.error(`[database] Falha ao inicializar PostgreSQL: ${error.stack || error.message}`);
    process.exit(1);
  }
}

bootstrap();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  mediaManager.stopAll();
  for (const client of sseClients.values()) client.end();
  const forceTimer = setTimeout(() => {
    for (const socket of serverSockets) socket.destroy();
  }, 2500);
  forceTimer.unref();
  const closeServer = new Promise((resolve) => server.close(resolve));
  if (renderer.browser) await Promise.race([
    renderer.browser.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 2000))
  ]);
  await flushDb().catch((err) => console.error(`[database] Falha no flush final: ${err.message}`));
  if (postgresStore) await postgresStore.close().catch((err) => console.error(`[database] Falha ao encerrar pool: ${err.message}`));
  await Promise.race([closeServer, new Promise((resolve) => setTimeout(resolve, 3500))]);
  clearTimeout(forceTimer);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", (err) => {
  console.error(`[fatal] Promise rejeitada sem tratamento: ${err && err.stack || err}`);
  shutdown();
});
process.on("uncaughtException", (err) => {
  console.error(`[fatal] Excecao nao tratada: ${err.stack || err.message}`);
  shutdown();
});
