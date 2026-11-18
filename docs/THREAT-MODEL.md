# ashr threat model

Method: STRIDE (Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege).
Scope: the phone, the tunnel, the hub, the Claude Code hooks, and the agents.
Status: hackathon build. Written 2026-11-14. Read it as a list of known gaps, not a security claim.

## What we protect

- The laptop and the repos on it.
- The pairing token. Whoever holds it can approve commands and type into agent terminals.

## Trust boundaries

```
phone  --(HTTPS via tunnel, or HTTP on LAN)-->  hub :7777  <--(localhost HTTP)--  Claude hooks
                                                  |
                                                  +--(tmux send-keys)-->  agents (one worktree each)
```

- The phone is untrusted input. The hub validates every body.
- Hooks are trusted only from localhost, with no proxy headers.
- Agents are semi-trusted. The guard scores what they ask to do. It does not contain them.

## Threats

| Code | STRIDE | Threat | What we do | Still open |
|---|---|---|---|---|
| T1 | Spoofing | Someone else poses as the phone | 128-bit random token, constant-time compare, new token each hub start | Token sits in the pairing URL (`?t=`). It lands in browser history, tunnel logs and screenshots of the QR. SSE needs the query form. Token never expires while the hub runs. No per-device identity. |
| T2 | Spoofing | A remote caller poses as a hook | `/hook/*` accepts only 127.0.0.1 or ::1 and rejects `X-Forwarded-For` and `CF-Connecting-IP` | Any local process or any agent can call `/hook/*`, including `/hook/fake`. A local user is fully trusted. |
| T3 | Tampering | A tool call changes after approval | The hub holds the exact request open and answers that request only | Phone shows a summary. The full `detail` is one tap deeper, so a long command can hide its tail. |
| T4 | Tampering | Phone input drives the shell | `/api/say` and `/api/kill` use `execFile` with argument lists. Input is validated. | `/api/say` types text into an agent terminal by design. A stolen token is remote prompt injection into agents. This is the biggest risk (see E1). |
| T5 | Repudiation | Nobody can tell who approved what | Hub keeps a log of the last 50 decisions (allow, deny, auto, timeout) | Log is in memory, capped at 50, with no device identity. It is lost on restart. |
| T6 | Information disclosure | Secrets in a command or file leak | Guard marks secrets as high risk using built-in regexes, an entropy check and optionally git-secret-shield | Heuristics miss novel key formats. Approving a high-risk ask still sends the content to the phone and the tunnel. |
| T7 | Information disclosure | Traffic is read in transit | Tunnel gives HTTPS to the phone | The hub binds `0.0.0.0` and the LAN pairing URL is plain HTTP. The tunnel is a public URL: anyone who guesses or learns it reaches the login check. Quick-tunnel provider sees all traffic. |
| T8 | Denial of service | Hub or phone is flooded | Body capped at 1 MB. Unanswered asks auto-deny after 110 s. | No rate limit. No cap on open asks. A failed or silent phone means agents stall, then deny. |
| T9 | Denial of service | Laptop sleeps | None | The laptop must stay awake and online. Lid closed means no approvals and a dead tunnel. Use `caffeinate`, not yet scripted. |
| T10 | Elevation of privilege | Guard is bypassed | Rules cover `rm -rf`, force push, `curl \| sh`, writes outside cwd, `.env` and keys | Rules are heuristics on strings. Obfuscation, scripts that run later, and renamed binaries pass as low. A low-risk call is allowed with no human. |
| E1 | Elevation of privilege | Stolen token becomes a shell | Token check on `/api/*` | One token holds every power. No read-only tier, no second approval for `/api/say`. Rotate by restarting the hub. |
| E2 | Elevation of privilege | Agent harms the host | One git worktree per agent | Worktrees isolate files, not processes. Agents run as the user with network and the full home directory. |

## Known gaps, ranked

1. Token in URL, one token for everything (T1, E1).
2. Tunnel is public and the token is the only gate (T7).
3. Guard rules are heuristics, and low risk auto-allows (T10).
4. Laptop must stay awake (T9).
5. No process sandbox around agents (E2).

## Possible hardening (not built)

- Move the token from the URL to a one-time pairing code that swaps for a session cookie.
- Put Cloudflare Access in front of the tunnel.
- Add a token tier that can approve but cannot use `/api/say`.
- Persist the decision log to disk.

## Agent sandbox on Linux with cgroup-process-sandbox

Source: github.com/Ethan-da-Tech-Wizard/cgroup-process-sandbox, `scripts/ethan_capped_run.sh`. Read from its README and script on 2026-11-14. Not run by us.

What it does: `bash ethan_capped_run.sh <command...>` runs a command with a memory cap (`ETHAN_CAP`, default 3G), no swap and a CPU quota (`ETHAN_CPU`, default 400%) through `systemd-run`. By default it also uses `unshare` for user, PID and network namespaces.

It is Linux only. On macOS the script hands off to `ethan_mac_capped_run.py`, which is not in the repo. The demo laptop will not use this.

Do not use the default mode with ashr. It breaks three things:

- The new network namespace has its own loopback, so the agent cannot reach the hub on `localhost:7777`.
- It starts the command under `env -i` with a fresh temporary `HOME`. `TMUX_PANE` and the Claude login are gone, so the hooks cannot identify the pane.
- It also cuts the agent off from the model API.

Use host mode instead. Set `ETHAN_HOST=1`. This skips the namespaces and keeps the memory, swap and CPU caps when a systemd user bus exists. Without that bus the command runs with no caps at all, so check the cgroup took effect.

How `scripts/start-agents.sh` could wrap each agent. Change only the line that starts `claude`:

```bash
# today
tmux send-keys -t "$SESSION:$name" "claude --settings '$SETTINGS'" Enter
# Linux, with the sandbox checked out at $SANDBOX
tmux send-keys -t "$SESSION:$name" \
  "ETHAN_HOST=1 ETHAN_CAP=4G bash '$SANDBOX/scripts/ethan_capped_run.sh' claude --settings '$SETTINGS'" Enter
```

Guard the change with `[ "$(uname -s)" = Linux ] && [ -n "${ASHR_SANDBOX:-}" ]`, so Mac keeps the current line. Set `ASHR_SANDBOX` to the checkout path.

What this buys: one runaway agent cannot eat all memory or freeze the laptop, so it closes the memory part of E2 and the freeze part of T8. What it does not buy: file or network isolation. An agent still reads the home directory and the network. Getting that needs a mount namespace or a container with the hub exposed to it on a host-reachable address. That work is open.

## Regenerating this document with deterministic-doc-forge

Repo: github.com/Ethan-da-Tech-Wizard/deterministic-doc-forge. Its README says it generates STRIDE threat models, and I checked that with two commands.

- `python3 scripts/twu_docgen.py threat-model --path <ashr> --output out.md` ran. It returned a 6-row table about containers, Docker layers and root filesystems. ashr has no Dockerfile and no Python, so the table is generic and does not describe ashr. Do not use this path.
- `python3 -m docforge build -i ashr-arch.json -o docs/` compiles a STRIDE matrix from a JSON spec of components and mitigations. I read the CLI help and the README. I did not build a ashr spec. To use it, write `ashr-arch.json` from the table above, then run `python3 -m docforge validate -i ashr-arch.json` and the `build` command. Review the output by hand. The README itself says generated threat models need human review.

This file stays hand-written until that spec exists.
