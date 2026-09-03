/**
 * Search and listing tools.
 *
 * Gmail's own query language is far more expressive than anything this server
 * could re-model, so the tools pass it through rather than inventing filter
 * arguments. The schema descriptions teach the model the syntax.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GmailClient } from '../../core/client.js';
import { ListThreadsSchema, SearchMessagesSchema } from '../schemas.js';
import { run } from './respond.js';

export function registerSearchTools(server: McpServer, getClient: () => GmailClient) {
  server.tool(
    'search_messages',
    'Search the mailbox with native Gmail query syntax and return matching message summaries. '
    + 'Supports every Gmail operator: from:, to:, subject:, label:, has:attachment, is:unread, '
    + 'newer_than:, older_than:, larger:, filename:, and boolean grouping.',
    SearchMessagesSchema.shape,
    async (args) => run('search_messages', async () => {
      const page = await getClient().searchMessages({
        query: args.query,
        labelIds: args.labelIds,
        includeSpamTrash: args.includeSpamTrash,
        limit: args.limit,
        pageToken: args.pageToken,
      });

      return {
        resultSizeEstimate: page.resultSizeEstimate,
        nextPageToken: page.nextPageToken,
        count: page.items.length,
        messages: page.items.map((message) => ({
          id: message.id,
          threadId: message.threadId,
          from: message.from,
          to: message.to,
          cc: message.cc,
          subject: message.subject,
          date: message.date,
          labelIds: message.labelIds,
          hasAttachments: message.hasAttachments,
          snippet: message.snippet,
        })),
      };
    }),
  );

  server.tool(
    'list_threads',
    'List conversation threads matching a Gmail query. Cheaper than search_messages when you only '
    + 'need to identify conversations; follow up with get_thread for the contents.',
    ListThreadsSchema.shape,
    async (args) => run('list_threads', async () => {
      const page = await getClient().listThreads({
        query: args.query,
        labelIds: args.labelIds,
        includeSpamTrash: args.includeSpamTrash,
        limit: args.limit,
        pageToken: args.pageToken,
      });

      return {
        resultSizeEstimate: page.resultSizeEstimate,
        nextPageToken: page.nextPageToken,
        count: page.items.length,
        threads: page.items,
      };
    }),
  );
}
