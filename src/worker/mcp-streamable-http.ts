import { AppPasswordGmailClient } from '../core/app-password-client.js';
import { truncateForAI } from '../core/parser/markdown.js';
import type { GmailAppPasswordCredentials } from '../types.js';
import {
  CreateDraftSchema,
  CreateFolderSchema,
  DeleteEmailsSchema,
  DeleteFolderSchema,
  ForwardEmailSchema,
  GetEmailContentSchema,
  GetEmailThreadSchema,
  GetRecentEmailsSchema,
  ListFoldersSchema,
  MarkEmailsSchema,
  MoveEmailsSchema,
  RenameFolderSchema,
  ReplyEmailSchema,
  SearchEmailsSchema,
  SendEmailSchema,
} from '../mcp/schemas.js';
import { z } from 'zod';
import { readRequestJson, RequestBodyTooLargeError } from './request-body.js';
import { handleSseConnect } from './sse-handler.js';

const SERVER_INFO = {
  name: '@xtnd-dynamics/mcp-gmail',
  version: '0.1.0',
};

const PROTOCOL_VERSION = '2024-11-05';
const MAX_MCP_REQUEST_BYTES = 1_048_576;
const MAIL_SCOPES = ['mail.read', 'mail.manage', 'mail.send', 'mail.delete'] as const;

const TOOL_SCHEMAS = {
  list_folders: ListFoldersSchema,
  create_folder: CreateFolderSchema,
  rename_folder: RenameFolderSchema,
  delete_folder: DeleteFolderSchema,
  search_emails: SearchEmailsSchema,
  get_recent_emails: GetRecentEmailsSchema,
  get_email_content: GetEmailContentSchema,
  get_email_thread: GetEmailThreadSchema,
  mark_emails: MarkEmailsSchema,
  move_emails: MoveEmailsSchema,
  delete_emails: DeleteEmailsSchema,
  send_email: SendEmailSchema,
  reply_email: ReplyEmailSchema,
  forward_email: ForwardEmailSchema,
  create_draft: CreateDraftSchema,
} as const;

type ToolName = keyof typeof TOOL_SCHEMAS;
type ValidatedToolCall = {
  [Name in ToolName]: {
    name: Name;
    args: z.infer<(typeof TOOL_SCHEMAS)[Name]>;
  }
}[ToolName];

export interface McpRequestContext {
  subject: string;
  scopes: readonly string[];
  resolveCredentials: () => Promise<GmailAppPasswordCredentials | null>;
  enableLegacySse: boolean;
}

export async function handleMcpStreamableHttp(
  request: Request,
  context: McpRequestContext,
): Promise<Response> {
  const url = new URL(request.url);

  // 1. GET requests: If client requests SSE stream or discovery
  if (request.method === 'GET') {
    const accept = request.headers.get('Accept') || '';
    if (accept.includes('text/event-stream')) {
      if (!context.enableLegacySse) {
        return new Response(
          JSON.stringify({ error: 'Legacy SSE transport is disabled. Use Streamable HTTP POST requests.' }),
          { status: 410, headers: { 'Content-Type': 'application/json' } },
        );
      }
      const missingScope = MAIL_SCOPES.find((scope) => !context.scopes.includes(scope));
      if (missingScope) return mcpScopeError(null, missingScope);
      const credentials = await context.resolveCredentials();
      if (!credentials) {
        return accountNotLinkedResponse(null, 401);
      }
      return handleSseConnect(request, credentials, context.subject);
    }

    // Server capabilities discovery response
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            prompts: { listChanged: false },
          },
          serverInfo: SERVER_INFO,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  }

  // 2. POST requests: JSON-RPC request handling
  if (request.method === 'POST') {
    let payload: unknown;
    try {
      payload = await readRequestJson(request, MAX_MCP_REQUEST_BYTES);
    } catch (error) {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: error instanceof RequestBodyTooLargeError ? -32600 : -32700,
            message: error instanceof RequestBodyTooLargeError
              ? 'Invalid Request: request body is too large'
              : 'Parse error: Invalid JSON',
          },
        }),
        {
          status: error instanceof RequestBodyTooLargeError ? 413 : 400,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    if (!isRecord(payload)) {
      return jsonRpcError(null, -32600, 'Invalid Request');
    }
    const id = payload.id ?? null;
    const method = typeof payload.method === 'string' ? payload.method : undefined;
    const params = isRecord(payload.params) ? payload.params : {};

    // Notifications return 204
    if (method === 'notifications/initialized' || method?.startsWith('notifications/')) {
      return new Response(null, {
        status: 204,
      });
    }

    // Method: initialize
    if (method === 'initialize') {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {
              tools: { listChanged: false },
              prompts: { listChanged: false },
              resources: { listChanged: false },
            },
            serverInfo: SERVER_INFO,
            instructions:
              'Mailbox credentials are linked once to the authenticated gateway account and are never supplied as MCP parameters or request headers.',
          },
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Method: ping
    if (method === 'ping') {
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id, result: {} }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Method: resources/list
    if (method === 'resources/list' || method === 'resources/templates/list') {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            resources: [
              {
                uri: 'one://folders',
                name: 'Mailbox Folders',
                description: 'Live catalog of all mailbox folders with real-time total and unread message counts.',
                mimeType: 'application/json',
              },
              {
                uri: 'one://status',
                name: 'Gateway Status',
                description: 'Connection state and active mailbox capabilities for one.com gateway.',
                mimeType: 'application/json',
              },
              {
                uri: 'one://templates/meeting-followup',
                name: 'Meeting Followup Template',
                description: 'Standard template for professional post-meeting summaries and action items.',
                mimeType: 'text/markdown',
              },
              {
                uri: 'one://templates/out-of-office',
                name: 'Out of Office Template',
                description: 'Standard template for out-of-office auto-responses.',
                mimeType: 'text/markdown',
              },
            ],
          },
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Method: resources/read
    if (method === 'resources/read') {
      const uri = params.uri;
      if (uri === 'one://status') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              contents: [
                {
                  uri: 'one://status',
                  mimeType: 'application/json',
                  text: JSON.stringify({
                    service: '@xtnd-dynamics/mcp-one',
                    version: SERVER_INFO.version,
                    protocolVersion: '2024-11-05',
                    imap: { host: 'imap.one.com', port: 993, tls: true },
                    smtp: { host: 'send.one.com', port: 465, tls: true },
                    toolsCount: 15,
                    promptsCount: 4,
                    resourcesCount: 4,
                  }),
                },
              ],
            },
          }),
        { headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (uri === 'one://templates/meeting-followup') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              contents: [
                {
                  uri: 'one://templates/meeting-followup',
                  mimeType: 'text/markdown',
                  text: `# Meeting Summary: [Topic]\n\n**Date:** [Date]\n**Attendees:** [Names]\n\n### Key Discussion Points\n- [Point 1]\n- [Point 2]\n\n### Action Items\n- [ ] **[Owner]**: [Task] (Due: [Date])\n`,
                },
              ],
            },
          }),
        { headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (uri === 'one://templates/out-of-office') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              contents: [
                {
                  uri: 'one://templates/out-of-office',
                  mimeType: 'text/markdown',
                  text: `Thank you for your message. I am out of the office until [Date]. For urgent inquiries, please contact [Colleague Name].`,
                },
              ],
            },
          }),
        { headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (uri === 'one://folders') {
        if (!context.scopes.includes('mail.read')) {
          return mcpScopeError(id, 'mail.read');
        }
        const credentials = await context.resolveCredentials();
        if (!credentials) {
          return accountNotLinkedResponse(id);
        }
        const client = new AppPasswordGmailClient(credentials);
        const folders = await client.listFolders();
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              contents: [
                {
                  uri: 'one://folders',
                  mimeType: 'application/json',
                  text: JSON.stringify({ count: folders.length, folders }, null, 2),
                },
              ],
            },
          }),
        { headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `Resource '${uri}' not found` },
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Method: ai.smithery/events/list or triggers/list
    if (method === 'ai.smithery/events/list' || method === 'events/list' || method === 'triggers/list') {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: { events: [], triggers: [] },
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Method: tools/list
    if (method === 'tools/list') {
      const tools = getToolDefinitions();
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: { tools },
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Method: prompts/list
    if (method === 'prompts/list') {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            prompts: [
              {
                name: 'triage-inbox',
                description: 'Inspect recent unread emails, prioritize into categories, and recommend triage actions.',
                arguments: [
                  {
                    name: 'limit',
                    description: 'Maximum number of unread emails to inspect (default: 10)',
                    required: false,
                  },
                ],
              },
              {
                name: 'draft-reply',
                description: 'Analyze an email thread and draft a professional, contextual reply.',
                arguments: [
                  {
                    name: 'uid',
                    description: 'The UID of the email to reply to',
                    required: true,
                  },
                  {
                    name: 'tone',
                    description: 'Tone of the reply: professional, friendly, concise, assertive (default: professional)',
                    required: false,
                  },
                ],
              },
              {
                name: 'clean-inbox',
                description: 'Detect marketing newsletters, automated alerts, and clutter, offering bulk cleanup actions.',
                arguments: [
                  {
                    name: 'folder',
                    description: 'Folder to scan (default: INBOX)',
                    required: false,
                  },
                ],
              },
              {
                name: 'executive-briefing',
                description: 'Generate a high-density executive summary of all emails received today with action item tracker.',
                arguments: [],
              },
            ],
          },
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Method: tools/call
    if (method === 'tools/call') {
      let toolCall: ValidatedToolCall;
      try {
        toolCall = validateToolCall(params.name, params.arguments ?? {});
      } catch (error) {
        const message = error instanceof Error && error.name === 'UnknownToolError'
          ? 'Unknown tool name.'
          : 'Tool arguments are invalid.';
        return jsonRpcError(id, -32602, message);
      }

      const requiredScope = requiredScopeForTool(toolCall.name);
      if (!context.scopes.includes(requiredScope)) {
        return mcpScopeError(id, requiredScope);
      }
      const credentials = await context.resolveCredentials();
      if (!credentials) {
        return accountNotLinkedResponse(id);
      }

      const client = new AppPasswordGmailClient(credentials);
      try {
        const result = await executeTool(client, toolCall);
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
              isError: false,
            },
          }),
        { headers: { 'Content-Type': 'application/json' } }
        );
      } catch (error: unknown) {
        const errorName = error instanceof Error ? error.name : 'UnknownError';
        console.error(JSON.stringify({
          message: 'MCP mail operation failed',
          errorName,
          tool: toolCall.name,
        }));
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: 'Tool Error: the mail operation failed.' }],
              isError: true,
            },
          }),
        { headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    // Unknown method
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method '${method}' not found` },
      }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' },
  });
}

function accountNotLinkedResponse(id: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text:
              'No one.com mailbox is linked to this authenticated connection. '
              + 'Link it once through POST /api/accounts/link, then retry the mail operation.',
          },
        ],
        isError: true,
      },
    }),
    { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
}

function mcpScopeError(id: unknown, requiredScope: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text: `This connection is not authorized for ${requiredScope}. Reauthorize with that scope.`,
          },
        ],
        isError: true,
      },
    }),
    { status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
}

function requiredScopeForTool(toolName: ToolName): string {
  if (toolName === 'send_email' || toolName === 'reply_email' || toolName === 'forward_email') {
    return 'mail.send';
  }
  if (toolName === 'delete_emails' || toolName === 'delete_folder') {
    return 'mail.delete';
  }
  if (
    toolName === 'create_folder'
    || toolName === 'rename_folder'
    || toolName === 'mark_emails'
    || toolName === 'move_emails'
    || toolName === 'create_draft'
  ) {
    return 'mail.manage';
  }
  return 'mail.read';
}

function validateToolCall(name: unknown, args: unknown): ValidatedToolCall {
  if (typeof name !== 'string' || !Object.hasOwn(TOOL_SCHEMAS, name)) {
    const error = new Error('Unknown tool name.');
    error.name = 'UnknownToolError';
    throw error;
  }

  const toolName = name as ToolName;
  return {
    name: toolName,
    args: TOOL_SCHEMAS[toolName].parse(args),
  } as ValidatedToolCall;
}

function jsonRpcError(id: unknown, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getToolDefinitions() {
  return [
    {
      name: 'list_folders',
      description: 'List all mailboxes/folders in the one.com mail account with message and unread counts.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'create_folder',
      description: 'Create a new folder or mailbox in the one.com mail account.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Folder name to create' } },
        required: ['name'],
      },
    },
    {
      name: 'rename_folder',
      description: 'Rename an existing mailbox/folder.',
      inputSchema: {
        type: 'object',
        properties: {
          oldName: { type: 'string', description: 'Current folder name' },
          newName: { type: 'string', description: 'New folder name' },
        },
        required: ['oldName', 'newName'],
      },
    },
    {
      name: 'delete_folder',
      description: 'Delete a folder/mailbox from the one.com mail account.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Folder name to delete' } },
        required: ['name'],
      },
    },
    {
      name: 'search_emails',
      description: 'Search for emails in one.com mailbox using filters (query, folder, sender, recipient, flags).',
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', default: 'INBOX' },
          query: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          subject: { type: 'string' },
          unreadOnly: { type: 'boolean' },
          limit: { type: 'number', default: 20 },
        },
      },
    },
    {
      name: 'get_recent_emails',
      description: 'Retrieve the most recent emails from a mailbox folder with envelopes.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', default: 'INBOX' },
          limit: { type: 'number', default: 10 },
        },
      },
    },
    {
      name: 'get_email_content',
      description: 'Fetch full email content by UID from a folder. Body is converted to clean Markdown.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', default: 'INBOX' },
          uid: { type: 'number' },
        },
        required: ['folder', 'uid'],
      },
    },
    {
      name: 'get_email_thread',
      description: 'Retrieve the full conversation thread for a given email UID or Message-ID.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', default: 'INBOX' },
          uidOrMessageId: { type: 'string' },
        },
        required: ['folder', 'uidOrMessageId'],
      },
    },
    {
      name: 'mark_emails',
      description: 'Mark emails as read, unread, flagged, or unflagged.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', default: 'INBOX' },
          uids: { type: 'array', items: { type: 'number' } },
          action: { type: 'string', enum: ['read', 'unread', 'flag', 'unflag'] },
        },
        required: ['folder', 'uids', 'action'],
      },
    },
    {
      name: 'move_emails',
      description: 'Move emails from a source folder to a destination folder.',
      inputSchema: {
        type: 'object',
        properties: {
          sourceFolder: { type: 'string', default: 'INBOX' },
          targetFolder: { type: 'string' },
          uids: { type: 'array', items: { type: 'number' } },
        },
        required: ['sourceFolder', 'targetFolder', 'uids'],
      },
    },
    {
      name: 'delete_emails',
      description: 'Delete emails by moving them to Trash (soft delete) or permanent expunge.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', default: 'INBOX' },
          uids: { type: 'array', items: { type: 'number' } },
          permanent: { type: 'boolean', default: false },
        },
        required: ['folder', 'uids'],
      },
    },
    {
      name: 'send_email',
      description: 'Send a new outbound email via one.com SMTP server (send.one.com:465).',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          bodyText: { type: 'string' },
          bodyHtml: { type: 'string' },
        },
        required: ['to', 'subject', 'bodyText'],
      },
    },
    {
      name: 'reply_email',
      description: 'Reply to an existing email with automated In-Reply-To and References headers.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', default: 'INBOX' },
          uid: { type: 'number' },
          bodyText: { type: 'string' },
          replyAll: { type: 'boolean', default: false },
        },
        required: ['folder', 'uid', 'bodyText'],
      },
    },
    {
      name: 'forward_email',
      description: 'Forward an existing email to new recipients with original header context.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', default: 'INBOX' },
          uid: { type: 'number' },
          to: { type: 'string' },
          comment: { type: 'string' },
        },
        required: ['folder', 'uid', 'to'],
      },
    },
    {
      name: 'create_draft',
      description: 'Create an email draft in the one.com Drafts folder without sending.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          bodyText: { type: 'string' },
        },
        required: ['to', 'subject', 'bodyText'],
      },
    },
  ];
}

async function executeTool(client: AppPasswordGmailClient, call: ValidatedToolCall): Promise<unknown> {
  switch (call.name) {
    case 'list_folders':
      return { folders: await client.listFolders() };
    case 'create_folder':
      return await client.createFolder(call.args.name);
    case 'rename_folder':
      return await client.renameFolder(call.args.oldName, call.args.newName);
    case 'delete_folder':
      return await client.deleteFolder(call.args.name);
    case 'search_emails':
      return client.searchEmails(call.args as any);
    case 'get_recent_emails':
      return client.getRecentEmails(call.args.folder, call.args.limit);
    case 'get_email_content':
      {
        const email = await client.getEmailContent(call.args.folder, call.args.uid);
        let selectedBody = email.bodyMarkdown || email.bodyText || '';
        const { text: body, truncated } = truncateForAI(selectedBody, 15_000);
        return {
          id: email.id,
          messageId: email.messageId,
          subject: email.subject,
          from: email.from,
          to: email.to,
          date: email.date,
          bodyFormat: call.args.format,
          truncated,
          body,
        };
      }
    case 'get_email_thread': {
      const thread = await client.getEmailThread(call.args.folder, call.args.uidOrMessageId);
      return thread;
    }
    case 'mark_emails':
      return await client.markEmails(call.args.folder, call.args.uids, call.args.action);
    case 'move_emails':
      return await client.moveEmails(call.args.sourceFolder, call.args.targetFolder, call.args.uids);
    case 'delete_emails':
      return await client.deleteEmails(call.args.folder, call.args.uids, call.args.permanent);
    case 'send_email':
      return client.sendEmail(call.args as any);
    case 'reply_email':
      return client.replyEmail(
        call.args.folder,
        call.args.uid,
        call.args.bodyText,
        call.args.replyAll,
      );
    case 'forward_email':
      return client.forwardEmail(
        call.args.folder,
        call.args.uid,
        call.args.to,
        call.args.comment,
      );
    case 'create_draft': {
      const toStr = Array.isArray(call.args.to) ? call.args.to.join(', ') : call.args.to;
      const ccStr = Array.isArray(call.args.cc) ? call.args.cc.join(', ') : call.args.cc;
      const bccStr = Array.isArray(call.args.bcc) ? call.args.bcc.join(', ') : call.args.bcc;
      return client.createDraft({
        to: toStr,
        cc: ccStr,
        bcc: bccStr,
        subject: call.args.subject,
        bodyText: call.args.bodyText,
      });
    }
  }
}
