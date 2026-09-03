import { AppPasswordGmailClient } from '../core/app-password-client.js';
import { GetEmailContentSchema, SearchEmailsSchema, SendEmailSchema } from '../mcp/schemas.js';
import type { GmailAppPasswordCredentials, WorkerEnv } from '../types.js';
import { handleAccountLinkRoute } from './account-link.js';
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

const SERVICE_VERSION = '0.1.0';
const MAIL_SCOPES = ['mail.read', 'mail.manage', 'mail.send', 'mail.delete'] as const;

export default {
  async fetch(request: Request, env: WorkerEnv, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const finish = (response: Response) => applyResponseSecurity(response, request, env);

    try {
      if (request.method === 'OPTIONS') {
        return finish(corsPreflight(request, env));
      }

      if (url.pathname === '/health' && request.method === 'GET') {
        return finish(json({
          status: 'ok',
          service: '@xtnd-dynamics/mcp-gmail',
          version: SERVICE_VERSION,
          credentialModel: 'authenticated account linking',
          timestamp: new Date().toISOString(),
        }));
      }

      if (url.pathname === '/openapi.json' && request.method === 'GET') {
        return finish(json(getOpenApiSpec(url.origin)));
      }

      if (url.pathname === '/.well-known/mcp/server-card.json' && request.method === 'GET') {
        return finish(json(serverCard()));
      }

      if (
        (url.pathname === '/.well-known/oauth-protected-resource'
          || url.pathname === '/.well-known/oauth-protected-resource/mcp')
        && request.method === 'GET'
      ) {
        if (!isOAuthConfigured(env)) {
          return finish(json({ error: 'OAuth discovery is not configured for this deployment.' }, 404));
        }
        return finish(json({
          resource: env.OAUTH_AUDIENCE,
          authorization_servers: [env.OAUTH_AUTHORIZATION_SERVER],
          scopes_supported: [...MAIL_SCOPES],
          ...(env.OAUTH_RESOURCE_DOCUMENTATION
            ? { resource_documentation: env.OAUTH_RESOURCE_DOCUMENTATION }
            : {}),
        }));
      }

      // Root developer documentation landing page
      if (url.pathname === '/' && request.method === 'GET') {
        return finish(new Response(getLandingHtml(), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }));
      }

      // Every operational endpoint, including /mcp, authenticates before mailbox resolution.
      const auth = await authenticateRequest(request, env);
      if (!auth.authenticated) {
        if (auth.status === 503) {
          return finish(json({ error: auth.error }, 503));
        }
        return finish(unauthorized(auth.error, request, env));
      }
      const principal = auth.principal;

      if (url.pathname.startsWith('/api/accounts/')) {
        if (!hasScope(principal, 'mail.manage')) {
          return finish(forbiddenScope('mail.manage'));
        }
        const accountResponse = await handleAccountLinkRoute(request, env, principal);
        if (accountResponse) return finish(accountResponse);
        return finish(json({ error: 'Not Found' }, 404));
      }

      if (url.pathname === '/mcp') {
        return finish(await handleMcpStreamableHttp(request, {
          subject: principal.subject,
          scopes: principal.scopes ?? [],
          resolveCredentials: () => resolveCredentials(request, env, principal.subject),
          enableLegacySse: isEnabled(env.ENABLE_LEGACY_SSE),
        }));
      }

      if (url.pathname === '/sse' && request.method === 'GET') {
        if (!isEnabled(env.ENABLE_LEGACY_SSE)) {
          return finish(json({ error: 'Legacy SSE transport is disabled. Use /mcp.' }, 410));
        }
        const missingScope = MAIL_SCOPES.find((scope) => !hasScope(principal, scope));
        if (missingScope) return finish(forbiddenScope(missingScope));
        const credentials = await resolveCredentials(request, env, principal.subject);
        if (!credentials) return finish(accountNotLinked());
        return finish(await handleSseConnect(request, credentials, principal.subject));
      }

      if (url.pathname === '/message' && request.method === 'POST') {
        if (!isEnabled(env.ENABLE_LEGACY_SSE)) {
          return finish(json({ error: 'Legacy SSE transport is disabled. Use /mcp.' }, 410));
        }
        return finish(await handleMessagePost(request, principal.subject));
      }

      if (url.pathname === '/api/folders' && request.method === 'GET') {
        if (!hasScope(principal, 'mail.read')) return finish(forbiddenScope('mail.read'));
        const credentials = await resolveCredentials(request, env, principal.subject);
        if (!credentials) return finish(accountNotLinked());
        const client = new AppPasswordGmailClient(credentials);
        return finish(json({ folders: await client.listFolders() }));
      }

      if (url.pathname === '/api/emails/search' && request.method === 'POST') {
        if (!hasScope(principal, 'mail.read')) return finish(forbiddenScope('mail.read'));
        const body = SearchEmailsSchema.parse(await readRequestJson(request, 1_048_576));
        const credentials = await resolveCredentials(request, env, principal.subject);
        if (!credentials) return finish(accountNotLinked());
        const client = new AppPasswordGmailClient(credentials);
        return finish(json(await client.searchEmails(body as any)));
      }

      if (url.pathname.startsWith('/api/emails/') && request.method === 'GET') {
        if (!hasScope(principal, 'mail.read')) return finish(forbiddenScope('mail.read'));
        const uid = Number(url.pathname.slice('/api/emails/'.length));
        const folder = url.searchParams.get('folder') || 'INBOX';
        const input = GetEmailContentSchema.parse({ folder, uid });
        const credentials = await resolveCredentials(request, env, principal.subject);
        if (!credentials) return finish(accountNotLinked());
        const client = new AppPasswordGmailClient(credentials);
        return finish(json(await client.getEmailContent(input.folder, input.uid)));
      }

      if (url.pathname === '/api/emails/send' && request.method === 'POST') {
        if (!hasScope(principal, 'mail.send')) return finish(forbiddenScope('mail.send'));
        const body = SendEmailSchema.parse(await readRequestJson(request, 3_145_728));
        const credentials = await resolveCredentials(request, env, principal.subject);
        if (!credentials) return finish(accountNotLinked());
        const client = new AppPasswordGmailClient(credentials);
        return finish(json(await client.sendEmail(body as any)));
      }

      return finish(json({ error: 'Not Found' }, 404));
    } catch (error) {
      if (error instanceof CredentialResolutionError) {
        return finish(json({ error: 'The hosted credential vault is unavailable.' }, 503));
      }
      if (error instanceof RequestBodyTooLargeError) {
        return finish(json({ error: 'The request body is too large.' }, 413));
      }
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      return finish(json({ error: 'Internal Server Error', errorName }, 500));
    }
  },
};

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

function serverCard(): Record<string, unknown> {
  return {
    serverInfo: { name: 'XTND | MCP | GMAIL', version: SERVICE_VERSION },
    icon: 'https://raw.githubusercontent.com/XTND-DYNAMICS/xtnd-mcp-gmail/main/assets/icon.svg',
    description: 'Supreme MCP server for Gmail and Google Workspace with dual-mode App Password & OAuth2 support.',
    homepage: 'https://github.com/XTND-DYNAMICS/xtnd-mcp-gmail#readme',
    repository: 'https://github.com/XTND-DYNAMICS/xtnd-mcp-gmail',
    authentication: {
      type: 'bearer',
      accountLinking: '/api/accounts/link',
      rawMailboxCredentialHeaders: 'disabled by default',
    },
    tools: [
      'list_folders', 'create_folder', 'rename_folder', 'delete_folder', 'search_emails',
      'get_recent_emails', 'get_email_content', 'get_email_thread', 'mark_emails',
      'move_emails', 'delete_emails', 'send_email', 'reply_email', 'forward_email', 'create_draft',
    ],
  };
}

function getLandingHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>XTND | MCP | GMAIL</title>
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
        <li><strong>Streamable HTTP MCP:</strong> <code>POST /mcp</code></li>
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
