import { strict as assert } from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createWorker } from '../src/worker/index.js';
import type { WorkerEnv } from '../src/types.js';

function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string, options?: 'text' | 'json' | { type?: string }) {
      const value = store.get(key);
      if (value === undefined) return null;
      const type = typeof options === 'string' ? options : options?.type;
      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) { store.set(key, value); },
    async delete(key: string) { store.delete(key); },
    async list(options: { prefix?: string } = {}) {
      const keys = [...store.keys()]
        .filter((name) => name.startsWith(options.prefix ?? ''))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: '' };
    },
  };
}

const ORIGIN = 'https://gmail.mcp.xgi.io';
const RESOURCE = `${ORIGIN}/`;
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const APP_PASSWORD_A = 'abcdefghijklmnop';
const APP_PASSWORD_B = 'qrstuvwxyzabcdef';

function setup() {
  const kv = memoryKv();
  const env = {
    KV: kv,
    OAUTH_KV: kv,
    MCP_RESOURCE_URL: RESOURCE,
    CREDENTIALS_MASTER_KEY: randomBytes(32).toString('base64'),
    GMAIL_IMAP_HOST: 'imap.gmail.com',
    GMAIL_IMAP_PORT: '993',
    GMAIL_SMTP_HOST: 'smtp.gmail.com',
    GMAIL_SMTP_PORT: '465',
  } as unknown as WorkerEnv;

  const passwords = new Map<string, string>([
    ['pam@stejle.dk', APP_PASSWORD_A],
    ['admin@petermolgaard.com', APP_PASSWORD_B],
  ]);

  const worker = createWorker({
    verifyMailbox: async (credentials) => {
      if (passwords.get(credentials.email) !== credentials.appPassword) {
        throw new Error('Gmail rejected the login');
      }
    },
  });

  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const fetch = (path: string, init?: RequestInit) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
  return { kv, env, fetch };
}

const base64url = (buffer: Buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decodeBase64Url = (segment: string): Uint8Array => Buffer.from(segment, 'base64url');

async function registerClient(app: ReturnType<typeof setup>): Promise<string> {
  const registration = await app.fetch('/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'ChatGPT Multi-Account Connector',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  assert.equal(registration.status, 201);
  const { client_id: clientId } = (await registration.json()) as { client_id: string };
  return clientId;
}

async function authorizeMailbox(
  app: ReturnType<typeof setup>,
  clientId: string,
  email: string,
  appPassword: string,
  nonce = 'nonce-abc-123',
) {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: 'openid profile email offline_access mail.read mail.manage mail.send mail.delete',
    state: `state-${email}`,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE,
  });
  const authorizePath = `/authorize?${query}`;
  const consentPage = await app.fetch(authorizePath);
  assert.equal(consentPage.status, 200);
  const html = await consentPage.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1]?.replace(
    /&#(\d+);/g,
    (_, code) => String.fromCharCode(Number(code)),
  );
  assert.ok(handle);
  const cookie = consentPage.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ');

  const form = new URLSearchParams({
    handle: handle!,
    nonce,
    email,
    appPassword,
    decision: 'approve',
  });
  for (const scope of ['offline_access', 'mail.read', 'mail.manage', 'mail.send', 'mail.delete']) {
    form.append('scope', scope);
  }

  const submitted = await app.fetch(authorizePath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: form,
  });
  assert.equal(submitted.status, 302);
  const redirect = new URL(submitted.headers.get('Location')!);
  const code = redirect.searchParams.get('code');
  assert.ok(code);

  const tokenRes = await app.fetch('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    }),
  });
  assert.equal(tokenRes.status, 200);
  return (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    scope: string;
  };
}

test('OIDC discovery: openid-configuration and oauth-authorization-server advertise userinfo and JWKS', async () => {
  const app = setup();
  for (const path of [
    '/.well-known/openid-configuration',
    '/.well-known/openid-configuration/mcp',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-authorization-server/mcp',
  ]) {
    const res = await app.fetch(path);
    assert.equal(res.status, 200, `expected 200 on ${path}`);
    const doc = (await res.json()) as Record<string, unknown>;
    assert.equal(doc.issuer, ORIGIN);
    assert.equal(doc.userinfo_endpoint, `${ORIGIN}/oauth/userinfo`);
    assert.equal(doc.jwks_uri, `${ORIGIN}/oauth/jwks.json`);
    assert.equal(doc.logo_uri, `${ORIGIN}/icon-192.png`);
    assert.deepEqual(doc.id_token_signing_alg_values_supported, ['ES256']);
    assert.deepEqual(doc.claims_supported, ['sub', 'name', 'preferred_username', 'email', 'email_verified']);
    const scopes = doc.scopes_supported as string[];
    assert.ok(scopes.includes('openid'));
    assert.ok(scopes.includes('email'));
    assert.ok(scopes.includes('profile'));
    assert.ok(scopes.includes('mail.read'));
  }
});

test('multi-account connector: two Gmail mailboxes coexist under one client with distinct OIDC userinfo and verified ES256 id_tokens', async () => {
  const app = setup();
  const clientId = await registerClient(app);

  const tokensA = await authorizeMailbox(app, clientId, 'pam@stejle.dk', APP_PASSWORD_A, 'nonce-stejle');
  const tokensB = await authorizeMailbox(app, clientId, 'admin@petermolgaard.com', APP_PASSWORD_B, 'nonce-pm');

  assert.ok(tokensA.id_token, 'first account receives signed id_token');
  assert.ok(tokensB.id_token, 'second account receives signed id_token');

  // Verify ES256 signatures against /oauth/jwks.json and ensure private key material is sealed in KV.
  const jwksRes = await app.fetch('/oauth/jwks.json');
  assert.equal(jwksRes.status, 200);
  const { keys } = (await jwksRes.json()) as { keys: Array<JsonWebKey & { kid: string; alg: string }> };
  assert.equal(keys.length, 1);
  assert.equal(keys[0].alg, 'ES256');
  assert.equal('d' in keys[0], false);

  const rawSigningRecord = app.kv.store.get('oidc:signing-key:v1') ?? '';
  assert.equal(rawSigningRecord.includes('"d"'), false, 'private scalar d is never stored in clear');

  const publicKey = await crypto.subtle.importKey(
    'jwk',
    keys[0],
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );

  for (const [token, expectedEmail, expectedNonce] of [
    [tokensA.id_token!, 'pam@stejle.dk', 'nonce-stejle'],
    [tokensB.id_token!, 'admin@petermolgaard.com', 'nonce-pm'],
  ] as const) {
    const [headerSeg, payloadSeg, sigSeg] = token.split('.');
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      decodeBase64Url(sigSeg),
      new TextEncoder().encode(`${headerSeg}.${payloadSeg}`),
    );
    assert.equal(valid, true, `ES256 signature verifies for ${expectedEmail}`);
    const claims = JSON.parse(Buffer.from(payloadSeg, 'base64url').toString('utf8')) as Record<string, unknown>;
    assert.equal(claims.iss, ORIGIN);
    assert.equal(claims.aud, clientId);
    assert.equal(claims.email, expectedEmail);
    assert.equal(claims.preferred_username, expectedEmail);
    assert.equal(claims.email_verified, true);
    assert.equal(claims.nonce, expectedNonce);
  }

  // Both accounts remain active simultaneously on /oauth/userinfo (GET + POST).
  const userInfoA = await app.fetch('/oauth/userinfo', {
    headers: { Authorization: `Bearer ${tokensA.access_token}` },
  });
  assert.equal(userInfoA.status, 200);
  const bodyA = (await userInfoA.json()) as Record<string, unknown>;
  assert.equal(bodyA.email, 'pam@stejle.dk');
  assert.equal(bodyA.preferred_username, 'pam@stejle.dk');

  const userInfoB = await app.fetch('/oauth/userinfo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ access_token: tokensB.access_token }),
  });
  assert.equal(userInfoB.status, 200);
  const bodyB = (await userInfoB.json()) as Record<string, unknown>;
  assert.equal(bodyB.email, 'admin@petermolgaard.com');
  assert.notEqual(bodyA.sub, bodyB.sub, 'each mailbox has a distinct stable OIDC subject');

  // Refreshing Account A emits a fresh id_token without replaying the initial authorization nonce.
  const refreshed = await app.fetch('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokensA.refresh_token!,
      client_id: clientId,
      resource: RESOURCE,
    }),
  });
  assert.equal(refreshed.status, 200);
  const refreshedBody = (await refreshed.json()) as { id_token?: string };
  assert.ok(refreshedBody.id_token);
  const refreshedClaims = JSON.parse(
    Buffer.from(refreshedBody.id_token!.split('.')[1], 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
  assert.equal(refreshedClaims.email, 'pam@stejle.dk');
  assert.equal('nonce' in refreshedClaims, false);

  // Unauthenticated /oauth/userinfo returns 401 with Bearer challenge.
  const unauth = await app.fetch('/oauth/userinfo');
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('WWW-Authenticate') ?? '', /^Bearer /);
});

test('loopback X-OAuth-Fetch completion & branded auto-close UI work end-to-end on canonical endpoint', async () => {
  const app = setup();
  const loopbackRedirect = 'http://127.0.0.1:64601/callback';

  // 1. Discarded /account/2 route is not served (returns 404)
  const challengeRes = await app.fetch('/account/2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(challengeRes.status, 404);
  const removedPrm = await app.fetch('/.well-known/oauth-protected-resource/account/2');
  assert.equal(removedPrm.status, 404);

  // 2. Canonical Protected Resource Metadata advertises root resource & brand icon
  const prmRes = await app.fetch('/.well-known/oauth-protected-resource');
  assert.equal(prmRes.status, 200);
  const prm = (await prmRes.json()) as Record<string, unknown>;
  assert.equal(prm.resource, RESOURCE);
  assert.equal(prm.resource_name, 'XMAIL | Gmail');
  assert.equal(prm.logo_uri, `${ORIGIN}/favicon.svg`);

  // 3. Register desktop loopback client
  const regRes = await app.fetch('/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Codex Desktop',
      redirect_uris: [loopbackRedirect],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  assert.equal(regRes.status, 201);
  const { client_id: clientId } = (await regRes.json()) as { client_id: string };

  // 4. GET /authorize renders branded card + auto-close script
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const authzQuery = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: loopbackRedirect,
    scope: 'openid profile email offline_access mail.read mail.manage mail.send mail.delete',
    state: 'desktop-loopback',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${ORIGIN}/mcp`,
  });
  const authzPath = `/authorize?${authzQuery}`;
  const pageRes = await app.fetch(authzPath);
  assert.equal(pageRes.status, 200);
  const csp = pageRes.headers.get('Content-Security-Policy') ?? '';
  assert.match(csp, /script-src 'nonce-[^']+'/);
  assert.match(csp, /connect-src 'self'/);
  const html = await pageRes.text();
  assert.match(html, /X-OAuth-Fetch/);
  assert.match(html, /window\.close\(\)/);
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1]?.replace(
    /&#(\d+);/g,
    (_, code) => String.fromCharCode(Number(code)),
  );
  assert.ok(handle);
  const cookie = pageRes.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ');

  // 5. Wrong password via X-OAuth-Fetch returns 400 JSON without consuming handle
  const badForm = new URLSearchParams({
    handle: handle!,
    email: 'admin@petermolgaard.com',
    appPassword: 'wrongpasswordxxxx',
    decision: 'approve',
    scope: 'mail.read',
  });
  const badSubmit = await app.fetch(authzPath, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-OAuth-Fetch': '1',
      Cookie: cookie,
    },
    body: badForm,
  });
  assert.equal(badSubmit.status, 400);
  const badJson = (await badSubmit.json()) as { ok: boolean; error?: string };
  assert.equal(badJson.ok, false);
  assert.match(badJson.error ?? '', /Gmail did not accept/);

  // 6. Valid password via X-OAuth-Fetch returns 200 JSON { ok: true, redirectTo, email }
  const goodForm = new URLSearchParams({
    handle: handle!,
    email: 'admin@petermolgaard.com',
    appPassword: APP_PASSWORD_B,
    decision: 'approve',
  });
  for (const s of ['offline_access', 'mail.read', 'mail.manage', 'mail.send', 'mail.delete']) {
    goodForm.append('scope', s);
  }
  const goodSubmit = await app.fetch(authzPath, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-OAuth-Fetch': '1',
      Cookie: cookie,
    },
    body: goodForm,
  });
  assert.equal(goodSubmit.status, 200);
  const goodJson = (await goodSubmit.json()) as { ok: boolean; redirectTo: string; email: string };
  assert.equal(goodJson.ok, true);
  assert.equal(goodJson.email, 'admin@petermolgaard.com');
  const cbUrl = new URL(goodJson.redirectTo);
  assert.equal(`${cbUrl.origin}${cbUrl.pathname}`, loopbackRedirect);
  assert.equal(cbUrl.searchParams.get('state'), 'desktop-loopback');
  const code = cbUrl.searchParams.get('code');
  assert.ok(code);

  // 7. Token exchange succeeds and serves MCP on canonical bare origin
  const tokRes = await app.fetch('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: loopbackRedirect,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${ORIGIN}/mcp`,
    }),
  });
  assert.equal(tokRes.status, 200);
  const tokJson = (await tokRes.json()) as { access_token: string; id_token?: string };
  assert.ok(tokJson.access_token);
  assert.ok(tokJson.id_token);

  const mcpInit = await app.fetch('/', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokJson.access_token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(mcpInit.status, 200);
  const mcpBody = (await mcpInit.json()) as { result?: { serverInfo?: { name?: string } } };
  assert.equal(mcpBody.result?.serverInfo?.name, '@xtnd-dynamics/mcp-gmail');
});
