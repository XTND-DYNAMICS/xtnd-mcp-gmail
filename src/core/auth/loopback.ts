/**
 * Interactive OAuth consent over a loopback redirect.
 *
 * Runtime boundary: Node only. The Worker never runs an interactive flow, so
 * this module is imported by the CLI alone and is kept out of the edge bundle.
 *
 * Google's installed-application flow requires a redirect URI it can reach.
 * A listener bound to 127.0.0.1 on an ephemeral port is the documented choice
 * for desktop clients and keeps the authorization code off any network hop.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import {
  buildAuthorizationUrl,
  createPkcePair,
  createStateToken,
  exchangeAuthorizationCode,
  type TokenSet,
} from './oauth.js';

/** Abandon the flow rather than leaving a listener bound indefinitely. */
const CONSENT_TIMEOUT_MS = 5 * 60_000;

export interface ConsentOptions {
  clientId: string;
  clientSecret: string;
  scopes: readonly string[];
  loginHint?: string;
  /** Receives the consent URL so the CLI can print it if the browser fails. */
  onAuthorizationUrl?: (url: string) => void;
}

export async function runLoopbackConsent(options: ConsentOptions): Promise<TokenSet> {
  const { verifier, challenge } = await createPkcePair();
  const state = createStateToken();

  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${port}`;

  const authorizationUrl = buildAuthorizationUrl({
    clientId: options.clientId,
    redirectUri,
    scopes: options.scopes,
    codeChallenge: challenge,
    state,
    loginHint: options.loginHint,
  });

  options.onAuthorizationUrl?.(authorizationUrl);
  openInBrowser(authorizationUrl);

  try {
    const code = await waitForAuthorizationCode(server, state);
    return await exchangeAuthorizationCode({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      code,
      codeVerifier: verifier,
      redirectUri,
    });
  } finally {
    server.close();
  }
}

function waitForAuthorizationCode(
  server: ReturnType<typeof createServer>,
  expectedState: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for Google consent. Re-run the command to try again.'));
    }, CONSENT_TIMEOUT_MS);

    const onRequest = (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      const error = url.searchParams.get('error');
      if (error) {
        respond(response, 400, 'Consent was denied. You can close this tab.');
        cleanup();
        reject(new Error(`Google consent was denied (${error}).`));
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      if (!code || !state) {
        // Browsers request /favicon.ico against the loopback listener; ignore
        // anything that is not the redirect itself.
        respond(response, 404, 'Not found.');
        return;
      }

      // A mismatched state means the redirect did not originate from the
      // request this process started. Refuse it rather than exchanging it.
      if (state !== expectedState) {
        respond(response, 400, 'State mismatch. You can close this tab.');
        cleanup();
        reject(new Error('The consent redirect carried an unexpected state value and was rejected.'));
        return;
      }

      respond(response, 200, 'Gmail is connected. You can close this tab and return to the terminal.');
      cleanup();
      resolve(code);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      server.off('request', onRequest);
    };

    server.on('request', onRequest);
  });
}

function respond(response: ServerResponse, status: number, message: string): void {
  const body = `<!doctype html><meta charset="utf-8"><title>xtnd-mcp-gmail</title>`
    + `<body style="font:16px system-ui;padding:3rem;max-width:32rem">${message}</body>`;
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

/**
 * Best-effort browser launch. A failure is not fatal: the CLI has already
 * printed the URL, so the user can open it themselves.
 */
function openInBrowser(url: string): void {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];

  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // Ignored: the URL was printed to stderr before this call.
  }
}
