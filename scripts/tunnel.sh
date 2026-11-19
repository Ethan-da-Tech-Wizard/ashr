#!/usr/bin/env bash
# Exposes the hub through a Cloudflare quick tunnel.
#
# How it fits: use when the phone is NOT on the same Wi-Fi as the laptop. cloudflared opens an outbound
# connection and gives a public https://*.trycloudflare.com URL that forwards to the local hub. The hub
# sees tunnel traffic as coming from 127.0.0.1 but with proxy headers, which is why server.mjs treats
# requests with x-forwarded-for / cf-connecting-ip as remote and refuses /hook/* for them.
# Semi-manual: you restart the hub with ASHR_PUBLIC_URL set so pairing QR codes use the tunnel URL;
# scripts/hub-tunnel.sh automates that. Needs `cloudflared` on PATH (brew install cloudflared).
# Privacy: the tunnel carries your hub traffic through Cloudflare's network; the pairing token and
# session token still protect /api/*.
set -euo pipefail
# Quick tunnel only: it does not start the hub. Use scripts/hub-tunnel.sh to do both.
# Default hub port; override with PORT=... to match the hub.
PORT="${PORT:-7777}"
command -v cloudflared >/dev/null || { echo "cloudflared not found (brew install cloudflared)" >&2; exit 1; }
echo "Starting tunnel to http://localhost:$PORT ..."
echo "When the trycloudflare.com URL appears below, restart the hub with it so the QR code points at the tunnel:"
echo "  ASHR_PUBLIC_URL=https://<your-name>.trycloudflare.com npm run hub"
echo
# exec: replace this shell so Ctrl-C goes straight to cloudflared and no wrapper is left running.
exec cloudflared tunnel --url "http://localhost:$PORT"
