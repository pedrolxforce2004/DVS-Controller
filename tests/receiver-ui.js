const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'dvs-receiver-'));
  const port = 37000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  const fixture = http.createServer((req, res) => { res.writeHead(req.url === '/bad' ? 404 : 200); res.end('<h1>Painel de teste</h1>'); });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), windowsHide: true, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DVS_DATA_DIR: data, DVS_ENABLE_ADMIN_AUTH: '1' }, stdio: 'ignore' });
  let browser;
  try {
    let ready = false;
    for (let n = 0; n < 100; n++) { try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch (_) {} await new Promise(r => setTimeout(r, 100)); }
    assert.ok(ready);
    browser = await chromium.launch({ headless: true });
    const admin = await browser.newPage();
    await admin.goto(base + '/admin');
    await admin.locator('[name=user]').fill('admin'); await admin.locator('[name=password]').fill('admin');
    await Promise.all([admin.waitForURL('**/admin'), admin.locator('button[type=submit]').click()]);
    await admin.locator('#passwordDialog').waitFor({ state: 'visible' });
    await admin.locator('[name=currentPassword]').fill('admin'); await admin.locator('[name=newPassword]').fill('ReceiverTest123!'); await admin.locator('[name=confirmPassword]').fill('ReceiverTest123!');
    admin.once('dialog', d => d.accept()); await admin.locator('#passwordForm button[type=submit]').click();
    await admin.locator('#passwordDialog').waitFor({ state: 'hidden' });
    async function api(route, body) {
      return admin.evaluate(async ({ route, body }) => {
        const me = await fetch('/api/me').then(r => r.json());
        const r = await fetch(route, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-dvs-csrf': me.csrfToken }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error(`${route}: ${r.status}`);
        return r.json();
      }, { route, body });
    }
    const bad = (await api('/api/panels', { name: 'Link incorreto', url: `http://127.0.0.1:${fixture.address().port}/bad`, mode: 'direct' })).panel;
    const good = (await api('/api/panels', { name: 'Painel normal', url: `http://127.0.0.1:${fixture.address().port}/ok`, mode: 'direct' })).panel;
    const receiver = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await receiver.goto(base + '/tv-app?name=Android-Test&platform=Android%20TV');
    await receiver.waitForFunction(() => !!JSON.parse(localStorage.getItem('dvs.receiver') || '{}').id);
    const id = await receiver.evaluate(() => JSON.parse(localStorage.getItem('dvs.receiver')).id);
    await api(`/api/tvs/${id}/command`, { type: 'setPanel', panelId: bad.id });
    await receiver.locator('#panelError').waitFor({ state: 'visible', timeout: 15000 });
    assert.match(await receiver.locator('#panelError').innerText(), /Problema no Link do Painel/);
    fs.mkdirSync(path.join(__dirname, '../artifacts/evidence'), { recursive: true });
    await receiver.screenshot({ path: path.join(__dirname, '../artifacts/evidence/panel-error-0.6.9.png') });
    await api(`/api/tvs/${id}/command`, { type: 'setPanel', panelId: good.id });
    await receiver.locator('#panelError').waitFor({ state: 'hidden', timeout: 15000 });
    await receiver.frameLocator('#frame').locator('h1').waitFor();
    await admin.goto(base + '/dashboard');
    await admin.waitForFunction(() => document.querySelector('#panelGrid').textContent.includes('Painel normal'));
    const healthyCard = admin.locator('.panel-card', { hasText: 'Painel normal' });
    assert.equal(await healthyCard.count(), 1);
    assert.match(await healthyCard.getAttribute('class'), /online/);
    console.log('Receiver UI: HTTP 404 error screen, panel switch recovery and dashboard state OK');
  } finally {
    if (browser) await browser.close(); child.kill(); fixture.closeAllConnections(); fixture.close();
    await new Promise(r => setTimeout(r, 500)); fs.rmSync(data, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
