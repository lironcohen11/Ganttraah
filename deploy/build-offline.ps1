# Builds the offline installation packages for the closed network.
# Run on a machine WITH internet access, from anywhere:
#   powershell -ExecutionPolicy Bypass -File deploy\build-offline.ps1
#
# Output (deploy\out):
#   gantraah-<version>-node.zip    - runs with Node.js only (no Docker needed)
#   gantraah-<version>-images.tar  - Docker images (app + PostgreSQL), only if Docker is running
param([string]$Version = (Get-Date -Format "yyyy.MM.dd-HHmm"))

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $PSScriptRoot "out"
$stage = Join-Path $out "gantraah-$Version"

Write-Host "== Gantraah offline package $Version"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Write-Host "-- building client"
Push-Location (Join-Path $root "client")
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "client npm ci failed" }
npm run build
if ($LASTEXITCODE -ne 0) { throw "client build failed" }
Write-Host "-- building the single-file demo (Gantraah-demo.html)"
npm run build:demo
if ($LASTEXITCODE -ne 0) { throw "demo build failed" }
New-Item -ItemType Directory -Force -Path $out | Out-Null
Copy-Item "dist-demo\index.html" (Join-Path $out "Gantraah-demo.html") -Force
Pop-Location

Write-Host "-- staging server with production dependencies"
$srv = Join-Path $stage "server"
New-Item -ItemType Directory -Force -Path $srv | Out-Null
Copy-Item (Join-Path $root "server\package.json"), (Join-Path $root "server\package-lock.json") $srv
Copy-Item -Recurse (Join-Path $root "server\src") (Join-Path $srv "src")
Push-Location $srv
npm ci --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "server npm ci failed" }
Pop-Location

New-Item -ItemType Directory -Force -Path (Join-Path $stage "client") | Out-Null
Copy-Item -Recurse (Join-Path $root "client\dist") (Join-Path $stage "client\dist")
Copy-Item (Join-Path $root ".env.example") $stage
Copy-Item (Join-Path $root "README.md") $stage
Copy-Item -Recurse (Join-Path $root "docs") (Join-Path $stage "docs")
Copy-Item (Join-Path $PSScriptRoot "start-gantraah.cmd") $stage
$dep = Join-Path $stage "docker"
New-Item -ItemType Directory -Force -Path $dep | Out-Null
Copy-Item (Join-Path $PSScriptRoot "docker-compose.yml"), (Join-Path $PSScriptRoot "compose.env.example"), (Join-Path $PSScriptRoot "backup.ps1") $dep
Set-Content -Path (Join-Path $stage "VERSION.txt") -Value $Version -Encoding utf8

$zip = Join-Path $out "gantraah-$Version-node.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip
Write-Host "-- created $zip"

$dockerOk = $false
try {
  $ErrorActionPreference = "Continue"
  docker info 2>$null | Out-Null
  $dockerOk = ($LASTEXITCODE -eq 0)
} catch { $dockerOk = $false } finally { $ErrorActionPreference = "Stop" }
if ($dockerOk) {
  Write-Host "-- building Docker images"
  docker build -t "gantraah:$Version" -t "gantraah:latest" $root
  if ($LASTEXITCODE -ne 0) { throw "docker build failed" }
  docker pull postgres:17-alpine
  $tar = Join-Path $out "gantraah-$Version-images.tar"
  docker save -o $tar "gantraah:$Version" "gantraah:latest" postgres:17-alpine
  Write-Host "-- created $tar"
} else {
  Write-Host "-- Docker is not running: skipped the Docker images (the Node package is enough to install)."
}
Write-Host "== done"
