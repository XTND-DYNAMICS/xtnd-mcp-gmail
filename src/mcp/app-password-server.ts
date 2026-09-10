/**
 * App Password MCP Server for @xtnd-dynamics/mcp-gmail
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AppPasswordGmailClient } from '../core/app-password-client.js';

export function createAppPasswordGmailMcpServer(getClient: () => AppPasswordGmailClient): McpServer {
  const server = new McpServer({
    name: '@xtnd-dynamics/mcp-gmail',
    version: '0.1.0',
  });

  // Folders / Labels
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

  server.tool('delete_label', 'Delete a Gmail label.', { name: z.string() }, async ({ name }) => {
    try {
      const result = await getClient().deleteFolder(name);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  });

  // Search
  server.tool(
    'search_emails',
    'Search for emails in Gmail using filters (query, folder, sender, recipient, flags).',
    {
      folder: z.string().optional().default('INBOX'),
      query: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      subject: z.string().optional(),
      unreadOnly: z.boolean().optional().default(false),
      limit: z.number().optional().default(20),
    },
    async (options) => {
      try {
        const result = await getClient().searchEmails(options as any);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  // Read
  server.tool(
    'get_recent_emails',
    'Retrieve recent emails from Gmail.',
    {
      folder: z.string().optional().default('INBOX'),
      limit: z.number().optional().default(10),
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
    'Fetch full email content by ID from Gmail.',
    {
      folder: z.string().optional().default('INBOX'),
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
    'Retrieve conversation thread for a given email ID.',
    {
      folder: z.string().optional().default('INBOX'),
      id: z.string().describe('Email ID or Message-ID'),
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

  // Outbound
  server.tool(
    'send_email',
    'Send an outbound email via Gmail SMTP (smtp.gmail.com:465).',
    {
      to: z.string().describe('Recipient email address'),
      subject: z.string().describe('Email subject'),
      bodyText: z.string().describe('Plain text body'),
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
    'Reply to an existing email in Gmail.',
    {
      folder: z.string().optional().default('INBOX'),
      id: z.string().describe('ID or UID of the email'),
      bodyText: z.string().describe('Reply text'),
      replyAll: z.boolean().optional().default(false),
    },
    async ({ folder, id, bodyText, replyAll }) => {
      try {
        const uid = parseInt(id, 10);
        const result = await getClient().replyEmail(folder, isNaN(uid) ? 1 : uid, bodyText, replyAll);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'forward_email',
    'Forward an existing email to new recipients.',
    {
      folder: z.string().optional().default('INBOX'),
      id: z.string().describe('ID or UID of the email'),
      to: z.string().describe('Recipient email address'),
      comment: z.string().optional(),
    },
    async ({ folder, id, to, comment }) => {
      try {
        const uid = parseInt(id, 10);
        const result = await getClient().forwardEmail(folder, isNaN(uid) ? 1 : uid, to, comment);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'create_draft',
    'Create a new email draft in the Gmail Drafts folder without sending it.',
    {
      to: z.string().describe('Recipient address, or several separated by commas'),
      cc: z.string().optional().describe('Cc recipients, comma separated'),
      bcc: z.string().optional().describe('Bcc recipients, comma separated'),
      subject: z.string(),
      bodyText: z.string(),
    },
    async ({ to, cc, bcc, subject, bodyText }) => {
      try {
        const result = await getClient().createDraft({ to, cc, bcc, subject, bodyText });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'create_reply_draft',
    'Save a reply to an existing email as a draft instead of sending it. Recipients, subject and '
    + 'the threading headers are derived from the original, so the draft opens in Gmail as a proper '
    + 'in-thread reply that a human can read and send. Prefer this over reply_email whenever the '
    + 'message should be reviewed before it reaches the recipient.',
    {
      folder: z.string().optional().default('INBOX'),
      id: z.string().describe('ID or UID of the email being replied to'),
      bodyText: z.string().describe('The reply body'),
      replyAll: z.boolean().default(false).describe('Keep everyone already on the thread in Cc'),
      additionalCc: z.string().optional().describe(
        'Extra Cc addresses, comma separated, merged with the ones derived from the original. '
        + 'Use it to bring someone into a thread they were not on. Duplicates are removed.',
      ),
      bodyHtml: z.string().optional().describe(
        'Optional HTML body, sent alongside bodyText as multipart/alternative. Required for '
        + 'anything that depends on layout: Gmail renders plain text in a proportional font, so '
        + 'a text table collapses into ragged columns. Use a real <table> here instead.',
      ),
      attachments: z.array(z.string()).optional().describe(
        'Absolute paths to files to attach. Each is read from disk and added as its own MIME '
        + 'part, so the draft opens in Gmail with the files already attached and ready to send.',
      ),
    },
    async ({ folder, id, bodyText, replyAll, additionalCc, bodyHtml, attachments }) => {
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
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  // Triage
  server.tool(
    'trash_email',
    'Move email to Gmail Trash.',
    {
      folder: z.string().optional().default('INBOX'),
      id: z.string().describe('Email ID or UID'),
    },
    async ({ folder, id }) => {
      try {
        const uid = parseInt(id, 10);
        const result = await getClient().deleteEmails(folder, [isNaN(uid) ? 1 : uid], false);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    'mark_email_read',
    'Mark email as read or unread.',
    {
      folder: z.string().optional().default('INBOX'),
      id: z.string().describe('Email ID or UID'),
      read: z.boolean().default(true),
    },
    async ({ folder, id, read }) => {
      try {
        const uid = parseInt(id, 10);
        const result = await getClient().markEmails(folder, [isNaN(uid) ? 1 : uid], read ? 'read' : 'unread');
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  // Resources
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

  // Prompts
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
1. Fetch up to ${limit} unread emails using search_emails({ unreadOnly: true, limit: ${limit} }).
2. For important emails, read full content with get_email.
3. Categorize into Urgent, Action Required, and Informational.
4. Suggest reply drafts or archive/trash actions.`,
            },
          },
        ],
      };
    }
  );

  return server;
}
