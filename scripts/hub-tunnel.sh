#!/usr/bin/env bash
# Program: ashr - hub-tunnel.sh
# Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
# Last Modified: 2026-11-18
# Purpose: Starts the real ashr hub behind a Cloudflare quick tunnel so a phone on any network can reach it, and stops both when you press Ctrl-C.
# Start the real ashr hub exposed over a Cloudflare quick tunnel.
# Accessible from any phone on cellular, hotspot, or remote networks worldwide.
# Stop on errors, unset variables and pipe failures.
set -euo pipefail

# Find this script's folder and the repo root; PORT defaults to 7777.
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PORT="${PORT:-7777}"

# Make sure cloudflared is installed, otherwise explain how to install it.
command -v cloudflared >/dev/null || { echo "cloudflared not found (brew install cloudflared)" >&2; exit 1; }

# A scratch folder for the tunnel log and a list of child process ids.
TMP="$(mktemp -d)"
PIDS=()

# On exit, stop the child programs (politely, then forcefully) and delete the scratch folder.
cleanup() {
  trap - EXIT INT TERM
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
  sleep 0.2
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill -9 "$pid" 2>/dev/null || true; done
  rm -rf "$TMP"
}
# Hook cleanup to normal exit, Ctrl-C and termination.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Starting Cloudflare quick tunnel for port $PORT ..."
# Start the tunnel in the background, sending its output to a log file.
cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" >"$TMP/tunnel.log" 2>&1 &
TUNNEL_PID=$!
PIDS+=("$TUNNEL_PID")

# Look in the log for up to 30 seconds for the public trycloudflare.com address.
URL=""
for _ in $(seq 1 60); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TMP/tunnel.log" | head -1 || true)"
  [ -n "$URL" ] && break
  kill -0 "$TUNNEL_PID" 2>/dev/null || break
  sleep 0.5
done

# No address found: show the end of the log and quit.
if [ -z "$URL" ]; then
  echo "Could not obtain trycloudflare.com URL. Output was:" >&2
  tail -n 10 "$TMP/tunnel.log" >&2
  exit 1
fi

# Give the address to the hub so its QR code points to the tunnel, then start the hub.
export ASHR_PUBLIC_URL="$URL"
echo "Tunnel active at: $URL"
echo "Starting ashr hub..."
echo

(cd "$ROOT" && exec node hub/server.mjs)
