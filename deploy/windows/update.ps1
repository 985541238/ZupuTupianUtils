# One-click update: backup -> stop service -> npm install -> build -> start service -> check port
# NOTE: keep this file ASCII-only (Windows PowerShell 5 reads BOM-less files as ANSI/GBK).
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$task = 'ZupuWorkbench'
$port = 8090
Set-Location $root

function Step($m) { Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }

try {
  Step 'Backup current build output to backup\ (latest copy only)'
  $bk = Join-Path $root 'backup'
  New-Item -ItemType Directory $bk -Force | Out-Null
  foreach ($d in @('server\dist', 'admin-web\dist')) {
    $src = Join-Path $root $d
    if (Test-Path $src) {
      $dst = Join-Path $bk ($d -replace '\\', '-')
      if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
      Copy-Item $src $dst -Recurse
    }
  }

  Step "Stop scheduled task $task"
  Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  # Fallback: kill any old process still holding the port
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

  Step 'npm install (server)'
  npm --prefix server install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'server npm install failed' }

  Step 'npm install (admin-web)'
  npm --prefix admin-web install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'admin-web npm install failed' }

  Step 'Build server + admin-web'
  npm run build:prod
  if ($LASTEXITCODE -ne 0) { throw 'build failed' }

  Step "Start scheduled task $task"
  Start-ScheduledTask -TaskName $task
  Start-Sleep -Seconds 6

  Step "Check port $port"
  $ok = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($ok) {
    Write-Host "UPDATE DONE. Service is listening on port $port. Press Ctrl+F5 in the browser." -ForegroundColor Green
  } else {
    Write-Host "Service is NOT listening on port $port. Check the tail of logs\server.log." -ForegroundColor Red
  }
} catch {
  Write-Host ""
  Write-Host ("UPDATE FAILED: " + $_.Exception.Message) -ForegroundColor Red
  Write-Host "Previous build is in backup\ (server-dist, admin-web-dist). Restore it and start the task again if needed." -ForegroundColor Yellow
}
