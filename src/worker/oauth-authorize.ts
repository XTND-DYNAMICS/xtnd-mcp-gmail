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
import { normalizeMcpResourceAlias } from './oidc.js';

export const MAIL_SCOPES = ['mail.read', 'mail.manage', 'mail.send', 'mail.delete'] as const;
export const OIDC_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const;
export const SUPPORTED_OAUTH_SCOPES = [...OIDC_SCOPES, ...MAIL_SCOPES] as const;
export const ADVERTISED_RESOURCE_SCOPES = ['openid', 'profile', 'email', ...MAIL_SCOPES] as const;

/** Failed sign-ins allowed per mailbox inside the window before the page refuses. */
const MAX_FAILED_ATTEMPTS = 5;
const FAILED_ATTEMPT_WINDOW_SECONDS = 900;
const MAX_FORM_BYTES = 16_384;
const MAX_NONCE_CHARS = 512;

export interface OAuthGrantProps {
  source: 'oauth-grant';
  subject: string;
  email: string;
  nonce?: string;
}

export interface AuthorizeDependencies {
  verifyMailbox?: MailboxVerifier;
  canonicalResource?: string;
}

/**
 * Stable vault subject (and OAuth userId, which may not contain ':') for a
 * mailbox signed in through OAuth. Never collides with API-key subjects (raw hex).
 */
export async function oauthSubjectFor(email: string): Promise<string> {
  return `oauth-${await sha256Hex(email.trim().toLowerCase())}`;
}

function generateCspNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function prepareProviderAuthorizeRequest(
  request: Request,
  canonicalResource?: string,
): { providerRequest: Request; accountSlug?: string } {
  const url = new URL(request.url);
  const explicitInstance = url.searchParams.get('instance')?.trim();
  let accountSlug = explicitInstance && /^[A-Za-z0-9._@+-]{1,64}$/.test(explicitInstance) ? explicitInstance : undefined;

  if (!canonicalResource) {
    return { providerRequest: request, accountSlug };
  }

  const resources = url.searchParams.getAll('resource');
  if (resources.length === 0) {
    return { providerRequest: request, accountSlug };
  }

  let rewritten = false;
  const normalized = resources.map((entry) => {
    const alias = normalizeMcpResourceAlias(entry, canonicalResource);
    if (alias) {
      if (!accountSlug && alias.accountSlug) accountSlug = alias.accountSlug;
      if (alias.canonical !== entry) {
        rewritten = true;
        return alias.canonical;
      }
    }
    return entry;
  });

  if (!rewritten) {
    return { providerRequest: request, accountSlug };
  }

  url.searchParams.delete('resource');
  for (const val of normalized) url.searchParams.append('resource', val);
  return {
    providerRequest: new Request(url.toString(), request),
    accountSlug,
  };
}

export async function handleAuthorize(
  request: Request,
  env: WorkerEnv,
  deps: AuthorizeDependencies = {},
): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth) return text('OAuth is not enabled on this deployment.', 503);

  const { providerRequest, accountSlug } = prepareProviderAuthorizeRequest(request, deps.canonicalResource);

  if (request.method === 'GET') {
    let authRequest: AuthRequest;
    try {
      authRequest = await oauth.parseAuthRequest(providerRequest);
    } catch (error) {
      return authorizationFailure(error);
    }
    const rawNonce = new URL(request.url).searchParams.get('nonce') ?? '';
    const nonce = rawNonce.length > 0 && rawNonce.length <= MAX_NONCE_CHARS ? rawNonce : undefined;
    const details: ConsentDescription = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    const scriptNonce = generateCspNonce();
    return page(consentPage(details, consent.handle, { error: undefined, nonce, accountSlug, scriptNonce }), 200, consent.headers, scriptNonce);
  }

  if (request.method !== 'POST') {
    return text('Method Not Allowed', 405, { Allow: 'GET, POST' });
  }

  const isFetchSubmit = request.headers.get('X-OAuth-Fetch') === '1';
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > MAX_FORM_BYTES) {
    return isFetchSubmit ? jsonResult({ ok: false, error: 'The sign-in form is too large.' }, 413) : text('The sign-in form is too large.', 413);
  }
  const form = await request.formData();
  const handle = String(form.get('handle') ?? '');
  const rawNonce = String(form.get('nonce') ?? '');
  const nonce = rawNonce.length > 0 && rawNonce.length <= MAX_NONCE_CHARS ? rawNonce : undefined;

  const failForm = (message: string) =>
    isFetchSubmit
      ? Promise.resolve(jsonResult({ ok: false, error: message }, 400))
      : rerender(providerRequest, env, handle, message, nonce, accountSlug);

  try {
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(providerRequest, handle);
      if (isFetchSubmit) {
        const redirectTo = denied.headers.get('Location') ?? '';
        return jsonResult({ ok: true, denied: true, redirectTo }, 200, denied.headers);
      }
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
      return failForm(error instanceof Error ? error.message : 'The mailbox credentials are invalid.');
    }

    const vault = await credentialVaultFromEnv(env);
    if (!vault) {
      return isFetchSubmit
        ? jsonResult({ ok: false, error: 'The hosted credential vault is not configured.' }, 503)
        : text('The hosted credential vault is not configured.', 503);
    }

    const failureKey = `oauth-signin-failures:${await sha256Hex(credentials.email)}`;
    const failures = Number((await env.KV.get(failureKey)) ?? '0');
    if (failures >= MAX_FAILED_ATTEMPTS) {
      return failForm('Too many failed sign-ins for this mailbox. Wait 15 minutes and try again.');
    }

    try {
      await (deps.verifyMailbox ?? defaultMailboxVerifier)(credentials);
    } catch {
      await env.KV.put(failureKey, String(failures + 1), { expirationTtl: FAILED_ATTEMPT_WINDOW_SECONDS });
      return failForm(
        'Gmail did not accept that address and App Password. Check both; an App Password is 16 letters from myaccount.google.com/apppasswords.',
      );
    }
    if (failures > 0) await env.KV.delete(failureKey);

    const requested = form.getAll('scope').map(String);
    const mailScope = MAIL_SCOPES.filter((candidate) => requested.includes(candidate));
    if (mailScope.length === 0) {
      return failForm('Choose at least one permission.');
    }
    const oidcScope = OIDC_SCOPES.filter((candidate) => candidate !== 'offline_access' || requested.includes('offline_access'));
    const scope = [...oidcScope, ...mailScope];

    const approved = await oauth.approveConsent(providerRequest, handle, { scope });
    const subject = await oauthSubjectFor(credentials.email);
    await vault.save(subject, credentials);

    const props: OAuthGrantProps = {
      source: 'oauth-grant',
      subject,
      email: credentials.email,
      ...(nonce ? { nonce } : {}),
    };
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: subject,
      metadata: { email: credentials.email },
      scope: approved.request.scope,
      props,
      revokeExistingGrants: false,
    });

    if (isFetchSubmit) {
      return jsonResult({ ok: true, redirectTo, email: credentials.email }, 200, approved.headers);
    }

    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (isFetchSubmit && error instanceof AuthorizationError) {
      if (error.redirectTo) {
        return jsonResult({ ok: true, redirectTo: error.redirectTo }, 200);
      }
      return jsonResult({ ok: false, error: error.description || 'The authorization request is invalid.' }, 400);
    }
    return authorizationFailure(error);
  }
}

/** Show the form again with an error. The handle is unconsumed, so the same browser can retry. */
async function rerender(
  providerRequest: Request,
  env: WorkerEnv,
  handle: string,
  message: string,
  nonce?: string,
  accountSlug?: string,
): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest: AuthRequest = await oauth.parseAuthRequest(providerRequest);
  const details: ConsentDescription = await oauth.describeConsent(authRequest);
  const scriptNonce = generateCspNonce();
  return page(
    consentPage(details, handle, { error: message, nonce, accountSlug, scriptNonce }),
    400,
    new Headers(),
    scriptNonce,
  );
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

interface ConsentPageOptions {
  error?: string;
  nonce?: string;
  accountSlug?: string;
  scriptNonce: string;
}

function buildLoopbackEnhanceScript(scriptNonce: string, accountSlug?: string): string {
  const slugLiteral = JSON.stringify(accountSlug ?? '').replace(/</g, '\\u003c');
  const js = `(function(){
var slug=${slugLiteral};
var form=document.getElementById("oauth-form");
var errBox=document.getElementById("oauth-error");
var card=document.getElementById("oauth-card");
if(!form||!card)return;
var lastDecision="approve";
var buttons=form.querySelectorAll("button[name=decision]");
for(var i=0;i<buttons.length;i++){
  buttons[i].addEventListener("click",function(){lastDecision=this.value||"approve";});
}
function showError(msg){
  if(!errBox)return;
  errBox.textContent=msg;
  errBox.hidden=false;
}
function renderConnected(email,redirectTo){
  document.title="Connected — XMAIL | Gmail";
  card.textContent="";
  card.setAttribute("role","status");
  card.style.textAlign="center";
  var brand=document.createElement("div");
  brand.className="brand-center";
  brand.innerHTML="<img src=\\"/favicon.svg\\" width=\\"44\\" height=\\"44\\" alt=\\"XMAIL | Gmail\\">";
  card.appendChild(brand);
  var badge=document.createElement("div");
  badge.className="done-badge";
  badge.innerHTML="<svg width=\\"26\\" height=\\"26\\" viewBox=\\"0 0 24 24\\" fill=\\"none\\" stroke=\\"currentColor\\" stroke-width=\\"2.5\\" stroke-linecap=\\"round\\" stroke-linejoin=\\"round\\" aria-hidden=\\"true\\"><path d=\\"M20 6 9 17l-5-5\\"/></svg>";
  card.appendChild(badge);
  var h1=document.createElement("h1");
  h1.textContent="Connected";
  card.appendChild(h1);
  if(email){
    var pill=document.createElement("div");
    pill.className="done-pill";
    pill.textContent=slug?email+" · Account "+slug:email;
    card.appendChild(pill);
  }
  var msg=document.createElement("p");
  msg.textContent="Completing sign-in and closing this window…";
  card.appendChild(msg);
  var actions=document.createElement("div");
  actions.className="done-actions";
  actions.hidden=true;
  card.appendChild(actions);
  function monitorPopup(pop){
    var start=Date.now();
    var finished=false;
    function finish(){
      if(finished)return;
      finished=true;
      try{if(pop&&!pop.closed)pop.close();}catch(_){}
      msg.textContent="Authentication complete. Closing window…";
      setTimeout(function(){
        try{window.close();}catch(_){}
        setTimeout(function(){
          msg.textContent="Authentication complete — you can close this tab and return to your app.";
          actions.textContent="";
          var closeBtn=document.createElement("button");
          closeBtn.type="button";
          closeBtn.className="deny";
          closeBtn.textContent="Close Window";
          closeBtn.addEventListener("click",function(){try{window.close();}catch(_){}});
          actions.appendChild(closeBtn);
          actions.hidden=false;
        },450);
      },350);
    }
    var iv=setInterval(function(){
      if(!pop||pop.closed){clearInterval(iv);finish();return;}
      var committed=false;
      try{var href=pop.location&&pop.location.href;if(href&&href!=="about:blank")committed=true;}catch(_){committed=true;}
      if(committed){clearInterval(iv);setTimeout(finish,150);return;}
      if(Date.now()-start>2500){clearInterval(iv);finish();}
    },30);
  }
  var pop=null;
  try{pop=window.open(redirectTo,"_blank","popup,width=120,height=80,left=9999,top=9999");}catch(_){pop=null;}
  if(pop){monitorPopup(pop);return;}
  h1.textContent="Finish Connecting";
  msg.textContent="Click below to deliver authorization to your desktop app.";
  var btn=document.createElement("button");
  btn.type="button";
  btn.className="allow";
  btn.textContent="Complete Sign-In";
  btn.addEventListener("click",function(){
    actions.hidden=true;
    h1.textContent="Connected";
    msg.textContent="Completing sign-in and closing this window…";
    var p2=null;
    try{p2=window.open(redirectTo,"_blank","popup,width=120,height=80,left=9999,top=9999");}catch(_){p2=null;}
    if(p2){monitorPopup(p2);}else{window.location.replace(redirectTo);}
  });
  actions.appendChild(btn);
  actions.hidden=false;
}
form.addEventListener("submit",function(ev){
  var submitter=ev.submitter;
  var decision=(submitter&&submitter.name==="decision"&&submitter.value)||lastDecision||"approve";
  if(decision!=="approve")return;
  ev.preventDefault();
  if(errBox)errBox.hidden=true;
  var fd=new FormData(form);
  fd.set("decision","approve");
  var allowBtn=form.querySelector("button.allow");
  var origLabel=allowBtn?allowBtn.textContent:"Allow";
  if(allowBtn){allowBtn.disabled=true;allowBtn.textContent="Verifying…";}
  fetch(window.location.href,{
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded","X-OAuth-Fetch":"1"},
    body:new URLSearchParams(fd).toString(),
    credentials:"same-origin"
  }).then(function(res){return res.json().then(function(body){return {status:res.status,body:body};});})
  .then(function(out){
    if(out.body&&out.body.ok&&typeof out.body.redirectTo==="string"){
      renderConnected(out.body.email||"",out.body.redirectTo);
      return;
    }
    if(allowBtn){allowBtn.disabled=false;allowBtn.textContent=origLabel;}
    showError((out.body&&out.body.error)||"Sign-in could not be completed.");
  }).catch(function(){
    if(allowBtn){allowBtn.disabled=false;allowBtn.textContent=origLabel;}
    showError("Network error while verifying credentials. Please try again.");
  });
});
})();`;
  return `<script nonce="${scriptNonce}">${js.replace(/\n\s*/g, '')}</script>`;
}

function consentPage(details: ConsentDescription, handle: string, opts: ConsentPageOptions): string {
  const name = escape(details.clientName || 'An application');
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : 'This app registered itself; its name is not verified.';
  const requested = details.scope.length > 0 ? details.scope : [...MAIL_SCOPES];
  const hasMailScope = MAIL_SCOPES.some((scope) => requested.includes(scope));
  const effectiveRequested = hasMailScope ? requested : [...requested, ...MAIL_SCOPES];
  const scopes = MAIL_SCOPES.map((scope) => `
        <label class="scope"><input type="checkbox" name="scope" value="${scope}"${effectiveRequested.includes(scope) ? ' checked' : ''}>
          <span><code>${scope}</code> ${escape(SCOPE_LABELS[scope])}</span></label>`).join('');
  const hiddenOffline = details.scope.includes('offline_access')
    ? '\n      <input type="hidden" name="scope" value="offline_access">'
    : '';
  const hiddenNonce = opts.nonce
    ? `\n      <input type="hidden" name="nonce" value="${escape(opts.nonce)}">`
    : '';
  const slotPill = opts.accountSlug
    ? `<span class="slot-pill">Account ${escape(opts.accountSlug)}</span>`
    : '';

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
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #090d16; color: #e2e8f0; margin: 0; padding: 32px 16px; line-height: 1.5; min-height: 100vh; box-sizing: border-box; display: flex; align-items: center; justify-content: center; }
    main { width: 100%; max-width: 480px; margin: 0 auto; background: #121827; border: 1px solid #1e293b; border-radius: 16px; padding: 28px; box-shadow: 0 20px 48px rgba(0,0,0,0.45); box-sizing: border-box; }
    .brand-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
    .brand-left { display: flex; align-items: center; gap: 10px; }
    .brand-eyebrow { font-size: 0.78rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #94a3b8; }
    .brand-center { display: flex; align-items: center; justify-content: center; margin: 0 auto 18px; }
    .slot-pill { background: rgba(234,67,53,0.16); border: 1px solid rgba(234,67,53,0.4); color: #fca5a5; font-size: 0.78rem; font-weight: 600; padding: 3px 10px; border-radius: 999px; }
    h1 { font-size: 1.35rem; margin: 0 0 8px; }
    p { color: #94a3b8; margin: 0 0 14px; }
    label { display: block; margin: 14px 0 4px; font-weight: 600; }
    input[type=email], input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid #334155; background: #0d121f; color: #e2e8f0; font-size: 1rem; }
    .scope { display: flex; gap: 10px; font-weight: 400; margin: 8px 0; color: #cbd5e1; }
    .error { background: rgba(234,67,53,0.15); border: 1px solid #ea4335; color: #fecaca; padding: 10px 12px; border-radius: 8px; }
    .warn { color: #fbbf24; }
    .actions { display: flex; gap: 12px; margin-top: 22px; }
    .done-actions { display: flex; flex-direction: column; gap: 10px; margin-top: 20px; }
    .done-badge { width: 52px; height: 52px; border-radius: 999px; margin: 0 auto 16px; background: rgba(16,185,129,0.14); border: 1px solid rgba(16,185,129,0.35); color: #10b981; display: flex; align-items: center; justify-content: center; }
    .done-pill { display: inline-flex; align-items: center; padding: 5px 12px; margin: 2px 0 14px; border-radius: 999px; background: #0d121f; border: 1px solid #334155; color: #e2e8f0; font-size: 0.86rem; font-weight: 600; }
    button { flex: 1; padding: 11px 16px; border-radius: 8px; border: 0; font-size: 1rem; font-weight: 600; cursor: pointer; }
    button:disabled { opacity: 0.7; cursor: wait; }
    .allow { background: #ea4335; color: #fff; }
    .deny { background: #1e293b; color: #e2e8f0; }
    code { background: #1e293b; padding: 1px 5px; border-radius: 4px; }
  </style>
</head>
<body>
  <main id="oauth-card">
    <div class="brand-row">
      <div class="brand-left">
        <img src="/favicon.svg" width="34" height="34" alt="XMAIL | Gmail">
        <span class="brand-eyebrow">XMAIL | Gmail</span>
      </div>
      ${slotPill}
    </div>
    <h1>Connect a Gmail mailbox to ${name}</h1>
    <p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
    ${details.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>' : ''}
    <p id="oauth-error" class="error" role="alert"${opts.error ? '' : ' hidden'}>${opts.error ? escape(opts.error) : ''}</p>
    <form id="oauth-form" method="post" autocomplete="off">
      <input type="hidden" name="handle" value="${escape(handle)}">${hiddenOffline}${hiddenNonce}
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
  ${details.redirectIsLoopback ? buildLoopbackEnhanceScript(opts.scriptNonce, opts.accountSlug) : ''}
</body>
</html>`;
}

function page(html: string, status: number, headers: Headers, scriptNonce: string): Response {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Frame-Options', 'DENY');
  // No form-action: browsers apply it to the redirect after the POST, which goes to the client.
  headers.set(
    'Content-Security-Policy',
    `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
  );
  return new Response(html, { status, headers });
}

function jsonResult(body: Record<string, unknown>, status: number, baseHeaders?: Headers): Response {
  const headers = new Headers(baseHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers });
}

function text(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}
