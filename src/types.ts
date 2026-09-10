/**
 * Shared types for @xtnd-dynamics/mcp-gmail
 */

/**
 * An OAuth2 installed-application credential plus the tokens obtained for one
 * mailbox. `refreshToken` is the long-lived secret; `accessToken` is a cache.
 */
export interface GmailCredentials {
  /** Mailbox address the tokens belong to, resolved from the userinfo/profile call. */
  email: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Cached bearer token. Absent or expired values are refreshed transparently. */
  accessToken?: string;
  /** Epoch milliseconds at which `accessToken` stops being valid. */
  accessTokenExpiresAt?: number;
  /** Scopes actually granted by the consent screen, not the ones requested. */
  scopes: string[];
}

export interface GmailAppPasswordCredentials {
  email: string;
  appPassword: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
}

export interface MailboxFolder {
  name: string;
  delimiter: string;
  flags: string[];
  totalMessages?: number;
  unreadMessages?: number;
}

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface GmailLabel {
  id: string;
  name: string;
  type: 'system' | 'user';
  messageListVisibility?: 'show' | 'hide';
  labelListVisibility?: 'labelShow' | 'labelShowIfUnread' | 'labelHide';
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
  color?: GmailLabelColor;
}

export interface GmailLabelColor {
  textColor?: string;
  backgroundColor?: string;
}

export interface EmailAttachment {
  attachmentId?: string;
  filename: string;
  contentType: string;
  size: number;
  contentId?: string;
  dataBase64?: string;
}

export interface EmailHeaderSummary {
  id: string;
  threadId: string;
  historyId?: string;
  messageId: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  replyTo?: EmailAddress[];
  subject: string;
  date: string;
  internalDate?: string;
  snippet?: string;
  labelIds: string[];
  sizeEstimate?: number;
  hasAttachments: boolean;
  inReplyTo?: string;
  references?: string;
}

export interface EmailDetail extends EmailHeaderSummary {
  bodyText?: string;
  bodyHtml?: string;
  bodyMarkdown?: string;
  attachments?: EmailAttachment[];
  /** Full RFC 822 source, only populated when the caller asks for `raw`. */
  raw?: string;
}

export interface GmailThread {
  id: string;
  historyId?: string;
  snippet?: string;
  messages: EmailDetail[];
}

export interface GmailDraft {
  id: string;
  /** Full detail when fetched by ID; body fields are absent in list results. */
  message: EmailDetail;
}

export interface SearchOptions {
  /** Native Gmail search syntax, e.g. `from:a@b.com is:unread newer_than:7d`. */
  query?: string;
  labelIds?: string[];
  includeSpamTrash?: boolean;
  limit?: number;
  pageToken?: string;
}

export interface PagedResult<T> {
  items: T[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface OutboundAttachment {
  filename: string;
  contentType?: string;
  dataBase64?: string;
  filePath?: string;
}

export interface AttachedEmail {
  filename?: string;
  rawEml: string;
}

export interface SendEmailOptions {
  from?: string;
  to: string[] | string;
  cc?: string[] | string;
  bcc?: string[] | string;
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
  attachments?: (string | OutboundAttachment)[];
  attachEmailUids?: (string | number)[];
  attachedEmails?: AttachedEmail[];
}

export interface CreateDraftOptions {
  from?: string;
  to?: string[] | string;
  cc?: string[] | string;
  bcc?: string[] | string;
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
  attachments?: (string | OutboundAttachment)[];
  attachEmailUids?: (string | number)[];
  attachedEmails?: AttachedEmail[];
}

export interface UpdateDraftOptions extends CreateDraftOptions {
  draftId: string;
}

export interface ModifyLabelsOptions {
  addLabelIds?: string[];
  removeLabelIds?: string[];
}

export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}

export interface GmailFilter {
  id?: string;
  criteria: {
    from?: string;
    to?: string;
    subject?: string;
    query?: string;
    negatedQuery?: string;
    hasAttachment?: boolean;
    excludeChats?: boolean;
    size?: number;
    sizeComparison?: 'unspecified' | 'smaller' | 'larger';
  };
  action: {
    addLabelIds?: string[];
    removeLabelIds?: string[];
    forward?: string;
  };
}

export interface SendAsAlias {
  sendAsEmail: string;
  displayName?: string;
  replyToAddress?: string;
  signature?: string;
  isPrimary?: boolean;
  isDefault?: boolean;
  treatAsAlias?: boolean;
  verificationStatus?: string;
}

export interface VacationSettings {
  enableAutoReply: boolean;
  responseSubject?: string;
  responseBodyPlainText?: string;
  responseBodyHtml?: string;
  restrictToContacts?: boolean;
  restrictToDomain?: boolean;
  startTime?: string;
  endTime?: string;
}

export interface ForwardingAddress {
  forwardingEmail: string;
  verificationStatus?: string;
}

export interface AutoForwarding {
  enabled: boolean;
  emailAddress?: string;
  disposition?: 'leaveInInbox' | 'archive' | 'trash' | 'markRead';
}

export interface Delegate {
  delegateEmail: string;
  verificationStatus?: string;
}

export interface HistoryRecord {
  id: string;
  messagesAdded?: string[];
  messagesDeleted?: string[];
  labelsAdded?: { messageId: string; labelIds: string[] }[];
  labelsRemoved?: { messageId: string; labelIds: string[] }[];
}

export interface WorkerKeyValueStore {
  get(key: string, type?: 'text' | 'json' | 'arrayBuffer' | 'stream'): Promise<any>;
  put(key: string, value: string | ArrayBuffer | ReadableStream, options?: { expirationTtl?: number; metadata?: any }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface WorkerSecretBinding {
  get(): Promise<string>;
}

export interface WorkerEnv {
  KV: WorkerKeyValueStore;
  CREDENTIALS_MASTER_KEY?: string | WorkerSecretBinding;
  GMAIL_IMAP_HOST?: string;
  GMAIL_IMAP_PORT?: string;
  GMAIL_SMTP_HOST?: string;
  GMAIL_SMTP_PORT?: string;
  GMAIL_EMAIL?: string;
  GMAIL_APP_PASSWORD?: string;
  API_KEYS_SHA256?: string;
  ALLOWED_ORIGINS?: string;
  ALLOW_LEGACY_CREDENTIAL_HEADERS?: string;
  ALLOW_STATIC_MAILBOX?: string;
  ENABLE_LEGACY_SSE?: string;
  OAUTH_AUTHORIZATION_SERVER?: string;
  OAUTH_INTROSPECTION_URL?: string;
  OAUTH_CLIENT_ID?: string | WorkerSecretBinding;
  OAUTH_CLIENT_SECRET?: string | WorkerSecretBinding;
  OAUTH_AUDIENCE?: string;
  OAUTH_RESOURCE_DOCUMENTATION?: string;
}
