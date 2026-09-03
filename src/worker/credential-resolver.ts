import type { WorkerEnv, GmailAppPasswordCredentials } from '../types.js';
import { CredentialVault, CredentialVaultError } from './credential-vault.js';

const DEFAULT_IMAP_HOST = 'imap.gmail.com';
const DEFAULT_IMAP_PORT = 993;
const DEFAULT_SMTP_HOST = 'smtp.gmail.com';
const DEFAULT_SMTP_PORT = 465;

export type CredentialSource = 'vault' | 'legacy-headers' | 'static-secret' | 'none';

export interface ResolvedMailboxCredentials {
  credentials: GmailAppPasswordCredentials | null;
  source: CredentialSource;
}

export class CredentialResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialResolutionError';
  }
}

/** Resolve credentials only after the caller has been authenticated. */
export async function resolveMailboxCredentials(
  request: Request,
  env: WorkerEnv,
  subject: string,
): Promise<ResolvedMailboxCredentials> {
  const vault = await credentialVaultFromEnv(env);
  if (vault) {
    try {
      const credentials = await vault.load(subject);
      if (credentials) {
        return { credentials: withConnectionDefaults(credentials, env), source: 'vault' };
      }
    } catch (error) {
      if (error instanceof CredentialVaultError) {
        throw new CredentialResolutionError(
          'The linked mailbox credential record is unavailable or cannot be decrypted.',
        );
      }
      throw error;
    }
  }

  if (isEnabled(env.ALLOW_LEGACY_CREDENTIAL_HEADERS)) {
    const email = request.headers.get('X-Gmail-Email') || request.headers.get('X-OneCom-Email') || request.headers.get('X-Mailbox-User');
    const appPassword = request.headers.get('X-Gmail-App-Password') || request.headers.get('X-Gmail-Password') || request.headers.get('X-OneCom-Password') || request.headers.get('X-Mailbox-Password');
    if ((email && !appPassword) || (!email && appPassword)) {
      throw new CredentialResolutionError('Both mailbox credential headers (email and password) must be supplied together.');
    }
    if (email && appPassword) {
      return {
        credentials: withConnectionDefaults({ email, appPassword }, env),
        source: 'legacy-headers',
      };
    }
  }

  if (isEnabled(env.ALLOW_STATIC_MAILBOX)) {
    const email = env.GMAIL_EMAIL;
    const appPassword = env.GMAIL_APP_PASSWORD;
    if (email && appPassword) {
      return {
        credentials: withConnectionDefaults({ email, appPassword }, env),
        source: 'static-secret',
      };
    }
  }

  return { credentials: null, source: 'none' };
}

function withConnectionDefaults(
  credentials: { email: string; appPassword?: string; password?: string; imapHost?: string; imapPort?: number; smtpHost?: string; smtpPort?: number },
  env: WorkerEnv,
): GmailAppPasswordCredentials {
  return {
    email: credentials.email,
    appPassword: credentials.appPassword || credentials.password || '',
    imapHost: credentials.imapHost || env.GMAIL_IMAP_HOST || DEFAULT_IMAP_HOST,
    imapPort: credentials.imapPort ?? parsePort(env.GMAIL_IMAP_PORT, DEFAULT_IMAP_PORT),
    smtpHost: credentials.smtpHost || env.GMAIL_SMTP_HOST || DEFAULT_SMTP_HOST,
    smtpPort: credentials.smtpPort ?? parsePort(env.GMAIL_SMTP_PORT, DEFAULT_SMTP_PORT),
  };
}

export async function credentialVaultFromEnv(env: WorkerEnv): Promise<CredentialVault | null> {
  const configuredSecret = env.CREDENTIALS_MASTER_KEY;
  if (configuredSecret === undefined) return null;

  let secret: string;
  try {
    secret = typeof configuredSecret === 'string'
      ? configuredSecret
      : await configuredSecret.get();
  } catch {
    throw new CredentialResolutionError('The credential-vault master key binding is unavailable.');
  }

  try {
    return new CredentialVault(env.KV, secret);
  } catch (error) {
    if (error instanceof CredentialVaultError) {
      throw new CredentialResolutionError('The credential-vault master key is invalid.');
    }
    throw error;
  }
}


function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new CredentialResolutionError('The configured mailbox port is invalid.');
  }
  return parsed;
}

export function isEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}
