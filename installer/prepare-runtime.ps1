$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vendor = Join-Path $root 'vendor'
$postgres = Join-Path $vendor 'postgresql'
$archive = Join-Path $vendor 'postgresql.zip'
$winsw = Join-Path $vendor 'WinSW-x64.exe'
$webosNode = Join-Path $vendor 'webos-node.exe'
$webosCliRuntime = Join-Path $vendor 'webos-cli-runtime'
$playwrightBrowsers = Join-Path $vendor 'playwright-browsers'

New-Item -ItemType Directory -Force -Path $vendor | Out-Null
if (-not (Test-Path $winsw)) {
  & curl.exe --fail --location --retry 3 --output $winsw 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao baixar WinSW.' }
}
if (-not (Test-Path $webosNode) -or (Get-Item -LiteralPath $webosNode).Length -lt 50MB) {
  $nodeBase = 'https://nodejs.org/download/release/latest-v24.x'
  $checksums = Join-Path $vendor 'node-SHASUMS256.txt'
  & curl.exe --fail --location --retry 3 --output $checksums "$nodeBase/SHASUMS256.txt"
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao baixar checksums do Node.js 24 LTS.' }
  $line = Get-Content -LiteralPath $checksums | Where-Object { $_ -match '\swin-x64/node\.exe$' } | Select-Object -First 1
  if (-not $line) { throw 'Checksum do node.exe para Windows x64 nao encontrado.' }
  $expected = ($line -split '\s+')[0].ToUpperInvariant()
  & curl.exe --fail --location --retry 3 --output $webosNode "$nodeBase/win-x64/node.exe"
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao baixar Node.js 24 LTS para a CLI webOS.' }
  $actual = (Get-FileHash -LiteralPath $webosNode -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($actual -ne $expected) {
    Remove-Item -LiteralPath $webosNode -Force
    throw 'Checksum do Node.js 24 LTS invalido.'
  }
  Remove-Item -LiteralPath $checksums -Force
}
if (-not (Test-Path (Join-Path $webosCliRuntime 'node_modules\@webos-tools\cli\bin\ares.js'))) {
  if (Test-Path $webosCliRuntime) { Remove-Item -LiteralPath $webosCliRuntime -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $webosCliRuntime | Out-Null
  & npm.cmd install --prefix $webosCliRuntime --omit=dev --ignore-scripts --no-audit --no-fund --save-exact '@webos-tools/cli@3.2.5'
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao preparar a CLI webOS isolada.' }
}
$headlessShell = Get-ChildItem -Path $playwrightBrowsers -Filter 'chrome-headless-shell.exe' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $headlessShell) {
  New-Item -ItemType Directory -Force -Path $playwrightBrowsers | Out-Null
  $previousBrowsersPath = $env:PLAYWRIGHT_BROWSERS_PATH
  try {
    $env:PLAYWRIGHT_BROWSERS_PATH = $playwrightBrowsers
    & npx.cmd playwright install chromium --only-shell --no-progress
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar o Chromium headless do Playwright.' }
  } finally {
    $env:PLAYWRIGHT_BROWSERS_PATH = $previousBrowsersPath
  }
  $headlessShell = Get-ChildItem -Path $playwrightBrowsers -Filter 'chrome-headless-shell.exe' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $headlessShell) { throw 'Chromium headless nao foi preparado no runtime do instalador.' }
}
if (-not (Test-Path (Join-Path $postgres 'bin\initdb.exe'))) {
  if (-not (Test-Path $archive) -or (Get-Item -LiteralPath $archive).Length -lt 300MB) {
    if (Test-Path $archive) { Remove-Item -LiteralPath $archive -Force }
    & curl.exe --fail --location --retry 3 --output $archive 'https://get.enterprisedb.com/postgresql/postgresql-17.11-1-windows-x64-binaries.zip'
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao baixar PostgreSQL.' }
  }
  $extract = Join-Path $vendor 'postgresql-extract'
  if (Test-Path $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $extract | Out-Null
  & tar.exe -xf $archive -C $extract
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao expandir PostgreSQL.' }
  $payload = Join-Path $extract 'pgsql'
  if (-not (Test-Path (Join-Path $payload 'bin\initdb.exe'))) { throw 'Arquivo PostgreSQL sem a estrutura esperada.' }
  if (Test-Path $postgres) { Remove-Item -LiteralPath $postgres -Recurse -Force }
  Move-Item -LiteralPath $payload -Destination $postgres
  Remove-Item -LiteralPath $extract -Recurse -Force
  Remove-Item -LiteralPath $archive -Force
}
$unneeded = @('pgAdmin 4', 'StackBuilder', 'doc', 'include')
foreach ($name in $unneeded) {
  $target = Join-Path $postgres $name
  if (Test-Path $target) {
    $item = Get-Item -LiteralPath $target -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point inesperado no runtime: $target" }
    Remove-Item -LiteralPath $target -Recurse -Force
  }
}
Write-Host 'Runtimes do instalador preparados.'
