// File: app/sheets.js
// Purpose: Controllers for the modal sheets (<dialog>) in index.html: the deny-reason
// sheet, the "do this instead" redirect sheet, and the agent detail/talk sheet.
// Dialog sheets for agent details, deny reasons and redirection instructions.
//
// How it fits: app.js calls initDecideSheets() and initAgentSheet() once at startup. Both look up
//   fixed element ids from app/index.html (#deny-sheet, #deny-chips, #deny-text, #redo-sheet,
//   #sheet, #say-text, #kill ...), so renaming those ids breaks this file. The sheets are native
//   <dialog> elements opened with showModal(), which gives focus trapping and Escape to close.
// State kept here: which ask a sheet is about (pendingDeny / pendingRedo) and which session the
//   agent sheet shows (openSession); all three are cleared when their sheet closes via a button.
import { tileHtml, ownerName } from "./agents.js";

// Shorthand for getElementById.
const $ = (id) => document.getElementById(id);

// Wire the deny and redirect sheets. `onDecision` is app.js's sendDecision.
// Returns { askDeny, askRedo }, the functions that open each sheet for an ask.
/**
 * @param {object} options
 * @param {Function} options.onDecision - app.js sendDecision(ask, behavior, message, fly, reset, redirect).
 * @param {(text: string) => void} options.onToast - shows a short message.
 * @returns {{askDeny: Function, askRedo: Function}} openers used by card.decideWith in app.js.
 */
export function initDecideSheets({ onDecision, onToast }) {
  // State for the sheet currently open (the ask plus the swipe callbacks), or null.
  let pendingDeny = null;
  let pendingRedo = null;

  // Open the deny sheet. `reset` snaps a swiped card back if the user cancels.
  /**
   * @param {object} ask - ask to deny.
   * @param {Function} [fly] - swipe animation callback, forwarded to the decision.
   * @param {Function} [reset] - returns a swiped card to rest if the user cancels.
   * @returns {void}
   */
  function askDeny(ask, fly, reset) {
    pendingDeny = { ask, fly, reset };
    $("deny-text").value = "";
    document.querySelectorAll("#deny-chips .chip").forEach((c) => c.classList.remove("on"));
    $("deny-sheet").showModal();
  }

  // Open the redirect sheet for an ask.
  /**
   * @param {object} ask - ask to redirect (denied with an instruction).
   * @returns {void}
   */
  function askRedo(ask) {
    pendingRedo = ask;
    $("redo-text").value = "";
    document.querySelectorAll("#redo-chips .chip").forEach((c) => c.classList.remove("on"));
    $("redo-sheet").showModal();
  }

  // Quick-reply chips are toggle buttons; their text becomes part of the message sent to the agent.
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
/**
 * @param {object} options
 * @param {(id: string, text: string) => Promise} options.onSay - api.say.
 * @param {(id: string) => Promise} options.onKill - api.kill.
 * @param {(text: string) => void} options.onToast
 * @param {(root: Element) => void} [options.wireFaces] - hides broken owner photos.
 * @param {object} [options.stateWord] - state id -> display word map.
 * @returns {{openSheet: (session: object) => void}}
 */
export function initAgentSheet({ onSay, onKill, onToast, wireFaces, stateWord = {} }) {
  let openSession = null;

  /**
   * @param {object} s - session to show (title, cwd, agent, owner, state).
   * @returns {void}
   */
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

  // Type a message into the agent's tmux pane via the hub; errors (no tmux pane, offline) are
  // shown as a toast and the sheet stays open so the text is not lost.
  $("say-send").onclick = async () => {
    const text = $("say-text").value.trim();
    if (!text || !openSession) return;
    try {
      await onSay(openSession.id, text);
      $("sheet").close();
      onToast("sent to the agent");
    } catch (err) { onToast(err.message); }
  };

  // Stop the agent (hub sends Ctrl-C to its pane).
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
