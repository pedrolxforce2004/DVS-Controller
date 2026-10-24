(function () {
  var APP_VERSION = "0.6.9";
  var setupForm = document.getElementById("setupForm");
  var serverInput = setupForm.elements.serverUrl;
  var nameInput = setupForm.elements.name;

  function readSettings() {
    try {
      return JSON.parse(localStorage.getItem("dvs.launcher") || "{}");
    } catch (_) {
      return {};
    }
  }

  function saveSettings(settings) {
    localStorage.setItem("dvs.launcher", JSON.stringify(settings));
  }

  function readLaunchSettings() {
    try {
      if (!window.PalmSystem || !window.PalmSystem.launchParams) return {};
      return JSON.parse(window.PalmSystem.launchParams);
    } catch (_) {
      return {};
    }
  }

  function normalizeServerUrl(value) {
    value = String(value || "").replace(/^\s+|\s+$/g, "").replace(/\/+$/, "");
    if (value && !/^https?:\/\//i.test(value)) value = "http://" + value;
    return value;
  }

  function isLocalhostUrl(value) {
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(value);
  }

  function openServerApp(serverUrl, name) {
    serverUrl = normalizeServerUrl(serverUrl);
    if (isLocalhostUrl(serverUrl)) {
      alert("Na TV, use o IP do computador servidor. Exemplo: https://dvs.example.com:3080");
      return;
    }
    saveSettings({ serverUrl: serverUrl, name: name });
    var target = serverUrl + "/tv-app?name=" + encodeURIComponent(name || "TV LG") +
      "&launcherVersion=" + encodeURIComponent(APP_VERSION);
    window.location.replace(target);
  }

  var launchSettings = readLaunchSettings();
  var settings = readSettings();
  if (launchSettings.serverUrl) settings.serverUrl = launchSettings.serverUrl;
  if (launchSettings.name) settings.name = launchSettings.name;
  if (launchSettings.serverUrl || launchSettings.name) saveSettings(settings);
  if (settings.serverUrl) serverInput.value = settings.serverUrl;
  if (settings.name) nameInput.value = settings.name;
  if (settings.serverUrl && settings.name) {
    setTimeout(function () {
      openServerApp(settings.serverUrl, settings.name);
    }, 1200);
  }

  setupForm.onsubmit = function (event) {
    event.preventDefault();
    openServerApp(serverInput.value, nameInput.value);
  };
})();
