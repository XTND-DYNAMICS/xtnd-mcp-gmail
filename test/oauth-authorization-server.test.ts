import { strict as assert } from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createWorker } from '../src/worker/index.js';
import type { WorkerEnv } from '../src/types.js';

/** In-memory KV with the subset of the Workers KV API the provider and the vault use. */
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
      const keys = [...store.keys()].filter((name) => name.startsWith(options.prefix ?? '')).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: '' };
    },
  };
}

const ORIGIN = 'https://gmail.mcp.xgi.io';
const RESOURCE = `${ORIGIN}/`;
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const MAILBOX = 'pam@example.com';
const APP_PASSWORD = 'abcdefghijklmnop';
const API_KEY = 'api-key-for-oauth-tests';

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
    API_KEYS_SHA256: createHash('sha256').update(API_KEY).digest('hex'),
  } as unknown as WorkerEnv;
  const verified: string[] = [];
  const worker = createWorker({
    verifyMailbox: async (credentials) => {
      verified.push(credentials.email);
      if (credentials.appPassword !== APP_PASSWORD) throw new Error('Gmail rejected the login');
    },
  });
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const fetch = (path: string, init?: RequestInit) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
  return { kv, env, fetch, verified };
}

const base64url = (buffer: Buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function initialize(token: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  };
}

function cookiesFrom(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
}

/** Runs the whole connector flow the way ChatGPT does: discovery, DCR, /authorize, PKCE token exchange. */
async function connect(app: ReturnType<typeof setup>, appPassword = APP_PASSWORD) {
  const registration = await app.fetch('/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'ChatGPT',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  assert.equal(registration.status, 201, await registration.clone().text());
  const { client_id: clientId } = await registration.json() as { client_id: string };

  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: 'mail.read mail.manage mail.send mail.delete',
    state: 'state-123',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE,
  });
  const authorizePath = `/authorize?${query}`;

  const consentPage = await app.fetch(authorizePath);
  assert.equal(consentPage.status, 200);
  assert.equal(consentPage.headers.get('X-Frame-Options'), 'DENY');
  const html = await consentPage.text();
  assert.match(html, /ChatGPT/);
  assert.match(html, /chatgpt\.com/);
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(handle, 'the consent page carries a handle');
  const cookie = cookiesFrom(consentPage);

  const form = new URLSearchParams({ handle: handle!.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))), email: MAILBOX, appPassword, decision: 'approve' });
  for (const scope of ['mail.read', 'mail.manage', 'mail.send', 'mail.delete']) form.append('scope', scope);
  const submitted = await app.fetch(authorizePath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: form,
  });
  return { submitted, clientId, verifier, authorizePath, cookie, handle: handle! };
}

async function exchange(app: ReturnType<typeof setup>, location: string, clientId: string, verifier: string) {
  const redirect = new URL(location);
  assert.equal(`${redirect.origin}${redirect.pathname}`, REDIRECT);
  assert.equal(redirect.searchParams.get('state'), 'state-123');
  const code = redirect.searchParams.get('code');
  assert.ok(code);
  const token = await app.fetch('/oauth/token', {
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
  assert.equal(token.status, 200, await token.clone().text());
  return await token.json() as { access_token: string; refresh_token?: string; scope?: string };
}

test('discovery: protected-resource and authorization-server metadata are published', async () => {
  const app = setup();
  const resource = await app.fetch('/.well-known/oauth-protected-resource');
  assert.equal(resource.status, 200);
  const resourceBody = await resource.json() as { resource: string; authorization_servers: string[] };
  assert.equal(resourceBody.resource, RESOURCE);
  assert.deepEqual(resourceBody.authorization_servers, [ORIGIN]);

  const server = await app.fetch('/.well-known/oauth-authorization-server');
  assert.equal(server.status, 200);
  const serverBody = await server.json() as Record<string, unknown>;
  assert.equal(serverBody.authorization_endpoint, `${ORIGIN}/authorize`);
  assert.equal(serverBody.token_endpoint, `${ORIGIN}/oauth/token`);
  assert.equal(serverBody.registration_endpoint, `${ORIGIN}/oauth/register`);
  assert.deepEqual(serverBody.code_challenge_methods_supported, ['S256']);
});

test('an unauthenticated MCP request is challenged with the resource metadata URL', async () => {
  const app = setup();
  const response = await app.fetch('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 401);
  assert.match(response.headers.get('WWW-Authenticate') ?? '', /resource_metadata="https:\/\/gmail\.mcp\.xgi\.io\/\.well-known\/oauth-protected-resource/);
});

test('full connector flow: sign in with an App Password, get tokens, call MCP, mailbox is linked', async () => {
  const app = setup();
  const { submitted, clientId, verifier } = await connect(app);
  assert.equal(submitted.status, 302, await submitted.clone().text());
  assert.deepEqual(app.verified, [MAILBOX]);

  const tokens = await exchange(app, submitted.headers.get('Location')!, clientId, verifier);
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token, 'a refresh token keeps the connector connected');

  const mcp = await app.fetch('/', initialize(tokens.access_token));
  assert.equal(mcp.status, 200);
  const body = await mcp.json() as { result?: { serverInfo?: { name?: string } } };
  assert.equal(body.result?.serverInfo?.name, '@xtnd-dynamics/mcp-gmail');

  const status = await app.fetch('/api/accounts/status', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { linked: true, vaultAvailable: true, email: MAILBOX });

  // The App Password is stored sealed, never in clear.
  const stored = [...app.kv.store.values()].join('\n');
  assert.equal(stored.includes(APP_PASSWORD), false);
});

test('a wrong App Password re-renders the form, stores nothing and issues no code', async () => {
  const app = setup();
  const { submitted } = await connect(app, 'wrong-password-xx');
  assert.equal(submitted.status, 400);
  assert.match(await submitted.text(), /Gmail did not accept that address and App Password/);
  assert.equal([...app.kv.store.keys()].some((key) => key.startsWith('mailbox:')), false);
  assert.equal([...app.kv.store.keys()].some((key) => key.startsWith('grant:')), false);
});

test('repeated failures lock the mailbox sign-in without asking Gmail again', async () => {
  const app = setup();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { submitted } = await connect(app, 'wrong-password-xx');
    assert.equal(submitted.status, 400);
  }
  app.verified.length = 0;
  const { submitted } = await connect(app, APP_PASSWORD);
  assert.equal(submitted.status, 400);
  assert.match(await submitted.text(), /Too many failed sign-ins/);
  assert.deepEqual(app.verified, [], 'Gmail is not contacted while the mailbox is locked');
});

test('Deny returns access_denied to the client', async () => {
  const app = setup();
  const { authorizePath, cookie, handle } = await connect(app, 'wrong-password-xx');
  const denied = await app.fetch(authorizePath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ handle: handle.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))), decision: 'deny' }),
  });
  assert.equal(denied.status, 302);
  assert.equal(new URL(denied.headers.get('Location')!).searchParams.get('error'), 'access_denied');
});

test('API keys keep working beside OAuth', async () => {
  const app = setup();
  const response = await app.fetch('/', initialize(API_KEY));
  assert.equal(response.status, 200);
});

test('the browser landing page is still served at the origin', async () => {
  const app = setup();
  const response = await app.fetch('/', { headers: { Accept: 'text/html' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type') ?? '', /text\/html/);
});
