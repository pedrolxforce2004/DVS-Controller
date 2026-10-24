const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

async function main() {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (_) {
    console.log("Admin UI: ignorado (Playwright opcional nao instalado)");
    return;
  }
  const root = path.resolve(__dirname, "..");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dvs-admin-ui-"));
  const port = 33000 + Math.floor(Math.random() * 1000);
  const server = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DVS_DATA_DIR: dataDir, DVS_ENABLE_ADMIN_AUTH: "1" },
    windowsHide: true,
    stdio: "ignore"
  });
  let browser;
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) break;
      } catch (_) {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(message.text()); });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    await page.goto(`${baseUrl}/admin`);
    await page.locator('[name="user"]').fill("admin");
    await page.locator('[name="password"]').fill("admin");
    await Promise.all([page.waitForURL("**/admin"), page.locator('button[type="submit"]').click()]);
    await page.locator("#currentUser").waitFor();
    await page.waitForFunction(function () { var element = document.getElementById("currentUser"); return Boolean(element && /Supervisor/.test(element.textContent || "")); });
    assert.match(await page.locator("#currentUser").innerText(), /Supervisor/);
    assert.equal(await page.locator("#passwordDialog").isVisible(), true);
    assert.equal(await page.locator("#cancelPassword").isVisible(), false);
    await page.locator('#passwordForm [name="currentPassword"]').fill("admin");
    await page.locator('#passwordForm [name="newPassword"]').fill("BrightScreen42!");
    await page.locator('#passwordForm [name="confirmPassword"]').fill("BrightScreen42!");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator('#passwordForm button[type="submit"]').click();
    await page.locator("#passwordDialog").waitFor({ state: "hidden" });
    assert.equal(await page.locator('button[data-view="usersView"]').isVisible(), true);
    let previewRequests = 0;
    let interactivePreviewRequests = 0;
    const previewJpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==", "base64");
    await page.route("**/panel-preview/**", async function (route) {
      previewRequests += 1;
      if (route.request().url().indexOf("interactive=1") >= 0) interactivePreviewRequests += 1;
      await route.fulfill({ status: 200, contentType: "image/jpeg", body: previewJpeg });
    });
    await page.evaluate(async function () {
      var me = await fetch("/api/me").then(function (response) { return response.json(); });
      var firstPanelId = "";
      for (var index = 0; index < 14; index += 1) {
        var panelResponse = await fetch("/api/panels", {
          method: "POST",
          headers: { "content-type": "application/json", "x-dvs-csrf": me.csrfToken },
          body: JSON.stringify({ name: "Painel UI " + index, url: "https://example.com/" + index, mode: index === 0 ? "server_image" : "direct", zoom: 1 })
        });
        var panelBody = await panelResponse.json();
        if (index === 0) firstPanelId = panelBody.panel.id;
      }
      var registration = await fetch("/api/tv/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "TV Estavel", platform: "test" })
      }).then(function (response) { return response.json(); });
      await fetch("/api/tvs/" + registration.tv.id + "/command", {
        method: "POST",
        headers: { "content-type": "application/json", "x-dvs-csrf": me.csrfToken },
        body: JSON.stringify({ type: "setPanel", panelId: firstPanelId, playbackMode: "server_image" })
      });
      await fetch("/api/groups", {
        method: "POST",
        headers: { "content-type": "application/json", "x-dvs-csrf": me.csrfToken },
        body: JSON.stringify({ name: '<img src=x onerror="window.__xss=1">' })
      });
    });
    await page.locator("#refreshBtn").click();
    await page.waitForFunction(function () { return document.querySelectorAll("#panelList .row").length === 14; });
    await page.locator("#tvGrid .tv-card").waitFor();
    await page.waitForFunction(function () { return document.querySelector("#tvGrid .preview img") && document.querySelector("#tvGrid .preview img").complete; });
    await page.evaluate(function () { window.__stablePanelSelect = document.querySelector("#tvGrid .panelSelect"); });
    await page.waitForTimeout(5500);
    assert.equal(await page.evaluate(function () { return window.__stablePanelSelect === document.querySelector("#tvGrid .panelSelect"); }), true, "Telemetria nao deve reconstruir o seletor de painel");
    assert.equal(await page.locator("#panelForm").isVisible(), false, "Dashboard nao contem cadastro de paineis");
    assert.equal(await page.locator("#groupForm").isVisible(), false, "Dashboard nao contem cadastro de grupos");
    assert.equal(await page.locator("#groupList img").count(), 0);
    assert.equal(await page.evaluate(function () { return window.__xss || 0; }), 0);
    await page.locator('button[data-view="usersView"]').click();
    assert.equal(await page.locator("#userForm").isVisible(), true);
    assert.equal(await page.locator("#userList .empty").isVisible(), false);
    await page.locator('button[data-view="dashboardView"]').click();
    await page.locator('button[data-view="mediaView"]').click();
    const previewsWhenDashboardClosed = previewRequests;
    await page.waitForTimeout(2500);
    assert.equal(previewRequests, previewsWhenDashboardClosed, "Previews devem parar fora do Dashboard");
    assert.equal(await page.locator('button[data-view="mediaView"]').innerText(), "Painel e Midia");
    assert.equal(await page.locator("#panelForm").isVisible(), true);
    assert.equal(await page.locator("#groupForm").isVisible(), false);
    assert.equal(await page.locator("#panelList").evaluate(function (element) { return element.scrollHeight > element.clientHeight; }), true);
    await page.locator("#panelList .row").filter({ hasText: "Painel UI 0" }).getByRole("button", { name: "Interagir" }).click();
    await page.locator("#remoteConnection").filter({ hasText: "Ao vivo" }).waitFor({ timeout: 3000 });
    assert.equal(interactivePreviewRequests > 0, true, "Controle interativo deve usar preview prioritario");
    await page.locator("#closeRemote").click();
    await page.locator('#panelForm [name="mode"]').selectOption("video");
    assert.equal(await page.locator('#panelForm [name="mediaId"]').isVisible(), true);
    assert.equal(await page.locator('#panelForm [name="url"]').isVisible(), false);
    await page.locator('[data-resource-view="groupsResource"]').click();
    assert.equal(await page.locator("#groupForm").isVisible(), true);
    await page.locator('[data-resource-view="playlistsResource"]').click();
    assert.equal(await page.locator("#playlistForm").isVisible(), true);
    assert.equal(await page.locator("#panelPlaylistForm").isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(__dirname, "../artifacts/evidence/admin-ui-0.6.9.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    assert.equal(await page.locator("#playlistForm").isVisible(), true);
    await page.screenshot({ path: path.join(__dirname, "../artifacts/evidence/admin-ui-mobile-0.6.9.png"), fullPage: true });
    console.log("Admin UI 0.6.9: OK");
  } finally {
    if (browser) await browser.close();
    try { server.kill(); } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
