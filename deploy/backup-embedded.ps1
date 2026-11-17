# Backup of the Ganttraah embedded database (installation WITHOUT Docker and WITHOUT PostgreSQL).
# The embedded database is a folder (data\pglite) that only one process may open, so the backup
# stops the service for a few seconds, copies the folder into a dated zip, and starts it again.
#
# Usage (as administrator), e.g. as a daily scheduled task at night:
#   powershell -ExecutionPolicy Bypass -File D:\Ganttraah\backup-embedded.ps1 -AppDir D:\Ganttraah -OutDir E:\Backups\Ganttraah
#
# Restore: stop the service, rename data\pglite, unzip the backup into data\, start the service.
param(
  [string]$AppDir = $PSScriptRoot,
  [string]$OutDir = (Join-Path $PSScriptRoot "backups"),
  [string]$TaskName = "Ganttraah",
  [int]$KeepDays = 30
)
$ErrorActionPreference = "Stop"
$data = Join-Path $AppDir "data\pglite"
if (-not (Test-Path $data)) { Write-Host "No database folder at $data"; exit 1 }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format "yyyy-MM-dd_HHmm"
$zip = Join-Path $OutDir "ganttraah_$stamp.zip"

# stop the service (scheduled task) and wait until the database folder is released
$hadTask = $false
try { schtasks /Query /TN $TaskName *> $null; $hadTask = ($LASTEXITCODE -eq 0) } catch { $hadTask = $false }
if ($hadTask) { schtasks /End /TN $TaskName | Out-Null }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*server\src\index.js*" -and $_.ExecutablePath } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 3

try {
  Compress-Archive -Path $data -DestinationPath $zip -Force
  Write-Host "Backup written to $zip"
} finally {
  if ($hadTask) { schtasks /Run /TN $TaskName | Out-Null; Write-Host "Service started again" }
}
Get-ChildItem $OutDir -Filter "ganttraah_*.zip" | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) } | Remove-Item
