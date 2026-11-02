# 打更新包：排除依赖、编译产物、数据与本地配置；带上 server/.env.production
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$name = "zupu-update-$(Get-Date -Format 'yyyyMMdd-HHmm')"
$stage = Join-Path $env:TEMP $name
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory $stage | Out-Null
$xd = @('node_modules','dist','.git','.idea','.vscode','data','logs','backup','待处理的图片','待处理的图片 - 副本','新建文件夹')
robocopy $root $stage /E /XD $xd /XF *.log .env /NFL /NDL /NJH /NJS | Out-Null
# robocopy 会排除所有同名 .env，这里把线上配置补回去
Copy-Item (Join-Path $root 'server\.env.production') (Join-Path $stage 'server\.env.production') -Force
$zip = Join-Path $root "$name.zip"
Compress-Archive -Path "$stage\*" -DestinationPath $zip -Force
Remove-Item $stage -Recurse -Force
Write-Host "已生成：$zip"
