const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

(async () => {
  const root = path.join(__dirname, '..');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'dvs-dashboard-'));
  const port = 38000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DVS_DATA_DIR: data, DVS_ENABLE_ADMIN_AUTH: '1' }, stdio: 'ignore' });
  let browser;
  try {
    let ready = false;
    for (let n = 0; n < 100; n++) { try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch (_) {} await new Promise(r => setTimeout(r, 100)); }
    assert.ok(ready, 'server starts');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(base + '/dashboard');
    await page.locator('#slideTitle').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#loginForm').count(), 0, 'dashboard is public for TV display');
    assert.equal(await page.locator('#slideTitle').innerText(), 'Todos os painéis');
    await page.goto(base + '/admin');
    await page.locator('[name=user]').fill('admin'); await page.locator('[name=password]').fill('admin');
    await Promise.all([page.waitForURL('**/admin'), page.locator('button[type=submit]').click()]);
    await page.locator('#passwordDialog').waitFor({ state: 'visible' });
    await page.locator('[name=currentPassword]').fill('admin'); await page.locator('[name=newPassword]').fill('DashboardTest123!'); await page.locator('[name=confirmPassword]').fill('DashboardTest123!');
    page.once('dialog', dialog => dialog.accept()); await page.locator('#passwordForm button[type=submit]').click();
    await page.locator('#passwordDialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#panelStatusGrid').count(), 0, 'monitor was removed from admin page');
    assert.equal(await page.locator('a[href="/dashboard"]').isVisible(), true, 'admin exposes dashboard shortcut');

    async function api(route, body, method = 'POST') {
      return page.evaluate(async ({ route, body, method }) => {
        const me = await fetch('/api/me').then(r => r.json());
        const response = await fetch(route, { method, headers: { 'content-type': 'application/json', 'x-dvs-csrf': me.csrfToken }, body: body === undefined ? undefined : JSON.stringify(body) });
        const result = await response.json(); if (!response.ok) throw new Error(`${route}: ${response.status} ${result.error}`); return result;
      }, { route, body, method });
    }
    const group = (await api('/api/groups', { name: 'Recepção' })).group;
    const panelA = (await api('/api/panels', { name: 'Indicadores', url: 'https://example.com/indicators', mode: 'direct' })).panel;
    const panelB = (await api('/api/panels', { name: 'Avisos', url: 'https://example.com/notices', mode: 'direct' })).panel;
    const registration = await fetch(base + '/api/tv/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'TV Recepção', platform: 'Android TV' }) }).then(r => r.json());
    await api(`/api/tvs/${registration.tv.id}`, { groupId: group.id }, 'PATCH');
    await api(`/api/tvs/${registration.tv.id}/command`, { type: 'setPanel', panelId: panelA.id });
    await fetch(base + `/api/tv/${registration.tv.id}/heartbeat`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dvs-tv-token': registration.tv.token }, body: JSON.stringify({ currentPanelId: panelA.id, playbackMode: 'direct', lastError: 'Problema no Link do Painel' }) });

    await page.goto(base + '/dashboard?interval=5');
    await page.locator('.panel-card').first().waitFor();
    assert.equal(await page.locator('#slideTitle').innerText(), 'Todos os painéis');
    assert.equal(await page.locator('.panel-card').count(), 2);
    assert.match(await page.locator('.panel-card.error').innerText(), /Indicadores[\s\S]+COM FALHA[\s\S]+TV Recepção/);
    await page.locator('#nextBtn').click();
    assert.equal(await page.locator('#slideTitle').innerText(), 'Principal');
    assert.equal(await page.locator('#emptyState').isVisible(), true);
    await page.locator('#nextBtn').click();
    assert.equal(await page.locator('#slideTitle').innerText(), 'Recepção');
    assert.equal(await page.locator('.panel-card').count(), 1);
    assert.match(await page.locator('.panel-card').innerText(), /Indicadores/);
    await page.locator('#pauseBtn').click();
    assert.equal(await page.locator('#rotationLabel').innerText(), 'Rotação pausada');
    fs.mkdirSync(path.join(root, 'artifacts/evidence'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'artifacts/evidence/dashboard-0.6.9.png'), fullPage: true });
    console.log('Dashboard TV: login, all-panels slide, group rotation, states and pause controls OK');
  } finally {
    if (browser) await browser.close(); child.kill(); await new Promise(resolve => setTimeout(resolve, 400)); fs.rmSync(data, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
