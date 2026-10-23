const fs = require("fs");
const path = require("path");
const pngToIcoModule = require("png-to-ico");
const pngToIco = pngToIcoModule.default || pngToIcoModule;
const { chromium } = require("playwright");

async function main() {
  const root = path.resolve(__dirname, "..");
  const svg = path.join(root, "build", "icon.svg");
  const png = path.join(root, "build", "icon.png");
  const ico = path.join(root, "build", "icon.ico");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
    await page.goto(`file:///${svg.replace(/\\/g, "/")}`);
    await page.screenshot({ path: png, omitBackground: true });
  } finally {
    await browser.close();
  }
  fs.writeFileSync(ico, await pngToIco(png));
  console.log(`Icone do Windows gerado: ${ico}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
