/**
 * Message, thread and attachment reading tools.
 */

import { writeFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GmailClient } from '../../core/client.js';
import { truncateForAI } from '../../core/parser/markdown.js';
import { base64UrlToBytes } from '../../core/parser/payload.js';
import { GetAttachmentSchema, GetMessageSchema, GetThreadSchema } from '../schemas.js';
import { run } from './respond.js';

/** Bodies beyond this are truncated so one message cannot exhaust the context. */
const BODY_BUDGET = 15_000;
const THREAD_BODY_BUDGET = 4_000;
const SNIPPET_BUDGET = 500;

export function registerReadTools(server: McpServer, getClient: () => GmailClient) {
  server.tool(
    'get_message',
    'Fetch one message by ID. The body is converted to Markdown by default, which is the most '
    + 'token-efficient representation; ask for text, html, or raw when you need the original.',
    GetMessageSchema.shape,
    async (args) => run('get_message', async () => {
      const message = await getClient().getMessage(
        args.messageId,
        args.format === 'raw' ? 'raw' : 'full',
      );

      const body = selectBody(message, args.format);
      const { text, truncated } = truncateForAI(body, BODY_BUDGET);

      return {
        id: message.id,
        threadId: message.threadId,
        messageId: message.messageId,
        subject: message.subject,
        from: message.from,
        to: message.to,
        cc: message.cc,
        bcc: message.bcc,
        replyTo: message.replyTo,
        date: message.date,
        labelIds: message.labelIds,
        hasAttachments: message.hasAttachments,
        attachments: message.attachments?.map((attachment) => ({
          attachmentId: attachment.attachmentId,
          filename: attachment.filename,
          contentType: attachment.contentType,
          size: attachment.size,
        })),
        bodyFormat: args.format,
        truncated,
        body: text,
      };
    }),
  );

  server.tool(
    'get_thread',
    'Retrieve a whole conversation. Returns snippets by default; set includeBodies when you need '
    + 'the full text of every message, which is markedly more expensive on long threads.',
    GetThreadSchema.shape,
    async (args) => run('get_thread', async () => {
      const thread = await getClient().getThread(args.threadId);
      const budget = args.includeBodies ? THREAD_BODY_BUDGET : SNIPPET_BUDGET;

      return {
        id: thread.id,
        count: thread.messages.length,
        messages: thread.messages.map((message) => ({
          id: message.id,
          messageId: message.messageId,
          from: message.from,
          to: message.to,
          cc: message.cc,
          date: message.date,
          subject: message.subject,
          labelIds: message.labelIds,
          hasAttachments: message.hasAttachments,
          body: truncateForAI(
            args.includeBodies
              ? message.bodyMarkdown || message.bodyText || ''
              : message.snippet || '',
            budget,
          ).text,
        })),
      };
    }),
  );

  server.tool(
    'get_attachment',
    'Download an attachment. Provide saveToPath to write it to disk and keep the bytes out of the '
    + 'conversation; omit it only for small files you genuinely need inline as base64.',
    GetAttachmentSchema.shape,
    async (args) => run('get_attachment', async () => {
      const data = await getClient().getAttachment(args.messageId, args.attachmentId);

      if (!args.saveToPath) {
        return {
          messageId: args.messageId,
          attachmentId: args.attachmentId,
          encoding: 'base64url',
          sizeBytes: base64UrlToBytes(data).byteLength,
          data,
        };
      }

      const bytes = base64UrlToBytes(data);
      await writeFile(args.saveToPath, bytes);

      return {
        messageId: args.messageId,
        attachmentId: args.attachmentId,
        savedTo: args.saveToPath,
        sizeBytes: bytes.byteLength,
      };
    }),
  );
}

function selectBody(
  message: { bodyMarkdown?: string; bodyText?: string; bodyHtml?: string; raw?: string },
  format: 'markdown' | 'text' | 'html' | 'raw',
): string {
  if (format === 'raw') return message.raw ?? '';
  if (format === 'html') return message.bodyHtml ?? message.bodyText ?? '';
  if (format === 'text') return message.bodyText ?? message.bodyMarkdown ?? '';
  return message.bodyMarkdown ?? message.bodyText ?? '';
}
