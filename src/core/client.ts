/**
 * GmailClient — the single facade the MCP tools call.
 *
 * Mirrors the OneMailClient role in xtnd-mcp-one: transport and parsing live
 * below this layer, tool wiring lives above it, and every scope check happens
 * here so no tool can reach the API without one.
 */

import { GmailRestClient, type GmailRestClientOptions } from './gmail/rest.js';
import { parseMessage, type GmailMessageResource } from './parser/payload.js';
import {
  buildReplyHeaders,
  composeMimeMessage,
  forwardSubject,
  replySubject,
  toGmailRaw,
} from './parser/rfc822.js';
import { GMAIL_SCOPES, assertScope } from './auth/scopes.js';
import type {
  AttachedEmail,
  AutoForwarding,
  Delegate,
  EmailDetail,
  EmailHeaderSummary,
  ForwardingAddress,
  GmailCredentials,
  GmailDraft,
  GmailFilter,
  GmailLabel,
  GmailProfile,
  GmailThread,
  HistoryRecord,
  ModifyLabelsOptions,
  PagedResult,
  SearchOptions,
  SendAsAlias,
  SendEmailOptions,
  VacationSettings,
} from '../types.js';

/** Gmail caps `maxResults` at 500 for list endpoints. */
const MAX_PAGE_SIZE = 500;

export interface GmailClientOptions extends GmailRestClientOptions {
  /**
   * Permits `deleteMessagePermanently` and `deleteThreadPermanently`. Off
   * unless the profile was created with `--allow-permanent-delete`, so an
   * accidental tool call cannot bypass Trash.
   */
  allowPermanentDelete?: boolean;
}

export class GmailClient {
  private readonly rest: GmailRestClient;
  private readonly allowPermanentDelete: boolean;

  constructor(credentials: GmailCredentials, options: GmailClientOptions = {}) {
    this.rest = new GmailRestClient(credentials, options);
    this.allowPermanentDelete = options.allowPermanentDelete === true;
  }

  get mailbox(): string {
    return this.rest.mailbox;
  }

  // ---------------------------------------------------------------- profile

  async getProfile(): Promise<GmailProfile> {
    this.requireScope(GMAIL_SCOPES.readonly, 'reading the mailbox profile');
    return this.rest.request<GmailProfile>('/users/me/profile');
  }

  // --------------------------------------------------------------- messages

  /** Search using native Gmail query syntax. */
  async searchMessages(options: SearchOptions = {}): Promise<PagedResult<EmailHeaderSummary>> {
    this.requireScope(GMAIL_SCOPES.readonly, 'searching messages');

    const listing = await this.rest.request<{
      messages?: { id: string }[];
      nextPageToken?: string;
      resultSizeEstimate?: number;
    }>('/users/me/messages', {
      query: {
        q: options.query,
        labelIds: options.labelIds,
        includeSpamTrash: options.includeSpamTrash,
        maxResults: clampPageSize(options.limit),
        pageToken: options.pageToken,
      },
    });

    const items = await this.hydrate(listing.messages ?? [], 'metadata');

    return {
      items,
      nextPageToken: listing.nextPageToken,
      resultSizeEstimate: listing.resultSizeEstimate,
    };
  }

  async getMessage(
    messageId: string,
    format: 'full' | 'metadata' | 'minimal' | 'raw' = 'full',
  ): Promise<EmailDetail> {
    this.requireScope(GMAIL_SCOPES.readonly, 'reading a message');
    const resource = await this.rest.request<GmailMessageResource>(
      `/users/me/messages/${encodeURIComponent(messageId)}`,
      { query: { format } },
    );
    return parseMessage(resource);
  }

  async sendMessage(options: SendEmailOptions): Promise<EmailHeaderSummary> {
    this.requireScope(GMAIL_SCOPES.send, 'sending mail');

    const attachedEmails: AttachedEmail[] = [...(options.attachedEmails || [])];
    if (options.attachEmailUids?.length) {
      for (const id of options.attachEmailUids) {
        try {
          const rawMsg = await this.getMessage(String(id), 'raw');
          if (rawMsg.raw) {
            attachedEmails.push({
              filename: `${(rawMsg.subject || `message-${id}`).replace(/[/\\?%*:|"<>]/g, '_')}.eml`,
              rawEml: rawMsg.raw,
            });
          }
        } catch {}
      }
    }

    const raw = toGmailRaw(composeMimeMessage({ ...options, attachedEmails }, this.rest.mailbox));
    const resource = await this.rest.request<GmailMessageResource>('/users/me/messages/send', {
      method: 'POST',
      body: { raw, threadId: options.threadId },
    });
    return parseMessage(resource);
  }

  /** Reply in-thread, carrying the References chain so Gmail groups it. */
  async replyToMessage(
    messageId: string,
    body: { bodyText: string; bodyHtml?: string; replyAll?: boolean; from?: string },
  ): Promise<EmailHeaderSummary> {
    const parent = await this.getMessage(messageId, 'full');
    const threading = buildReplyHeaders({
      messageId: parent.messageId,
      references: parent.references,
    });

    const to = parent.replyTo?.length ? parent.replyTo : parent.from;
    const recipients = to.map((address) => address.address);
    const cc = body.replyAll
      ? [...(parent.to ?? []), ...(parent.cc ?? [])]
          .map((address) => address.address)
          .filter((address) => address.toLowerCase() !== this.rest.mailbox.toLowerCase())
          .filter((address) => !recipients.includes(address))
      : undefined;

    return this.sendMessage({
      from: body.from,
      to: recipients,
      cc: cc && cc.length > 0 ? cc : undefined,
      subject: replySubject(parent.subject),
      bodyText: body.bodyText,
      bodyHtml: body.bodyHtml,
      threadId: parent.threadId,
      ...threading,
    });
  }

  async forwardMessage(
    messageId: string,
    options: { to: string | string[]; comment?: string; from?: string },
  ): Promise<EmailHeaderSummary> {
    const source = await this.getMessage(messageId, 'full');
    const quoted = [
      options.comment ?? '',
      '',
      '---------- Forwarded message ----------',
      `From: ${formatAddresses(source.from)}`,
      `Date: ${source.date}`,
      `Subject: ${source.subject}`,
      `To: ${formatAddresses(source.to)}`,
      '',
      source.bodyText ?? source.bodyMarkdown ?? '',
    ].join('\n');

    return this.sendMessage({
      from: options.from,
      to: options.to,
      subject: forwardSubject(source.subject),
      bodyText: quoted,
    });
  }

  async modifyMessageLabels(
    messageId: string,
    changes: ModifyLabelsOptions,
  ): Promise<EmailHeaderSummary> {
    this.requireScope(GMAIL_SCOPES.modify, 'changing message labels');
    const resource = await this.rest.request<GmailMessageResource>(
      `/users/me/messages/${encodeURIComponent(messageId)}/modify`,
      { method: 'POST', body: changes },
    );
    return parseMessage(resource);
  }

  /** Apply the same label change to up to 1000 messages in one call. */
  async batchModifyMessages(messageIds: string[], changes: ModifyLabelsOptions): Promise<void> {
    this.requireScope(GMAIL_SCOPES.modify, 'changing message labels');
    await this.rest.request('/users/me/messages/batchModify', {
      method: 'POST',
      body: { ids: messageIds, ...changes },
      expectEmpty: true,
    });
  }

  async trashMessage(messageId: string): Promise<void> {
    this.requireScope(GMAIL_SCOPES.modify, 'moving a message to Trash');
    await this.rest.request(`/users/me/messages/${encodeURIComponent(messageId)}/trash`, {
      method: 'POST',
    });
  }

  async untrashMessage(messageId: string): Promise<void> {
    this.requireScope(GMAIL_SCOPES.modify, 'restoring a message from Trash');
    await this.rest.request(`/users/me/messages/${encodeURIComponent(messageId)}/untrash`, {
      method: 'POST',
    });
  }

  /**
   * Irreversible. Bypasses Trash entirely and cannot be undone, so it is
   * refused unless the profile explicitly opted in at setup time.
   */
  async deleteMessagePermanently(messageId: string): Promise<void> {
    this.requirePermanentDelete();
    this.requireScope(GMAIL_SCOPES.full, 'permanently deleting a message');
    await this.rest.request(`/users/me/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
      expectEmpty: true,
    });
  }

  // ---------------------------------------------------------------- threads

  async listThreads(options: SearchOptions = {}): Promise<PagedResult<{ id: string; snippet?: string }>> {
    this.requireScope(GMAIL_SCOPES.readonly, 'listing threads');
    const listing = await this.rest.request<{
      threads?: { id: string; snippet?: string }[];
      nextPageToken?: string;
      resultSizeEstimate?: number;
    }>('/users/me/threads', {
      query: {
        q: options.query,
        labelIds: options.labelIds,
        includeSpamTrash: options.includeSpamTrash,
        maxResults: clampPageSize(options.limit),
        pageToken: options.pageToken,
      },
    });

    return {
      items: listing.threads ?? [],
      nextPageToken: listing.nextPageToken,
      resultSizeEstimate: listing.resultSizeEstimate,
    };
  }

  async getThread(threadId: string, format: 'full' | 'metadata' | 'minimal' = 'full'): Promise<GmailThread> {
    this.requireScope(GMAIL_SCOPES.readonly, 'reading a thread');
    const resource = await this.rest.request<{
      id: string;
      historyId?: string;
      snippet?: string;
      messages?: GmailMessageResource[];
    }>(`/users/me/threads/${encodeURIComponent(threadId)}`, { query: { format } });

    return {
      id: resource.id,
      historyId: resource.historyId,
      snippet: resource.snippet,
      messages: (resource.messages ?? []).map(parseMessage),
    };
  }

  async modifyThreadLabels(threadId: string, changes: ModifyLabelsOptions): Promise<void> {
    this.requireScope(GMAIL_SCOPES.modify, 'changing thread labels');
    await this.rest.request(`/users/me/threads/${encodeURIComponent(threadId)}/modify`, {
      method: 'POST',
      body: changes,
    });
  }

  async trashThread(threadId: string): Promise<void> {
    this.requireScope(GMAIL_SCOPES.modify, 'moving a thread to Trash');
    await this.rest.request(`/users/me/threads/${encodeURIComponent(threadId)}/trash`, {
      method: 'POST',
    });
  }

  async untrashThread(threadId: string): Promise<void> {
    this.requireScope(GMAIL_SCOPES.modify, 'restoring a thread from Trash');
    await this.rest.request(`/users/me/threads/${encodeURIComponent(threadId)}/untrash`, {
      method: 'POST',
    });
  }

  async deleteThreadPermanently(threadId: string): Promise<void> {
    this.requirePermanentDelete();
    this.requireScope(GMAIL_SCOPES.full, 'permanently deleting a thread');
    await this.rest.request(`/users/me/threads/${encodeURIComponent(threadId)}`, {
      method: 'DELETE',
      expectEmpty: true,
    });
  }

  // ----------------------------------------------------------------- drafts

  async createDraft(options: SendEmailOptions): Promise<GmailDraft> {
    this.requireScope(GMAIL_SCOPES.compose, 'creating a draft');

    const attachedEmails: AttachedEmail[] = [...(options.attachedEmails || [])];
    if (options.attachEmailUids?.length) {
      for (const id of options.attachEmailUids) {
        try {
          const rawMsg = await this.getMessage(String(id), 'raw');
          if (rawMsg.raw) {
            attachedEmails.push({
              filename: `${(rawMsg.subject || `message-${id}`).replace(/[/\\?%*:|"<>]/g, '_')}.eml`,
              rawEml: rawMsg.raw,
            });
          }
        } catch {}
      }
    }

    const raw = toGmailRaw(composeMimeMessage({ ...options, attachedEmails }, this.rest.mailbox));
    const resource = await this.rest.request<{ id: string; message: GmailMessageResource }>(
      '/users/me/drafts',
      { method: 'POST', body: { message: { raw, threadId: options.threadId } } },
    );
    return { id: resource.id, message: parseMessage(resource.message) };
  }

  async updateDraft(draftId: string, options: SendEmailOptions): Promise<GmailDraft> {
    this.requireScope(GMAIL_SCOPES.compose, 'updating a draft');

    const attachedEmails: AttachedEmail[] = [...(options.attachedEmails || [])];
    if (options.attachEmailUids?.length) {
      for (const id of options.attachEmailUids) {
        try {
          const rawMsg = await this.getMessage(String(id), 'raw');
          if (rawMsg.raw) {
            attachedEmails.push({
              filename: `${(rawMsg.subject || `message-${id}`).replace(/[/\\?%*:|"<>]/g, '_')}.eml`,
              rawEml: rawMsg.raw,
            });
          }
        } catch {}
      }
    }

    const raw = toGmailRaw(composeMimeMessage({ ...options, attachedEmails }, this.rest.mailbox));
    const resource = await this.rest.request<{ id: string; message: GmailMessageResource }>(
      `/users/me/drafts/${encodeURIComponent(draftId)}`,
      { method: 'PUT', body: { message: { raw, threadId: options.threadId } } },
    );
    return { id: resource.id, message: parseMessage(resource.message) };
  }

  async listDrafts(limit?: number, pageToken?: string): Promise<PagedResult<GmailDraft>> {
    this.requireScope(GMAIL_SCOPES.readonly, 'listing drafts');
    const listing = await this.rest.request<{
      drafts?: { id: string; message: { id: string; threadId: string } }[];
      nextPageToken?: string;
      resultSizeEstimate?: number;
    }>('/users/me/drafts', { query: { maxResults: clampPageSize(limit), pageToken } });

    const drafts: GmailDraft[] = [];
    for (const entry of listing.drafts ?? []) {
      const message = await this.getMessage(entry.message.id, 'metadata');
      drafts.push({ id: entry.id, message });
    }

    return {
      items: drafts,
      nextPageToken: listing.nextPageToken,
      resultSizeEstimate: listing.resultSizeEstimate,
    };
  }

  async getDraft(draftId: string): Promise<GmailDraft> {
    this.requireScope(GMAIL_SCOPES.readonly, 'reading a draft');
    const resource = await this.rest.request<{ id: string; message: GmailMessageResource }>(
      `/users/me/drafts/${encodeURIComponent(draftId)}`,
      { query: { format: 'full' } },
    );
    return { id: resource.id, message: parseMessage(resource.message) };
  }

  async sendDraft(draftId: string): Promise<EmailHeaderSummary> {
    this.requireScope(GMAIL_SCOPES.send, 'sending a draft');
    const resource = await this.rest.request<GmailMessageResource>('/users/me/drafts/send', {
      method: 'POST',
      body: { id: draftId },
    });
    return parseMessage(resource);
  }

  async deleteDraft(draftId: string): Promise<void> {
    this.requireScope(GMAIL_SCOPES.compose, 'deleting a draft');
    await this.rest.request(`/users/me/drafts/${encodeURIComponent(draftId)}`, {
      method: 'DELETE',
      expectEmpty: true,
    });
  }

  // ----------------------------------------------------------------- labels

  async listLabels(): Promise<GmailLabel[]> {
    this.requireScope(GMAIL_SCOPES.readonly, 'listing labels');
    const listing = await this.rest.request<{ labels?: GmailLabel[] }>('/users/me/labels');
    return listing.labels ?? [];
  }

  async getLabel(labelId: string): Promise<GmailLabel> {
    this.requireScope(GMAIL_SCOPES.readonly, 'reading a label');
    return this.rest.request<GmailLabel>(`/users/me/labels/${encodeURIComponent(labelId)}`);
  }

  async createLabel(label: Partial<GmailLabel> & { name: string }): Promise<GmailLabel> {
    this.requireScope(GMAIL_SCOPES.labels, 'creating a label');
    return this.rest.request<GmailLabel>('/users/me/labels', { method: 'POST', body: label });
  }

  async updateLabel(labelId: string, changes: Partial<GmailLabel>): Promise<GmailLabel> {
    this.requireScope(GMAIL_SCOPES.labels, 'updating a label');
    return this.rest.request<GmailLabel>(`/users/me/labels/${encodeURIComponent(labelId)}`, {
      method: 'PATCH',
      body: changes,
    });
  }

  async deleteLabel(labelId: string): Promise<void> {
    this.requireScope(GMAIL_SCOPES.labels, 'deleting a label');
    await this.rest.request(`/users/me/labels/${encodeURIComponent(labelId)}`, {
      method: 'DELETE',
      expectEmpty: true,
    });
  }

  // ------------------------------------------------------------ attachments

  async getAttachment(messageId: string, attachmentId: string): Promise<string> {
    this.requireScope(GMAIL_SCOPES.readonly, 'downloading an attachment');
    return this.rest.getAttachmentData(messageId, attachmentId);
  }

  // ---------------------------------------------------------------- history

  /** Incremental change feed since a known historyId. */
  async listHistory(startHistoryId: string, limit?: number): Promise<PagedResult<HistoryRecord>> {
    this.requireScope(GMAIL_SCOPES.readonly, 'reading mailbox history');
    const listing = await this.rest.request<{
      history?: HistoryRecord[];
      nextPageToken?: string;
    }>('/users/me/history', {
      query: { startHistoryId, maxResults: clampPageSize(limit) },
    });
    return { items: listing.history ?? [], nextPageToken: listing.nextPageToken };
  }

  // --------------------------------------------------------------- settings

  async listFilters(): Promise<GmailFilter[]> {
    this.requireScope(GMAIL_SCOPES.settingsBasic, 'listing filters');
    const listing = await this.rest.request<{ filter?: GmailFilter[] }>('/users/me/settings/filters');
    return listing.filter ?? [];
  }

  async createFilter(filter: GmailFilter): Promise<GmailFilter> {
    this.requireScope(GMAIL_SCOPES.settingsBasic, 'creating a filter');
    return this.rest.request<GmailFilter>('/users/me/settings/filters', {
      method: 'POST',
      body: filter,
    });
  }

  async deleteFilter(filterId: string): Promise<void> {
    this.requireScope(GMAIL_SCOPES.settingsBasic, 'deleting a filter');
    await this.rest.request(`/users/me/settings/filters/${encodeURIComponent(filterId)}`, {
      method: 'DELETE',
      expectEmpty: true,
    });
  }

  async listSendAs(): Promise<SendAsAlias[]> {
    this.requireScope(GMAIL_SCOPES.settingsBasic, 'listing send-as aliases');
    const listing = await this.rest.request<{ sendAs?: SendAsAlias[] }>('/users/me/settings/sendAs');
    return listing.sendAs ?? [];
  }

  async updateSendAs(sendAsEmail: string, changes: Partial<SendAsAlias>): Promise<SendAsAlias> {
    this.requireScope(GMAIL_SCOPES.settingsBasic, 'updating a send-as alias');
    return this.rest.request<SendAsAlias>(
      `/users/me/settings/sendAs/${encodeURIComponent(sendAsEmail)}`,
      { method: 'PATCH', body: changes },
    );
  }

  async getVacation(): Promise<VacationSettings> {
    this.requireScope(GMAIL_SCOPES.settingsBasic, 'reading the vacation responder');
    return this.rest.request<VacationSettings>('/users/me/settings/vacation');
  }

  async updateVacation(settings: VacationSettings): Promise<VacationSettings> {
    this.requireScope(GMAIL_SCOPES.settingsBasic, 'updating the vacation responder');
    return this.rest.request<VacationSettings>('/users/me/settings/vacation', {
      method: 'PUT',
      body: settings,
    });
  }

  async listForwardingAddresses(): Promise<ForwardingAddress[]> {
    this.requireScope(GMAIL_SCOPES.settingsBasic, 'listing forwarding addresses');
    const listing = await this.rest.request<{ forwardingAddresses?: ForwardingAddress[] }>(
      '/users/me/settings/forwardingAddresses',
    );
    return listing.forwardingAddresses ?? [];
  }

  async getAutoForwarding(): Promise<AutoForwarding> {
    this.requireScope(GMAIL_SCOPES.settingsBasic, 'reading auto-forwarding');
    return this.rest.request<AutoForwarding>('/users/me/settings/autoForwarding');
  }

  async updateAutoForwarding(settings: AutoForwarding): Promise<AutoForwarding> {
    // Auto-forwarding silently copies every inbound message off the account,
    // so it needs the sharing scope rather than the basic settings scope.
    this.requireScope(GMAIL_SCOPES.settingsSharing, 'changing auto-forwarding');
    return this.rest.request<AutoForwarding>('/users/me/settings/autoForwarding', {
      method: 'PUT',
      body: settings,
    });
  }

  async listDelegates(): Promise<Delegate[]> {
    this.requireScope(GMAIL_SCOPES.settingsSharing, 'listing delegates');
    const listing = await this.rest.request<{ delegates?: Delegate[] }>('/users/me/settings/delegates');
    return listing.delegates ?? [];
  }

  async removeDelegate(delegateEmail: string): Promise<void> {
    this.requireScope(GMAIL_SCOPES.settingsSharing, 'removing a delegate');
    await this.rest.request(`/users/me/settings/delegates/${encodeURIComponent(delegateEmail)}`, {
      method: 'DELETE',
      expectEmpty: true,
    });
  }

  // ---------------------------------------------------------------- private

  /** Hydrate a list of message ids into summaries, preserving order. */
  private async hydrate(
    references: { id: string }[],
    format: 'metadata' | 'full',
  ): Promise<EmailHeaderSummary[]> {
    const summaries: EmailHeaderSummary[] = [];
    for (const reference of references) {
      summaries.push(await this.getMessage(reference.id, format));
    }
    return summaries;
  }

  private requireScope(scope: string, operation: string): void {
    assertScope(this.rest.grantedScopes, scope as never, operation);
  }

  private requirePermanentDelete(): void {
    if (!this.allowPermanentDelete) {
      throw new Error(
        'Permanent deletion is disabled for this profile. It bypasses Trash and cannot be undone. '
        + 'Re-run "mcp-gmail setup --allow-permanent-delete" to enable it deliberately.',
      );
    }
  }
}

function clampPageSize(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  return Math.min(Math.max(limit, 1), MAX_PAGE_SIZE);
}

function formatAddresses(addresses: { name?: string; address: string }[]): string {
  return addresses
    .map((entry) => (entry.name ? `${entry.name} <${entry.address}>` : entry.address))
    .join(', ');
}
