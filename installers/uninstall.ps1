# Quita el companion de Spotify para Deska (Windows).
$ErrorActionPreference = 'Continue'
$dir = if ($env:DESKA_SPOTIFY_HOME) { $env:DESKA_SPOTIFY_HOME } else { Join-Path $env:LOCALAPPDATA 'deska-spotify' }
$startup = if ($env:DESKA_SPOTIFY_STARTUP) { $env:DESKA_SPOTIFY_STARTUP } else { [Environment]::GetFolderPath('Startup') }

Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$dir*companion.mjs*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item (Join-Path $startup 'DeskaSpotify.lnk') -Force -ErrorAction SilentlyContinue
Start-Sleep 1
Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'Spotify para Deska se ha quitado de este equipo.'
