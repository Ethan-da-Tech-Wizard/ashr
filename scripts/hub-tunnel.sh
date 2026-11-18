#!/usr/bin/env bash
# Start the real ashr hub exposed over a Cloudflare quick tunnel.
# Accessible from any phone on cellular, hotspot, or remote networks worldwide.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PORT="${PORT:-7777}"

command -v cloudflared >/dev/null || { echo "cloudflared not found (brew install cloudflared)" >&2; exit 1; }

TMP="$(mktemp -d)"
PIDS=()

cleanup() {
  trap - EXIT INT TERM
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
  sleep 0.2
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill -9 "$pid" 2>/dev/null || true; done
  rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Starting Cloudflare quick tunnel for port $PORT ..."
cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" >"$TMP/tunnel.log" 2>&1 &
TUNNEL_PID=$!
PIDS+=("$TUNNEL_PID")

URL=""
for _ in $(seq 1 60); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TMP/tunnel.log" | head -1 || true)"
  [ -n "$URL" ] && break
  kill -0 "$TUNNEL_PID" 2>/dev/null || break
  sleep 0.5
done

if [ -z "$URL" ]; then
  echo "Could not obtain trycloudflare.com URL. Output was:" >&2
  tail -n 10 "$TMP/tunnel.log" >&2
  exit 1
fi

export ASHR_PUBLIC_URL="$URL"
echo "Tunnel active at: $URL"
echo "Starting ashr hub..."
echo

(cd "$ROOT" && exec node hub/server.mjs)
