(function () {
  var state = { tvs: [], groups: [], panels: [], webosDevices: [], tizenDevices: [], androidDevices: [], media: [], playlists: [], panelPlaylists: [] };
  var tvGrid = document.getElementById("tvGrid");
  var tvTemplate = document.getElementById("tvTemplate");
  var panelList = document.getElementById("panelList");
  var groupList = document.getElementById("groupList");
  var groupFilter = document.getElementById("groupFilter");
  var serverStatus = document.getElementById("serverStatus");
  var receiverUrl = document.getElementById("receiverUrl");
  var webosGrid = document.getElementById("webosGrid");
  var tizenGrid = document.getElementById("tizenGrid");
  var androidGrid = document.getElementById("androidGrid");
  var remoteDialog = document.getElementById("remoteDialog");
  var remotePanelId = "";
  var remotePreviewTimer = null;
  var remotePreviewController = null;
  var remoteObjectUrl = "";
  var remoteActionChain = Promise.resolve();
  var remoteLogEntries = [];
  var activeViewId = "dashboardView";
  var renderSignatures = { dashboard: "", resources: "", webos: "", tizen: "", android: "" };
  var previewQueue = [];
  var activePreviewRequests = 0;
  var previewControllers = [];
  var PREVIEW_CONCURRENCY = 2;
  var previewObserver = window.IntersectionObserver ? new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var img = entry.target;
      previewObserver.unobserve(img);
      enqueuePreview(img);
    });
  }, { rootMargin: "220px" }) : null;
  var mediaGrid = document.getElementById("mediaGrid");
  var playlistList = document.getElementById("playlistList");
  var panelPlaylistList = document.getElementById("panelPlaylistList");
  var loadRequest = null;
  var currentMe = null;
  var users = [];
  var liveUpdatesStarted = false;
  var csrfToken = "";
  var feedbackTimer = null;

  receiverUrl.textContent = window.location.origin + "/receiver";

  function dashboardIsVisible() {
    return activeViewId === "dashboardView" && !document.hidden;
  }

  function previewIsVisible(img) {
    if (!img || !img.isConnected || !dashboardIsVisible()) return false;
    var rect = img.getBoundingClientRect();
    return rect.bottom >= -220 && rect.top <= window.innerHeight + 220;
  }

  function forgetPreviewController(controller) {
    previewControllers = previewControllers.filter(function (item) { return item !== controller; });
  }

  function swapPreviewImage(img, blob) {
    if (!img.isConnected) return;
    var objectUrl = URL.createObjectURL(blob);
    var preload = new Image();
    preload.onload = function () {
      if (!img.isConnected) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      var oldUrl = img.getAttribute("data-object-url");
      img.src = objectUrl;
      img.setAttribute("data-object-url", objectUrl);
      img.removeAttribute("data-preview-error");
      if (oldUrl) URL.revokeObjectURL(oldUrl);
    };
    preload.onerror = function () { URL.revokeObjectURL(objectUrl); };
    preload.src = objectUrl;
  }

  function runPreviewQueue() {
    while (activePreviewRequests < PREVIEW_CONCURRENCY && previewQueue.length) {
      var img = previewQueue.shift();
      if (!previewIsVisible(img)) {
        if (img) img.removeAttribute("data-preview-queued");
        continue;
      }
      activePreviewRequests += 1;
      var controller = window.AbortController ? new AbortController() : null;
      if (controller) previewControllers.push(controller);
      (function (target, requestController) {
        var options = { cache: "no-store" };
        if (requestController) options.signal = requestController.signal;
        fetch(target.getAttribute("data-src") + "?t=" + Date.now(), options).then(function (response) {
          if (!response.ok) throw new Error("Preview HTTP " + response.status);
          return response.blob();
        }).then(function (blob) {
          if (previewIsVisible(target)) swapPreviewImage(target, blob);
        }).catch(function (error) {
          if (!error || error.name !== "AbortError") target.setAttribute("data-preview-error", "true");
        }).finally(function () {
          target.removeAttribute("data-preview-queued");
          activePreviewRequests = Math.max(0, activePreviewRequests - 1);
          if (requestController) forgetPreviewController(requestController);
          runPreviewQueue();
        });
      })(img, controller);
    }
  }

  function enqueuePreview(img) {
    if (!previewIsVisible(img) || img.getAttribute("data-preview-queued") === "true") return;
    img.setAttribute("data-preview-queued", "true");
    previewQueue.push(img);
    runPreviewQueue();
  }

  function stopPreviewWork() {
    previewQueue.forEach(function (img) { if (img) img.removeAttribute("data-preview-queued"); });
    previewQueue = [];
    previewControllers.forEach(function (controller) { controller.abort(); });
    previewControllers = [];
  }

  function releaseDashboardPreviews() {
    stopPreviewWork();
    var images = document.querySelectorAll("#tvGrid .preview img[data-object-url]");
    for (var index = 0; index < images.length; index += 1) {
      URL.revokeObjectURL(images[index].getAttribute("data-object-url"));
    }
  }

  function refreshVisiblePreviews() {
    if (!dashboardIsVisible()) return;
    var images = document.querySelectorAll("#tvGrid .preview img");
    for (var index = 0; index < images.length; index += 1) enqueuePreview(images[index]);
  }

  function api(path, options) {
    var controller = window.AbortController ? new AbortController() : null;
    var timeout = setTimeout(function () { if (controller) controller.abort(); }, 12000);
    var requestOptions = Object.assign({
      headers: { "content-type": "application/json" }
    }, options || {});
    requestOptions.headers = Object.assign({}, requestOptions.headers || {});
    if (csrfToken && !["GET", "HEAD", "OPTIONS"].includes(String(requestOptions.method || "GET").toUpperCase())) {
      requestOptions.headers["x-dvs-csrf"] = csrfToken;
    }
    if (controller) requestOptions.signal = controller.signal;
    return fetch(path, requestOptions).then(function (res) {
      return res.text().then(function (text) {
        var body;
        try { body = text ? JSON.parse(text) : {}; }
        catch (_) { body = { error: text || "Resposta invalida do servidor" }; }
        if (res.status === 401) {
          location.href = "/admin";
          return body;
        }
        if (!res.ok) {
          var message = body.error || "Erro na requisicao";
          if (body.code) message += " [" + body.code + "]";
          if (body.requestId) message += " | ID " + body.requestId;
          var error = new Error(message);
          error.code = body.code || "";
          error.needsPair = Boolean(body.needsPair);
          throw error;
        }
        if (body.csrfToken) csrfToken = body.csrfToken;
        return body;
      });
    }).catch(function (err) {
      if (err && err.name === "AbortError") throw new Error("O servidor nao respondeu em 12 segundos");
      throw err;
    }).finally(function () {
      clearTimeout(timeout);
    });
  }

  function byId(list, id) {
    return list.filter(function (item) { return item.id === id; })[0];
  }

  function compareName(left, right) {
    return String(left && left.name || "").localeCompare(String(right && right.name || ""), "pt-BR", { sensitivity: "base", numeric: true });
  }

  function sortNamed(list) {
    return (list || []).slice().sort(compareName);
  }

  function showResourceFeedback(message, type) {
    var feedback = document.getElementById("resourceFeedback");
    if (!feedback) return;
    clearTimeout(feedbackTimer);
    feedback.textContent = message || "";
    feedback.className = "resource-feedback" + (type ? " " + type : "");
    if (message) feedbackTimer = setTimeout(function () {
      feedback.textContent = "";
      feedback.className = "resource-feedback";
    }, 5000);
  }

  function showResourceError(error) {
    showResourceFeedback(error && error.message ? error.message : String(error || "Nao foi possivel concluir a operacao"), "error");
  }

  function groupName(id) {
    var group = byId(state.groups, id);
    return group ? group.name : "Sem grupo";
  }

  function modeName(mode) {
    if (mode === "server_image") return "Renderizado";
    if (mode === "legacy_videowall") return "VideoWall legado";
    if (mode === "playlist") return "Lista de videos";
    if (mode === "panel_playlist") return "Playlist de paineis";
    if (mode === "video") return "Video";
    if (mode === "rtsp") return "RTSP via servidor";
    return "Direto";
  }

  function zoomName(value) {
    return Math.round(Number(value || 1) * 100) + "%";
  }

  function formatDateTimeLocal(iso) {
    if (!iso) return "";
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    var offset = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
  }

  function formatMetricBytes(bytes) {
    bytes = Number(bytes || 0);
    if (!Number.isFinite(bytes)) return "0 B";
    if (bytes < 1024) return Math.round(bytes) + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
    return (bytes / 1024 / 1024 / 1024).toFixed(1) + " GB";
  }

  function timeAgo(iso) {
    if (!iso) return "Nunca visto";
    var seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (seconds < 60) return seconds + "s atras";
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + "min atras";
    return Math.floor(minutes / 60) + "h atras";
  }

  function updateMetrics() {
    document.getElementById("metricOnline").textContent = state.tvs.filter(function (tv) { return tv.status === "online"; }).length;
    document.getElementById("metricTvs").textContent = state.tvs.length;
    document.getElementById("metricPanels").textContent = state.panels.length;
    document.getElementById("metricErrors").textContent = state.tvs.filter(function (tv) { return Boolean(tv.lastError); }).length;
    document.getElementById("tvSubtitle").textContent = state.tvs.length + " TVs cadastradas, " + state.panels.length + " paineis disponiveis";
  }

  function renderServerMetrics(metrics) {
    if (!document.getElementById("serverCpu")) return;
    var cpu = Math.max(0, Math.min(100, Number(metrics.cpuPercent || 0)));
    var memory = metrics.memory || {};
    var memoryPercent = Math.max(0, Math.min(100, Number(memory.percent || 0)));
    var network = metrics.network || {};
    document.getElementById("serverCpu").textContent = cpu.toFixed(1).replace(".0", "") + "%";
    document.getElementById("serverCpuBar").style.width = cpu + "%";
    document.getElementById("serverMemory").textContent = memoryPercent.toFixed(1).replace(".0", "") + "%";
    document.getElementById("serverMemoryDetail").textContent = formatMetricBytes(memory.used) + " de " + formatMetricBytes(memory.total);
    document.getElementById("serverMemoryBar").style.width = memoryPercent + "%";
    if (network.available) {
      document.getElementById("serverNetwork").textContent = formatMetricBytes(network.bytesPerSecond) + "/s";
      document.getElementById("serverNetworkDetail").textContent = "RX " + formatMetricBytes(network.receivedBytesPerSecond) + "/s | TX " + formatMetricBytes(network.sentBytesPerSecond) + "/s";
      document.getElementById("serverMetricsStatus").textContent = "Amostrando";
      document.getElementById("serverMetricsStatus").className = "status-pill online";
    } else {
      document.getElementById("serverNetwork").textContent = "Indisponivel";
      document.getElementById("serverNetworkDetail").textContent = "Contador de rede nao disponivel neste host";
      document.getElementById("serverMetricsStatus").textContent = "Parcial";
      document.getElementById("serverMetricsStatus").className = "status-pill";
    }
    document.getElementById("serverMetricsUpdated").textContent = metrics.sampledAt ? "Amostra de " + new Date(metrics.sampledAt).toLocaleTimeString("pt-BR") : "Aguardando amostra";
  }

  function renderGroups() {
    var selected = groupFilter.value || "all";
    groupFilter.innerHTML = '<option value="all">Todos os grupos</option>';
    sortNamed(state.groups).forEach(function (group) {
      var option = document.createElement("option");
      option.value = group.id;
      option.textContent = group.name;
      groupFilter.appendChild(option);
    });
    groupFilter.value = selected;

    groupList.innerHTML = "";
    sortNamed(state.groups).forEach(function (group) {
      var row = document.createElement("div");
      row.className = "row";
      row.innerHTML = "<div><strong></strong><small></small></div>";
      row.querySelector("strong").textContent = group.name;
      row.querySelector("small").textContent = state.tvs.filter(function (tv) { return tv.groupId === group.id; }).length + " TVs";
      if (group.id !== "default") {
        var remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "Excluir";
        remove.onclick = function () {
          if (!confirm("Excluir o grupo " + group.name + "? As TVs serao movidas para Principal.")) return;
          api("/api/groups/" + group.id, { method: "DELETE" }).then(function () {
            showResourceFeedback("Grupo excluido e TVs movidas para Principal.", "success");
            return load();
          }).catch(showResourceError);
        };
        row.appendChild(remove);
      }
      groupList.appendChild(row);
    });
  }

  function renderPanels() {
    panelList.innerHTML = "";
    document.getElementById("panelCatalogCount").textContent = state.panels.length + (state.panels.length === 1 ? " item" : " itens");
    if (!state.panels.length) {
      panelList.innerHTML = '<div class="row"><div><strong>Nenhum painel cadastrado</strong><small>Cadastre uma URL para enviar as TVs.</small></div></div>';
      return;
    }
    sortNamed(state.panels).forEach(function (panel) {
      var row = document.createElement("div");
      row.className = "row";
      var label = document.createElement("div");
      label.innerHTML = "<strong></strong><small></small><span class='tag'></span>";
      label.querySelector("strong").textContent = panel.name;
      if (panel.mode === "rtsp") label.querySelector("small").textContent = "Fonte RTSP protegida e convertida para HLS";
      else if (panel.mode === "playlist") {
        var panelPlaylist = byId(state.playlists, panel.playlistId);
        label.querySelector("small").textContent = panelPlaylist ? panelPlaylist.name : "Lista nao encontrada";
      } else if (panel.mode === "panel_playlist") {
        var linkPlaylist = byId(state.panelPlaylists, panel.panelPlaylistId);
        label.querySelector("small").textContent = linkPlaylist ? linkPlaylist.name : "Playlist de paineis nao encontrada";
      } else if (panel.mode === "video") {
        var panelMedia = byId(state.media, panel.mediaId);
        label.querySelector("small").textContent = panelMedia ? panelMedia.name + (panel.loop === false ? " | executar uma vez" : " | loop") : "Video nao encontrado";
      } else label.querySelector("small").textContent = panel.url;
      label.querySelector(".tag").textContent = modeName(panel.mode) + " | Zoom " + zoomName(panel.zoom);
      if (panel.renderStatus && panel.renderStatus.error) {
        var error = document.createElement("span");
        error.className = "tag error";
        error.textContent = "Render: " + panel.renderStatus.error;
        label.appendChild(error);
      }
      var actions = document.createElement("div");
      actions.className = "row-actions";
      var edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "Editar";
      edit.onclick = function () { editPanel(panel); };
      var playlistManaged = panel.mode === "playlist" && Boolean(byId(state.playlists, panel.playlistId)) || panel.mode === "panel_playlist" && Boolean(byId(state.panelPlaylists, panel.panelPlaylistId));
      if ((!currentMe || currentMe.role !== "operator") && !playlistManaged) actions.appendChild(edit);
      if (panel.mode === "server_image") {
        var interact = document.createElement("button");
        interact.type = "button";
        interact.textContent = "Interagir";
        interact.onclick = function () { openRemote(panel); };
        actions.appendChild(interact);
      }
      var remove = document.createElement("button");
      remove.textContent = "Excluir";
      remove.onclick = function () {
        if (!confirm("Excluir o painel " + panel.name + "? TVs que o utilizam ficarao sem conteudo atribuido.")) return;
        api("/api/panels/" + panel.id, { method: "DELETE" }).then(function () {
          showResourceFeedback("Painel excluido.", "success");
          return load();
        }).catch(showResourceError);
      };
      if ((!currentMe || currentMe.role !== "operator") && !playlistManaged) actions.appendChild(remove);
      if (playlistManaged) {
        var managed = document.createElement("span");
        managed.className = "tag managed-tag";
        managed.textContent = "Gerenciado em Playlists";
        actions.appendChild(managed);
      }
      row.appendChild(label);
      row.appendChild(actions);
      panelList.appendChild(row);
    });
  }

  function editPanel(panel) {
    var form = document.getElementById("panelForm");
    form.dataset.panelId = panel.id;
    form.elements.name.value = panel.name;
    form.elements.url.value = panel.url;
    form.elements.mode.value = panel.mode;
    form.elements.playlistId.value = panel.playlistId || "";
    form.elements.panelPlaylistId.value = panel.panelPlaylistId || "";
    form.elements.mediaId.value = panel.mediaId || "";
    form.elements.videoLoop.checked = panel.loop !== false;
    form.elements.zoom.value = panel.zoom || 1;
    form.elements.authEnabled.checked = Boolean(panel.auth && panel.auth.enabled);
    form.elements.authUsername.value = "";
    form.elements.authPassword.value = "";
    form.elements.usernameSelector.value = panel.auth && panel.auth.usernameSelector || "";
    form.elements.passwordSelector.value = panel.auth && panel.auth.passwordSelector || "";
    form.elements.submitSelector.value = panel.auth && panel.auth.submitSelector || "";
    document.getElementById("zoomValue").textContent = zoomName(panel.zoom);
    document.getElementById("cancelPanelEdit").hidden = false;
    updatePanelMode();
    form.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function applyPreviewZoom(img, zoom) {
    zoom = Math.max(0.25, Math.min(3, Number(zoom || 1)));
    img.style.transformOrigin = "0 0";
    img.style.transform = "scale(" + zoom + ")";
    img.style.webkitTransformOrigin = "0 0";
    img.style.webkitTransform = "scale(" + zoom + ")";
  }

  function previewFor(panel, preview, tv) {
    if (!panel) {
      preview.textContent = "Sem painel atribuido";
      return;
    }
    var tvZoom = Number(tv && tv.zoom || 1);
    if (panel.mode === "video") {
      var directMedia = byId(state.media, panel.mediaId);
      if (!directMedia) { preview.textContent = "Video nao encontrado"; return; }
      var directVideo = document.createElement("video");
      directVideo.src = directMedia.url;
      directVideo.muted = true;
      directVideo.autoplay = true;
      directVideo.loop = panel.loop !== false;
      directVideo.playsInline = true;
      preview.innerHTML = "";
      preview.appendChild(directVideo);
      return;
    }
    if (panel.mode === "playlist") {
      var playlist = byId(state.playlists, panel.playlistId);
      var firstMedia = playlist && playlist.items.length ? byId(state.media, playlist.items[0]) : null;
      if (!firstMedia) {
        preview.textContent = "Lista sem videos";
        return;
      }
      var video = document.createElement("video");
      video.src = firstMedia.url;
      video.muted = true;
      video.autoplay = true;
      video.loop = true;
      video.playsInline = true;
      preview.innerHTML = "";
      preview.appendChild(video);
      return;
    }
    var img = document.createElement("img");
    var badge = document.createElement("span");
    img.alt = "Preview do painel";
    img.loading = "lazy";
    img.decoding = "async";
    img.setAttribute("data-src", "/panel-preview/" + panel.id);
    badge.className = "preview-zoom";
    badge.textContent = "Painel " + zoomName(panel.zoom) + " | TV " + zoomName(tvZoom);
    preview.innerHTML = "";
    preview.appendChild(img);
    preview.appendChild(badge);
    applyPreviewZoom(img, tvZoom);
    if (previewObserver) previewObserver.observe(img);
    else enqueuePreview(img);
  }

  function sendTvZoom(tv, value, label) {
    label.textContent = zoomName(value);
    clearTimeout(label._zoomTimer);
    label._zoomTimer = setTimeout(function () {
      api("/api/tvs/" + tv.id + "/command", {
        method: "POST",
        body: JSON.stringify({ type: "setZoom", zoom: Number(value) })
      }).then(load).catch(alert);
    }, 250);
  }

  function renderTvs() {
    releaseDashboardPreviews();
    tvGrid.innerHTML = "";
    var filter = groupFilter.value || "all";
    var tvs = sortNamed(state.tvs).filter(function (tv) {
      return filter === "all" || tv.groupId === filter;
    });
    if (!tvs.length) {
      tvGrid.innerHTML = '<div class="panel">Nenhuma TV cadastrada neste filtro.</div>';
      return;
    }
    tvs.forEach(function (tv) {
      var node = tvTemplate.content.firstElementChild.cloneNode(true);
      node.setAttribute("data-tv-id", tv.id);
      var panel = byId(state.panels, tv.currentPanelId);
      node.querySelector("h3").textContent = tv.name;
      node.querySelector(".meta").textContent = groupName(tv.groupId) + " | " + tv.status + (tv.ip ? " | " + tv.ip : "");
      node.querySelector(".status-dot").className = "status-dot " + tv.status;
      node.querySelector(".panel-name").textContent = panel ? panel.name + " (" + modeName(panel.mode) + ")" : "Sem painel";
      node.querySelector(".last-seen").textContent = timeAgo(tv.lastSeen);
      node.querySelector(".error-line").textContent = tv.lastError || "";
      previewFor(panel, node.querySelector(".preview"), tv);

      var tvName = node.querySelector(".tvName");
      var tvGroup = node.querySelector(".tvGroup");
      tvName.value = tv.name;
      tvGroup.innerHTML = "";
      sortNamed(state.groups).forEach(function (group) {
        var option = document.createElement("option");
        option.value = group.id;
        option.textContent = group.name;
        tvGroup.appendChild(option);
      });
      tvGroup.value = tv.groupId || "default";
      node.querySelector(".saveTv").onclick = function () {
        api("/api/tvs/" + tv.id, {
          method: "PATCH",
          body: JSON.stringify({ name: tvName.value, groupId: tvGroup.value })
        }).then(load).catch(alert);
      };
      node.querySelector(".deleteTv").onclick = function () {
        if (!confirm("Remover a TV cadastrada \"" + tv.name + "\"?")) return;
        api("/api/tvs/" + tv.id, { method: "DELETE" }).then(load).catch(alert);
      };

      var tvZoom = node.querySelector(".tvZoom");
      var tvZoomValue = node.querySelector(".tvZoomValue");
      tvZoom.value = Number(tv.zoom || 1);
      tvZoomValue.textContent = zoomName(tv.zoom || 1);
      tvZoom.oninput = function () {
        sendTvZoom(tv, tvZoom.value, tvZoomValue);
      };

      var select = node.querySelector(".panelSelect");
      select.innerHTML = '<option value="">Selecione um painel</option>';
      sortNamed(state.panels).forEach(function (item) {
        var option = document.createElement("option");
        option.value = item.id;
        option.textContent = item.name + " - " + modeName(item.mode);
        select.appendChild(option);
      });
      select.value = tv.currentPanelId || "";

      node.querySelector(".send").onclick = function () {
        if (!select.value) return;
        var selected = byId(state.panels, select.value);
        api("/api/tvs/" + tv.id + "/command", {
          method: "POST",
          body: JSON.stringify({ type: "setPanel", panelId: select.value, playbackMode: selected.mode })
        }).then(load).catch(alert);
      };
      node.querySelector(".reload").onclick = function () {
        api("/api/tvs/" + tv.id + "/command", {
          method: "POST",
          body: JSON.stringify({ type: "reload" })
        }).catch(alert);
      };
      node.querySelector(".identify").onclick = function () {
        api("/api/tvs/" + tv.id + "/command", {
          method: "POST",
          body: JSON.stringify({ type: "identify" })
        }).catch(alert);
      };
      tvGrid.appendChild(node);
    });
  }

  function updateTvTelemetry() {
    sortNamed(state.tvs).forEach(function (tv) {
      var node = tvGrid.querySelector('[data-tv-id="' + tv.id + '"]');
      if (!node) return;
      node.querySelector(".meta").textContent = groupName(tv.groupId) + " | " + tv.status + (tv.ip ? " | " + tv.ip : "");
      node.querySelector(".status-dot").className = "status-dot " + tv.status;
      node.querySelector(".last-seen").textContent = timeAgo(tv.lastSeen);
      node.querySelector(".error-line").textContent = tv.lastError || "";
    });
  }

  function renderWebos() {
    var linkSelect = document.getElementById("webosForm").elements.linkedTvId;
    var selected = linkSelect.value;
    linkSelect.innerHTML = '<option value="">Sem vinculo</option>';
    state.tvs.forEach(function (tv) {
      var option = document.createElement("option");
      option.value = tv.id;
      option.textContent = tv.name;
      linkSelect.appendChild(option);
    });
    linkSelect.value = selected;
    webosGrid.innerHTML = "";
    if (!state.webosDevices.length) {
      webosGrid.innerHTML = '<div class="empty-state">Nenhuma TV configurada no gerenciador webOS.</div>';
      return;
    }
    sortNamed(state.webosDevices).forEach(function (device) {
      var node = document.getElementById("webosTemplate").content.firstElementChild.cloneNode(true);
      var linked = byId(state.tvs, device.linkedTvId);
      node.querySelector("h3").textContent = device.name;
      node.querySelector(".device-address").textContent = device.username + "@" + device.host + ":" + device.port;
      node.querySelector(".device-meta").textContent = (linked ? "Receiver: " + linked.name : "Sem receiver vinculado") + " | TV: " + (device.powerState === "online" ? "acessivel" : device.powerState === "offline" ? "desligada ou inacessivel" : "nao verificada") + " | Inicio automatico: " + (device.autoLaunch ? "ativo" : "desativado") + (device.lastAutoLaunchAt ? " | Ultimo inicio: " + timeAgo(device.lastAutoLaunchAt) : "");
      var deviceLink = node.querySelector(".device-link");
      deviceLink.innerHTML = '<option value="">Sem receiver vinculado</option>';
      state.tvs.forEach(function (tv) {
        var option = document.createElement("option");
        option.value = tv.id;
        option.textContent = tv.name;
        deviceLink.appendChild(option);
      });
      deviceLink.value = device.linkedTvId || "";
      var autoRenew = node.querySelector(".device-auto-renew");
      var autoLaunch = node.querySelector(".device-auto-launch");
      autoRenew.checked = device.autoRenew;
      autoLaunch.checked = device.autoLaunch;
      deviceLink.onchange = saveDeviceSettings;
      autoRenew.onchange = saveDeviceSettings;
      autoLaunch.onchange = saveDeviceSettings;
      function saveDeviceSettings() {
        api("/api/webos/devices/" + device.id, {
          method: "PATCH",
          body: JSON.stringify({ linkedTvId: deviceLink.value, autoRenew: autoRenew.checked, autoLaunch: autoLaunch.checked })
        }).then(load).catch(function (err) { alert(err.message); });
      }
      node.querySelector(".device-result").textContent = device.lastError || device.lastResult || "Aguardando operacao";
      var updateStatus = node.querySelector(".system-update-status");
      var updateTime = node.querySelector(".system-update-time");
      updateStatus.textContent = (device.scheduledSystemUpdateAt ? "Agendada para " + new Date(device.scheduledSystemUpdateAt).toLocaleString("pt-BR") + " | " : "") + (device.lastSystemUpdateCheckAt ? "Verificada " + timeAgo(device.lastSystemUpdateCheckAt) : "Nao verificada");
      updateTime.value = formatDateTimeLocal(device.scheduledSystemUpdateAt);
      node.querySelector(".device-state").textContent = device.lastError ? "Atencao" : device.lastAction ? "Pronta" : "Cadastrada";
      if (device.lastError) node.querySelector(".device-state").className = "device-state tag error";
      var buttons = node.querySelectorAll("[data-action]");
      for (var i = 0; i < buttons.length; i += 1) buttons[i].onclick = function (event) { runWebosAction(device, event.currentTarget); };
      webosGrid.appendChild(node);
    });
  }

  function fillTvLinks(select, selected) {
    select.innerHTML = '<option value="">Sem receiver vinculado</option>';
    sortNamed(state.tvs).forEach(function (tv) {
      var option = document.createElement("option");
      option.value = tv.id;
      option.textContent = tv.name;
      select.appendChild(option);
    });
    select.value = selected || "";
  }

  function renderTizen() {
    var formLink = document.getElementById("tizenForm").elements.linkedTvId;
    fillTvLinks(formLink, formLink.value);
    tizenGrid.innerHTML = "";
    if (!state.tizenDevices.length) {
      tizenGrid.innerHTML = '<div class="empty-state">Nenhuma TV Samsung configurada. Ative o Developer Mode e cadastre o IP acima.</div>';
      return;
    }
    sortNamed(state.tizenDevices).forEach(function (device) {
      var node = document.getElementById("tizenTemplate").content.firstElementChild.cloneNode(true);
      var linked = byId(state.tvs, device.linkedTvId);
      node.querySelector("h3").textContent = device.name;
      node.querySelector(".device-address").textContent = (device.serial || device.host + ":" + device.port) + " | SDB";
      node.querySelector(".device-meta").textContent = (linked ? "Receiver: " + linked.name : "Sem receiver vinculado") + " | Inicio automatico: " + (device.autoLaunch ? "ativo" : "desativado");
      var link = node.querySelector(".device-link");
      var profile = node.querySelector(".device-profile");
      var autoLaunch = node.querySelector(".device-auto-launch");
      fillTvLinks(link, device.linkedTvId);
      profile.value = device.profile || "";
      autoLaunch.checked = device.autoLaunch;
      node.querySelector(".save-tizen").onclick = function () {
        api("/api/tizen/devices/" + device.id, {
          method: "PATCH",
          body: JSON.stringify({ linkedTvId: link.value, profile: profile.value, autoLaunch: autoLaunch.checked })
        }).then(load).catch(function (err) { alert(err.message); });
      };
      node.querySelector(".device-result").textContent = device.lastError || device.lastResult || "Aguardando operacao";
      node.querySelector(".device-state").textContent = device.lastError ? "Atencao" : device.lastAction ? "Pronta" : "Cadastrada";
      if (device.lastError) node.querySelector(".device-state").className = "device-state tag error";
      var buttons = node.querySelectorAll("[data-action]");
      for (var index = 0; index < buttons.length; index += 1) buttons[index].onclick = function (event) { runTizenAction(device, event.currentTarget, profile.value); };
      tizenGrid.appendChild(node);
    });
  }

  function renderAndroid() {
    var formLink = document.getElementById("androidForm").elements.linkedTvId;
    fillTvLinks(formLink, formLink.value);
    androidGrid.innerHTML = "";
    if (!state.androidDevices.length) {
      androidGrid.innerHTML = '<div class="empty-state">Nenhuma TV Android configurada. Ative ADB pela rede e cadastre o IP acima.</div>';
      return;
    }
    sortNamed(state.androidDevices).forEach(function (device) {
      var node = document.getElementById("androidTemplate").content.firstElementChild.cloneNode(true);
      var linked = byId(state.tvs, device.linkedTvId);
      node.querySelector("h3").textContent = device.name;
      node.querySelector(".device-address").textContent = (device.serial || device.host + ":" + device.port) + " | ADB";
      node.querySelector(".device-meta").textContent = (linked ? "Receiver: " + linked.name : "Sem receiver vinculado") + " | Inicio automatico: " + (device.autoLaunch ? "ativo" : "desativado");
      var link = node.querySelector(".device-link");
      var autoLaunch = node.querySelector(".device-auto-launch");
      fillTvLinks(link, device.linkedTvId);
      autoLaunch.checked = device.autoLaunch;
      node.querySelector(".save-android").onclick = function () {
        api("/api/android/devices/" + device.id, {
          method: "PATCH",
          body: JSON.stringify({ linkedTvId: link.value, autoLaunch: autoLaunch.checked })
        }).then(load).catch(function (err) { alert(err.message); });
      };
      node.querySelector(".device-result").textContent = device.lastError || device.lastResult || "Aguardando operacao";
      node.querySelector(".device-state").textContent = device.lastError ? "Atencao" : device.lastAction ? "Pronta" : "Cadastrada";
      if (device.lastError) node.querySelector(".device-state").className = "device-state tag error";
      var buttons = node.querySelectorAll("[data-action]");
      for (var index = 0; index < buttons.length; index += 1) buttons[index].onclick = function (event) { runAndroidAction(device, event.currentTarget); };
      androidGrid.appendChild(node);
    });
  }

  function formatBytes(bytes) {
    bytes = Number(bytes || 0);
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  function renderMedia() {
    mediaGrid.innerHTML = "";
    if (!state.media.length) mediaGrid.innerHTML = '<div class="empty-state">Nenhum video enviado.</div>';
    sortNamed(state.media).forEach(function (media) {
      var card = document.createElement("article");
      card.className = "media-card";
      card.innerHTML = '<video controls muted preload="metadata"></video><div class="media-card-body"><strong></strong><small></small><button type="button" class="danger-btn">Excluir</button></div>';
      card.querySelector("video").src = media.url;
      card.querySelector("strong").textContent = media.name;
      card.querySelector("small").textContent = media.fileName + " | " + formatBytes(media.size);
      card.querySelector("button").onclick = function () {
        if (!confirm("Excluir o video " + media.name + "?")) return;
        api("/api/media/" + media.id, { method: "DELETE" }).then(load).catch(function (err) { alert(err.message); });
      };
      mediaGrid.appendChild(card);
    });

    var options = document.getElementById("playlistMediaOptions");
    options.innerHTML = "";
    if (!state.media.length) options.innerHTML = '<div class="empty-state">Envie um video na aba Midias antes de criar a playlist.</div>';
    sortNamed(state.media).forEach(function (media, index) {
      var label = document.createElement("label");
      label.className = "media-option";
      label.innerHTML = '<input type="checkbox"><span class="order"></span><span class="media-option-name"></span>';
      label.querySelector("input").value = media.id;
      label.querySelector(".order").textContent = String(index + 1);
      label.querySelector(".media-option-name").textContent = media.name;
      options.appendChild(label);
    });

    playlistList.innerHTML = "";
    if (!state.playlists.length) playlistList.innerHTML = '<div class="empty-state">Nenhuma lista criada.</div>';
    sortNamed(state.playlists).forEach(function (playlist) {
      var row = document.createElement("div");
      row.className = "row";
      var names = playlist.items.map(function (mediaId) { var media = byId(state.media, mediaId); return media ? media.name : "Video removido"; });
      row.innerHTML = '<div><strong></strong><small></small><span class="tag"></span><span class="tag availability-tag">Disponivel no Dashboard</span></div><div class="row-actions"><button type="button" data-edit>Editar</button><button type="button" data-delete>Excluir</button></div>';
      row.querySelector("strong").textContent = playlist.name;
      row.querySelector("small").textContent = names.join(" -> ");
      row.querySelector(".tag").textContent = playlist.loop ? "Loop ativo" : "Executar uma vez";
      row.querySelector("[data-edit]").onclick = function () { editVideoPlaylist(playlist); };
      row.querySelector("[data-delete]").onclick = function () {
        if (!confirm("Excluir a playlist " + playlist.name + "? Ela deixara de estar disponivel para as TVs.")) return;
        api("/api/playlists/" + playlist.id, { method: "DELETE" }).then(function () {
          showResourceFeedback("Playlist de videos excluida.", "success");
          return load();
        }).catch(showResourceError);
      };
      playlistList.appendChild(row);
    });
    updatePlaylistSelect();
    updateTargetTvSelects();
    renderPanelPlaylists();
  }

  function editVideoPlaylist(playlist) {
    var form = document.getElementById("playlistForm");
    form.dataset.playlistId = playlist.id;
    form.elements.name.value = playlist.name;
    form.elements.loop.checked = playlist.loop !== false;
    form.elements.targetTvId.value = "";
    var checks = form.querySelectorAll('.playlist-options input[type="checkbox"]');
    for (var index = 0; index < checks.length; index += 1) checks[index].checked = playlist.items.indexOf(checks[index].value) >= 0;
    form.querySelector(".cancel-playlist-edit").hidden = false;
    form.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function renderPanelPlaylists() {
    var options = document.getElementById("panelPlaylistOptions");
    options.innerHTML = "";
    var availablePanels = sortNamed(state.panels).filter(function (panel) { return panel.mode !== "panel_playlist"; });
    if (!availablePanels.length) options.innerHTML = '<div class="empty-state">Cadastre um painel antes de criar esta playlist.</div>';
    availablePanels.forEach(function (panel, index) {
      var label = document.createElement("label");
      label.className = "media-option panel-playlist-option";
      label.innerHTML = '<input type="checkbox"><span class="order"></span><span class="media-option-name"></span><input class="panel-duration" type="number" min="5" max="86400" step="5" value="30" title="Tempo em segundos">';
      label.querySelector('input[type="checkbox"]').value = panel.id;
      label.querySelector(".order").textContent = String(index + 1);
      label.querySelector(".media-option-name").textContent = panel.name + " - " + modeName(panel.mode);
      options.appendChild(label);
    });

    panelPlaylistList.innerHTML = "";
    if (!state.panelPlaylists.length) panelPlaylistList.innerHTML = '<div class="empty-state">Nenhuma playlist de paineis criada.</div>';
    sortNamed(state.panelPlaylists).forEach(function (playlist) {
      var row = document.createElement("div");
      row.className = "row";
      var names = playlist.items.map(function (item) {
        var panel = byId(state.panels, item.panelId);
        return (panel ? panel.name : "Painel removido") + " (" + Number(item.durationSeconds || 30) + "s)";
      });
      row.innerHTML = '<div><strong></strong><small></small><span class="tag"></span><span class="tag availability-tag">Disponivel no Dashboard</span></div><div class="row-actions"><button type="button" data-edit>Editar</button><button type="button" data-delete>Excluir</button></div>';
      row.querySelector("strong").textContent = playlist.name;
      row.querySelector("small").textContent = names.join(" -> ");
      row.querySelector(".tag").textContent = playlist.loop ? "Loop ativo" : "Executar uma vez";
      row.querySelector("[data-edit]").onclick = function () { editPanelPlaylist(playlist); };
      row.querySelector("[data-delete]").onclick = function () {
        if (!confirm("Excluir a playlist " + playlist.name + "? Ela deixara de estar disponivel para as TVs.")) return;
        api("/api/panel-playlists/" + playlist.id, { method: "DELETE" }).then(function () {
          showResourceFeedback("Playlist de paineis excluida.", "success");
          return load();
        }).catch(showResourceError);
      };
      panelPlaylistList.appendChild(row);
    });
    updatePanelPlaylistSelect();
  }

  function editPanelPlaylist(playlist) {
    var form = document.getElementById("panelPlaylistForm");
    form.dataset.playlistId = playlist.id;
    form.elements.name.value = playlist.name;
    form.elements.loop.checked = playlist.loop !== false;
    form.elements.targetTvId.value = "";
    var checks = form.querySelectorAll('.playlist-options input[type="checkbox"]');
    for (var index = 0; index < checks.length; index += 1) {
      var item = playlist.items.filter(function (entry) { return entry.panelId === checks[index].value; })[0];
      checks[index].checked = Boolean(item);
      if (item) checks[index].closest(".panel-playlist-option").querySelector(".panel-duration").value = Number(item.durationSeconds || 30);
    }
    form.querySelector(".cancel-playlist-edit").hidden = false;
    form.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function updatePlaylistSelect() {
    var select = document.getElementById("panelForm").elements.playlistId;
    var selected = select.value;
    select.innerHTML = '<option value="">Selecione uma lista</option>';
    sortNamed(state.playlists).forEach(function (playlist) {
      var option = document.createElement("option");
      option.value = playlist.id;
      option.textContent = playlist.name;
      select.appendChild(option);
    });
    select.value = selected;
    var mediaSelect = document.getElementById("panelForm").elements.mediaId;
    var selectedMedia = mediaSelect.value;
    mediaSelect.innerHTML = '<option value="">Selecione um video</option>';
    sortNamed(state.media).forEach(function (media) {
      var mediaOption = document.createElement("option");
      mediaOption.value = media.id;
      mediaOption.textContent = media.name;
      mediaSelect.appendChild(mediaOption);
    });
    mediaSelect.value = selectedMedia;
  }

  function updatePanelPlaylistSelect() {
    var select = document.getElementById("panelForm").elements.panelPlaylistId;
    var selected = select.value;
    select.innerHTML = '<option value="">Selecione uma playlist de paineis</option>';
    sortNamed(state.panelPlaylists).forEach(function (playlist) {
      var option = document.createElement("option");
      option.value = playlist.id;
      option.textContent = playlist.name;
      select.appendChild(option);
    });
    select.value = selected;
  }

  function updateTargetTvSelects() {
    var selects = document.querySelectorAll('#playlistsResource select[name="targetTvId"]');
    for (var index = 0; index < selects.length; index += 1) {
      var selected = selects[index].value;
      selects[index].innerHTML = '<option value="">Somente disponibilizar</option>';
      sortNamed(state.tvs).forEach(function (tv) {
        var option = document.createElement("option");
        option.value = tv.id;
        option.textContent = tv.name + (tv.status === "online" ? " - online" : " - " + tv.status);
        selects[index].appendChild(option);
      });
      selects[index].value = selected;
    }
  }

  function updatePanelMode() {
    var form = document.getElementById("panelForm");
    var mode = form.elements.mode.value;
    var urlInput = form.elements.url;
    var playlistSelect = form.elements.playlistId;
    var panelPlaylistSelect = form.elements.panelPlaylistId;
    var mediaSelect = form.elements.mediaId;
    var videoLoop = form.querySelector("[data-video-loop]");
    playlistSelect.hidden = mode !== "playlist";
    playlistSelect.required = mode === "playlist";
    panelPlaylistSelect.hidden = mode !== "panel_playlist";
    panelPlaylistSelect.required = mode === "panel_playlist";
    mediaSelect.hidden = mode !== "video";
    mediaSelect.required = mode === "video";
    videoLoop.hidden = mode !== "video";
    urlInput.hidden = mode === "playlist" || mode === "panel_playlist" || mode === "video";
    urlInput.required = mode !== "playlist" && mode !== "panel_playlist" && mode !== "video" && !(mode === "rtsp" && form.dataset.panelId);
    urlInput.placeholder = mode === "rtsp" ? (form.dataset.panelId ? "RTSP salvo; deixe vazio para manter" : "rtsp://usuario:senha@camera:554/stream") : "http://servidor/painel";
  }

  function runWebosAction(device, button) {
    var action = button.getAttribute("data-action");
    if (action === "delete") {
      if (!confirm("Remover " + device.name + " do gerenciador webOS?")) return;
      api("/api/webos/devices/" + device.id, { method: "DELETE" }).then(load).catch(function (err) { alert(err.message); });
      return;
    }
    var scheduledAt = "";
    if (action === "schedule-system-update") {
      var card = button.closest(".device-card");
      var input = card && card.querySelector(".system-update-time");
      scheduledAt = input && input.value ? new Date(input.value).toISOString() : "";
      if (!scheduledAt) {
        alert("Informe a data e hora para atualizar o sistema da TV.");
        return;
      }
    }
    if (action === "start-system-update" && !confirm("Enviar o comando de atualizacao de sistema agora para " + device.name + "?")) return;
    var passphrase = "";
    if (action === "pair") {
      passphrase = prompt("Informe a passphrase exibida no Key Server da TV:") || "";
      if (!passphrase) return;
    }
    function run(passphraseValue) {
      return api("/api/webos/devices/" + device.id + "/action", {
        method: "POST",
        body: JSON.stringify({ action: action, passphrase: passphraseValue || "", scheduledAt: scheduledAt })
      });
    }
    var oldText = button.textContent;
    button.disabled = true;
    button.textContent = "Processando...";
    run(passphrase).catch(function (err) {
      if (action === "pair" || err.code !== "DVS_WEBOS_AUTH_FAILED" && !/autenticacao SSH|authentication methods failed/i.test(err.message || "")) throw err;
      var retryPassphrase = prompt("A chave SSH expirou. Informe a passphrase atual do Key Server para parear novamente:") || "";
      if (!retryPassphrase) throw err;
      return run(retryPassphrase);
    }).then(function (result) {
      alert(result.output || "Operacao concluida");
      return load();
    }).catch(function (err) {
      alert(err.message);
      return load();
    }).finally(function () {
      button.disabled = false;
      button.textContent = oldText;
    });
  }

  function runTizenAction(device, button, profile) {
    var action = button.getAttribute("data-action");
    if (action === "delete") {
      if (!confirm("Remover " + device.name + " do gerenciador Tizen?")) return;
      api("/api/tizen/devices/" + device.id, { method: "DELETE" }).then(load).catch(function (err) { alert(err.message); });
      return;
    }
    if ((action === "update" || action === "package") && !String(profile || "").trim()) {
      alert("Informe e salve um perfil de certificado Samsung antes de gerar o pacote.");
      return;
    }
    if (action === "uninstall" && !confirm("Desinstalar o DVS Receiver de " + device.name + "?")) return;
    var certificatePassword = "";
    if (action === "update" || action === "package") {
      certificatePassword = prompt("Senha do certificado Samsung do perfil " + profile + " (nao e a senha do DVS Controller):") || "";
      if (!certificatePassword) return;
    }
    var oldText = button.textContent;
    button.disabled = true;
    button.textContent = "Processando...";
    api("/api/tizen/devices/" + device.id + "/action", {
      method: "POST",
      body: JSON.stringify({ action: action, profile: profile, certificatePassword: certificatePassword })
    }).then(function (result) {
      alert(result.output || "Operacao concluida");
      return load();
    }).catch(function (err) {
      alert(err.message);
      return load();
    }).finally(function () {
      button.disabled = false;
      button.textContent = oldText;
    });
  }

  function runAndroidAction(device, button) {
    var action = button.getAttribute("data-action");
    if (action === "delete") {
      if (!confirm("Remover " + device.name + " do gerenciador Android TV?")) return;
      api("/api/android/devices/" + device.id, { method: "DELETE" }).then(load).catch(function (err) { alert(err.message); });
      return;
    }
    if (action === "uninstall" && !confirm("Desinstalar o DVS Receiver de " + device.name + "?")) return;
    var oldText = button.textContent;
    button.disabled = true;
    button.textContent = "Processando...";
    api("/api/android/devices/" + device.id + "/action", {
      method: "POST",
      body: JSON.stringify({ action: action })
    }).then(function (result) {
      alert(result.output || "Operacao concluida");
      return load();
    }).catch(function (err) {
      alert(err.message);
      return load();
    }).finally(function () {
      button.disabled = false;
      button.textContent = oldText;
    });
  }

  function openRemote(panel) {
    if (remotePreviewController) remotePreviewController.abort();
    remotePanelId = panel.id;
    remoteLogEntries = [];
    remoteActionChain = Promise.resolve();
    document.getElementById("remoteTitle").textContent = "Controle: " + panel.name;
    document.getElementById("remoteResolution").textContent = Number(panel.width || 1920) + " x " + Number(panel.height || 1080) + " | Zoom " + zoomName(panel.zoom);
    document.getElementById("remoteStatus").textContent = "Abrindo sessao renderizada";
    document.getElementById("remoteLastAction").textContent = "Nenhum comando enviado";
    document.getElementById("remoteLoading").className = "remote-loading";
    document.getElementById("remoteConnection").className = "remote-live";
    document.getElementById("remoteConnection").innerHTML = "<i></i> Conectando";
    renderRemoteLog();
    remoteDialog.showModal();
    refreshRemotePreview(0);
  }

  function refreshRemotePreview(delay) {
    clearTimeout(remotePreviewTimer);
    remotePreviewTimer = setTimeout(function () {
      if (!remotePanelId) return;
      var panelId = remotePanelId;
      if (remotePreviewController) remotePreviewController.abort();
      var requestController = window.AbortController ? new AbortController() : null;
      remotePreviewController = requestController;
      var options = { cache: "no-store" };
      if (requestController) options.signal = requestController.signal;
      fetch("/panel-preview/" + panelId + "?interactive=1&t=" + Date.now(), options).then(function (response) {
        if (!response.ok) throw new Error("Imagem indisponivel (HTTP " + response.status + ")");
        return response.blob();
      }).then(function (blob) {
        if (remotePanelId !== panelId) return;
        var objectUrl = URL.createObjectURL(blob);
        var preload = new Image();
        preload.onload = function () {
          if (remotePanelId !== panelId) {
            URL.revokeObjectURL(objectUrl);
            return;
          }
          var oldUrl = remoteObjectUrl;
          remoteObjectUrl = objectUrl;
          document.getElementById("remoteImage").src = objectUrl;
          if (oldUrl) URL.revokeObjectURL(oldUrl);
        };
        preload.onerror = function () { URL.revokeObjectURL(objectUrl); };
        preload.src = objectUrl;
      }).catch(function (error) {
        if (!error || error.name === "AbortError" || remotePanelId !== panelId) return;
        document.getElementById("remoteConnection").className = "remote-live error";
        document.getElementById("remoteConnection").innerHTML = "<i></i> Reconectando";
        document.getElementById("remoteStatus").textContent = error.message;
        refreshRemotePreview(2000);
      }).finally(function () {
        if (remotePreviewController === requestController) remotePreviewController = null;
      });
    }, delay);
  }

  function remoteActionName(payload) {
    if (payload.type === "click") return "Clique no painel";
    if (payload.type === "type") return payload.replace ? "Texto substituido" : "Texto inserido";
    if (payload.type === "key") return "Tecla " + payload.key;
    if (payload.type === "scroll") return payload.deltaY < 0 ? "Rolagem para cima" : "Rolagem para baixo";
    if (payload.type === "reload") return "Pagina recarregada";
    return "Comando enviado";
  }

  function renderRemoteLog() {
    var list = document.getElementById("remoteLog");
    list.innerHTML = "";
    if (!remoteLogEntries.length) {
      list.innerHTML = "<li>Nenhum comando nesta sessao.</li>";
      return;
    }
    remoteLogEntries.slice(0, 8).forEach(function (entry) {
      var item = document.createElement("li");
      var label = document.createElement("strong");
      var time = document.createElement("span");
      label.textContent = entry.label;
      time.textContent = entry.time;
      item.appendChild(label);
      item.appendChild(time);
      list.appendChild(item);
    });
  }

  function remoteAction(payload) {
    if (!remotePanelId) return Promise.resolve();
    var panelId = remotePanelId;
    var label = remoteActionName(payload);
    remoteActionChain = remoteActionChain.then(function () {
      var startedAt = Date.now();
      document.getElementById("remoteStatus").textContent = "Executando: " + label;
      return api("/api/panels/" + panelId + "/interact", {
        method: "POST",
        body: JSON.stringify(payload)
      }).then(function () {
        if (remotePanelId !== panelId) return;
        var elapsed = Date.now() - startedAt;
        document.getElementById("remoteStatus").textContent = "Pronto para interagir";
        document.getElementById("remoteLastAction").textContent = label + " | " + elapsed + " ms";
        remoteLogEntries.unshift({ label: label, time: new Date().toLocaleTimeString() });
        renderRemoteLog();
        refreshRemotePreview(60);
      }).catch(function (err) {
        if (remotePanelId !== panelId) return;
        document.getElementById("remoteStatus").textContent = "Falha ao executar comando";
        document.getElementById("remoteLastAction").textContent = err.message;
        remoteLogEntries.unshift({ label: "Erro: " + err.message, time: new Date().toLocaleTimeString() });
        renderRemoteLog();
      });
    });
    return remoteActionChain;
  }

  function closeRemote() {
    remotePanelId = "";
    clearTimeout(remotePreviewTimer);
    remotePreviewTimer = null;
    if (remotePreviewController) remotePreviewController.abort();
    remotePreviewController = null;
    document.getElementById("remoteImage").removeAttribute("src");
    if (remoteObjectUrl) URL.revokeObjectURL(remoteObjectUrl);
    remoteObjectUrl = "";
    document.getElementById("remoteLoading").className = "remote-loading";
  }

  function remoteImagePoint(event) {
    var img = event.currentTarget;
    if (!img.naturalWidth || !img.naturalHeight) return null;
    var rect = img.getBoundingClientRect();
    var imageRatio = img.naturalWidth / img.naturalHeight;
    var boxRatio = rect.width / rect.height;
    var width = boxRatio > imageRatio ? rect.height * imageRatio : rect.width;
    var height = boxRatio > imageRatio ? rect.height : rect.width / imageRatio;
    var left = rect.left + (rect.width - width) / 2;
    var top = rect.top + (rect.height - height) / 2;
    var x = event.clientX - left;
    var y = event.clientY - top;
    if (x < 0 || y < 0 || x > width || y > height) return null;
    return { x: x / width, y: y / height, viewportX: event.clientX - rect.left, viewportY: event.clientY - rect.top };
  }

  function render() {
    updateMetrics();
    renderGroups();
    renderPanels();
    renderTvs();
    renderWebos();
    renderTizen();
    renderAndroid();
    renderMedia();
  }

  function roleName(role) {
    return role === "supervisor" ? "Supervisor" : role === "technician" ? "Tecnico" : "Operador";
  }

  function loadUsers() {
    if (!currentMe || currentMe.role !== "supervisor") return Promise.resolve();
    return api("/api/users").then(function (result) { users = result.users || []; renderUsers(); });
  }

  function renderUsers() {
    var list = document.getElementById("userList");
    list.innerHTML = "";
    users.forEach(function (user) {
      var row = document.createElement("div");
      row.className = "user-row";
      row.innerHTML = '<div class="user-identity"><strong></strong><small></small></div><input class="user-display" aria-label="Nome para exibicao"><select class="user-role"><option value="operator">Operador</option><option value="technician">Tecnico</option><option value="supervisor">Supervisor</option></select><input class="user-password" type="password" minlength="12" maxlength="128" autocomplete="new-password" placeholder="Nova senha (opcional)"><input class="user-password-confirm" type="password" minlength="12" maxlength="128" autocomplete="new-password" placeholder="Repita a nova senha"><label class="check-row"><input class="user-enabled" type="checkbox"> Ativo</label><button type="button" class="user-save">Salvar</button><button type="button" class="user-delete danger-btn">Excluir</button>';
      row.querySelector("strong").textContent = user.username;
      row.querySelector("small").textContent = roleName(user.role) + (user.mustChangePassword ? " | troca de senha pendente" : "");
      row.querySelector(".user-display").value = user.displayName || user.username;
      row.querySelector(".user-role").value = user.role;
      row.querySelector(".user-enabled").checked = user.enabled !== false;
      row.querySelector(".user-save").onclick = function () {
        var password = row.querySelector(".user-password").value;
        var confirmPassword = row.querySelector(".user-password-confirm").value;
        if (password !== confirmPassword) { alert("A confirmacao da nova senha nao confere."); return; }
        var payload = { displayName: row.querySelector(".user-display").value, role: row.querySelector(".user-role").value, enabled: row.querySelector(".user-enabled").checked };
        if (password) { payload.password = password; payload.confirmPassword = confirmPassword; payload.mustChangePassword = true; }
        api("/api/users/" + user.id, { method: "PATCH", body: JSON.stringify(payload) }).then(loadUsers).catch(alert);
      };
      row.querySelector(".user-delete").disabled = currentMe && currentMe.user === user.username;
      row.querySelector(".user-delete").onclick = function () {
        if (!confirm("Excluir o usuario " + user.username + "?")) return;
        api("/api/users/" + user.id, { method: "DELETE" }).then(loadUsers).catch(alert);
      };
      list.appendChild(row);
    });
  }

  function applyState(next) {
    state = next;
    state.webosDevices = state.webosDevices || [];
    state.tizenDevices = state.tizenDevices || [];
    state.androidDevices = state.androidDevices || [];
    state.media = state.media || [];
    state.playlists = state.playlists || [];
    state.panelPlaylists = state.panelPlaylists || [];
    state.tvs = sortNamed(state.tvs);
    state.groups = sortNamed(state.groups);
    state.panels = sortNamed(state.panels);
    state.webosDevices = sortNamed(state.webosDevices);
    state.tizenDevices = sortNamed(state.tizenDevices);
    state.androidDevices = sortNamed(state.androidDevices);
    state.media = sortNamed(state.media);
    state.playlists = sortNamed(state.playlists);
    state.panelPlaylists = sortNamed(state.panelPlaylists);
    var dashboardSignature = JSON.stringify({
      tvs: state.tvs.map(function (tv) { return { id: tv.id, name: tv.name, groupId: tv.groupId, currentPanelId: tv.currentPanelId, zoom: tv.zoom }; }),
      groups: state.groups,
      panels: state.panels.map(function (panel) { var copy = Object.assign({}, panel); delete copy.renderStatus; return copy; }),
      media: state.media,
      playlists: state.playlists,
      panelPlaylists: state.panelPlaylists
    });
    var resourceSignature = JSON.stringify({
      groups: state.groups,
      panels: state.panels.map(function (panel) { var copy = Object.assign({}, panel); delete copy.renderStatus; return copy; }),
      media: state.media,
      playlists: state.playlists,
      panelPlaylists: state.panelPlaylists,
      tvs: state.tvs.map(function (tv) { return { id: tv.id, name: tv.name }; })
    });
    var linkedTvs = state.tvs.map(function (tv) { return { id: tv.id, name: tv.name }; });
    var webosSignature = JSON.stringify({ devices: state.webosDevices, tvs: linkedTvs });
    var tizenSignature = JSON.stringify({ devices: state.tizenDevices, tvs: linkedTvs });
    var androidSignature = JSON.stringify({ devices: state.androidDevices, tvs: linkedTvs });

    updateMetrics();
    if (dashboardSignature !== renderSignatures.dashboard) {
      renderSignatures.dashboard = dashboardSignature;
      renderGroups();
      renderTvs();
    } else {
      updateTvTelemetry();
    }
    if (resourceSignature !== renderSignatures.resources) {
      renderSignatures.resources = resourceSignature;
      renderGroups();
      renderPanels();
      renderMedia();
    }
    if (webosSignature !== renderSignatures.webos) { renderSignatures.webos = webosSignature; renderWebos(); }
    if (tizenSignature !== renderSignatures.tizen) { renderSignatures.tizen = tizenSignature; renderTizen(); }
    if (androidSignature !== renderSignatures.android) { renderSignatures.android = androidSignature; renderAndroid(); }
    renderServerMetrics(state.serverMetrics || {});
  }

  function load() {
    if (loadRequest) return loadRequest;
    loadRequest = api("/api/state").then(function (next) {
      applyState(next);
      serverStatus.textContent = "Online";
      serverStatus.className = "status-pill online";
    }).catch(function () {
      serverStatus.textContent = "Sem conexao";
      serverStatus.className = "status-pill offline";
    }).finally(function () {
      loadRequest = null;
    });
    return loadRequest;
  }

  document.getElementById("panelForm").onsubmit = function (event) {
    event.preventDefault();
    var data = new FormData(event.target);
    api("/api/panels", {
      method: "POST",
      body: JSON.stringify({
        id: event.target.dataset.panelId || "",
        name: data.get("name"),
        url: data.get("url"),
        mode: data.get("mode"),
        playlistId: data.get("playlistId"),
        panelPlaylistId: data.get("panelPlaylistId"),
        mediaId: data.get("mediaId"),
        loop: data.get("videoLoop") === "on",
        refreshSeconds: 1,
        renderDelayMs: 100,
        zoom: data.get("zoom"),
        auth: {
          enabled: data.get("authEnabled") === "on",
          username: data.get("authUsername"),
          password: data.get("authPassword"),
          usernameSelector: data.get("usernameSelector"),
          passwordSelector: data.get("passwordSelector"),
          submitSelector: data.get("submitSelector")
        }
      })
    }).then(function () {
      event.target.reset();
      delete event.target.dataset.panelId;
      document.getElementById("cancelPanelEdit").hidden = true;
      event.target.elements.zoom.value = 1;
      document.getElementById("zoomValue").textContent = "100%";
      updatePanelMode();
      showResourceFeedback("Painel salvo e disponivel no Dashboard.", "success");
      return load();
    }).catch(showResourceError);
  };

  document.getElementById("cancelPanelEdit").onclick = function () {
    var form = document.getElementById("panelForm");
    form.reset();
    delete form.dataset.panelId;
    this.hidden = true;
    document.getElementById("zoomValue").textContent = "100%";
    updatePanelMode();
  };

  document.getElementById("panelForm").elements.zoom.oninput = function (event) {
    document.getElementById("zoomValue").textContent = zoomName(event.target.value);
  };
  document.getElementById("panelForm").elements.mode.onchange = updatePanelMode;

  document.getElementById("uploadForm").onsubmit = function (event) {
    event.preventDefault();
    var form = event.target;
    var file = form.elements.file.files[0];
    if (!file) return;
    var button = form.querySelector('button[type="submit"]');
    var progress = document.getElementById("uploadProgress");
    var status = document.getElementById("uploadStatus");
    var xhr = new XMLHttpRequest();
    button.disabled = true;
    progress.hidden = false;
    progress.value = 0;
    status.textContent = "Enviando " + file.name;
    xhr.open("POST", "/api/media/upload?name=" + encodeURIComponent(file.name) + "&title=" + encodeURIComponent(form.elements.title.value || ""), true);
    if (csrfToken) xhr.setRequestHeader("x-dvs-csrf", csrfToken);
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.upload.onprogress = function (uploadEvent) {
      if (uploadEvent.lengthComputable) progress.value = Math.round(uploadEvent.loaded / uploadEvent.total * 100);
    };
    xhr.onload = function () {
      button.disabled = false;
      progress.hidden = true;
      var body = {};
      try { body = JSON.parse(xhr.responseText || "{}"); } catch (_) {}
      if (xhr.status < 200 || xhr.status >= 300) return alert(body.error || "Falha no upload");
      form.reset();
      status.textContent = "Upload concluido";
      showResourceFeedback("Video enviado para a biblioteca.", "success");
      load();
    };
    xhr.onerror = function () { button.disabled = false; progress.hidden = true; status.textContent = "Falha no upload"; };
    xhr.send(file);
  };

  document.getElementById("playlistForm").onsubmit = function (event) {
    event.preventDefault();
    var form = event.target;
    var checked = form.querySelectorAll('.playlist-options input[type="checkbox"]:checked');
    var items = [];
    for (var i = 0; i < checked.length; i += 1) items.push(checked[i].value);
    if (!items.length) { showResourceFeedback("Selecione pelo menos um video para a playlist.", "error"); return; }
    api("/api/playlists", {
      method: "POST",
      body: JSON.stringify({ id: form.dataset.playlistId || "", name: form.elements.name.value, items: items, loop: form.elements.loop.checked, targetTvId: form.elements.targetTvId.value })
    }).then(function (result) {
      var assigned = result.assignedTvId ? " e enviada para a TV selecionada" : " e disponibilizada no Dashboard";
      form.reset();
      delete form.dataset.playlistId;
      form.elements.loop.checked = true;
      form.querySelector(".cancel-playlist-edit").hidden = true;
      showResourceFeedback("Playlist salva" + assigned + ".", "success");
      return load();
    }).catch(showResourceError);
  };

  document.getElementById("panelPlaylistForm").onsubmit = function (event) {
    event.preventDefault();
    var form = event.target;
    var checked = form.querySelectorAll('.playlist-options input[type="checkbox"]:checked');
    var items = [];
    for (var i = 0; i < checked.length; i += 1) {
      var row = checked[i].closest(".panel-playlist-option");
      items.push({ panelId: checked[i].value, durationSeconds: Number(row.querySelector(".panel-duration").value || 30) });
    }
    if (!items.length) { showResourceFeedback("Selecione pelo menos um painel para a playlist.", "error"); return; }
    api("/api/panel-playlists", {
      method: "POST",
      body: JSON.stringify({ id: form.dataset.playlistId || "", name: form.elements.name.value, items: items, loop: form.elements.loop.checked, targetTvId: form.elements.targetTvId.value })
    }).then(function (result) {
      var assigned = result.assignedTvId ? " e enviada para a TV selecionada" : " e disponibilizada no Dashboard";
      form.reset();
      delete form.dataset.playlistId;
      form.elements.loop.checked = true;
      form.querySelector(".cancel-playlist-edit").hidden = true;
      showResourceFeedback("Playlist salva" + assigned + ".", "success");
      return load();
    }).catch(showResourceError);
  };

  var cancelPlaylistButtons = document.querySelectorAll(".cancel-playlist-edit");
  for (var cancelIndex = 0; cancelIndex < cancelPlaylistButtons.length; cancelIndex += 1) {
    cancelPlaylistButtons[cancelIndex].onclick = function (event) {
      var form = event.currentTarget.closest("form");
      form.reset();
      delete form.dataset.playlistId;
      form.elements.loop.checked = true;
      event.currentTarget.hidden = true;
    };
  }

  var viewButtons = document.querySelectorAll("[data-view]");
  for (var viewIndex = 0; viewIndex < viewButtons.length; viewIndex += 1) {
    viewButtons[viewIndex].onclick = function (event) {
      var targetId = event.currentTarget.getAttribute("data-view");
      activeViewId = targetId;
      for (var buttonIndex = 0; buttonIndex < viewButtons.length; buttonIndex += 1) viewButtons[buttonIndex].classList.toggle("active", viewButtons[buttonIndex] === event.currentTarget);
      var views = document.querySelectorAll(".app-view");
      for (var viewItem = 0; viewItem < views.length; viewItem += 1) views[viewItem].hidden = views[viewItem].id !== targetId;
      if (targetId === "dashboardView") setTimeout(refreshVisiblePreviews, 0);
      else stopPreviewWork();
      if (targetId === "usersView") loadUsers().catch(alert);
    };
  }
  updatePanelMode();

  document.getElementById("webosForm").onsubmit = function (event) {
    event.preventDefault();
    var data = new FormData(event.target);
    var submit = event.target.querySelector('button[type="submit"]');
    submit.disabled = true;
    submit.textContent = "Conectando...";
    api("/api/webos/devices", {
      method: "POST",
      body: JSON.stringify({
        name: data.get("name"),
        host: data.get("host"),
        port: data.get("port"),
        username: "prisoner",
        passphrase: data.get("passphrase"),
        linkedTvId: data.get("linkedTvId"),
        autoRenew: data.get("autoRenew") === "on",
        autoLaunch: data.get("autoLaunch") === "on"
      })
    }).then(function () {
      event.target.reset();
      event.target.elements.port.value = 9922;
      return load();
    }).catch(function (err) {
      alert(err.message);
      return load();
    }).finally(function () {
      submit.disabled = false;
      submit.textContent = "Cadastrar e parear";
    });
  };

  function loadWebosStatus() {
    return api("/api/webos/status").then(function (status) {
      document.getElementById("cliStatus").textContent = status.available ? status.version : "CLI indisponivel";
      document.getElementById("cliStatus").className = "status-pill " + (status.available ? "online" : "offline");
      document.getElementById("packageStatus").textContent = status.package || "Nenhum IPK encontrado";
    }).catch(function () {});
  }

  document.getElementById("tizenForm").onsubmit = function (event) {
    event.preventDefault();
    var data = new FormData(event.target);
    var submit = event.target.querySelector('button[type="submit"]');
    submit.disabled = true;
    submit.textContent = "Conectando...";
    api("/api/tizen/devices", {
      method: "POST",
      body: JSON.stringify({
        name: data.get("name"),
        host: data.get("host"),
        port: data.get("port"),
        profile: data.get("profile"),
        linkedTvId: data.get("linkedTvId"),
        autoLaunch: data.get("autoLaunch") === "on"
      })
    }).then(function () {
      event.target.reset();
      event.target.elements.port.value = 26101;
      return load();
    }).catch(function (err) {
      alert(err.message);
      return load();
    }).finally(function () {
      submit.disabled = false;
      submit.textContent = "Cadastrar e conectar";
    });
  };

  function applyTizenStatus(status) {
    document.getElementById("tizenCliStatus").textContent = status.available ? status.tizen : "SDK indisponivel";
    document.getElementById("tizenCliStatus").className = "status-pill " + (status.available ? "online" : "offline");
    document.getElementById("tizenPackageStatus").textContent = status.package || "Nenhum WGT assinado";
    if (status.sdk) document.getElementById("tizenSdkPath").value = status.sdk;
    document.getElementById("tizenSdkHelp").textContent = status.available
      ? "SDK validado em " + status.sdk
      : (status.error || "Instale o Tizen Studio e as extensoes Samsung TV.");
  }

  function loadTizenStatus() {
    return api("/api/tizen/status").then(applyTizenStatus).catch(function () {});
  }

  var resourceButtons = document.querySelectorAll("[data-resource-view]");
  for (var resourceIndex = 0; resourceIndex < resourceButtons.length; resourceIndex += 1) {
    resourceButtons[resourceIndex].onclick = function (event) {
      var targetId = event.currentTarget.getAttribute("data-resource-view");
      for (var buttonIndex = 0; buttonIndex < resourceButtons.length; buttonIndex += 1) resourceButtons[buttonIndex].classList.toggle("active", resourceButtons[buttonIndex] === event.currentTarget);
      var sections = document.querySelectorAll(".resource-section");
      for (var sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) sections[sectionIndex].hidden = sections[sectionIndex].id !== targetId;
    };
  }

  function applyAndroidStatus(status) {
    document.getElementById("androidCliStatus").textContent = status.available ? "ADB disponivel" : "ADB indisponivel";
    document.getElementById("androidCliStatus").className = "status-pill " + (status.available ? "online" : "offline");
    document.getElementById("androidPackageStatus").textContent = status.package || "Nenhum APK encontrado";
  }

  function loadAndroidStatus() {
    return api("/api/android/status").then(applyAndroidStatus).catch(function () {});
  }

  document.getElementById("tizenSdkForm").onsubmit = function (event) {
    event.preventDefault();
    var submit = event.target.querySelector("button[type=submit]");
    submit.disabled = true;
    submit.textContent = "Validando...";
    api("/api/tizen/sdk", {
      method: "POST",
      body: JSON.stringify({ path: event.target.elements.path.value })
    }).then(function (status) {
      applyTizenStatus(status);
    }).catch(function (error) {
      document.getElementById("tizenSdkHelp").textContent = error.message;
    }).finally(function () {
      submit.disabled = false;
      submit.textContent = "Validar SDK";
    });
  };

  document.getElementById("androidForm").onsubmit = function (event) {
    event.preventDefault();
    var data = new FormData(event.target);
    var submit = event.target.querySelector('button[type="submit"]');
    submit.disabled = true;
    submit.textContent = "Conectando...";
    api("/api/android/devices", {
      method: "POST",
      body: JSON.stringify({
        name: data.get("name"),
        host: data.get("host"),
        port: data.get("port"),
        linkedTvId: data.get("linkedTvId"),
        autoLaunch: data.get("autoLaunch") === "on"
      })
    }).then(function () {
      event.target.reset();
      event.target.elements.port.value = 5555;
      return load();
    }).catch(function (err) {
      alert(err.message);
      return load();
    }).finally(function () {
      submit.disabled = false;
      submit.textContent = "Cadastrar e conectar";
    });
  };
  document.getElementById("checkTizenProfiles").onclick = function () {
    var help = document.getElementById("tizenSdkHelp");
    help.textContent = "Consultando perfis de certificado...";
    api("/api/tizen/profiles").then(function (result) {
      help.textContent = result.profiles && result.profiles.length ? "Perfis disponiveis: " + result.profiles.join(", ") : result.output;
    }).catch(function (error) { help.textContent = error.message; });
  };

  document.getElementById("closeRemote").onclick = function () { remoteDialog.close(); };
  remoteDialog.addEventListener("close", closeRemote);
  document.getElementById("remoteImage").onload = function () {
    if (!remotePanelId) return;
    document.getElementById("remoteLoading").className = "remote-loading hidden";
    document.getElementById("remoteConnection").className = "remote-live online";
    document.getElementById("remoteConnection").innerHTML = "<i></i> Ao vivo";
    document.getElementById("remoteStatus").textContent = "Pronto para interagir";
    refreshRemotePreview(3000);
  };
  document.getElementById("remoteImage").onerror = function () {
    if (!remotePanelId) return;
    document.getElementById("remoteConnection").className = "remote-live error";
    document.getElementById("remoteConnection").innerHTML = "<i></i> Sem imagem";
    document.getElementById("remoteStatus").textContent = "Nao foi possivel abrir o fluxo renderizado";
    refreshRemotePreview(2000);
  };
  document.getElementById("remoteImage").onclick = function (event) {
    var point = remoteImagePoint(event);
    if (!point) return;
    var pointer = document.getElementById("remotePointer");
    pointer.style.left = point.viewportX + "px";
    pointer.style.top = point.viewportY + "px";
    pointer.className = "remote-pointer";
    void pointer.offsetWidth;
    pointer.className = "remote-pointer active";
    remoteAction({ type: "click", x: point.x, y: point.y });
  };
  document.getElementById("remoteForm").onsubmit = function (event) {
    event.preventDefault();
    var input = event.target.elements.text;
    if (!input.value) return;
    remoteAction({ type: "type", text: input.value, replace: event.target.elements.replace.checked }).then(function () { input.value = ""; });
  };
  document.getElementById("remoteReload").onclick = function () { remoteAction({ type: "reload" }); };
  var remoteKeys = document.querySelectorAll("[data-key]");
  for (var keyIndex = 0; keyIndex < remoteKeys.length; keyIndex += 1) {
    remoteKeys[keyIndex].onclick = function (event) { remoteAction({ type: "key", key: event.currentTarget.getAttribute("data-key") }); };
  }
  var remoteScrolls = document.querySelectorAll("[data-scroll]");
  for (var scrollIndex = 0; scrollIndex < remoteScrolls.length; scrollIndex += 1) {
    remoteScrolls[scrollIndex].onclick = function (event) { remoteAction({ type: "scroll", deltaY: Number(event.currentTarget.getAttribute("data-scroll")) }); };
  }
  document.getElementById("clearRemoteLog").onclick = function () { remoteLogEntries = []; renderRemoteLog(); };

  document.getElementById("groupForm").onsubmit = function (event) {
    event.preventDefault();
    var data = new FormData(event.target);
    api("/api/groups", {
      method: "POST",
      body: JSON.stringify({ name: data.get("name") })
    }).then(function () {
      event.target.reset();
      showResourceFeedback("Grupo adicionado.", "success");
      return load();
    }).catch(showResourceError);
  };

  groupFilter.onchange = renderTvs;
  document.getElementById("refreshBtn").onclick = load;
  document.getElementById("logoutBtn").onclick = function () {
    api("/api/logout", { method: "POST", body: "{}" }).then(function () { location.href = "/admin"; });
  };
  document.getElementById("passwordBtn").onclick = function () {
    document.getElementById("passwordDialog").showModal();
  };
  document.getElementById("cancelPassword").onclick = function () {
    if (currentMe && currentMe.mustChangePassword) return;
    document.getElementById("passwordDialog").close();
  };
  document.getElementById("passwordDialog").addEventListener("cancel", function (event) {
    if (currentMe && currentMe.mustChangePassword) event.preventDefault();
  });
  document.getElementById("passwordForm").onsubmit = function (event) {
    event.preventDefault();
    var data = new FormData(event.target);
    if (data.get("newPassword") !== data.get("confirmPassword")) { alert("A confirmacao da nova senha nao confere."); return; }
    api("/api/change-password", {
      method: "POST",
      body: JSON.stringify({
        currentPassword: data.get("currentPassword"),
        newPassword: data.get("newPassword"),
        confirmPassword: data.get("confirmPassword")
      })
    }).then(function () {
      event.target.reset();
      document.getElementById("passwordDialog").close();
      document.getElementById("passwordBtn").textContent = "Senha";
      document.getElementById("passwordBtn").className = "ghost-btn";
      document.getElementById("cancelPassword").hidden = false;
      if (currentMe) currentMe.mustChangePassword = false;
      startLiveUpdates();
      alert("Senha alterada.");
    }).catch(alert);
  };

  document.getElementById("userForm").onsubmit = function (event) {
    event.preventDefault();
    var form = event.target;
    var data = new FormData(form);
    api("/api/users", {
      method: "POST",
      body: JSON.stringify({
        displayName: data.get("displayName"),
        username: data.get("username"),
        role: data.get("role"),
        password: data.get("password"),
        mustChangePassword: data.get("mustChangePassword") === "on"
      })
    }).then(function () { form.reset(); form.elements.mustChangePassword.checked = true; return loadUsers(); }).catch(alert);
  };

  api("/api/me").then(function (me) {
    currentMe = me;
    csrfToken = me.csrfToken || "";
    document.body.setAttribute("data-role", me.role || "operator");
    document.getElementById("currentUser").textContent = (me.displayName || me.user) + " | " + roleName(me.role);
    if (!me.authEnabled) {
      document.getElementById("passwordBtn").hidden = true;
      document.getElementById("logoutBtn").hidden = true;
    }
    var supervisorOnly = document.querySelectorAll("[data-supervisor]");
    for (var item = 0; item < supervisorOnly.length; item += 1) supervisorOnly[item].hidden = me.role !== "supervisor";
    if (me.role === "operator") {
      var restrictedTabs = document.querySelectorAll('[data-view="mediaView"], [data-view="webosView"], [data-view="tizenView"], [data-view="androidView"]');
      for (var tab = 0; tab < restrictedTabs.length; tab += 1) restrictedTabs[tab].hidden = true;
    }
    if (!me.mustChangePassword) {
      startLiveUpdates();
      return;
    }
    var passwordButton = document.getElementById("passwordBtn");
    passwordButton.textContent = "Trocar senha obrigatoria";
    passwordButton.className = "danger-btn";
    document.getElementById("cancelPassword").hidden = true;
    document.getElementById("passwordDialog").showModal();
  }).catch(function () {});

  function startLiveUpdates() {
    if (liveUpdatesStarted) return;
    liveUpdatesStarted = true;
    if (window.EventSource) {
      var events = new EventSource("/api/events");
      events.addEventListener("state", function (event) {
        applyState(JSON.parse(event.data));
        serverStatus.textContent = "Online";
        serverStatus.className = "status-pill online";
      });
      events.onerror = function () {
        serverStatus.textContent = "Reconectando";
        serverStatus.className = "status-pill offline";
      };
    }
    load();
    loadWebosStatus();
    loadTizenStatus();
    loadAndroidStatus();
    setInterval(load, 30000);
    setInterval(updateTvTelemetry, 5000);
    setInterval(refreshVisiblePreviews, 15000);
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stopPreviewWork();
    else if (activeViewId === "dashboardView") refreshVisiblePreviews();
  });
})();
