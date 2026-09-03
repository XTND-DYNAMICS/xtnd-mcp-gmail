#!/usr/bin/env node
/**
 * CLI entrypoint for local stdio transport and one-time OAuth setup.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { GmailClient } from './core/client.js';
import { runLoopbackConsent } from './core/auth/loopback.js';
import { revokeToken } from './core/auth/oauth.js';
import { DEFAULT_SCOPES, GMAIL_SCOPES, PERMANENT_DELETE_SCOPES } from './core/auth/scopes.js';
import { LocalProfileStore } from './credentials/local-profile-store.js';
import { createGmailMcpServer } from './mcp/server.js';
import type { GmailCredentials } from './types.js';

const DEFAULT_PROFILE = 'default';

interface ParsedOptions {
  profile?: string;
  clientId?: string;
  clientSecret?: string;
  email?: string;
  allowPermanentDelete: boolean;
  select: boolean;
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const command = args[0];

  if (command === 'setup') return setupProfile(args.slice(1));
  if (command === 'accounts' || command === 'profiles') return manageProfiles(args.slice(1));
  if (command === 'status') return printStatus(args.slice(1));
  if (command === 'help' || command === '--help' || command === '-h') return printHelp();

  return runStdioServer(command === 'serve' ? args.slice(1) : args);
}

async function setupProfile(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const store = new LocalProfileStore();
  const profileName = options.profile ?? DEFAULT_PROFILE;

  const clientId = options.clientId
    ?? process.env.GMAIL_OAUTH_CLIENT_ID
    ?? await promptLine('Google OAuth client ID: ');
  const clientSecret = options.clientSecret
    ?? process.env.GMAIL_OAUTH_CLIENT_SECRET
    ?? await promptHidden('Google OAuth client secret: ');

  if (!clientId || !clientSecret) {
    throw new Error(
      'A Google Cloud OAuth client of type "Desktop app" is required. Create one at '
      + 'https://console.cloud.google.com/apis/credentials with the Gmail API enabled.',
    );
  }

  const scopes = options.allowPermanentDelete
    ? [...DEFAULT_SCOPES, ...PERMANENT_DELETE_SCOPES]
    : DEFAULT_SCOPES;

  if (options.allowPermanentDelete) {
    process.stderr.write(
      'Requesting full mailbox scope so permanent deletion is possible. '
      + 'Deletions made with it bypass Trash and cannot be undone.\n',
    );
  }

  process.stderr.write('Opening Google consent in your browser...\n');

  const tokens = await runLoopbackConsent({
    clientId,
    clientSecret,
    scopes,
    loginHint: options.email,
    onAuthorizationUrl: (url) => {
      process.stderr.write(`If the browser did not open, visit:\n${url}\n`);
    },
  });

  if (!tokens.refreshToken) {
    throw new Error(
      'Google returned no refresh token. Remove this app from '
      + 'https://myaccount.google.com/permissions and run setup again.',
    );
  }

  // The mailbox address is not in the token response, so ask Gmail who we are
  // before saving. This also proves the grant actually works.
  const provisional: GmailCredentials = {
    email: 'pending@invalid',
    clientId,
    clientSecret,
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.expiresAt,
    scopes: tokens.scopes.length > 0 ? tokens.scopes : [...scopes],
  };

  const profile = await new GmailClient(provisional).getProfile();
  const credentials: GmailCredentials = { ...provisional, email: profile.emailAddress };

  const saved = await store.save(profileName, credentials, { select: options.select });

  process.stdout.write(`Saved Gmail profile "${saved.name}" for ${saved.email}.\n`);
  process.stdout.write(`Credential file: ${store.credentialsFile}\n`);
  process.stdout.write(
    'Storage model: filesystem-protected plaintext (private directory and mode 0600 file); '
    + 'no Keychain is used.\n',
  );
  process.stdout.write(`Granted scopes:\n${saved.scopes.map((scope) => `  ${scope}`).join('\n')}\n`);
  if (saved.scopes.includes(GMAIL_SCOPES.full)) {
    process.stdout.write('Permanent deletion is ENABLED for this profile.\n');
  }
  if (saved.active) {
    process.stdout.write('This profile is now active and will be reused automatically.\n');
  }
}

async function manageProfiles(args: string[]): Promise<void> {
  const action = args[0] ?? 'list';
  const store = new LocalProfileStore();

  if (action === 'list') {
    const profiles = await store.list();
    if (profiles.length === 0) {
      process.stdout.write('No saved Gmail profiles. Run: mcp-gmail setup\n');
      return;
    }
    for (const profile of profiles) {
      process.stdout.write(`${profile.active ? '* ' : '  '}${profile.name}  ${profile.email}\n`);
    }
    return;
  }

  const profileName = args[1];
  if (!profileName || args.length > 2) {
    throw new Error(`Usage: mcp-gmail accounts ${action} <profile>`);
  }

  if (action === 'use' || action === 'select') {
    const selected = await store.select(profileName);
    process.stdout.write(`Active Gmail profile: ${selected.name} (${selected.email})\n`);
    return;
  }

  if (action === 'remove' || action === 'delete') {
    // Revoke before deleting: a refresh token left live at Google would keep
    // working for anyone who recovered the file.
    const credentials = await store.load(profileName);
    if (credentials) {
      try {
        await revokeToken(credentials.refreshToken);
        process.stdout.write('Revoked the OAuth grant at Google.\n');
      } catch {
        process.stderr.write(
          'Warning: the grant could not be revoked at Google. Remove it manually at '
          + 'https://myaccount.google.com/permissions\n',
        );
      }
    }

    const removed = await store.remove(profileName);
    if (!removed) {
      throw new Error(`No saved Gmail profile named "${profileName}" exists.`);
    }
    process.stdout.write(`Removed local Gmail profile "${profileName}".\n`);
    return;
  }

  throw new Error('Usage: mcp-gmail accounts <list|use|remove> [profile]');
}

async function printStatus(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const store = new LocalProfileStore();
  const requestedProfile = options.profile ?? process.env.MCP_GMAIL_PROFILE;
  const credentials = await store.load(requestedProfile);
  const activeName = requestedProfile ?? await store.getActiveProfileName();

  if (!credentials || !activeName) {
    process.stdout.write('Credential source: not configured. Run: mcp-gmail setup\n');
    return;
  }

  process.stdout.write(`Credential source: local profile "${activeName}" (${credentials.email})\n`);
  process.stdout.write(`Credential file: ${store.credentialsFile}\n`);
  process.stdout.write(`Granted scopes:\n${credentials.scopes.map((s) => `  ${s}`).join('\n')}\n`);
  process.stdout.write(
    `Permanent deletion: ${credentials.scopes.includes(GMAIL_SCOPES.full) ? 'enabled' : 'disabled'}\n`,
  );
}

import { AppPasswordGmailClient } from './core/app-password-client.js';
import { createAppPasswordGmailMcpServer } from './mcp/app-password-server.js';

async function runStdioServer(args: string[]): Promise<void> {
  // 1. Check for Direct App Password Credentials in Environment
  const email = process.env.GMAIL_EMAIL || process.env.ONECOM_EMAIL;
  const appPassword = process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_PASSWORD || process.env.ONECOM_PASSWORD;

  if (email && appPassword) {
    const imapHost = process.env.GMAIL_IMAP_HOST || 'imap.gmail.com';
    const imapPort = parseInt(process.env.GMAIL_IMAP_PORT || '993', 10);
    const smtpHost = process.env.GMAIL_SMTP_HOST || 'smtp.gmail.com';
    const smtpPort = parseInt(process.env.GMAIL_SMTP_PORT || '465', 10);

    const client = new AppPasswordGmailClient({
      email,
      appPassword,
      imapHost,
      imapPort,
      smtpHost,
      smtpPort,
    });
    const server = createAppPasswordGmailMcpServer(() => client);
    await server.connect(new StdioServerTransport());
    return;
  }

  // 2. Check for OAuth2 Stored Profile
  const options = parseOptions(args);
  const store = new LocalProfileStore();
  const profileName = options.profile ?? process.env.MCP_GMAIL_PROFILE;
  const credentials = await store.load(profileName);

  if (!credentials) {
    throw new Error(
      'No Gmail account is configured. Either provide GMAIL_EMAIL and GMAIL_APP_PASSWORD, '
      + 'or run "npx -y @xtnd-dynamics/mcp-gmail setup" once.',
    );
  }

  const activeName = profileName ?? await store.getActiveProfileName();
  const allowPermanentDelete = credentials.scopes.includes(GMAIL_SCOPES.full);

  // Persist refreshed access tokens so the next process start skips a refresh
  // round trip. A write failure must not take the server down.
  const client = new GmailClient(credentials, {
    allowPermanentDelete,
    onTokenRefreshed: async (updated) => {
      if (!activeName) return;
      try {
        await store.save(activeName, updated, { select: false });
      } catch {
        // Non-fatal: the in-memory token remains valid for this process.
      }
    },
  });

  const server = createGmailMcpServer(() => client);
  await server.connect(new StdioServerTransport());
}

function parseOptions(args: string[]): ParsedOptions {
  const options: ParsedOptions = { allowPermanentDelete: false, select: true };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--profile') {
      options.profile = requiredOptionValue(args, ++index, '--profile');
    } else if (argument === '--client-id') {
      options.clientId = requiredOptionValue(args, ++index, '--client-id');
    } else if (argument === '--client-secret') {
      options.clientSecret = requiredOptionValue(args, ++index, '--client-secret');
    } else if (argument === '--email') {
      options.email = requiredOptionValue(args, ++index, '--email');
    } else if (argument === '--allow-permanent-delete') {
      options.allowPermanentDelete = true;
    } else if (argument === '--no-select') {
      options.select = false;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  return options;
}

function requiredOptionValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

async function promptLine(prompt: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      'Interactive setup requires a terminal. Supply --client-id and --client-secret, or set '
      + 'GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET.',
    );
  }
  const reader = createInterface({ input, output });
  try {
    return (await reader.question(prompt)).trim();
  } finally {
    reader.close();
  }
}

async function promptHidden(prompt: string): Promise<string> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('A terminal is required for hidden entry. Use --client-secret for automation.');
  }

  output.write(prompt);
  const previousRawMode = input.isRaw;
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');

  return new Promise<string>((resolveSecret, rejectSecret) => {
    let secret = '';
    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode(previousRawMode ?? false);
      input.pause();
      output.write('\n');
    };
    const onData = (chunk: string | Buffer) => {
      for (const character of chunk.toString()) {
        if (character === '\u0003') {
          cleanup();
          rejectSecret(new Error('Setup cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolveSecret(secret);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          if (secret.length > 0) {
            secret = secret.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        if (character >= ' ') {
          secret += character;
          output.write('*');
        }
      }
    };
    input.on('data', onData);
  });
}

function printHelp(): void {
  process.stdout.write('XTND MCP GMAIL\n\n');
  process.stdout.write('  mcp-gmail setup [--profile NAME] [--client-id ID] [--client-secret SECRET]\n');
  process.stdout.write('                  [--email ADDRESS] [--allow-permanent-delete]\n');
  process.stdout.write('  mcp-gmail accounts list\n');
  process.stdout.write('  mcp-gmail accounts use NAME\n');
  process.stdout.write('  mcp-gmail accounts remove NAME\n');
  process.stdout.write('  mcp-gmail status [--profile NAME]\n');
  process.stdout.write('  mcp-gmail serve [--profile NAME]\n\n');
  process.stdout.write('With no command, the local MCP stdio server starts using the active profile.\n');
  process.stdout.write('Setup needs a Google Cloud OAuth client of type "Desktop app" with the Gmail\n');
  process.stdout.write('API enabled. GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET are honoured\n');
  process.stdout.write('as automation overrides.\n');
}

function isDirectInvocation(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown CLI failure.';
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
}
