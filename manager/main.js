const { app, BrowserWindow, ipcMain, shell } = require("electron");
const http = require("http");
const path = require("path");
const fs = require("fs");

function isRemoteDesktopSession() {
  return process.platform === "win32" && /^rdp/i.test(String(process.env.SESSIONNAME || ""));
}

if (process.platform === "win32" && process.env.DVS_MANAGER_ENABLE_GPU !== "1") {
  app.disableHardwareAcceleration();
  process.env.ELECTRON_DISABLE_GPU = "1";
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-gpu-rasterization");
  app.commandLine.appendSwitch("disable-vulkan");
  app.commandLine.appendSwitch("disable-direct-composition");
  app.commandLine.appendSwitch("disable-accelerated-2d-canvas");
  app.commandLine.appendSwitch("disable-accelerated-video-decode");
  app.commandLine.appendSwitch("disable-zero-copy");
  app.commandLine.appendSwitch("disable-oop-rasterization");
  app.commandLine.appendSwitch("in-process-gpu");
  app.commandLine.appendSwitch("use-gl", "swiftshader");
  app.commandLine.appendSwitch("use-angle", "swiftshader");
  app.commandLine.appendSwitch("disable-features", [
    "Vulkan",
    "VulkanFromANGLE",
    "DefaultANGLEVulkan",
    "VizDisplayCompositor",
    "UseSkiaRenderer",
    "CanvasOopRasterization",
    "DirectComposition",
    "CalculateNativeWinOcclusion"
  ].join(","));
}

if (app.isPackaged && process.platform === "win32" && process.env.ProgramData) {
  process.env.DVS_DATA_DIR = path.join(process.env.ProgramData, "DVS Controller");
}
const configStore = require("../lib/config-store");

let mainWindow;
let managerPainted = false;

function logManagerIssue(message) {
  try {
    const directory = process.env.DVS_DATA_DIR || path.join(__dirname, "..", "data");
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(path.join(directory, "manager-ui.log"), `${new Date().toISOString()} ${message}\n`);
  } catch (_) {}
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function managerRequest(method, pathname, body) {
  const config = configStore.load();
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const request = http.request({
      hostname: "127.0.0.1",
      port: config.managerPort,
      method,
      path: pathname,
      timeout: 8000,
      headers: {
        authorization: `Bearer ${config.controlToken}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload)
      }
    }, (response) => {
      let value = "";
      response.on("data", (chunk) => { value += chunk; });
      response.on("end", () => {
        let result;
        try { result = value ? JSON.parse(value) : {}; } catch (_) { result = { error: value || "Resposta invalida" }; }
        if (response.statusCode >= 400) reject(new Error(result.error || `HTTP ${response.statusCode}`));
        else resolve(result);
      });
    });
    request.on("timeout", () => request.destroy(new Error("O servico gerenciador nao respondeu")));
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function createWindow() {
  const useNativeFrame = process.env.DVS_MANAGER_NATIVE_FRAME === "1" || isRemoteDesktopSession();
  const useRendererSandbox = process.env.DVS_MANAGER_RENDERER_SANDBOX === "1" && !isRemoteDesktopSession();
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 690,
    minWidth: 900,
    minHeight: 560,
    show: false,
    paintWhenInitiallyHidden: true,
    frame: !useNativeFrame ? false : true,
    backgroundColor: "#101721",
    title: "DVS Controller - Gerenciador de Servicos",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: useRendererSandbox,
      backgroundThrottling: false
    }
  });
  if (useNativeFrame) mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.on("did-fail-load", (_event, code, description, validatedUrl) => {
    logManagerIssue(`did-fail-load code=${code} description=${description} url=${validatedUrl}`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logManagerIssue(`render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
    openAdminFallback("O processo de renderizacao do Gerenciador falhou.");
  });
  mainWindow.webContents.on("unresponsive", () => {
    logManagerIssue("webcontents unresponsive");
  });
  mainWindow.webContents.once("paint", () => {
    managerPainted = true;
  });
  mainWindow.loadFile(path.join(__dirname, "ui", "index.html"));
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.focus();
  });
  mainWindow.webContents.once("did-finish-load", () => {
    if (useNativeFrame) {
      mainWindow.webContents.executeJavaScript('document.body.classList.add("native-frame")').catch(() => {});
    }
    if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
    setTimeout(() => {
      verifyManagerPaint().catch((error) => logManagerIssue(`paint-check-error ${error.message}`));
    }, 2500).unref();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

async function verifyManagerPaint() {
  if (!mainWindow || managerPainted) return;
  const visibleText = await mainWindow.webContents.executeJavaScript("document.body && document.body.innerText || ''").catch(() => "");
  const image = await mainWindow.webContents.capturePage().catch(() => null);
  if (/Servicos|Serviços|DVS Controller|Carregando/i.test(String(visibleText || "")) && hasVisibleContent(image)) return;
  logManagerIssue("blank-window-detected");
  await openAdminFallback("A interface do Gerenciador nao pintou nesta sessao grafica.");
}

function hasVisibleContent(image) {
  if (!image || image.isEmpty()) return false;
  const bitmap = image.toBitmap();
  if (!bitmap || !bitmap.length) return false;
  let brightPixels = 0;
  const step = Math.max(4, Math.floor(bitmap.length / 4 / 8000) * 4);
  for (let index = 0; index < bitmap.length; index += step) {
    const blue = bitmap[index];
    const green = bitmap[index + 1];
    const red = bitmap[index + 2];
    if (red + green + blue > 210) brightPixels += 1;
    if (brightPixels > 24) return true;
  }
  return false;
}

async function openAdminFallback(reason) {
  const config = configStore.load();
  logManagerIssue(`${reason} Abrindo painel externo na porta ${config.serverPort}.`);
  await shell.openExternal(`${config.tlsCertPath && config.tlsKeyPath ? "https" : "http"}://127.0.0.1:${Number(config.serverPort)}/admin`).catch((error) => {
    logManagerIssue(`open-admin-fallback-error ${error.message}`);
  });
}

if (hasSingleInstanceLock) app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());

ipcMain.handle("manager:request", (_event, request) => managerRequest(request.method, request.path, request.body));
ipcMain.handle("manager:open-admin", async (_event, target) => shell.openExternal(`${target && target.secure ? "https" : "http"}://127.0.0.1:${Number(target && target.port)}/admin`));
ipcMain.handle("manager:open-tizen-tool", async (_event, kind, sdkPath) => {
  const root = path.resolve(String(sdkPath || ""));
  const candidates = kind === "certificate"
    ? ["tools/certificate-manager/certificate-manager.exe", "certificate-manager/certificate-manager.exe"]
    : ["package-manager/package-manager.exe"];
  const executable = candidates.map((item) => path.join(root, item)).find((item) => fs.existsSync(item));
  if (!executable) {
    await shell.openExternal("https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html");
    return { opened: false, message: kind === "certificate" ? "Certificate Manager nao encontrado. Instale a Samsung Certificate Extension no Package Manager." : "Tizen Studio nao encontrado. A pagina oficial foi aberta." };
  }
  const error = await shell.openPath(executable);
  if (error) throw new Error(error);
  return { opened: true, message: kind === "certificate" ? "Certificate Manager aberto." : "Package Manager aberto." };
});
ipcMain.on("window:minimize", () => mainWindow && mainWindow.minimize());
ipcMain.on("window:maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on("window:close", () => mainWindow && mainWindow.close());
