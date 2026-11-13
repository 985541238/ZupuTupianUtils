# ZupuWorkbench service control helper (stop / start / restart).
# Keep this file ASCII-only (Windows PowerShell 5 reads BOM-less files as ANSI/GBK).
# Usage: service-control.ps1 stop | start | restart
param(
  [Parameter(Mandatory = $false)]
  [string]$Action = 'restart'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$taskName = 'ZupuWorkbench'

# Read port from server\.env (prod server keeps PORT in .env or .env.production), fallback 8090
$port = 8090
foreach ($f in @('server\.env', 'server\.env.production')) {
  $p = Join-Path $root $f
  if (Test-Path $p) {
    $m = Select-String -Path $p -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
    if ($m) {
      $port = [int]$m.Matches[0].Groups[1].Value
      break
    }
  }
}

function Say($m) {
  $line = ((Get-Date -Format 'HH:mm:ss') + '  ' + $m)
  Write-Host $line
}

function PortListening() {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  return [bool]$c
}

function WaitPort([bool]$up, [int]$seconds = 60) {
  for ($i = 0; $i -lt $seconds; $i++) {
    if ((PortListening) -eq $up) { return $true }
    Start-Sleep -Seconds 1
  }
  return ((PortListening) -eq $up)
}

function Stop-Svc() {
  Say ('stopping ' + $taskName + ' ...')
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    try { Stop-ScheduledTask -TaskName $taskName } catch { }
  } else {
    Say 'scheduled task not found'
  }
  Start-Sleep -Seconds 2
  if (PortListening) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      ForEach-Object { try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } catch { } }
  }
  if (WaitPort $false 30) {
    Say ('stopped, port ' + $port + ' is free')
  } else {
    Say ('WARN: port ' + $port + ' is still in use')
  }
}

function Start-Svc() {
  Say ('starting ' + $taskName + ' ...')
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Start-ScheduledTask -TaskName $taskName
  } else {
    $startCmd = Join-Path $PSScriptRoot 'start.cmd'
    if (-not (Test-Path $startCmd)) { throw 'scheduled task missing and start.cmd not found' }
    Start-Process -FilePath $startCmd -WorkingDirectory $root -WindowStyle Hidden
  }
  if (-not (WaitPort $true 60)) { throw ('service did not listen on port ' + $port) }
  Say ('listening on port ' + $port)
  try {
    $r = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + '/') -UseBasicParsing -TimeoutSec 15
    Say ('http GET / -> ' + $r.StatusCode)
  } catch {
    Say ('WARN: http check failed: ' + $_.Exception.Message)
  }
}

switch ($Action.ToLower()) {
  'stop' { Stop-Svc }
  'start' { Start-Svc }
  'restart' { Stop-Svc; Start-Svc }
  default { throw 'usage: service-control.ps1 stop|start|restart' }
}
