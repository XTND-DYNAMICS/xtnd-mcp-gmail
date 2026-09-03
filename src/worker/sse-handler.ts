import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { AppPasswordGmailClient } from '../core/app-password-client.js';
import { createAppPasswordGmailMcpServer } from '../mcp/app-password-server.js';
import type { GmailAppPasswordCredentials } from '../types.js';
import { readRequestJson, RequestBodyTooLargeError } from './request-body.js';

const SESSION_TTL_MS = 15 * 60 * 1_000;
const MAX_ACTIVE_SESSIONS = 64;
const MAX_SESSIONS_PER_SUBJECT = 2;
const MAX_SSE_MESSAGE_BYTES = 1_048_576;

interface SessionContext {
  transport: SSEServerTransport;
  server: McpServer;
  subject: string;
  expiresAt: number;
  close: () => void;
}

// In-memory session registry (scoped to Worker execution lifecycle / session ID)
const activeSessions = new Map<string, SessionContext>();

export async function handleSseConnect(
  request: Request,
  credentials: GmailAppPasswordCredentials,
  subject: string,
): Promise<Response> {
  removeExpiredSessions();
  if (
    activeSessions.size >= MAX_ACTIVE_SESSIONS
    || [...activeSessions.values()].filter((session) => session.subject === subject).length
      >= MAX_SESSIONS_PER_SUBJECT
  ) {
    return new Response(JSON.stringify({ error: 'Too many active legacy SSE sessions.' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
    });
  }

  const url = new URL(request.url);
  const sessionId = crypto.randomUUID();
  const messageEndpoint = `${url.origin}/message?sessionId=${sessionId}`;

  const getClient = () => new AppPasswordGmailClient(credentials);
  const server = createAppPasswordGmailMcpServer(getClient);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let closed = false;

  const closeSession = () => {
    if (closed) return;
    closed = true;
    activeSessions.delete(sessionId);
    writer.close().catch(() => {});
    server.close().catch(() => {});
  };

  const responseMock = {
    writeHead: (status: number, headers: Record<string, string>) => {},
    write: (chunk: string) => {
      if (closed) return false;
      if (writer.desiredSize !== null && writer.desiredSize <= -8) {
        closeSession();
        return false;
      }
      writer.write(encoder.encode(chunk)).catch(() => {});
      return true;
    },
    end: closeSession,
    on: (event: string, cb: () => void) => {},
  };

  const transport = new SSEServerTransport(messageEndpoint, responseMock as any);
  activeSessions.set(sessionId, {
    transport,
    server,
    subject,
    expiresAt: Date.now() + SESSION_TTL_MS,
    close: closeSession,
  });

  request.signal.addEventListener('abort', closeSession);

  await server.connect(transport);

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

export async function handleMessagePost(
  request: Request,
  subject: string,
): Promise<Response> {
  removeExpiredSessions();
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('sessionId');

  if (!sessionId || !activeSessions.has(sessionId)) {
    return new Response(JSON.stringify({ error: 'Invalid or expired SSE session ID' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = activeSessions.get(sessionId)!;
  if (session.subject !== subject) {
    return new Response(JSON.stringify({ error: 'SSE session does not belong to this caller' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  try {
    const jsonBody = await readRequestJson(request, MAX_SSE_MESSAGE_BYTES);
    await session.transport.handlePostMessage(
      {
        body: jsonBody,
      } as any,
      {
        writeHead: () => {},
        end: () => {},
      } as any
    );

    return new Response(JSON.stringify({ status: 'accepted' }), {
      status: 202,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (error: unknown) {
    return new Response(JSON.stringify({
      error: error instanceof RequestBodyTooLargeError
        ? 'Legacy SSE message is too large.'
        : 'Legacy SSE message is invalid.',
    }), {
      status: error instanceof RequestBodyTooLargeError ? 413 : 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

function removeExpiredSessions(): void {
  const now = Date.now();
  for (const session of activeSessions.values()) {
    if (session.expiresAt <= now) session.close();
  }
}
