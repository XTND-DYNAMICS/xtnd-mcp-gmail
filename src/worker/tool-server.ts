/**
 * The hosted Worker's view of the shared Gmail tool server.
 *
 * It adds what a multi-tenant host needs on top of the shared definition in
 * src/mcp/app-password-server.ts: scope checks per tool (before mailbox
 * credentials are read), the caller's linked mailbox as the client, no
 * filesystem, and failures redacted to a generic message so no IMAP/SMTP
 * detail leaks to the caller.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AppPasswordGmailClient } from '../core/app-password-client.js';
import {
  ToolRefusal,
  createAppPasswordGmailMcpServer,
} from '../mcp/app-password-server.js';
import type { GmailAppPasswordCredentials } from '../types.js';

export interface HostedToolServerOptions {
  scopes: readonly string[];
  resolveCredentials: () => Promise<GmailAppPasswordCredentials | null>;
  origin?: string;
}

const ACCOUNT_NOT_LINKED = 'No Gmail mailbox is linked to this authenticated connection. '
  + 'Link it once through POST /api/accounts/link, then retry the mail operation.';

const INSTRUCTIONS = 'Mailbox credentials are linked once to the authenticated gateway account and are never '
  + 'supplied as MCP parameters or request headers. This hosted server has no filesystem: pass attachments '
  + 'as { filename, contentType, dataBase64 } objects and omit saveToPath. '
  + 'Always prefer create_draft, create_reply_draft, or update_draft over send_email, reply_email, forward_email, or send_draft unless the user explicitly asks to send immediately. '
  + 'Never call delete_email_permanently or delete_label without explicit user confirmation in the current turn.';

export function createHostedToolServer(options: HostedToolServerOptions): McpServer {
  let client: Promise<AppPasswordGmailClient> | undefined;

  return createAppPasswordGmailMcpServer({
    fileAccess: false,
    origin: options.origin,
    instructions: INSTRUCTIONS,
    authorize: (scope) => {
      if (!options.scopes.includes(scope)) {
        throw new ToolRefusal(`This connection is not authorized for ${scope}. Reauthorize with that scope.`);
      }
    },
    getClient: () => {
      client ??= options.resolveCredentials().then((credentials) => {
        if (!credentials) throw new ToolRefusal(ACCOUNT_NOT_LINKED);
        return new AppPasswordGmailClient(credentials);
      });
      return client;
    },
    formatError: (error, operation) => {
      if (error instanceof ToolRefusal) return error.message;
      console.error(JSON.stringify({
        message: 'MCP mail operation failed',
        errorName: error instanceof Error ? error.name : 'UnknownError',
        tool: operation,
      }));
      return 'Tool Error: the mail operation failed.';
    },
  });
}
