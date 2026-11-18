// Program: ashr - aws-vault.mjs
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: A tamper-evident audit log: each decision is hashed into a chain and written to S3 (signed with AWS Signature V4 using only Node's crypto), or just hashed in a dry run when no AWS settings exist.
// Zero-dependency AWS S3 Tamper-Proof Audit Vault for ashr.
// Built for SunHacks 2026 (Amazon sponsor prize track).
// $0 budget guarantee: falls back to zero-cost offline dry-run if credentials or bucket are unset.
// Node's hashing and HMAC functions.
import { createHash, createHmac } from 'node:crypto';

// SHA-256 of any value, as hex text.
export const sha256 = (str) =>
  createHash('sha256')
    .update(typeof str === 'string' || Buffer.isBuffer(str) ? str : String(str ?? ''))
    .digest('hex');
// HMAC-SHA256 returning raw bytes, used while deriving the signing key.
const hmac = (key, str) => createHmac('sha256', key).update(str).digest();

// The hash of the previous record; each new record includes it, which links the records in a chain.
let lastHash = '0'.repeat(64);

// Return the latest hash in the chain.
export function getLastHash() {
  return lastHash;
}

// Reset the chain (used by tests).
export function resetVaultChain(initialHash = '0'.repeat(64)) {
  lastHash = initialHash;
}

// Derive the AWS Signature V4 signing key by chaining HMACs over the date, region, service and the text "aws4_request".
export function getSignatureKey(key, dateStamp, regionName, serviceName) {
  const kDate = hmac('AWS4' + key, dateStamp);
  const kRegion = hmac(kDate, regionName);
  const kService = hmac(kRegion, serviceName);
  return hmac(kService, 'aws4_request');
}

// Create the headers for a signed S3 request: build the canonical request, the string to sign and the signature, and return the headers with an Authorization value.
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
  // Read the address and make the timestamp (x-amz-date) and the hash of the body.
  const u = new URL(url);
  const xAmzDate = (now instanceof Date ? now : new Date(now))
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = xAmzDate.slice(0, 8);
  const payloadHash = sha256(body);

  // Collect the headers that are signed: host, date, optional body hash, and any extra headers in lower case.
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

  // Signed headers must be sorted by name.
  const sortedKeys = Object.keys(normalizedHeaders).sort();
  const canonicalHeaders = sortedKeys
    .map((k) => `${k}:${normalizedHeaders[k]}\n`)
    .join('');
  const signedHeaders = sortedKeys.join(';');

  // Sort and encode the query parameters.
  let canonicalQuery = '';
  if (u.search) {
    const params = new URLSearchParams(u.search);
    canonicalQuery = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
  }

  // The canonical request: method, path, query, headers, signed header names and body hash.
  const canonicalRequest = [
    method.toUpperCase(),
    u.pathname || '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  // Build the string to sign, derive the key, compute the signature and assemble the Authorization header.
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

// Add one decision to the audit chain and, if a bucket and credentials are configured, upload it to S3. Returns the mode (dry-run or s3), the object key and the hash.
export async function recordDecisionToVault(decisionEvent = {}, options = {}) {
  // Read the settings from options or environment variables.
  const bucket = (options.bucket ?? process.env.ASHR_AWS_VAULT_BUCKET ?? '').trim();
  const accessKey = (options.accessKey ?? process.env.AWS_ACCESS_KEY_ID ?? '').trim();
  const secretKey = (options.secretKey ?? process.env.AWS_SECRET_ACCESS_KEY ?? '').trim();
  const region = (options.region ?? process.env.AWS_REGION ?? 'us-west-2').trim();
  const endpoint = (options.endpoint ?? process.env.AWS_ENDPOINT_URL ?? '').trim();
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  const now = options.now ? new Date(options.now) : new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timestamp = now.getTime();

  // Build the record with its time and the previous hash, hash it and make it the new last hash.
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

  // The object key is audit/<date>/<session>-<time>-<hash prefix>.json.
  const objectKey = `audit/${dateStr}/${decisionEvent.sessionId || 'agent'}-${timestamp}-${recordHash.slice(0, 8)}.json`;

  // Without a bucket or credentials return a dry-run result and send nothing.
  // Zero-cost guarantee: If bucket or credentials are not configured, log in dry-run mode without billing
  if (!bucket || !accessKey || !secretKey) {
    return {
      ok: true,
      mode: 'dry-run',
      key: objectKey,
      hash: recordHash,
    };
  }

  // Use a custom endpoint if given (for example a local test server), otherwise the normal S3 address.
  // Support for custom endpoints (e.g. LocalStack, MinIO, or mock test server)
  let s3Url;
  if (endpoint) {
    const cleanEndpoint = endpoint.replace(/\/$/, '');
    s3Url = `${cleanEndpoint}/${bucket}/${objectKey}`;
  } else {
    const host = `${bucket}.s3.${region}.amazonaws.com`;
    s3Url = `https://${host}/${objectKey}`;
  }

  // Sign and upload the record with PUT; errors are returned as ok: false instead of being thrown.
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
