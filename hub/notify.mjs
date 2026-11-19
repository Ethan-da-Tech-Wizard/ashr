// Post phone alerts to an ntfy topic when medium or high risk asks arrive. See Issue #3.
// Zero dependencies (Node 24 fetch). Topic comes from ASHR_NTFY_TOPIC env var.
// Never includes pairing codes or sensitive session tokens.
//
// How it fits: routes.hookPermission fires notifyAsk(ask) (without awaiting) whenever a request
//   is held for the phone, so the user is alerted even if the app is closed. It is optional:
//   with no ASHR_NTFY_TOPIC it does nothing.
// Privacy note: this is the one place hub data leaves the machine without the user opening the
//   app. It goes to the public ntfy.sh service; only the risk level, tool name, one-line
//   summary and guard reasons are sent, never command detail, file contents or tokens. Treat
//   the topic name like a password (anyone who knows it can read the alerts).
// Test: test/notify.test.mjs (injects a fake fetch; no network).

// Send a push notification for an ask that needs a human. Returns true only if
// ntfy accepted it; every failure path returns false rather than throwing.
/**
 * @param {object} ask - pending ask {risk, tool, summary, reasons}.
 * @param {string} [topic] - ntfy topic; defaults to env ASHR_NTFY_TOPIC.
 * @param {typeof fetch} [fetchFn] - injectable for tests.
 * @returns {Promise<boolean>} true if the ntfy server accepted the message.
 */
export async function notifyAsk(ask, topic = process.env.ASHR_NTFY_TOPIC, fetchFn = globalThis.fetch) {
  if (!topic || !ask) return false;
  // Low-risk actions are auto-approved, so they never need to ping a phone.
  if (ask.risk !== 'high' && ask.risk !== 'medium') return false;
  if (typeof fetchFn !== 'function') return false;

  // The topic acts as a shared secret, so it is URL-encoded to keep it one path segment.
  const url = `https://ntfy.sh/${encodeURIComponent(topic)}`;
  const title = `ashr: ${ask.risk.toUpperCase()} risk (${ask.tool || 'Action'})`;
  // Message text: the summary plus the guard's reasons in brackets, e.g. `npm i x\n[network install]`.
  const reasons = Array.isArray(ask.reasons) && ask.reasons.length ? `\n[${ask.reasons.join(', ')}]` : '';
  const body = `${ask.summary || 'Command needs approval'}${reasons}`;

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      // ntfy reads metadata from headers. High risk gets elevated priority and a warning icon
      // so it stands out from routine medium-risk asks.
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
