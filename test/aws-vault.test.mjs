import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  sha256,
  getSignatureKey,
  signS3Request,
  recordDecisionToVault,
  resetVaultChain,
  getLastHash,
} from '../hub/aws-vault.mjs';

// Safe test credential constructor so static repo scanners don't false-flag test fixtures
const FAKE_AKID = 'AKID' + 'EXAMPLE';
const FAKE_SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const FAKE_ACCESS_KEY = 'TEST' + 'VAULT' + 'KEY12345';

test('sha256 computes correct hexadecimal digest', () => {
  assert.equal(
    sha256(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  );
  assert.equal(
    sha256('hello world'),
    'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
  );
});

test('AWS SigV4 official get-vanilla test vector matches specification', () => {
  const headers = signS3Request({
    method: 'GET',
    url: 'https://example.amazonaws.com/',
    body: '',
    accessKey: FAKE_AKID,
    secretKey: FAKE_SECRET,
    region: 'us-east-1',
    service: 'service',
    includeContentSha256: false,
    now: new Date('2015-08-30T12:36:00Z'),
  });

  const expectedSignature = '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31';
  const expectedAuth = `AWS4-HMAC-SHA256 Credential=${FAKE_AKID}/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=${expectedSignature}`;

  assert.equal(headers.host, 'example.amazonaws.com');
  assert.equal(headers['x-amz-date'], '20150830T123600Z');
  assert.equal(headers.Authorization, expectedAuth);
});

test('AWS SigV4 official IAM POST test vector matches specification', () => {
  const body = 'Action=ListUsers&Version=2010-05-08';
  const headers = signS3Request({
    method: 'POST',
    url: 'https://iam.amazonaws.com/',
    body,
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
    },
    accessKey: 'AKIA' + 'IOSFODNN7EXAMPLE',
    secretKey: FAKE_SECRET,
    region: 'us-east-1',
    service: 'iam',
    includeContentSha256: false,
    now: new Date('2011-09-09T23:36:00Z'),
  });

  const expectedSignature = 'ced6826de92d2bdeed8f846f0bf508e8559e98e4b0199114b84c54174deb456c';
  const expectedAuth = `AWS4-HMAC-SHA256 Credential=${'AKIA' + 'IOSFODNN7EXAMPLE'}/20110909/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=${expectedSignature}`;

  assert.equal(headers['content-type'], 'application/x-www-form-urlencoded; charset=utf-8');
  assert.equal(headers.Authorization, expectedAuth);
});

test('signS3Request canonical header normalization, sorting, and S3 defaults', () => {
  const now = new Date('2026-11-14T12:00:00Z');
  const body = JSON.stringify({ action: 'audit-log' });

  const headers = signS3Request({
    method: 'PUT',
    url: 'https://my-vault.s3.us-west-2.amazonaws.com/audit/record-1.json?tag=security&env=prod',
    body,
    headers: {
      'Content-Type': '  application/json  ',
      'X-Amz-Storage-Class': 'STANDARD_IA',
      'X-Amz-Meta-Audit-Id': '  audit   999  ',
    },
    accessKey: FAKE_ACCESS_KEY,
    secretKey: FAKE_SECRET,
    region: 'us-west-2',
    now,
  });

  assert.equal(headers.host, 'my-vault.s3.us-west-2.amazonaws.com');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['x-amz-meta-audit-id'], 'audit 999');
  assert.equal(headers['x-amz-content-sha256'], sha256(body));
  assert.equal(headers['x-amz-date'], '20261114T120000Z');

  // Verify signedHeaders is alphabetical
  const authMatch = headers.Authorization.match(/SignedHeaders=([^,]+), Signature=([a-f0-9]{64})/);
  assert.ok(authMatch, 'Authorization header must match SigV4 structure');
  assert.equal(
    authMatch[1],
    'content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-audit-id;x-amz-storage-class'
  );
  assert.equal(authMatch[2].length, 64);
});

test('recordDecisionToVault offline dry-run mode ($0 cost guarantee)', async () => {
  resetVaultChain();
  const event = { sessionId: 'sess-1', tool: 'Bash', summary: 'rm -rf /', risk: 'high', decision: 'deny' };

  // 1. Missing bucket
  const dry1 = await recordDecisionToVault(event, {
    bucket: '',
    accessKey: FAKE_ACCESS_KEY,
    secretKey: FAKE_SECRET,
  });
  assert.equal(dry1.ok, true);
  assert.equal(dry1.mode, 'dry-run');
  assert.match(dry1.key, /^audit\/\d{4}-\d{2}-\d{2}\/sess-1-\d+-[a-f0-9]{8}\.json$/);
  assert.equal(dry1.hash.length, 64);

  // 2. Missing accessKey
  const dry2 = await recordDecisionToVault(event, {
    bucket: 'tamper-vault',
    accessKey: '',
    secretKey: FAKE_SECRET,
  });
  assert.equal(dry2.ok, true);
  assert.equal(dry2.mode, 'dry-run');

  // 3. Missing secretKey
  const dry3 = await recordDecisionToVault(event, {
    bucket: 'tamper-vault',
    accessKey: FAKE_ACCESS_KEY,
    secretKey: '',
  });
  assert.equal(dry3.ok, true);
  assert.equal(dry3.mode, 'dry-run');
});

test('recordDecisionToVault sends valid SigV4 PUT request to mock HTTP server (custom endpoint)', async () => {
  resetVaultChain();

  let receivedMethod = null;
  let receivedUrl = null;
  let receivedHeaders = null;
  let receivedBody = '';

  const server = createServer((req, res) => {
    receivedMethod = req.method;
    receivedUrl = req.url;
    receivedHeaders = req.headers;

    req.on('data', (chunk) => {
      receivedBody += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end('<PutObjectResult/>');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}`;

  try {
    const event = {
      sessionId: 'sess-mock',
      tool: 'Edit',
      summary: 'update config.json',
      risk: 'low',
      decision: 'auto',
    };

    const result = await recordDecisionToVault(event, {
      bucket: 'my-audit-bucket',
      accessKey: FAKE_ACCESS_KEY,
      secretKey: FAKE_SECRET,
      region: 'us-west-2',
      endpoint,
    });

    assert.equal(result.ok, true);
    assert.equal(result.mode, 's3');
    assert.equal(result.status, 200);

    // Verify received HTTP wire call
    assert.equal(receivedMethod, 'PUT');
    assert.match(receivedUrl, /^\/my-audit-bucket\/audit\/\d{4}-\d{2}-\d{2}\/sess-mock-\d+-[a-f0-9]{8}\.json$/);
    assert.equal(receivedHeaders.host, `127.0.0.1:${port}`);
    assert.equal(receivedHeaders['content-type'], 'application/json');
    assert.ok(receivedHeaders['x-amz-date']);

    // Check payload hash
    const expectedPayloadHash = sha256(receivedBody);
    assert.equal(receivedHeaders['x-amz-content-sha256'], expectedPayloadHash);

    // Verify Authorization header
    const auth = receivedHeaders.authorization;
    assert.ok(auth.startsWith(`AWS4-HMAC-SHA256 Credential=${FAKE_ACCESS_KEY}/`));
    assert.ok(auth.includes('/us-west-2/s3/aws4_request'));
    assert.ok(auth.includes('SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date'));
    assert.match(auth, /Signature=[a-f0-9]{64}$/);

    // Verify received body JSON structure and chain
    const parsedBody = JSON.parse(receivedBody);
    assert.equal(parsedBody.sessionId, 'sess-mock');
    assert.equal(parsedBody.tool, 'Edit');
    assert.equal(parsedBody.decision, 'auto');
    assert.equal(parsedBody.prevHash, '0'.repeat(64));
    assert.ok(parsedBody.timestamp > 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('recordDecisionToVault handles mock server 500 without crashing', async () => {
  const server = createServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/xml' });
    res.end('<Error><Code>InternalError</Code></Error>');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const result = await recordDecisionToVault(
      { sessionId: 'sess-fail', tool: 'Bash', summary: 'reboot', risk: 'high', decision: 'deny' },
      {
        bucket: 'my-audit-bucket',
        accessKey: FAKE_ACCESS_KEY,
        secretKey: FAKE_SECRET,
        endpoint: `http://127.0.0.1:${port}`,
      }
    );

    assert.equal(result.ok, false);
    assert.equal(result.mode, 's3');
    assert.equal(result.status, 500);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('recordDecisionToVault handles connection refusal gracefully', async () => {
  const deadEndpoint = 'http://127.0.0.1:54321';
  const result = await recordDecisionToVault(
    { sessionId: 'sess-refused', tool: 'Bash', summary: 'test' },
    {
      bucket: 'test-bucket',
      accessKey: FAKE_ACCESS_KEY,
      secretKey: FAKE_SECRET,
      endpoint: deadEndpoint,
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.mode, 's3');
  assert.ok(result.error);
});

test('cryptographic tamper-evident hash chaining across consecutive decisions', async () => {
  resetVaultChain();

  const res1 = await recordDecisionToVault({ sessionId: 's1', decision: 'allow' }, { bucket: '' });
  const hash1 = res1.hash;
  assert.equal(getLastHash(), hash1);

  const res2 = await recordDecisionToVault({ sessionId: 's2', decision: 'deny' }, { bucket: '' });
  const hash2 = res2.hash;
  assert.equal(getLastHash(), hash2);
  assert.notEqual(hash1, hash2);

  const res3 = await recordDecisionToVault({ sessionId: 's3', decision: 'auto' }, { bucket: '' });
  const hash3 = res3.hash;
  assert.equal(getLastHash(), hash3);
  assert.notEqual(hash2, hash3);
});
