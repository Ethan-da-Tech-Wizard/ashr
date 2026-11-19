#!/usr/bin/env bash
# One-command stage demo: hub + scripted fake herd (+ optional Cloudflare quick tunnel).
# Usage: scripts/demo.sh [--tunnel]     (env PORT default 7777). Ctrl-C stops everything.
# Strict mode: exit on error (-e), on unset variables (-u), and on failures inside pipelines.
set -euo pipefail

# Resolve the script's own folder and the repo root so it works from any current directory.
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PORT="${PORT:-7777}"
TUNNEL=0

# Auto-detect the optional git-secret-shield checkout next to this repo (if not set) so the external secret scan is enabled.
if [ -z "${ASHR_SECRET_SHIELD:-}" ]; then
  for p in "$ROOT/../git-secret-shield"; do
    if [ -d "$p" ]; then
      export ASHR_SECRET_SHIELD="$p"
      break
    fi
  done
fi
for arg in "$@"; do
  case "$arg" in
    --tunnel) TUNNEL=1 ;;
    *) echo "usage: $0 [--tunnel]" >&2; exit 1 ;;
  esac
done

# Random per-run token: the fake agents use it to read hub state, and nothing else knows it.
ASHR_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(16).toString('hex'))")"
export ASHR_TOKEN PORT
# Background processes we started, so cleanup stops exactly those.
PIDS=()
TMP="$(mktemp -d)"

# Stop children politely (SIGTERM), wait briefly, force-kill leftovers, delete temp files.
cleanup() {
  trap - EXIT INT TERM
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
  sleep 0.3
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill -9 "$pid" 2>/dev/null || true; done
  rm -rf "$TMP"
  echo "demo stopped."
}
# Cleanup runs on any exit; INT/TERM are turned into exits with the conventional 130/143 codes so EXIT fires.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Refuse to start if something already answers on the port.
if curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
  echo "port $PORT is already in use. Stop that hub first (or set PORT=...)." >&2
  exit 1
fi

# Optional public URL through a Cloudflare quick tunnel so a phone off the Wi-Fi can reach the hub.
if [ "$TUNNEL" -eq 1 ]; then
  command -v cloudflared >/dev/null || { echo "cloudflared not found (brew install cloudflared)" >&2; exit 1; }
  echo "Starting Cloudflare tunnel ..."
  cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" >"$TMP/tunnel.log" 2>&1 &
  TUNNEL_PID=$!
  PIDS+=("$TUNNEL_PID")
  URL=""
  # Poll up to 30 s for cloudflared to print its trycloudflare.com address.
  for _ in $(seq 1 60); do
    URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TMP/tunnel.log" | head -1 || true)"
    [ -n "$URL" ] && break
    kill -0 "$TUNNEL_PID" 2>/dev/null || break
    sleep 0.5
  done
  if [ -z "$URL" ]; then
    echo "could not get a trycloudflare.com URL. cloudflared said:" >&2
    tail -n 10 "$TMP/tunnel.log" >&2
    exit 1
  fi
  export ASHR_PUBLIC_URL="$URL"
  echo "Tunnel: $URL"
fi

# ASHR_NO_START_CODE stops the hub printing its own pairing QR; this script prints one later, once the tunnel works.
(cd "$ROOT" && ASHR_NO_START_CODE=1 exec node hub/server.mjs) &
HUB_PID=$!
PIDS+=("$HUB_PID")
for _ in $(seq 1 40); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break
  kill -0 "$HUB_PID" 2>/dev/null || { echo "hub failed to start" >&2; exit 1; }
  sleep 0.25
done

# A fresh tunnel hostname takes a few seconds to propagate; query a public resolver directly and require HTTP 200 so nobody scans a dead link.
if [ -n "${ASHR_PUBLIC_URL:-}" ]; then
  # A new tunnel name takes a few seconds to reach public DNS. Wait so nobody scans a dead link.
  HOST="${ASHR_PUBLIC_URL#https://}"
  echo "Waiting for the tunnel to answer ..."
  for _ in $(seq 1 60); do
    IP="$(dig +short @1.1.1.1 "$HOST" 2>/dev/null | head -1)"
    if [ -n "$IP" ] && [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$HOST:443:$IP" "$ASHR_PUBLIC_URL/")" = "200" ]; then
      echo "Tunnel is up."
      break
    fi
    sleep 1
  done
fi

PAIR_URL="$(cd "$ROOT" && node scripts/pair.mjs 2>/dev/null || true)"
echo "=============================================="
echo "  PHONE URL (single use, scan the QR above or open this):"
echo "  ${PAIR_URL:-(could not get a pair code; run: npm run pair)}"
echo "  Ctrl-C stops the demo."
echo "=============================================="
echo

node "$ROOT/scripts/fake-agents.mjs" --loop &
FAKE_PID=$!
PIDS+=("$FAKE_PID")
# A fake-agent crash must never take down the hub or tunnel.
wait "$FAKE_PID" || echo "fake agents stopped"
wait "$HUB_PID"
