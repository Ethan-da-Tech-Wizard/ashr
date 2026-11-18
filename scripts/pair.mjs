// Asks the running hub for a fresh one-time pair code. The hub prints the URL + QR; we print the URL too.
// Usage: npm run pair   (env PORT default 7777)
const PORT = process.env.PORT || 7777;
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/hook/pair-code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!res.ok) throw new Error(`hub said ${res.status}`);
  console.log((await res.json()).url);
} catch (e) {
  console.error(`pair: ${e.message}. Is the hub running on port ${PORT}?`);
  process.exit(1);
}
