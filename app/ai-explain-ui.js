// Program: ashr - ai-explain-ui.js
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Browser UI for the "Ask a model" bar on a request card: renders the Gemini and Grok buttons and shows each model's explanation.
// Client-side UI handler for AI Quick Explain (Gemini and Grok).
// explainAsk sends the request to the hub, which asks the chosen AI model.
import { explainAsk } from "./api.js";

// Escape helper so text from a model can be shown as plain text and never as HTML.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * Build the HTML for the "Ask a model" bar (two buttons) and the empty box that will hold the answer.
 * @returns {string} an HTML string, inserted into a card by card.js.
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

/**
 * Make the Gemini and Grok buttons on one card work.
 * @param {HTMLElement} card the card element that contains the bar.
 * @param {{id: string}} ask the request the card shows; its id is sent to the hub.
 */
export function wireAiExplain(card, ask) {
  // Find the answer box and the two buttons inside this card.
  const box = card.querySelector(".ai-explain-box");
  const pills = card.querySelectorAll(".ai-pill");
  // If the bar is missing there is nothing to wire up.
  if (!box || !pills.length) return;

  // Give every button its own click handler.
  pills.forEach((pill) => {
    pill.addEventListener("click", async (e) => {
      // Stop the click from reaching the card, which would otherwise treat it as part of a swipe.
      e.stopPropagation();
      // Pick which model was clicked; anything that is not "grok" means Gemini.
      const provider = pill.dataset.ai === "grok" ? "grok" : "gemini";
      const provName = provider === "grok" ? "Grok" : "Gemini";

      // Disable both buttons while we wait so the user cannot send two requests at once.
      pills.forEach((p) => { p.disabled = true; });
      // Show the answer box with a small loading message.
      box.classList.remove("hidden");
      box.innerHTML = `<div class="ai-loading"><span class="ai-spinner"></span> Asking ${provName}...</div>`;

      // Ask the hub. On success show the answer, on failure show an error message.
      try {
        const res = await explainAsk(ask.id, provider);
        // If the hub says the answer was faked (no real API key), add a "(simulated)" tag.
        const sim = res.simulated ? ' <span class="ai-sim-tag">(simulated)</span>' : '';
        box.innerHTML = `
          <div class="ai-badge ${esc(res.provider || provider)}">${provName} says${sim}</div>
          <p class="ai-text">${esc(res.explanation || "No explanation provided.")}</p>`;
      // Something went wrong (network, 401 and so on): tell the user in the box.
      } catch (err) {
        box.innerHTML = `<div class="ai-error">Could not get explanation: ${esc(err.message || "request failed")}</div>`;
      // Whatever happened, let the user press the buttons again.
      } finally {
        pills.forEach((p) => { p.disabled = false; });
      }
    });
  });
}
