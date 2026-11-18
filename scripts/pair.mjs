// Program: ashr - pair.mjs
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Asks the running hub for a fresh one-time pairing code and prints the pairing link.
// Asks the running hub for a fresh one-time pair code. The hub prints the URL + QR; we print the URL too.
// Usage: npm run pair   (env PORT default 7777)
// The hub port (default 7777).
const PORT = process.env.PORT || 7777;
// Ask the hub's local pair-code endpoint, then print the link it returns. On failure print why and exit with 1.
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/hook/pair-code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!res.ok) throw new Error(`hub said ${res.status}`);
  console.log((await res.json()).url);
} catch (e) {
  console.error(`pair: ${e.message}. Is the hub running on port ${PORT}?`);
  process.exit(1);
}
