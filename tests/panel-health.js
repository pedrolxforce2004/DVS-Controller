const assert = require('node:assert/strict');
const http = require('node:http');
const { PanelHealth } = require('../lib/panel-health');
(async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (req.url === '/slow') return;
    if (req.url === '/redirect') { res.writeHead(302, { location: '/missing' }); return res.end(); }
    res.writeHead(req.url === '/missing' ? 404 : 200); res.end('fixture');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = new PanelHealth({ timeout: 150, concurrency: 1 });
  try {
    assert.equal((await health.check({ id: 'a', url: base })).status, 'reachable');
    await health.check({ id: 'a', url: base }); assert.equal(hits, 1, 'cache prevents repeated probes');
    assert.equal((await health.check({ id: 'a', url: base + '/missing' })).httpStatus, 404);
    assert.equal((await health.check({ id: 'b', url: base + '/redirect' })).status, 'error');
    const pending = health.check({ id: 'c', url: base + '/slow' });
    assert.equal((await health.check({ id: 'd', url: base })).status, 'unknown');
    assert.equal((await pending).status, 'error');
    assert.equal((await health.check({ id: 'e', url: 'file:///private' })).status, 'error');
    console.log('Panel health: HTTP, redirect, timeout, cache and concurrency OK');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
