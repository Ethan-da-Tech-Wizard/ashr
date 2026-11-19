// Zero-dependency AWS S3 Tamper-Proof Audit Vault for ashr.
// Built for SunHacks 2026 (Amazon sponsor prize track).
// $0 budget guarantee: falls back to zero-cost offline dry-run if credentials or bucket are unset.
// Hand-rolled AWS Signature V4 (no SDK), keeping the hub dependency-free.
//
// How it fits: routes.hookPermission (auto-allow) and routes.apiDecide (phone decision) call
//   recordDecisionToVault() after every decision, fire-and-forget. Each record is one small JSON
//   object PUT to an S3 bucket, so there is an off-machine trail of what agents were allowed to do.
// Tamper evidence: every record contains `prevHash`, the SHA-256 of the previous record's JSON.
//   Editing or deleting any stored record breaks the chain from that point on. The chain head
//   (`lastHash`) is process memory only: it restarts at 64 zeros whenever the hub restarts, so
//   verifying across restarts means treating each hub run as its own chain.
// Modes: with no ASHR_AWS_VAULT_BUCKET / credentials it runs "dry-run" (computes the hash and
//   key, uploads nothing), so by default nothing is spent and nothing leaves the machine. When
//   configured, each record (session id, tool, summary, risk, decision, optional message) goes to
//   the user's own bucket; do not enable if summaries may contain secrets.
// Inputs: ASHR_AWS_VAULT_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
//   (default us-west-2), AWS_ENDPOINT_URL (LocalStack/MinIO). Test: test/aws-vault.test.mjs
//   (checks signatures against the published AWS example values, no network).
import { createHash, createHmac } from 'node:crypto';

// Hex SHA-256 of a string or Buffer; other values are stringified first.
/**
 * @param {string|Buffer|unknown} str - data to hash; non-string values are stringified.
 * @returns {string} 64-character lowercase hex SHA-256.
 */
export const sha256 = (str) =>
  createHash('sha256')
    .update(typeof str === 'string' || Buffer.isBuffer(str) ? str : String(str ?? ''))
    .digest('hex');
// Raw-bytes HMAC-SHA256, the building block of the SigV4 key derivation.
const hmac = (key, str) => createHmac('sha256', key).update(str).digest();

// Head of the audit hash chain: each record embeds the previous record's hash,
// so deleting or editing any stored record breaks every later link.
// Module-level state: one chain per process. Writes happen synchronously before any await in
// recordDecisionToVault, so concurrent decisions cannot interleave and fork the chain.
let lastHash = '0'.repeat(64);

/** @returns {string} hex hash of the most recent record (64 zeros before the first). */
export function getLastHash() {
  return lastHash;
}

// Reset the chain head (tests, or resuming from a known hash).
/**
 * @param {string} [initialHash] - new chain head; defaults to 64 zeros.
 * @returns {void}
 */
export function resetVaultChain(initialHash = '0'.repeat(64)) {
  lastHash = initialHash;
}

// SigV4 signing-key derivation: HMAC chain over date, region, service, "aws4_request".
/**
 * @param {string} key - AWS secret access key.
 * @param {string} dateStamp - YYYYMMDD.
 * @param {string} regionName - e.g. 'us-west-2'.
 * @param {string} serviceName - e.g. 's3'.
 * @returns {Buffer} 32-byte signing key valid for that day, region and service.
 */
export function getSignatureKey(key, dateStamp, regionName, serviceName) {
  const kDate = hmac('AWS4' + key, dateStamp);
  const kRegion = hmac(kDate, regionName);
  const kService = hmac(kRegion, serviceName);
  return hmac(kService, 'aws4_request');
}

// Return the headers (including Authorization) for a SigV4-signed S3 request.
// `now` is injectable so signatures are reproducible in tests.
/**
 * @param {object} request
 * @param {string} [request.method='GET']
 * @param {string} request.url - absolute URL being requested.
 * @param {string|Buffer} [request.body=''] - payload (hashed, not sent).
 * @param {object} [request.headers] - extra headers to sign (e.g. content-type).
 * @param {string} request.accessKey
 * @param {string} request.secretKey
 * @param {string} [request.region='us-west-2']
 * @param {string} [request.service='s3']
 * @param {boolean} [request.includeContentSha256=true] - S3 requires x-amz-content-sha256.
 * @param {Date|number|string} [request.now] - signing time; inject for reproducible tests.
 * @returns {object} headers to send: host, x-amz-date, optional x-amz-content-sha256, extras,
 *   and Authorization. Follows the AWS Signature Version 4 steps: canonical request, string to
 *   sign, derived key, HMAC signature.
 */
export function signS3Request({
  method = 'GET',
  url,
  body = '',
  headers: extraHeaders = {},
  accessKey,
  secretKey,
  region = 'us-west-2',
  service = 's3',
  includeContentSha256 = true,
  now = new Date(),
}) {
  const u = new URL(url);
  // x-amz-date format is ISO-8601 basic: YYYYMMDD'T'HHMMSS'Z' (separators and millis stripped).
  const xAmzDate = (now instanceof Date ? now : new Date(now))
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = xAmzDate.slice(0, 8);
  const payloadHash = sha256(body);

  // Headers that get signed: lower-cased names, trimmed and whitespace-collapsed values.
  const normalizedHeaders = {
    host: u.host,
    'x-amz-date': xAmzDate,
  };
  if (includeContentSha256) {
    normalizedHeaders['x-amz-content-sha256'] = payloadHash;
  }

  if (extraHeaders && typeof extraHeaders === 'object') {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (v !== undefined && v !== null) {
        normalizedHeaders[k.toLowerCase().trim()] = String(v).trim().replace(/\s+/g, ' ');
      }
    }
  }

  // SigV4 requires headers in sorted order, in both the canonical block and the signed list.
  const sortedKeys = Object.keys(normalizedHeaders).sort();
  const canonicalHeaders = sortedKeys
    .map((k) => `${k}:${normalizedHeaders[k]}\n`)
    .join('');
  const signedHeaders = sortedKeys.join(';');

  // Query params must be sorted by name and percent-encoded.
  let canonicalQuery = '';
  if (u.search) {
    const params = new URLSearchParams(u.search);
    canonicalQuery = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
  }

  // Canonical request = method, path, query, headers, signed header names, payload hash.
  const canonicalRequest = [
    method.toUpperCase(),
    u.pathname || '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const canonicalRequestHash = sha256(canonicalRequest);
  const stringToSign = [algorithm, xAmzDate, credentialScope, canonicalRequestHash].join('\n');

  const signingKey = getSignatureKey(secretKey, dateStamp, region, service);
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const authorization = `${algorithm} Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    ...normalizedHeaders,
    Authorization: authorization,
  };
}

// Append one approve/deny decision to the tamper-evident audit log.
// Settings come from `options` first, then AWS_* / ASHR_AWS_VAULT_BUCKET env vars.
// Returns { ok, mode: 'dry-run' | 's3', key, hash, ... } and never throws.
/**
 * @param {object} [decisionEvent] - {sessionId, tool, summary, risk, decision, message?}.
 * @param {object} [options] - overrides for bucket, accessKey, secretKey, region, endpoint,
 *   fetchFn and now (all default to environment values / real clock).
 * @returns {Promise<{ok: boolean, mode: 'dry-run'|'s3', key: string, hash: string,
 *   status?: number, error?: string}>} never rejects. Note the hash chain advances even in
 *   dry-run mode or when the upload fails, so the in-memory chain is complete for this run.
 */
export async function recordDecisionToVault(decisionEvent = {}, options = {}) {
  const bucket = (options.bucket ?? process.env.ASHR_AWS_VAULT_BUCKET ?? '').trim();
  const accessKey = (options.accessKey ?? process.env.AWS_ACCESS_KEY_ID ?? '').trim();
  const secretKey = (options.secretKey ?? process.env.AWS_SECRET_ACCESS_KEY ?? '').trim();
  const region = (options.region ?? process.env.AWS_REGION ?? 'us-west-2').trim();
  const endpoint = (options.endpoint ?? process.env.AWS_ENDPOINT_URL ?? '').trim();
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  const now = options.now ? new Date(options.now) : new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timestamp = now.getTime();

  // Cryptographic audit chain link
  const recordPayload = {
    ...decisionEvent,
    timestamp,
    iso: now.toISOString(),
    prevHash: lastHash,
  };
  const recordJson = JSON.stringify(recordPayload);
  const recordHash = sha256(recordJson);
  lastHash = recordHash;

  // Key layout: audit/<date>/<session>-<ms timestamp>-<8 hash chars>.json, unique per record.
  const objectKey = `audit/${dateStr}/${decisionEvent.sessionId || 'agent'}-${timestamp}-${recordHash.slice(0, 8)}.json`;

  // Zero-cost guarantee: If bucket or credentials are not configured, log in dry-run mode without billing
  if (!bucket || !accessKey || !secretKey) {
    return {
      ok: true,
      mode: 'dry-run',
      key: objectKey,
      hash: recordHash,
    };
  }

  // Support for custom endpoints (e.g. LocalStack, MinIO, or mock test server)
  // Path-style URL for custom endpoints (LocalStack/MinIO); virtual-hosted style for real AWS.
  let s3Url;
  if (endpoint) {
    const cleanEndpoint = endpoint.replace(/\/$/, '');
    s3Url = `${cleanEndpoint}/${bucket}/${objectKey}`;
  } else {
    const host = `${bucket}.s3.${region}.amazonaws.com`;
    s3Url = `https://${host}/${objectKey}`;
  }

  try {
    const signedHeaders = signS3Request({
      method: 'PUT',
      url: s3Url,
      body: recordJson,
      headers: {
        'content-type': 'application/json',
      },
      accessKey,
      secretKey,
      region,
      service: 's3',
      includeContentSha256: true,
      now,
    });

    const res = await fetchFn(s3Url, {
      method: 'PUT',
      headers: signedHeaders,
      body: recordJson,
    });

    return {
      ok: res.ok,
      mode: 's3',
      status: res.status,
      key: objectKey,
      hash: recordHash,
    };
  // Network or signing errors are reported in the result rather than thrown: auditing must never break an approval.
  } catch (err) {
    return {
      ok: false,
      mode: 's3',
      error: err.message,
      key: objectKey,
      hash: recordHash,
    };
  }
}
