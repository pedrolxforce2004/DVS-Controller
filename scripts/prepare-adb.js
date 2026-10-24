const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const spec = require('../vendor/android/runtime.json');
const root = path.resolve(__dirname, '..');
const destination = path.join(root, 'vendor/android/platform-tools');
const hash = p => fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : '';
(async () => {
  if (process.platform !== 'win32') throw new Error('O runtime ADB empacotado destina-se ao Windows');
  if (Object.entries(spec.files).every(([name, expected]) => hash(path.join(destination, name)) === expected)) {
    console.log(`ADB Android Platform-Tools ${spec.version}: arquivos e hashes conferidos`); return;
  }
  const cache = path.join(root, 'artifacts/adb-download'); fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, 'platform-tools.zip');
  if (hash(archive) !== spec.sha256) {
    const response = await fetch(spec.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Download ADB: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== spec.sha256) throw new Error('Checksum do download ADB invalido');
    fs.writeFileSync(archive, bytes);
  }
  const extract = fs.mkdtempSync(path.join(cache, 'extract-'));
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:DVS_ADB_ARCHIVE, $env:DVS_ADB_EXTRACT)'], { env: { ...process.env, DVS_ADB_ARCHIVE: archive, DVS_ADB_EXTRACT: extract }, windowsHide: true, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Nao foi possivel extrair o runtime ADB');
    for (const [name, expected] of Object.entries(spec.files)) if (hash(path.join(extract, 'platform-tools', name)) !== expected) throw new Error('Arquivo ADB invalido: ' + name);
    fs.mkdirSync(destination, { recursive: true });
    for (const name of Object.keys(spec.files)) fs.copyFileSync(path.join(extract, 'platform-tools', name), path.join(destination, name));
    console.log(`ADB ${spec.version} preparado com DLLs, licencas e verificacao SHA-256`);
  } finally {
    if (!path.resolve(extract).startsWith(path.resolve(cache) + path.sep)) throw new Error('Diretorio temporario inesperado');
    fs.rmSync(extract, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
