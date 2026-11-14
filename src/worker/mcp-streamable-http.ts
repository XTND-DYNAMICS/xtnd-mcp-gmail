/**
 * Streamable HTTP MCP endpoint for the hosted Worker.
 *
 * POST requests are served by the shared Gmail tool server (the same one the
 * stdio server runs) through the SDK's web-standard Streamable HTTP transport,
 * stateless: one server and one transport per request, JSON responses.
 *
 * Before handing a request to the SDK this module keeps three promises the
 * earlier hand-written endpoint made to hosted clients:
 *  - tool names and argument shapes the hosted endpoint used to expose keep
 *    working (LEGACY_TOOL_CALLS rewrites them onto the shared tools);
 *  - clients that send `Accept: application/json` only, or an initialize
 *    request without protocolVersion/clientInfo, are still answered;
 *  - the Smithery events/triggers discovery methods still answer empty lists.
 */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { DEFAULT_NEGOTIATED_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { MAIL_SCOPES } from '../mcp/app-password-server.js';
import type { GmailAppPasswordCredentials } from '../types.js';
import { readRequestJson, RequestBodyTooLargeError } from './request-body.js';
import { handleSseConnect } from './sse-handler.js';
import { createHostedToolServer } from './tool-server.js';
import { BUILD_STAMP } from '../version.generated.js';

const SERVER_INFO = {
  name: '@xtnd-dynamics/mcp-gmail',
  version: BUILD_STAMP.version,
};

const PROTOCOL_VERSION = '2024-11-05';
const MAX_MCP_REQUEST_BYTES = 1_048_576;
const EMPTY_EVENT_METHODS = new Set(['ai.smithery/events/list', 'events/list', 'triggers/list']);

export interface McpRequestContext {
  subject: string;
  scopes: readonly string[];
  resolveCredentials: () => Promise<GmailAppPasswordCredentials | null>;
  enableLegacySse: boolean;
}

type JsonRecord = Record<string, unknown>;
type ToolCall = { name: string; arguments: JsonRecord };

const asId = (value: unknown) => (typeof value === 'number' || typeof value === 'string' ? String(value) : value);
const asIds = (value: unknown) => (Array.isArray(value) ? value.map(asId) : value);
const joined = (value: unknown) => (Array.isArray(value) ? value.join(', ') : value);

function renamed(args: JsonRecord, from: string, to: string, convert: (value: unknown) => unknown): JsonRecord {
  if (!(from in args) || to in args) return args;
  const { [from]: value, ...rest } = args;
  return { ...rest, [to]: convert(value) };
}

/**
 * Tool names and argument shapes the hosted endpoint exposed before it served
 * the shared tool server, mapped onto the shared tools. Each rewrite lands on
 * a tool that needs the same scope the old tool needed.
 */
export const LEGACY_TOOL_CALLS: Readonly<Record<string, (args: JsonRecord) => ToolCall>> = {
  list_folders: (args) => ({ name: 'list_labels', arguments: args }),
  create_folder: (args) => ({ name: 'create_label', arguments: args }),
  rename_folder: (args) => ({ name: 'rename_label', arguments: args }),
  delete_folder: (args) => ({ name: 'delete_label', arguments: args }),
  get_email_content: ({ format: _format, ...args }) => ({ name: 'get_email', arguments: renamed(args, 'uid', 'id', asId) }),
  get_email_thread: (args) => ({ name: 'get_thread', arguments: renamed(args, 'uidOrMessageId', 'id', asId) }),
  mark_emails: ({ uids, action, ...args }) => {
    const id = Array.isArray(uids) ? uids.map(asId).join(',') : asId(uids);
    if (action === 'flag' || action === 'unflag') {
      return { name: 'star_email', arguments: { ...args, id, star: action === 'flag' } };
    }
    // Any other action value is passed on as `read` and fails validation, as it did before.
    const read = action === 'read' ? true : action === 'unread' ? false : action ?? null;
    return { name: 'mark_email_read', arguments: { ...args, id, read } };
  },
  delete_emails: ({ uids, permanent, ...args }) => {
    const id = Array.isArray(uids) ? uids.map(asId).join(',') : asId(uids);
    return permanent === true
      ? { name: 'delete_email_permanently', arguments: { ...args, id, confirm: true } }
      : { name: 'trash_email', arguments: { ...args, id } };
  },
  reply_email: (args) => ({ name: 'reply_email', arguments: renamed(args, 'uid', 'id', asId) }),
  forward_email: (args) => ({ name: 'forward_email', arguments: renamed(args, 'uid', 'id', asId) }),
  move_emails: (args) => ({ name: 'move_emails', arguments: renamed(args, 'uids', 'ids', asIds) }),
  create_draft: (args) => ({
    name: 'create_draft',
    arguments: { ...args, ...('to' in args ? { to: joined(args.to) } : {}), ...('cc' in args ? { cc: joined(args.cc) } : {}), ...('bcc' in args ? { bcc: joined(args.bcc) } : {}) },
  }),
};

export async function handleMcpStreamableHttp(
  request: Request,
  context: McpRequestContext,
): Promise<Response> {
  // 1. GET requests: legacy SSE stream or discovery
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
            resources: { listChanged: false },
          },
          serverInfo: SERVER_INFO,
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }

  // 2. POST requests: JSON-RPC, served by the shared tool server
  if (request.method === 'POST') {
    let payload: unknown;
    try {
      payload = await readRequestJson(request, MAX_MCP_REQUEST_BYTES);
    } catch (error) {
      const tooLarge = error instanceof RequestBodyTooLargeError;
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: tooLarge ? -32600 : -32700,
            message: tooLarge ? 'Invalid Request: request body is too large' : 'Parse error: Invalid JSON',
          },
        }),
        { status: tooLarge ? 413 : 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (isRecord(payload) && typeof payload.method === 'string' && EMPTY_EVENT_METHODS.has(payload.method)) {
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: payload.id ?? null, result: { events: [], triggers: [] } }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }

    const parsedBody = Array.isArray(payload) ? payload.map(normalizeMessage) : normalizeMessage(payload);

    const server = createHostedToolServer({
      scopes: context.scopes,
      resolveCredentials: context.resolveCredentials,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(jsonRequest(request), { parsedBody });
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  }

  return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * The body has already been read and parsed (with our size limit), so the SDK
 * gets it as parsedBody. This request only carries headers; it states the JSON
 * content type and response type the endpoint has always accepted and answers
 * with, whatever the client's own Accept/Content-Type said.
 */
function jsonRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.set('Content-Type', 'application/json');
  headers.set('Accept', 'application/json, text/event-stream');
  headers.delete('Content-Length');
  return new Request(request.url, { method: 'POST', headers });
}

function normalizeMessage(message: unknown): unknown {
  if (!isRecord(message) || typeof message.method !== 'string') return message;
  const params = isRecord(message.params) ? message.params : {};

  if (message.method === 'initialize') {
    return {
      ...message,
      params: {
        ...params,
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
        capabilities: isRecord(params.capabilities) ? params.capabilities : {},
        clientInfo: isRecord(params.clientInfo) ? params.clientInfo : { name: 'unidentified-client', version: '0' },
      },
    };
  }

  if (message.method === 'tools/call' && typeof params.name === 'string' && Object.hasOwn(LEGACY_TOOL_CALLS, params.name)) {
    const args = isRecord(params.arguments) ? params.arguments : {};
    const call = LEGACY_TOOL_CALLS[params.name](args);
    return { ...message, params: { ...params, name: call.name, arguments: call.arguments } };
  }

  return message;
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
              'No Gmail mailbox is linked to this authenticated connection. '
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

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
