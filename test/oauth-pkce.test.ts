import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';
import {
  OAuthError,
  accessTokenIsStale,
  buildAuthorizationUrl,
  createPkcePair,
  createStateToken,
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeToken,
} from '../src/core/auth/oauth.js';

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const CLIENT_SECRET = 'client-secret-must-not-leak';
const REFRESH_TOKEN = 'refresh-token-must-not-leak';

interface RecordedCall {
  url: string;
  method: string | undefined;
  body: URLSearchParams;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Replace fetch with one canned answer and record what was sent. */
function stubFetch(status: number, body: unknown): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      body: new URLSearchParams(String(init?.body ?? '')),
    });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

test('PKCE: the verifier is 32 random bytes, base64url, and the challenge is its S256 digest', async () => {
  const { verifier, challenge } = await createPkcePair();

  assert.equal(verifier.length, 43);
  assert.match(verifier, BASE64URL);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
});

test('PKCE: every pair and every state token is new', async () => {
  const verifiers = new Set<string>();
  const states = new Set<string>();
  for (let index = 0; index < 50; index += 1) {
    verifiers.add((await createPkcePair()).verifier);
    states.add(createStateToken());
  }
  assert.equal(verifiers.size, 50);
  assert.equal(states.size, 50);
  for (const state of states) {
    assert.equal(state.length, 32);
    assert.match(state, BASE64URL);
  }
});

test('the consent URL asks for S256 PKCE, binds the state and never carries the client secret', () => {
  const url = new URL(buildAuthorizationUrl({
    clientId: 'client-id',
    redirectUri: 'http://127.0.0.1:53682',
    scopes: ['scope-a', 'scope-b'],
    codeChallenge: 'challenge-value',
    state: 'state-value',
  }));

  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-value');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'state-value');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:53682');
  assert.equal(url.searchParams.get('scope'), 'scope-a scope-b');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.equal(url.searchParams.has('code_verifier'), false);
  assert.equal(url.searchParams.has('login_hint'), false);
});

test('the code exchange sends the verifier and redirect URI in the POST body, not the URL', async () => {
  const calls = stubFetch(200, {
    access_token: 'access-token',
    refresh_token: 'new-refresh-token',
    expires_in: 3599,
    scope: 'scope-a  scope-b',
    token_type: 'Bearer',
  });
  const before = Date.now();

  const tokens = await exchangeAuthorizationCode({
    clientId: 'client-id',
    clientSecret: CLIENT_SECRET,
    code: 'authorization-code',
    codeVerifier: 'the-verifier',
    redirectUri: 'http://127.0.0.1:53682',
  });

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, 'https://oauth2.googleapis.com/token');
  assert.equal(call.method, 'POST');
  assert.equal(call.body.get('grant_type'), 'authorization_code');
  assert.equal(call.body.get('code'), 'authorization-code');
  assert.equal(call.body.get('code_verifier'), 'the-verifier');
  assert.equal(call.body.get('redirect_uri'), 'http://127.0.0.1:53682');
  assert.equal(new URL(call.url).search, '');

  assert.equal(tokens.accessToken, 'access-token');
  assert.equal(tokens.refreshToken, 'new-refresh-token');
  assert.deepEqual(tokens.scopes, ['scope-a', 'scope-b']);
  assert.ok(tokens.expiresAt >= before + 3_599_000);
});

test('a rejected refresh token gives a re-consent instruction that names neither secret', async () => {
  const calls = stubFetch(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });

  await assert.rejects(
    refreshAccessToken({ clientId: 'client-id', clientSecret: CLIENT_SECRET, refreshToken: REFRESH_TOKEN }),
    (error: unknown) => {
      assert.ok(error instanceof OAuthError);
      assert.equal(error.code, 'invalid_grant');
      assert.equal(error.status, 400);
      assert.match(error.message, /mcp-gmail setup/);
      assert.doesNotMatch(error.message, new RegExp(`${CLIENT_SECRET}|${REFRESH_TOKEN}`));
      return true;
    },
  );
  assert.equal(calls[0].body.get('grant_type'), 'refresh_token');
});

test('token request failures never echo the request, whatever the response body', async () => {
  for (const body of [{ error: 'invalid_client' }, 'not json at all', {}]) {
    stubFetch(401, body);
    await assert.rejects(
      refreshAccessToken({ clientId: 'client-id', clientSecret: CLIENT_SECRET, refreshToken: REFRESH_TOKEN }),
      (error: unknown) => {
        assert.ok(error instanceof OAuthError);
        assert.doesNotMatch(error.message, new RegExp(`${CLIENT_SECRET}|${REFRESH_TOKEN}`));
        return true;
      },
    );
  }
});

test('a successful response without an access token is refused', async () => {
  stubFetch(200, { refresh_token: 'only-a-refresh-token' });
  await assert.rejects(
    refreshAccessToken({ clientId: 'client-id', clientSecret: CLIENT_SECRET, refreshToken: REFRESH_TOKEN }),
    /did not contain an access token/,
  );
});

test('revocation posts the token in the body; an already-invalid token is fine, a server error is not', async () => {
  const calls = stubFetch(200, {});
  await revokeToken(REFRESH_TOKEN);
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/revoke');
  assert.equal(calls[0].body.get('token'), REFRESH_TOKEN);
  assert.equal(new URL(calls[0].url).search, '');

  stubFetch(400, { error: 'invalid_token' });
  await revokeToken(REFRESH_TOKEN);

  stubFetch(503, {});
  await assert.rejects(revokeToken(REFRESH_TOKEN), (error: unknown) => {
    assert.ok(error instanceof OAuthError);
    assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, new RegExp(REFRESH_TOKEN));
    return true;
  });
});

test('an access token counts as stale a minute before it expires', () => {
  const now = Date.now();
  assert.equal(accessTokenIsStale(undefined), true);
  assert.equal(accessTokenIsStale(now - 1_000), true);
  assert.equal(accessTokenIsStale(now + 30_000), true);
  assert.equal(accessTokenIsStale(now + 120_000), false);
});
