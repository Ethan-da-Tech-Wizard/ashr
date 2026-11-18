// Dialog sheets for agent details, deny reasons and redirection instructions.
import { tileHtml, ownerName } from "./agents.js";

const $ = (id) => document.getElementById(id);

export function initDecideSheets({ onDecision, onToast }) {
  let pendingDeny = null;
  let pendingRedo = null;

  function askDeny(ask, fly, reset) {
    pendingDeny = { ask, fly, reset };
    $("deny-text").value = "";
    document.querySelectorAll("#deny-chips .chip").forEach((c) => c.classList.remove("on"));
    $("deny-sheet").showModal();
  }

  function askRedo(ask) {
    pendingRedo = ask;
    $("redo-text").value = "";
    document.querySelectorAll("#redo-chips .chip").forEach((c) => c.classList.remove("on"));
    $("redo-sheet").showModal();
  }

  document.querySelectorAll("#deny-chips .chip").forEach((chip) => {
    chip.onclick = () => { chip.classList.toggle("on"); };
  });

  $("deny-cancel").onclick = () => {
    $("deny-sheet").close();
    pendingDeny?.reset?.();
    pendingDeny = null;
  };

  $("deny-send").onclick = () => {
    if (!pendingDeny) return;
    const chips = [...document.querySelectorAll("#deny-chips .chip.on")].map((c) => c.textContent);
    const typed = $("deny-text").value.trim();
    const message = [...chips, typed].filter(Boolean).join(". ") || "Denied from phone";
    const { ask, fly, reset } = pendingDeny;
    pendingDeny = null;
    $("deny-sheet").close();
    onDecision(ask, "deny", message, fly, reset);
  };

  document.querySelectorAll("#redo-chips .chip").forEach((chip) => {
    chip.onclick = () => { chip.classList.toggle("on"); };
  });

  $("redo-cancel").onclick = () => {
    $("redo-sheet").close();
    pendingRedo = null;
  };

  $("redo-send").onclick = () => {
    if (!pendingRedo) return;
    const chips = [...document.querySelectorAll("#redo-chips .chip.on")].map((c) => c.textContent);
    const note = [...chips, $("redo-text").value.trim()].filter(Boolean).join(". ");
    if (!note) return onToast("say what to do instead");
    const ask = pendingRedo;
    pendingRedo = null;
    $("redo-sheet").close();
    onDecision(ask, "deny", `Do not do that. Do this instead: ${note}`, undefined, undefined, true);
  };

  return { askDeny, askRedo };
}

export function initAgentSheet({ onSay, onKill, onToast, wireFaces, stateWord = {} }) {
  let openSession = null;

  function openSheet(s) {
    openSession = s;
    $("sheet-agent").innerHTML = tileHtml(s);
    wireFaces?.($("sheet-agent"));
    $("sheet-title").textContent = s.title;
    const by = ownerName(s.owner);
    $("sheet-state").textContent = `${s.agent}${by ? ` · @${by}` : ""} · ${stateWord[s.state] || s.state}`;
    $("sheet-cwd").textContent = s.cwd;
    $("say-text").value = "";
    $("sheet").showModal();
  }

  $("say-send").onclick = async () => {
    const text = $("say-text").value.trim();
    if (!text || !openSession) return;
    try {
      await onSay(openSession.id, text);
      $("sheet").close();
      onToast("sent to the agent");
    } catch (err) { onToast(err.message); }
  };

  $("kill").onclick = async () => {
    if (!openSession) return;
    try {
      await onKill(openSession.id);
      $("sheet").close();
      onToast("agent stopped");
    } catch (err) { onToast(err.message); }
  };

  return { openSheet };
}
