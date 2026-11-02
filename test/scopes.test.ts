import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  DEFAULT_SCOPES,
  GMAIL_SCOPES,
  MissingScopeError,
  PERMANENT_DELETE_SCOPES,
  assertScope,
  grantSatisfies,
  parseScopeString,
} from '../src/core/auth/scopes.js';
import { GmailClient } from '../src/core/client.js';
import type { GmailCredentials } from '../src/types.js';

test('the default grant never includes full mailbox access; permanent delete asks for it alone', () => {
  assert.equal(DEFAULT_SCOPES.includes(GMAIL_SCOPES.full), false);
  assert.deepEqual([...PERMANENT_DELETE_SCOPES], [GMAIL_SCOPES.full]);
});

test('full mailbox access satisfies every scope', () => {
  for (const scope of Object.values(GMAIL_SCOPES)) {
    assert.equal(grantSatisfies([GMAIL_SCOPES.full], scope), true, scope);
  }
});

test('only the documented supersets stand in for a scope', () => {
  assert.equal(grantSatisfies([GMAIL_SCOPES.modify], GMAIL_SCOPES.readonly), true);
  assert.equal(grantSatisfies([GMAIL_SCOPES.compose], GMAIL_SCOPES.readonly), true);
  assert.equal(grantSatisfies([GMAIL_SCOPES.compose], GMAIL_SCOPES.send), true);

  assert.equal(grantSatisfies([GMAIL_SCOPES.send], GMAIL_SCOPES.compose), false);
  assert.equal(grantSatisfies([GMAIL_SCOPES.readonly], GMAIL_SCOPES.modify), false);
  assert.equal(grantSatisfies([GMAIL_SCOPES.modify], GMAIL_SCOPES.labels), false);
  assert.equal(grantSatisfies([GMAIL_SCOPES.labels], GMAIL_SCOPES.settingsBasic), false);
  assert.equal(grantSatisfies([GMAIL_SCOPES.settingsBasic], GMAIL_SCOPES.settingsSharing), false);
  assert.equal(grantSatisfies([...DEFAULT_SCOPES], GMAIL_SCOPES.full), false);
  assert.equal(grantSatisfies([], GMAIL_SCOPES.readonly), false);
});

test('a scope is matched exactly, never by prefix or case', () => {
  assert.equal(grantSatisfies([`${GMAIL_SCOPES.modify}.extra`], GMAIL_SCOPES.modify), false);
  assert.equal(grantSatisfies([GMAIL_SCOPES.modify.toUpperCase()], GMAIL_SCOPES.modify), false);
  assert.equal(grantSatisfies(['https://mail.google.com'], GMAIL_SCOPES.readonly), false);
});

test('a missing scope fails closed with the scope and a re-consent instruction', () => {
  assert.doesNotThrow(() => assertScope([GMAIL_SCOPES.modify], GMAIL_SCOPES.readonly, 'reading mail'));
  assert.throws(
    () => assertScope([GMAIL_SCOPES.readonly], GMAIL_SCOPES.send, 'sending mail'),
    (error: unknown) => {
      assert.ok(error instanceof MissingScopeError);
      assert.equal(error.required, GMAIL_SCOPES.send);
      assert.match(error.message, /sending mail/);
      assert.match(error.message, /mcp-gmail setup/);
      return true;
    },
  );
});

test('scope strings from a token response split on any whitespace', () => {
  assert.deepEqual(parseScopeString(undefined), []);
  assert.deepEqual(parseScopeString(''), []);
  assert.deepEqual(parseScopeString(' a  b\tc\nd '), ['a', 'b', 'c', 'd']);
});

function client(scopes: string[], allowPermanentDelete: boolean) {
  const requests: string[] = [];
  const credentials: GmailCredentials = {
    email: 'owner@example.com',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'refresh-token',
    accessToken: 'access-token',
    accessTokenExpiresAt: Date.now() + 3_600_000,
    scopes,
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { gmail: new GmailClient(credentials, { fetchImpl, allowPermanentDelete }), requests };
}

test('permanent delete is refused before any request unless the profile opted in', async () => {
  const { gmail, requests } = client([GMAIL_SCOPES.full], false);
  await assert.rejects(gmail.deleteMessagePermanently('abc'), /Permanent deletion is disabled/);
  await assert.rejects(gmail.deleteThreadPermanently('abc'), /Permanent deletion is disabled/);
  assert.deepEqual(requests, []);
});

test('permanent delete is refused before any request without full mailbox access', async () => {
  const { gmail, requests } = client([...DEFAULT_SCOPES], true);
  await assert.rejects(gmail.deleteMessagePermanently('abc'), MissingScopeError);
  await assert.rejects(gmail.deleteThreadPermanently('abc'), MissingScopeError);
  assert.deepEqual(requests, []);
});

test('permanent delete goes ahead only with the opt-in and full mailbox access', async () => {
  const { gmail, requests } = client([GMAIL_SCOPES.full], true);
  await gmail.deleteMessagePermanently('abc');
  assert.equal(requests.length, 1);
  assert.match(requests[0], /^DELETE .*\/users\/me\/messages\/abc$/);
});
