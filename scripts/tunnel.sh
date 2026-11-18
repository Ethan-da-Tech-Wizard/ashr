#!/usr/bin/env bash
# Program: ashr - tunnel.sh
# Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
# Last Modified: 2026-11-18
# Purpose: Opens a Cloudflare quick tunnel to the local hub port and tells you how to restart the hub with the public address.
# Exposes the hub through a Cloudflare quick tunnel.
# Stop on errors, unset variables and pipe failures.
set -euo pipefail
# Port of the hub (default 7777).
PORT="${PORT:-7777}"
# Check cloudflared is installed.
command -v cloudflared >/dev/null || { echo "cloudflared not found (brew install cloudflared)" >&2; exit 1; }
echo "Starting tunnel to http://localhost:$PORT ..."
echo "When the trycloudflare.com URL appears below, restart the hub with it so the QR code points at the tunnel:"
echo "  ASHR_PUBLIC_URL=https://<your-name>.trycloudflare.com npm run hub"
echo
# Replace this shell with cloudflared so Ctrl-C stops the tunnel.
exec cloudflared tunnel --url "http://localhost:$PORT"
