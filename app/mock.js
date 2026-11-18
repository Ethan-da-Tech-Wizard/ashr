// Demo data so the app works with no hub (screenshots, judges' phones, backup demo).
const now = () => Date.now();

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

export function createDemo() {
  let state = seed();
  const subs = new Set();
  const emit = () => subs.forEach((fn) => fn(structuredClone(state)));

  const setSession = (id, patch) => {
    state.sessions = state.sessions.map((s) => (s.id === id ? { ...s, ...patch, updatedAt: now() } : s));
  };

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

  return { post, subscribe, reset: () => { state = seed(); emit(); } };
}
