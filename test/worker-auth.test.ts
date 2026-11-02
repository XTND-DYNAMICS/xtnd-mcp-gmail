import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { DEFAULT_MAIL_SCOPES, authenticateRequest, type FetchLike } from '../src/worker/auth.js';
import worker from '../src/worker/index.js';
import { handleMcpStreamableHttp } from '../src/worker/mcp-streamable-http.js';
import type { WorkerEnv } from '../src/types.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function kv(records: Record<string, string> = {}, options: { fail?: boolean; reads?: string[] } = {}) {
  return {
    get: async (key: string) => {
      options.reads?.push(key);
      if (options.fail) throw new Error('KV unavailable');
      return records[key] ?? null;
    },
    put: async () => {},
    delete: async () => {},
  };
}

function env(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return { KV: kv(), ...overrides } as WorkerEnv;
}

const OAUTH = {
  OAUTH_AUTHORIZATION_SERVER: 'https://auth.example.com',
  OAUTH_INTROSPECTION_URL: 'https://auth.example.com/introspect',
  OAUTH_CLIENT_ID: 'resource-server',
  OAUTH_CLIENT_SECRET: 'introspection-secret',
  OAUTH_AUDIENCE: 'https://mail.example.com/mcp',
} as Partial<WorkerEnv>;

const bearer = (token: string, path = '/api/folders', init: RequestInit = {}) =>
  new Request(`https://mail.example.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) },
  });

function introspection(answer: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(typeof answer === 'string' ? answer : JSON.stringify(answer), { status });
  };
  return { fetchImpl, calls };
}

const activeToken = () => ({
  active: true,
  sub: 'user-123',
  aud: 'https://mail.example.com/mcp',
  iss: 'https://auth.example.com',
  exp: Math.floor(Date.now() / 1000) + 600,
  scope: 'mail.read mail.send mail.read',
});

test('a request without a well-formed bearer token is refused', async () => {
  const cases: (string | null)[] = [null, 'Basic dXNlcjpwYXNz', 'Bearer', 'Bearer    ', `Bearer ${'x'.repeat(16_385)}`];
  for (const header of cases) {
    const request = new Request('https://mail.example.com/api/folders', header === null ? {} : { headers: { Authorization: header } });
    const result = await authenticateRequest(request, env({ API_KEYS_SHA256: sha256('x'.repeat(16_385)) }));
    assert.equal(result.authenticated, false, String(header).slice(0, 20));
    if (!result.authenticated) assert.equal(result.status, 401);
  }
});

test('a KV API key is found by its SHA-256 hash; the principal never holds the raw token', async () => {
  const token = 'kv-api-key-value';
  const result = await authenticateRequest(
    bearer(token),
    env({ KV: kv({ [`apikey:${sha256(token)}`]: JSON.stringify({ scopes: ['mail.read', ' mail.read ', 'mail.send'] }) }) }),
  );

  assert.equal(result.authenticated, true);
  if (!result.authenticated) return;
  assert.deepEqual(result.principal, { subject: sha256(token), tokenHash: sha256(token), scopes: ['mail.read', 'mail.send'], source: 'kv' });
  assert.doesNotMatch(JSON.stringify(result.principal), new RegExp(token));
});

test('a KV key with unreadable scope metadata authenticates with no scopes at all', async () => {
  const token = 'kv-api-key-value';
  for (const record of ['not json', '{}', JSON.stringify({ scopes: 'mail.read' }), JSON.stringify({ scopes: ['mail.read', 7] }), JSON.stringify({ scopes: ['mail.read', ''] })]) {
    const result = await authenticateRequest(bearer(token), env({ KV: kv({ [`apikey:${sha256(token)}`]: record }) }));
    assert.equal(result.authenticated, true, record);
    if (result.authenticated) assert.deepEqual(result.principal.scopes, [], record);
  }
});

test('a KV outage is reported as unavailable (503), never as a pass', async () => {
  const result = await authenticateRequest(bearer('anything'), env({ KV: kv({}, { fail: true }), API_KEYS_SHA256: sha256('anything') }));
  assert.deepEqual(result, { authenticated: false, error: 'Bearer token verification is unavailable.', status: 503 });
});

test('an API_KEYS_SHA256 entry matches its token whatever its case or padding, and only its token', async () => {
  const token = 'env-api-key-value';
  const allowed = ` not-a-hash , ${sha256('other-key')}, ${sha256(token).toUpperCase()} `;

  const accepted = await authenticateRequest(bearer(token), env({ API_KEYS_SHA256: allowed }));
  assert.equal(accepted.authenticated, true);
  if (accepted.authenticated) {
    assert.equal(accepted.principal.source, 'env');
    assert.deepEqual(accepted.principal.scopes, [...DEFAULT_MAIL_SCOPES]);
  }

  for (const wrong of ['env-api-key-valu', 'env-api-key-value2', sha256(token)]) {
    const refused = await authenticateRequest(bearer(wrong), env({ API_KEYS_SHA256: allowed }));
    assert.deepEqual(refused, { authenticated: false, error: 'Invalid bearer token.', status: 401 }, wrong);
  }
});

test('a partly configured OAuth verifier fails closed with 503', async () => {
  const { OAUTH_CLIENT_SECRET: _omitted, ...partial } = OAUTH;
  const { fetchImpl, calls } = introspection(activeToken());
  const result = await authenticateRequest(bearer('oauth-token'), env(partial), fetchImpl);
  assert.deepEqual(result, { authenticated: false, error: 'OAuth token verification is unavailable.', status: 503 });
  assert.equal(calls.length, 0);
});

test('an OAuth token is introspected with client authentication and no redirects', async () => {
  const { fetchImpl, calls } = introspection(activeToken());
  const result = await authenticateRequest(bearer('oauth-token'), env(OAUTH), fetchImpl);

  assert.equal(result.authenticated, true);
  if (!result.authenticated) return;
  assert.equal(result.principal.source, 'oauth');
  assert.equal(result.principal.subject, sha256('oauth\0https://auth.example.com\0user-123'));
  assert.deepEqual(result.principal.scopes, ['mail.read', 'mail.send']);

  const [call] = calls;
  assert.equal(call.url, 'https://auth.example.com/introspect');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'error');
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get('Authorization'), `Basic ${Buffer.from('resource-server:introspection-secret').toString('base64')}`);
  assert.equal(new URLSearchParams(String(call.init.body)).get('token'), 'oauth-token');
});

test('an audience given as a list must contain this resource', async () => {
  const accepted = introspection({ ...activeToken(), aud: ['https://other.example.com', 'https://mail.example.com/mcp'] });
  assert.equal((await authenticateRequest(bearer('t'), env(OAUTH), accepted.fetchImpl)).authenticated, true);

  const refused = introspection({ ...activeToken(), aud: ['https://other.example.com'] });
  assert.equal((await authenticateRequest(bearer('t'), env(OAUTH), refused.fetchImpl)).authenticated, false);
});

test('inactive, misaddressed, expired, not-yet-valid or malformed OAuth tokens are refused with 401', async () => {
  const now = Math.floor(Date.now() / 1000);
  const rejected: Record<string, unknown>[] = [
    { ...activeToken(), active: false },
    { ...activeToken(), active: 'true' },
    { ...activeToken(), aud: 'https://other.example.com' },
    { ...activeToken(), iss: 'https://evil.example.com' },
    { ...activeToken(), exp: now - 1 },
    { ...activeToken(), exp: undefined },
    { ...activeToken(), nbf: now + 600 },
    { ...activeToken(), sub: '' },
    { ...activeToken(), sub: 'user\n123' },
    { ...activeToken(), scope: ['mail.read'] },
  ];
  for (const answer of rejected) {
    const { fetchImpl } = introspection(answer);
    const result = await authenticateRequest(bearer('oauth-token'), env(OAUTH), fetchImpl);
    assert.deepEqual(result, { authenticated: false, error: 'Invalid bearer token.', status: 401 }, JSON.stringify(answer));
  }
});

test('a failing or misbehaving introspection endpoint gives 503, never a pass', async () => {
  const failures: FetchLike[] = [
    introspection(activeToken(), 500).fetchImpl,
    introspection('not json').fetchImpl,
    introspection('x'.repeat(70_000)).fetchImpl,
    async () => new Response('{}', { headers: { 'Content-Length': '70000' } }),
    async () => { throw new TypeError('network down'); },
  ];
  for (const fetchImpl of failures) {
    const result = await authenticateRequest(bearer('oauth-token'), env(OAUTH), fetchImpl);
    assert.deepEqual(result, { authenticated: false, error: 'OAuth token verification is unavailable.', status: 503 });
  }
});

test('an introspection URL that is not plain HTTPS is never called', async () => {
  for (const url of ['http://auth.example.com/introspect', 'https://user:pass@auth.example.com/introspect', 'https://auth.example.com/introspect#x']) {
    const { fetchImpl, calls } = introspection(activeToken());
    const result = await authenticateRequest(bearer('oauth-token'), env({ ...OAUTH, OAUTH_INTROSPECTION_URL: url }), fetchImpl);
    assert.equal(result.authenticated, false, url);
    assert.equal(calls.length, 0, url);
  }
});

const ctx = {} as never;

test('the Worker refuses an unauthenticated call and points OAuth clients at its metadata', async () => {
  const plain = await worker.fetch(new Request('https://mail.example.com/api/folders'), env(), ctx);
  assert.equal(plain.status, 401);
  assert.equal(plain.headers.get('WWW-Authenticate'), null);

  const withOAuth = await worker.fetch(new Request('https://mail.example.com/api/folders'), env(OAUTH), ctx);
  assert.equal(withOAuth.status, 401);
  assert.match(withOAuth.headers.get('WWW-Authenticate') ?? '', /resource_metadata="https:\/\/mail\.example\.com\/\.well-known\/oauth-protected-resource"/);
});

test('each REST route demands its own scope before touching mailbox credentials', async () => {
  const token = 'scoped-key';
  const reads: string[] = [];
  const withScopes = (scopes: string[]) => env({ KV: kv({ [`apikey:${sha256(token)}`]: JSON.stringify({ scopes }) }, { reads }) });
  const cases: [string, RequestInit, string[], string][] = [
    ['/api/folders', {}, ['mail.send', 'mail.manage', 'mail.delete'], 'mail.read'],
    ['/api/emails/search', { method: 'POST', body: '{}' }, ['mail.send'], 'mail.read'],
    ['/api/emails/7', {}, ['mail.manage'], 'mail.read'],
    ['/api/emails/send', { method: 'POST', body: JSON.stringify({ to: 'a@example.com', subject: 's' }) }, ['mail.read', 'mail.manage', 'mail.delete'], 'mail.send'],
    ['/api/accounts/link', { method: 'POST', body: '{}' }, ['mail.read', 'mail.send'], 'mail.manage'],
  ];
  for (const [path, init, scopes, required] of cases) {
    reads.length = 0;
    const response = await worker.fetch(bearer(token, path, init), withScopes(scopes), ctx);
    assert.equal(response.status, 403, path);
    assert.equal((await response.json() as { requiredScope: string }).requiredScope, required, path);
    assert.deepEqual(reads, [`apikey:${sha256(token)}`], path);
  }
});

test('an MCP tool call needs the tool\'s scope, and without it no mailbox credentials are read', async () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['search_emails', {}, 'mail.read'],
    ['send_email', { to: 'a@example.com', subject: 's' }, 'mail.send'],
    ['send_draft', { draftId: 'd1' }, 'mail.send'],
    ['mark_emails', { uids: [1], action: 'read' }, 'mail.manage'],
    ['delete_emails', { uids: [1] }, 'mail.delete'],
  ];
  for (const [name, args, required] of cases) {
    let credentialsRead = false;
    const response = await handleMcpStreamableHttp(
      new Request('https://mail.example.com/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }),
      {
        subject: 'subject',
        scopes: DEFAULT_MAIL_SCOPES.filter((scope) => scope !== required),
        resolveCredentials: async () => { credentialsRead = true; return null; },
        enableLegacySse: false,
      },
    );
    const body = await response.json() as { result?: { isError?: boolean; content?: { text: string }[] } };
    assert.equal(body.result?.isError, true, name);
    assert.match(body.result?.content?.[0]?.text ?? '', new RegExp(`not authorized for ${required.replace('.', '\\.')}`), name);
    assert.equal(credentialsRead, false, name);
  }
});
