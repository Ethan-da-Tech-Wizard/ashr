# ashr: rules for every coding agent

Claude Code, Codex and Gemini all read this file. `CLAUDE.md` points here.

## What this is

A phone app plus a laptop hub. The hub guards coding agents and buzzes the phone only for risky commands.
The spec is `docs/CONTRACT.md`. Change the contract first, then the code.

## Who owns what

- `app/` (phone UI): Zazu. Others ask before big changes.
- `hub/`, `guard/`, `hooks/`, `scripts/`: Ethan. Others ask before big changes.
- `docs/`: anyone.

## Rules

- Zero npm dependencies in `hub/` and `app/`. Node 24 built-ins only. This keeps setup to one command.
- Files stay under 300 lines. Split by job.
- Never run shell strings. Use `execFile` with an argument list.
- Validate all phone input in the hub. The phone is untrusted.
- Never commit tokens, `.env` files or real keys. The guard tests use fake keys only.

## Working together

Two people and several coding agents share this repo. Follow these steps so nobody overwrites anybody.

1. **Pick an issue and assign it to yourself.** An assigned issue is taken. Do not start work on someone else's.
2. **Start a branch:** `npm run task -- zazu/<thing>` or `npm run task -- ethan/<thing>`. It starts from the latest `main` in its own folder and prints the path. Add `--here` to stay in the current folder.
3. **One agent per folder.** Never run two agents in the same folder. Each task folder has its own branch.
4. **Stay in your folders** (see "Who owns what"). If you must edit the other owner's folder, keep that edit in its own small pull request and tell them first.
5. **Commit small and often.** One idea per commit.
6. **Before you push:** `npm run sync`. It pulls in the latest `main`, runs the tests and warns if another open branch edits the same files.
7. **Push and open a pull request:** `npm run ship`. It prints the link.
8. **Merge when the check is green.** The other person merges pull requests that touch their folders. Merged branches delete themselves.
9. **Never push to `main`.** A git hook blocks it. Never force-push a branch someone else has pulled.
10. **Do not build on an open pull request.** Wait for it to merge, then start from `main`.

If `npm run sync` reports a conflict, fix the marked files, run `npm test`, commit, and sync again. Keep both sides' work unless the owner of the file says otherwise.

## Commands

```bash
npm test            # guard + hub tests, must pass before every push
npm run task -- zazu/pitch   # new branch from the latest main, in its own folder
npm run sync        # pull in the latest main, run the tests, warn about overlap
npm run ship        # sync, push, print the pull request link
npm run hub         # start the hub on :7777 and print the pairing QR
npm run fake        # fake Codex + Gemini sessions for demos
python3 -m http.server 7780 -d app   # phone UI alone, demo data at /?demo=1
```
