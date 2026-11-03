#!/usr/bin/env bash
# Instala el companion de Spotify para Deska (macOS). Sin sudo, sin requisitos previos.
#   curl -fsSL https://raw.githubusercontent.com/hopsiedev/deska-spotify/main/installers/install.sh | DESKA_SPOTIFY_CODE='<código del panel>' bash
set -euo pipefail

RELAY="${DESKA_SPOTIFY_RELAY:-https://deska-spotify-relay.xhopsiedev.workers.dev}"
REPO="hopsiedev/deska-spotify"
REF="main"
NODE_MAJOR="22"
FILES=(companion.mjs adapters/macos.mjs package.json)
LABEL="dev.deska.spotify-companion"

die() { echo "Error: $*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "este instalador es solo para macOS (en Windows usa install.ps1)."

CODE="${DESKA_SPOTIFY_CODE:-}"
if [ -z "$CODE" ]; then
  read -r -p "Código de emparejamiento (lo muestra el panel de Spotify en Deska): " CODE < /dev/tty
fi
CODE="$(printf '%s' "$CODE" | tr -d '[:space:]')"
[[ "$CODE" =~ ^([a-z0-9]{16,32})\.([a-f0-9]{32,64})$ ]] || die "el código de emparejamiento no es válido. Cópialo de nuevo desde el panel."
ID="${BASH_REMATCH[1]}"
SECRET="${BASH_REMATCH[2]}"

DIR="${DESKA_SPOTIFY_HOME:-$HOME/Library/Application Support/deska-spotify}"
AGENTS="${DESKA_SPOTIFY_AGENTS:-$HOME/Library/LaunchAgents}"
PLIST="$AGENTS/$LABEL.plist"

echo "Instalando Spotify para Deska…"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
mkdir -p "$DIR/adapters" "$DIR/node" "$AGENTS"

# 1) Node portable (verificado con SHA-256 de nodejs.org)
if [ ! -x "$DIR/node/node" ]; then
  case "$(uname -m)" in arm64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
  BASE="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  SUMS="$(curl -fsSL "$BASE/SHASUMS256.txt")"
  FILE="$(printf '%s\n' "$SUMS" | awk '{print $2}' | grep -E "^node-v$NODE_MAJOR[0-9.]+-darwin-$ARCH\.tar\.gz$" | head -1)"
  [ -n "$FILE" ] || die "no se encontró Node para este Mac."
  HASH="$(printf '%s\n' "$SUMS" | awk -v f="$FILE" '$2 == f {print $1}')"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  echo "Descargando Node ($FILE)…"
  curl -fsSL -o "$TMP/$FILE" "$BASE/$FILE"
  echo "$HASH  $TMP/$FILE" | shasum -a 256 -c - >/dev/null || die "la descarga de Node está dañada (SHA-256 no coincide)."
  tar -xzf "$TMP/$FILE" -C "$TMP"
  cp "$TMP"/node-v*/bin/node "$DIR/node/node"
  chmod +x "$DIR/node/node"
fi

# 2) Companion
for f in "${FILES[@]}"; do
  if [ -n "${DESKA_SPOTIFY_SRC:-}" ]; then cp "$DESKA_SPOTIFY_SRC/$f" "$DIR/$f"
  else curl -fsSL -o "$DIR/$f" "https://raw.githubusercontent.com/$REPO/$REF/companion/$f"; fi
done
printf '{\n  "relay": "%s",\n  "id": "%s",\n  "secret": "%s"\n}\n' "$RELAY" "$ID" "$SECRET" > "$DIR/config.json"
chmod 600 "$DIR/config.json"

# 3) Arranque automático (LaunchAgent): se inicia al abrir sesión y se reinicia si falla
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$DIR/node/node</string>
    <string>$DIR/companion.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/companion.log</string>
  <key>StandardErrorPath</key><string>$DIR/companion.log</string>
</dict>
</plist>
PLIST
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo
echo "Listo. El panel de Spotify en Deska se conectará en unos segundos."
echo "La primera vez macOS pedirá permiso para que se controle Spotify: pulsa «Aceptar»."
echo "Para quitarlo: curl -fsSL https://raw.githubusercontent.com/$REPO/$REF/installers/uninstall.sh | bash"
