const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

(async () => {
  const root = path.join(__dirname, '..');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'dvs-069-'));
  const port = 41000 + Math.floor(Math.random() * 500);
  const base = `http://127.0.0.1:${port}`;
  const seed = { groups: [{ id: 'default', name: 'Principal' }], tvs: [], panels: [], webosDevices: [], tizenDevices: [], androidDevices: [] };
  for (const kind of ['webos', 'tizen', 'android']) seed[kind + 'Devices'].push({ id: kind + '-test', name: 'TV ' + kind, host: '192.0.2.2', port: 1234, profile: kind === 'tizen' ? 'INFRA' : undefined });
  fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify(seed));
  let submitted = '', child, browser;
  const fixture = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let body = ''; req.on('data', chunk => body += chunk);
      req.on('end', () => { submitted = body; res.setHeader('content-type', 'text/html'); res.end('<h1>Login direto confirmado</h1>'); });
    } else { res.setHeader('content-type', 'text/html'); res.end('<h1>Painel local</h1>'); }
  });
  await new Promise(r => fixture.listen(0, '127.0.0.1', r));
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/login`;
  async function start() {
    child = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true, env: { ...process.env, DVS_DATA_DIR: data, HOST: '127.0.0.1', PORT: String(port), DVS_ENABLE_ADMIN_AUTH: '1' }, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) return; } catch (_) {} await new Promise(r => setTimeout(r, 100)); }
    throw new Error('Servidor nao iniciou');
  }
  async function stop() { const exited = new Promise(r => child.once('exit', r)); child.kill(); await exited; }
  async function json(route, body, headers = {}, method = 'POST', expected = 200) {
    const res = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await res.json(); assert.equal(res.status, expected, `${route}: ${JSON.stringify(value)}`); return { value, res };
  }
  async function login(user, password) {
    const result = await json('/api/login', { user, password });
    const cookie = result.res.headers.get('set-cookie').split(';')[0];
    const me = await json('/api/me', undefined, { cookie }, 'GET');
    return { cookie, 'x-dvs-csrf': me.value.csrfToken, origin: base };
  }
  try {
    await start();
    const admin = await login('admin', 'admin');
    await json('/api/change-password', { currentPassword: 'admin', newPassword: 'Release069Test!', confirmPassword: 'Release069Test!' }, admin);
    const headers = await login('admin', 'Release069Test!');
    const group = (await json('/api/groups', { name: 'Operações' }, headers)).value.group;
    for (const kind of ['webos', 'tizen', 'android']) await json(`/api/${kind}/devices/${kind}-test`, { groupId: group.id }, headers, 'PATCH');
    await json('/api/users', { username: 'operador', displayName: 'Operador', role: 'operator', password: 'Operator069Test!', mustChangePassword: false }, headers, 'POST', 201);
    const operator = await login('operador', 'Operator069Test!');
    const panel = (await json('/api/panels', { name: 'Login direto', url: fixtureUrl, mode: 'direct', auth: { enabled: true, username: 'screen', password: 'screen-secret', directMethod: 'form_post', loginUrl: fixtureUrl, usernameField: 'login', passwordField: 'senha' } }, operator)).value.panel;
    assert.equal(panel.mode, 'direct');
    await json('/api/panels', { id: panel.id, url: fixtureUrl, zoom: 1.2, auth: { enabled: true, username: '', password: '', directMethod: 'form_post', loginUrl: fixtureUrl, usernameField: 'login', passwordField: 'senha' } }, operator);
    await json('/api/panels', { id: panel.id, mode: 'server_image' }, operator, 'POST', 403);
    await json(`/api/panels/${panel.id}`, undefined, operator, 'DELETE', 403);
    await json('/api/groups', { name: 'Proibido' }, operator, 'POST', 403);
    const other = (await json('/api/panels', { name: 'Outro', url: fixtureUrl, mode: 'server_image' }, headers)).value.panel;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: 'node', viewport: { width: 1920, height: 1080 } });
    const receiver = await context.newPage();
    await receiver.goto(base + '/tv-app?name=TV-069&platform=Android%20TV');
    await receiver.waitForFunction(() => JSON.parse(localStorage.getItem('dvs.receiver') || '{}').id);
    const settings = await receiver.evaluate(() => JSON.parse(localStorage.getItem('dvs.receiver')));
    await json(`/api/tvs/${settings.id}`, { groupId: group.id }, headers, 'PATCH');
    await json(`/api/tvs/${settings.id}/command`, { type: 'setPanel', panelId: panel.id }, headers);
    await receiver.frameLocator('#frame').locator('h1', { hasText: 'Login direto confirmado' }).waitFor();
    assert.equal(submitted, 'login=screen&senha=screen-secret');
    await json(`/api/tv/${settings.id}/heartbeat`, { currentPanelId: other.id, playbackMode: 'server_image', zoom: 0.5 }, { 'x-dvs-tv-token': settings.token });
    let snapshot = (await json('/api/state', undefined, {}, 'GET')).value;
    assert.equal(snapshot.tvs.find(tv => tv.id === settings.id).currentPanelId, panel.id);
    assert.equal(snapshot.tvs.find(tv => tv.id === settings.id).playbackMode, 'direct');
    await json('/api/tv/register', { id: settings.id, token: settings.token, groupId: 'default', name: 'Nome antigo', zoom: 0.5 });
    snapshot = (await json('/api/state', undefined, {}, 'GET')).value;
    assert.equal(snapshot.tvs.find(tv => tv.id === settings.id).groupId, group.id);
    const exposed = JSON.stringify(snapshot);
    assert.ok(!exposed.includes('screen-secret')); assert.ok(!exposed.includes('sourceSecret'));
    await json(`/api/tv/${settings.id}/direct-login`, { panelId: other.id }, { 'x-dvs-tv-token': settings.token }, 'POST', 403);
    await json(`/api/tv/${settings.id}/direct-login`, { panelId: panel.id }, { 'x-dvs-tv-token': 'invalid' }, 'POST', 401);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
    let upload = await fetch(base + '/api/media/upload?name=imagem.png&title=Comunicado', { method: 'POST', headers, body: png });
    assert.equal(upload.status, 200); const media = (await upload.json()).media;
    upload = await fetch(base + '/api/media/upload?name=falso.png', { method: 'POST', headers, body: Buffer.from('not an image') }); assert.equal(upload.status, 400);
    const image = (await json('/api/panels', { name: 'Comunicado', mode: 'image', mediaId: media.id }, headers)).value.panel;
    await json(`/api/tvs/${settings.id}/command`, { type: 'setPanel', panelId: image.id }, headers);
    await receiver.waitForFunction(() => { const img = document.getElementById('serverImage'); return img.complete && img.naturalWidth > 0 && img.style.display === 'block'; });
    await json('/api/panels', { id: image.id, zoom: 1.1 }, operator);
    const rtsp = (await json('/api/panels', { name: 'NVR canal 1', mode: 'rtsp', url: 'rtsp://camera:pass@192.0.2.10:554/stream' }, headers)).value.panel;
    assert.equal(rtsp.mode, 'rtsp'); assert.equal(rtsp.url, ''); assert.ok(rtsp.hasSource);
    const list = (await json('/api/panel-playlists', { name: 'Ciclo', items: [{ panelId: panel.id, durationSeconds: 10 }, { panelId: image.id, durationSeconds: 10 }] }, headers)).value;
    const playback = list.panel || (await json('/api/state', undefined, {}, 'GET')).value.panels.find(p => p.mode === 'panel_playlist');
    assert.ok(playback);
    await json(`/api/tvs/${settings.id}/command`, { type: 'setPanel', panelId: playback.id }, headers);
    await json(`/api/tv/${settings.id}/heartbeat`, { currentPanelId: image.id, playbackMode: 'image' }, { 'x-dvs-tv-token': settings.token });
    snapshot = (await json('/api/state', undefined, {}, 'GET')).value;
    assert.equal(snapshot.tvs.find(tv => tv.id === settings.id).currentPanelId, playback.id);
    assert.equal(snapshot.tvs.find(tv => tv.id === settings.id).playbackMode, 'panel_playlist');
    const evidence = path.join(root, 'artifacts/evidence'); fs.mkdirSync(evidence, { recursive: true });
    const dashboard = await context.newPage(); await dashboard.goto(base + '/dashboard'); await dashboard.locator('.panel-card').first().waitFor();
    await dashboard.locator('#pauseBtn').click();
    for (const size of [{ width: 1920, height: 1080 }, { width: 3840, height: 2160 }, { width: 1280, height: 720 }]) {
      await dashboard.setViewportSize(size); await dashboard.reload(); await dashboard.locator('.panel-card').first().waitFor();
      await dashboard.screenshot({ path: path.join(evidence, `dashboard-${size.width}.png`) });
      assert.ok(await dashboard.locator('#metricNetwork').isVisible());
      assert.equal(await dashboard.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    const adminPage = await context.newPage();
    await context.addCookies([{ name: 'dvs_session', value: headers.cookie.split('=')[1], url: base }]);
    await adminPage.goto(base + '/admin'); await adminPage.locator('#currentUser').waitFor();
    for (const kind of ['webos', 'tizen', 'android']) {
      await adminPage.locator(`[data-view="${kind}View"]`).click();
      await adminPage.locator(`#${kind}Grid .device-group`).waitFor();
      assert.match(await adminPage.locator(`#${kind}Grid .device-group>h3`).innerText(), /Operações/);
    }
    await adminPage.screenshot({ path: path.join(evidence, 'device-groups.png'), fullPage: true });
    await browser.close(); browser = null;
    await new Promise(r => setTimeout(r, 1200)); await stop(); await start();
    snapshot = (await json('/api/state', undefined, {}, 'GET')).value;
    assert.equal(snapshot.panels.find(p => p.id === panel.id).mode, 'direct');
    assert.equal(snapshot.tvs.find(tv => tv.id === settings.id).currentPanelId, playback.id);
    assert.equal(snapshot.tvs.find(tv => tv.id === settings.id).groupId, group.id);
    for (const kind of ['webos', 'tizen', 'android']) assert.equal(snapshot[kind + 'Devices'][0].groupId, group.id);
    console.log('0.6.9: login direto POST real no iframe, segredo restrito, operador, imagem real, validacao de upload, RTSP cadastrado, playlist, heartbeat atrasado, grupos nas 3 plataformas, telas 720p/1080p/4K e reinicio: OK');
  } finally {
    if (browser) await browser.close(); if (child && child.exitCode === null) await stop(); fixture.closeAllConnections(); fixture.close(); fs.rmSync(data, { recursive: true, force: true });
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
