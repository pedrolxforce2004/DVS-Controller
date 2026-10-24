const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');

// A scoped session transports the application; its JavaScript and layout still run on the TV.
// The sandbox gives the application an opaque origin, isolated from DVS cookies and storage.
class DirectSessions {
  constructor({ browser, authorize }) {
    this.browser = browser;
    this.authorize = authorize;
    this.sessions = new Map();
    this.pending = new Map();
    this.ttl = 30 * 60 * 1000;
    this.timer = setInterval(() => {
      for (const [token, session] of this.sessions) if (session.expires < Date.now()) {
        for (const socket of session.sockets) socket.destroy(); this.sessions.delete(token);
      }
    }, 60000).unref();
  }
  async create(tv, panel, auth) {
    const signature = crypto.createHash('sha256').update(panel.authSecret + panel.url + panel.updatedAt).digest('hex');
    const key = `${tv.id}:${panel.id}:${signature}`;
    for (const session of this.sessions.values()) if (session.key === key && session.expires > Date.now()) {
      session.expires = Date.now() + this.ttl;
      return { viewerUrl: session.prefix + session.startPath, transport: 'application' };
    }
    if (this.pending.has(key)) return this.pending.get(key);
    if (this.sessions.size >= 100 || this.pending.size >= 4) throw new Error('Aguarde a preparacao das outras sessoes de login');
    const task = this.prepare(tv, panel, auth, key).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
  async prepare(tv, panel, auth, key) {
    const origin = new URL(panel.url).origin;
    const browser = await this.browser();
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    try {
      const page = await context.newPage();
      await page.goto(auth.loginUrl || panel.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      if (new URL(page.url()).origin !== origin) throw new Error('O login redirecionou para outra origem; configure a integracao desse provedor');
      const password = page.locator(auth.passwordSelector || 'input[type="password"]').first();
      await password.waitFor({ state: 'visible', timeout: 12000 });
      const username = page.locator(auth.usernameSelector || 'input[autocomplete="username"],input[name="username"],input[name="user"],input[name="login"],input[type="email"],input[type="text"],input:not([type])').first();
      await username.fill(auth.username || '');
      await password.fill(auth.password || '');
      const submit = auth.submitSelector ? page.locator(auth.submitSelector).first() : password.locator('xpath=ancestor::form').locator('button[type="submit"],input[type="submit"],button:not([type])').first();
      if (await submit.count()) await submit.click({ timeout: 10000 });
      else await password.press('Enter');
      await password.waitFor({ state: 'hidden', timeout: 15000 });
      if (new URL(page.url()).origin !== origin) throw new Error('O login saiu da origem do painel');
      // Reopen the configured destination after authentication, retaining its requested path.
      await page.goto(panel.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      if (await page.locator('input[type="password"]').first().isVisible().catch(() => false)) throw new Error('O site nao manteve a sessao de login');
      const final = new URL(page.url());
      if (final.origin !== origin) throw new Error('Destino de exibicao fora da origem cadastrada');
      const storage = await context.storageState();
      const token = crypto.randomBytes(32).toString('hex');
      const session = { key, token, tvId: tv.id, tvTokenHash: tv.tokenHash, panelId: panel.id, signature: panel.authSecret + panel.updatedAt, origin, cookies: storage.cookies, storage: storage.origins.find(item => item.origin === origin)?.localStorage || [], prefix: `/direct-app/${token}`, startPath: final.pathname + final.search, expires: Date.now() + this.ttl, sockets: new Set() };
      this.sessions.set(token, session);
      return { viewerUrl: session.prefix + session.startPath, transport: 'application' };
    } catch (error) {
      // The browser's exception can contain filled values, selectors or response details.
      if (/Timeout|locator|page\./i.test(error.message)) throw new Error('Nao foi possivel concluir o login automatico. Confira usuario e senha; se necessario, ajuste os seletores em Opcoes avancadas.');
      throw error;
    } finally { await context.close(); }
  }
  resolve(url) {
    const match = url.pathname.match(/^\/direct-app\/([a-f0-9]{64})(\/.*)?$/);
    const session = match && this.sessions.get(match[1]);
    if (!session) return null;
    if (session.expires < Date.now() || !this.authorize(session)) {
      for (const socket of session.sockets) socket.destroy();
      this.sessions.delete(session.token); return null;
    }
    session.expires = Date.now() + this.ttl;
    const target = new URL((match[2] || '/') + url.search, session.origin);
    if (target.origin !== session.origin) return null;
    return { session, target };
  }
  cookieHeader(session, target) {
    return session.cookies.filter(cookie => (target.hostname === cookie.domain.replace(/^\./, '') || cookie.domain.startsWith('.') && target.hostname.endsWith(cookie.domain)) && (!cookie.expires || cookie.expires < 0 || cookie.expires * 1000 > Date.now()) && target.pathname.startsWith(cookie.path || '/') && (!cookie.secure || target.protocol === 'https:')).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  }
  rememberCookies(session, values, target) {
    for (const value of values || []) {
      const [pair, ...attributes] = value.split(';'); const split = pair.indexOf('='); if (split < 1) continue;
      const cookie = { name: pair.slice(0, split).trim(), value: pair.slice(split + 1), path: '/', domain: target.hostname, expires: -1 };
      for (const attribute of attributes) {
        const [name, ...rest] = attribute.trim().split('='); const val = rest.join('=');
        if (name.toLowerCase() === 'path') cookie.path = val;
        if (name.toLowerCase() === 'max-age') cookie.expires = Date.now() / 1000 + Number(val);
        if (name.toLowerCase() === 'expires') cookie.expires = Date.parse(val) / 1000;
        if (name.toLowerCase() === 'secure') cookie.secure = true;
      }
      session.cookies = session.cookies.filter(old => old.name !== cookie.name || old.path !== cookie.path);
      session.cookies.push(cookie);
    }
  }
  rewrite(value, session) {
    const escaped = session.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return value.replace(new RegExp(escaped + '(?=/|["\'`])', 'g'), session.prefix)
      .replace(/(["'`])\/(?!\/|direct-app\/)([^"'`\s<>]+)\1/g, (_, quote, suffix) => quote + session.prefix + '/' + suffix + quote)
      .replace(/url\(\s*\/(?!\/|direct-app\/)([^)]+)\)/g, (_, suffix) => `url(${session.prefix}/${suffix})`);
  }
  bootstrap(session) {
    // No upstream credentials or DVS tokens are embedded into the application document.
    return `<script>(function(){var prefix=${JSON.stringify(session.prefix)},upstream=${JSON.stringify(session.origin)},saved=${JSON.stringify(session.storage)};
function route(value){var u=new URL(String(value),location.href);if(u.origin===upstream||u.origin===location.origin){if(u.pathname.indexOf(prefix+'/')!==0)u.pathname=prefix+u.pathname;u.protocol=location.protocol;u.host=location.host;}return u.href;}
var nativeFetch=window.fetch;window.fetch=function(input,options){if(typeof input==='string'||input instanceof URL)input=route(input);else if(input instanceof Request)input=new Request(route(input.url),input);return nativeFetch.call(this,input,Object.assign({},options,{credentials:'omit'}));};
var open=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url){var args=Array.prototype.slice.call(arguments);args[1]=route(url);return open.apply(this,args);};
var WS=window.WebSocket;if(WS){window.WebSocket=function(url,protocols){var u=new URL(String(url),location.href);if(u.host===location.host||u.host===new URL(upstream).host){u.pathname=u.pathname.indexOf(prefix+'/')===0?u.pathname:prefix+u.pathname;u.host=location.host;u.protocol=location.protocol==='https:'?'wss:':'ws:';}return protocols===undefined?new WS(u.href):new WS(u.href,protocols);};window.WebSocket.prototype=WS.prototype;['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(function(k){window.WebSocket[k]=WS[k];});}
function store(){var data={};saved.forEach(function(x){data[x.name]=x.value;});return{getItem:function(k){return Object.prototype.hasOwnProperty.call(data,k)?data[k]:null;},setItem:function(k,v){data[k]=String(v);},removeItem:function(k){delete data[k];},clear:function(){data={};},key:function(i){return Object.keys(data)[i]||null;},get length(){return Object.keys(data).length;}};}
try{Object.defineProperty(window,'localStorage',{value:store()});Object.defineProperty(window,'sessionStorage',{value:store()});}catch(e){}
setInterval(function(){nativeFetch(prefix+'/__dvs_keepalive',{credentials:'omit'}).catch(function(){});},60000);
})();</script>`;
  }
  async handle(req, res, url) {
    const resolved = this.resolve(url);
    res.setHeader('access-control-allow-origin', 'null');
    res.setHeader('access-control-allow-methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type,authorization,range,x-requested-with');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('cross-origin-resource-policy', 'cross-origin');
    if (!resolved) { res.writeHead(401); res.end('Sessao de exibicao expirada. Recarregue o painel.'); return; }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const { session, target } = resolved;
    if (target.pathname === '/__dvs_keepalive') { res.writeHead(204); res.end(); return; }
    const headers = { cookie: this.cookieHeader(session, target), 'accept-encoding': 'identity', origin: session.origin, referer: session.origin + '/' };
    for (const key of ['accept', 'content-type', 'authorization', 'range', 'if-range', 'user-agent', 'content-length']) if (req.headers[key]) headers[key] = req.headers[key];
    const upstream = (target.protocol === 'https:' ? https : http).request(target, { method: req.method, headers }, response => {
      this.rememberCookies(session, response.headers['set-cookie'], target);
      const location = response.headers.location;
      if (location) {
        const next = new URL(location, target);
        if (next.origin !== session.origin) { res.writeHead(502); res.end('Redirecionamento externo nao suportado nesta sessao'); response.resume(); return; }
        res.setHeader('location', session.prefix + next.pathname + next.search);
      }
      const type = String(response.headers['content-type'] || 'application/octet-stream');
      res.setHeader('content-type', type);
      // The sandbox is essential: upstream scripts must never gain the DVS origin.
      res.setHeader('content-security-policy', "sandbox allow-scripts allow-forms allow-popups; default-src 'self' http: https: ws: wss: data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' http: https: blob:; style-src 'self' 'unsafe-inline' http: https:; connect-src http: https: ws: wss:");
      res.removeHeader('x-frame-options');
      if (/text\/html|javascript|text\/css/.test(type)) {
        let size = 0, chunks = [];
        response.on('data', chunk => { size += chunk.length; if (size > 12 * 1024 * 1024) upstream.destroy(new Error('Documento do painel excedeu o limite')); else chunks.push(chunk); });
        response.on('end', () => {
          let body = this.rewrite(Buffer.concat(chunks).toString('utf8'), session);
          if (/text\/html/.test(type)) body = body.replace(/<head([^>]*)>/i, (match) => match + this.bootstrap(session));
          res.writeHead(response.statusCode); res.end(body);
        });
      } else {
        for (const key of ['content-range', 'accept-ranges']) if (response.headers[key]) res.setHeader(key, response.headers[key]);
        res.writeHead(response.statusCode); response.pipe(res);
      }
    });
    upstream.setTimeout(30000, () => upstream.destroy(new Error('Tempo de resposta do painel esgotado')));
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); if (!res.destroyed) res.end('Falha de comunicacao com o painel'); });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  }
  upgrade(req, socket, head) {
    const resolved = this.resolve(new URL(req.url, 'http://localhost'));
    if (!resolved) { socket.destroy(); return; }
    const { session, target } = resolved;
    const headers = { host: target.host, origin: session.origin, cookie: this.cookieHeader(session, target), connection: 'Upgrade', upgrade: 'websocket' };
    for (const key of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol']) if (req.headers[key]) headers[key] = req.headers[key];
    const upstream = (target.protocol === 'https:' ? https : http).request(target, { headers });
    upstream.on('upgrade', (response, remote, remoteHead) => {
      session.sockets.add(remote);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).filter(([k]) => !['set-cookie'].includes(k)).map(([k,v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (remoteHead.length) socket.write(remoteHead); if (head.length) remote.write(head);
      socket.pipe(remote).pipe(socket);
      socket.on('close', () => { remote.destroy(); session.sockets.delete(remote); });
      remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
    });
    upstream.on('response', response => { response.resume(); socket.destroy(); });
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.end();
  }
  close() { clearInterval(this.timer); for (const session of this.sessions.values()) for (const socket of session.sockets) socket.destroy(); this.sessions.clear(); }
}
module.exports = { DirectSessions };
