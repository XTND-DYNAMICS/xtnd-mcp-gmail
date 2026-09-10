/**
 * App Password MCP Server for @xtnd-dynamics/mcp-gmail
 * Provides 100% full Gmail feature suite support via high-speed Direct TLS (IMAP + SMTP).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AppPasswordGmailClient } from '../core/app-password-client.js';

export function createAppPasswordGmailMcpServer(getClient: () => AppPasswordGmailClient): McpServer {
  const server = new McpServer({
    name: '@xtnd-dynamics/mcp-gmail',
    version: '0.1.0',
  });

  // ---------------------------------------------------------------- Search & Read

  server.tool(
    'search_emails',
    'Search for emails in Gmail. Supports native Gmail query syntax via query argument '
    + '(e.g. "from:alice is:unread has:attachment newer_than:7d") or structured filters.',
    {
      folder: z.string().optional().default('INBOX').describe('Mailbox folder (default: INBOX)'),
      query: z.string().optional().describe('Native Gmail search query, e.g. "is:unread has:attachment"'),
      from: z.string().optional().describe('Sender email address or name filter'),
      to: z.string().optional().describe('Recipient email address filter'),
      subject: z.string().optional().describe('Subject keyword filter'),
      unreadOnly: z.boolean().optional().default(false).describe('Filter to unread messages only'),
      starredOnly: z.boolean().optional().default(false).describe('Filter to starred/flagged messages only'),
      limit: z.number().optional().default(20).describe('Maximum number of emails to return'),
    },
    async (options) => {
      try {
        const result = await getClient().searchEmails(options);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'get_recent_emails',
    'Retrieve recent emails from Gmail mailbox folder.',
    {
      folder: z.string().optional().default('INBOX').describe('Mailbox folder (default: INBOX)'),
      limit: z.number().optional().default(10).describe('Maximum number of emails to retrieve'),
    },
    async ({ folder, limit }) => {
      try {
        const emails = await getClient().getRecentEmails(folder, limit);
        return { content: [{ type: 'text', text: JSON.stringify({ count: emails.length, emails }, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'get_email',
    'Fetch full email content by ID/UID from Gmail, including markdown body, HTML, headers, and attachments list.',
    {
      folder: z.string().optional().default('INBOX').describe('Mailbox folder (default: INBOX)'),
      id: z.string().describe('ID or UID of the email'),
    },
    async ({ folder, id }) => {
      try {
        const uid = parseInt(id, 10);
        const email = await getClient().getEmailContent(folder, isNaN(uid) ? 1 : uid);
        return { content: [{ type: 'text', text: JSON.stringify(email, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'get_thread',
    'Retrieve conversation thread for a given email ID or thread ID using Gmail native threading.',
    {
      folder: z.string().optional().default('INBOX').describe('Mailbox folder (default: INBOX)'),
      id: z.string().describe('Email ID, UID, or Thread ID'),
    },
    async ({ folder, id }) => {
      try {
        const thread = await getClient().getEmailThread(folder, id);
        return { content: [{ type: 'text', text: JSON.stringify(thread, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'get_attachment',
    'Download and extract an attachment from an email. Provide saveToPath to save directly to disk.',
    {
      folder: z.string().optional().default('INBOX').describe('Mailbox folder (default: INBOX)'),
      id: z.string().describe('Email ID or UID'),
      attachmentId: z.string().describe('Attachment ID or filename'),
      saveToPath: z.string().optional().describe('Optional absolute path to write the file to'),
    },
    async ({ folder, id, attachmentId, saveToPath }) => {
      try {
        const uid = parseInt(id, 10);
        const result = await getClient().getAttachment(folder, isNaN(uid) ? 1 : uid, attachmentId, saveToPath);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              filename: result.filename,
              contentType: result.contentType,
              sizeBytes: result.size,
              savedToPath: result.savedToPath,
              dataBase64: saveToPath ? undefined : result.dataBase64,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'get_raw_email',
    'Fetch raw RFC 822 source for an email. Provide saveToPath to export as a .eml file.',
    {
      folder: z.string().optional().default('INBOX').describe('Mailbox folder (default: INBOX)'),
      id: z.string().describe('Email ID or UID'),
      saveToPath: z.string().optional().describe('Optional path to write the .eml file to'),
    },
    async ({ folder, id, saveToPath }) => {
      try {
        const uid = parseInt(id, 10);
        const result = await getClient().getRawEmail(folder, isNaN(uid) ? 1 : uid, saveToPath);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              uid: result.uid,
              sizeBytes: result.sizeBytes,
              savedToPath: result.savedToPath,
              raw: saveToPath ? undefined : result.raw,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  // ---------------------------------------------------------------- Outbound Sending

  server.tool(
    'send_email',
    'Send an outbound email via Gmail SMTP. Supports plain text, HTML bodies, file attachments, and attaching other emails.',
    {
      to: z.string().describe('Recipient email address or comma-separated list'),
      subject: z.string().describe('Email subject line'),
      bodyText: z.string().describe('Plain text body'),
      bodyHtml: z.string().optional().describe('Optional HTML body (multipart/alternative)'),
      cc: z.string().optional().describe('Optional CC recipient(s)'),
      bcc: z.string().optional().describe('Optional BCC recipient(s)'),
      attachments: z.array(z.string()).optional().describe('Optional absolute paths of files to attach'),
      attachEmailUids: z.array(z.string()).optional().describe('Optional email IDs/UIDs to attach as .eml message attachments'),
    },
    async (options) => {
      try {
        const result = await getClient().sendEmail(options as any);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'reply_email',
    'Reply in-thread to an existing email in Gmail. Derives recipients, subject, and threading headers.',
    {
      folder: z.string().optional().default('INBOX').describe('Mailbox folder (default: INBOX)'),
      id: z.string().describe('ID or UID of the email being replied to'),
      bodyText: z.string().describe('Reply text'),
      bodyHtml: z.string().optional().describe('Optional HTML reply text'),
      replyAll: z.boolean().optional().default(false).describe('Keep everyone already on the thread in Cc'),
      additionalCc: z.string().optional().describe('Extra Cc addresses to include'),
      attachments: z.array(z.string()).optional().describe('Optional file paths to attach'),
      attachEmailUids: z.array(z.string()).optional().describe('Optional email IDs/UIDs to attach as .eml'),
    },
    async ({ folder, id, bodyText, bodyHtml, replyAll, additionalCc, attachments, attachEmailUids }) => {
      try {
        const uid = parseInt(id, 10);
        const result = await getClient().replyEmail(
          folder,
          isNaN(uid) ? 1 : uid,
          bodyText,
          replyAll,
          additionalCc,
          bodyHtml,
          attachments,
          attachEmailUids,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'forward_email',
    'Forward an existing email to new recipients. Supports forwarding inline or as an attached .eml file.',
    {
      folder: z.string().optional().default('INBOX').describe('Mailbox folder (default: INBOX)'),
      id: z.string().describe('ID or UID of the email to forward'),
      to: z.string().describe('Recipient email address'),
      comment: z.string().optional().describe('Optional note prepended above the forwarded email'),
      bodyHtml: z.string().optional().describe('Optional HTML body'),
      attachments: z.array(z.string()).optional().describe('Optional additional file paths to attach'),
      attachAsEml: z.boolean().optional().default(false).describe('If true, attach the original email as a full .eml attachment'),
    },
    async ({ folder, id, to, comment, bodyHtml, attachments, attachAsEml }) => {
      try {
        const uid = parseInt(id, 10);
        const result = await getClient().forwardEmail(
          folder,
          isNaN(uid) ? 1 : uid,
          to,
          comment,
          bodyHtml,
          attachments,
          attachAsEml,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  // ---------------------------------------------------------------- Drafts Lifecycle

  server.tool(
    'create_draft',
    'Create a new email draft in the Gmail Drafts folder without sending it. Supports file and email attachments.',
    {
      to: z.string().optional().describe('Recipient address(es), comma separated'),
      cc: z.string().optional().describe('Cc recipients, comma separated'),
      bcc: z.string().optional().describe('Bcc recipients, comma separated'),
      subject: z.string().optional().describe('Draft subject line'),
      bodyText: z.string().optional().default('').describe('Draft body plain text'),
      bodyHtml: z.string().optional().describe('Optional HTML draft body'),
      attachments: z.array(z.string()).optional().describe('Absolute file paths to attach'),
      attachEmailUids: z.array(z.string()).optional().describe('Email IDs/UIDs to attach as .eml message attachments'),
    },
    async (options) => {
      try {
        const result = await getClient().createDraft(options as any);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'create_reply_draft',
    'Save a reply to an existing email as a draft in Gmail. Recipients, subject, and threading headers are preserved.',
    {
      folder: z.string().optional().default('INBOX').describe('Mailbox folder (default: INBOX)'),
      id: z.string().describe('ID or UID of the email being replied to'),
      bodyText: z.string().describe('The reply body'),
      replyAll: z.boolean().default(false).describe('Keep everyone already on the thread in Cc'),
      additionalCc: z.string().optional().describe('Extra Cc addresses to include'),
      bodyHtml: z.string().optional().describe('Optional HTML body (for tables and styled layout)'),
      attachments: z.array(z.string()).optional().describe('Absolute file paths to attach'),
      attachEmailUids: z.array(z.string()).optional().describe('Email IDs/UIDs to attach as .eml'),
    },
    async ({ folder, id, bodyText, replyAll, additionalCc, bodyHtml, attachments, attachEmailUids }) => {
      try {
        const uid = parseInt(id, 10);
        const result = await getClient().createReplyDraft(
          folder,
          isNaN(uid) ? 1 : uid,
          bodyText,
          replyAll,
          additionalCc,
          bodyHtml,
          attachments,
          attachEmailUids,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'update_draft',
    'Update an existing draft in Gmail Drafts folder, replacing its content, recipients, or attachments.',
    {
      draftId: z.string().describe('Draft ID/UID to update'),
      to: z.string().optional().describe('Recipient address(es)'),
      cc: z.string().optional().describe('Cc recipients'),
      bcc: z.string().optional().describe('Bcc recipients'),
      subject: z.string().optional().describe('Subject line'),
      bodyText: z.string().optional().describe('Plain text body'),
      bodyHtml: z.string().optional().describe('HTML body'),
      attachments: z.array(z.string()).optional().describe('Absolute file paths to attach'),
      attachEmailUids: z.array(z.string()).optional().describe('Email IDs/UIDs to attach as .eml'),
    },
    async ({ draftId, ...rest }) => {
      try {
        const result = await getClient().updateDraft(draftId, rest as any);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'list_drafts',
    'List all email drafts in the Gmail Drafts folder.',
    {
      limit: z.number().optional().default(20).describe('Maximum number of drafts to return'),
    },
    async ({ limit }) => {
      try {
        const result = await getClient().listDrafts(limit);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'get_draft',
    'Fetch one draft by ID/UID including full body, headers, and attachment information.',
    {
      draftId: z.string().describe('Draft ID/UID'),
    },
    async ({ draftId }) => {
      try {
        const result = await getClient().getDraft(draftId);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'send_draft',
    'Send an existing draft immediately and remove it from the Gmail Drafts folder.',
    {
      draftId: z.string().describe('Draft ID/UID to send'),
    },
    async ({ draftId }) => {
      try {
        const result = await getClient().sendDraft(draftId);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'delete_draft',
    'Delete a draft permanently from the Gmail Drafts folder.',
    {
      draftId: z.string().describe('Draft ID/UID to delete'),
    },
    async ({ draftId }) => {
      try {
        const result = await getClient().deleteDraft(draftId);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  // ---------------------------------------------------------------- Labels & Folders

  server.tool('list_labels', 'List all Gmail folders and labels with message and unread counts.', {}, async () => {
    try {
      const folders = await getClient().listFolders();
      return { content: [{ type: 'text', text: JSON.stringify({ count: folders.length, labels: folders }, null, 2) }] };
    } catch (err: any) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  });

  server.tool('create_label', 'Create a new Gmail label.', { name: z.string() }, async ({ name }) => {
    try {
      const result = await getClient().createFolder(name);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  });

  server.tool(
    'rename_label',
    'Rename an existing Gmail label.',
    {
      oldName: z.string().describe('Existing label name'),
      newName: z.string().describe('New label name'),
    },
    async ({ oldName, newName }) => {
      try {
        const result = await getClient().renameFolder(oldName, newName);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool('delete_label', 'Delete a Gmail label.', { name: z.string() }, async ({ name }) => {
    try {
      const result = await getClient().deleteFolder(name);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  });

  server.tool(
    'modify_email_labels',
    'Add or remove labels on one or more emails.',
    {
      folder: z.string().optional().default('INBOX').describe('Mailbox folder (default: INBOX)'),
      id: z.string().describe('Email ID or UID (or comma separated IDs)'),
      addLabels: z.array(z.string()).optional().describe('Labels to add'),
      removeLabels: z.array(z.string()).optional().describe('Labels to remove'),
    },
    async ({ folder, id, addLabels, removeLabels }) => {
      try {
        const uids = id.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
        const result = await getClient().modifyEmailLabels(folder, uids, addLabels, removeLabels);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'batch_modify_labels',
    'Apply label additions/removals to multiple messages at once.',
    {
      folder: z.string().optional().default('INBOX').describe('Mailbox folder (default: INBOX)'),
      ids: z.array(z.string()).describe('List of email IDs/UIDs'),
      addLabels: z.array(z.string()).optional().describe('Labels to add'),
      removeLabels: z.array(z.string()).optional().describe('Labels to remove'),
    },
    async ({ folder, ids, addLabels, removeLabels }) => {
      try {
        const uids = ids.map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
        const result = await getClient().modifyEmailLabels(folder, uids, addLabels, removeLabels);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  // ---------------------------------------------------------------- Triage & Actions

  server.tool(
    'archive_email',
    'Archive email(s) by removing them from INBOX.',
    {
      folder: z.string().optional().default('INBOX').describe('Mailbox folder (default: INBOX)'),
      id: z.string().describe('Email ID or comma-separated IDs'),
    },
    async ({ folder, id }) => {
      try {
        const uids = id.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
        const result = await getClient().archiveEmail(folder, uids);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'star_email',
    'Star or unstar email(s).',
    {
      folder: z.string().optional().default('INBOX').describe('Mailbox folder (default: INBOX)'),
      id: z.string().describe('Email ID or comma-separated IDs'),
      star: z.boolean().default(true).describe('True to star, false to unstar'),
    },
    async ({ folder, id, star }) => {
      try {
        const uids = id.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
        const result = await getClient().starEmail(folder, uids, star);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'mark_email_read',
    'Mark email(s) as read or unread.',
    {
      folder: z.string().optional().default('INBOX').describe('Mailbox folder (default: INBOX)'),
      id: z.string().describe('Email ID or comma-separated IDs'),
      read: z.boolean().default(true).describe('True for read, false for unread'),
    },
    async ({ folder, id, read }) => {
      try {
        const uids = id.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
        const result = await getClient().markEmails(folder, uids, read ? 'read' : 'unread');
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'trash_email',
    'Move email(s) to Gmail Trash. Reversible with untrash_email.',
    {
      folder: z.string().optional().default('INBOX').describe('Mailbox folder (default: INBOX)'),
      id: z.string().describe('Email ID or comma-separated IDs'),
    },
    async ({ folder, id }) => {
      try {
        const uids = id.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
        const result = await getClient().trashEmail(folder, uids);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'untrash_email',
    'Restore email(s) from Gmail Trash back to INBOX.',
    {
      id: z.string().describe('Email ID or comma-separated IDs'),
    },
    async ({ id }) => {
      try {
        const uids = id.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
        const result = await getClient().untrashEmail(uids);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'move_emails',
    'Move email(s) to another mailbox folder.',
    {
      sourceFolder: z.string().describe('Current mailbox folder'),
      targetFolder: z.string().describe('Target mailbox folder'),
      ids: z.array(z.string()).describe('List of email IDs/UIDs to move'),
    },
    async ({ sourceFolder, targetFolder, ids }) => {
      try {
        const uids = ids.map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
        const result = await getClient().moveEmails(sourceFolder, targetFolder, uids);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'delete_email_permanently',
    'IRREVERSIBLE. Permanently delete email(s), bypassing Trash.',
    {
      folder: z.string().optional().default('INBOX').describe('Mailbox folder (default: INBOX)'),
      id: z.string().describe('Email ID or comma-separated IDs'),
      confirm: z.boolean().describe('Must explicitly be true to confirm permanent deletion'),
    },
    async ({ folder, id, confirm }) => {
      if (!confirm) {
        return { isError: true, content: [{ type: 'text', text: 'Error: confirm must be set to true to permanently delete emails.' }] };
      }
      try {
        const uids = id.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
        const result = await getClient().deleteEmailsPermanently(folder, uids);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  // ---------------------------------------------------------------- Account Profile

  server.tool('get_profile', 'Get authenticated mailbox address and status summary.', {}, async () => {
    try {
      const profile = await getClient().getProfile();
      return { content: [{ type: 'text', text: JSON.stringify(profile, null, 2) }] };
    } catch (err: any) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  });

  // ---------------------------------------------------------------- Resources

  server.resource(
    'labels',
    'gmail://labels',
    {
      description: 'Live catalog of Gmail folders and labels with unread counts.',
      mimeType: 'application/json',
    },
    async () => {
      try {
        const folders = await getClient().listFolders();
        return {
          contents: [{ uri: 'gmail://labels', mimeType: 'application/json', text: JSON.stringify({ count: folders.length, labels: folders }, null, 2) }],
        };
      } catch (err: any) {
        return { contents: [{ uri: 'gmail://labels', mimeType: 'application/json', text: JSON.stringify({ error: err.message }) }] };
      }
    }
  );

  server.resource(
    'profile',
    'gmail://profile',
    {
      description: 'Authenticated mailbox address and message counters.',
      mimeType: 'application/json',
    },
    async () => {
      try {
        const profile = await getClient().getProfile();
        return {
          contents: [{ uri: 'gmail://profile', mimeType: 'application/json', text: JSON.stringify(profile, null, 2) }],
        };
      } catch (err: any) {
        return { contents: [{ uri: 'gmail://profile', mimeType: 'application/json', text: JSON.stringify({ error: err.message }) }] };
      }
    }
  );

  // ---------------------------------------------------------------- Prompts

  server.prompt(
    'triage-inbox',
    'Inspect recent unread emails, prioritize into categories, and recommend triage actions.',
    {
      limit: z.string().optional().describe('Maximum number of unread emails to inspect (default: 10)'),
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
    }
  );

  server.prompt(
    'draft-reply',
    'Read a thread and prepare a contextual reply as a draft for review.',
    {
      id: z.string().describe('The email ID to reply to'),
      tone: z.string().optional().describe('professional, friendly, concise, or assertive'),
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
    })
  );

  return server;
}
