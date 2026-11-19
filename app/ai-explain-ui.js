// File: app/ai-explain-ui.js
// Purpose: The "Ask a model" row on an approval card and the code that fills it
// in with Gemini's or Grok's plain-English explanation of the pending action.
// Client-side UI handler for AI Quick Explain (Gemini and Grok).
//
// How it fits: card.js embeds aiExplainBarHtml() in each card; app.js calls wireAiExplain(card, ask)
// after building it. A click calls api.explainAsk -> hub /api/explain -> hub/ai-explain.mjs, which
// either asks the provider (if an API key is configured on the laptop) or returns an offline canned
// answer flagged `simulated`, shown to the user as '(simulated)'. The phone never holds a provider key.
import { explainAsk } from "./api.js";

// HTML-escape untrusted text (explanations come from a remote model) before it goes into innerHTML.
// Local escape helper; the model's answer is untrusted text.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Markup for the provider buttons plus the (initially hidden) box that shows the result.
// aria-live="polite" makes screen readers announce the explanation when it appears.
/**
 * @returns {string} HTML for the two provider buttons (data-ai='gemini'|'grok') and the result box.
 */
export function aiExplainBarHtml() {
  return `
    <div class="ai-bar">
      <span class="ai-label">Ask a model</span>
      <div class="ai-pills">
        <button type="button" class="ai-pill" data-ai="gemini" aria-label="Explain with Gemini">Gemini</button>
        <button type="button" class="ai-pill" data-ai="grok" aria-label="Explain with Grok">Grok</button>
      </div>
    </div>
    <div class="ai-explain-box hidden" role="region" aria-live="polite"></div>`;
}

// Attach click handlers to a card's provider buttons. Each click asks the hub to
// explain `ask` with that provider and renders the answer, or an error, in the box.
/**
 * @param {HTMLElement} card - card containing the bar from aiExplainBarHtml.
 * @param {object} ask - ask whose id is sent to the hub.
 * @returns {void}
 */
export function wireAiExplain(card, ask) {
  const box = card.querySelector(".ai-explain-box");
  const pills = card.querySelectorAll(".ai-pill");
  if (!box || !pills.length) return;

  pills.forEach((pill) => {
    pill.addEventListener("click", async (e) => {
      // Do not let the click start a swipe or other card gesture.
      e.stopPropagation();
      const provider = pill.dataset.ai === "grok" ? "grok" : "gemini";
      const provName = provider === "grok" ? "Grok" : "Gemini";

      // Disable both buttons while a request is in flight to prevent duplicate calls.
      pills.forEach((p) => { p.disabled = true; });
      box.classList.remove("hidden");
      box.innerHTML = `<div class="ai-loading"><span class="ai-spinner"></span> Asking ${provName}...</div>`;

      try {
        const res = await explainAsk(ask.id, provider);
        // The hub marks answers produced offline (no API key) so the user is not misled about their source.
        const sim = res.simulated ? ' <span class="ai-sim-tag">(simulated)</span>' : '';
        box.innerHTML = `
          <div class="ai-badge ${esc(res.provider || provider)}">${provName} says${sim}</div>
          <p class="ai-text">${esc(res.explanation || "No explanation provided.")}</p>`;
      } catch (err) {
        box.innerHTML = `<div class="ai-error">Could not get explanation: ${esc(err.message || "request failed")}</div>`;
      // Always re-enable the buttons, success or failure.
      } finally {
        pills.forEach((p) => { p.disabled = false; });
      }
    });
  });
}
