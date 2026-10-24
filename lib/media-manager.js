const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const streams = new Map();
const MAX_STREAMS = Math.max(1, Number(process.env.MAX_RTSP_STREAMS || 8));
const IDLE_TIMEOUT_MS = Math.max(30000, Number(process.env.RTSP_IDLE_TIMEOUT_MS || 2 * 60 * 1000));
const STARTUP_TIMEOUT_MS = Math.max(10000, Number(process.env.RTSP_STARTUP_TIMEOUT_MS || 30000));

function ffmpegPath() {
  try {
    const binary = require("ffmpeg-static");
    const unpacked = binary && binary.replace(/([\\/])app\.asar([\\/])/i, "$1app.asar.unpacked$2");
    return unpacked && fs.existsSync(unpacked) ? unpacked : binary;
  } catch (_) {
    return "";
  }
}

function cleanStreamFiles(directory) {
  fs.mkdirSync(directory, { recursive: true });
  for (const name of fs.readdirSync(directory)) {
    if (/^(index\.m3u8|segment\d+\.ts|preview\.jpg)$/.test(name)) {
      fs.unlinkSync(path.join(directory, name));
    }
  }
}

function startRtsp(panelId, sourceUrl, outputRoot) {
  const current = streams.get(panelId);
  if (current && current.process && current.process.exitCode === null) {
    current.lastAccess = Date.now();
    return current;
  }
  if (current) streams.delete(panelId);
  if (streams.size >= MAX_STREAMS) {
    const error = new Error(`Limite de ${MAX_STREAMS} streams RTSP simultaneos atingido`);
    error.code = "DVS_RTSP_LIMIT_REACHED";
    throw error;
  }
  const binary = ffmpegPath();
  if (!binary) throw new Error("FFmpeg nao esta disponivel no servidor");
  const directory = path.join(outputRoot, panelId);
  cleanStreamFiles(directory);
  const playlistPath = path.join(directory, "index.m3u8");
  const previewPath = path.join(directory, "preview.jpg");
  const args = [
    "-hide_banner", "-loglevel", "warning", "-rtsp_transport", "tcp", "-i", sourceUrl,
    "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast",
    "-tune", "zerolatency", "-profile:v", "baseline", "-level", "3.1", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k", "-ar", "44100", "-f", "hls", "-hls_time", "2",
    "-hls_list_size", "5", "-hls_flags", "delete_segments+append_list+independent_segments",
    "-hls_segment_filename", path.join(directory, "segment%d.ts"), playlistPath,
    "-map", "0:v:0", "-vf", "fps=1/2", "-q:v", "4", "-update", "1", "-y", previewPath
  ];
  const child = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  const info = { process: child, startedAt: Date.now(), lastAccess: Date.now(), error: "", log: "", directory, playlistPath, previewPath, startupTimer: null };
  streams.set(panelId, info);
  child.stderr.on("data", (chunk) => {
    const safe = chunk.toString().split(sourceUrl).join("[fonte RTSP]").replace(/(rtsps?:\/\/)[^\s/@]+@/gi, "$1[credenciais]@");
    info.log = (info.log + safe).slice(-4000);
  });
  child.on("error", (err) => { info.error = err.message; });
  child.on("close", (code) => {
    if (info.startupTimer) clearTimeout(info.startupTimer);
    if (code !== 0 && !info.stopped) info.error = info.log || `FFmpeg terminou com codigo ${code}`;
  });
  info.startupTimer = setTimeout(() => {
    if (fs.existsSync(playlistPath) || child.exitCode !== null) return;
    info.error = `RTSP nao produziu dados em ${STARTUP_TIMEOUT_MS / 1000}s`;
    info.stopped = true;
    child.kill();
  }, STARTUP_TIMEOUT_MS);
  info.startupTimer.unref();
  return info;
}

function stop(panelId) {
  const info = streams.get(panelId);
  if (!info) return;
  info.stopped = true;
  if (info.startupTimer) clearTimeout(info.startupTimer);
  if (info.process && info.process.exitCode === null) info.process.kill();
  streams.delete(panelId);
}

function stopAll() {
  for (const panelId of Array.from(streams.keys())) stop(panelId);
}

function status(panelId) {
  const info = streams.get(panelId);
  if (!info) return null;
  return {
    running: Boolean(info.process && info.process.exitCode === null),
    startedAt: info.startedAt,
    error: info.error,
    log: info.error ? info.log : ""
  };
}

function cleanupIdle() {
  const cutoff = Date.now() - IDLE_TIMEOUT_MS;
  for (const [panelId, info] of streams.entries()) {
    if (Number(info.lastAccess || info.startedAt) < cutoff) stop(panelId);
  }
}

setInterval(cleanupIdle, 30000).unref();

function waitForFile(filePath, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) return resolve(true);
      if (Date.now() - started >= timeoutMs) return resolve(false);
      setTimeout(check, 200);
    };
    check();
  });
}

module.exports = { ffmpegPath, startRtsp, stop, stopAll, status, waitForFile };
