/**
 * Shared tool response helpers.
 *
 * xtnd-mcp-one repeats the try/catch envelope in each of its fifteen tools.
 * This package exposes closer to forty, so the envelope lives here instead:
 * one place that decides how a Gmail failure is phrased for the model.
 */

import { GmailApiError } from '../../core/gmail/rest.js';
import { MissingScopeError } from '../../core/auth/scopes.js';

export interface ToolResult {
  /** The SDK's callback contract allows arbitrary extra fields on a result. */
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** Serialise a successful payload as pretty JSON. */
export function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Run a tool body, converting any failure into a message the model can act on.
 *
 * Scope and quota failures are recoverable in different ways, so they are
 * phrased differently: a missing scope needs the user to re-consent, a 429
 * needs the caller to slow down, and everything else is reported verbatim.
 */
export async function run(operation: string, body: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await body());
  } catch (error: unknown) {
    return { content: [{ type: 'text', text: describe(operation, error) }], isError: true };
  }
}

function describe(operation: string, error: unknown): string {
  if (error instanceof MissingScopeError) {
    return `${operation} needs an OAuth scope this profile was not granted. ${error.message}`;
  }

  if (error instanceof GmailApiError) {
    if (error.status === 429) {
      return `${operation} was rate limited by Gmail after retries. Reduce the batch size or retry later.`;
    }
    return `${operation} failed: ${error.message}`;
  }

  const message = error instanceof Error ? error.message : 'Unknown failure.';
  return `${operation} failed: ${message}`;
}
