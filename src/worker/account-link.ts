import { AppPasswordGmailClient } from '../core/app-password-client.js';
import type { GmailAppPasswordCredentials, WorkerEnv } from '../types.js';
import type { AuthenticatedPrincipal } from './auth.js';
import { CredentialVaultError } from './credential-vault.js';
import { credentialVaultFromEnv, CredentialResolutionError } from './credential-resolver.js';
import { readRequestJson, RequestBodyTooLargeError } from './request-body.js';

const MAX_LINK_REQUEST_BYTES = 16_384;
type MailboxVerifier = (credentials: GmailAppPasswordCredentials) => Promise<void>;

async function defaultMailboxVerifier(credentials: GmailAppPasswordCredentials): Promise<void> {
  const client = new AppPasswordGmailClient(credentials);
  await client.listFolders();
}

export async function handleAccountLinkRoute(
  request: Request,
  env: WorkerEnv,
  principal: AuthenticatedPrincipal,
  verifyMailbox: MailboxVerifier = defaultMailboxVerifier,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== '/api/accounts/link' && path !== '/api/accounts/status') return null;

  try {
    if (path === '/api/accounts/status' && request.method === 'GET') {
      return accountStatus(env, principal.subject);
    }

    if (path === '/api/accounts/link' && (request.method === 'POST' || request.method === 'PUT')) {
      return linkAccount(request, env, principal.subject, verifyMailbox);
    }

    if (path === '/api/accounts/link' && request.method === 'DELETE') {
      return unlinkAccount(env, principal.subject);
    }

    return json({ error: 'Method Not Allowed' }, 405, { Allow: path.endsWith('/status') ? 'GET' : 'POST, PUT, DELETE' });
  } catch (error) {
    if (error instanceof CredentialResolutionError || error instanceof CredentialVaultError) {
      return vaultFailure(error);
    }
    throw error;
  }
}

async function accountStatus(env: WorkerEnv, subject: string): Promise<Response> {
  const vault = await credentialVaultFromEnv(env);
  if (!vault) {
    return json({ linked: false, vaultAvailable: false });
  }

  try {
    const credentials = await vault.load(subject);
    return json({
      linked: credentials !== null,
      vaultAvailable: true,
      ...(credentials ? { email: credentials.email } : {}),
    });
  } catch (error) {
    return vaultFailure(error);
  }
}

async function linkAccount(
  request: Request,
  env: WorkerEnv,
  subject: string,
  verifyMailbox: MailboxVerifier,
): Promise<Response> {
  let rawBody: unknown;
  try {
    rawBody = await readRequestJson(request, MAX_LINK_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return json({ error: 'The account-link request is too large.' }, 413);
    }
    return json({ error: 'The account-link request must contain valid JSON.' }, 400);
  }

  let credentials: GmailAppPasswordCredentials;
  try {
    credentials = parseLinkCredentials(rawBody, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The mailbox credentials are invalid.';
    return json({ error: message }, 400);
  }

  const vault = await credentialVaultFromEnv(env);
  if (!vault) {
    return json(
      { error: 'The hosted credential vault is not configured. Set CREDENTIALS_MASTER_KEY as a Worker secret.' },
      503,
    );
  }

  try {
    // Validate before writing.
    await verifyMailbox(credentials);
  } catch {
    return json(
      { error: 'Mailbox verification failed. Check the Gmail address and App Password; nothing was saved.' },
      422,
    );
  }

  try {
    await vault.save(subject, credentials);
    return json({ linked: true, email: credentials.email }, 201);
  } catch (error) {
    return vaultFailure(error);
  }
}

async function unlinkAccount(env: WorkerEnv, subject: string): Promise<Response> {
  const vault = await credentialVaultFromEnv(env);
  if (!vault) {
    return json({ linked: false, vaultAvailable: false });
  }

  try {
    await vault.delete(subject);
    return json({ linked: false, removed: true });
  } catch (error) {
    return vaultFailure(error);
  }
}

function parseLinkCredentials(value: unknown, env: WorkerEnv): GmailAppPasswordCredentials {
  if (!isRecord(value)) throw new Error('The mailbox credentials must be a JSON object.');
  const allowedKeys = new Set(['email', 'password', 'appPassword', 'imapHost', 'imapPort', 'smtpHost', 'smtpPort']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error('The account-link request contains unsupported fields.');
  }

  const rawEmail = value.email;
  const password = typeof value.appPassword === 'string' ? value.appPassword : value.password;
  let email: string;
  if (typeof rawEmail !== 'string' || !rawEmail.includes('@')) {
    throw new Error('Invalid email address format.');
  }
  email = rawEmail.trim().toLowerCase();
  if (
    typeof password !== 'string'
    || password.length === 0
    || password.length > 4_096
    || /[\u0000\r\n]/.test(password)
  ) {
    throw new Error('The mailbox password is empty or contains unsupported control characters.');
  }

  const imapHost = env.GMAIL_IMAP_HOST ?? 'imap.gmail.com';
  const smtpHost = env.GMAIL_SMTP_HOST ?? 'smtp.gmail.com';
  const imapPort = configuredPort(env.GMAIL_IMAP_PORT, 993);
  const smtpPort = configuredPort(env.GMAIL_SMTP_PORT, 465);

  if (value.imapHost !== undefined && value.imapHost !== imapHost) {
    throw new Error(`This gateway only permits the configured IMAP host (${imapHost}).`);
  }
  if (value.smtpHost !== undefined && value.smtpHost !== smtpHost) {
    throw new Error(`This gateway only permits the configured SMTP host (${smtpHost}).`);
  }
  if (value.imapPort !== undefined && value.imapPort !== imapPort) {
    throw new Error(`This gateway only permits the configured IMAP port (${imapPort}).`);
  }
  if (value.smtpPort !== undefined && value.smtpPort !== smtpPort) {
    throw new Error(`This gateway only permits the configured SMTP port (${smtpPort}).`);
  }

  return { email: email.trim().toLowerCase(), appPassword: password, imapHost, imapPort, smtpHost, smtpPort };
}

function configuredPort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('The gateway mailbox port configuration is invalid.');
  }
  return port;
}

function vaultFailure(error: unknown): Response {
  if (error instanceof CredentialVaultError || error instanceof CredentialResolutionError) {
    return json({ error: 'The hosted credential vault is unavailable.' }, 503);
  }
  throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function json(
  body: Record<string, unknown>,
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
