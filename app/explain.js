// Turns an agent's request into plain English: one sentence, then up to three short points.
// Pure functions, no DOM, so node can test them. explain(ask, agentName) -> { headline, points }

// Words that suggest a credentials file; only affects the wording shown, not the risk score (the hub's guard decides that).
const SECRET = /(^|\/)\.env(\.|$)|\.pem$|\.key$|id_rsa|credentials|secrets?\b/i;
const short = (s, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const words = (cmd) => cmd.trim().split(/\s+/);
// Positional arguments of a split command (flags removed).
const args = (w, from = 1) => w.slice(from).filter((x) => !x.startsWith("-"));
const list = (items) => short(items.join(", ")) || "some files";

// Order matters: more specific rules (reading a secrets file) precede general ones (reading any file).
// Each rule: [test on the word list, sentence builder]. First match wins.
const BASH = [
  [(w) => /^(cat|less|more|head|tail|bat)$/.test(w[0]) && args(w).some((f) => SECRET.test(f)),
    (w) => `Open your secrets file (${list(args(w))}). It holds passwords and keys.`],
  [(w) => /^(printenv|env)$/.test(w[0]), () => "Print every secret and setting on this laptop."],
  [(w) => /^(cat|less|more|head|tail|bat)$/.test(w[0]), (w) => `Read ${list(args(w))} and show what is inside.`],
  [(w) => w[0] === "rm", (w) => `Delete ${list(args(w))}. Deleted files do not come back.`],
  [(w) => /^(npm|pnpm|yarn|bun)$/.test(w[0]) && /^(install|i|add)$/.test(w[1] || ""),
    (w) => (args(w, 2).length ? `Download and install ${list(args(w, 2))} from the internet.` : "Download and install every package this project lists.")],
  [(w) => /^(pip|pip3|brew|gem|cargo|apt|apt-get)$/.test(w[0]) && w.includes("install"),
    (w) => `Download and install ${list(args(w).filter((x) => x !== "install"))} from the internet.`],
  [(w) => /^(npm|pnpm|yarn|bun)$/.test(w[0]) && (w[1] === "test" || w[2] === "test"), () => "Run the project's tests."],
  [(w) => /^(npm|pnpm|yarn|bun)$/.test(w[0]) && w[1] === "run", (w) => `Run the project's "${w[2] || "script"}" script.`],
  [(w) => w[0] === "git" && w[1] === "push",
    (w) => `Upload this code to GitHub${args(w, 2)[1] ? ` on the "${args(w, 2)[1]}" branch` : ""}. Your team will see it.`],
  [(w) => w[0] === "git" && w[1] === "reset" && w.includes("--hard"), () => "Throw away all changes that are not saved in git."],
  [(w) => w[0] === "git" && w[1] === "commit", () => "Save the current changes into git history."],
  [(w) => w[0] === "git" && /^(checkout|switch)$/.test(w[1] || ""), (w) => `Switch git to ${list(args(w, 2))}.`],
  [(w) => w[0] === "git" && /^(pull|fetch|clone)$/.test(w[1] || ""), () => "Download code from GitHub."],
  [(w) => w[0] === "git", (w) => `Run a git command (${w[1] || "git"}).`],
  [(w) => /^(curl|wget)$/.test(w[0]), (w) => `Talk to a website: ${short((args(w).find((x) => /\w\.\w/.test(x)) || "unknown address").replace(/^https?:\/\//, ""), 40)}.`],
  [(w) => w[0] === "sudo", () => "Run a command with full control of this laptop."],
  [(w) => /^(chmod|chown)$/.test(w[0]), (w) => `Change who can open ${list(args(w, 2))}.`],
  [(w) => w[0] === "mv", (w) => `Move or rename ${list(args(w))}.`],
  [(w) => w[0] === "cp", (w) => `Copy ${list(args(w))}.`],
  [(w) => /^(mkdir|touch)$/.test(w[0]), (w) => `Create ${list(args(w))}.`],
  [(w) => /^(kill|pkill|killall)$/.test(w[0]), () => "Stop a running program."],
  [(w) => /^(docker|kubectl)$/.test(w[0]), (w) => `Run a ${w[0]} command (${w[1] || ""}).`],
  [(w) => /^(node|python|python3|bash|sh|deno|ruby)$/.test(w[0]), (w) => `Run the script ${list(args(w).slice(0, 1))}.`],
  [(w) => /^(ls|pwd|find|grep|rg|wc|which|echo)$/.test(w[0]), () => "Look around the project. Nothing changes."],
];

// Describe one simple command. Output redirections are removed first so "echo x > f" is judged by its command word.
function bashPart(cmd) {
  const c = String(cmd ?? "");
  const w = words(c.replace(/\s+\d?>+\s*\S+/g, ""));
  const rule = BASH.find(([test]) => test(w));
  return rule ? rule[1](w) : `Run "${short(c, 36)}" in the terminal.`;
}

// Describe a chain (&&, ||, ;) as "A, then b, then c", using at most three steps and only the first sentence of each.
function bash(cmd) {
  const c = String(cmd ?? "");
  const parts = c.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
  if (parts.length < 2) return bashPart(c);
  const steps = parts.slice(0, 3).map(bashPart).map((s) => s.split(". ")[0].replace(/\.$/, ""));
  const lower = (s) => (s ? s[0].toLowerCase() + s.slice(1) : "");
  return `${steps[0]}, then ${steps.slice(1).map(lower).join(", then ")}.`;
}

// One-sentence summary by tool type; Bash is delegated to the command rules above.
function headline(ask) {
  const tool = ask?.tool || "";
  const target = String(ask?.summary || "").replace(/^\w+\s+/, "");
  if (tool === "Bash") return bash(String(ask?.summary || ""));
  if (/^(Edit|MultiEdit|NotebookEdit)$/.test(tool)) return `Change the file ${short(target)}.`;
  if (tool === "Write") return `Create or replace the file ${short(target)}.`;
  if (tool === "Read") return `Read the file ${short(target)}.`;
  if (/^Web/.test(tool)) return `Go online to look up ${short(target)}.`;
  return `Use the ${tool || "unknown"} tool.`;
}

// Generic risk sentence per level.
const WORST = {
  high: "This could leak secrets or lose work.",
  medium: "Not dangerous by itself, but worth a look.",
  low: "This is usually safe.",
};

// Return { headline, points } for an ask. Safe with null or malformed input.
export function explain(ask, agentName = "The agent") {
  const agent = agentName || "The agent";
  if (!ask || typeof ask !== "object") {
    return {
      headline: "Action needs your decision.",
      points: [
        WORST.medium,
        `Allow and ${agent} does it now. Deny and it stops and waits.`,
      ],
    };
  }
  const points = [];
  if (Array.isArray(ask.reasons) && ask.reasons.length) points.push(`Flagged because: ${ask.reasons.join(", ")}.`);
  points.push(WORST[ask.risk] || WORST.medium);
  points.push(`Allow and ${agent} does it now. Deny and it stops and waits.`);
  return { headline: headline(ask), points };
}
