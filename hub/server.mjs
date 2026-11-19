// ==============================================================================
// Program: server.mjs
// Programmer: Ethan-da-Tech-Wizard
// Last Modified: November 18, 2026
// Purpose: HTTP hub server coordinating phone-in-the-loop agent supervision and API routes
//
// How it fits: this is the single process the whole product revolves around. Coding agents
//   (Claude Code via native HTTP hooks, Gemini via hooks/gemini-hook.mjs, Codex/Grok via
//   scripts/) POST permission requests to /hook/*; the paired phone (app/) talks to /api/*
//   and receives live updates over Server-Sent Events; any other GET returns the phone app's
//   static files from app/. This file owns only the HTTP plumbing (routing, auth gates, body
//   parsing, static files, SSE). Business logic lives in routes.mjs (endpoint handlers),
//   state.mjs (sessions/asks), auth.mjs (pairing and tokens), tmux.mjs (typing into panes)
//   and guard/ (risk scoring). The wire format is specified in docs/CONTRACT.md.
//
// Inputs: environment PORT (default 7777), ASHR_TOKEN (optional fixed admin token),
//   ASHR_PUBLIC_URL (tunnel URL used in pairing links), ASHR_NO_START_CODE (skip the first
//   pairing code), plus ASHR_OWNER via owner.mjs.
// Outputs: JSON responses, an SSE stream, and a printed pairing URL (+ QR if `qrencode` is
//   installed). State is in memory only; restarting the hub forgets everything.
//
// Security model (see docs/THREAT-MODEL.md): /hook/* is accepted only from loopback with no
//   proxy headers, because a Cloudflare tunnel also reaches the hub from 127.0.0.1;
//   /api/* needs a Bearer token minted by one-time pairing; POST hooks must be JSON so
//   browsers cannot send them cross-site without a CORS preflight.
//
// Known limits: binds to 0.0.0.0 by default so the phone can reach it on the LAN (pass
//   `host` to restrict); no TLS (use the tunnel); no rate limit except on pairing (auth.mjs).
//
// Run: `node hub/server.mjs` (or `npm start`). Test: `npm test` (test/hub*.test.mjs start
//   the hub on an ephemeral port through startHub()).
// ==============================================================================
// ashr hub: zero-dependency HTTP + SSE server. See docs/CONTRACT.md.
// Zero-dependency server: Node's http module only. Routes: /hook/* (localhost
// agents), /api/* (paired phone, token auth), everything else GET = static app.
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

// Directory of this file, and the phone app's static folder next to it (../app). ES modules
// have no __dirname, hence fileURLToPath.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '../app');
// Request bodies over 1 MB are rejected.
const MAX_BODY = 1_000_000; // bytes; the largest legitimate body is a long prompt in a hook event
// Content types for the static files in app/.
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain',
};

// Remote addresses that count as this machine (IPv4, IPv6 and IPv4-mapped IPv6 loopback).
const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// A tunnel (cloudflared) connects from localhost, so also reject proxied requests.
// True only for genuinely local callers. A tunnel's connections also arrive from loopback, so requests carrying proxy headers are treated as remote.
/**
 * @param {http.IncomingMessage} req
 * @returns {boolean} true only for a direct loopback connection with no proxy headers.
 *   x-forwarded-for / cf-connecting-ip are set by tunnels, so their presence means the
 *   caller is really remote even though the socket address is 127.0.0.1.
 */
const isLocalHook = (req) =>
  LOCAL.has(req.socket.remoteAddress) && !req.headers['x-forwarded-for'] && !req.headers['cf-connecting-ip'];

// Send a JSON response; no-store keeps proxies and browsers from caching state.
/**
 * @param {http.ServerResponse} res
 * @param {number} status - HTTP status code.
 * @param {object} obj - JSON-serialisable body.
 * @returns {void} ends the response. The body is serialised first so a failure to
 *   stringify throws before any header is written.
 */
const send = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
};

// Read and parse a JSON object body with a size cap. Empty body gives {}; arrays and primitives are coerced to {}.
/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<object>} the parsed JSON object ({} when empty or not an object).
 * @throws rejects with Error('body too large') over MAX_BODY (the socket is destroyed so
 *   the client stops sending) or Error('invalid json') on a parse error.
 */
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

// Accept a token as a Bearer header or as ?t= (needed because EventSource cannot set headers).
/**
 * @param {ReturnType<typeof createAuth>} auth - the hub's token store.
 * @param {http.IncomingMessage} req
 * @param {URL} url - parsed request URL (for the ?t= fallback).
 * @returns {boolean} whether the presented token is currently valid.
 */
function tokenOk(auth, req, url) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  return auth.valid(m ? m[1] : url.searchParams.get('t') ?? '');
}

// Serve files from app/. The resolved path must stay inside APP_DIR (blocks ../ traversal); directories map to index.html.
/**
 * @param {http.ServerResponse} res
 * @param {string} pathname - URL path, percent-encoded.
 * @returns {void} replies 400 (bad encoding), 403 (escapes APP_DIR), 404 or 200 + file.
 *   Files get no-cache (not no-store) so the phone app updates quickly after a code change
 *   yet can still use conditional requests.
 */
function serveStatic(res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, { error: 'bad request' });
  }
  if (rel.endsWith('/')) rel += 'index.html';
  // path.resolve collapses any ../ segments; the prefix check afterwards rejects anything
  // that landed outside the app folder (the extra `file !== APP_DIR` allows the folder itself).
  const file = path.resolve(APP_DIR, '.' + rel);
  if (file !== APP_DIR && !file.startsWith(APP_DIR + path.sep)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// Open the Server-Sent Events stream: send current state immediately, then register for updates and ping every 15 s so idle connections survive proxies.
/**
 * @param {object} ctx - hub context; uses ctx.state.snapshot() and ctx.state.clients.
 * @param {http.IncomingMessage} req - its 'close' event removes the client.
 * @param {http.ServerResponse} res - kept open and registered in ctx.state.clients so
 *   state.emit() can push further `state` events to it.
 * @returns {void}
 */
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
  // Idempotent teardown shared by the three exit paths (ping failure, response error, client
  // disconnect). `ping` is declared below but only used after it is assigned.
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

// owner: GitHub name shown on the phone for every agent on this hub.
// token: optional fixed session token (ASHR_TOKEN). announce(code, url): called when a pair code is issued.
/**
 * Starts the hub HTTP server.
 *
 * @param {object} [options]
 * @param {number} [options.port=7777] - TCP port; pass 0 in tests for an ephemeral port.
 * @param {string} [options.token=''] - fixed admin token (ASHR_TOKEN); empty means pairing only.
 * @param {number} [options.holdMs=110000] - how long a permission request waits for the phone.
 * @param {string} [options.host='0.0.0.0'] - bind address.
 * @param {(code: string, url: string) => void} [options.announce] - called when a pair code
 *   is issued through /hook/pair-code so the terminal can print it.
 * @param {(() => string)|null} [options.baseUrl] - supplies the public base URL for pairing links.
 * @param {string} [options.owner='unknown'] - GitHub name shown for every session.
 * @returns {Promise<{server: http.Server, ctx: object, token?: string, port: number, close: () => Promise<void>}>}
 *   resolves once listening; `close()` ends SSE clients, drops keep-alive sockets and stops.
 */
export function startHub({ port = 7777, token = '', holdMs = 110_000, host = '0.0.0.0', announce = () => {}, baseUrl = null, owner = 'unknown' } = {}) {
  const auth = createAuth({ fixedToken: token });
  const ctx = { state: createState({ holdMs, owner }), tmux, auth, port, announce, baseUrl };
  // Route table: POST path -> handler.
  // Every state-changing endpoint is a POST; anything not in this table 404s. Handlers live in
  // routes.mjs and share one signature: (ctx, req, body, res) -> { status, json }.
  const POST = { '/hook/permission': routes.hookPermission, '/hook/event': routes.hookEvent, '/hook/fake': routes.hookFake,
    '/hook/pair-code': routes.hookPairCode,
    '/hook/agent-token': routes.hookAgentToken,
    '/hook/agent-token/revoke': routes.hookAgentTokenRevoke,
    '/api/pair': routes.apiPair,
    '/api/decide': routes.apiDecide, '/api/say': routes.apiSay, '/api/kill': routes.apiKill,
    '/api/explain': routes.apiExplain };

  // Request pipeline: hooks must be local and JSON; /api needs a token (except pairing); other GETs are static files.
  const server = http.createServer(async (req, res) => {
    try {
      // The base is a dummy: it is only needed so new URL() accepts a path-only request target.
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
      // Authenticated GETs (the /api auth gate above already ran for these).
      if (req.method === 'GET' && p === '/api/state') return send(res, 200, ctx.state.snapshot());
      if (req.method === 'GET' && p === '/api/stream') return openStream(ctx, req, res);
      // Lookup only runs for POST, so a GET to a POST-only path is a 404, not a handler call.
      const handler = req.method === 'POST' && POST[p];
      if (!handler) return send(res, 404, { error: 'not found' });
      let body;
      try { body = await readJson(req); } catch (e) { return send(res, 400, { error: e.message }); }
      // `res` is passed because hookPermission holds the request open and listens for the agent
      // hanging up; every handler still returns { status, json } for the reply written below.
      const out = await handler(ctx, req, body, res);
      send(res, out.status, out.json);
    } catch (e) {
      // Last-resort handler: never leak internals to the client, but log them for the operator.
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      console.error('hub error:', e);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => resolve({ server, ctx, token: token || undefined, port: server.address().port,
      close: () => { for (const r of ctx.state.clients) r.end(); server.closeAllConnections(); return new Promise((r) => server.close(r)); } }));
  });
}

// First non-loopback IPv4 address, used to build a pairing URL the phone can reach.
/**
 * @returns {string} the first non-loopback IPv4 address (the laptop's LAN address), or
 *   127.0.0.1 when the machine has none (offline). Used only to build the pairing URL.
 */
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return '127.0.0.1';
}

/**
 * @param {number} port - the hub's listening port.
 * @returns {string} base URL the phone should use, without a trailing slash:
 *   ASHR_PUBLIC_URL (tunnel) when set, otherwise http://<lan ip>:<port>.
 */
const publicBase = (port) => (process.env.ASHR_PUBLIC_URL || `http://${lanIp()}:${port}`).replace(/\/$/, '');

/**
 * Prints the pairing link, and a terminal QR code when the `qrencode` tool exists.
 * @param {string} url - full pairing URL including ?pair=<code>.
 * @returns {void}
 */
function printPairUrl(url) {
  console.log(`\nPair your phone (one time, 10 min): ${url}\n`);
  // qrencode is optional; any failure (not installed, timeout) just prints a hint.
  try { console.log(execFileSync('qrencode', ['-t', 'ansiutf8', url], { encoding: 'utf8', timeout: 3000 })); }
  catch { console.log('(install qrencode for a terminal QR code)'); }
}

// Run as a script: start the hub with settings from environment variables.
// import.meta.main is true only when this file is run directly, so tests can import
// startHub without side effects.
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
