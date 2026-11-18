#!/usr/bin/env bash
# Program: ashr - demo.sh
# Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
# Last Modified: 2026-11-18
# Purpose: Starts a stage demo with one command: the hub, a scripted fake herd of agents and (with --tunnel) a public Cloudflare address, then prints a one-time phone pairing link.
# One-command stage demo: hub + scripted fake herd (+ optional Cloudflare quick tunnel).
# Usage: scripts/demo.sh [--tunnel]     (env PORT default 7777). Ctrl-C stops everything.
# Stop on errors (-e), on unset variables (-u) and on failures inside pipes.
set -euo pipefail

# Work out where this script lives (HERE) and the repo root (ROOT), no matter where it is run from.
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# The hub port (default 7777); TUNNEL=1 later means "also start a public tunnel".
PORT="${PORT:-7777}"
TUNNEL=0

# If the secret-shield folder was not set, look for a sibling folder named git-secret-shield and use it.
if [ -z "${ASHR_SECRET_SHIELD:-}" ]; then
  for p in "$ROOT/../git-secret-shield"; do
    if [ -d "$p" ]; then
      export ASHR_SECRET_SHIELD="$p"
      break
    fi
  done
fi
# Read the command line: only --tunnel is allowed.
for arg in "$@"; do
  case "$arg" in
    --tunnel) TUNNEL=1 ;;
    *) echo "usage: $0 [--tunnel]" >&2; exit 1 ;;
  esac
done

# Make a random 16-byte token (32 hex characters) for this run and share it with child programs.
ASHR_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(16).toString('hex'))")"
export ASHR_TOKEN PORT
# PIDS lists the background programs started here so we can stop them; TMP is a scratch folder.
PIDS=()
TMP="$(mktemp -d)"

# Cleanup: stop every background process politely, then forcefully, remove the scratch folder and say so. Runs when the script ends.
cleanup() {
  trap - EXIT INT TERM
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
  sleep 0.3
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill -9 "$pid" 2>/dev/null || true; done
  rm -rf "$TMP"
  echo "demo stopped."
}
# Run cleanup on exit, and turn Ctrl-C and termination into a normal exit with the usual codes.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# If something already answers on the port, stop with a message instead of clashing with it.
if curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
  echo "port $PORT is already in use. Stop that hub first (or set PORT=...)." >&2
  exit 1
fi

# Tunnel mode: start cloudflared, then poll its log (up to 30 seconds) for the trycloudflare.com address.
if [ "$TUNNEL" -eq 1 ]; then
  command -v cloudflared >/dev/null || { echo "cloudflared not found (brew install cloudflared)" >&2; exit 1; }
  echo "Starting Cloudflare tunnel ..."
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
    echo "could not get a trycloudflare.com URL. cloudflared said:" >&2
    tail -n 10 "$TMP/tunnel.log" >&2
    exit 1
  fi
  export ASHR_PUBLIC_URL="$URL"
  echo "Tunnel: $URL"
fi

# Start the hub in the background and wait (up to 10 seconds) until it answers.
(cd "$ROOT" && ASHR_NO_START_CODE=1 exec node hub/server.mjs) &
HUB_PID=$!
PIDS+=("$HUB_PID")
for _ in $(seq 1 40); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break
  kill -0 "$HUB_PID" 2>/dev/null || { echo "hub failed to start" >&2; exit 1; }
  sleep 0.25
done

# A new tunnel name takes a moment to reach public DNS, so wait until it really answers before showing a link.
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

# Ask scripts/pair.mjs for a single-use pairing link and print it in a box.
PAIR_URL="$(cd "$ROOT" && node scripts/pair.mjs 2>/dev/null || true)"
echo "=============================================="
echo "  PHONE URL (single use, scan the QR above or open this):"
echo "  ${PAIR_URL:-(could not get a pair code; run: npm run pair)}"
echo "  Ctrl-C stops the demo."
echo "=============================================="
echo

# Run the fake agents in the foreground; if they crash, the hub and tunnel stay up. When the hub stops, so does the script.
node "$ROOT/scripts/fake-agents.mjs" --loop &
FAKE_PID=$!
PIDS+=("$FAKE_PID")
# A fake-agent crash must never take down the hub or tunnel.
wait "$FAKE_PID" || echo "fake agents stopped"
wait "$HUB_PID"
