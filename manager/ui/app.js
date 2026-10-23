(function () {
  "use strict";
  var current = null;
  var busy = false;
  var services = document.getElementById("services");
  var dialog = document.getElementById("settingsDialog");
  var form = document.getElementById("settingsForm");
  var toastTimer;

  function toast(message, isError) {
    var element = document.getElementById("toast");
    element.textContent = message;
    element.className = "toast visible" + (isError ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { element.className = "toast"; }, 3500);
  }

  function duration(seconds) {
    if (!seconds) return "";
    if (seconds < 60) return seconds + "s";
    if (seconds < 3600) return Math.floor(seconds / 60) + " min";
    if (seconds < 86400) return Math.floor(seconds / 3600) + "h " + Math.floor(seconds % 3600 / 60) + "min";
    return Math.floor(seconds / 86400) + "d " + Math.floor(seconds % 86400 / 3600) + "h";
  }

  function serviceIcon(id) { return id === "postgresql" ? "DB" : id === "manager" ? "MGR" : "DVS"; }
  function statusLabel(status) { return status === "running" ? "Executando" : status === "starting" ? "Iniciando" : "Parado"; }

  function render(data) {
    current = data;
    document.getElementById("machine").textContent = data.machine;
    document.getElementById("platform").textContent = data.platform + " • gerenciador ativo há " + duration(data.managerUptime);
    document.getElementById("updatedAt").textContent = "Atualizado às " + new Date().toLocaleTimeString("pt-BR");
    var essential = data.services.filter(function (item) { return item.id !== "manager"; });
    var allRunning = essential.every(function (item) { return item.status === "running"; });
    var global = document.getElementById("globalStatus");
    global.className = "global-status " + (allRunning ? "running" : "error");
    global.innerHTML = "<i></i> " + (allRunning ? "Todos os serviços em execução" : "Atenção necessária");
    services.innerHTML = "";
    data.services.forEach(function (service) {
      var row = document.createElement("div");
      row.className = "service-row";
      var details = service.pid ? "PID " + service.pid : service.windowsState && service.windowsState !== "running" ? service.windowsState : "Serviço do sistema";
      if (service.uptime) details += " • ativo há " + duration(service.uptime);
      row.innerHTML = '<div class="service-name"><span class="service-icon">' + serviceIcon(service.id) + '</span><span>' + service.name + '</span></div>' +
        '<div class="description">' + service.description + '<small>' + details + '</small></div>' +
        '<div class="port">' + service.port + '</div>' +
        '<div class="status ' + service.status + '"><i></i>' + statusLabel(service.status) + '</div>' +
        '<div class="row-actions"></div>';
      var actions = row.querySelector(".row-actions");
      if (service.id !== "manager") {
        actions.appendChild(actionButton(service, service.status === "stopped" ? "start" : "restart", service.status === "stopped" ? "▶" : "↻", service.status === "stopped" ? "Iniciar" : "Reiniciar"));
        if (service.status !== "stopped") actions.appendChild(actionButton(service, "stop", "■", "Parar", "stop"));
      }
      services.appendChild(row);
    });
  }

  function actionButton(service, action, label, title, className) {
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title + " " + service.name;
    button.className = className || "";
    button.disabled = busy;
    button.onclick = function () { control(service.id, action); };
    return button;
  }

  function load(silent) {
    return window.dvs.request("GET", "/v1/status").then(render).catch(function (error) {
      if (!silent) toast(error.message, true);
      var global = document.getElementById("globalStatus");
      global.className = "global-status error";
      global.innerHTML = "<i></i> Serviço gerenciador indisponível";
      services.innerHTML = '<div class="loading">Não foi possível conectar ao serviço local.<br>Verifique se o DVS Controller Service está iniciado.</div>';
    });
  }

  function control(service, action) {
    if (busy) return;
    busy = true;
    toast((action === "stop" ? "Parando " : action === "start" ? "Iniciando " : "Reiniciando ") + service + "...");
    window.dvs.request("POST", "/v1/services/" + service + "/" + action, {}).then(function (data) {
      render(data);
      toast("Operação concluída com sucesso.");
    }).catch(function (error) { toast(error.message, true); }).then(function () { busy = false; });
  }

  document.getElementById("refresh").onclick = function () { load(false); };
  document.getElementById("openAdmin").onclick = function () { if (current) window.dvs.openAdmin(current.config.serverPort, current.config.tlsEnabled); };
  function openTizenTool(kind) {
    if (!current) return;
    window.dvs.openTizenTool(kind, current.config.tizenStudioPath || "").then(function (result) { toast(result.message, !result.opened); }).catch(function (error) { toast(error.message, true); });
  }
  document.getElementById("openTizenPackages").onclick = function () { openTizenTool("packages"); };
  document.getElementById("openTizenCertificates").onclick = function () { openTizenTool("certificate"); };
  document.getElementById("stopAll").onclick = function () {
    if (busy || !confirm("Parar o DVS Server e o PostgreSQL? O Gerenciador permanecera aberto para iniciar os servicos novamente.")) return;
    busy = true;
    toast("Parando os servicos...");
    window.dvs.request("POST", "/v1/services/all/stop", {}).then(render)
      .then(function () { toast("Servicos parados. Use Iniciar em cada servico ou Reiniciar tudo."); })
      .catch(function (error) { toast(error.message, true); }).then(function () { busy = false; });
  };
  document.getElementById("restartAll").onclick = function () {
    if (busy) return;
    busy = true;
    window.dvs.request("POST", "/v1/services/postgresql/restart", {}).then(function () {
      return window.dvs.request("POST", "/v1/services/dvs/restart", {});
    }).then(render).then(function () { toast("Todos os serviços foram reiniciados."); })
      .catch(function (error) { toast(error.message, true); }).then(function () { busy = false; });
  };
  document.getElementById("settingsButton").onclick = function () {
    if (!current) return;
    form.elements.serverPort.value = current.config.serverPort;
    form.elements.databasePort.value = current.config.databasePort;
    form.elements.tlsCertPath.value = current.config.tlsCertPath || "";
    form.elements.tlsKeyPath.value = current.config.tlsKeyPath || "";
    form.elements.requireAdminTls.checked = Boolean(current.config.requireAdminTls);
    document.getElementById("formError").textContent = "";
    dialog.showModal();
  };
  function closeDialog() { dialog.close(); }
  document.getElementById("cancelSettings").onclick = closeDialog;
  document.getElementById("cancelSettingsBottom").onclick = closeDialog;
  form.onsubmit = function (event) {
    event.preventDefault();
    var submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    document.getElementById("formError").textContent = "";
    window.dvs.request("PUT", "/v1/config", {
      serverPort: Number(form.elements.serverPort.value),
      databasePort: Number(form.elements.databasePort.value),
      tlsCertPath: form.elements.tlsCertPath.value,
      tlsKeyPath: form.elements.tlsKeyPath.value,
      requireAdminTls: form.elements.requireAdminTls.checked
    }).then(function (data) { render(data); dialog.close(); toast("Portas atualizadas e serviços reiniciados."); })
      .catch(function (error) { document.getElementById("formError").textContent = error.message; })
      .then(function () { submit.disabled = false; });
  };
  document.getElementById("minimize").onclick = window.dvs.minimize;
  document.getElementById("maximize").onclick = window.dvs.maximize;
  document.getElementById("close").onclick = window.dvs.close;

  load(false);
  setInterval(function () { if (!busy && !dialog.open) load(true); }, 5000);
}());
