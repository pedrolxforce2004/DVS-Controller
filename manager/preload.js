const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dvs", {
  request(method, path, body) {
    return ipcRenderer.invoke("manager:request", { method, path, body });
  },
  openAdmin(port, secure) { return ipcRenderer.invoke("manager:open-admin", { port, secure }); },
  openTizenTool(kind, sdkPath) { return ipcRenderer.invoke("manager:open-tizen-tool", kind, sdkPath); },
  minimize() { ipcRenderer.send("window:minimize"); },
  maximize() { ipcRenderer.send("window:maximize"); },
  close() { ipcRenderer.send("window:close"); }
});
