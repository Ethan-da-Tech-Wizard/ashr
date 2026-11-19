// The request card: blurred art on top, a dark folder panel below with the plain-English
// sentence, the exact request, and a "What is this?" drawer with the details and AI answers.
//
// How it fits: app.js buildCard() sets card.innerHTML = cardHtml(...) and then calls wireCard(card);
//   swipe.js and ai-explain-ui.js attach behaviour to elements this markup creates (.wash, .stamp,
//   .ai-pill ...), and styles.css styles every class used here. The module is pure string building
//   (no DOM access), which is why test/card.test.mjs can run it under Node.
// Security: every dynamic value goes through esc() because summaries and titles come from agents.
import { explain } from "./explain.js";
import { ownerName } from "./agents.js";
import { aiExplainBarHtml } from "./ai-explain-ui.js";

// Local copy of the escape helper (also in app.js, agents.js and ai-explain-ui.js) so this module
// has no import cycle with them.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Return the inner HTML of an approval card. `waited` is the pre-formatted wait time.
// Tolerates missing ask/session so a malformed update never throws.
/**
 * @param {object|null} ask - {summary, detail, risk, reasons, tool, ...}.
 * @param {object|null} session - owning session {agent, title, owner}.
 * @param {string} waited - preformatted wait time such as '45s' (app.js ago()).
 * @returns {string} inner HTML for the card element; null inputs give a generic placeholder card.
 */
export function cardHtml(ask, session, waited) {
  const a = ask && typeof ask === "object" ? ask : null;
  const s = session && typeof session === "object" ? session : {};
  // 'See change' only appears when detail adds information beyond the one-line summary.
  const hasDiff = Boolean(a?.detail && a?.detail !== a?.summary);
  // Plain-English summary is generated locally (explain.js); nothing is sent anywhere.
  const { headline, points } = explain(a, s.agent);
  const by = ownerName(s.owner);
  const risk = a?.risk || "medium";
  const summary = a?.summary || "";
  // Structure, top to bottom: colour washes and ALLOW/DENY stamps (driven by swipe.js), the art
  // header with agent and owner, then the dark panel: risk tab, plain-English sentence, the exact
  // request in <code>, an expandable brief (points + AI buttons), and the footer with the wait
  // time and buttons. The `.waiting` span is updated every second by app.js.
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

// Opens and closes the "What is this?" drawer.
/**
 * @param {HTMLElement} card - element whose innerHTML came from cardHtml().
 * @returns {void} makes the 'What is this?' button toggle the `open` class (CSS shows the drawer)
 *   and keeps aria-expanded in sync for screen readers.
 */
export function wireCard(card) {
  const why = card.querySelector('[data-act="why"]');
  if (!why) return;
  why.onclick = () => {
    const open = card.classList.toggle("open");
    why.textContent = open ? "Hide" : "What is this?";
    why.setAttribute("aria-expanded", String(open));
  };
}
