// Program: ashr - server.mjs
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: The ashr hub: a dependency-free HTTP and server-sent-events server that serves the phone app, protects the API with tokens, and lets only localhost call the agent hooks.
// ashr hub: zero-dependency HTTP + SSE server. See docs/CONTRACT.md.
// Node built-in modules, then the hub's own parts: state, owner lookup, auth, tmux control and the route handlers.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createState } from './state.mjs';
import { resolveOwner } from './owner.mjs';
import { createAuth } from './auth.mjs';
import * as tmux from './tmux.mjs';
import * as routes from './routes.mjs';

// Work out where the files are: this folder, the phone app folder, a 1 MB limit for request bodies, and the content types for static files.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '../app');
const MAX_BODY = 1_000_000;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain',
};

// Addresses that mean "this computer".
const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// A hook request counts as local only if it comes from this computer and carries no proxy headers, because a tunnel connects from localhost too.
// A tunnel (cloudflared) connects from localhost, so also reject proxied requests.
const isLocalHook = (req) =>
  LOCAL.has(req.socket.remoteAddress) && !req.headers['x-forwarded-for'] && !req.headers['cf-connecting-ip'];

// Send a JSON reply with the given status and no caching.
const send = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
};

// Read a request body as JSON (max 1 MB). Rejects on invalid JSON or a too-large body; an empty body or a non-object becomes {}.
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

// Check the session token from the Authorization header ("Bearer ...") or the ?t= query value (used by the event stream).
function tokenOk(auth, req, url) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  return auth.valid(m ? m[1] : url.searchParams.get('t') ?? '');
}

// Serve a file from the app folder. The path check blocks any attempt to leave the folder (403); unknown files give 404.
function serveStatic(res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, { error: 'bad request' });
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(APP_DIR, '.' + rel);
  if (file !== APP_DIR && !file.startsWith(APP_DIR + path.sep)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// Open the live event stream: send headers, the first state, remember the client, and send a ping every 15 seconds. Cleanup runs when the client leaves.
function openStream(ctx, req, res) {
  // no-transform stops Cloudflare from compressing (and so buffering) the stream.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store, no-transform',
    'Content-Encoding': 'identity', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`: ${' '.repeat(2048)}\n\n`); // padding so proxies flush the first chunk
  res.write(`event: state\ndata: ${JSON.stringify(ctx.state.snapshot())}\n\n`);
  ctx.state.clients.add(res);
  const cleanup = () => {
    clearInterval(ping);
    ctx.state.clients.delete(res);
  };
  const ping = setInterval(() => {
    if (res.writableEnded || res.destroyed) { cleanup(); return; }
    try { res.write(': ping\n\n'); } catch { cleanup(); }
  }, 15_000);
  res.on('error', cleanup);
  req.on('close', cleanup);
}

// Create and start a hub.
// owner: GitHub name shown on the phone for every agent on this hub.
// token: optional fixed session token (ASHR_TOKEN). announce(code, url): called when a pair code is issued.
// Options: port, fixed token, how long to hold a request waiting for the phone, host, a pair announce function, a base URL function and the owner name. Returns a promise with the server, state, port and a close function.
export function startHub({ port = 7777, token = '', holdMs = 110_000, host = '0.0.0.0', announce = () => {}, baseUrl = null, owner = 'unknown' } = {}) {
  // Build the shared context (state, tmux, auth) that every route handler receives.
  const auth = createAuth({ fixedToken: token });
  const ctx = { state: createState({ holdMs, owner }), tmux, auth, port, announce, baseUrl };
  // The table of POST routes: /hook/* for agents on this computer, /api/* for the phone.
  const POST = { '/hook/permission': routes.hookPermission, '/hook/event': routes.hookEvent, '/hook/fake': routes.hookFake,
    '/hook/pair-code': routes.hookPairCode,
    '/hook/agent-token': routes.hookAgentToken,
    '/hook/agent-token/revoke': routes.hookAgentTokenRevoke,
    '/api/pair': routes.apiPair,
    '/api/decide': routes.apiDecide, '/api/say': routes.apiSay, '/api/kill': routes.apiKill,
    '/api/explain': routes.apiExplain };

  // The request handler. Hook paths must be local and JSON; API paths need a token (except pairing); other GET requests serve the app files.
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://hub');
      const p = url.pathname;
      if (p.startsWith('/hook/')) {
        if (!isLocalHook(req)) return send(res, 403, { error: 'hooks are localhost only' });
        if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
          return send(res, 415, { error: 'content-type must be application/json' });
        }
      } else if (p.startsWith('/api/')) {
        if (p !== '/api/pair' && !tokenOk(auth, req, url)) return send(res, 401, { error: 'unauthorized' });
      } else if (req.method === 'GET') {
        return serveStatic(res, p);
      }
      // Two GET endpoints: a state snapshot and the live stream. Anything else must be a known POST route.
      if (req.method === 'GET' && p === '/api/state') return send(res, 200, ctx.state.snapshot());
      if (req.method === 'GET' && p === '/api/stream') return openStream(ctx, req, res);
      // Read the JSON body, run the handler and send its reply. Any crash becomes a plain 500 error.
      const handler = req.method === 'POST' && POST[p];
      if (!handler) return send(res, 404, { error: 'not found' });
      let body;
      try { body = await readJson(req); } catch (e) { return send(res, 400, { error: e.message }); }
      const out = await handler(ctx, req, body, res);
      send(res, out.status, out.json);
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      console.error('hub error:', e);
    }
  });

  // Listen and resolve with the running hub; close() ends the streams and the server.
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve({ server, ctx, token: token || undefined, port: server.address().port,
      close: () => { for (const r of ctx.state.clients) r.end(); server.closeAllConnections(); return new Promise((r) => server.close(r)); } }));
  });
}

// Find this computer's first non-internal IPv4 address so a phone on the same Wi-Fi can reach it.
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return '127.0.0.1';
}

// The address to put in the pairing link: ASHR_PUBLIC_URL if set, otherwise the LAN address and port.
const publicBase = (port) => (process.env.ASHR_PUBLIC_URL || `http://${lanIp()}:${port}`).replace(/\/$/, '');

// Print the pairing link and, if qrencode is installed, a QR code in the terminal.
function printPairUrl(url) {
  console.log(`\nPair your phone (one time, 10 min): ${url}\n`);
  try { console.log(execFileSync('qrencode', ['-t', 'ansiutf8', url], { encoding: 'utf8', timeout: 3000 })); }
  catch { console.log('(install qrencode for a terminal QR code)'); }
}

// When this file is run directly: start the hub on PORT, print the pairing link (unless a script prints its own) and the port.
if (import.meta.main) {
  const port = Number(process.env.PORT) || 7777;
  const hub = await startHub({ port, owner: resolveOwner(), token: process.env.ASHR_TOKEN || '',
    baseUrl: () => publicBase(port), announce: (code, url) => printPairUrl(url) });
  console.log(`\nashr hub on port ${hub.port}`);
  // demo.sh prints its own code once the tunnel answers; skip ours to avoid two QRs.
  if (!process.env.ASHR_NO_START_CODE) {
    const code = hub.ctx.auth.newCode();
    printPairUrl(`${publicBase(hub.port)}/?pair=${code}`);
  }
}
