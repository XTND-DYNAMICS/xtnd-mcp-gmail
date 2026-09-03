/**
 * Gmail OAuth scope catalogue.
 *
 * Security boundary: the scope set granted at `mcp-gmail setup` is the hard
 * ceiling on what any tool can ever do. Tools that need a scope the active
 * profile does not hold fail closed with a re-consent instruction rather than
 * silently degrading.
 */

export const GMAIL_SCOPES = {
  /** Read messages, threads, labels, history, attachments and settings. */
  readonly: 'https://www.googleapis.com/auth/gmail.readonly',
  /** Create, update and delete drafts; send on the user's behalf. */
  compose: 'https://www.googleapis.com/auth/gmail.compose',
  /** Send messages only. Implied by compose but requested explicitly. */
  send: 'https://www.googleapis.com/auth/gmail.send',
  /** All read/write message and thread operations except permanent delete. */
  modify: 'https://www.googleapis.com/auth/gmail.modify',
  /** Create, update and delete labels. */
  labels: 'https://www.googleapis.com/auth/gmail.labels',
  /** Filters, forwarding addresses, send-as aliases, vacation responder, IMAP/POP. */
  settingsBasic: 'https://www.googleapis.com/auth/gmail.settings.basic',
  /** Delegates and send-as with custom SMTP. Google Workspace only. */
  settingsSharing: 'https://www.googleapis.com/auth/gmail.settings.sharing',
  /** Full mailbox access. The only scope permitting irreversible delete. */
  full: 'https://mail.google.com/',
} as const;

export type GmailScope = (typeof GMAIL_SCOPES)[keyof typeof GMAIL_SCOPES];

/**
 * Scopes requested by default. Covers every documented Gmail capability except
 * irreversible deletion, which requires `full` and is opt-in at setup time.
 */
export const DEFAULT_SCOPES: readonly GmailScope[] = [
  GMAIL_SCOPES.modify,
  GMAIL_SCOPES.compose,
  GMAIL_SCOPES.send,
  GMAIL_SCOPES.labels,
  GMAIL_SCOPES.settingsBasic,
  GMAIL_SCOPES.settingsSharing,
];

/**
 * Additional scope unlocked with `--allow-permanent-delete`. Grants
 * `messages.delete` and `threads.delete`, which bypass Trash and cannot be
 * undone. Never request this implicitly.
 */
export const PERMANENT_DELETE_SCOPES: readonly GmailScope[] = [GMAIL_SCOPES.full];

/** A scope grant satisfies a requirement if it is present, or if `full` is held. */
export function grantSatisfies(granted: readonly string[], required: GmailScope): boolean {
  if (granted.includes(GMAIL_SCOPES.full)) return true;
  if (granted.includes(required)) return true;

  // `modify` subsumes `readonly`; `compose` subsumes `send`.
  if (required === GMAIL_SCOPES.readonly) {
    return granted.includes(GMAIL_SCOPES.modify) || granted.includes(GMAIL_SCOPES.compose);
  }
  if (required === GMAIL_SCOPES.send) {
    return granted.includes(GMAIL_SCOPES.compose);
  }
  return false;
}

export class MissingScopeError extends Error {
  readonly required: GmailScope;

  constructor(required: GmailScope, operation: string) {
    super(
      `The active Gmail profile was not granted "${required}", which ${operation} requires. `
      + 'Re-run "mcp-gmail setup" for this profile to consent to the additional scope.',
    );
    this.name = 'MissingScopeError';
    this.required = required;
  }
}

/** Throw unless the granted scope set covers `required`. */
export function assertScope(
  granted: readonly string[],
  required: GmailScope,
  operation: string,
): void {
  if (!grantSatisfies(granted, required)) {
    throw new MissingScopeError(required, operation);
  }
}

/** Normalise a space-delimited scope string from a token response. */
export function parseScopeString(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/\s+/).filter((entry) => entry.length > 0);
}
