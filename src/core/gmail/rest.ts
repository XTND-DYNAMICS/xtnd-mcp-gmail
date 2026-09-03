/**
 * Minimal Gmail REST transport.
 *
 * Runtime boundary: `fetch` only, so the same client serves the stdio CLI and
 * the Worker. No googleapis dependency is pulled in; the Gmail surface used by
 * this package is small enough to address directly and keeping it dependency
 * free is what lets the Worker bundle stay inside its size budget.
 *
 * Security boundary: request bodies and Authorization headers are never
 * logged. Errors carry the Google `reason` and HTTP status, never the token.
 */

import { accessTokenIsStale, refreshAccessToken } from '../auth/oauth.js';
import type { GmailCredentials } from '../../types.js';

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';

/** Retry budget for 429 and 5xx, which Gmail returns under per-user quota. */
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 400;

export class GmailApiError extends Error {
  readonly status: number;
  readonly reason?: string;

  constructor(message: string, status: number, reason?: string) {
    super(message);
    this.name = 'GmailApiError';
    this.status = status;
    this.reason = reason;
  }
}

export interface GmailRestClientOptions {
  /**
   * Invoked whenever a refreshed access token is obtained, so the caller can
   * persist it and avoid a refresh round trip on the next process start.
   */
  onTokenRefreshed?: (credentials: GmailCredentials) => void | Promise<void>;
  /** Overridable for tests. */
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | string[] | undefined>;
  body?: unknown;
  /** Suppresses JSON parsing for endpoints that answer 204 No Content. */
  expectEmpty?: boolean;
}

export class GmailRestClient {
  private credentials: GmailCredentials;
  private readonly options: GmailRestClientOptions;
  private readonly fetchImpl: typeof fetch;
  private refreshInFlight: Promise<void> | null = null;

  constructor(credentials: GmailCredentials, options: GmailRestClientOptions = {}) {
    this.credentials = { ...credentials, scopes: [...credentials.scopes] };
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Scopes the active grant actually holds. Used for fail-closed checks. */
  get grantedScopes(): readonly string[] {
    return this.credentials.scopes;
  }

  get mailbox(): string {
    return this.credentials.email;
  }

  /** Issue an authenticated Gmail API call against the `me` mailbox. */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = buildUrl(path, options.query);

    for (let attempt = 0; ; attempt += 1) {
      await this.ensureFreshAccessToken();

      const response = await this.fetchImpl(url, {
        method: options.method ?? 'GET',
        headers: this.buildHeaders(options.body !== undefined),
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });

      if (response.ok) {
        if (options.expectEmpty || response.status === 204) {
          return undefined as T;
        }
        return (await response.json()) as T;
      }

      // A 401 after a proactive refresh means the token was revoked mid-flight.
      // Force one refresh and retry; a second 401 is a real authorization loss.
      if (response.status === 401 && attempt === 0) {
        this.credentials.accessToken = undefined;
        this.credentials.accessTokenExpiresAt = undefined;
        continue;
      }

      if (shouldRetry(response.status) && attempt < MAX_RETRIES) {
        await delay(backoffDelayMs(attempt, response));
        continue;
      }

      throw await toApiError(response);
    }
  }

  /**
   * Fetch a binary attachment. Gmail returns it base64url encoded inside a
   * JSON envelope rather than as a byte stream.
   */
  async getAttachmentData(messageId: string, attachmentId: string): Promise<string> {
    const payload = await this.request<{ data?: string; size?: number }>(
      `/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
    return payload.data ?? '';
  }

  private buildHeaders(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.credentials.accessToken}`,
      accept: 'application/json',
    };
    if (hasBody) {
      headers['content-type'] = 'application/json';
    }
    return headers;
  }

  /**
   * Refresh the cached access token when needed. Concurrent callers share a
   * single refresh so a burst of tool calls cannot trigger a token stampede.
   */
  private async ensureFreshAccessToken(): Promise<void> {
    if (!accessTokenIsStale(this.credentials.accessTokenExpiresAt) && this.credentials.accessToken) {
      return;
    }

    if (this.refreshInFlight) {
      await this.refreshInFlight;
      return;
    }

    this.refreshInFlight = (async () => {
      const tokens = await refreshAccessToken({
        clientId: this.credentials.clientId,
        clientSecret: this.credentials.clientSecret,
        refreshToken: this.credentials.refreshToken,
      });

      this.credentials = {
        ...this.credentials,
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: tokens.expiresAt,
        // A refresh response repeats the granted scopes; trust it over the
        // value stored at consent time so a revoked scope is noticed.
        scopes: tokens.scopes.length > 0 ? tokens.scopes : this.credentials.scopes,
      };

      await this.options.onTokenRefreshed?.({ ...this.credentials });
    })();

    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }
}

function buildUrl(
  path: string,
  query: Record<string, string | number | boolean | string[] | undefined> = {},
): string {
  const url = new URL(`${GMAIL_API_BASE}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        url.searchParams.append(key, entry);
      }
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function shouldRetry(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function backoffDelayMs(attempt: number, response: Response): number {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1_000, 20_000);
  }
  // Exponential with jitter, so parallel tool calls do not resynchronise.
  return BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * BASE_BACKOFF_MS);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function toApiError(response: Response): Promise<GmailApiError> {
  const payload = (await response.json().catch(() => ({}))) as {
    error?: { message?: string; errors?: { reason?: string }[] };
  };

  const reason = payload.error?.errors?.[0]?.reason;
  const message = payload.error?.message ?? `HTTP ${response.status}`;

  if (response.status === 403 && reason === 'insufficientPermissions') {
    return new GmailApiError(
      'Gmail rejected the call for insufficient OAuth scope. Re-run "mcp-gmail setup" to grant the '
      + 'scope this operation needs.',
      response.status,
      reason,
    );
  }

  if (response.status === 404) {
    return new GmailApiError(
      `Gmail could not find the requested resource. It may have been deleted or belongs to another mailbox. (${message})`,
      response.status,
      reason,
    );
  }

  return new GmailApiError(`Gmail API error: ${message}`, response.status, reason);
}
