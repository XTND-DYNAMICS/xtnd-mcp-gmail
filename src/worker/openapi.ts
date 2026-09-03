/**
 * OpenAPI 3.0 Specification for ChatGPT Custom Actions and REST clients
 */

export function getOpenApiSpec(origin = 'https://gmail.mcp.xgi.io') {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Gmail API (xtnd-mcp-gmail)',
      version: '0.1.0',
      description:
        'Supreme Mail API for Gmail & Google Workspace. Authenticate with a bearer token, link the mailbox once, and call mail endpoints seamlessly.',
    },
    servers: [{ url: origin }],
    paths: {
      '/api/accounts/status': {
        get: {
          summary: 'Show whether a Gmail mailbox is linked to this authenticated caller',
          operationId: 'getLinkedMailboxStatus',
          responses: {
            '200': { description: 'Non-sensitive linked-mailbox status' },
          },
        },
      },
      '/api/accounts/link': {
        post: {
          summary: 'Verify and securely link a Gmail mailbox to this authenticated caller',
          operationId: 'linkMailbox',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'password'],
                  additionalProperties: false,
                  properties: {
                    email: { type: 'string', format: 'email' },
                    password: { type: 'string', format: 'password', writeOnly: true },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Mailbox verified and linked successfully' },
            '400': { description: 'Invalid input or verification failed' },
          },
        },
      },
      '/api/folders': {
        get: {
          summary: 'List all folders and labels',
          operationId: 'listFolders',
          responses: {
            '200': { description: 'List of folders and unread counts' },
          },
        },
      },
      '/api/emails/search': {
        post: {
          summary: 'Search emails with filters',
          operationId: 'searchEmails',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    folder: { type: 'string', default: 'INBOX' },
                    query: { type: 'string' },
                    unreadOnly: { type: 'boolean' },
                    limit: { type: 'number', default: 20 },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Search results' },
          },
        },
      },
      '/api/emails/send': {
        post: {
          summary: 'Send an email via Gmail SMTP',
          operationId: 'sendEmail',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['to', 'subject', 'bodyText'],
                  properties: {
                    to: { type: 'string' },
                    subject: { type: 'string' },
                    bodyText: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Email sent' },
          },
        },
      },
    },
  };
}
