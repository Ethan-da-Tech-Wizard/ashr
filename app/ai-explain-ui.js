// Client-side UI handler for AI Quick Explain (Gemini and Grok).
import { explainAsk } from "./api.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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

export function wireAiExplain(card, ask) {
  const box = card.querySelector(".ai-explain-box");
  const pills = card.querySelectorAll(".ai-pill");
  if (!box || !pills.length) return;

  pills.forEach((pill) => {
    pill.addEventListener("click", async (e) => {
      e.stopPropagation();
      const provider = pill.dataset.ai === "grok" ? "grok" : "gemini";
      const provName = provider === "grok" ? "Grok" : "Gemini";

      pills.forEach((p) => { p.disabled = true; });
      box.classList.remove("hidden");
      box.innerHTML = `<div class="ai-loading"><span class="ai-spinner"></span> Asking ${provName}...</div>`;

      try {
        const res = await explainAsk(ask.id, provider);
        const sim = res.simulated ? ' <span class="ai-sim-tag">(simulated)</span>' : '';
        box.innerHTML = `
          <div class="ai-badge ${esc(res.provider || provider)}">${provName} says${sim}</div>
          <p class="ai-text">${esc(res.explanation || "No explanation provided.")}</p>`;
      } catch (err) {
        box.innerHTML = `<div class="ai-error">Could not get explanation: ${esc(err.message || "request failed")}</div>`;
      } finally {
        pills.forEach((p) => { p.disabled = false; });
      }
    });
  });
}
