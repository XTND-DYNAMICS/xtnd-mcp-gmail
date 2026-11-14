/**
 * App Password MCP Server for @xtnd-dynamics/mcp-gmail
 *
 * The one definition of the Gmail tool set (IMAP + SMTP over Direct TLS). The
 * local stdio server and the hosted Cloudflare Worker both serve the server
 * built here, so their tools, input schemas and behaviour cannot drift apart.
 *
 * Every tool carries the mail scope it needs. A host that authorizes callers
 * passes an `authorize` hook, which runs before mailbox credentials are
 * resolved; the stdio server passes none and every tool is allowed. A host
 * without a filesystem sets `fileAccess: false`, and tools then refuse file
 * paths and accept base64 attachment objects instead.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AppPasswordGmailClient } from '../core/app-password-client.js';
import { BRAND_DATA_URI_ICONS, brandIconsForOrigin } from './brand-icons.js';
import { BUILD_STAMP } from '../version.generated.js';

export const MAIL_SCOPES = ['mail.read', 'mail.manage', 'mail.send', 'mail.delete'] as const;
export type MailScope = (typeof MAIL_SCOPES)[number];

/**
 * A refusal whose message is meant for the caller: a missing scope, an
 * unlinked mailbox, an argument the host cannot honour. Hosts that redact
 * mail-operation failures still show these messages verbatim.
 */
export class ToolRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRefusal';
  }
}

export interface AppPasswordServerOptions {
  /** Resolves the mailbox client. Called only after authorization and argument checks pass. */
  getClient: () => AppPasswordGmailClient | Promise<AppPasswordGmailClient>;
  /** Throws (normally a ToolRefusal) when the caller lacks `scope`. Omit to allow every tool. */
  authorize?: (scope: MailScope, operation: string) => void | Promise<void>;
  /** Whether tools may read and write local files. Defaults to true (stdio). */
  fileAccess?: boolean;
  /** Turns a tool failure into the text returned to the caller. Defaults to `Error: <message>`. */
  formatError?: (error: unknown, operation: string) => string;
  /** Server instructions sent with the initialize result. */
  instructions?: string;
  /** Public HTTPS origin for SEP-973 icon URLs when served by the Cloudflare Worker. */
  origin?: string;
}

interface ToolEnv {
  fileAccess: boolean;
}

interface ToolDefinition<Shape extends z.ZodRawShape> {
  name: string;
  description: string;
  scope: MailScope;
  input: Shape;
  /** Argument checks that need no mailbox; they run before credentials are resolved. */
  check?: (args: z.infer<z.ZodObject<Shape>>, env: ToolEnv) => void;
  run: (client: AppPasswordGmailClient, args: z.infer<z.ZodObject<Shape>>, env: ToolEnv) => Promise<unknown>;
}

type AnyToolDefinition = ToolDefinition<z.ZodRawShape>;

function defineTool<Shape extends z.ZodRawShape>(definition: ToolDefinition<Shape>): AnyToolDefinition {
  return definition as unknown as AnyToolDefinition;
}

// ------------------------------------------------------------------ shared inputs

const Folder = z.string().optional().default('INBOX').describe('Mailbox folder (default: INBOX)');

const AttachmentInput = z.union([
  z.string().min(1).max(4_096).describe('Absolute path of a local file (local stdio server only)'),
  z.object({
    filename: z.string().min(1).max(255)
      .refine((value) => !/[\u0000-\u001f"\\]/.test(value), 'filename cannot contain control characters, quotes or backslashes')
      .describe('File name shown to the recipient'),
    contentType: z.string().min(1).max(255)
      .refine((value) => !/[\u0000-\u001f]/.test(value), 'contentType cannot contain control characters')
      .optional()
      .describe('MIME type, e.g. application/pdf (derived from the file name when omitted)'),
    dataBase64: z.string().max(35_000_000).describe('File content, base64 encoded'),
  }).strict(),
]);

const Attachments = z.array(AttachmentInput).max(25);

const ATTACHMENTS_HELP = 'Files to attach: absolute file paths (local stdio server only) or { filename, contentType, dataBase64 } objects';

function parseUid(id: string): number {
  const trimmed = id.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new ToolRefusal(`"${trimmed.slice(0, 64)}" is not a message ID: use the numeric ID returned by search or list tools.`);
  }
  return Number(trimmed);
}

function parseUids(ids: readonly string[]): number[] {
  const uids = ids.map(parseUid);
  if (uids.length === 0) throw new ToolRefusal('Provide at least one message ID.');
  return uids;
}

function parseUidList(id: string): number[] {
  return parseUids(id.split(',').filter((part) => part.trim() !== ''));
}

function assertNoLocalFiles(env: ToolEnv, attachments: readonly z.infer<typeof AttachmentInput>[] | undefined): void {
  if (env.fileAccess || !attachments?.some((item) => typeof item === 'string')) return;
  throw new ToolRefusal(
    'This server has no filesystem, so attachments cannot be file paths. '
    + 'Pass each file as { filename, contentType, dataBase64 }.',
  );
}

function assertNoSavePath(env: ToolEnv, saveToPath: string | undefined): void {
  if (env.fileAccess || saveToPath === undefined) return;
  throw new ToolRefusal('This server has no filesystem, so saveToPath is not available. Omit it to receive the content inline.');
}

// ------------------------------------------------------------------ the tool set

export const APP_PASSWORD_TOOLS: readonly AnyToolDefinition[] = [
  // -------------------------------------------------------------- Search & Read

  defineTool({
    name: 'search_emails',
    description: 'Search for emails in Gmail. Supports native Gmail query syntax via query argument '
      + '(e.g. "from:alice is:unread has:attachment newer_than:7d") or structured filters.',
    scope: 'mail.read',
    input: {
      folder: Folder,
      query: z.string().optional().describe('Native Gmail search query, e.g. "is:unread has:attachment"'),
      from: z.string().optional().describe('Sender email address or name filter'),
      to: z.string().optional().describe('Recipient email address filter'),
      subject: z.string().optional().describe('Subject keyword filter'),
      unreadOnly: z.boolean().optional().default(false).describe('Filter to unread messages only'),
      starredOnly: z.boolean().optional().default(false).describe('Filter to starred/flagged messages only'),
      limit: z.number().optional().default(20).describe('Maximum number of emails to return'),
    },
    run: (client, args) => client.searchEmails(args),
  }),

  defineTool({
    name: 'get_recent_emails',
    description: 'Retrieve recent emails from Gmail mailbox folder.',
    scope: 'mail.read',
    input: {
      folder: Folder,
      limit: z.number().optional().default(10).describe('Maximum number of emails to retrieve'),
    },
    run: async (client, { folder, limit }) => {
      const emails = await client.getRecentEmails(folder, limit);
      return { count: emails.length, emails };
    },
  }),

  defineTool({
    name: 'get_email',
    description: 'Fetch full email content by ID/UID from Gmail. Returns markdown body, HTML, headers, and attachment metadata (without heavy binary payloads by default).',
    scope: 'mail.read',
    input: {
      folder: Folder,
      id: z.string().describe('ID or UID of the email'),
      includeAttachmentData: z.boolean().optional().default(false).describe('If true, returns base64 attachment payloads. Default false avoids token context bloat.'),
    },
    run: (client, { folder, id, includeAttachmentData }) => client.getEmailContent(folder, parseUid(id), includeAttachmentData),
  }),

  defineTool({
    name: 'get_thread',
    description: 'Retrieve conversation thread for a given email ID or thread ID using Gmail native threading.',
    scope: 'mail.read',
    input: {
      folder: Folder,
      id: z.string().describe('Email ID, UID, or Thread ID'),
      includeAttachmentData: z.boolean().optional().default(false).describe('If true, includes base64 attachment data in messages.'),
    },
    run: (client, { folder, id, includeAttachmentData }) => client.getEmailThread(folder, id, includeAttachmentData),
  }),

  defineTool({
    name: 'get_attachment',
    description: 'Download and extract an attachment from an email. Provide saveToPath to save directly to disk (local stdio server only); otherwise the content is returned base64 encoded.',
    scope: 'mail.read',
    input: {
      folder: Folder,
      id: z.string().describe('Email ID or UID'),
      attachmentId: z.string().describe('Attachment ID or filename'),
      saveToPath: z.string().optional().describe('Optional absolute path to write the file to (local stdio server only)'),
    },
    check: ({ saveToPath }, env) => assertNoSavePath(env, saveToPath),
    run: async (client, { folder, id, attachmentId, saveToPath }) => {
      const result = await client.getAttachment(folder, parseUid(id), attachmentId, saveToPath);
      return {
        filename: result.filename,
        contentType: result.contentType,
        sizeBytes: result.size,
        savedToPath: result.savedToPath,
        dataBase64: saveToPath ? undefined : result.dataBase64,
      };
    },
  }),

  defineTool({
    name: 'get_raw_email',
    description: 'Fetch raw RFC 822 source for an email. Provide saveToPath to export as a .eml file (local stdio server only).',
    scope: 'mail.read',
    input: {
      folder: Folder,
      id: z.string().describe('Email ID or UID'),
      saveToPath: z.string().optional().describe('Optional path to write the .eml file to (local stdio server only)'),
    },
    check: ({ saveToPath }, env) => assertNoSavePath(env, saveToPath),
    run: async (client, { folder, id, saveToPath }) => {
      const result = await client.getRawEmail(folder, parseUid(id), saveToPath);
      return {
        uid: result.uid,
        sizeBytes: result.sizeBytes,
        savedToPath: result.savedToPath,
        raw: saveToPath ? undefined : result.raw,
      };
    },
  }),

  // -------------------------------------------------------------- Outbound Sending

  defineTool({
    name: 'send_email',
    description: 'Send an outbound email via Gmail SMTP. Supports plain text, HTML bodies, file attachments, and attaching other emails.',
    scope: 'mail.send',
    input: {
      to: z.string().describe('Recipient email address or comma-separated list'),
      subject: z.string().describe('Email subject line'),
      bodyText: z.string().optional().default('').describe('Plain text body (may be empty when bodyHtml is given)'),
      bodyHtml: z.string().optional().describe('Optional HTML body (multipart/alternative)'),
      cc: z.string().optional().describe('Optional CC recipient(s)'),
      bcc: z.string().optional().describe('Optional BCC recipient(s)'),
      attachments: Attachments.optional().describe(ATTACHMENTS_HELP),
      attachEmailUids: z.array(z.string()).optional().describe('Optional email IDs/UIDs to attach as .eml message attachments'),
    },
    check: ({ attachments }, env) => assertNoLocalFiles(env, attachments),
    run: (client, args) => client.sendEmail(args),
  }),

  defineTool({
    name: 'reply_email',
    description: 'Reply in-thread to an existing email in Gmail. Derives recipients, subject, threading headers, and automatically quotes the original message.',
    scope: 'mail.send',
    input: {
      folder: Folder,
      id: z.string().describe('ID or UID of the email being replied to'),
      bodyText: z.string().describe('Reply text'),
      bodyHtml: z.string().optional().describe('Optional HTML reply text'),
      replyAll: z.boolean().optional().default(false).describe('Keep everyone already on the thread in Cc (excluding this mailbox)'),
      additionalCc: z.string().optional().describe('Extra Cc addresses to include'),
      quoteOriginal: z.boolean().optional().default(true).describe('Automatically format and quote original email below reply'),
      attachments: Attachments.optional().describe(ATTACHMENTS_HELP),
      attachEmailUids: z.array(z.string()).optional().describe('Optional email IDs/UIDs to attach as .eml'),
    },
    check: ({ attachments }, env) => assertNoLocalFiles(env, attachments),
    run: (client, a) => client.replyEmail(
      a.folder, parseUid(a.id), a.bodyText, a.replyAll, a.additionalCc, a.bodyHtml, a.attachments, a.attachEmailUids, a.quoteOriginal,
    ),
  }),

  defineTool({
    name: 'forward_email',
    description: 'Forward an existing email to new recipients with original text, headers, and attachments intact.',
    scope: 'mail.send',
    input: {
      folder: Folder,
      id: z.string().describe('ID or UID of the email to forward'),
      to: z.string().describe('Recipient email address'),
      comment: z.string().optional().describe('Optional note prepended above the forwarded email'),
      bodyHtml: z.string().optional().describe('Optional HTML body'),
      attachments: Attachments.optional().describe(`Additional ${ATTACHMENTS_HELP.charAt(0).toLowerCase()}${ATTACHMENTS_HELP.slice(1)}`),
      attachAsEml: z.boolean().optional().default(false).describe('If true, attach the original email as a full .eml attachment; if false, forwards inline with all original attachments preserved'),
    },
    check: ({ attachments }, env) => assertNoLocalFiles(env, attachments),
    run: (client, a) => client.forwardEmail(a.folder, parseUid(a.id), a.to, a.comment, a.bodyHtml, a.attachments, a.attachAsEml),
  }),

  // -------------------------------------------------------------- Drafts Lifecycle

  defineTool({
    name: 'create_draft',
    description: 'Create a new email draft in the Gmail Drafts folder without sending it. Supports file and email attachments.',
    scope: 'mail.manage',
    input: {
      to: z.string().optional().describe('Recipient address(es), comma separated'),
      cc: z.string().optional().describe('Cc recipients, comma separated'),
      bcc: z.string().optional().describe('Bcc recipients, comma separated'),
      subject: z.string().optional().describe('Draft subject line'),
      bodyText: z.string().optional().default('').describe('Draft body plain text'),
      bodyHtml: z.string().optional().describe('Optional HTML draft body'),
      attachments: Attachments.optional().describe(ATTACHMENTS_HELP),
      attachEmailUids: z.array(z.string()).optional().describe('Email IDs/UIDs to attach as .eml message attachments'),
    },
    check: ({ attachments }, env) => assertNoLocalFiles(env, attachments),
    run: (client, args) => client.createDraft(args),
  }),

  defineTool({
    name: 'create_reply_draft',
    description: 'Save a reply to an existing email as a draft in Gmail. Preserves recipients (Reply-To / From, and Cc on Reply All), subject (Re: ...), In-Reply-To/References threading headers, and quotes the original message.',
    scope: 'mail.manage',
    input: {
      folder: Folder,
      id: z.string().describe('ID or UID of the email being replied to'),
      bodyText: z.string().describe('The reply body'),
      replyAll: z.boolean().default(false).describe('Keep everyone already on the thread in Cc (excluding this mailbox)'),
      additionalCc: z.string().optional().describe('Extra Cc addresses to include'),
      quoteOriginal: z.boolean().optional().default(true).describe('Automatically format and quote original message below reply'),
      bodyHtml: z.string().optional().describe('Optional HTML body (for tables and styled layout)'),
      attachments: Attachments.optional().describe(ATTACHMENTS_HELP),
      attachEmailUids: z.array(z.string()).optional().describe('Email IDs/UIDs to attach as .eml'),
    },
    check: ({ attachments }, env) => assertNoLocalFiles(env, attachments),
    run: (client, a) => client.createReplyDraft(
      a.folder, parseUid(a.id), a.bodyText, a.replyAll, a.additionalCc, a.bodyHtml, a.attachments, a.attachEmailUids, a.quoteOriginal,
    ),
  }),

  defineTool({
    name: 'create_forward_draft',
    description: 'Save a forwarded email as a draft in Gmail Drafts folder for review before sending. Preserves original headers and attachments.',
    scope: 'mail.manage',
    input: {
      folder: Folder,
      id: z.string().describe('ID or UID of the email to forward'),
      to: z.string().describe('Recipient email address'),
      comment: z.string().optional().describe('Optional note prepended above the forwarded email'),
      bodyHtml: z.string().optional().describe('Optional HTML body'),
      attachments: Attachments.optional().describe(`Additional ${ATTACHMENTS_HELP.charAt(0).toLowerCase()}${ATTACHMENTS_HELP.slice(1)}`),
      attachAsEml: z.boolean().optional().default(false).describe('If true, attach the original email as a full .eml attachment; if false, forwards inline with all original attachments preserved'),
    },
    check: ({ attachments }, env) => assertNoLocalFiles(env, attachments),
    run: (client, a) => client.createForwardDraft(a.folder, parseUid(a.id), a.to, a.comment, a.bodyHtml, a.attachments, a.attachAsEml),
  }),

  defineTool({
    name: 'update_draft',
    description: 'Update an existing draft in Gmail Drafts folder. Safely updates text, recipients, or subject while preserving threading headers and existing attachments unless explicitly replaced.',
    scope: 'mail.manage',
    input: {
      draftId: z.string().describe('Draft ID/UID to update'),
      to: z.string().optional().describe('Recipient address(es)'),
      cc: z.string().optional().describe('Cc recipients'),
      bcc: z.string().optional().describe('Bcc recipients'),
      subject: z.string().optional().describe('Subject line'),
      bodyText: z.string().optional().describe('Plain text body'),
      bodyHtml: z.string().optional().describe('HTML body'),
      attachments: Attachments.optional().describe(`${ATTACHMENTS_HELP} (omit to preserve existing attachments)`),
      attachEmailUids: z.array(z.string()).optional().describe('Email IDs/UIDs to attach as .eml'),
    },
    check: ({ attachments }, env) => assertNoLocalFiles(env, attachments),
    run: (client, { draftId, ...rest }) => client.updateDraft(draftId, rest),
  }),

  defineTool({
    name: 'list_drafts',
    description: 'List all email drafts in the Gmail Drafts folder with accurate attachment metadata and subject/recipients.',
    scope: 'mail.read',
    input: {
      limit: z.number().optional().default(20).describe('Maximum number of drafts to return'),
      includeAttachmentData: z.boolean().optional().default(false).describe('If true, includes base64 attachment data.'),
    },
    run: (client, { limit, includeAttachmentData }) => client.listDrafts(limit, includeAttachmentData),
  }),

  defineTool({
    name: 'get_draft',
    description: 'Fetch one draft by ID/UID including full body, headers, and attachment metadata.',
    scope: 'mail.read',
    input: {
      draftId: z.string().describe('Draft ID/UID'),
      includeAttachmentData: z.boolean().optional().default(false).describe('If true, includes base64 attachment payloads.'),
    },
    run: (client, { draftId, includeAttachmentData }) => client.getDraft(draftId, includeAttachmentData),
  }),

  defineTool({
    name: 'send_draft',
    description: 'Send an existing draft immediately (including all attached files) and remove it from the Gmail Drafts folder.',
    scope: 'mail.send',
    input: {
      draftId: z.string().describe('Draft ID/UID to send'),
    },
    run: (client, { draftId }) => client.sendDraft(draftId),
  }),

  defineTool({
    name: 'delete_draft',
    description: 'Delete a draft permanently from the Gmail Drafts folder.',
    scope: 'mail.delete',
    input: {
      draftId: z.string().describe('Draft ID/UID to delete'),
    },
    run: (client, { draftId }) => client.deleteDraft(draftId),
  }),

  // -------------------------------------------------------------- Labels & Folders

  defineTool({
    name: 'list_labels',
    description: 'List all Gmail folders and labels with message and unread counts.',
    scope: 'mail.read',
    input: {},
    run: async (client) => {
      const folders = await client.listFolders();
      return { count: folders.length, labels: folders };
    },
  }),

  defineTool({
    name: 'create_label',
    description: 'Create a new Gmail label.',
    scope: 'mail.manage',
    input: { name: z.string().describe('Label name to create') },
    run: (client, { name }) => client.createFolder(name),
  }),

  defineTool({
    name: 'rename_label',
    description: 'Rename an existing Gmail label.',
    scope: 'mail.manage',
    input: {
      oldName: z.string().describe('Existing label name'),
      newName: z.string().describe('New label name'),
    },
    run: (client, { oldName, newName }) => client.renameFolder(oldName, newName),
  }),

  defineTool({
    name: 'delete_label',
    description: 'Delete a Gmail label.',
    scope: 'mail.delete',
    input: { name: z.string().describe('Label name to delete') },
    run: (client, { name }) => client.deleteFolder(name),
  }),

  defineTool({
    name: 'modify_email_labels',
    description: 'Add or remove labels on one or more emails.',
    scope: 'mail.manage',
    input: {
      folder: Folder,
      id: z.string().describe('Email ID or UID (or comma separated IDs)'),
      addLabels: z.array(z.string()).optional().describe('Labels to add'),
      removeLabels: z.array(z.string()).optional().describe('Labels to remove'),
    },
    run: (client, { folder, id, addLabels, removeLabels }) => client.modifyEmailLabels(folder, parseUidList(id), addLabels, removeLabels),
  }),

  defineTool({
    name: 'batch_modify_labels',
    description: 'Apply label additions/removals to multiple messages at once.',
    scope: 'mail.manage',
    input: {
      folder: Folder,
      ids: z.array(z.string()).describe('List of email IDs/UIDs'),
      addLabels: z.array(z.string()).optional().describe('Labels to add'),
      removeLabels: z.array(z.string()).optional().describe('Labels to remove'),
    },
    run: (client, { folder, ids, addLabels, removeLabels }) => client.modifyEmailLabels(folder, parseUids(ids), addLabels, removeLabels),
  }),

  // -------------------------------------------------------------- Triage & Actions

  defineTool({
    name: 'archive_email',
    description: 'Archive email(s) by removing them from INBOX.',
    scope: 'mail.manage',
    input: {
      folder: Folder,
      id: z.string().describe('Email ID or comma-separated IDs'),
    },
    run: (client, { folder, id }) => client.archiveEmail(folder, parseUidList(id)),
  }),

  defineTool({
    name: 'star_email',
    description: 'Star or unstar email(s).',
    scope: 'mail.manage',
    input: {
      folder: Folder,
      id: z.string().describe('Email ID or comma-separated IDs'),
      star: z.boolean().default(true).describe('True to star, false to unstar'),
    },
    run: (client, { folder, id, star }) => client.starEmail(folder, parseUidList(id), star),
  }),

  defineTool({
    name: 'mark_email_read',
    description: 'Mark email(s) as read or unread.',
    scope: 'mail.manage',
    input: {
      folder: Folder,
      id: z.string().describe('Email ID or comma-separated IDs'),
      read: z.boolean().default(true).describe('True for read, false for unread'),
    },
    run: (client, { folder, id, read }) => client.markEmails(folder, parseUidList(id), read ? 'read' : 'unread'),
  }),

  defineTool({
    name: 'trash_email',
    description: 'Move email(s) to Gmail Trash. Reversible with untrash_email.',
    scope: 'mail.delete',
    input: {
      folder: Folder,
      id: z.string().describe('Email ID or comma-separated IDs'),
    },
    run: (client, { folder, id }) => client.trashEmail(folder, parseUidList(id)),
  }),

  defineTool({
    name: 'untrash_email',
    description: 'Restore email(s) from Gmail Trash back to INBOX.',
    scope: 'mail.manage',
    input: {
      id: z.string().describe('Email ID or comma-separated IDs'),
    },
    run: (client, { id }) => client.untrashEmail(parseUidList(id)),
  }),

  defineTool({
    name: 'move_emails',
    description: 'Move email(s) to another mailbox folder.',
    scope: 'mail.manage',
    input: {
      sourceFolder: z.string().describe('Current mailbox folder'),
      targetFolder: z.string().describe('Target mailbox folder'),
      ids: z.array(z.string()).describe('List of email IDs/UIDs to move'),
    },
    run: (client, { sourceFolder, targetFolder, ids }) => client.moveEmails(sourceFolder, targetFolder, parseUids(ids)),
  }),

  defineTool({
    name: 'delete_email_permanently',
    description: 'IRREVERSIBLE. Permanently delete email(s), bypassing Trash.',
    scope: 'mail.delete',
    input: {
      folder: Folder,
      id: z.string().describe('Email ID or comma-separated IDs'),
      confirm: z.boolean().describe('Must explicitly be true to confirm permanent deletion'),
    },
    check: ({ confirm }) => {
      if (!confirm) throw new ToolRefusal('confirm must be set to true to permanently delete emails.');
    },
    run: (client, { folder, id }) => client.deleteEmailsPermanently(folder, parseUidList(id)),
  }),

  // -------------------------------------------------------------- Account Profile

  defineTool({
    name: 'get_profile',
    description: 'Get authenticated mailbox address and status summary.',
    scope: 'mail.read',
    input: {},
    run: (client) => client.getProfile(),
  }),
];

/** The names of every tool the server exposes, in registration order. */
export const APP_PASSWORD_TOOL_NAMES: readonly string[] = APP_PASSWORD_TOOLS.map((tool) => tool.name);

/** The mail scope each tool requires. */
export function requiredScopeForTool(name: string): MailScope | undefined {
  return APP_PASSWORD_TOOLS.find((tool) => tool.name === name)?.scope;
}

const defaultFormatError = (error: unknown) => `Error: ${error instanceof Error ? error.message : String(error)}`;

const DEFAULT_INSTRUCTIONS = 'Always prefer create_draft, create_reply_draft, create_forward_draft, or update_draft '
  + 'over send_email, reply_email, forward_email, or send_draft unless the user explicitly asks to send immediately. '
  + 'Never call delete_email_permanently or delete_label without explicit user confirmation in the current turn.';

const NON_IDEMPOTENT_TOOLS = new Set([
  'send_email',
  'reply_email',
  'forward_email',
  'send_draft',
  'create_draft',
  'create_reply_draft',
  'create_forward_draft',
  'create_label',
]);

export function createAppPasswordGmailMcpServer(options: AppPasswordServerOptions): McpServer {
  const env: ToolEnv = { fileAccess: options.fileAccess ?? true };
  const formatError = options.formatError ?? defaultFormatError;
  const authorize = async (scope: MailScope, operation: string) => {
    if (options.authorize) await options.authorize(scope, operation);
  };
  const origin = options.origin?.replace(/\/+$/, '');

  const server = new McpServer(
    {
      name: '@xtnd-dynamics/mcp-gmail',
      title: 'XMAIL | Gmail',
      version: BUILD_STAMP.version,
      websiteUrl: origin || 'https://gmail.mcp.xgi.io',
      icons: origin ? brandIconsForOrigin(origin) : BRAND_DATA_URI_ICONS,
    },
    { instructions: options.instructions ?? DEFAULT_INSTRUCTIONS },
  );

  for (const tool of APP_PASSWORD_TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          readOnlyHint: tool.scope === 'mail.read',
          destructiveHint: tool.scope === 'mail.delete',
          idempotentHint: !NON_IDEMPOTENT_TOOLS.has(tool.name),
          openWorldHint: tool.scope === 'mail.send',
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          await authorize(tool.scope, tool.name);
          tool.check?.(args, env);
          const client = await options.getClient();
          const result = await tool.run(client, args, env);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err: unknown) {
          return { isError: true, content: [{ type: 'text' as const, text: formatError(err, tool.name) }] };
        }
      },
    );
  }

  // ---------------------------------------------------------------- Resources

  const jsonResource = (uri: string, name: string, description: string, read: (client: AppPasswordGmailClient) => Promise<unknown>) => {
    server.registerResource(name, uri, { description, mimeType: 'application/json' }, async () => {
      try {
        await authorize('mail.read', uri);
        const client = await options.getClient();
        const value = await read(client);
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }] };
      } catch (err: unknown) {
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ error: formatError(err, uri) }) }] };
      }
    });
  };

  jsonResource('gmail://labels', 'labels', 'Live catalog of Gmail folders and labels with unread counts.', async (client) => {
    const folders = await client.listFolders();
    return { count: folders.length, labels: folders };
  });

  jsonResource('gmail://profile', 'profile', 'Authenticated mailbox address and message counters.', (client) => client.getProfile());

  // ---------------------------------------------------------------- Prompts

  server.registerPrompt(
    'triage-inbox',
    {
      description: 'Inspect recent unread emails, prioritize into categories, and recommend triage actions.',
      argsSchema: {
        limit: z.string().optional().describe('Maximum number of unread emails to inspect (default: 10)'),
      },
    },
    async (args) => {
      const limit = args.limit ? parseInt(args.limit, 10) : 10;
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please triage my Gmail inbox:
1. Fetch up to ${limit} unread emails using search_emails({ query: "is:unread", limit: ${limit} }).
2. For important emails, read full content with get_email.
3. Categorize into Urgent, Action Required, Informational, and Newsletters.
4. Suggest reply drafts or archive/trash actions.`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'draft-reply',
    {
      description: 'Read a thread and prepare a contextual reply as a draft for review.',
      argsSchema: {
        id: z.string().describe('The email ID to reply to'),
        tone: z.string().optional().describe('professional, friendly, concise, or assertive'),
      },
    },
    async (args) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Please prepare a reply to message ${args.id}:
1. Read it with get_email, and the thread with get_thread.
2. Draft a ${args.tone || 'professional'} reply.
3. Create it with create_reply_draft so I can review it in Gmail before sending.`,
          },
        },
      ],
    }),
  );

  return server;
}
