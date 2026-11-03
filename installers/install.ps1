# Instala el companion de Spotify para Deska (Windows). Sin permisos de administrador, sin requisitos previos.
#   $env:DESKA_SPOTIFY_CODE='<código del panel>'; irm https://raw.githubusercontent.com/hopsiedev/deska-spotify/main/installers/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Relay = if ($env:DESKA_SPOTIFY_RELAY) { $env:DESKA_SPOTIFY_RELAY } else { 'https://deska-spotify-relay.xhopsiedev.workers.dev' }
$Repo = 'hopsiedev/deska-spotify'
$Ref = 'main'
$NodeMajor = '22'
$Files = @('companion.mjs', 'adapters/windows.mjs', 'spotify-worker.ps1', 'package.json')

$code = $env:DESKA_SPOTIFY_CODE
if (-not $code) { $code = Read-Host 'Código de emparejamiento (lo muestra el panel de Spotify en Deska)' }
$code = $code.Trim()
if ($code -notmatch '^([a-z0-9]{16,32})\.([a-f0-9]{32,64})$') { throw 'El código de emparejamiento no es válido. Cópialo de nuevo desde el panel.' }
$id = $Matches[1]; $secret = $Matches[2]

$dir = if ($env:DESKA_SPOTIFY_HOME) { $env:DESKA_SPOTIFY_HOME } else { Join-Path $env:LOCALAPPDATA 'deska-spotify' }
$startup = if ($env:DESKA_SPOTIFY_STARTUP) { $env:DESKA_SPOTIFY_STARTUP } else { [Environment]::GetFolderPath('Startup') }
$lnk = Join-Path $startup 'DeskaSpotify.lnk'
$utf8 = New-Object Text.UTF8Encoding($false)

function Stop-Companion {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$dir*companion.mjs*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
Write-Host 'Instalando Spotify para Deska…'
Stop-Companion
New-Item -ItemType Directory -Force -Path $dir, "$dir\adapters", "$dir\node" | Out-Null

# 1) Node portable (verificado con SHA-256 de nodejs.org)
$nodeExe = Join-Path $dir 'node\node.exe'
if (-not (Test-Path $nodeExe)) {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $base = "https://nodejs.org/dist/latest-v$NodeMajor.x"
  $sums = [string](Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content
  $line = ($sums -split "`n" | Where-Object { $_ -match "node-v$NodeMajor[\d.]+-win-$arch\.zip\s*$" } | Select-Object -First 1)
  if (-not $line) { throw 'No se encontró Node para este equipo.' }
  $hash, $file = ($line.Trim() -split '\s+')
  $zip = Join-Path $env:TEMP $file
  Write-Host "Descargando Node ($file)…"
  Invoke-WebRequest "$base/$file" -OutFile $zip -UseBasicParsing
  if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $hash.ToUpper()) { Remove-Item $zip -Force; throw 'La descarga de Node está dañada (SHA-256 no coincide).' }
  $tmp = Join-Path $env:TEMP ('deska-node-' + [guid]::NewGuid())
  Expand-Archive $zip -DestinationPath $tmp -Force
  Copy-Item (Get-ChildItem $tmp -Recurse -Filter node.exe | Select-Object -First 1).FullName $nodeExe -Force
  Remove-Item $tmp, $zip -Recurse -Force
}

# 2) Companion
foreach ($f in $Files) {
  $dest = Join-Path $dir $f
  if ($env:DESKA_SPOTIFY_SRC) { Copy-Item (Join-Path $env:DESKA_SPOTIFY_SRC $f) $dest -Force }
  else { Invoke-WebRequest "https://raw.githubusercontent.com/$Repo/$Ref/companion/$f" -OutFile $dest -UseBasicParsing }
}
[IO.File]::WriteAllText((Join-Path $dir 'config.json'), (@{ relay = $Relay; id = $id; secret = $secret } | ConvertTo-Json), $utf8)

# 3) Arranque automático al iniciar sesión (acceso directo en Inicio, sin ventana)
$vbs = Join-Path $dir 'run-hidden.vbs'
$q = '"'
[IO.File]::WriteAllText($vbs, @"
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$dir"
sh.Run "$q$q$nodeExe$q$q $q$q$dir\companion.mjs$q$q", 0, False
"@, $utf8)
New-Item -ItemType Directory -Force -Path $startup | Out-Null
$sc = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$sc.TargetPath = 'wscript.exe'
$sc.Arguments = "`"$vbs`""
$sc.WorkingDirectory = $dir
$sc.Save()

Start-Process wscript.exe -ArgumentList "`"$vbs`""
Write-Host ''
Write-Host 'Listo. El panel de Spotify en Deska se conectará en unos segundos.'
Write-Host "Se inicia solo con Windows. Para quitarlo: irm https://raw.githubusercontent.com/$Repo/$Ref/installers/uninstall.ps1 | iex"
