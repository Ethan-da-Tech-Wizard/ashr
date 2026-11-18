// Program: ashr - card.js
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Builds the HTML for one swipeable request card (plain-English headline, exact command, risk tag, drawer with details) and wires its "What is this?" drawer.
// The request card: blurred art on top, a dark folder panel below with the plain-English
// sentence, the exact request, and a "What is this?" drawer with the details and AI answers.
// explain turns a request into plain English; ownerName gives the GitHub handle; aiExplainBarHtml makes the model buttons.
import { explain } from "./explain.js";
import { ownerName } from "./agents.js";
import { aiExplainBarHtml } from "./ai-explain-ui.js";

// Escape helper so request text is shown as text, never run as HTML.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * Build the inner HTML of a request card.
 * @param {object} ask the request (tool, summary, detail, risk, reasons).
 * @param {object} session the agent session that made it.
 * @param {string} waited text such as "12s" for how long it has waited.
 * @returns {string} an HTML string.
 */
export function cardHtml(ask, session, waited) {
  // Use the inputs only if they are objects, so missing data cannot crash the page.
  const a = ask && typeof ask === "object" ? ask : null;
  const s = session && typeof session === "object" ? session : {};
  // There is a change to show only when the detail text exists and differs from the summary.
  const hasDiff = Boolean(a?.detail && a?.detail !== a?.summary);
  // Get the plain-English sentence and bullet points for this request.
  const { headline, points } = explain(a, s.agent);
  const by = ownerName(s.owner);
  // Default the risk to "medium" and the summary to an empty string when missing.
  const risk = a?.risk || "medium";
  const summary = a?.summary || "";
  return `
    <div class="wash allow"></div><div class="wash deny"></div>
    <div class="stamp allow">ALLOW</div><div class="stamp deny">DENY</div>
    <div class="art"><i></i></div>
    <div class="art-tag"><b>${esc(s.agent || "agent")}${by ? ` · @${esc(by)}` : ""}</b><span>${esc(s.title || "")}</span></div>
    <div class="panel">
      <div class="tab"><span class="risk ${esc(risk)}">${esc(risk)} risk</span>
        <svg class="tab-cap" viewBox="0 0 58 41" aria-hidden="true"><path d="M0 0c13 0 18 4 26 16s14 25 32 25H0z"/></svg></div>
      <div class="panel-body">
        <p class="plain${headline.length > 60 ? " long" : ""}">${esc(headline)}</p>
        <code class="raw">${esc(summary)}</code>
        <div class="brief">
          <ul class="points">${points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
          ${aiExplainBarHtml()}
        </div>
      </div>
      <div class="foot">
        <div class="wait"><span class="waiting">${esc(waited || "0s")}</span><span class="wait-word">waiting</span></div>
        <div class="foot-btns">
          ${hasDiff ? `<button type="button" class="pill ghost" data-act="diff">See change</button>` : ""}
          <button type="button" class="pill why" id="ai-explain-btn" data-act="why" aria-expanded="false">What is this?</button>
        </div>
      </div>
    </div>`;
}

// Wire up the drawer button on a card.
// Opens and closes the "What is this?" drawer.
// Toggle the card's "open" class, change the button label and keep aria-expanded in sync for screen readers.
export function wireCard(card) {
  const why = card.querySelector('[data-act="why"]');
  // If the card has no drawer button, there is nothing to do.
  if (!why) return;
  why.onclick = () => {
    const open = card.classList.toggle("open");
    why.textContent = open ? "Hide" : "What is this?";
    why.setAttribute("aria-expanded", String(open));
  };
}
