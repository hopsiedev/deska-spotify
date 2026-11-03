#!/usr/bin/env bash
# Quita el companion de Spotify para Deska (macOS).
set -uo pipefail
LABEL="dev.deska.spotify-companion"
DIR="${DESKA_SPOTIFY_HOME:-$HOME/Library/Application Support/deska-spotify}"
PLIST="${DESKA_SPOTIFY_AGENTS:-$HOME/Library/LaunchAgents}/$LABEL.plist"

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null
rm -f "$PLIST"
rm -rf "$DIR"
echo "Spotify para Deska se ha quitado de este Mac."
