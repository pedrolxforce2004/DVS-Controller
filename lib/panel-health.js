const http = require('http');
const https = require('https');

// One bounded probe per panel, shared by receivers. Never download response bodies.
class PanelHealth {
  constructor({ ttl = 30000, timeout = 8000, concurrency = 4 } = {}) {
    this.ttl = ttl; this.timeout = timeout; this.concurrency = concurrency;
    this.cache = new Map(); this.pending = new Map(); this.active = 0;
  }
  async check(panel) {
    const key = panel.id;
    const cached = this.cache.get(key);
    if (cached && cached.url === panel.url && Date.now() - cached.time < this.ttl) return cached.result;
    if (this.pending.has(key)) return this.pending.get(key);
    if (this.active >= this.concurrency) return { status: 'unknown', reason: 'Aguardando verificacao' };
    this.active++;
    const task = this.probe(panel.url).then(result => {
      this.cache.set(key, { url: panel.url, time: Date.now(), result });
      if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
      return result;
    }).finally(() => { this.active--; this.pending.delete(key); });
    this.pending.set(key, task);
    return task;
  }
  probe(raw, redirects = 0, deadline = Date.now() + this.timeout) {
    return new Promise(resolve => {
      let url;
      try { url = new URL(raw); } catch (_) { return resolve({ status: 'error', reason: 'URL invalida' }); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || redirects > 4 || Date.now() >= deadline) {
        return resolve({ status: 'error', reason: 'Destino ou redirecionamento invalido' });
      }
      let finished = false;
      const done = result => { if (!finished) { finished = true; clearTimeout(timer); resolve(result); } };
      const request = (url.protocol === 'https:' ? https : http).get(url, { headers: { 'user-agent': 'DVS-Link-Check/0.6.9', range: 'bytes=0-0' } }, response => {
        const code = response.statusCode;
        const location = response.headers.location;
        response.destroy();
        if (code >= 300 && code < 400 && location) {
          let next;
          try { next = new URL(location, url).href; } catch (_) { return done({ status: 'error', reason: 'Redirecionamento invalido' }); }
          this.probe(next, redirects + 1, deadline).then(done);
        } else done({ status: code >= 400 ? 'error' : 'reachable', httpStatus: code, reason: code >= 400 ? `HTTP ${code}` : '' });
      });
      const timer = setTimeout(() => { done({ status: 'error', reason: 'Tempo de resposta esgotado' }); request.destroy(); }, Math.max(1, deadline - Date.now()));
      request.on('error', () => done({ status: 'error', reason: 'Falha de conexao ou certificado TLS' }));
    });
  }
}
module.exports = { PanelHealth };
