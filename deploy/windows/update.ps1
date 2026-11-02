# 一键更新部署：备份旧编译产物 → 停服务 → 安装依赖 → 编译前后端 → 启服务 → 检查端口
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$task = 'ZupuWorkbench'
$port = 8090
Set-Location $root

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }

try {
  Step '备份当前编译产物（保留最近一份到 backup\）'
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

  Step "停止计划任务 $task"
  Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  # 兜底：结束仍占用端口的旧进程
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

  Step '安装服务端依赖'
  npm --prefix server install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'server npm install 失败' }

  Step '安装前端依赖'
  npm --prefix admin-web install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'admin-web npm install 失败' }

  Step '编译前后端'
  npm run build:prod
  if ($LASTEXITCODE -ne 0) { throw '编译失败' }

  Step "启动计划任务 $task"
  Start-ScheduledTask -TaskName $task
  Start-Sleep -Seconds 6

  Step "检查端口 $port"
  $ok = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($ok) {
    Write-Host "更新完成，服务已在端口 $port 运行。请在浏览器按 Ctrl+F5 刷新。" -ForegroundColor Green
  } else {
    Write-Host "服务未监听端口 $port，请查看 logs\server.log 末尾的报错。" -ForegroundColor Red
  }
} catch {
  Write-Host "`n更新失败：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host "旧版本备份在 backup\ 目录（server-dist、admin-web-dist），可还原后再启动计划任务。" -ForegroundColor Yellow
}
