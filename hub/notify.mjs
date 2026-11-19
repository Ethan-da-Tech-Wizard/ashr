// Post phone alerts to an ntfy topic when medium or high risk asks arrive. See Issue #3.
// Zero dependencies (Node 24 fetch). Topic comes from ASHR_NTFY_TOPIC env var.
// Never includes pairing codes or sensitive session tokens.

// Send a push notification for an ask that needs a human. Returns true only if
// ntfy accepted it; every failure path returns false rather than throwing.
export async function notifyAsk(ask, topic = process.env.ASHR_NTFY_TOPIC, fetchFn = globalThis.fetch) {
  if (!topic || !ask) return false;
  // Low-risk actions are auto-approved, so they never need to ping a phone.
  if (ask.risk !== 'high' && ask.risk !== 'medium') return false;
  if (typeof fetchFn !== 'function') return false;

  // The topic acts as a shared secret, so it is URL-encoded to keep it one path segment.
  const url = `https://ntfy.sh/${encodeURIComponent(topic)}`;
  const title = `ashr: ${ask.risk.toUpperCase()} risk (${ask.tool || 'Action'})`;
  const reasons = Array.isArray(ask.reasons) && ask.reasons.length ? `\n[${ask.reasons.join(', ')}]` : '';
  const body = `${ask.summary || 'Command needs approval'}${reasons}`;

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
