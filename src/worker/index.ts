import { AppPasswordGmailClient } from '../core/app-password-client.js';
import { APP_PASSWORD_TOOL_NAMES } from '../mcp/app-password-server.js';
import { brandIconsForOrigin, serveBrandIconRoute } from '../mcp/brand-icons.js';
import { GetEmailContentSchema, SearchEmailsSchema, SendEmailSchema } from '../mcp/schemas.js';
import type { GmailAppPasswordCredentials, WorkerEnv } from '../types.js';
import { OAuthProvider, type OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import { handleAccountLinkRoute, type MailboxVerifier } from './account-link.js';
import {
  ADVERTISED_RESOURCE_SCOPES,
  handleAuthorize,
  MAIL_SCOPES,
  SUPPORTED_OAUTH_SCOPES,
  type OAuthGrantProps,
} from './oauth-authorize.js';
import { handleOidcRequest, isOidcRoutePath } from './oidc.js';
import {
  authenticateRequest,
  isOAuthConfigured,
  type AuthenticatedPrincipal,
} from './auth.js';
import {
  CredentialResolutionError,
  isEnabled,
  resolveMailboxCredentials,
} from './credential-resolver.js';
import { handleMcpStreamableHttp } from './mcp-streamable-http.js';
import { getOpenApiSpec } from './openapi.js';
import { readRequestJson, RequestBodyTooLargeError } from './request-body.js';
import { handleMessagePost, handleSseConnect } from './sse-handler.js';
import { versionRoutes } from '@xtnd-dynamics/xtnd-platform';
import { BUILD_STAMP } from '../version.generated.js';

/** GET /health and GET /version, as every XSuite API serves them (AGENTS.md §3), from the build stamp. */
const versioned = versionRoutes(BUILD_STAMP);

export interface WorkerDependencies {
  /** Verifies a mailbox at sign-in; the default logs in to Gmail over IMAP. */
  verifyMailbox?: MailboxVerifier;
}

/** The Worker. `createWorker()` exists so tests can replace the Gmail login check. */
export function createWorker(deps: WorkerDependencies = {}) {
  let provider: {
    resource: string;
    instance: OAuthProvider<WorkerEnv>;
    options: OAuthProviderOptions<WorkerEnv>;
  } | null = null;

  const oauthBundle = (resource: string) => {
    if (provider?.resource !== resource) {
      const options = buildOAuthProviderOptions(resource, deps);
      provider = { resource, instance: new OAuthProvider<WorkerEnv>(options), options };
    }
    return provider;
  };

  return {
    async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
      const iconResponse = serveBrandIconRoute(new URL(request.url).pathname, request.method);
      if (iconResponse) return iconResponse;

      const finish = (response: Response) => applyResponseSecurity(response, request, env);
      try {
        const resource = oauthResource(env);
        const publicResponse = await publicRoute(request, env, resource !== null);
        if (publicResponse) return finish(publicResponse);

        if (resource) {
          // Built-in OAuth 2.1 + OIDC authorization server: discovery, JWKS,
          // /oauth/userinfo, registration, token (+ id_token) and /authorize;
          // API keys still work through resolveExternalToken.
          const bundle = oauthBundle(resource);
          const oidcResponse = await handleOidcRequest(
            request,
            env,
            ctx,
            resource,
            bundle.instance,
            bundle.options,
          );
          if (oidcResponse) return finish(oidcResponse);
          return finish(await bundle.instance.fetch(request, env, ctx));
        }

        // Every operational endpoint authenticates before mailbox resolution.
        const auth = await authenticateRequest(request, env);
        if (!auth.authenticated) {
          if (auth.status === 503) return finish(json({ error: auth.error }, 503));
          return finish(unauthorized(auth.error, request, env));
        }
        return finish(await protectedRoute(request, env, auth.principal));
      } catch (error) {
        return finish(errorResponse(error));
      }
    },
  };
}

export default createWorker();

/** The configured resource URL, or null when the built-in authorization server is off. */
function oauthResource(env: WorkerEnv): string | null {
  const configured = String(env.MCP_RESOURCE_URL ?? '').trim();
  if (!configured) return null;
  const url = new URL(configured);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
    throw new Error('MCP_RESOURCE_URL must be an https URL without credentials, query or fragment.');
  }
  if (!env.OAUTH_KV) throw new Error('MCP_RESOURCE_URL is set but the OAUTH_KV binding is missing.');
  return url.href;
}

function buildOAuthProviderOptions(
  resource: string,
  deps: WorkerDependencies,
): OAuthProviderOptions<WorkerEnv> {
  const origin = new URL(resource).origin;
  return {
    // '/' matches the bare origin only; '/api' matches /api and /api/*.
    apiRoute: ['/', '/mcp', '/api', '/sse', '/message'],
    apiHandler: {
      async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
        try {
          return await protectedRoute(request, env, principalFromContext(ctx));
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
    defaultHandler: {
      async fetch(request: Request, env: WorkerEnv): Promise<Response> {
        if (new URL(request.url).pathname === '/authorize') {
          return handleAuthorize(request, env, {
            verifyMailbox: deps.verifyMailbox,
            canonicalResource: resource,
          });
        }
        return json({ error: 'Not Found' }, 404);
      },
    },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [...SUPPORTED_OAUTH_SCOPES],
    requiredScopes: [...ADVERTISED_RESOURCE_SCOPES],
    resourceMetadata: {
      resource,
      authorization_servers: [origin],
      resource_name: 'XMAIL | Gmail',
      logo_uri: `${origin}/favicon.svg`,
      icons: brandIconsForOrigin(origin),
      resource_documentation: 'https://github.com/XTND-DYNAMICS/xtnd-mcp-gmail#readme',
    },
    accessTokenTTL: 3_600,
    // A connector stays connected while it is used; it lapses after 90 idle days.
    refreshTokenTTL: 90 * 24 * 3_600,
    resolveExternalToken: async ({ token, request, env }) => {
      // API keys (KV apikey:<sha256> or API_KEYS_SHA256) keep working beside OAuth.
      const headers = new Headers({ Authorization: `Bearer ${token}` });
      const result = await authenticateRequest(new Request(request.url, { headers }), env);
      if (!result.authenticated) {
        if (result.status === 503) throw new Error(result.error);
        return null;
      }
      const props: ApiKeyProps = {
        source: 'api-key',
        subject: result.principal.subject,
        tokenHash: result.principal.tokenHash,
        scopes: result.principal.scopes ?? [],
      };
      return { props, audience: resource };
    },
  } as OAuthProviderOptions<WorkerEnv>;
}

interface ApiKeyProps {
  source: 'api-key';
  subject: string;
  tokenHash: string;
  scopes: string[];
}

function principalFromContext(ctx: ExecutionContext): AuthenticatedPrincipal {
  const props = (ctx as unknown as { props?: OAuthGrantProps | ApiKeyProps }).props;
  const auth = (ctx as unknown as { auth?: { scope?: string[] } }).auth;
  if (props?.source === 'oauth-grant' && typeof props.subject === 'string') {
    return { subject: props.subject, tokenHash: '', scopes: [...(auth?.scope ?? [])], source: 'oauth' };
  }
  if (props?.source === 'api-key' && typeof props.subject === 'string') {
    return { subject: props.subject, tokenHash: props.tokenHash, scopes: [...props.scopes], source: 'kv' };
  }
  throw new Error('The authenticated request carries no usable identity.');
}

/** Unauthenticated routes: health, version, documents, discovery and the landing page. */
async function publicRoute(request: Request, env: WorkerEnv, oauthEnabled: boolean): Promise<Response | null> {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    // The provider and OIDC layer answer preflight for their own endpoints.
    const providerPath =
      url.pathname.startsWith('/.well-known/oauth-')
      || isOidcRoutePath(url.pathname)
      || url.pathname.startsWith('/oauth/');
    if (!(oauthEnabled && providerPath)) return corsPreflight(request, env);
    return null;
  }

  const versionResponse = await versioned(request);
  if (versionResponse) return versionResponse;

  if (url.pathname === '/openapi.json' && request.method === 'GET') {
    return json(getOpenApiSpec(url.origin));
  }

  if (url.pathname === '/.well-known/mcp/server-card.json' && request.method === 'GET') {
    return json(serverCard(url.origin));
  }

  if (
    !oauthEnabled
    && (url.pathname === '/.well-known/oauth-protected-resource'
      || url.pathname === '/.well-known/oauth-protected-resource/mcp')
    && request.method === 'GET'
  ) {
    if (!isOAuthConfigured(env)) {
      return json({ error: 'OAuth discovery is not configured for this deployment.' }, 404);
    }
    return json({
      resource: env.OAUTH_AUDIENCE,
      resource_name: 'XMAIL | Gmail',
      authorization_servers: [env.OAUTH_AUTHORIZATION_SERVER],
      scopes_supported: [...MAIL_SCOPES],
      logo_uri: `${url.origin}/favicon.svg`,
      icons: brandIconsForOrigin(url.origin),
      ...(env.OAUTH_RESOURCE_DOCUMENTATION
        ? { resource_documentation: env.OAUTH_RESOURCE_DOCUMENTATION }
        : {}),
    });
  }

  // The landing page, for a browser. The MCP endpoint also lives at the root,
  // so a GET with credentials or one asking for an event stream is MCP.
  if (
    url.pathname === '/'
    && request.method === 'GET'
    && !request.headers.has('Authorization')
    && !(request.headers.get('Accept') ?? '').includes('text/event-stream')
  ) {
    return new Response(getLandingHtml(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  return null;
}

/** Authenticated routes. `principal` came from an API key or an OAuth grant. */
async function protectedRoute(
  request: Request,
  env: WorkerEnv,
  principal: AuthenticatedPrincipal,
): Promise<Response> {
  const url = new URL(request.url);

    if (url.pathname.startsWith('/api/accounts/')) {
      if (!hasScope(principal, 'mail.manage')) {
        return (forbiddenScope('mail.manage'));
      }
      const accountResponse = await handleAccountLinkRoute(request, env, principal);
      if (accountResponse) return (accountResponse);
      return (json({ error: 'Not Found' }, 404));
    }

    // The connection URL is the bare origin; /mcp stays as an alias so
    // existing clients keep working.
    if (url.pathname === '/' || url.pathname === '/mcp') {
      return (await handleMcpStreamableHttp(request, {
        subject: principal.subject,
        scopes: principal.scopes ?? [],
        resolveCredentials: () => resolveCredentials(request, env, principal.subject),
        enableLegacySse: isEnabled(env.ENABLE_LEGACY_SSE),
      }));
    }

    if (url.pathname === '/sse' && request.method === 'GET') {
      if (!isEnabled(env.ENABLE_LEGACY_SSE)) {
        return (json({ error: 'Legacy SSE transport is disabled. Use /mcp.' }, 410));
      }
      const missingScope = MAIL_SCOPES.find((scope) => !hasScope(principal, scope));
      if (missingScope) return (forbiddenScope(missingScope));
      const credentials = await resolveCredentials(request, env, principal.subject);
      if (!credentials) return (accountNotLinked());
      return (await handleSseConnect(request, credentials, principal.subject));
    }

    if (url.pathname === '/message' && request.method === 'POST') {
      if (!isEnabled(env.ENABLE_LEGACY_SSE)) {
        return (json({ error: 'Legacy SSE transport is disabled. Use /mcp.' }, 410));
      }
      return (await handleMessagePost(request, principal.subject));
    }

    if (url.pathname === '/api/folders' && request.method === 'GET') {
      if (!hasScope(principal, 'mail.read')) return (forbiddenScope('mail.read'));
      const credentials = await resolveCredentials(request, env, principal.subject);
      if (!credentials) return (accountNotLinked());
      const client = new AppPasswordGmailClient(credentials);
      return (json({ folders: await client.listFolders() }));
    }

    if (url.pathname === '/api/emails/search' && request.method === 'POST') {
      if (!hasScope(principal, 'mail.read')) return (forbiddenScope('mail.read'));
      const body = SearchEmailsSchema.parse(await readRequestJson(request, 1_048_576));
      const credentials = await resolveCredentials(request, env, principal.subject);
      if (!credentials) return (accountNotLinked());
      const client = new AppPasswordGmailClient(credentials);
      return (json(await client.searchEmails(body as any)));
    }

    if (url.pathname.startsWith('/api/emails/') && request.method === 'GET') {
      if (!hasScope(principal, 'mail.read')) return (forbiddenScope('mail.read'));
      const uid = Number(url.pathname.slice('/api/emails/'.length));
      const folder = url.searchParams.get('folder') || 'INBOX';
      const input = GetEmailContentSchema.parse({ folder, uid });
      const credentials = await resolveCredentials(request, env, principal.subject);
      if (!credentials) return (accountNotLinked());
      const client = new AppPasswordGmailClient(credentials);
      return (json(await client.getEmailContent(input.folder, input.uid)));
    }

    if (url.pathname === '/api/emails/send' && request.method === 'POST') {
      if (!hasScope(principal, 'mail.send')) return (forbiddenScope('mail.send'));
      const body = SendEmailSchema.parse(await readRequestJson(request, 3_145_728));
      const credentials = await resolveCredentials(request, env, principal.subject);
      if (!credentials) return (accountNotLinked());
      const client = new AppPasswordGmailClient(credentials);
      return (json(await client.sendEmail(body as any)));
    }

    return json({ error: 'Not Found' }, 404);
}

function errorResponse(error: unknown): Response {
    if (error instanceof CredentialResolutionError) {
      return (json({ error: 'The hosted credential vault is unavailable.' }, 503));
    }
    if (error instanceof RequestBodyTooLargeError) {
      return (json({ error: 'The request body is too large.' }, 413));
    }
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    return (json({ error: 'Internal Server Error', errorName }, 500));
}

async function resolveCredentials(
  request: Request,
  env: WorkerEnv,
  subject: string,
): Promise<GmailAppPasswordCredentials | null> {
  const resolved = await resolveMailboxCredentials(request, env, subject);
  return resolved.credentials;
}

function hasScope(principal: AuthenticatedPrincipal, requiredScope: string): boolean {
  return principal.scopes?.includes(requiredScope) ?? false;
}

function unauthorized(
  message: string,
  request: Request,
  env: WorkerEnv,
): Response {
  const headers: Record<string, string> = {};
  if (isOAuthConfigured(env)) {
    headers['WWW-Authenticate'] = `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource', request.url).href}"`;
  }
  return json({ error: message }, 401, headers);
}

function forbiddenScope(requiredScope: string): Response {
  return json({
    error: 'Insufficient scope.',
    requiredScope,
    message: `This operation requires the "${requiredScope}" scope.`,
  }, 403);
}

function accountNotLinked(): Response {
  return json({
    error: 'No Gmail mailbox is linked to this authenticated identity.',
    linkEndpoint: '/api/accounts/link',
    instructions: 'POST /api/accounts/link with {"email": "...", "appPassword": "..."}.',
  }, 404);
}

function corsPreflight(request: Request, env: WorkerEnv): Response {
  const origin = request.headers.get('Origin');
  const allowed = origin && allowedOrigins(env).has(origin);
  return new Response(null, {
    status: 204,
    headers: {
      ...(allowed ? { 'Access-Control-Allow-Origin': origin } : {}),
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, X-Gmail-Email, X-Gmail-App-Password',
      'Access-Control-Max-Age': '86400',
      'Cache-Control': 'no-store',
    },
  });
}

function applyResponseSecurity(
  response: Response,
  request: Request,
  env: WorkerEnv,
): Response {
  const origin = request.headers.get('Origin');
  if (origin && allowedOrigins(env).has(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin);
  }
  appendVary(response.headers, 'Origin');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  return response;
}

function allowedOrigins(env: WorkerEnv): Set<string> {
  return new Set(
    (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

function appendVary(headers: Headers, value: string): void {
  const existing = headers.get('Vary');
  const values = new Set((existing ?? '').split(',').map((entry) => entry.trim()).filter(Boolean));
  values.add(value);
  headers.set('Vary', [...values].join(', '));
}

function json(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function serverCard(origin: string): Record<string, unknown> {
  const icons = brandIconsForOrigin(origin);
  return {
    serverInfo: {
      name: 'XTND | MCP | GMAIL',
      title: 'XMAIL | Gmail',
      version: BUILD_STAMP.version,
      websiteUrl: origin,
      icons,
    },
    icon: `${origin}/favicon.svg`,
    icons,
    description: 'Supreme MCP server for Gmail and Google Workspace with dual-mode App Password & OAuth2 support.',
    homepage: 'https://github.com/XTND-DYNAMICS/xtnd-mcp-gmail#readme',
    repository: 'https://github.com/XTND-DYNAMICS/xtnd-mcp-gmail',
    authentication: {
      type: 'oauth2',
      oauthProtectedResource: '/.well-known/oauth-protected-resource',
      apiKeys: 'Authorization: Bearer <key>',
      accountLinking: '/authorize (OAuth sign-in) or /api/accounts/link (API keys)',
      rawMailboxCredentialHeaders: 'disabled by default',
    },
    tools: [...APP_PASSWORD_TOOL_NAMES],
  };
}

function getLandingHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="icon" href="/favicon.ico" sizes="32x32">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <title>XMAIL | Gmail — MCP Server</title>
  <style>
    :root { --bg: #090d16; --card: #121827; --text: #e2e8f0; --accent: #ea4335; --accent-glow: rgba(234,67,53,0.2); --code-bg: #0d121f; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; margin: 0; padding: 40px 20px; }
    .container { max-width: 800px; margin: 0 auto; }
    .header { text-align: center; margin-bottom: 40px; }
    .badge { display: inline-block; background: var(--accent-glow); color: var(--accent); border: 1px solid var(--accent); padding: 4px 12px; border-radius: 9999px; font-size: 0.85rem; font-weight: 600; margin-bottom: 12px; }
    h1 { font-size: 2.5rem; margin: 0 0 10px; font-weight: 800; }
    p.lead { font-size: 1.2rem; color: #94a3b8; margin: 0; }
    .card { background: var(--card); border: 1px solid #1e293b; border-radius: 12px; padding: 24px; margin-bottom: 24px; box-shadow: 0 4px 20px rgba(0,0,0,0.4); }
    h2 { font-size: 1.3rem; margin-top: 0; color: #fff; border-bottom: 1px solid #1e293b; padding-bottom: 12px; }
    pre { background: var(--code-bg); padding: 16px; border-radius: 8px; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 0.9rem; border: 1px solid #1e293b; }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-top: 16px; }
    .pill { background: #1e293b; padding: 8px 12px; border-radius: 6px; font-family: monospace; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="badge">XTND DYNAMICS</div>
      <h1>XTND | MCP | GMAIL</h1>
      <p class="lead">Supreme MCP Server for Gmail & Google Workspace</p>
    </div>
    <div class="card">
      <h2>Endpoints</h2>
      <ul>
        <li><strong>Streamable HTTP MCP:</strong> <code>POST /</code> (alias: <code>/mcp</code>)</li>
        <li><strong>Server Card:</strong> <a href="/.well-known/mcp/server-card.json"><code>/.well-known/mcp/server-card.json</code></a></li>
        <li><strong>OpenAPI 3.1:</strong> <a href="/openapi.json"><code>/openapi.json</code></a></li>
        <li><strong>Health Check:</strong> <a href="/health"><code>/health</code></a></li>
      </ul>
    </div>
    <div class="card">
      <h2>Claude Desktop Configuration</h2>
      <pre><code>{
  "mcpServers": {
    "GMAIL": {
      "command": "npx",
      "args": ["-y", "@xtnd-dynamics/mcp-gmail"],
      "env": {
        "GMAIL_EMAIL": "your-email@gmail.com",
        "GMAIL_APP_PASSWORD": "your-app-password"
      }
    }
  }
}</code></pre>
    </div>
  </div>
</body>
</html>`;
}
