#!/usr/bin/env bash
# Start the real ashr hub exposed over a Cloudflare quick tunnel.
# Accessible from any phone on cellular, hotspot, or remote networks worldwide.
#
# How it fits: the one-command version of scripts/tunnel.sh: starts cloudflared, waits for it to print its
# public URL, exports that as ASHR_PUBLIC_URL, then runs the hub in the foreground so its pairing QR points
# at the tunnel. Ctrl-C stops both (see the cleanup trap). Needs cloudflared; qrencode is optional.
# Run: bash scripts/hub-tunnel.sh   (env PORT, default 7777). Logs go to a temp dir that is deleted on exit.
# -e stop on any error, -u error on unset variables, pipefail make a failure inside a pipe fail the line:
# strict mode so the script never half-starts.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PORT="${PORT:-7777}"

command -v cloudflared >/dev/null || { echo "cloudflared not found (brew install cloudflared)" >&2; exit 1; }

# Private scratch folder for cloudflared's log; removed by cleanup(). PIDS tracks background processes to stop.
TMP="$(mktemp -d)"
PIDS=()

# Same stop-then-kill cleanup pattern as demo.sh.
cleanup() {
  trap - EXIT INT TERM
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
  sleep 0.2
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill -9 "$pid" 2>/dev/null || true; done
  rm -rf "$TMP"
}
# Run cleanup on any exit. INT/TERM exit with the conventional 128+signal codes (130, 143), which then
# also fires the EXIT trap, so the tunnel is never left running.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Starting Cloudflare quick tunnel for port $PORT ..."
# --no-autoupdate: do not let cloudflared replace itself while the demo is running. Output is captured
# to a file because the URL is only announced in the log.
cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" >"$TMP/tunnel.log" 2>&1 &
TUNNEL_PID=$!
PIDS+=("$TUNNEL_PID")

# Poll the tunnel log up to 30 s for the public URL; give up early if cloudflared dies.
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

# The hub uses this to build pairing links that work from outside the local network.
export ASHR_PUBLIC_URL="$URL"
echo "Tunnel active at: $URL"
echo "Starting ashr hub..."
echo

# exec replaces the subshell, so signals reach the hub directly.
(cd "$ROOT" && exec node hub/server.mjs)
