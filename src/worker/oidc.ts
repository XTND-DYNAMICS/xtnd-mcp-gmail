/**
 * OpenID Connect (OIDC Core 1.0) discovery, JWKS, signed `id_token` issuance,
 * and `/oauth/userinfo` for multi-account OAuth connectors (such as ChatGPT /
 * Codex "Connected accounts -> Connect another account").
 *
 * The P-256 (`ES256`) signing keypair is generated with WebCrypto and stored
 * sealed with AES-256-GCM under `CREDENTIALS_MASTER_KEY` in `OAUTH_KV` — never
 * hardcoded in source or defaulted (AGENTS.md §0).
 */

import { getOAuthApi, type OAuthProvider, type OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import { brandIconsForOrigin } from '../mcp/brand-icons.js';
import type { WorkerEnv } from '../types.js';
import { authenticateRequest } from './auth.js';
import { CredentialResolutionError, resolveMailboxCredentials } from './credential-resolver.js';
import { CredentialVaultError, decodeMasterKey } from './credential-vault.js';
import type { OAuthGrantProps } from './oauth-authorize.js';

const SIGNING_KEY_KV_KEY = 'oidc:signing-key:v1';
const SIGNING_KEY_AAD = 'xtnd-mcp-gmail/oidc-signing-key/v1';
const GCM_IV_BYTES = 12;

interface SealedSigningKeyRecordV1 {
  version: 1;
  algorithm: 'AES-256-GCM';
  kid: string;
  publicJwk: JsonWebKey;
  iv: string;
  ciphertext: string;
}

interface LoadedSigningKey {
  kid: string;
  publicJwk: Record<string, unknown>;
  privateKey: CryptoKey;
}

/** Per-isolate cache keyed by `${origin}:${kid}` so warm requests skip KV + importKey. */
let cachedSigningKey: { cacheKey: string; loaded: LoadedSigningKey } | null = null;

const OIDC_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

export interface ParsedAccountEndpoint {
  endpointPath: string;
  slug: string;
}

/**
 * Named multi-account MCP endpoint paths (`/account/<slug>` and `/accounts/<slug>`),
 * allowing desktop MCP hosts that store one OAuth token per server URL (such as
 * ChatGPT Desktop / Codex local plugins, Claude Desktop, and Cursor) to connect
 * multiple independent Gmail / Google Workspace mailboxes simultaneously.
 */
export function parseAccountEndpointPath(pathname: string): ParsedAccountEndpoint | null {
  const match = /^\/(accounts?)\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[2]).trim();
  } catch {
    return null;
  }
  if (!decoded || decoded === '.' || decoded === '..' || !/^[A-Za-z0-9._@+-]{1,64}$/.test(decoded)) {
    return null;
  }
  return {
    endpointPath: `/${match[1]}/${encodeURIComponent(decoded)}`,
    slug: decoded,
  };
}

export function normalizeMcpResourceAlias(
  rawResource: string,
  canonicalResource: string,
): { canonical: string; accountSlug?: string } | null {
  let parsed: URL;
  let canonicalUrl: URL;
  try {
    parsed = new URL(rawResource);
    canonicalUrl = new URL(canonicalResource);
  } catch {
    return null;
  }
  if (parsed.origin !== canonicalUrl.origin || parsed.username || parsed.password || parsed.hash) {
    return null;
  }
  if (parsed.pathname === '/' || parsed.pathname === '/mcp' || parsed.pathname === '/mcp/') {
    return { canonical: canonicalResource };
  }
  const account = parseAccountEndpointPath(parsed.pathname);
  if (account) {
    return { canonical: canonicalResource, accountSlug: account.slug };
  }
  return null;
}

export function isOidcRoutePath(pathname: string): boolean {
  return (
    isDiscoveryPath(pathname)
    || isProtectedResourcePath(pathname)
    || pathname === '/oauth/jwks.json'
    || pathname === '/oauth/jwks'
    || pathname === '/oauth/userinfo'
    || pathname === '/oauth/token'
  );
}

function isDiscoveryPath(pathname: string): boolean {
  return (
    pathname === '/.well-known/openid-configuration'
    || pathname.startsWith('/.well-known/openid-configuration/')
    || pathname === '/.well-known/oauth-authorization-server'
    || pathname.startsWith('/.well-known/oauth-authorization-server/')
  );
}

function isProtectedResourcePath(pathname: string): boolean {
  return (
    pathname === '/.well-known/oauth-protected-resource'
    || pathname.startsWith('/.well-known/oauth-protected-resource/')
  );
}

export async function handleOidcRequest(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
  resource: string,
  provider: OAuthProvider<WorkerEnv>,
  providerOptions: OAuthProviderOptions<WorkerEnv>,
): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (!isOidcRoutePath(pathname)) return null;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...OIDC_CORS_HEADERS, 'Cache-Control': 'no-store' },
    });
  }

  const origin = new URL(resource).origin;

  if (isProtectedResourcePath(pathname)) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return oidcJson({ error: 'method_not_allowed' }, 405, { Allow: 'GET, HEAD, OPTIONS' });
    }
    const prefix = '/.well-known/oauth-protected-resource';
    const rawSuffix = pathname === prefix || pathname === `${prefix}/` ? '' : pathname.slice(prefix.length);
    const isMcpAlias = rawSuffix === '/mcp' || rawSuffix === '/mcp/';
    const accountAlias = rawSuffix && !isMcpAlias ? parseAccountEndpointPath(rawSuffix) : null;
    if (rawSuffix !== '' && !isMcpAlias && !accountAlias) {
      return oidcJson({ error: 'not_found' }, 404);
    }

    const upstream = await provider.fetch(
      new Request(`${origin}${prefix}`, { method: 'GET' }),
      env,
      ctx,
    );
    if (!upstream.ok) return upstream;
    const base = (await upstream.json()) as Record<string, unknown>;
    const advertisedResource = accountAlias
      ? `${origin}${accountAlias.endpointPath}`
      : isMcpAlias
        ? `${origin}/mcp`
        : base.resource;
    const enriched: Record<string, unknown> = {
      ...base,
      resource: advertisedResource,
      resource_name: accountAlias ? `XMAIL | Gmail (${accountAlias.slug})` : 'XMAIL | Gmail',
      logo_uri: `${origin}/favicon.svg`,
      icons: brandIconsForOrigin(origin),
      resource_documentation: 'https://github.com/XTND-DYNAMICS/xtnd-mcp-gmail#readme',
    };
    const body = request.method === 'HEAD' ? null : JSON.stringify(enriched);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        ...OIDC_CORS_HEADERS,
      },
    });
  }

  if (isDiscoveryPath(pathname)) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return oidcJson({ error: 'method_not_allowed' }, 405, { Allow: 'GET, HEAD, OPTIONS' });
    }
    const upstream = await provider.fetch(
      new Request(`${origin}/.well-known/oauth-authorization-server`, { method: 'GET' }),
      env,
      ctx,
    );
    if (!upstream.ok) return upstream;
    const base = (await upstream.json()) as Record<string, unknown>;
    const enriched: Record<string, unknown> = {
      ...base,
      userinfo_endpoint: `${origin}/oauth/userinfo`,
      jwks_uri: `${origin}/oauth/jwks.json`,
      logo_uri: `${origin}/icon-192.png`,
      icons: brandIconsForOrigin(origin),
      service_documentation: 'https://github.com/XTND-DYNAMICS/xtnd-mcp-gmail#readme',
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['ES256'],
      claims_supported: ['sub', 'name', 'preferred_username', 'email', 'email_verified'],
    };
    const body = request.method === 'HEAD' ? null : JSON.stringify(enriched);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        ...OIDC_CORS_HEADERS,
      },
    });
  }

  if (pathname === '/oauth/jwks.json' || pathname === '/oauth/jwks') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return oidcJson({ error: 'method_not_allowed' }, 405, { Allow: 'GET, HEAD, OPTIONS' });
    }
    const signingKey = await loadOrCreateSigningKey(env, origin);
    const body = request.method === 'HEAD' ? null : JSON.stringify({ keys: [signingKey.publicJwk] });
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        ...OIDC_CORS_HEADERS,
      },
    });
  }

  if (pathname === '/oauth/userinfo') {
    return handleUserInfo(request, env, providerOptions);
  }

  if (pathname === '/oauth/token') {
    let grantType = '';
    let effectiveRequest = request;
    if (request.method === 'POST') {
      const contentType = request.headers.get('Content-Type') ?? '';
      if (contentType.includes('application/x-www-form-urlencoded')) {
        try {
          const rawBody = await request.clone().text();
          const params = new URLSearchParams(rawBody);
          grantType = params.get('grant_type') ?? '';
          const resources = params.getAll('resource');
          if (resources.length > 0) {
            let rewritten = false;
            const normalizedValues = resources.map((entry) => {
              const alias = normalizeMcpResourceAlias(entry, resource);
              if (alias && alias.canonical !== entry) {
                rewritten = true;
                return alias.canonical;
              }
              return entry;
            });
            if (rewritten) {
              params.delete('resource');
              for (const val of normalizedValues) params.append('resource', val);
              effectiveRequest = new Request(request.url, {
                method: request.method,
                headers: request.headers,
                body: params.toString(),
              });
            }
          }
        } catch {
          grantType = '';
        }
      }
    }

    const tokenResponse = await provider.fetch(effectiveRequest, env, ctx);
    if (
      request.method !== 'POST'
      || tokenResponse.status !== 200
      || !(tokenResponse.headers.get('Content-Type') ?? '').includes('application/json')
    ) {
      return tokenResponse;
    }

    const payload = (await tokenResponse.clone().json()) as Record<string, unknown>;
    const accessToken = typeof payload.access_token === 'string' ? payload.access_token : null;
    if (!accessToken) return tokenResponse;

    const oauthApi = getOAuthApi(providerOptions, env);
    const summary = await oauthApi.unwrapToken<OAuthGrantProps>(accessToken);
    const props = summary?.grant?.props;
    if (!summary || props?.source !== 'oauth-grant' || !props.email) {
      return tokenResponse;
    }

    const signingKey = await loadOrCreateSigningKey(env, origin);
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: origin,
      sub: summary.userId,
      aud: summary.grant.clientId,
      iat: now,
      exp: summary.expiresAt,
      email: props.email,
      email_verified: true,
      name: props.email,
      preferred_username: props.email,
      ...(grantType === 'authorization_code' && props.nonce ? { nonce: props.nonce } : {}),
    };
    const idToken = await signEs256Jwt(signingKey, claims);
    const headers = new Headers(tokenResponse.headers);
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('Cache-Control', 'no-store');
    return new Response(JSON.stringify({ ...payload, id_token: idToken }), {
      status: 200,
      headers,
    });
  }

  return null;
}

async function handleUserInfo(
  request: Request,
  env: WorkerEnv,
  providerOptions: OAuthProviderOptions<WorkerEnv>,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return oidcJson({ error: 'method_not_allowed' }, 405, { Allow: 'GET, POST, OPTIONS' });
  }

  const bearer = await extractAccessToken(request);
  if (!bearer) {
    return oidcUnauthorized('Missing access token.');
  }

  const oauthApi = getOAuthApi(providerOptions, env);
  const summary = await oauthApi.unwrapToken<OAuthGrantProps>(bearer);
  const now = Math.floor(Date.now() / 1000);
  if (summary && summary.expiresAt > now && summary.grant?.props?.source === 'oauth-grant') {
    const email = summary.grant.props.email;
    return oidcJson({
      sub: summary.userId,
      email,
      email_verified: true,
      name: email,
      preferred_username: email,
    });
  }

  // API keys remain valid callers if a mailbox is linked to their subject.
  const apiKeyAuth = await authenticateRequest(
    new Request(request.url, { headers: { Authorization: `Bearer ${bearer}` } }),
    env,
  );
  if (apiKeyAuth.authenticated) {
    const resolved = await resolveMailboxCredentials(request, env, apiKeyAuth.principal.subject);
    const email = resolved.credentials?.email;
    return oidcJson({
      sub: apiKeyAuth.principal.subject,
      ...(email
        ? {
            email,
            email_verified: true,
            name: email,
            preferred_username: email,
          }
        : {
            name: apiKeyAuth.principal.subject,
            preferred_username: apiKeyAuth.principal.subject,
          }),
    });
  }

  return oidcUnauthorized('The access token is invalid or expired.');
}

async function extractAccessToken(request: Request): Promise<string | null> {
  const authHeader = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
  if (match) return match[1];

  if (
    request.method === 'POST'
    && (request.headers.get('Content-Type') ?? '').includes('application/x-www-form-urlencoded')
  ) {
    const params = new URLSearchParams(await request.clone().text());
    const formToken = params.get('access_token')?.trim();
    if (formToken) return formToken;
  }

  return null;
}

async function loadOrCreateSigningKey(env: WorkerEnv, origin: string): Promise<LoadedSigningKey> {
  if (!env.OAUTH_KV) {
    throw new CredentialResolutionError('OAUTH_KV binding is required for OIDC signing.');
  }
  const masterKey = await importMasterAesKey(env);

  const existingRaw = await env.OAUTH_KV.get(SIGNING_KEY_KV_KEY);
  if (existingRaw) {
    const record = JSON.parse(existingRaw) as SealedSigningKeyRecordV1;
    const cacheKey = `${origin}:${record.kid}:${record.iv}`;
    if (cachedSigningKey?.cacheKey === cacheKey) {
      return cachedSigningKey.loaded;
    }
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64Url(record.iv),
        additionalData: new TextEncoder().encode(SIGNING_KEY_AAD),
        tagLength: 128,
      },
      masterKey,
      fromBase64Url(record.ciphertext),
    );
    const privateJwk = JSON.parse(new TextDecoder().decode(plaintext)) as JsonWebKey;
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      privateJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    const loaded: LoadedSigningKey = {
      kid: record.kid,
      publicJwk: buildPublicJwk(record.publicJwk, record.kid),
      privateKey,
    };
    cachedSigningKey = { cacheKey, loaded };
    return loaded;
  }

  const generated = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;

  const publicJwk = (await crypto.subtle.exportKey('jwk', generated.publicKey)) as JsonWebKey;
  const privateJwk = (await crypto.subtle.exportKey('jwk', generated.privateKey)) as JsonWebKey;
  const kid = await computeEcThumbprint(publicJwk);

  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(privateJwk));
  let ciphertext: ArrayBuffer;
  try {
    ciphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: new TextEncoder().encode(SIGNING_KEY_AAD),
        tagLength: 128,
      },
      masterKey,
      plaintext,
    );
  } finally {
    plaintext.fill(0);
  }

  const record: SealedSigningKeyRecordV1 = {
    version: 1,
    algorithm: 'AES-256-GCM',
    kid,
    publicJwk: { kty: 'EC', crv: 'P-256', x: publicJwk.x, y: publicJwk.y },
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
  };
  await env.OAUTH_KV.put(SIGNING_KEY_KV_KEY, JSON.stringify(record));

  const nonExtractablePrivate = await crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const loaded: LoadedSigningKey = {
    kid,
    publicJwk: buildPublicJwk(record.publicJwk, kid),
    privateKey: nonExtractablePrivate,
  };
  cachedSigningKey = { cacheKey: `${origin}:${kid}:${record.iv}`, loaded };
  return loaded;
}

function buildPublicJwk(jwk: JsonWebKey, kid: string): Record<string, unknown> {
  return {
    kty: 'EC',
    crv: 'P-256',
    x: jwk.x,
    y: jwk.y,
    kid,
    use: 'sig',
    alg: 'ES256',
  };
}

async function computeEcThumbprint(jwk: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({ crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return toBase64Url(new Uint8Array(digest));
}

async function importMasterAesKey(env: WorkerEnv): Promise<CryptoKey> {
  const configured = env.CREDENTIALS_MASTER_KEY;
  if (configured === undefined) {
    throw new CredentialResolutionError('CREDENTIALS_MASTER_KEY is required for OIDC token signing.');
  }
  let secret: string;
  try {
    secret = typeof configured === 'string' ? configured : await configured.get();
  } catch {
    throw new CredentialResolutionError('The credential-vault master key binding is unavailable.');
  }
  let rawBytes: Uint8Array;
  try {
    rawBytes = decodeMasterKey(secret);
  } catch (error) {
    if (error instanceof CredentialVaultError) {
      throw new CredentialResolutionError('The credential-vault master key is invalid.');
    }
    throw error;
  }
  try {
    return await crypto.subtle.importKey('raw', rawBytes, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally {
    rawBytes.fill(0);
  }
}

async function signEs256Jwt(signingKey: LoadedSigningKey, claims: Record<string, unknown>): Promise<string> {
  const headerSegment = toBase64Url(
    new TextEncoder().encode(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: signingKey.kid })),
  );
  const payloadSegment = toBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${headerSegment}.${payloadSegment}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signingKey.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
}

function oidcJson(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...OIDC_CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function oidcUnauthorized(description: string): Response {
  const safeDesc = description.replace(/"/g, '');
  return oidcJson(
    { error: 'invalid_token', error_description: description },
    401,
    { 'WWW-Authenticate': `Bearer error="invalid_token", error_description="${safeDesc}"` },
  );
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
