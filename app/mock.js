// File: app/mock.js
// Demo data so the app works with no hub (screenshots, judges' phones, backup demo).
//
// How it fits: api.js creates one demo with createDemo() ONLY when the URL contains ?demo=1, and
//   then routes every post() and subscribe() call here instead of the network. The shapes match the
//   hub's real snapshot ({sessions, asks, log}) and replies, so app.js cannot tell the difference.
// Scripted behaviour: five agents, two pending asks, a third ask appearing after 9 s, and a decision
//   moving its agent to `working` and then `done` after 6 s, so a presenter can swipe through a full
//   story with no laptop. Nothing is persisted and nothing leaves the browser.
// Indirection so timestamps stay in one place.
const now = () => Date.now();

// Fresh demo state: five agents (two waiting on approval), two pending asks and a short log.
// Times are relative to now so ages look realistic. Used only with ?demo=1.
function seed() {
  const t = now();
  return {
    sessions: [
      { id: "claude-auth", owner: "zazmattaz-debug", agent: "claude", title: "fix the login tests", cwd: "~/sunhacks/wt-auth", state: "needs_you", updatedAt: t - 40e3 },
      { id: "codex-nav", owner: "Ethan-da-Tech-Wizard", agent: "codex", title: "build the navbar", cwd: "~/sunhacks/wt-nav", state: "needs_you", updatedAt: t - 95e3 },
      { id: "gemini-docs", owner: "Ethan-da-Tech-Wizard", agent: "gemini", title: "write the API docs", cwd: "~/sunhacks/wt-docs", state: "working", updatedAt: t - 12e3 },
      { id: "grok-audit", owner: "Ethan-da-Tech-Wizard", agent: "grok", title: "audit auth & dependencies", cwd: "~/sunhacks/wt-audit", state: "working", updatedAt: t - 5e3 },
      { id: "claude-db", owner: "zazmattaz-debug", agent: "claude", title: "add the sessions table", cwd: "~/sunhacks/wt-db", state: "done", updatedAt: t - 300e3 },
    ],
    asks: [
      {
        id: "ask_1", sessionId: "claude-auth", tool: "Bash", summary: "rm -rf node_modules && npm install",
        detail: "rm -rf node_modules && npm install", risk: "high", reasons: ["deletes files", "network install"], createdAt: t - 40e3,
      },
      {
        id: "ask_2", sessionId: "codex-nav", tool: "Edit", summary: "Edit src/components/Nav.tsx",
        detail: "@@ -12,6 +12,9 @@\n   return (\n-    <nav className=\"nav\">\n+    <nav className=\"nav sticky\">\n+      <Logo />\n+      <Search />\n       <Links />",
        risk: "medium", reasons: ["edits a shared component"], createdAt: t - 95e3,
      },
    ],
    log: [
      { at: t - 90e3, sessionId: "grok-audit", summary: "audit dependencies", verdict: "auto" },
      { at: t - 130e3, sessionId: "gemini-docs", summary: "Read docs/api.md", verdict: "auto" },
      { at: t - 210e3, sessionId: "claude-db", summary: "npm test", verdict: "auto" },
      { at: t - 260e3, sessionId: "claude-db", summary: "cat .env", verdict: "deny" },
    ],
  };
}

// In-browser stand-in for the hub: same post() and subscribe() shape as api.js, no network.
/**
 * @returns {{post: (path: string, body: object) => Promise<object>, subscribe: (fn: Function) => Function,
 *   reset: () => void}} the fake hub. `post` mimics /api/decide, /api/say, /api/kill and /api/explain;
 *   `subscribe(fn)` calls fn with a snapshot now and after every change and returns an unsubscribe.
 */
export function createDemo() {
  let state = seed();
  const subs = new Set();
  // Send each subscriber its own deep copy so UI code cannot mutate the demo's state.
  const emit = () => subs.forEach((fn) => fn(structuredClone(state)));

  // Patch one session and refresh its updatedAt, like hub/state.mjs upsertSession.
  const setSession = (id, patch) => {
    state.sessions = state.sessions.map((s) => (s.id === id ? { ...s, ...patch, updatedAt: now() } : s));
  };

  // Imitate hub endpoints: decide removes the ask and later marks the agent done; say retitles; kill idles; explain returns a canned answer.
  const post = async (path, body) => {
    if (path === "/api/decide") {
      const ask = state.asks.find((a) => a.id === body.askId);
      if (!ask) return {};
      state.asks = state.asks.filter((a) => a.id !== ask.id);
      state.log = [{ at: now(), sessionId: ask.sessionId, summary: ask.summary, verdict: body.behavior }, ...state.log];
      setSession(ask.sessionId, { state: "working" });
      emit();
      setTimeout(() => { setSession(ask.sessionId, { state: "done" }); emit(); }, 6000);
    } else if (path === "/api/say") {
      setSession(body.sessionId, { state: "working", title: body.text.slice(0, 60) });
      emit();
    } else if (path === "/api/kill") {
      setSession(body.sessionId, { state: "idle" });
      emit();
    } else if (path === "/api/explain") {
      const ask = state.asks.find((a) => a.id === body?.askId) || { summary: "demo command", risk: "medium" };
      const provider = body?.provider === "grok" ? "grok" : "gemini";
      return {
        ok: true,
        provider,
        explanation: provider === "gemini"
          ? `Gemini analysis: Evaluated "${ask.summary}". High risk of state mutation. Verify before approving.`
          : `Grok breakdown: "${ask.summary}" will alter repository or system files. Review changes carefully.`,
        simulated: true,
      };
    }
    return {};
  };

  /**
   * @param {(state: object) => void} fn - receives structured clones of the state.
   * @returns {() => void} unsubscribe (also cancels the scripted third ask if it has not fired).
   */
  const subscribe = (fn) => {
    subs.add(fn);
    fn(structuredClone(state));
    // A new ask arrives a little later, so the demo feels alive.
    const timer = setTimeout(() => {
      state.asks = [...state.asks, {
        id: "ask_3", sessionId: "gemini-docs", tool: "Bash", summary: "git push origin main",
        detail: "git push origin main", risk: "medium", reasons: ["pushes to main"], createdAt: now(),
      }];
      setSession("gemini-docs", { state: "needs_you" });
      emit();
    }, 9000);
    return () => { subs.delete(fn); clearTimeout(timer); };
  };

  // `reset` restores the opening scene, handy between rehearsals.
  return { post, subscribe, reset: () => { state = seed(); emit(); } };
}
