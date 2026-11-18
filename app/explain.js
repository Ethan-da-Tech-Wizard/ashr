// Program: ashr - explain.js
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Turns an agent's request (usually a shell command) into one plain-English sentence plus short bullet points, using a table of simple rules.
// Turns an agent's request into plain English: one sentence, then up to three short points.
// Pure functions, no DOM, so node can test them. explain(ask, agentName) -> { headline, points }

// Matches file names that probably hold secrets (.env files, .pem or .key files, ssh keys, credentials).
const SECRET = /(^|\/)\.env(\.|$)|\.pem$|\.key$|id_rsa|credentials|secrets?\b/i;
// Cut a string to n characters and add an ellipsis if it was longer.
const short = (s, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// Split a command into words by whitespace.
const words = (cmd) => cmd.trim().split(/\s+/);
// The words after the command name, leaving out option flags that start with a dash.
const args = (w, from = 1) => w.slice(from).filter((x) => !x.startsWith("-"));
// Join items with commas and shorten the result; fall back to "some files" if empty.
const list = (items) => short(items.join(", ")) || "some files";

// Each rule: [test on the word list, sentence builder]. First match wins.
// Rules for shell commands. Each rule is a pair: a test on the word list and a function that builds the sentence.
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

// Explain one simple command: find the first rule whose test passes, or fall back to showing the command.
function bashPart(cmd) {
  // Make sure we have a string, then drop output redirections like "> file" before splitting into words.
  const c = String(cmd ?? "");
  const w = words(c.replace(/\s+\d?>+\s*\S+/g, ""));
  const rule = BASH.find(([test]) => test(w));
  return rule ? rule[1](w) : `Run "${short(c, 36)}" in the terminal.`;
}

// Explain a command that may chain several parts with &&, || or ;. Only the first three parts are described.
function bash(cmd) {
  const c = String(cmd ?? "");
  const parts = c.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
  if (parts.length < 2) return bashPart(c);
  const steps = parts.slice(0, 3).map(bashPart).map((s) => s.split(". ")[0].replace(/\.$/, ""));
  // Lower-case the first letter so the sentence reads "do this, then do that".
  const lower = (s) => (s ? s[0].toLowerCase() + s.slice(1) : "");
  return `${steps[0]}, then ${steps.slice(1).map(lower).join(", then ")}.`;
}

// Choose the headline sentence based on which tool the agent wants to use (Bash, Edit, Write, Read, Web...).
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

// One sentence per risk level, describing the worst case.
const WORST = {
  high: "This could leak secrets or lose work.",
  medium: "Not dangerous by itself, but worth a look.",
  low: "This is usually safe.",
};

/**
 * Explain an ask in plain English.
 * @param {object} ask the request from the hub.
 * @param {string} [agentName] agent name used in the "Allow and ... does it now" line.
 * @returns {{headline: string, points: string[]}} a sentence and up to three bullets.
 */
export function explain(ask, agentName = "The agent") {
  // Use a generic name when none was given.
  const agent = agentName || "The agent";
  // Missing or invalid request: return a safe generic message.
  if (!ask || typeof ask !== "object") {
    return {
      headline: "Action needs your decision.",
      points: [
        WORST.medium,
        `Allow and ${agent} does it now. Deny and it stops and waits.`,
      ],
    };
  }
  // Build the bullets: why it was flagged (if reasons exist), the worst case for this risk, and what Allow and Deny do.
  const points = [];
  if (Array.isArray(ask.reasons) && ask.reasons.length) points.push(`Flagged because: ${ask.reasons.join(", ")}.`);
  points.push(WORST[ask.risk] || WORST.medium);
  points.push(`Allow and ${agent} does it now. Deny and it stops and waits.`);
  return { headline: headline(ask), points };
}
