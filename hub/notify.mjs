// Program: ashr - notify.mjs
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Sends a phone notification through an ntfy topic when a medium or high risk request arrives.
// Post phone alerts to an ntfy topic when medium or high risk asks arrive. See Issue #3.
// Zero dependencies (Node 24 fetch). Topic comes from ASHR_NTFY_TOPIC env var.
// Never includes pairing codes or sensitive session tokens.

// Post a notification for an ask. Returns true if the service accepted it, and false if there is no topic, the risk is low, fetch is missing or the call fails. The topic and fetch function can be passed in for tests.
export async function notifyAsk(ask, topic = process.env.ASHR_NTFY_TOPIC, fetchFn = globalThis.fetch) {
  if (!topic || !ask) return false;
  if (ask.risk !== 'high' && ask.risk !== 'medium') return false;
  if (typeof fetchFn !== 'function') return false;

  // Build the ntfy address, the title with the risk and tool, a body with the summary and reasons.
  const url = `https://ntfy.sh/${encodeURIComponent(topic)}`;
  const title = `ashr: ${ask.risk.toUpperCase()} risk (${ask.tool || 'Action'})`;
  const reasons = Array.isArray(ask.reasons) && ask.reasons.length ? `\n[${ask.reasons.join(', ')}]` : '';
  const body = `${ask.summary || 'Command needs approval'}${reasons}`;

  // Send it. High risk gets high priority and a warning tag.
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        Title: title,
        Priority: ask.risk === 'high' ? 'high' : 'default',
        Tags: ask.risk === 'high' ? 'warning' : 'bell',
      },
      body,
    });
    return res.ok;
  } catch {
    return false;
  }
}
