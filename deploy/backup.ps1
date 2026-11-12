# Daily backup of the Ganttraah database (Docker installation).
# Run from the folder that contains docker-compose.yml, e.g. as a Windows scheduled task.
param([string]$OutDir = ".\backups", [int]$KeepDays = 30)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format "yyyy-MM-dd_HHmm"
$file = Join-Path $OutDir "gantraah_$stamp.sql"
docker compose --env-file compose.env exec -T db pg_dump -U gantraah -d gantraah --clean --if-exists | Out-File -Encoding utf8 $file
if ($LASTEXITCODE -ne 0) { Write-Host "Backup FAILED"; exit 1 }
Get-ChildItem $OutDir -Filter "gantraah_*.sql" | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) } | Remove-Item
Write-Host "Backup written to $file"
