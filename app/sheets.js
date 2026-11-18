// Program: ashr - sheets.js
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Wires the pop-up sheets: the deny-reason sheet, the redirect-instructions sheet and the agent chat sheet with send and stop buttons.
// Dialog sheets for agent details, deny reasons and redirection instructions.
// tileHtml draws an agent tile; ownerName gives the GitHub handle.
import { tileHtml, ownerName } from "./agents.js";

// Shortcut for finding an element by its id.
const $ = (id) => document.getElementById(id);

/**
 * Set up the deny and redirect sheets.
 * @param {{onDecision: Function, onToast: Function}} handlers onDecision sends the decision, onToast shows a message.
 * @returns {{askDeny: Function, askRedo: Function}} functions that open each sheet.
 */
export function initDecideSheets({ onDecision, onToast }) {
  // Remember which request each open sheet is about.
  let pendingDeny = null;
  let pendingRedo = null;

  // Open the deny sheet for a request: clear the text and un-select all reason chips.
  function askDeny(ask, fly, reset) {
    pendingDeny = { ask, fly, reset };
    $("deny-text").value = "";
    document.querySelectorAll("#deny-chips .chip").forEach((c) => c.classList.remove("on"));
    $("deny-sheet").showModal();
  }

  // Open the redirect sheet for a request in the same way.
  function askRedo(ask) {
    pendingRedo = ask;
    $("redo-text").value = "";
    document.querySelectorAll("#redo-chips .chip").forEach((c) => c.classList.remove("on"));
    $("redo-sheet").showModal();
  }

  // Clicking a reason chip switches it on or off.
  document.querySelectorAll("#deny-chips .chip").forEach((chip) => {
    chip.onclick = () => { chip.classList.toggle("on"); };
  });

  // Cancel: close the sheet and put the card back where it was (reset).
  $("deny-cancel").onclick = () => {
    $("deny-sheet").close();
    pendingDeny?.reset?.();
    pendingDeny = null;
  };

  // Send: join the chosen chips and typed text into one message (default "Denied from phone"), then report the decision.
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

  // Same chip toggling for the redirect sheet.
  document.querySelectorAll("#redo-chips .chip").forEach((chip) => {
    chip.onclick = () => { chip.classList.toggle("on"); };
  });

  // Cancel the redirect and forget the request.
  $("redo-cancel").onclick = () => {
    $("redo-sheet").close();
    pendingRedo = null;
  };

  // Send: build a note from chips and text; if empty, ask the user to type something. Otherwise deny the step with a message telling the agent to do the note instead.
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

/**
 * Set up the agent chat sheet (opened by tapping an agent).
 * @param {object} options onSay and onKill call the hub, onToast shows messages, wireFaces fixes photos, stateWord maps state names to words.
 * @returns {{openSheet: Function}} openSheet(session) opens the sheet.
 */
export function initAgentSheet({ onSay, onKill, onToast, wireFaces, stateWord = {} }) {
  // The agent currently shown in the sheet.
  let openSession = null;

  // Fill the sheet with this agent's tile, title, owner, state and folder, then show it.
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

  // Send the typed message to the agent, close the sheet and confirm with a toast; show the error text if it fails.
  $("say-send").onclick = async () => {
    const text = $("say-text").value.trim();
    if (!text || !openSession) return;
    try {
      await onSay(openSession.id, text);
      $("sheet").close();
      onToast("sent to the agent");
    } catch (err) { onToast(err.message); }
  };

  // Stop the agent, close the sheet and confirm; show the error text if it fails.
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
