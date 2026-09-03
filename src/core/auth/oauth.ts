/**
 * Google OAuth2 token operations.
 *
 * Runtime boundary: this module uses only `fetch` and Web Crypto, so it runs
 * unchanged in Node and in the Cloudflare Worker. The interactive consent
 * flow, which needs a loopback listener and a browser, lives in `loopback.ts`
 * and is imported by the CLI only.
 *
 * Security boundary: no function here logs, and none returns the client secret
 * or refresh token in an error message. Callers must not print the returned
 * token objects.
 */

import { parseScopeString } from './scopes.js';

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOCATION_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

/** Refresh this long before nominal expiry so in-flight calls never race it. */
const EXPIRY_SKEW_MS = 60_000;

export interface AuthorizationUrlOptions {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  codeChallenge: string;
  state: string;
  /** Pre-fills the account chooser. Does not restrict which account consents. */
  loginHint?: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: string[];
  tokenType: string;
}

export class OAuthError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.name = 'OAuthError';
    this.status = options.status;
    this.code = options.code;
  }
}

/** Build the consent URL for the installed-application flow. */
export function buildAuthorizationUrl(options: AuthorizationUrlOptions): string {
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', options.scopes.join(' '));
  url.searchParams.set('code_challenge', options.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', options.state);
  // `offline` is what yields a refresh token; `consent` forces Google to
  // re-issue one even when the user has approved this client before.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  if (options.loginHint) {
    url.searchParams.set('login_hint', options.loginHint);
  }
  return url.toString();
}

/** Exchange an authorization code for an access and refresh token pair. */
export async function exchangeAuthorizationCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenSet> {
  return requestToken({
    grant_type: 'authorization_code',
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
  });
}

/** Trade a refresh token for a fresh access token. */
export async function refreshAccessToken(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<TokenSet> {
  return requestToken({
    grant_type: 'refresh_token',
    client_id: params.clientId,
    client_secret: params.clientSecret,
    refresh_token: params.refreshToken,
  });
}

/**
 * Revoke a refresh token at Google. Used by `mcp-gmail accounts remove` so a
 * deleted local profile does not leave a live grant behind.
 */
export async function revokeToken(token: string): Promise<void> {
  const response = await fetch(REVOCATION_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  });

  // Google answers 200 for a successful revoke and 400 for a token that was
  // already invalid. Both leave the caller in the intended state.
  if (!response.ok && response.status !== 400) {
    throw new OAuthError(`Token revocation failed with status ${response.status}.`, {
      status: response.status,
    });
  }
}

/** True when the cached access token is missing or within the refresh skew. */
export function accessTokenIsStale(expiresAt: number | undefined): boolean {
  if (!expiresAt) return true;
  return Date.now() >= expiresAt - EXPIRY_SKEW_MS;
}

async function requestToken(form: Record<string, string>): Promise<TokenSet> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    const code = typeof payload.error === 'string' ? payload.error : undefined;
    const description = typeof payload.error_description === 'string'
      ? payload.error_description
      : `HTTP ${response.status}`;

    if (code === 'invalid_grant') {
      throw new OAuthError(
        'Google rejected the stored refresh token. It was revoked, expired, or the account password '
        + 'changed. Re-run "mcp-gmail setup" for this profile.',
        { status: response.status, code },
      );
    }

    throw new OAuthError(`Google token request failed: ${description}`, {
      status: response.status,
      code,
    });
  }

  const accessToken = payload.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new OAuthError('Google token response did not contain an access token.');
  }

  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 3_600;

  return {
    accessToken,
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : undefined,
    expiresAt: Date.now() + expiresIn * 1_000,
    scopes: parseScopeString(typeof payload.scope === 'string' ? payload.scope : undefined),
    tokenType: typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
  };
}

/** Generate a PKCE verifier and its S256 challenge using Web Crypto. */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

/** Opaque value binding the consent redirect to the request that started it. */
export function createStateToken(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(24)));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
