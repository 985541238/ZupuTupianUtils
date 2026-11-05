# Deploy a PREBUILT package (no npm install / no compile on the server).
# Flow: stop task -> backup dist -> db dump -> schema migrate -> copy prebuilt dist -> start -> verify
# Keep this file ASCII-only (Windows PowerShell 5 reads BOM-less files as ANSI/GBK).
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$taskName = 'ZupuWorkbench'
$port = 8090
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory $logDir -Force | Out-Null }
$log = Join-Path $logDir ('deploy-' + $stamp + '.log')

function Say($m) {
  $line = ((Get-Date -Format 'HH:mm:ss') + '  ' + $m)
  Write-Host $line
  try { Add-Content -Path $log -Value $line -Encoding UTF8 } catch { }
}
function Step($m) { Write-Host ''; Write-Host ('==> ' + $m) -ForegroundColor Cyan }

function Find-Tool($exe) {
  $c = Get-Command $exe -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $bases = @("$env:ProgramFiles\MySQL", "${env:ProgramFiles(x86)}\MySQL", 'C:\mysql', 'D:\mysql', 'C:\Program Files\MariaDB*')
  foreach ($b in $bases) {
    $dirs = Get-Item $b -ErrorAction SilentlyContinue
    if (-not $dirs) { continue }
    foreach ($d in $dirs) {
      $hit = Get-ChildItem $d.FullName -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path (Join-Path $_.FullName 'bin') $exe } |
        Where-Object { Test-Path $_ } | Select-Object -First 1
      if ($hit) { return $hit }
    }
  }
  return $null
}

# ---------- read db config ----------
$envFile = Join-Path $root 'server\.env'
if (-not (Test-Path $envFile)) { $envFile = Join-Path $root 'server\.env.production' }
$cfg = @{}
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$') { $cfg[$matches[1].ToUpper()] = $matches[2].Trim() }
  }
}
$dbName = if ($cfg['DB_NAME']) { $cfg['DB_NAME'] } else { 'zupu_scan' }
$dbUser = if ($cfg['DB_USER']) { $cfg['DB_USER'] } else { 'zupu' }
$dbPass = if ($cfg.ContainsKey('DB_PASS')) { $cfg['DB_PASS'] } else { '' }

Say ('project root : ' + $root)
Say ('log file      : ' + $log)
Say ('database      : ' + $dbName + ' / ' + $dbUser)
if ($dbPass -eq '') { Say 'WARN: DB_PASS is empty, skip db dump and schema migrate' }

# ---------- 1. stop service ----------
Step "Stop scheduled task $taskName and free port $port"
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Say 'scheduled task stopped'
} else {
  Say 'scheduled task not found, skip'
}
Start-Sleep -Seconds 2
Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

# ---------- 2. backup ----------
Step 'Backup current build output'
$bk = Join-Path $root ('backup\' + $stamp)
New-Item -ItemType Directory $bk -Force | Out-Null
foreach ($d in @('server\dist', 'admin-web\dist')) {
  $src = Join-Path $root $d
  if (Test-Path $src) {
    $dst = Join-Path $bk ($d -replace '\\', '-')
    Copy-Item $src $dst -Recurse -Force
    Say ('backed up ' + $d)
  }
}

# ---------- 3. database dump ----------
if ($dbPass -ne '') {
  Step 'Dump database'
  $dump = Find-Tool 'mysqldump.exe'
  if ($dump) {
    $out = Join-Path $bk ('db-' + $dbName + '-' + $stamp + '.sql')
    $err = Join-Path $bk 'dump.err.txt'
    try {
      Start-Process -FilePath $dump -NoNewWindow -Wait `
        -ArgumentList @("-u$dbUser", "-p$dbPass", '--single-transaction', '--no-tablespaces', '--databases', $dbName) `
        -RedirectStandardOutput $out -RedirectStandardError $err
      Say ('db dump ok : ' + $out + '  (' + [math]::Round((Get-Item $out).Length / 1MB, 2) + ' MB)')
    } catch {
      Say ('WARN: db dump failed: ' + $_.Exception.Message)
    }
  } else {
    Say 'WARN: mysqldump.exe not found, skip db dump'
  }
}

# ---------- 4. schema migrate ----------
# Run every sql\migrate_*.sql in name order. All of them are written to be
# re-runnable (CREATE TABLE IF NOT EXISTS / information_schema guards), so a
# repeat run is harmless; a single failure is reported and does not abort.
Step 'Apply schema migrations (sql\migrate_*.sql)'
$mysql = Find-Tool 'mysql.exe'
$sqlFiles = @(Get-ChildItem (Join-Path $root 'sql') -Filter 'migrate_*.sql' -ErrorAction SilentlyContinue | Sort-Object Name)
if ($dbPass -ne '' -and $mysql -and $sqlFiles.Count -gt 0) {
  foreach ($sqlFile in $sqlFiles) {
    $tmp = Join-Path $env:TEMP ('zupu-mig-' + $sqlFile.BaseName + '.sql')
    (Get-Content $sqlFile.FullName -Encoding UTF8) | Where-Object { $_ -notmatch '^\s*USE\s' } |
      Set-Content -Path $tmp -Encoding Default
    try {
      Start-Process -FilePath $mysql -NoNewWindow -Wait `
        -ArgumentList @("-u$dbUser", "-p$dbPass", $dbName) `
        -RedirectStandardInput $tmp `
        -RedirectStandardOutput (Join-Path $env:TEMP 'zupu-mig.out.txt') `
        -RedirectStandardError (Join-Path $env:TEMP 'zupu-mig.err.txt')
      $errTxt = Get-Content (Join-Path $env:TEMP 'zupu-mig.err.txt') -ErrorAction SilentlyContinue |
        Where-Object { $_ -notmatch 'Using a password on the command line' }
      if ($errTxt) {
        Say ('  WARN ' + $sqlFile.Name + ': ' + ($errTxt -join ' '))
      } else {
        Say ('  ok   ' + $sqlFile.Name)
      }
    } catch {
      Say ('  WARN ' + $sqlFile.Name + ' failed: ' + $_.Exception.Message)
    }
  }
  Say ('schema migrations done (' + $sqlFiles.Count + ' files, idempotent)')
} else {
  Say 'WARN: mysql client or sql files missing, skip (app also auto-migrates on boot)'
}

# ---------- 5. copy prebuilt ----------
Step 'Copy prebuilt dist'
$ok = $false
try {
  $pre = Join-Path $root 'prebuilt'
  if (-not (Test-Path $pre)) { throw 'prebuilt folder missing, unzip the package over the project root first' }
  foreach ($pair in @(@('server-dist', 'server\dist'), @('admin-web-dist', 'admin-web\dist'))) {
    $from = Join-Path $pre $pair[0]
    $to = Join-Path $root $pair[1]
    if (-not (Test-Path $from)) { throw ('missing prebuilt\' + $pair[0]) }
    if (-not (Test-Path $to)) { New-Item -ItemType Directory $to -Force | Out-Null }
    $rc = Start-Process -FilePath 'robocopy' -NoNewWindow -Wait -PassThru `
      -ArgumentList @($from, $to, '/E', '/NFL', '/NDL', '/NJH', '/NJS')
    if ($rc.ExitCode -ge 8) { throw ('robocopy failed with code ' + $rc.ExitCode + ' on ' + $pair[1]) }
    Say ('copied -> ' + $pair[1])
  }
  $ok = $true
} catch {
  Say ('FAIL: ' + $_.Exception.Message)
}

# ---------- 6. start + verify ----------
if ($ok) {
  Step "Start scheduled task $taskName"
  try {
    Start-ScheduledTask -TaskName $taskName
    Say 'start requested'
  } catch {
    Say ('WARN: Start-ScheduledTask failed: ' + $_.Exception.Message)
  }
  $listening = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 2
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $listening = $true; break }
  }
  if (-not $listening) {
    # fallback: run the server directly (scheduled task may be missing or failed to start)
    Say 'WARN: task did not bring the port up, starting start.cmd directly'
    $startCmd = Join-Path $root 'deploy\windows\start.cmd'
    if (Test-Path $startCmd) {
      Start-Process -FilePath $startCmd -WorkingDirectory $root -WindowStyle Hidden
      for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Seconds 2
        if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $listening = $true; break }
      }
      if ($listening) { Say 'server started directly (note: not as a scheduled task, re-register it later)' }
    }
  }
  if ($listening) {
    Say ("port $port is listening")
    try {
      $r = Invoke-WebRequest -Uri ("http://127.0.0.1:$port/") -UseBasicParsing -TimeoutSec 15
      Say ('http GET / -> ' + $r.StatusCode)
    } catch {
      Say ('WARN: http GET failed: ' + $_.Exception.Message)
    }
    try {
      Invoke-WebRequest -Uri ("http://127.0.0.1:$port/auth/login") -Method POST -UseBasicParsing -TimeoutSec 15 `
        -ContentType 'application/json' -Body '{"username":"__probe__","password":"__probe__"}' | Out-Null
      Say 'auth probe -> 200 (unexpected)'
    } catch {
      $code = 0
      if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
      Say ('auth probe -> ' + $code + '  (401 = db ok, 500 = db/config broken)')
    }
  } else {
    Say "FAIL: port $port is not listening. Rolling back."
    $ok = $false
  }
}

if (-not $ok) {
  Step 'Rollback to previous dist'
  foreach ($pair in @(@('server-dist', 'server\dist'), @('admin-web-dist', 'admin-web\dist'))) {
    $from = Join-Path $bk $pair[0]
    $to = Join-Path $root $pair[1]
    if (Test-Path $from) {
      Get-ChildItem $to -Recurse -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
      Copy-Item $from $to -Recurse -Force
      Say ('restored ' + $pair[1])
    }
  }
  try { Start-ScheduledTask -TaskName $taskName } catch { }
  Say 'rollback done, service restarted with the previous build'
}

Step 'Tail of logs\server.log'
$serverLog = Join-Path $logDir 'server.log'
if (Test-Path $serverLog) { Get-Content $serverLog -Tail 20 | ForEach-Object { Write-Host $_ } }

Write-Host ''
if ($ok) {
  Write-Host 'DEPLOY DONE. Open http://<server-ip>:8090 and press Ctrl+F5.' -ForegroundColor Green
} else {
  Write-Host 'DEPLOY FAILED. Previous build restored. Check the messages above.' -ForegroundColor Red
}
Write-Host ('Log: ' + $log)
