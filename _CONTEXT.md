# ashr (SunHacks 2026)

Hackathon project with Ethan. A phone app that guards coding agents: safe commands pass, risky ones buzz the phone.
Own git repo at github.com/zazmattaz-debug/ashr (private, Ethan has write access). Ignored by the workspace repo.

## Stack

Node 24 hub (no deps), plain-JS PWA, Claude Code HTTP hooks, tmux, git worktrees, Cloudflare quick tunnel.

## Structure

```
app/      phone PWA (Zazu)
hub/      HTTP server, SSE, state, tmux bridge (Ethan)
guard/    risk rules + secret scan
hooks/    Claude Code settings with HTTP hooks
scripts/  start-agents.sh, fake-agents.mjs, tunnel.sh
docs/     CONTRACT.md + plan images
test/     node --test
```

## Quick start

`npm test` · `npm run hub` · `bash scripts/start-agents.sh auth nav`

## Status

2026-11-14: 109 tests pass, Opus review fixes in, live Claude Code and tunnel checks pass. Pushed. Final name still open.
