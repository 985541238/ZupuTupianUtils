# 族谱清晰化工作台 - Windows 服务器一键安装（以管理员身份运行 PowerShell）
# 用法：在仓库根目录执行  powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root

function Need($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "未找到 $cmd。$hint" }
}
Write-Host '== 1/6 检查环境' -ForegroundColor Cyan
Need node   '请安装 Node.js 20/22 LTS：https://nodejs.org'
Need npm    '随 Node.js 安装'
$py = $null
foreach ($c in 'python','py') { if (Get-Command $c -ErrorAction SilentlyContinue) { $py = $c; break } }
if (-not $py) { throw '未找到 Python。请安装 Python 3.10+（勾选 Add to PATH）：https://www.python.org' }
node -v; & $py --version

Write-Host '== 2/6 安装 Python 依赖（图片处理用）' -ForegroundColor Cyan
& $py -m pip install --upgrade pip
& $py -m pip install opencv-python-headless numpy scipy

Write-Host '== 3/6 安装并构建服务端' -ForegroundColor Cyan
Push-Location server
npm ci
npm run build:prod
Pop-Location

Write-Host '== 4/6 构建管理端' -ForegroundColor Cyan
Push-Location admin-web
npm ci
npm run build
Pop-Location

Write-Host '== 5/6 生成配置 server\.env' -ForegroundColor Cyan
$envFile = Join-Path $root 'server\.env'
if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $PSScriptRoot 'env.example') $envFile
  $secret = -join ((48..57 + 65..90 + 97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
  $enc = -join ((48..57 + 65..90 + 97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
  (Get-Content $envFile -Raw).Replace('__JWT_SECRET__', $secret).Replace('__SETTINGS_SECRET__', $enc) | Set-Content $envFile -Encoding UTF8
  Write-Host "已生成 $envFile ，请打开填写数据库账号密码（DB_USER / DB_PASS）。" -ForegroundColor Yellow
} else { Write-Host '已存在 server\.env，保持不变' }

Write-Host '== 6/6 开机自启（计划任务）' -ForegroundColor Cyan
& (Join-Path $PSScriptRoot 'register-service.ps1')

Write-Host ''
Write-Host '安装完成。接下来：' -ForegroundColor Green
Write-Host '  1) 在 MySQL 建库并导入 sql\ 下脚本（见 deploy\windows\README.md 第 3 步）'
Write-Host '  2) 编辑 server\.env 填数据库密码'
Write-Host '  3) 运行 deploy\windows\start.cmd 或重启服务器，然后访问 http://服务器IP:8081'
