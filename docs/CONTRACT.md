# ashr hub contract

The hub is one Node process on the laptop. Zero npm dependencies. Port 7777.
The phone app and the agent hooks only talk to the hub. Nothing else is exposed.

## Auth (v2: one-time pairing)

- The hub prints `<base>/?pair=<code>` plus a QR. A pair code works once and expires after 10 minutes.
- The phone POSTs `/api/pair` `{ code }` and gets `{ token }` back (a random session token). The code is burned on first use.
- The phone stores the session token in localStorage. Every `/api/*` call sends `Authorization: Bearer <token>`. SSE uses `?t=<token>`.
- A photo of the projected QR is useless after the phone pairs.
- New code: `npm run pair` POSTs localhost-only `/hook/pair-code` and the hub prints a fresh URL + QR.
- `ASHR_TOKEN` env still works as a fixed session token for tests and scripts.
- `/hook/*` requires `Content-Type: application/json` (blocks no-preflight browser POSTs) and localhost with no proxy headers.
- At most 20 open asks. Beyond that, `/hook/permission` replies deny with message "ashr queue full".
- `/api/decide` on an unknown or expired ask returns 410 `{ error: "expired" }`.
- With no session token and no `?demo=1`, the app shows a full-screen "Not paired. Scan the QR on the laptop." screen. Demo data shows only with `?demo=1`.

## Auth (v1, replaced by v2 above)

- Hub makes a random `PAIR_TOKEN` at start and prints `http://<host>:7777/?t=<token>` plus a QR (qrencode).
- Phone stores the token in localStorage and sends `Authorization: Bearer <token>` (SSE: `?t=` query).
- Hook calls come from localhost only. The hub rejects `/hook/*` from any other address.

## Session

```json
{ "id": "claude-1a2b", "agent": "claude|codex|gemini|grok", "title": "fix auth tests",
  "cwd": "/repo/wt-auth", "state": "needs_you|working|done|failed|signed_out|idle",
  "updatedAt": 1731600000000, "tmux": "ashr:1", "owner": "zazmattaz-debug" }
```

`owner` is the GitHub name of the person whose laptop runs the agent. The hub sets it once at start:
`ASHR_OWNER`, else the signed-in `gh` user, else git's `github.user`, else the laptop user name.

## Ask (a blocked permission)

```json
{ "id": "ask_9f", "sessionId": "claude-1a2b", "tool": "Bash",
  "summary": "npm install left-pad", "detail": "<full command or file path + diff>",
  "risk": "low|medium|high", "reasons": ["network install"], "createdAt": 1731600000000 }
```

## How Claude Code calls the hub

Claude Code has native `"type": "http"` hooks. No hook script. It POSTs the event JSON and reads the reply body as hook output.
`hooks/claude-settings.json` registers PermissionRequest (timeout 120), Notification, Stop, SessionStart, UserPromptSubmit,
each with header `X-Ashr-Pane: $TMUX_PANE` (`allowedEnvVars: ["TMUX_PANE"]`) so the hub knows which tmux pane to type into.

Permission reply bodies:

```json
{ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "allow" } } }
{ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "deny", "message": "Denied from phone: <reason>" } } }
```

Notification `notification_type` values that matter: `permission_prompt`, `idle_prompt` (-> needs_you), `agent_completed` (-> done), `auth_storage_failure` (-> signed_out).

## Endpoints

| Method | Path | Who | What |
|---|---|---|---|
| POST | `/hook/permission` | hook | Body = hook stdin JSON. Guard scores it. Low risk: answer allow at once. Else hold the request open until the phone decides or 110 s pass (then deny). |
| POST | `/hook/event` | hook | Body = Notification / Stop / SessionStart / UserPromptSubmit JSON. Updates session state. Returns `{}`. |
| GET | `/api/state` | phone | `{ sessions: Session[], asks: Ask[], log: Entry[] }` |
| GET | `/api/stream` | phone | Server-Sent Events. Event `state` with the same body, sent on every change. |
| POST | `/api/decide` | phone | `{ askId, behavior: "allow"|"deny", message? }` |
| POST | `/api/say` | phone | `{ sessionId, text }`. Types the text into the session's tmux pane, then Enter. |
| POST | `/api/kill` | phone | `{ sessionId }`. Sends Ctrl-C to the pane. |
| GET | `/` | phone | Serves `app/` (PWA). |
| POST | `/hook/fake` | localhost | Demo only. `{ session: { id?, agent, title?, cwd?, state?, owner? }, ask?: { tool, summary, detail, risk, reasons } }`. Upserts a fake session; `ask` adds an open ask (no held request). Setting a non-`needs_you` state clears that session's fake asks. Used by `scripts/fake-agents.mjs`. |

## Guard (guard/rules.mjs)

- `score({ tool, input, cwd }) -> { risk, reasons, summary, detail }`
- High: `rm -rf`, `git push --force`, `curl | sh`, writes outside `cwd`, touches `.env` or keys, secrets found in the content.
- Medium: package installs, network calls, git push, writes to config files.
- Low: read-only tools, tests, edits inside `cwd`.
- Secret scan: if `ASHR_SECRET_SHIELD` points at a checkout of Ethan's git-secret-shield, the guard writes the content to a 0600 temp file and runs `python3 -m secretshield scan <file> --fail-on-findings` (exit 1 = secret). Otherwise it uses built-in regexes and an entropy check.

## Log entry

`state.log` is newest first, max 50 entries. One entry per guard decision:

```json
{ "at": 1731600000000, "sessionId": "claude-1a2b", "summary": "npm install left-pad", "verdict": "allow|deny|auto|timeout" }
```

`auto` = guard allowed a low-risk call without asking. `timeout` = no phone answer in 110 s, hub denied.

## Session state rules

A session is `needs_you` while it has an open ask. After a decision (or timeout) with no other open ask it goes back to `working`.
