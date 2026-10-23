(function () {
  var form = document.getElementById("loginForm");
  form.onsubmit = function (event) {
    event.preventDefault();
    var data = new FormData(form);
    var button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: data.get("user"), password: data.get("password") })
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error((body.error || "Falha no login") + (body.code ? " [" + body.code + "]" : ""));
        location.href = location.pathname === "/dashboard" ? "/dashboard" : "/admin";
      });
    }).catch(function (err) {
      alert(err.message);
      button.disabled = false;
    });
  };
})();
