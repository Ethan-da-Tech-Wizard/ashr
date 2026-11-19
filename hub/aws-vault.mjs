// Zero-dependency AWS S3 Tamper-Proof Audit Vault for ashr.
// Built for SunHacks 2026 (Amazon sponsor prize track).
// $0 budget guarantee: falls back to zero-cost offline dry-run if credentials or bucket are unset.
// Hand-rolled AWS Signature V4 (no SDK), keeping the hub dependency-free.
import { createHash, createHmac } from 'node:crypto';

// Hex SHA-256 of a string or Buffer; other values are stringified first.
export const sha256 = (str) =>
  createHash('sha256')
    .update(typeof str === 'string' || Buffer.isBuffer(str) ? str : String(str ?? ''))
    .digest('hex');
// Raw-bytes HMAC-SHA256, the building block of the SigV4 key derivation.
const hmac = (key, str) => createHmac('sha256', key).update(str).digest();

// Head of the audit hash chain: each record embeds the previous record's hash,
// so deleting or editing any stored record breaks every later link.
let lastHash = '0'.repeat(64);

export function getLastHash() {
  return lastHash;
}

// Reset the chain head (tests, or resuming from a known hash).
export function resetVaultChain(initialHash = '0'.repeat(64)) {
  lastHash = initialHash;
}

// SigV4 signing-key derivation: HMAC chain over date, region, service, "aws4_request".
export function getSignatureKey(key, dateStamp, regionName, serviceName) {
  const kDate = hmac('AWS4' + key, dateStamp);
  const kRegion = hmac(kDate, regionName);
  const kService = hmac(kRegion, serviceName);
  return hmac(kService, 'aws4_request');
}

// Return the headers (including Authorization) for a SigV4-signed S3 request.
// `now` is injectable so signatures are reproducible in tests.
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
