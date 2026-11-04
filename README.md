# Spotify Control para Deska

Un panel de [Deska](https://deska.dev) que controla **tu app de escritorio de Spotify** (con tu sesión, sin OAuth ni API): portada, título y artista, play/pausa, anterior/siguiente, volumen y línea de tiempo con salto. Compatible con **Windows** e integrable en *Extras*.

```
Panel (Deska) ⇄ relé (Cloudflare Worker) ⇄ companion (tu PC) → app de Spotify
```

El panel de Deska corre en un entorno aislado que no puede comunicarse directamente con tu PC. Por eso, un programa ligero en tu equipo (el *companion*) se conecta de forma saliente a un relé seguro y traduce los comandos hacia Spotify mediante las APIs de control multimedia de Windows (SMTC). No se abre ningún puerto ni túnel en tu red.

## Aviso de privacidad e instalación
- **Inicio de sesión**: el instalador configura el companion para iniciar automáticamente con tu sesión de Windows (acceso directo oculto en Inicio).
- **Tráfico por el relé**: para reflejar la reproducción en Deska, el título, artista, duración, volumen y carátula pasan a través de tu relé en Cloudflare Workers.
- **Secreto protegido**: el secreto de emparejamiento nunca se expone en URLs de consulta. Viaja en cabeceras `Authorization` o mediante autenticación por mensaje WebSocket.
- **Revocación**: pulsar **Nuevo código** en el panel revoca de inmediato la pareja anterior en el relé, cerrando los sockets activos y borrando los datos asociados.

## Instalación

1. Instala el panel **Spotify Control** en Deska.
2. Ábrelo: verás el comando con tu código de emparejamiento único. Pulsa **Copiar comando**.
3. Pégalo en **PowerShell** en tu equipo:
   ```powershell
   $env:DESKA_SPOTIFY_CODE='…'; $f="$env:TEMP\deska-install.ps1"; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest 'https://raw.githubusercontent.com/hopsiedev/deska-spotify/v1.0.6/installers/install.ps1' -OutFile $f -UseBasicParsing; if ((Get-FileHash $f -Algorithm SHA256).Hash -ne '2DAF9CEE8C2203404A1FBF69ADD40169096AE5863FF817E39A8EEF8B0C167B0D') { Remove-Item $f -Force; throw 'SHA-256 no coincide' }; & $f; Remove-Item $f -Force
   ```
4. En pocos segundos el panel se sincroniza con tu Spotify.

> **Integridad verificada**: el comando valida la suma SHA-256 del instalador y el instalador valida individualmente la suma SHA-256 de Node portable y de cada archivo del companion (`companion.mjs`, `adapters/windows.mjs`, `spotify-worker.ps1`, `package.json`), fijados todos a la versión `v1.0.6`.

## Desinstalación

Para desinstalar el companion de tu equipo, detener el proceso y borrar todos sus archivos:
```powershell
irm https://raw.githubusercontent.com/hopsiedev/deska-spotify/v1.0.6/installers/uninstall.ps1 | iex
```
También puedes copiar este comando directamente desde el botón en el panel de Deska.

## Estructura

| Carpeta | Descripción |
|---|---|
| `panel/` | Paquete del panel de Deska v1.0.6 (HTML/CSS/JS, icon, manifest `panel.json`) |
| `relay/` | Worker de Cloudflare + Durable Object con WebSockets hibernables, autenticación por cabecera/mensaje y límite de tasa |
| `companion/` | Companion para Windows (`companion.mjs` + `adapters/windows.mjs` + `spotify-worker.ps1`) |
| `installers/` | `install.ps1` y `uninstall.ps1` con comprobación estricta de hash SHA-256 |
| `scripts/` | Herramientas de desarrollo (`set-relay.mjs`, servidor de pruebas) |

## Desarrollo y pruebas

```bash
cd relay && npm install && npx wrangler dev --port 8787     # relé local
# En otra terminal:
node companion/companion.mjs
cd relay && npm test                                          # pruebas de extremos
```

## Seguridad y límites
- Lista de comandos permitidos cerrada: únicamente `status`, `toggle`, `pause`, `resume`, `next`, `prev`, `volume (0-100)` y `seek`. Comandos como `play` o `search` con procesos externos han sido eliminados.
- Límite de tasa en el relé: limitador por IP y limitadores por Hub frente a inundación de comandos o sondeos repetidos.
- Ver [PRIVACY.md](PRIVACY.md).
