// File: app/sheets.js
// Purpose: Controllers for the modal sheets (<dialog>) in index.html: the deny-reason
// sheet, the "do this instead" redirect sheet, and the agent detail/talk sheet.
// Dialog sheets for agent details, deny reasons and redirection instructions.
import { tileHtml, ownerName } from "./agents.js";

const $ = (id) => document.getElementById(id);

// Wire the deny and redirect sheets. `onDecision` is app.js's sendDecision.
// Returns { askDeny, askRedo }, the functions that open each sheet for an ask.
export function initDecideSheets({ onDecision, onToast }) {
  // State for the sheet currently open (the ask plus the swipe callbacks), or null.
  let pendingDeny = null;
  let pendingRedo = null;

  // Open the deny sheet. `reset` snaps a swiped card back if the user cancels.
  function askDeny(ask, fly, reset) {
    pendingDeny = { ask, fly, reset };
    $("deny-text").value = "";
    document.querySelectorAll("#deny-chips .chip").forEach((c) => c.classList.remove("on"));
    $("deny-sheet").showModal();
  }

  // Open the redirect sheet for an ask.
  function askRedo(ask) {
    pendingRedo = ask;
    $("redo-text").value = "";
    document.querySelectorAll("#redo-chips .chip").forEach((c) => c.classList.remove("on"));
    $("redo-sheet").showModal();
  }

  document.querySelectorAll("#deny-chips .chip").forEach((chip) => {
    chip.onclick = () => { chip.classList.toggle("on"); };
  });

  // Cancel puts the swiped card back where it was.
  $("deny-cancel").onclick = () => {
    $("deny-sheet").close();
    pendingDeny?.reset?.();
    pendingDeny = null;
  };

  // Message = selected quick-reply chips plus typed text, joined with ". "; falls back to a generic message.
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

  // A redirect needs an instruction. It is sent as a deny whose message tells the agent to do something else (redirect = true plays the neutral effect).
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

// Wire the agent sheet: shows details, lets the user type to the agent (tmux) or stop it.
// Returns { openSheet(session) }.
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
