# Spotify Control para Deska

Un panel de [Deska](https://deska.dev) que controla **tu app de escritorio de Spotify** (con tu sesión, sin OAuth ni API): portada, título y artista, play/pausa, anterior/siguiente, volumen y línea de tiempo con salto. Incluye una fila en *Extras*. Funciona en **Windows** y **macOS**.

```
Panel (Deska) ⇄ relé (Cloudflare Worker) ⇄ companion (tu PC) → app de Spotify
```

El panel de Deska corre en un sandbox que no puede hablar con tu PC. Por eso un programa pequeño (el *companion*) se conecta **hacia fuera** a un relé con host fijo y traduce los comandos. No se abre ningún puerto ni túnel en tu equipo.

## Instalar (usuarios)
1. Instala el panel **Spotify Control** desde la Biblioteca de paneles de Deska (Comunidad).
2. Ábrelo: muestra un comando con tu código de emparejamiento. Pulsa **Copiar comando**.
3. Pégalo en una terminal:
   - **Windows** (PowerShell): `$env:DESKA_SPOTIFY_CODE='…'; irm https://raw.githubusercontent.com/hopsiedev/deska-spotify/main/installers/install.ps1 | iex`
   - **macOS** (Terminal): `curl -fsSL https://raw.githubusercontent.com/hopsiedev/deska-spotify/main/installers/install.sh | DESKA_SPOTIFY_CODE='…' bash`
4. En unos segundos el panel pasa de "Esperando a tu PC…" al reproductor. El companion arranca solo al iniciar sesión.

Requisitos: app de escritorio de Spotify abierta. En macOS, la primera vez el sistema pide permiso para controlar Spotify.

Desinstalar: `irm …/installers/uninstall.ps1 | iex` (Windows) o `curl -fsSL …/installers/uninstall.sh | bash` (macOS).

## Estructura
| Carpeta | Qué es |
|---|---|
| `panel/` | Paquete del panel de Deska (lo que se envía al marketplace) |
| `relay/` | Cloudflare Worker + Durable Object (WebSockets hibernables) |
| `companion/` | Programa del PC: `companion.mjs` + adaptadores `windows` (SMTC/PowerShell) y `macos` (AppleScript) |
| `installers/` | `install` / `uninstall` para Windows y macOS |
| `scripts/set-relay.mjs` | Fija el host del relé en todos los archivos |

## Desarrollo
```bash
cd relay && npm install && npx wrangler dev --port 8787     # relé local
# en otra terminal: companion apuntando al relé local
echo '{"relay":"http://127.0.0.1:8787","id":"testpair0123456789ab","secret":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' > companion/config.json
node companion/companion.mjs
cd relay && npm test                                          # pruebas de extremo a extremo
```
Desplegar el relé: `cd relay && npx wrangler deploy`, y luego `node scripts/set-relay.mjs <host>.workers.dev`.

## Seguridad
- Cada pareja es un `id` (20 caracteres) y un `secret` (128 bits) generados por el panel; el relé guarda solo el hash SHA-256 del secreto.
- El relé y el companion aceptan únicamente: `status`, `toggle`, `pause`, `resume`, `next`, `prev`, `volume 0-100`, `seek <segundos>`. Nada más se ejecuta.
- Quien tenga tu código puede controlar tu reproducción; trátalo como una contraseña. **Nuevo código** en el panel invalida el anterior.
- Los instaladores verifican el SHA-256 de Node; ejecutan código remoto (`irm | iex`, `curl | bash`), así que léelos antes: son cortos.

Ver [PRIVACY.md](PRIVACY.md).

## Estado
- Windows: probado (relé local, instalación, arranque oculto, comandos, portada, línea de tiempo, desinstalación).
- macOS: adaptador e instalador **sin probar en un Mac real**.
- Límite del plan gratuito de Workers: ~100 000 peticiones al día en total. Con WebSockets hibernables aguanta muchos usuarios; si el panel tiene que usar sondeo, cada panel abierto gasta ~28 000/día.
