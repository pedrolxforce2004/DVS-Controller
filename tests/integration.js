const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const port = 32000 + Math.floor(Math.random() * 1000);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dvs-test-"));
const baseUrl = `http://127.0.0.1:${port}`;
let output = "";
const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
  cwd: path.join(__dirname, ".."),
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DVS_DATA_DIR: dataDir, DVS_TIZEN_SDK_LINK: path.join(dataDir, "TizenSdk"), DVS_ENABLE_ADMIN_AUTH: "1" },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"]
});
server.stdout.on("data", (chunk) => { output += chunk.toString(); });
server.stderr.on("data", (chunk) => { output += chunk.toString(); });

async function request(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch (_) { body = { text }; }
  return { response, body };
}

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const result = await request("/api/health");
      if (result.response.status === 200) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Servidor de teste nao iniciou.\n${output}`);
}

async function run() {
  await waitForServer();

  let result = await request("/api/state");
  assert.equal(result.response.status, 200);
  assert.equal(Array.isArray(result.body.panels), true);

  result = await request("/api/groups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Sem login" })
  });
  assert.equal(result.response.status, 401);
  assert.equal(result.body.code, "DVS_AUTH_REQUIRED");

  result = await request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://evil.invalid" },
    body: JSON.stringify({ user: "admin", password: "admin" })
  });
  assert.equal(result.response.status, 403);
  assert.equal(result.body.code, "DVS_CSRF_ORIGIN_REJECTED");

  result = await request("/panel-preview/panel_inexistente");
  assert.equal(result.response.status, 401);
  assert.equal(result.body.code, "DVS_PLAYBACK_UNAUTHORIZED");

  result = await request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: "admin", password: "admin" })
  });
  assert.equal(result.response.status, 200);
  let cookie = String(result.response.headers.get("set-cookie") || "").split(";")[0];
  assert(cookie.startsWith("dvs_session="));

  result = await request("/api/me", { headers: { cookie } });
  assert.equal(result.response.status, 200);
  let adminHeaders = { cookie, "content-type": "application/json", origin: baseUrl, "x-dvs-csrf": result.body.csrfToken };
  result = await request("/admin", { headers: { cookie } });
  assert.equal(result.response.status, 200);
  assert(result.response.headers.get("content-security-policy"));
  assert.equal(result.response.headers.get("x-content-type-options"), "nosniff");

  result = await request("/tv-app?name=Simulator&platform=Samsung%20Tizen&launcherVersion=0.6.9");
  assert.equal(result.response.status, 200);
  assert.match(result.response.headers.get("content-security-policy"), /frame-ancestors 'self' chrome-extension:/);

  result = await request("/api/tizen/status", { headers: { cookie } });
  assert.equal(result.response.status, 403);
  assert.equal(result.body.code, "DVS_AUTH_PASSWORD_CHANGE_REQUIRED");

  result = await request("/api/change-password", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ currentPassword: "admin", newPassword: "123", confirmPassword: "123" })
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.code, "DVS_AUTH_WEAK_PASSWORD");

  result = await request("/api/change-password", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ currentPassword: "admin", newPassword: "Integration123!", confirmPassword: "Integration123!" })
  });
  assert.equal(result.response.status, 200);
  const renewedCookie = String(result.response.headers.get("set-cookie") || "").split(";")[0];
  assert(renewedCookie.startsWith("dvs_session="));
  assert.notEqual(renewedCookie, cookie);

  result = await request("/api/me", { headers: { cookie } });
  assert.equal(result.response.status, 401);
  cookie = renewedCookie;
  adminHeaders = { cookie, "content-type": "application/json", origin: baseUrl, "x-dvs-csrf": "" };

  result = await request("/api/me", { headers: { cookie } });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.mustChangePassword, false);
  assert.equal(result.body.role, "supervisor");
  adminHeaders["x-dvs-csrf"] = result.body.csrfToken;

  result = await request("/api/tizen/status", { headers: { cookie } });
  assert.equal(result.response.status, 200);
  assert.equal(typeof result.body.available, "boolean");
  assert.equal(result.body.appId, "DVSCTRL001.DVSReceiver");

  const localTizenSdk = path.join(__dirname, "..", "tools", "tizen-studio");
  if (fs.existsSync(localTizenSdk)) {
    result = await request("/api/tizen/sdk", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ path: localTizenSdk })
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.available, true);
  }

  result = await request("/api/groups", {
    method: "POST",
    headers: adminHeaders,
    body: "{json"
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.code, "DVS_INVALID_JSON");

  result = await request("/api/groups", {
    method: "POST",
    headers: { ...adminHeaders, origin: "http://evil.invalid" },
    body: JSON.stringify({ name: "Bloqueado" })
  });
  assert.equal(result.response.status, 403);
  assert.equal(result.body.code, "DVS_CSRF_ORIGIN_REJECTED");

  result = await request("/api/tv/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "TV Integracao", platform: "test" })
  });
  assert.equal(result.response.status, 200);
  const tv = result.body.tv;
  assert(tv.id && tv.token);
  const tvCookie = String(result.response.headers.get("set-cookie") || "").split(";")[0];

  result = await request("/api/tv/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: tv.id, token: "invalido", name: "TV Invasora" })
  });
  assert.equal(result.response.status, 401);
  assert.equal(result.body.code, "DVS_TV_TOKEN_INVALID");

  result = await request(`/api/tv/${encodeURIComponent(tv.id)}/state`, { headers: { "x-dvs-tv-token": tv.token } });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.tvs, undefined);
  assert.equal(result.body.webosDevices, undefined);
  assert.equal(result.body.panels.length, 0);

  const writes = [];
  for (let index = 0; index < 20; index += 1) {
    writes.push(request("/api/groups", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name: `Grupo ${index}` })
    }));
    writes.push(request(`/api/tv/${encodeURIComponent(tv.id)}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dvs-tv-token": tv.token },
      body: JSON.stringify({ currentPanelId: "", playbackMode: "direct", zoom: 1 })
    }));
  }
  const writeResults = await Promise.all(writes);
  assert(writeResults.every((item) => item.response.status === 200));

  result = await request("/api/state", { headers: { cookie } });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.groups.filter((group) => /^Grupo /.test(group.name)).length, 20);
  assert.equal(result.body.tvs[0].name, "TV Integracao");
  assert(Array.isArray(result.body.tizenDevices));

  const loadResults = await Promise.all(Array.from({ length: 200 }, () => request("/api/health")));
  assert(loadResults.every((item) => item.response.status === 200));

  result = await request("/api/diagnostics", { headers: { cookie } });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.database.error, "");

  result = await request("/api/users", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ username: "operador.teste", displayName: "Operador Teste", role: "operator", password: "Operator123!", mustChangePassword: false })
  });
  assert.equal(result.response.status, 201);
  const operatorId = result.body.user.id;

  result = await request("/api/users", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ username: "tecnico.teste", displayName: "Tecnico Teste", role: "technician", password: "Technician123!", mustChangePassword: true })
  });
  assert.equal(result.response.status, 201);
  const technicianId = result.body.user.id;

  result = await request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: "operador.teste", password: "Operator123!" })
  });
  assert.equal(result.response.status, 200);
  const operatorCookie = String(result.response.headers.get("set-cookie") || "").split(";")[0];
  result = await request("/api/me", { headers: { cookie: operatorCookie } });
  const operatorHeaders = { cookie: operatorCookie, "content-type": "application/json", origin: baseUrl, "x-dvs-csrf": result.body.csrfToken };

  result = await request("/api/panels", { method: "POST", headers: operatorHeaders, body: JSON.stringify({ name: "Painel do operador", url: "https://example.com", mode: "direct" }) });
  assert.equal(result.response.status, 200);
  const operatorPanel = result.body.panel.id;
  result = await request("/api/panels", { method: "POST", headers: operatorHeaders, body: JSON.stringify({ id: operatorPanel, name: "Edicao indevida", url: "https://example.com" }) });
  assert.equal(result.response.status, 403);
  result = await request(`/api/panels/${operatorPanel}`, { method: "DELETE", headers: operatorHeaders });
  assert.equal(result.response.status, 403);
  result = await request("/api/panels", { method: "POST", headers: operatorHeaders, body: JSON.stringify({ url: "javascript:alert(1)" }) });
  assert.equal(result.response.status, 400);
  result = await request("/api/panels", { method: "POST", headers: operatorHeaders, body: JSON.stringify({ url: "https://example.com", width: "invalid" }) });
  assert.equal(result.response.status, 400);

  result = await request("/api/groups", {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({ name: "Grupo indevido" })
  });
  assert.equal(result.response.status, 403);
  assert.equal(result.body.code, "DVS_AUTH_FORBIDDEN");

  result = await request(`/api/tvs/${encodeURIComponent(tv.id)}/command`, {
    method: "POST",
    headers: operatorHeaders,
    body: JSON.stringify({ type: "identify" })
  });
  assert.equal(result.response.status, 200);

  result = await request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: "tecnico.teste", password: "Technician123!" })
  });
  assert.equal(result.response.status, 200);
  const technicianCookie = String(result.response.headers.get("set-cookie") || "").split(";")[0];
  result = await request("/api/me", { headers: { cookie: technicianCookie } });
  const technicianCsrf = result.body.csrfToken;
  result = await request("/api/users", { headers: { cookie: technicianCookie } });
  assert.equal(result.response.status, 403);
  assert.equal(result.body.code, "DVS_AUTH_PASSWORD_CHANGE_REQUIRED");
  result = await request("/api/change-password", {
    method: "POST",
    headers: { cookie: technicianCookie, "content-type": "application/json", origin: baseUrl, "x-dvs-csrf": technicianCsrf },
    body: JSON.stringify({ currentPassword: "Technician123!", newPassword: "Technician456!", confirmPassword: "Technician456!" })
  });
  assert.equal(result.response.status, 200);
  const renewedTechnicianCookie = String(result.response.headers.get("set-cookie") || "").split(";")[0];
  result = await request("/api/users", { headers: { cookie: renewedTechnicianCookie } });
  assert.equal(result.response.status, 403);
  assert.equal(result.body.code, "DVS_AUTH_FORBIDDEN");

  result = await request(`/api/users/${encodeURIComponent(operatorId)}`, {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ displayName: "Operador Atualizado", role: "operator", enabled: true })
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.user.displayName, "Operador Atualizado");

  result = await request(`/api/users/${encodeURIComponent(technicianId)}`, { method: "DELETE", headers: adminHeaders });
  assert.equal(result.response.status, 200);

  const mp4Header = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00]);
  result = await request("/api/media/upload?name=video-teste.mp4&title=Video%20Avulso", {
    method: "POST",
    headers: { cookie, origin: baseUrl, "content-type": "video/mp4", "x-dvs-csrf": adminHeaders["x-dvs-csrf"] },
    body: mp4Header
  });
  assert.equal(result.response.status, 200);
  const mediaId = result.body.media.id;

  result = await request("/api/panels", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ name: "Video sem playlist", mode: "video", mediaId, loop: true, zoom: 1 })
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.panel.mode, "video");
  assert.equal(result.body.panel.mediaId, mediaId);
  assert.equal(result.body.panel.loop, true);

  result = await request("/api/playlists", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ name: "Playlist integrada", items: [mediaId], loop: true, targetTvId: tv.id })
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.playlist.items[0], mediaId);
  assert.equal(result.body.panel.mode, "playlist");
  assert.equal(result.body.panel.playlistId, result.body.playlist.id);
  assert.equal(result.body.assignedTvId, tv.id);
  const automaticPlaylistPanelId = result.body.panel.id;
  const automaticPlaylistId = result.body.playlist.id;

  result = await request("/api/playlists", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ id: automaticPlaylistId, name: "Playlist integrada atualizada", items: [mediaId], loop: false })
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.panel.id, automaticPlaylistPanelId);
  assert.equal(result.body.playlist.loop, false);

  result = await request("/api/state", { headers: { cookie } });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.playlists.find((playlist) => playlist.id === automaticPlaylistId).panelId, automaticPlaylistPanelId);
  assert.equal(result.body.tvs.find((item) => item.id === tv.id).currentPanelId, automaticPlaylistPanelId);
  assert.equal(result.body.panels.filter((panel) => panel.playlistId === automaticPlaylistId).length, 1);

  for (let index = 0; index < 5; index += 1) {
    await request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: "admin", password: "errada" })
    });
  }
  result = await request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: "admin", password: "errada" })
  });
  assert.equal(result.response.status, 429);
  assert.equal(result.body.code, "DVS_AUTH_RATE_LIMITED");

  await new Promise((resolve) => setTimeout(resolve, 250));
  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, "db.json"), "utf8"));
  assert.equal(persisted.groups.filter((group) => /^Grupo /.test(group.name)).length, 20);
  assert.equal(persisted.auth.algorithm, "scrypt-v2");
  assert.equal(persisted.auth.mustChangePassword, false);
  assert.equal(persisted.users.some((user) => user.username === "operador.teste" && user.role === "operator"), true);
  assert.equal(persisted.users.some((user) => user.username === "tecnico.teste"), false);
  assert.equal(persisted.panels.some((panel) => panel.mode === "video" && panel.mediaId), true);
  assert.equal(persisted.panels.some((panel) => panel.id === automaticPlaylistPanelId && panel.managedBy === "playlist"), true);
  assert.equal(persisted.tvs[0].token, undefined);
  assert.match(persisted.tvs[0].tokenHash, /^[a-f0-9]{64}$/);
  assert(tvCookie.startsWith("dvs_tv_auth="));
}

(async () => {
  try {
    await run();
    console.log("Integracao DVS: OK");
  } catch (err) {
    console.error(err.stack || err.message);
    console.error(output);
    process.exitCode = 1;
  } finally {
    try { server.kill(); } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})();
