/**
 * Label tools.
 *
 * Gmail has no folders: a message's location is the set of labels on it, and
 * archiving is removing INBOX. The tool descriptions say so explicitly, because
 * a model reasoning in folder terms will otherwise reach for a move operation
 * that does not exist.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GmailClient } from '../../core/client.js';
import {
  BatchModifyLabelsSchema,
  CreateLabelSchema,
  DeleteLabelSchema,
  GetLabelSchema,
  ListLabelsSchema,
  ModifyMessageLabelsSchema,
  ModifyThreadLabelsSchema,
  UpdateLabelSchema,
} from '../schemas.js';
import { run } from './respond.js';

export function registerLabelTools(server: McpServer, getClient: () => GmailClient) {
  server.tool(
    'list_labels',
    'List every label with its ID and unread counts. Call this first: all other label tools take '
    + 'IDs, not display names.',
    ListLabelsSchema.shape,
    async () => run('list_labels', async () => {
      const labels = await getClient().listLabels();
      return {
        count: labels.length,
        labels: labels.map((label) => ({
          id: label.id,
          name: label.name,
          type: label.type,
          messagesTotal: label.messagesTotal,
          messagesUnread: label.messagesUnread,
        })),
      };
    }),
  );

  server.tool(
    'get_label',
    'Fetch one label including its message and thread counts.',
    GetLabelSchema.shape,
    async (args) => run('get_label', async () => getClient().getLabel(args.labelId)),
  );

  server.tool(
    'create_label',
    'Create a label. Use "Parent/Child" in the name to nest it under an existing label.',
    CreateLabelSchema.shape,
    async (args) => run('create_label', async () => {
      const label = await getClient().createLabel({
        name: args.name,
        messageListVisibility: args.messageListVisibility,
        labelListVisibility: args.labelListVisibility,
        color: args.color,
      });
      return { created: true, id: label.id, name: label.name };
    }),
  );

  server.tool(
    'update_label',
    'Rename a label or change its visibility and colour.',
    UpdateLabelSchema.shape,
    async (args) => run('update_label', async () => {
      const label = await getClient().updateLabel(args.labelId, {
        name: args.name,
        messageListVisibility: args.messageListVisibility,
        labelListVisibility: args.labelListVisibility,
        color: args.color,
      });
      return { updated: true, id: label.id, name: label.name };
    }),
  );

  server.tool(
    'delete_label',
    'Delete a label. This removes it from every message carrying it, but does not delete the '
    + 'messages themselves.',
    DeleteLabelSchema.shape,
    async (args) => run('delete_label', async () => {
      await getClient().deleteLabel(args.labelId);
      return { deleted: true, labelId: args.labelId };
    }),
  );

  server.tool(
    'modify_message_labels',
    'Add or remove labels on one message. Removing INBOX archives it; adding TRASH does not '
    + 'delete it, use trash_message for that. Adding UNREAD marks it unread.',
    ModifyMessageLabelsSchema.shape,
    async (args) => run('modify_message_labels', async () => {
      const message = await getClient().modifyMessageLabels(args.messageId, {
        addLabelIds: args.addLabelIds,
        removeLabelIds: args.removeLabelIds,
      });
      return { updated: true, id: message.id, labelIds: message.labelIds };
    }),
  );

  server.tool(
    'modify_thread_labels',
    'Add or remove labels across every message in a thread.',
    ModifyThreadLabelsSchema.shape,
    async (args) => run('modify_thread_labels', async () => {
      await getClient().modifyThreadLabels(args.threadId, {
        addLabelIds: args.addLabelIds,
        removeLabelIds: args.removeLabelIds,
      });
      return {
        updated: true,
        threadId: args.threadId,
        addLabelIds: args.addLabelIds,
        removeLabelIds: args.removeLabelIds,
      };
    }),
  );

  server.tool(
    'batch_modify_labels',
    'Apply the same label change to up to 1000 messages in a single call. Far cheaper than looping '
    + 'modify_message_labels, and the right tool for bulk archiving or marking read.',
    BatchModifyLabelsSchema.shape,
    async (args) => run('batch_modify_labels', async () => {
      await getClient().batchModifyMessages(args.messageIds, {
        addLabelIds: args.addLabelIds,
        removeLabelIds: args.removeLabelIds,
      });
      return {
        updated: true,
        messageCount: args.messageIds.length,
        addLabelIds: args.addLabelIds,
        removeLabelIds: args.removeLabelIds,
      };
    }),
  );
}
