/**
 * Draft tools.
 *
 * Gmail drafts are first-class resources rather than a folder convention, so
 * create/update/send/delete map onto real endpoints. This is the path to
 * prefer whenever a human should approve a message before it is sent.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GmailClient } from '../../core/client.js';
import {
  CreateDraftSchema,
  CreateReplyDraftSchema,
  DeleteDraftSchema,
  GetDraftSchema,
  ListDraftsSchema,
  SendDraftSchema,
  UpdateDraftSchema,
} from '../schemas.js';
import { run } from './respond.js';

export function registerDraftTools(server: McpServer, getClient: () => GmailClient) {
  server.tool(
    'create_draft',
    'Create a draft in the Gmail Drafts folder without sending it. The draft is visible in the '
    + 'user\'s own Gmail client, so it can be reviewed, edited and sent by hand.',
    CreateDraftSchema.shape,
    async (args) => run('create_draft', async () => {
      const draft = await getClient().createDraft({
        to: args.to || '',
        cc: args.cc,
        bcc: args.bcc,
        from: args.from,
        subject: args.subject || '',
        bodyText: args.bodyText || '',
        bodyHtml: args.bodyHtml,
        threadId: args.threadId,
        attachments: args.attachments as any,
        attachEmailUids: args.attachEmailIds,
      });

      return {
        created: true,
        draftId: draft.id,
        messageId: draft.message.id,
        threadId: draft.message.threadId,
        to: args.to,
        subject: args.subject,
      };
    }),
  );

  server.tool(
    'create_reply_draft',
    'Create a reply draft to an existing email in Gmail Drafts folder. Derives recipient, subject, threading headers, and automatically quotes the original message.',
    CreateReplyDraftSchema.shape,
    async (args) => run('create_reply_draft', async () => {
      const draft = await getClient().createReplyDraft(args.messageId, {
        bodyText: args.bodyText,
        bodyHtml: args.bodyHtml,
        replyAll: args.replyAll,
        from: args.from,
        quoteOriginal: args.quoteOriginal,
      });

      return {
        created: true,
        draftId: draft.id,
        messageId: draft.message.id,
        threadId: draft.message.threadId,
        to: draft.message.to,
        cc: draft.message.cc,
        subject: draft.message.subject,
      };
    }),
  );

  server.tool(
    'update_draft',
    'Replace the entire contents of an existing draft. Gmail has no partial update: every field '
    + 'you want to keep must be supplied again.',
    UpdateDraftSchema.shape,
    async (args) => run('update_draft', async () => {
      const draft = await getClient().updateDraft(args.draftId, {
        to: args.to || '',
        cc: args.cc,
        bcc: args.bcc,
        from: args.from,
        subject: args.subject || '',
        bodyText: args.bodyText || '',
        bodyHtml: args.bodyHtml,
        threadId: args.threadId,
        attachments: args.attachments as any,
        attachEmailUids: args.attachEmailIds,
      });

      return {
        updated: true,
        draftId: draft.id,
        messageId: draft.message.id,
        subject: args.subject,
      };
    }),
  );

  server.tool(
    'list_drafts',
    'List drafts with their recipients and subjects.',
    ListDraftsSchema.shape,
    async (args) => run('list_drafts', async () => {
      const page = await getClient().listDrafts(args.limit, args.pageToken);

      return {
        count: page.items.length,
        nextPageToken: page.nextPageToken,
        drafts: page.items.map((draft) => ({
          draftId: draft.id,
          messageId: draft.message.id,
          threadId: draft.message.threadId,
          to: draft.message.to,
          cc: draft.message.cc,
          subject: draft.message.subject,
          date: draft.message.date,
        })),
      };
    }),
  );

  server.tool(
    'get_draft',
    'Fetch one draft including its body.',
    GetDraftSchema.shape,
    async (args) => run('get_draft', async () => {
      const draft = await getClient().getDraft(args.draftId);

      return {
        draftId: draft.id,
        messageId: draft.message.id,
        threadId: draft.message.threadId,
        to: draft.message.to,
        cc: draft.message.cc,
        bcc: draft.message.bcc,
        subject: draft.message.subject,
        body: draft.message.bodyMarkdown ?? draft.message.bodyText ?? '',
      };
    }),
  );

  server.tool(
    'send_draft',
    'Send an existing draft as-is. Sends immediately and cannot be recalled.',
    SendDraftSchema.shape,
    async (args) => run('send_draft', async () => {
      const sent = await getClient().sendDraft(args.draftId);

      return {
        sent: true,
        draftId: args.draftId,
        id: sent.id,
        threadId: sent.threadId,
        to: sent.to,
        subject: sent.subject,
      };
    }),
  );

  server.tool(
    'delete_draft',
    'Delete a draft permanently. Drafts do not go to Trash, so this cannot be undone.',
    DeleteDraftSchema.shape,
    async (args) => run('delete_draft', async () => {
      await getClient().deleteDraft(args.draftId);
      return { deleted: true, draftId: args.draftId };
    }),
  );
}
