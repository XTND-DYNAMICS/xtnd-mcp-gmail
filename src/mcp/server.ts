/**
 * MCP server factory for @xtnd-dynamics/mcp-gmail.
 *
 * Registers 42 tools, 3 resources and 4 workflow prompts across the Gmail
 * message, thread, draft, label, triage and settings surfaces.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GmailClient } from '../core/client.js';
import { registerDraftTools } from './tools/drafts.js';
import { registerLabelTools } from './tools/labels.js';
import { registerOutboundTools } from './tools/outbound.js';
import { registerReadTools } from './tools/read.js';
import { registerSearchTools } from './tools/search.js';
import { registerSettingsTools } from './tools/settings.js';
import { registerTriageTools } from './tools/triage.js';

const VERSION = '0.1.0';

export function createGmailMcpServer(getClient: () => GmailClient): McpServer {
  const server = new McpServer({ name: '@xtnd-dynamics/mcp-gmail', version: VERSION });

  registerSearchTools(server, getClient);
  registerReadTools(server, getClient);
  registerOutboundTools(server, getClient);
  registerDraftTools(server, getClient);
  registerLabelTools(server, getClient);
  registerTriageTools(server, getClient);
  registerSettingsTools(server, getClient);

  registerResources(server, getClient);
  registerPrompts(server);

  return server;
}

function registerResources(server: McpServer, getClient: () => GmailClient) {
  server.resource(
    'labels',
    'gmail://labels',
    {
      description: 'Live catalog of Gmail labels with message and thread counts.',
      mimeType: 'application/json',
    },
    async () => {
      try {
        const labels = await getClient().listLabels();
        return jsonResource('gmail://labels', { count: labels.length, labels });
      } catch (error: unknown) {
        return jsonResource('gmail://labels', { error: messageOf(error) });
      }
    },
  );

  server.resource(
    'profile',
    'gmail://profile',
    {
      description: 'Authenticated mailbox address and mailbox size counters.',
      mimeType: 'application/json',
    },
    async () => {
      try {
        return jsonResource('gmail://profile', await getClient().getProfile());
      } catch (error: unknown) {
        return jsonResource('gmail://profile', { error: messageOf(error) });
      }
    },
  );

  server.resource(
    'search-syntax',
    'gmail://reference/search-syntax',
    {
      description: 'Gmail search operator reference for composing query arguments.',
      mimeType: 'text/markdown',
    },
    async () => ({
      contents: [{
        uri: 'gmail://reference/search-syntax',
        mimeType: 'text/markdown',
        text: `# Gmail search operators

| Operator | Meaning |
| --- | --- |
| \`from:\` / \`to:\` / \`cc:\` / \`bcc:\` | Match a correspondent |
| \`subject:\` | Words in the subject |
| \`label:\` / \`in:\` | Label or system location (inbox, sent, drafts, spam, trash, anywhere) |
| \`is:\` | unread, read, starred, important, snoozed |
| \`has:\` | attachment, drive, document, youtube, userlabels, nouserlabels |
| \`filename:\` | Attachment name or extension |
| \`newer_than:\` / \`older_than:\` | Relative age, e.g. \`7d\`, \`2m\`, \`1y\` |
| \`after:\` / \`before:\` | Absolute date, \`YYYY/MM/DD\` |
| \`larger:\` / \`smaller:\` | Size, e.g. \`10M\` |
| \`"..."\` | Exact phrase |
| \`-\` | Negate a term |
| \`{a b}\` or \`OR\` | Match any |
| \`AROUND n\` | Words within n of each other |

Gmail has no folders. A message's location is its label set: archiving means
removing \`INBOX\`, and marking unread means adding \`UNREAD\`.`,
      }],
    }),
  );
}

function registerPrompts(server: McpServer) {
  server.prompt(
    'triage-inbox',
    'Inspect recent unread mail, prioritise it, and recommend label and archive actions.',
    { limit: z.string().optional().describe('How many unread messages to inspect (default: 10)') },
    async (args) => {
      const limit = args.limit ? parseInt(args.limit, 10) : 10;
      return userPrompt(`Please triage my Gmail inbox:
1. Call search_messages({ query: "is:unread in:inbox", limit: ${limit} }).
2. Read the important ones in full with get_message.
3. Group them into Urgent, Action Required, Informational, and Newsletters.
4. Propose label or archive actions, and use batch_modify_labels for bulk changes
   once I have confirmed them.`);
    },
  );

  server.prompt(
    'draft-reply',
    'Read a thread and prepare a contextual reply as a draft for review.',
    {
      messageId: z.string().describe('The Gmail message ID to reply to'),
      tone: z.string().optional().describe('professional, friendly, concise, or assertive'),
    },
    async (args) => userPrompt(`Please prepare a reply to message ${args.messageId}:
1. Read it with get_message, and the surrounding thread with get_thread.
2. Draft a ${args.tone || 'professional'} reply that answers every question asked.
3. Create it with create_draft so I can review it in Gmail before it is sent.
   Do not call send_message or reply_message unless I ask you to.`),
  );

  server.prompt(
    'find-and-archive',
    'Find clutter matching a description and archive it in bulk after confirmation.',
    { description: z.string().describe('What to look for, e.g. "old newsletters from 2024"') },
    async (args) => userPrompt(`Please help me clear out: ${args.description}
1. Translate that into Gmail search syntax and call search_messages.
2. Show me the senders, subjects and counts you found.
3. Wait for my confirmation, then archive them with
   batch_modify_labels({ removeLabelIds: ["INBOX"] }).
Do not trash or delete anything unless I explicitly ask.`),
  );

  server.prompt(
    'daily-briefing',
    'Summarise the last day of mail into an executive briefing with an action list.',
    {},
    async () => userPrompt(`Please generate a briefing of my Gmail:
1. Call search_messages({ query: "newer_than:1d in:inbox", limit: 25 }).
2. Read the ones from clients and colleagues with get_message.
3. Produce a markdown summary:
   - Urgent / blockers
   - Waiting on a decision from me
   - FYI
   - Consolidated action checklist with the message ID beside each item.`),
  );
}

function userPrompt(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

function jsonResource(uri: string, payload: unknown) {
  return {
    contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) }],
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown failure.';
}
