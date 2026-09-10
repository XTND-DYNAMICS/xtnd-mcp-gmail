/**
 * Sending tools.
 *
 * These are the only tools in the package that put mail in front of another
 * person, so each one returns the resulting Gmail id and thread id: the caller
 * can then show exactly what was sent rather than asserting that it worked.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GmailClient } from '../../core/client.js';
import { forwardSubject, replySubject } from '../../core/parser/rfc822.js';
import { ForwardMessageSchema, ReplyMessageSchema, SendMessageSchema } from '../schemas.js';
import { run } from './respond.js';

export function registerOutboundTools(server: McpServer, getClient: () => GmailClient) {
  server.tool(
    'send_message',
    'Send a new email immediately. Use create_draft instead when the message should be reviewed '
    + 'before it leaves the account.',
    SendMessageSchema.shape,
    async (args) => run('send_message', async () => {
      const sent = await getClient().sendMessage({
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        from: args.from,
        subject: args.subject,
        bodyText: args.bodyText,
        bodyHtml: args.bodyHtml,
        attachments: args.attachments as any,
        attachEmailUids: args.attachEmailIds,
      });

      return {
        sent: true,
        id: sent.id,
        threadId: sent.threadId,
        messageId: sent.messageId,
        to: args.to,
        subject: args.subject,
      };
    }),
  );

  server.tool(
    'reply_message',
    'Reply in-thread to an existing message. Recipients, subject, threading headers, and quoted original are automatically managed.',
    ReplyMessageSchema.shape,
    async (args) => run('reply_message', async () => {
      const sent = await getClient().replyToMessage(args.messageId, {
        bodyText: args.bodyText,
        bodyHtml: args.bodyHtml,
        replyAll: args.replyAll,
        from: args.from,
        quoteOriginal: args.quoteOriginal,
      });

      return {
        sent: true,
        id: sent.id,
        threadId: sent.threadId,
        inReplyTo: args.messageId,
        replyAll: args.replyAll,
        to: sent.to,
        cc: sent.cc,
        subject: sent.subject,
      };
    }),
  );

  server.tool(
    'forward_message',
    'Forward an existing message, optionally with a note above the quoted original or as an attached .eml file.',
    ForwardMessageSchema.shape,
    async (args) => run('forward_message', async () => {
      const source = await getClient().getMessage(args.messageId, 'full');
      let sent: any;

      if (args.attachAsEml) {
        const rawMsg = await getClient().getMessage(args.messageId, 'raw');
        sent = await getClient().sendMessage({
          from: args.from,
          to: args.to,
          subject: forwardSubject(source.subject),
          bodyText: args.comment || 'Attached is the forwarded message.',
          attachments: args.attachments as any,
          attachedEmails: rawMsg.raw ? [{
            filename: `${source.subject.replace(/[/\\?%*:|"<>]/g, '_')}.eml`,
            rawEml: rawMsg.raw,
          }] : undefined,
        });
      } else {
        const quoted = [
          args.comment ?? '',
          '',
          '---------- Forwarded message ----------',
          `From: ${source.from.map((a) => a.address).join(', ')}`,
          `Date: ${source.date}`,
          `Subject: ${source.subject}`,
          `To: ${source.to.map((a) => a.address).join(', ')}`,
          '',
          source.bodyText ?? source.bodyMarkdown ?? '',
        ].join('\n');

        sent = await getClient().sendMessage({
          from: args.from,
          to: args.to,
          subject: forwardSubject(source.subject),
          bodyText: quoted,
          attachments: args.attachments as any,
        });
      }

      return {
        sent: true,
        id: sent.id,
        threadId: sent.threadId,
        forwarded: args.messageId,
        to: args.to,
        subject: sent.subject,
      };
    }),
  );
}
