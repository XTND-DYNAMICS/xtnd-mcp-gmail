/**
 * Worker Authentication Utilities
 */

import type { WorkerEnv, WorkerSecretBinding } from '../types.js';

export const DEFAULT_MAIL_SCOPES = [
  'mail.read',
  'mail.manage',
  'mail.send',
  'mail.delete',
] as const;

export interface AuthenticatedPrincipal {
  /** Stable, collision-resistant caller identity. Never derived from untrusted KV metadata. */
  subject: string;
  /** SHA-256 hash of the presented bearer token. The raw token is never returned. */
  tokenHash: string;
  scopes?: string[];
  source?: 'kv' | 'env' | 'oauth';
}

export type AuthenticationResult =
  | { authenticated: true; principal: AuthenticatedPrincipal }
  | { authenticated: false; error: string; status: 401 | 503 };

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const MAX_BEARER_TOKEN_LENGTH = 16_384;
const MAX_INTROSPECTION_RESPONSE_BYTES = 65_536;
const INTROSPECTION_TIMEOUT_MS = 5_000;

type OAuthConfigurationState = 'none' | 'partial' | 'complete';

interface OAuthConfiguration {
  authorizationServer: string;
  introspectionUrl: string;
  clientId: string;
  clientSecret: string;
  audience: string;
}

class OAuthTokenRejectedError extends Error {
  constructor() {
    super('OAuth token rejected');
    this.name = 'OAuthTokenRejectedError';
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Bytes(text: string): Promise<Uint8Array> {
  const message = new TextEncoder().encode(text);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', message));
}

export async function sha256Hex(text: string): Promise<string> {
  return bytesToHex(await sha256Bytes(text));
}

function parseSha256Hex(value: string): Uint8Array | null {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    return null;
  }

  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function fixedSizeHashEqual(actual: Uint8Array, expected: Uint8Array): boolean {
  if (actual.byteLength !== 32 || expected.byteLength !== 32) {
    return false;
  }

  if (typeof (crypto.subtle as any)?.timingSafeEqual === 'function') {
    return (crypto.subtle as any).timingSafeEqual(actual, expected);
  }

  // Node's Web Crypto does not currently expose timingSafeEqual. Both inputs
  // are fixed-size SHA-256 values, so a full XOR pass is a safe test fallback.
  let difference = 0;
  for (let index = 0; index < actual.byteLength; index += 1) {
    difference |= actual[index] ^ expected[index];
  }
  return difference === 0;
}

function defaultScopes(): string[] {
  return [...DEFAULT_MAIL_SCOPES];
}

function parseKvScopes(record: string): string[] {
  let metadata: unknown;
  try {
    metadata = JSON.parse(record);
  } catch {
    return [];
  }

  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    !('scopes' in metadata) ||
    !Array.isArray(metadata.scopes)
  ) {
    return [];
  }

  const scopes: string[] = [];
  for (const scope of metadata.scopes) {
    if (typeof scope !== 'string' || scope.trim().length === 0) {
      return [];
    }
    const normalizedScope = scope.trim();
    if (!scopes.includes(normalizedScope)) {
      scopes.push(normalizedScope);
    }
  }
  return scopes;
}

function createPrincipal(
  tokenHash: string,
  scopes: string[],
  source: 'kv' | 'env'
): AuthenticatedPrincipal {
  return {
    subject: tokenHash,
    tokenHash,
    scopes,
    source,
  };
}

function isConfiguredValue(value: unknown): boolean {
  return typeof value === 'string'
    ? value.trim().length > 0
    : typeof value === 'object'
      && value !== null
      && 'get' in value
      && typeof value.get === 'function';
}

function oauthConfigurationState(env: WorkerEnv): OAuthConfigurationState {
  const values = [
    env.OAUTH_AUTHORIZATION_SERVER,
    env.OAUTH_INTROSPECTION_URL,
    env.OAUTH_CLIENT_ID,
    env.OAUTH_CLIENT_SECRET,
    env.OAUTH_AUDIENCE,
  ];
  const present = values.filter(isConfiguredValue).length;
  if (present === 0) return 'none';
  return present === values.length ? 'complete' : 'partial';
}

/** True only when every field required for RFC 7662 validation is present. */
export function isOAuthConfigured(env: WorkerEnv): boolean {
  return oauthConfigurationState(env) === 'complete';
}

async function resolveSecretValue(
  value: string | WorkerSecretBinding | undefined,
): Promise<string> {
  if (typeof value === 'string') return value;
  if (value && typeof value.get === 'function') {
    return await value.get();
  }
  return '';
}

function secureUrl(value: string, fieldName: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${fieldName} is not a valid URL.`);
  }
  if (
    url.protocol !== 'https:'
    || url.username.length > 0
    || url.password.length > 0
    || url.hash.length > 0
  ) {
    throw new Error(`${fieldName} must be an HTTPS URL without credentials or a fragment.`);
  }
  return value;
}

async function loadOAuthConfiguration(env: WorkerEnv): Promise<OAuthConfiguration> {
  const authorizationServer = secureUrl(
    String(env.OAUTH_AUTHORIZATION_SERVER ?? '').trim(),
    'OAUTH_AUTHORIZATION_SERVER',
  );
  const introspectionUrl = secureUrl(
    String(env.OAUTH_INTROSPECTION_URL ?? '').trim(),
    'OAUTH_INTROSPECTION_URL',
  );
  const clientId = (await resolveSecretValue(env.OAUTH_CLIENT_ID)).trim();
  const clientSecret = await resolveSecretValue(env.OAUTH_CLIENT_SECRET);
  const audience = secureUrl(
    String(env.OAUTH_AUDIENCE ?? '').trim(),
    'OAUTH_AUDIENCE',
  );

  if (!clientId || !clientSecret || !audience) {
    throw new Error('OAuth verifier credentials or audience are empty.');
  }
  if (clientId.includes(':') || /[\u0000-\u001f\u007f]/.test(clientId + clientSecret + audience)) {
    throw new Error('OAuth verifier configuration contains unsupported characters.');
  }

  return { authorizationServer, introspectionUrl, clientId, clientSecret, audience };
}

function utf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function readLimitedText(response: Response): Promise<string> {
  const declaredLength = response.headers.get('Content-Length');
  if (declaredLength && Number(declaredLength) > MAX_INTROSPECTION_RESPONSE_BYTES) {
    throw new Error('OAuth introspection response is too large.');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_INTROSPECTION_RESPONSE_BYTES) {
      try { await reader.cancel(); } catch {}
      throw new Error('OAuth introspection response is too large.');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function validSubject(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validatedScopes(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value !== 'string') throw new OAuthTokenRejectedError();
  return [...new Set(value.split(/\s+/).map((scope) => scope.trim()).filter(Boolean))];
}

function audienceMatches(value: unknown, expected: string): boolean {
  if (typeof value === 'string') return value === expected;
  return Array.isArray(value)
    && value.every((audience) => typeof audience === 'string')
    && value.includes(expected);
}

async function introspectOAuthToken(
  token: string,
  tokenHash: string,
  env: WorkerEnv,
  fetchImpl: FetchLike,
): Promise<AuthenticatedPrincipal> {
  const config = await loadOAuthConfiguration(env);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INTROSPECTION_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(config.introspectionUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${utf8Base64(`${config.clientId}:${config.clientSecret}`)}`,
        'Cache-Control': 'no-store',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ token, token_type_hint: 'access_token' }),
      redirect: 'error',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error('OAuth introspection endpoint rejected the verification request.');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await readLimitedText(response));
  } catch (error) {
    if (error instanceof OAuthTokenRejectedError) throw error;
    throw new Error('OAuth introspection endpoint returned an invalid response.');
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('OAuth introspection endpoint returned an invalid response.');
  }

  const result = payload as Record<string, unknown>;
  const now = Date.now() / 1_000;
  if (
    result.active !== true
    || !validSubject(result.sub)
    || !audienceMatches(result.aud, config.audience)
    || typeof result.exp !== 'number'
    || !Number.isFinite(result.exp)
    || result.exp <= now
    || (result.nbf !== undefined
      && (typeof result.nbf !== 'number' || !Number.isFinite(result.nbf) || result.nbf > now))
    || (result.iss !== undefined && result.iss !== config.authorizationServer)
  ) {
    throw new OAuthTokenRejectedError();
  }

  const scopes = validatedScopes(result.scope);
  return {
    subject: await sha256Hex(`oauth\0${config.authorizationServer}\0${result.sub}`),
    tokenHash,
    scopes,
    source: 'oauth',
  };
}

export async function authenticateRequest(
  request: Request,
  env: WorkerEnv,
  fetchImpl: FetchLike = fetch,
): Promise<AuthenticationResult> {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return {
      authenticated: false,
      error: 'Missing or malformed Authorization header. Expected Bearer token.',
      status: 401,
    };
  }

  const token = authHeader.slice(7).trim();
  if (!token || token.length > MAX_BEARER_TOKEN_LENGTH) {
    return { authenticated: false, error: 'Invalid bearer token.', status: 401 };
  }

  const tokenHashBytes = await sha256Bytes(token);
  const tokenHash = bytesToHex(tokenHashBytes);

  // 1. Check KV store for apikey:<hash>
  if (env.KV) {
    let record: string | null;
    try {
      record = await env.KV.get(`apikey:${tokenHash}`);
    } catch {
      return {
        authenticated: false,
        error: 'Bearer token verification is unavailable.',
        status: 503,
      };
    }
    if (record !== null) {
      return {
        authenticated: true,
        principal: createPrincipal(tokenHash, parseKvScopes(record), 'kv'),
      };
    }
  }

  // 2. Check API_KEYS_SHA256 env variable fallback
  if (env.API_KEYS_SHA256) {
    let matchesAllowedHash = false;
    for (const allowedHash of env.API_KEYS_SHA256.split(',')) {
      const allowedHashBytes = parseSha256Hex(allowedHash);
      if (allowedHashBytes !== null) {
        matchesAllowedHash = fixedSizeHashEqual(tokenHashBytes, allowedHashBytes) || matchesAllowedHash;
      }
    }
    if (matchesAllowedHash) {
      return {
        authenticated: true,
        principal: createPrincipal(tokenHash, defaultScopes(), 'env'),
      };
    }
  }

  const oauthState = oauthConfigurationState(env);
  if (oauthState === 'partial') {
    return {
      authenticated: false,
      error: 'OAuth token verification is unavailable.',
      status: 503,
    };
  }
  if (oauthState === 'complete') {
    try {
      return {
        authenticated: true,
        principal: await introspectOAuthToken(token, tokenHash, env, fetchImpl),
      };
    } catch (error) {
      if (error instanceof OAuthTokenRejectedError) {
        return { authenticated: false, error: 'Invalid bearer token.', status: 401 };
      }
      return {
        authenticated: false,
        error: 'OAuth token verification is unavailable.',
        status: 503,
      };
    }
  }

  return { authenticated: false, error: 'Invalid bearer token.', status: 401 };
}
