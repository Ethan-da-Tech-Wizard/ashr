// Asks the running hub for a fresh one-time pair code. The hub prints the URL + QR; we print the URL too.
// Usage: npm run pair   (env PORT default 7777)
//
// How it fits: package.json maps `npm run pair` here. The hub (hub/server.mjs) already issues one pairing
// code at start; pairing codes expire after 10 minutes and work once, so use this to get another one
// (a second phone, an expired code). It calls routes.hookPairCode, which also prints the QR on the hub's
// own terminal. Exit code 1 if the hub is not reachable. No dependencies; Node's built-in fetch.
const PORT = process.env.PORT || 7777;
// The endpoint is localhost-only on the hub, so this only works on the laptop running it.
// Empty JSON body is enough; the Content-Type header is REQUIRED because the hub rejects /hook/* POSTs
// that are not application/json (a CSRF defence).
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/hook/pair-code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!res.ok) throw new Error(`hub said ${res.status}`);
  console.log((await res.json()).url);
} catch (e) {
  console.error(`pair: ${e.message}. Is the hub running on port ${PORT}?`);
  process.exit(1);
}
