(function () {
  var APP_VERSION = "0.6.8";
  var setup = document.getElementById("setup");
  var stage = document.getElementById("stage");
  var setupForm = document.getElementById("setupForm");
  var frame = document.getElementById("frame");
  var serverImage = document.getElementById("serverImage");
  var videoPlayer = document.getElementById("videoPlayer");
  var message = document.getElementById("message");
  var identify = document.getElementById("identify");
  var settings = readSettings();
  var state = { currentPanelId: "", playbackMode: "direct", lastError: "", zoom: 1, tvZoom: 1 };
  var panelError = document.getElementById("panelError");
  var directTimer = null;
  var frameTimer = null;
  var directUrl = "";
  function showPanelError(detail) {
    state.lastError = "Problema no Link do Painel";
    document.getElementById("panelErrorDetail").textContent = detail || "";
    panelError.hidden = false;
    showMessage("");
  }
  function clearPanelError() { panelError.hidden = true; state.lastError = ""; }
  function checkDirectLink(generation) {
    if (generation !== playbackGeneration) return;
    request("/api/tv/" + encodeURIComponent(settings.id) + "/panel-health", {}, function (err, health) {
      if (generation !== playbackGeneration) return;
      if (!err && health.panelId === state.currentPanelId) {
        if (health.status === "error") showPanelError(health.reason);
        else if (health.status === "reachable" && !panelError.hidden) {
          clearPanelError(); if (frame.style.display === "block") frame.src = directUrl;
        }
      }
      directTimer = setTimeout(function () { checkDirectLink(generation); }, 30000);
    });
  }
  var eventSource = null;
  var imageTimer = null;
  var playlistState = null;
  var panelPlaylistState = null;
  var panelPlaylistTimer = null;
  var handledCommandIds = {};
  var handledCommandOrder = [];
  var navigationCommandGeneration = 0;
  var zoomCommandGeneration = 0;
  var playbackGeneration = 0;
  var pollInFlight = false;
  var heartbeatInFlight = false;
  var pollInterval = null;
  var heartbeatInterval = null;
  var screenSaverBridge = null;
  var screenSaverResponseBridge = null;

  applyLaunchParams();

  function readSettings() {
    try {
      return JSON.parse(localStorage.getItem("dvs.receiver") || "{}");
    } catch (_) {
      return {};
    }
  }

  function queryValue(name) {
    var match = new RegExp("[?&]" + name + "=([^&]*)").exec(window.location.search || "");
    return match ? decodeURIComponent(match[1].replace(/\+/g, " ")) : "";
  }

  function applyLaunchParams() {
    var name = queryValue("name");
    var id = queryValue("id");
    var token = queryValue("token");
    var platform = queryValue("platform");
    var launcherVersion = queryValue("launcherVersion");
    if (window.location.pathname === "/tv-app" || name) {
      settings.serverUrl = window.location.protocol + "//" + window.location.host;
      if (name) settings.name = name;
      if (id) settings.id = id;
      if (token) settings.token = token;
      if (platform) settings.platform = platform;
      if (launcherVersion) settings.launcherVersion = launcherVersion;
      saveSettings(settings);
    }
  }

  function saveSettings(next) {
    settings = next;
    localStorage.setItem("dvs.receiver", JSON.stringify(settings));
  }

  function joinUrl(base, path) {
    return String(base || "").replace(/\/+$/, "") + path;
  }

  function tvStatePath() {
    return "/api/tv/" + encodeURIComponent(settings.id || "") + "/state";
  }

  function playbackQuery() {
    return "tvId=" + encodeURIComponent(settings.id || "");
  }

  function normalizeServerUrl(value) {
    value = String(value || "").replace(/^\s+|\s+$/g, "").replace(/\/+$/, "");
    if (value && !/^https?:\/\//i.test(value)) value = "http://" + value;
    return value;
  }

  function isLocalhostUrl(value) {
    var isWebOs = /webos|web0s|smarttv/i.test(navigator.userAgent || "");
    return isWebOs && /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(value);
  }

  function showMessage(text) {
    message.textContent = text;
    message.style.display = text ? "block" : "none";
  }

  function blockWebOsScreenSaver() {
    try {
      if (window.tizen && tizen.power && tizen.power.request) tizen.power.request("SCREEN", "SCREEN_NORMAL");
    } catch (_) {}
    if (typeof WebOSServiceBridge === "undefined") return;
    try {
      screenSaverBridge = new WebOSServiceBridge();
      screenSaverResponseBridge = new WebOSServiceBridge();
      screenSaverBridge.onservicecallback = function (raw) {
        var data = {};
        try {
          data = JSON.parse(raw || "{}");
        } catch (_) {}
        if (!data.timestamp) return;
        screenSaverResponseBridge.call(
          "luna://com.webos.service.tvpower/power/responseScreenSaverRequest",
          JSON.stringify({
            clientName: "DVS Controller",
            ack: false,
            timestamp: data.timestamp
          })
        );
      };
      screenSaverBridge.call(
        "luna://com.webos.service.tvpower/power/registerScreenSaverRequest",
        JSON.stringify({
          subscribe: true,
          clientName: "DVS Controller"
        })
      );
    } catch (_) {}
  }

  function failConnect(err) {
    setup.hidden = false;
    stage.hidden = true;
    setup.style.display = "flex";
    stage.style.display = "none";
    alert(err.message || String(err));
  }

  function request(path, options, done) {
    requestUrl(joinUrl(settings.serverUrl, path), options, done);
  }

  function getJson(path, done) {
    request(path, { method: "GET" }, done);
  }

  function requestUrl(url, options, done) {
    options = options || {};
    var xhr = new XMLHttpRequest();
    var finished = false;
    var timer = setTimeout(function () {
      if (finished) return;
      finished = true;
      try { xhr.abort(); } catch (_) {}
      done(new Error("Tempo esgotado: " + url));
    }, 15000);
    xhr.open(options.method || "GET", url, true);
    xhr.setRequestHeader("content-type", "text/plain");
    if (settings.token) xhr.setRequestHeader("x-dvs-tv-token", settings.token);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4 || finished) return;
      finished = true;
      clearTimeout(timer);
      var body = {};
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch (_) {
        done(new Error("Resposta invalida do servidor"));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) done(null, body);
      else done(new Error(body.error || "Erro " + xhr.status));
    };
    xhr.onerror = function () {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done(new Error("Falha de rede: " + url));
    };
    xhr.send(options.body || null);
  }

  function register(done, retried) {
    var registration = {
      id: settings.id || "",
      token: settings.token || "",
      name: settings.name || "",
      platform: settings.platform || "LG webOS",
      model: navigator.userAgent || "",
      appVersion: settings.launcherVersion || APP_VERSION
    };
    request("/api/tv/register", { method: "POST", body: JSON.stringify(registration) }, function (err, body) {
      if (err) {
        if (!retried && settings.id && /Cadastro da TV nao reconhecido/.test(err.message || "")) {
          settings.id = "";
          settings.token = "";
          saveSettings(settings);
          register(done, true);
          return;
        }
        done(err);
        return;
      }
      saveSettings({
        serverUrl: settings.serverUrl,
        name: body.tv.name,
        id: body.tv.id,
        token: body.tv.token,
        platform: settings.platform || "LG webOS",
        launcherVersion: settings.launcherVersion || APP_VERSION
      });
      done(null);
    });
  }

  function start() {
    settings.serverUrl = normalizeServerUrl(settings.serverUrl);
    if (isLocalhostUrl(settings.serverUrl)) {
      alert("Na TV, use o IP do computador servidor. Exemplo: https://dvs.example.com:3080");
      return;
    }
    setup.hidden = true;
    stage.hidden = false;
    setup.style.display = "none";
    stage.style.display = "block";
    blockWebOsScreenSaver();
    showMessage("Testando " + settings.serverUrl);
    getJson("/api/ping?t=" + Date.now(), function (pingErr) {
      if (pingErr) {
        failConnect(pingErr);
        return;
      }
      showMessage("Registrando TV");
      register(function (err) {
      if (err) {
        failConnect(err);
        return;
      }
      connectEvents();
      pollCommands();
      clearInterval(pollInterval);
      pollInterval = setInterval(pollCommands, 5000);
      sendHeartbeat();
      clearInterval(heartbeatInterval);
      heartbeatInterval = setInterval(sendHeartbeat, 10000);
      showMessage("Aguardando painel");
      });
    });
  }

  function connectEvents() {
    if (!window.EventSource) {
      showMessage("Conectado por compatibilidade");
      return;
    }
    if (eventSource) eventSource.close();
    eventSource = new EventSource(joinUrl(settings.serverUrl, "/api/tv/" + settings.id + "/events"));
    eventSource.addEventListener("command", function (event) {
      try { applyCommand(JSON.parse(event.data)); } catch (_) {}
    });
    eventSource.onopen = function () {
      if (!state.lastError) showMessage("");
    };
    eventSource.onerror = function () {
      showMessage("Reconectando ao servidor");
    };
  }

  function sendHeartbeat() {
    if (!settings.id || !settings.token || heartbeatInFlight) return;
    heartbeatInFlight = true;
    var path = "/api/tv/" + settings.id + "/heartbeat";
    request(path, { method: "POST", body: JSON.stringify({
      currentPanelId: state.currentPanelId || "",
      playbackMode: state.playbackMode || "",
      zoom: state.tvZoom || 1,
      lastError: state.lastError || ""
    }) }, function (err) {
      heartbeatInFlight = false;
      if (!err) {
        if (/Heartbeat sem resposta/.test(state.lastError || "")) state.lastError = "";
        return;
      }
      state.lastError = "Heartbeat sem resposta";
      showMessage("Sem conexao com servidor");
    });
  }

  function pollCommands() {
    if (!settings.id || !settings.token || pollInFlight) return;
    pollInFlight = true;
    getJson("/api/tv/" + settings.id + "/poll", function (err, body) {
      pollInFlight = false;
      if (err || !body) return;
      var commands = body.commands && body.commands.length ? body.commands : body.command ? [body.command] : [];
      for (var i = 0; i < commands.length; i += 1) applyCommand(commands[i]);
    });
  }

  function resetZoom() {
    frame.style.transform = "";
    frame.style.transformOrigin = "";
    frame.style.width = "100%";
    frame.style.height = "100%";
    serverImage.style.transform = "";
    serverImage.style.transformOrigin = "";
    serverImage.style.width = "100%";
    serverImage.style.height = "100%";
    videoPlayer.style.transform = "";
    videoPlayer.style.transformOrigin = "";
    videoPlayer.style.width = "100%";
    videoPlayer.style.height = "100%";
  }

  function stopVideo() {
    playlistState = null;
    videoPlayer.onended = null;
    videoPlayer.onplaying = null;
    videoPlayer.onerror = null;
    try { videoPlayer.pause(); } catch (_) {}
    videoPlayer.removeAttribute("src");
    try { videoPlayer.load(); } catch (_) {}
    videoPlayer.style.display = "none";
  }

  function stopPanelPlaylist() {
    panelPlaylistState = null;
    clearTimeout(panelPlaylistTimer);
    panelPlaylistTimer = null;
  }

  function stopServerImage() {
    clearTimeout(imageTimer);
    imageTimer = null;
    serverImage.onerror = null;
    serverImage.onload = null;
    serverImage.removeAttribute("src");
    serverImage.style.display = "none";
  }

  function applyZoom(element, zoom) {
    zoom = Math.max(0.25, Math.min(3, Number(zoom || 1)));
    element.style.transformOrigin = "0 0";
    element.style.transform = "scale(" + zoom + ")";
    element.style.webkitTransformOrigin = "0 0";
    element.style.webkitTransform = "scale(" + zoom + ")";
    element.style.width = (100 / zoom) + "%";
    element.style.height = (100 / zoom) + "%";
  }

  function applyImageZoom(element, zoom) {
    zoom = Math.max(0.25, Math.min(3, Number(zoom || 1)));
    element.style.transformOrigin = "0 0";
    element.style.transform = "scale(" + zoom + ")";
    element.style.webkitTransformOrigin = "0 0";
    element.style.webkitTransform = "scale(" + zoom + ")";
    element.style.width = "100%";
    element.style.height = "100%";
  }

  function effectiveZoom(panelZoom) {
    return Number(panelZoom || 1) * Number(state.tvZoom || 1);
  }

  function loadDirect(url, zoom) {
    var generation = ++playbackGeneration;
    clearTimeout(directTimer); clearTimeout(frameTimer);
    frame.onload = null; frame.onerror = null;
    clearPanelError();
    clearTimeout(imageTimer);
    stopVideo();
    resetZoom();
    stopServerImage();
    frame.style.display = "block";
    applyZoom(frame, effectiveZoom(zoom));
    directUrl = url;
    frame.src = "about:blank";
    setTimeout(function () {
      if (generation !== playbackGeneration) return;
      frame.onload = function () { if (generation === playbackGeneration) clearTimeout(frameTimer); };
      frame.onerror = function () { if (generation === playbackGeneration) showPanelError("Falha ao carregar a pagina"); };
      frameTimer = setTimeout(function () { if (generation === playbackGeneration) showPanelError("Tempo de carregamento esgotado"); }, 25000);
      frame.src = url;
      checkDirectLink(generation);
    }, 50);
    showMessage("");
  }

  function loadServerImage(panelId, refreshSeconds, zoom) {
    var generation = ++playbackGeneration;
    clearTimeout(directTimer); clearTimeout(frameTimer);
    frame.onload = null; frame.onerror = null;
    clearPanelError();
    clearTimeout(imageTimer);
    stopVideo();
    resetZoom();
    frame.style.display = "none";
    stopServerImage();
    serverImage.style.display = "block";
    applyImageZoom(serverImage, state.tvZoom);
    function connectStream(delay) {
      clearTimeout(imageTimer);
      imageTimer = setTimeout(function () {
        if (generation !== playbackGeneration || state.currentPanelId !== panelId || state.playbackMode !== "server_image") return;
        serverImage.src = joinUrl(settings.serverUrl, "/panel-mjpeg/" + panelId + "?" + playbackQuery() + "&t=" + Date.now());
      }, delay);
    }
    serverImage.onerror = function () {
      if (generation !== playbackGeneration) return;
      state.lastError = "Fluxo renderizado interrompido";
      showPanelError("Renderizacao indisponivel");
      connectStream(2000);
    };
    serverImage.onload = function () {
      if (generation !== playbackGeneration) return;
      clearPanelError();
      showMessage("");
    };
    connectStream(0);
    checkDirectLink(generation);
    showMessage("");
  }

  function loadLegacyWall(panelId, zoom) {
    var generation = ++playbackGeneration;
    clearTimeout(directTimer); clearTimeout(frameTimer);
    frame.onload = null; frame.onerror = null;
    clearPanelError();
    clearTimeout(imageTimer);
    stopVideo();
    resetZoom();
    stopServerImage();
    frame.style.display = "block";
    applyZoom(frame, effectiveZoom(zoom));
    frame.src = "about:blank";
    setTimeout(function () {
      if (generation === playbackGeneration) {
        directUrl = joinUrl(settings.serverUrl, "/legacy-wall/" + encodeURIComponent(panelId) + "?" + playbackQuery());
        frame.src = directUrl; checkDirectLink(generation);
      }
    }, 50);
    showMessage("");
  }

  function loadPlaylist(panel, serverState) {
    var generation = ++playbackGeneration;
    clearTimeout(directTimer); clearTimeout(frameTimer);
    frame.onload = null; frame.onerror = null;
    clearPanelError();
    clearTimeout(imageTimer);
    resetZoom();
    frame.style.display = "none";
    stopServerImage();
    stopVideo();
    var playlist = null;
    for (var i = 0; i < serverState.playlists.length; i += 1) {
      if (serverState.playlists[i].id === panel.playlistId) playlist = serverState.playlists[i];
    }
    if (!playlist || !playlist.items.length) {
      showMessage("Lista de reproducao vazia");
      return;
    }
    var items = [];
    for (var itemIndex = 0; itemIndex < playlist.items.length; itemIndex += 1) {
      for (var mediaIndex = 0; mediaIndex < serverState.media.length; mediaIndex += 1) {
        if (serverState.media[mediaIndex].id === playlist.items[itemIndex]) items.push(serverState.media[mediaIndex]);
      }
    }
    if (!items.length) {
      showMessage("Videos da lista nao encontrados");
      return;
    }
    playlistState = { items: items, index: 0, loop: playlist.loop !== false };
    videoPlayer.style.display = "block";
    applyZoom(videoPlayer, effectiveZoom(panel.zoom));
    videoPlayer.onended = function () {
      if (!playlistState || generation !== playbackGeneration) return;
      playlistState.index += 1;
      if (playlistState.index >= playlistState.items.length) {
        if (!playlistState.loop) return showMessage("Lista finalizada");
        playlistState.index = 0;
      }
      playCurrentMedia();
    };
    videoPlayer.onerror = function () {
      if (generation !== playbackGeneration) return;
      state.lastError = "Formato de video nao suportado pela TV";
      showPanelError(state.lastError);
      setTimeout(function () { if (playlistState && generation === playbackGeneration) videoPlayer.onended(); }, 2500);
    };
    videoPlayer.onplaying = function () { if (generation === playbackGeneration) clearPanelError(); };
    function playCurrentMedia() {
      if (!playlistState || generation !== playbackGeneration) return;
      var media = playlistState.items[playlistState.index];
      videoPlayer.src = joinUrl(settings.serverUrl, media.url + "?" + playbackQuery());
      videoPlayer.load();
      var promise = videoPlayer.play();
      if (promise && promise.catch) promise.catch(function () { showMessage("Aguardando reproducao do video"); });
      showMessage("");
    }
    playCurrentMedia();
  }

  function loadVideo(panel, serverState) {
    var media = null;
    for (var i = 0; i < serverState.media.length; i += 1) {
      if (serverState.media[i].id === panel.mediaId) media = serverState.media[i];
    }
    if (!media) { showMessage("Video nao encontrado"); return; }
    loadPlaylist({ playlistId: "dvs_single_video", zoom: panel.zoom }, {
      media: serverState.media,
      playlists: [{ id: "dvs_single_video", items: [media.id], loop: panel.loop !== false }]
    });
  }

  function loadPanelPlaylist(panel, serverState) {
    stopPanelPlaylist();
    var playlist = null;
    for (var i = 0; i < (serverState.panelPlaylists || []).length; i += 1) {
      if (serverState.panelPlaylists[i].id === panel.panelPlaylistId) playlist = serverState.panelPlaylists[i];
    }
    if (!playlist || !playlist.items || !playlist.items.length) {
      showMessage("Playlist de paineis vazia");
      return;
    }
    panelPlaylistState = { token: Date.now() + Math.random(), playlist: playlist, index: 0, loop: playlist.loop !== false };
    function findPanel(panelId) {
      for (var panelIndex = 0; panelIndex < serverState.panels.length; panelIndex += 1) {
        if (serverState.panels[panelIndex].id === panelId) return serverState.panels[panelIndex];
      }
      return null;
    }
    function advance(token) {
      if (!panelPlaylistState || panelPlaylistState.token !== token) return;
      panelPlaylistState.index += 1;
      if (panelPlaylistState.index >= panelPlaylistState.playlist.items.length) {
        if (!panelPlaylistState.loop) { showMessage("Playlist finalizada"); return; }
        panelPlaylistState.index = 0;
      }
      playCurrent(token);
    }
    function playCurrent(token) {
      if (!panelPlaylistState || panelPlaylistState.token !== token) return;
      var item = panelPlaylistState.playlist.items[panelPlaylistState.index];
      var selectedPanel = findPanel(item.panelId);
      if (!selectedPanel) { advance(token); return; }
      state.currentPanelId = selectedPanel.id;
      state.playbackMode = selectedPanel.mode || "direct";
      state.zoom = Number(selectedPanel.zoom || 1);
      if (state.playbackMode === "server_image") loadServerImage(selectedPanel.id, selectedPanel.refreshSeconds, selectedPanel.zoom);
      else if (state.playbackMode === "legacy_videowall") loadLegacyWall(selectedPanel.id, selectedPanel.zoom);
      else if (state.playbackMode === "video") loadVideo(selectedPanel, serverState);
      else if (state.playbackMode === "playlist") loadPlaylist(selectedPanel, serverState);
      else if (state.playbackMode === "rtsp") loadRtsp(selectedPanel);
      else loadDirect(selectedPanel.url, selectedPanel.zoom);
      clearTimeout(panelPlaylistTimer);
      panelPlaylistTimer = setTimeout(function () { advance(token); }, Math.max(5, Number(item.durationSeconds || 30)) * 1000);
    }
    playCurrent(panelPlaylistState.token);
  }

  function loadRtsp(panel) {
    var generation = ++playbackGeneration;
    clearTimeout(directTimer); clearTimeout(frameTimer);
    frame.onload = null; frame.onerror = null;
    clearPanelError();
    clearTimeout(imageTimer);
    resetZoom();
    frame.style.display = "none";
    stopServerImage();
    stopVideo();
    videoPlayer.style.display = "block";
    applyZoom(videoPlayer, effectiveZoom(panel.zoom));
    videoPlayer.onerror = function () {
      if (generation !== playbackGeneration) return;
      state.lastError = "Fluxo RTSP/HLS indisponivel";
      showPanelError(state.lastError);
      setTimeout(function () {
        if (generation === playbackGeneration && state.playbackMode === "rtsp") {
          videoPlayer.src = joinUrl(settings.serverUrl, "/stream/" + panel.id + "/index.m3u8?" + playbackQuery() + "&t=" + Date.now());
          videoPlayer.load();
          videoPlayer.play();
        }
      }, 3000);
    };
    videoPlayer.onplaying = function () { clearPanelError(); showMessage(""); };
    videoPlayer.src = joinUrl(settings.serverUrl, "/stream/" + panel.id + "/index.m3u8?" + playbackQuery() + "&t=" + Date.now());
    videoPlayer.load();
    var promise = videoPlayer.play();
    if (promise && promise.catch) promise.catch(function () { showMessage("Iniciando fluxo de video"); });
  }

  function applyCommand(command) {
    if (!command || command.id && handledCommandIds[command.id]) return;
    if (command.id) {
      handledCommandIds[command.id] = true;
      handledCommandOrder.push(command.id);
      if (handledCommandOrder.length > 100) delete handledCommandIds[handledCommandOrder.shift()];
    }
    var navigationGeneration = navigationCommandGeneration;
    if (command.type === "setPanel" || command.type === "reload") navigationGeneration = ++navigationCommandGeneration;
    if (command.type === "setZoom") zoomCommandGeneration += 1;
    executeCommand(command, function () {}, navigationGeneration, zoomCommandGeneration);
  }

  function executeCommand(command, done, navigationGeneration, commandZoomGeneration) {
    if (command.type === "setPanel") {
      getJson(tvStatePath(), function (err, serverState) {
        if (navigationGeneration !== navigationCommandGeneration) { done(false); return; }
        if (err) {
          state.lastError = err.message;
          showMessage(err.message);
          done(false);
          return;
        }
        var panel = null;
        for (var i = 0; i < serverState.panels.length; i += 1) {
          if (serverState.panels[i].id === command.panelId) panel = serverState.panels[i];
        }
        if (!panel) {
          state.lastError = "Painel nao encontrado";
          showPanelError(state.lastError);
          done(false);
          return;
        }
        state.currentPanelId = panel.id;
        state.playbackMode = command.playbackMode || panel.mode || "direct";
        if (state.playbackMode !== "panel_playlist") stopPanelPlaylist();
        state.zoom = Number(panel.zoom || 1);
        if (commandZoomGeneration === zoomCommandGeneration) state.tvZoom = Number(command.tvZoom || command.zoom || state.tvZoom || 1);
        state.lastError = "";
        if (state.playbackMode === "server_image") loadServerImage(panel.id, panel.refreshSeconds, panel.zoom);
        else if (state.playbackMode === "legacy_videowall") loadLegacyWall(panel.id, panel.zoom);
        else if (state.playbackMode === "video") loadVideo(panel, serverState);
        else if (state.playbackMode === "playlist") loadPlaylist(panel, serverState);
        else if (state.playbackMode === "panel_playlist") loadPanelPlaylist(panel, serverState);
        else if (state.playbackMode === "rtsp") loadRtsp(panel);
        else loadDirect(panel.url, panel.zoom);
        sendHeartbeat();
        done(true);
      });
      return;
    }
    if (command.type === "setZoom") {
      state.tvZoom = Number(command.zoom || 1);
      if (state.playbackMode === "server_image" && state.currentPanelId) {
        loadServerImage(state.currentPanelId, 2, state.zoom);
      } else if (state.playbackMode === "legacy_videowall" && state.currentPanelId) {
        loadLegacyWall(state.currentPanelId, state.zoom);
      } else if ((state.playbackMode === "video" || state.playbackMode === "playlist" || state.playbackMode === "rtsp") && videoPlayer.style.display === "block") {
        applyZoom(videoPlayer, effectiveZoom(state.zoom));
      } else if (frame.style.display === "block") {
        applyZoom(frame, effectiveZoom(state.zoom));
      } else if (serverImage.style.display === "block") {
        applyImageZoom(serverImage, state.tvZoom);
      }
      sendHeartbeat();
      done(true);
      return;
    }
    if (command.type === "reload") {
      if (state.playbackMode === "server_image" && state.currentPanelId) loadServerImage(state.currentPanelId, 2, state.zoom);
      else if (state.playbackMode === "legacy_videowall" && state.currentPanelId) loadLegacyWall(state.currentPanelId, state.zoom);
      else if (state.playbackMode === "rtsp" && state.currentPanelId) loadRtsp({ id: state.currentPanelId, zoom: state.zoom });
      else if ((state.playbackMode === "video" || state.playbackMode === "playlist") && state.currentPanelId) {
        getJson(tvStatePath(), function (err, serverState) {
          if (navigationGeneration !== navigationCommandGeneration) { done(false); return; }
          if (err) { showMessage(err.message); done(false); return; }
          var panel = null;
          for (var i = 0; i < serverState.panels.length; i += 1) if (serverState.panels[i].id === state.currentPanelId) panel = serverState.panels[i];
          if (panel) {
            if (state.playbackMode === "video") loadVideo(panel, serverState);
            else loadPlaylist(panel, serverState);
          }
          done(Boolean(panel));
        });
        return;
      }
      else frame.src = frame.src;
      done(true);
      return;
    }
    if (command.type === "identify") {
      identify.textContent = settings.name + "\n" + settings.id;
      identify.hidden = false;
      setTimeout(function () { identify.hidden = true; }, 8000);
      done(true);
      return;
    }
    done(true);
  }

  setupForm.onsubmit = function (event) {
    event.preventDefault();
    var serverUrl = normalizeServerUrl(setupForm.elements.serverUrl.value);
    var name = setupForm.elements.name.value;
    saveSettings({
      serverUrl: serverUrl,
      name: name,
      id: settings.id,
      token: settings.token,
      platform: settings.platform,
      launcherVersion: settings.launcherVersion
    });
    start();
  };

  function boot() {
    if (settings.serverUrl && settings.name) {
      setupForm.elements.serverUrl.value = normalizeServerUrl(settings.serverUrl);
      setupForm.elements.name.value = settings.name;
      start();
    }
  }

  if (document.readyState === "complete") setTimeout(boot, 0);
  else window.addEventListener("load", boot);
})();
