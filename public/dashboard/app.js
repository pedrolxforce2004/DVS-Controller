(function () {
  "use strict";
  var state = { tvs: [], panels: [], groups: [], serverMetrics: {} };
  var slides = [], slideIndex = 0, paused = false, startedAt = Date.now(), receivedAt = 0;
  var seconds = Number(new URLSearchParams(location.search).get("interval") || 20);
  var intervalSeconds = Number.isFinite(seconds) ? Math.max(5, Math.min(300, seconds)) : 20;
  var capacity = window.innerWidth < 900 ? 4 : window.innerHeight < 850 ? 6 : 10;
  var grid = document.getElementById("panelGrid");
  var modeNames = { direct: "Direto na TV", server_image: "Servidor", image: "Imagem", video: "Vídeo", rtsp: "DVR / NVR", playlist: "Vídeos", panel_playlist: "Playlist", legacy_videowall: "VideoWall" };
  function el(tag, className, text) {
    var node = document.createElement(tag); if (className) node.className = className;
    if (text !== undefined) node.textContent = text; return node;
  }
  function sorted(items) { return items.slice().sort(function (a,b) { return a.name.localeCompare(b.name, "pt-BR", { numeric: true, sensitivity: "base" }); }); }
  function status(tvs, panel) {
    if (panel && (panel.renderStatus && panel.renderStatus.error || panel.streamStatus && panel.streamStatus.error)) return "error";
    if (tvs.some(function (tv) { return tv.lastError || tv.status === "stale"; })) return "error";
    if (tvs.some(function (tv) { return tv.status === "offline"; })) return "offline";
    return tvs.length ? "online" : "idle";
  }
  function entries(group) {
    var tvs = state.tvs.filter(function (tv) { return tv.groupId === group.id || group.id === "default" && !state.groups.some(function (g) { return g.id === tv.groupId; }); });
    var result = sorted(state.panels).filter(function (p) { return tvs.some(function (tv) { return tv.currentPanelId === p.id; }); }).map(function (p) {
      return { group: group, panel: p, tvs: tvs.filter(function (tv) { return tv.currentPanelId === p.id; }) };
    });
    var unassigned = tvs.filter(function (tv) { return !state.panels.some(function (p) { return p.id === tv.currentPanelId; }); });
    if (unassigned.length) result.push({ group: group, panel: { name: "TVs sem painel", mode: "" }, tvs: unassigned });
    if (!result.length) result.push({ group: group, empty: true, tvs: [] });
    return result;
  }
  function buildSlides() {
    var key = slides[slideIndex] && slides[slideIndex].key, all = [];
    var groups = sorted(state.groups);
    groups.forEach(function (g) { all = all.concat(entries(g)); });
    sorted(state.panels).filter(function (p) { return !state.tvs.some(function (tv) { return tv.currentPanelId === p.id; }); }).forEach(function (p) { all.push({ group: { id: "unused", name: "Painéis disponíveis" }, panel: p, tvs: [] }); });
    slides = [];
    function add(id, name, rows) {
      var total = Math.max(1, Math.ceil(rows.length / capacity));
      for (var page = 0; page < total; page++) slides.push({ key: id + ":" + page, id: id, name: name, page: page, total: total, rows: rows.slice(page * capacity, (page + 1) * capacity) });
    }
    add("all", "Todos os painéis", all);
    groups.forEach(function (g) { add(g.id, g.name, entries(g)); });
    var index = slides.findIndex(function (s) { return s.key === key; }); slideIndex = index < 0 ? 0 : index;
  }
  function renderCard(row) {
    var panel = row.panel, tvs = row.tvs, value = status(tvs, panel);
    var card = el("article", "panel-card " + value);
    var head = el("div", "card-header"); head.appendChild(el("h2", "", panel.name));
    head.appendChild(el("span", "status", { online: "ONLINE", offline: "OFFLINE", error: "COM FALHA", idle: "SEM TV" }[value])); card.appendChild(head);
    var list = el("div", "tv-list");
    if (!tvs.length) list.textContent = "Disponível para atribuição";
    tvs.forEach(function (tv) {
      var item = el("div", "tv-row " + (tv.lastError ? "problem" : tv.status));
      item.appendChild(el("span", "tv-name", tv.name));
      item.appendChild(el("span", "tv-status", tv.lastError || { online: "Conectada", stale: "Sem resposta recente", offline: "Desconectada" }[tv.status] || tv.status)); list.appendChild(item);
    });
    card.appendChild(list); card.appendChild(el("span", "mode", modeNames[panel.mode] || "Aguardando atribuição")); return card;
  }
  function rate(value) { return Number.isFinite(value) ? (value * 8 / 1000000).toFixed(1) + " Mb/s" : "Indisponível"; }
  function render() {
    buildSlides(); var slide = slides[slideIndex];
    document.getElementById("slideTitle").textContent = slide.name;
    document.getElementById("slideMeta").textContent = slide.id === "all" ? "Visão do ambiente · " + state.groups.length + " grupos" : "Painéis e dispositivos do grupo";
    document.getElementById("pageLabel").textContent = "Página " + (slide.page + 1) + " / " + slide.total;
    grid.innerHTML = "";
    var sections = {};
    slide.rows.forEach(function (row) {
      var section = sections[row.group.id];
      if (!section) {
        section = el("section", "group-section"); var heading = el("div", "group-heading");
        heading.appendChild(el("h2", "", row.group.name)); section.appendChild(heading);
        section.appendChild(el("div", "group-panels")); grid.appendChild(section); sections[row.group.id] = section;
      }
      if (!row.empty) section.lastElementChild.appendChild(renderCard(row));
      else section.lastElementChild.appendChild(el("div", "group-empty", "Nenhuma TV atribuída"));
    });
    document.getElementById("emptyState").hidden = slide.rows.some(function (row) { return !row.empty; });
    document.getElementById("metricPanels").textContent = state.panels.length;
    document.getElementById("metricOnline").textContent = state.tvs.filter(function (tv) { return tv.status === "online"; }).length;
    document.getElementById("metricOffline").textContent = state.tvs.filter(function (tv) { return tv.status !== "online"; }).length;
    document.getElementById("metricErrors").textContent = state.tvs.filter(function (tv) { return tv.lastError; }).length;
    var metrics = state.serverMetrics, memory = metrics.memory || {}, network = metrics.network || {};
    document.getElementById("metricCpu").textContent = metrics.sampledAt ? Number(metrics.cpuPercent).toFixed(1) + "%" : "—";
    document.getElementById("metricMemory").textContent = metrics.sampledAt ? Number(memory.percent || 0).toFixed(1) + "%" : "—";
    document.getElementById("memoryDetail").textContent = memory.total ? (memory.used / 1073741824).toFixed(1) + " / " + (memory.total / 1073741824).toFixed(1) + " GB" : "Aguardando amostra";
    document.getElementById("metricNetwork").textContent = network.available ? rate(network.bytesPerSecond) : "Indisponível";
    document.getElementById("networkDetail").textContent = network.available ? "↓ " + rate(network.receivedBytesPerSecond) + "   ↑ " + rate(network.sentBytesPerSecond) : "Sem amostra de rede";
    renderPlaylist();
  }
  function renderPlaylist() {
    var list = document.getElementById("playlist"); list.innerHTML = "";
    slides.forEach(function (slide, index) {
      if (slide.page > 0) return;
      var button = el("button", slide.id === slides[slideIndex].id ? "active" : "", slide.id === "all" ? "Visão geral" : slide.name);
      button.type = "button"; button.onclick = function () { showSlide(index); }; list.appendChild(button);
    });
    document.getElementById("rotationLabel").textContent = paused ? "Rotação pausada" : "Rotação · " + intervalSeconds + "s";
  }
  function showSlide(index) { slideIndex = (index + slides.length) % slides.length; startedAt = Date.now(); document.getElementById("dashboardMain").scrollTop = 0; render(); }
  function applyState(next) {
    state = { tvs: next.tvs || [], panels: next.panels || [], groups: next.groups || [], serverMetrics: next.serverMetrics || {} };
    receivedAt = Date.now(); render();
  }
  function load() {
    fetch("/api/state", { cache: "no-store" }).then(function (res) { if (!res.ok) throw new Error("Falha ao atualizar"); return res.json(); }).then(applyState).catch(function () {});
  }
  document.getElementById("previousBtn").onclick = function () { showSlide(slideIndex - 1); };
  document.getElementById("nextBtn").onclick = function () { showSlide(slideIndex + 1); };
  document.getElementById("pauseBtn").onclick = function () { paused = !paused; this.textContent = paused ? "Continuar" : "Pausar"; startedAt = Date.now(); renderPlaylist(); };
  document.getElementById("fullscreenBtn").onclick = function () { var fn = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen; if (fn) fn.call(document.documentElement); };
  setInterval(function () {
    document.getElementById("clock").textContent = new Date().toLocaleTimeString("pt-BR");
    var stale = !receivedAt || Date.now() - receivedAt > 30000;
    document.getElementById("connectionStatus").textContent = stale ? "Dados desatualizados" : "Atualização ao vivo";
    document.getElementById("connectionStatus").className = stale ? "connection stale" : "connection";
    var elapsed = Date.now() - startedAt;
    document.getElementById("progressBar").style.width = (paused ? 0 : Math.min(100, elapsed / (intervalSeconds * 10))) + "%";
    var main = document.getElementById("dashboardMain");
    if (!paused && main.scrollHeight > main.clientHeight) main.scrollTop = Math.max(0, (main.scrollHeight - main.clientHeight) * Math.min(1, elapsed / (intervalSeconds * 850)));
    if (!paused && elapsed >= intervalSeconds * 1000) showSlide(slideIndex + 1);
  }, 250);
  load(); setInterval(load, 10000);
  if (window.EventSource) { var events = new EventSource("/api/events"); events.addEventListener("state", function (e) { try { applyState(JSON.parse(e.data)); } catch (_) {} }); }
})();
