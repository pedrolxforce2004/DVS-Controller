(function () {
  "use strict";
  var state = { tvs: [], groups: [], panels: [], serverMetrics: {} };
  var slides = [];
  var slideIndex = 0;
  var paused = false;
  var startedAt = Date.now();
  var requestedInterval = Number(new URLSearchParams(location.search).get("interval") || 20);
  var intervalSeconds = Number.isFinite(requestedInterval) ? Math.max(5, Math.min(300, requestedInterval)) : 20;
  var grid = document.getElementById("panelGrid");
  var empty = document.getElementById("emptyState");

  function sortNamed(items) {
    return (items || []).slice().sort(function (a, b) {
      return String(a.name || "").localeCompare(String(b.name || ""), "pt-BR", { numeric: true, sensitivity: "base" });
    });
  }

  function buildSlides() {
    var currentId = slides[slideIndex] && slides[slideIndex].id;
    slides = [{ id: "all", name: "Todos os painéis", type: "all" }].concat(sortNamed(state.groups).map(function (group) {
      return { id: group.id, name: group.name, type: "group" };
    }));
    var currentIndex = slides.findIndex(function (slide) { return slide.id === currentId; });
    slideIndex = currentIndex >= 0 ? currentIndex : Math.min(slideIndex, Math.max(0, slides.length - 1));
  }

  function panelStatus(tvs) {
    var online = tvs.filter(function (tv) { return tv.status === "online"; });
    if (online.some(function (tv) { return Boolean(tv.lastError); })) return "error";
    if (online.length) return "online";
    if (tvs.length) return "offline";
    return "idle";
  }

  function renderCard(panel, relevantTvs) {
    var tvs = relevantTvs.filter(function (tv) { return tv.currentPanelId === panel.id; });
    var online = tvs.filter(function (tv) { return tv.status === "online"; }).length;
    var errors = tvs.filter(function (tv) { return Boolean(tv.lastError); }).length;
    var status = panelStatus(tvs);
    var card = document.createElement("article");
    card.className = "panel-card " + status;
    var header = document.createElement("div"); header.className = "card-header";
    var title = document.createElement("h2"); title.textContent = panel.name;
    var badge = document.createElement("span"); badge.className = "status"; badge.textContent = { online: "ONLINE", offline: "OFFLINE", error: "COM FALHA", idle: "SEM TV" }[status];
    header.appendChild(title); header.appendChild(badge); card.appendChild(header);
    var counts = document.createElement("div"); counts.className = "counts";
    counts.innerHTML = '<div><strong></strong><span>TVs online</span></div><div><strong></strong><span>TVs vinculadas</span></div><div><strong></strong><span>Falhas</span></div>';
    var values = counts.querySelectorAll("strong"); values[0].textContent = online; values[1].textContent = tvs.length; values[2].textContent = errors;
    card.appendChild(counts);
    var list = document.createElement("div"); list.className = "tv-list";
    if (!tvs.length) list.textContent = "Nenhuma TV exibe este painel nesta tela.";
    else tvs.forEach(function (tv, index) {
      if (index) list.appendChild(document.createTextNode("  •  "));
      var item = document.createElement("span"); item.className = tv.lastError ? "problem" : ""; item.textContent = tv.name + (tv.lastError ? ": " + tv.lastError : " (" + tv.status + ")"); list.appendChild(item);
    });
    card.appendChild(list);
    var mode = document.createElement("span"); mode.className = "mode"; mode.textContent = String(panel.mode || "direct").replace(/_/g, " "); card.appendChild(mode);
    return card;
  }

  function render() {
    buildSlides();
    var slide = slides[slideIndex] || slides[0];
    var relevantTvs = slide.type === "all" ? state.tvs : state.tvs.filter(function (tv) { return tv.groupId === slide.id; });
    var panels = slide.type === "all" ? sortNamed(state.panels) : sortNamed(state.panels.filter(function (panel) {
      return relevantTvs.some(function (tv) { return tv.currentPanelId === panel.id; });
    }));
    document.getElementById("slideTitle").textContent = slide.name;
    document.getElementById("slideMeta").textContent = slide.type === "all" ? "Visão geral de todos os painéis cadastrados" : relevantTvs.length + " TV(s) cadastrada(s) no grupo";
    grid.innerHTML = "";
    panels.forEach(function (panel) { grid.appendChild(renderCard(panel, relevantTvs)); });
    empty.hidden = panels.length !== 0;
    document.body.classList.toggle("compact", panels.length > 12);
    var online = state.tvs.filter(function (tv) { return tv.status === "online"; }).length;
    var errors = state.tvs.filter(function (tv) { return Boolean(tv.lastError); }).length;
    document.getElementById("metricPanels").textContent = panels.length;
    document.getElementById("metricOnline").textContent = online;
    document.getElementById("metricOffline").textContent = state.tvs.length - online;
    document.getElementById("metricErrors").textContent = errors;
    document.getElementById("metricCpu").textContent = Number(state.serverMetrics.cpuPercent || 0).toFixed(1).replace(".0", "") + "%";
    document.getElementById("metricMemory").textContent = Number(state.serverMetrics.memory && state.serverMetrics.memory.percent || 0).toFixed(1).replace(".0", "") + "%";
    renderPlaylist();
  }

  function renderPlaylist() {
    var list = document.getElementById("playlist"); list.innerHTML = "";
    slides.forEach(function (slide, index) {
      var button = document.createElement("button"); button.type = "button"; button.className = index === slideIndex ? "active" : ""; button.title = slide.name;
      button.onclick = function () { showSlide(index); }; list.appendChild(button);
    });
    document.getElementById("rotationLabel").textContent = paused ? "Rotação pausada" : "Próxima tela em " + intervalSeconds + "s";
  }

  function showSlide(index) {
    slideIndex = (index + slides.length) % slides.length;
    startedAt = Date.now(); render();
  }

  function applyState(next) {
    state = next || state;
    state.tvs = state.tvs || []; state.groups = state.groups || []; state.panels = state.panels || []; state.serverMetrics = state.serverMetrics || {};
    render();
  }

  function load() {
    fetch("/api/state", { cache: "no-store" }).then(function (response) {
      if (response.status === 401) { location.href = "/dashboard"; throw new Error("Sessão encerrada"); }
      if (!response.ok) throw new Error("Falha ao carregar o dashboard");
      return response.json();
    }).then(applyState).catch(function () {});
  }

  document.getElementById("previousBtn").onclick = function () { showSlide(slideIndex - 1); };
  document.getElementById("nextBtn").onclick = function () { showSlide(slideIndex + 1); };
  document.getElementById("pauseBtn").onclick = function () { paused = !paused; this.textContent = paused ? "Continuar" : "Pausar"; startedAt = Date.now(); renderPlaylist(); };
  document.getElementById("fullscreenBtn").onclick = function () {
    var request = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
    if (request) request.call(document.documentElement);
  };

  setInterval(function () {
    document.getElementById("clock").textContent = new Date().toLocaleTimeString("pt-BR");
    var elapsed = Date.now() - startedAt;
    document.getElementById("progressBar").style.width = (paused ? 0 : Math.min(100, elapsed / (intervalSeconds * 10))) + "%";
    if (!paused && elapsed >= intervalSeconds * 1000) showSlide(slideIndex + 1);
  }, 250);

  load();
  if (window.EventSource) {
    var events = new EventSource("/api/events");
    events.addEventListener("state", function (event) { try { applyState(JSON.parse(event.data)); } catch (_) {} });
    events.onerror = function () { setTimeout(load, 3000); };
  } else setInterval(load, 5000);
})();
