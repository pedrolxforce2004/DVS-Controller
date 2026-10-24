(function () {
  "use strict";
  var VERSION = "0.6.9";
  var form = document.getElementById("setupForm");
  var serverInput = document.getElementById("serverUrl");
  var nameInput = document.getElementById("tvName");
  var status = document.getElementById("status");
  var settings = readSettings();

  keepScreenAwake();
  registerRemoteKeys();
  serverInput.value = settings.serverUrl || "";
  nameInput.value = settings.name || "Samsung TV";

  if (settings.serverUrl && settings.name) connect(settings.serverUrl, settings.name);

  form.onsubmit = function (event) {
    event.preventDefault();
    connect(serverInput.value, nameInput.value);
  };

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) keepScreenAwake();
  });

  window.addEventListener("pageshow", keepScreenAwake);

  function readSettings() {
    try { return JSON.parse(localStorage.getItem("dvs.tizen.receiver") || "{}"); } catch (_) { return {}; }
  }

  function normalizeServer(value) {
    value = String(value || "").replace(/^\s+|\s+$/g, "").replace(/\/+$/, "");
    if (value && !/^https?:\/\//i.test(value)) value = "http://" + value;
    return value;
  }

  function connect(serverUrl, name) {
    serverUrl = normalizeServer(serverUrl);
    name = String(name || "Samsung TV").replace(/^\s+|\s+$/g, "");
    if (!serverUrl) return;
    settings = { serverUrl: serverUrl, name: name || "Samsung TV" };
    localStorage.setItem("dvs.tizen.receiver", JSON.stringify(settings));
    status.textContent = "Conectando ao DVS Controller...";
    var url = serverUrl + "/tv-app?name=" + encodeURIComponent(settings.name) +
      "&platform=" + encodeURIComponent("Samsung Tizen") +
      "&launcherVersion=" + encodeURIComponent(VERSION);
    window.location.replace(url);
  }

  function keepScreenAwake() {
    try {
      if (window.tizen && tizen.power && tizen.power.request) tizen.power.request("SCREEN", "SCREEN_NORMAL");
    } catch (_) {}
  }

  function registerRemoteKeys() {
    try {
      if (!window.tizen || !tizen.tvinputdevice) return;
      tizen.tvinputdevice.registerKey("ColorF0Red");
      tizen.tvinputdevice.registerKey("ColorF1Green");
    } catch (_) {}
  }
})();
