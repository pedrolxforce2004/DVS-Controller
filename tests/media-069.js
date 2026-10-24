const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const net = require('node:net');
const media = require('../lib/media-manager');
(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dvs-media-069-'));
  try {
    const binary = media.ffmpegPath(); assert.ok(fs.existsSync(binary), 'FFmpeg instalado');
    const generated = spawnSync(binary, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', '-f', 'hls', '-hls_time', '1', '-hls_segment_filename', path.join(temp, 'segment%d.ts'), path.join(temp, 'index.m3u8')], { windowsHide: true, encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    assert.match(fs.readFileSync(path.join(temp, 'index.m3u8'), 'utf8'), /#EXTM3U/);
    assert.ok(fs.statSync(path.join(temp, 'segment0.ts')).size > 0);
    const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r));
    const stream = media.startRtsp('fixture', `rtsp://fixture-user:private-password@127.0.0.1:${port}/stream`, temp);
    await new Promise(resolve => stream.process.once('close', resolve));
    const status = media.status('fixture'); assert.ok(status.error); assert.ok(!JSON.stringify(status).includes('private-password')); assert.ok(!JSON.stringify(status).includes('fixture-user'));
    media.stop('fixture'); assert.equal(media.status('fixture'), null);
    console.log('Midia 0.6.9: FFmpeg real gera HLS/segmentos, RTSP indisponivel reporta falha sem credenciais e encerra stream: OK');
  } finally { media.stopAll(); fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(err => { console.error(err); process.exitCode = 1; });
