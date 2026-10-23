param(
  [string]$OutputPath = "C:\DVS Controller\installer-diagnostic.txt"
)

$ErrorActionPreference = "Continue"
$dataDir = "C:\ProgramData\DVS Controller"
$lines = [System.Collections.Generic.List[string]]::new()

function Add-Section([string]$Title) {
  $lines.Add("")
  $lines.Add("=== $Title ===")
}

function Add-CommandOutput([scriptblock]$Command) {
  try {
    $value = & $Command 2>&1 | Out-String -Width 240
    $lines.Add($value.TrimEnd())
  } catch {
    $lines.Add($_.Exception.Message)
  }
}

$lines.Add("DVS Controller installer diagnostic")
$lines.Add("Generated: $([DateTime]::Now.ToString('o'))")

Add-Section "Data directory ACL"
Add-CommandOutput { icacls.exe $dataDir }
Add-CommandOutput {
  $configPath = Join-Path $dataDir "service-config.json"
  if (Test-Path -LiteralPath $configPath) {
    Get-Item -LiteralPath $configPath -Force | Select-Object FullName, Attributes, IsReadOnly
    icacls.exe $configPath
    Get-Acl -LiteralPath $configPath | Select-Object Owner, AccessToString
  }
}

Add-Section "Data directory files"
Add-CommandOutput {
  if (Test-Path -LiteralPath $dataDir) {
    Get-ChildItem -LiteralPath $dataDir -Force | Select-Object FullName, Length, LastWriteTime
    foreach ($keyFile in @("postgres\PG_VERSION", "service\DVSControllerService.xml")) {
      $target = Join-Path $dataDir $keyFile
      if (Test-Path -LiteralPath $target) { Get-Item -LiteralPath $target | Select-Object FullName, Length, LastWriteTime }
    }
  } else {
    "Directory not found: $dataDir"
  }
}

Add-Section "DVS services"
Add-CommandOutput {
  Get-CimInstance Win32_Service |
    Where-Object { $_.Name -like "DVS*" -or $_.DisplayName -like "*DVS*" } |
    Select-Object Name, DisplayName, State, StartMode, StartName, ExitCode, PathName
}

Add-Section "Relevant ports"
Add-CommandOutput { netstat.exe -ano | Select-String -Pattern ":3080\s|:3091\s|:5432\s" }

Add-Section "DVS logs"
Add-CommandOutput {
  if (Test-Path -LiteralPath $dataDir) {
    Get-ChildItem -LiteralPath $dataDir -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Extension -in ".log", ".txt" -or $_.Name -match "\.out\.log$|\.err\.log$" } |
      ForEach-Object {
        "--- $($_.FullName)"
        Get-Content -LiteralPath $_.FullName -Tail 200 -ErrorAction SilentlyContinue
      }
  }
}

Add-Section "Service Control Manager events"
Add-CommandOutput {
  Get-WinEvent -FilterHashtable @{ LogName = "System"; StartTime = (Get-Date).AddHours(-6) } -ErrorAction SilentlyContinue |
    Where-Object { $_.ProviderName -eq "Service Control Manager" -and $_.Message -match "DVSController|DVS Controller" } |
    Select-Object -First 30 TimeCreated, Id, LevelDisplayName, Message
}

[IO.File]::WriteAllLines($OutputPath, $lines, [Text.UTF8Encoding]::new($false))
