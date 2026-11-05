# Pack a PREBUILT update zip: source + compiled dist (server/dist, admin-web/dist).
# Excludes node_modules / dist (kept under prebuilt\) / data / logs / backup / .env*.
# Keep this file ASCII-only (Windows PowerShell 5 reads BOM-less files as ANSI/GBK).
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$name = 'zupu-update-' + (Get-Date -Format 'yyyyMMdd-HHmm')
$stage = Join-Path $env:TEMP ('pack-' + $name)
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory $stage -Force | Out-Null

$exDirs = @('node_modules', 'dist', '.git', '.idea', '.vscode', 'data', 'logs', 'backup', 'prebuilt')
$exFiles = @('.env', '.env.production', '*.log')

# allowlist of top-level items to ship (avoids Chinese-named sample folders)
$items = @('server', 'admin-web', 'sql', 'deploy', 'docs', 'package.json',
  'README.md', 'README.zh-CN.md', 'LICENSE', 'BUILD.md', 'DEPLOY.md', 'STRUCTURE.md', 'ZUPU-README.md')

foreach ($item in $items) {
  $src = Join-Path $root $item
  if (-not (Test-Path $src)) { continue }
  $dst = Join-Path $stage $item
  if ((Get-Item $src).PSIsContainer) {
    $roboArgs = @($src, $dst, '/E', '/XD') + $exDirs + @('/XF') + $exFiles + @('/NFL', '/NDL', '/NJH', '/NJS')
    robocopy @roboArgs | Out-Null
    if ($LASTEXITCODE -ge 8) { throw ('robocopy failed: ' + $item) }
  } else {
    New-Item -ItemType Directory (Split-Path $dst) -Force | Out-Null
    Copy-Item $src $dst -Force
  }
}

# compiled output -> prebuilt\ (never overwrite the live dist before backup)
$pre = Join-Path $stage 'prebuilt'
New-Item -ItemType Directory $pre -Force | Out-Null
foreach ($pair in @(@('server\dist', 'server-dist'), @('admin-web\dist', 'admin-web-dist'))) {
  $src = Join-Path $root $pair[0]
  if (-not (Test-Path $src)) { throw ('build output missing, run npm run build:prod first: ' + $pair[0]) }
  robocopy $src (Join-Path $pre $pair[1]) /E /NFL /NDL /NJH /NJS | Out-Null
  if ($LASTEXITCODE -ge 8) { throw ('robocopy failed: ' + $pair[0]) }
}

$zip = Join-Path $root ($name + '.zip')
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal -Force
Remove-Item $stage -Recurse -Force
Write-Host ('package: ' + $zip)
Write-Host ('size   : ' + [math]::Round((Get-Item $zip).Length / 1MB, 2) + ' MB')
