/**
 * Trash and deletion tools.
 *
 * Trash is reversible and needs only `gmail.modify`. Permanent deletion is not
 * reversible, needs the full-mailbox scope, and is refused unless the profile
 * was created with `--allow-permanent-delete`. The `confirm` argument is a
 * second, independent gate so a malformed tool call cannot reach it.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GmailClient } from '../../core/client.js';
import {
  DeleteMessagePermanentlySchema,
  DeleteThreadPermanentlySchema,
  TrashMessageSchema,
  TrashThreadSchema,
  UntrashMessageSchema,
  UntrashThreadSchema,
} from '../schemas.js';
import { run } from './respond.js';

export function registerTriageTools(server: McpServer, getClient: () => GmailClient) {
  server.tool(
    'trash_message',
    'Move a message to Trash, where Gmail keeps it for 30 days. Reversible with untrash_message.',
    TrashMessageSchema.shape,
    async (args) => run('trash_message', async () => {
      await getClient().trashMessage(args.messageId);
      return { trashed: true, messageId: args.messageId, reversible: true };
    }),
  );

  server.tool(
    'untrash_message',
    'Restore a message from Trash to where its labels place it.',
    UntrashMessageSchema.shape,
    async (args) => run('untrash_message', async () => {
      await getClient().untrashMessage(args.messageId);
      return { restored: true, messageId: args.messageId };
    }),
  );

  server.tool(
    'trash_thread',
    'Move an entire conversation to Trash. Reversible with untrash_thread.',
    TrashThreadSchema.shape,
    async (args) => run('trash_thread', async () => {
      await getClient().trashThread(args.threadId);
      return { trashed: true, threadId: args.threadId, reversible: true };
    }),
  );

  server.tool(
    'untrash_thread',
    'Restore an entire conversation from Trash.',
    UntrashThreadSchema.shape,
    async (args) => run('untrash_thread', async () => {
      await getClient().untrashThread(args.threadId);
      return { restored: true, threadId: args.threadId };
    }),
  );

  server.tool(
    'delete_message_permanently',
    'IRREVERSIBLE. Delete a message outright, bypassing Trash. Prefer trash_message in every case '
    + 'where the user has not explicitly asked for permanent destruction. Requires the profile to '
    + 'have been set up with --allow-permanent-delete.',
    DeleteMessagePermanentlySchema.shape,
    async (args) => run('delete_message_permanently', async () => {
      await getClient().deleteMessagePermanently(args.messageId);
      return { deleted: true, messageId: args.messageId, reversible: false };
    }),
  );

  server.tool(
    'delete_thread_permanently',
    'IRREVERSIBLE. Delete an entire conversation outright, bypassing Trash. Requires the profile to '
    + 'have been set up with --allow-permanent-delete.',
    DeleteThreadPermanentlySchema.shape,
    async (args) => run('delete_thread_permanently', async () => {
      await getClient().deleteThreadPermanently(args.threadId);
      return { deleted: true, threadId: args.threadId, reversible: false };
    }),
  );
}
