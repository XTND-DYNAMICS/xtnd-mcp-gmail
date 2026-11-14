/**
 * The OAuth 2.1 authorization endpoint (`/authorize`).
 *
 * @cloudflare/workers-oauth-provider validates the request, registers clients,
 * issues and refreshes tokens; this page is the part the library leaves to the
 * deployment: it signs the user in and asks for consent. Signing in here means
 * proving control of a Gmail mailbox with its App Password. The credentials are
 * verified against Gmail before anything is stored, then sealed in the existing
 * credential vault under the grant's subject, so every token issued from this
 * grant reaches exactly that mailbox.
 */

import { AuthorizationError, type AuthRequest, type ConsentDescription } from '@cloudflare/workers-oauth-provider';
import type { GmailAppPasswordCredentials, WorkerEnv } from '../types.js';
import { defaultMailboxVerifier, parseLinkCredentials, type MailboxVerifier } from './account-link.js';
import { sha256Hex } from './auth.js';
import { credentialVaultFromEnv } from './credential-resolver.js';

export const MAIL_SCOPES = ['mail.read', 'mail.manage', 'mail.send', 'mail.delete'] as const;

/** Failed sign-ins allowed per mailbox inside the window before the page refuses. */
const MAX_FAILED_ATTEMPTS = 5;
const FAILED_ATTEMPT_WINDOW_SECONDS = 900;
const MAX_FORM_BYTES = 16_384;

export interface OAuthGrantProps {
  source: 'oauth-grant';
  subject: string;
  email: string;
}

export interface AuthorizeDependencies {
  verifyMailbox?: MailboxVerifier;
}

/**
 * Stable vault subject (and OAuth userId, which may not contain ':') for a
 * mailbox signed in through OAuth. Never collides with API-key subjects (raw hex).
 */
export async function oauthSubjectFor(email: string): Promise<string> {
  return `oauth-${await sha256Hex(email.trim().toLowerCase())}`;
}

export async function handleAuthorize(
  request: Request,
  env: WorkerEnv,
  deps: AuthorizeDependencies = {},
): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth) return text('OAuth is not enabled on this deployment.', 503);

  if (request.method === 'GET') {
    let authRequest: AuthRequest;
    try {
      authRequest = await oauth.parseAuthRequest(request);
    } catch (error) {
      return authorizationFailure(error);
    }
    const details: ConsentDescription = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    return page(consentPage(details, consent.handle), 200, consent.headers);
  }

  if (request.method !== 'POST') {
    return text('Method Not Allowed', 405, { Allow: 'GET, POST' });
  }

  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > MAX_FORM_BYTES) return text('The sign-in form is too large.', 413);
  const form = await request.formData();
  const handle = String(form.get('handle') ?? '');

  try {
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    let credentials: GmailAppPasswordCredentials;
    try {
      credentials = parseLinkCredentials({
        email: String(form.get('email') ?? ''),
        // Google shows App Passwords in groups of four; the spaces are not part of it.
        appPassword: String(form.get('appPassword') ?? '').replace(/\s+/g, ''),
      }, env);
    } catch (error) {
      return rerender(request, env, handle, error instanceof Error ? error.message : 'The mailbox credentials are invalid.');
    }

    const vault = await credentialVaultFromEnv(env);
    if (!vault) return text('The hosted credential vault is not configured.', 503);

    const failureKey = `oauth-signin-failures:${await sha256Hex(credentials.email)}`;
    const failures = Number((await env.KV.get(failureKey)) ?? '0');
    if (failures >= MAX_FAILED_ATTEMPTS) {
      return rerender(request, env, handle, 'Too many failed sign-ins for this mailbox. Wait 15 minutes and try again.');
    }

    try {
      await (deps.verifyMailbox ?? defaultMailboxVerifier)(credentials);
    } catch {
      await env.KV.put(failureKey, String(failures + 1), { expirationTtl: FAILED_ATTEMPT_WINDOW_SECONDS });
      return rerender(
        request,
        env,
        handle,
        'Gmail did not accept that address and App Password. Check both; an App Password is 16 letters from myaccount.google.com/apppasswords.',
      );
    }
    if (failures > 0) await env.KV.delete(failureKey);

    const requested = form.getAll('scope').map(String);
    const scope = MAIL_SCOPES.filter((candidate) => requested.includes(candidate));
    if (scope.length === 0) {
      return rerender(request, env, handle, 'Choose at least one permission.');
    }

    const approved = await oauth.approveConsent(request, handle, { scope });
    const subject = await oauthSubjectFor(credentials.email);
    await vault.save(subject, credentials);

    const props: OAuthGrantProps = { source: 'oauth-grant', subject, email: credentials.email };
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: subject,
      metadata: { email: credentials.email },
      scope: approved.request.scope,
      props,
    });
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    return authorizationFailure(error);
  }
}

/** Show the form again with an error. The handle is unconsumed, so the same browser can retry. */
async function rerender(request: Request, env: WorkerEnv, handle: string, message: string): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest: AuthRequest = await oauth.parseAuthRequest(request);
  const details: ConsentDescription = await oauth.describeConsent(authRequest);
  return page(consentPage(details, handle, message), 400, new Headers());
}

/** AuthorizationError: redirect to the client once it is validated, else show the reason. Anything else is a fault. */
function authorizationFailure(error: unknown): Response {
  if (!(error instanceof AuthorizationError)) throw error;
  if (error.redirectTo) {
    return new Response(null, { status: 302, headers: { Location: error.redirectTo } });
  }
  return text(error.description || 'The authorization request is invalid.', 400);
}

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const SCOPE_LABELS: Record<string, string> = {
  'mail.read': 'Read mail, threads, drafts and attachments',
  'mail.manage': 'Organise mail and drafts: labels, flags, moves, archive',
  'mail.send': 'Send mail, replies, forwards and drafts',
  'mail.delete': 'Move mail to Trash and delete it',
};

function consentPage(details: ConsentDescription, handle: string, error?: string): string {
  const name = escape(details.clientName || 'An application');
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : 'This app registered itself; its name is not verified.';
  const requested = details.scope.length > 0 ? details.scope : [...MAIL_SCOPES];
  const scopes = MAIL_SCOPES.map((scope) => `
        <label class="scope"><input type="checkbox" name="scope" value="${scope}"${requested.includes(scope) ? ' checked' : ''}>
          <span><code>${scope}</code> ${escape(SCOPE_LABELS[scope])}</span></label>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="icon" href="/favicon.ico" sizes="32x32">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <title>Connect Gmail to ${name}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #090d16; color: #e2e8f0; margin: 0; padding: 32px 16px; line-height: 1.5; }
    main { max-width: 480px; margin: 0 auto; background: #121827; border: 1px solid #1e293b; border-radius: 12px; padding: 28px; }
    h1 { font-size: 1.35rem; margin: 0 0 8px; }
    p { color: #94a3b8; margin: 0 0 14px; }
    label { display: block; margin: 14px 0 4px; font-weight: 600; }
    input[type=email], input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid #334155; background: #0d121f; color: #e2e8f0; font-size: 1rem; }
    .scope { display: flex; gap: 10px; font-weight: 400; margin: 8px 0; color: #cbd5e1; }
    .error { background: rgba(234,67,53,0.15); border: 1px solid #ea4335; color: #fecaca; padding: 10px 12px; border-radius: 8px; }
    .warn { color: #fbbf24; }
    .actions { display: flex; gap: 12px; margin-top: 22px; }
    button { flex: 1; padding: 11px; border-radius: 8px; border: 0; font-size: 1rem; font-weight: 600; cursor: pointer; }
    .allow { background: #ea4335; color: #fff; }
    .deny { background: #1e293b; color: #e2e8f0; }
    code { background: #1e293b; padding: 1px 5px; border-radius: 4px; }
  </style>
</head>
<body>
  <main>
    <h1>Connect a Gmail mailbox to ${name}</h1>
    <p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
    ${details.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>' : ''}
    ${error ? `<p class="error" role="alert">${escape(error)}</p>` : ''}
    <form method="post" autocomplete="off">
      <input type="hidden" name="handle" value="${escape(handle)}">
      <label for="email">Gmail address</label>
      <input id="email" name="email" type="email" required autocomplete="username" placeholder="name@example.com">
      <label for="appPassword">App Password</label>
      <input id="appPassword" name="appPassword" type="password" required autocomplete="current-password" placeholder="xxxx xxxx xxxx xxxx">
      <p style="margin-top:6px">Create one at <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer" style="color:#60a5fa">myaccount.google.com/apppasswords</a>. It is checked with Gmail and stored encrypted; your Google password is never asked for.</p>
      <label>Permissions</label>${scopes}
      <div class="actions">
        <button class="deny" name="decision" value="deny" formnovalidate>Deny</button>
        <button class="allow" name="decision" value="approve">Allow</button>
      </div>
    </form>
  </main>
</body>
</html>`;
}

function page(html: string, status: number, headers: Headers): Response {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Frame-Options', 'DENY');
  // No form-action: browsers apply it to the redirect after the POST, which goes to the client.
  headers.set('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  return new Response(html, { status, headers });
}

function text(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}
