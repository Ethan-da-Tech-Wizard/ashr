#!/usr/bin/env bash
# Exposes the hub through a Cloudflare quick tunnel.
set -euo pipefail
PORT="${PORT:-7777}"
command -v cloudflared >/dev/null || { echo "cloudflared not found (brew install cloudflared)" >&2; exit 1; }
echo "Starting tunnel to http://localhost:$PORT ..."
echo "When the trycloudflare.com URL appears below, restart the hub with it so the QR code points at the tunnel:"
echo "  ASHR_PUBLIC_URL=https://<your-name>.trycloudflare.com npm run hub"
echo
exec cloudflared tunnel --url "http://localhost:$PORT"
