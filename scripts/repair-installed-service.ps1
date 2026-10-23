$ErrorActionPreference = 'Stop'
$xmlPath = 'C:\ProgramData\DVS Controller\service\DVSControllerService.xml'
$backupPath = 'C:\ProgramData\DVS Controller\service\DVSControllerService.xml.before-quote-fix'
$resultPath = 'C:\DVS Controller\data\service-repair-result.log'
$expected = '<arguments>C:\Program Files\DVS Controller\resources\app.asar\service\host.js</arguments>'
$replacement = '<arguments>&quot;C:\Program Files\DVS Controller\resources\app.asar\service\host.js&quot;</arguments>'

try {
  $content = [IO.File]::ReadAllText($xmlPath)
  if ($content.Contains($expected)) {
    if (-not (Test-Path -LiteralPath $backupPath)) {
      [IO.File]::WriteAllText($backupPath, $content, [Text.UTF8Encoding]::new($false))
    }
    [IO.File]::WriteAllText($xmlPath, $content.Replace($expected, $replacement), [Text.UTF8Encoding]::new($false))
  } elseif (-not $content.Contains($replacement)) {
    throw 'O XML instalado nao possui o argumento conhecido; reparo cancelado.'
  }
  Start-Service -Name 'DVSControllerService'
  Start-Sleep -Seconds 8
  $service = Get-Service -Name 'DVSControllerService'
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3080/api/health' -TimeoutSec 5
  $result = [ordered]@{ success = $true; service = [string]$service.Status; health = $health; at = (Get-Date).ToString('o') }
  [IO.File]::WriteAllText($resultPath, ($result | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
} catch {
  $result = [ordered]@{ success = $false; error = $_.Exception.Message; at = (Get-Date).ToString('o') }
  [IO.File]::WriteAllText($resultPath, ($result | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
  exit 1
}
