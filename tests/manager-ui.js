const assert = require("assert");
const path = require("path");

async function main() {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (_) {
    console.log("Manager UI: ignorado (Playwright opcional nao instalado)");
    return;
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1060, height: 690 }, deviceScaleFactor: 1 });
    await page.addInitScript(() => {
      window.__dvsRequests = [];
      window.dvs = {
        request(method, pathname, body) {
          window.__dvsRequests.push({ method, pathname, body });
          return Promise.resolve({
            machine: "DVS-SERVER-01",
            platform: "Windows 11",
            managerUptime: 86461,
            config: { serverPort: 3080, managerPort: 3091, databasePort: 5432, databaseName: "dvs_controller" },
            services: [
              { id: "dvs", name: "DVS Server", description: "Servidor de TVs, painel administrativo e streaming", port: 3080, status: "running", pid: 4120, uptime: 7210 },
              { id: "postgresql", name: "PostgreSQL", description: "Banco de dados de configuracao e cadastro das TVs", port: 5432, status: "running", windowsState: "running" },
              { id: "manager", name: "Gerenciador DVS", description: "Supervisor e API local de controle dos servicos", port: 3091, status: "running", pid: 2080, uptime: 86461 }
            ]
          });
        },
        openAdmin() {}, minimize() {}, maximize() {}, close() {}, openTizenTool() { return Promise.resolve({ ok: true }); }
      };
    });
    await page.goto(`file:///${path.join(__dirname, "..", "manager", "ui", "index.html").replace(/\\/g, "/")}`);
    await page.waitForSelector(".service-row");
    assert.equal(await page.locator(".service-row").count(), 3);
    assert.match(await page.locator("#globalStatus").innerText(), /Todos os serviços/);
    assert.equal(await page.locator("body").evaluate((body) => body.scrollWidth <= body.clientWidth), true);
    await page.screenshot({ path: path.join(__dirname, "../artifacts/evidence/manager-ui.png"), fullPage: true });
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#stopAll").click();
    await page.waitForFunction(() => window.__dvsRequests.some((item) => item.pathname === "/v1/services/all/stop"));
    assert.equal(await page.evaluate(() => window.__dvsRequests.some((item) => item.pathname === "/v1/services/all/stop" && item.method === "POST")), true);
    console.log("Manager UI: OK");
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
