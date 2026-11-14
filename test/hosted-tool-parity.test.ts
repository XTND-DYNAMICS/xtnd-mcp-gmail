import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  APP_PASSWORD_TOOL_NAMES,
  MAIL_SCOPES,
  createAppPasswordGmailMcpServer,
  requiredScopeForTool,
} from '../src/mcp/app-password-server.js';
import { LEGACY_TOOL_CALLS, handleMcpStreamableHttp, type McpRequestContext } from '../src/worker/mcp-streamable-http.js';

type ToolListing = { name: string; inputSchema: unknown };
type RpcBody = {
  result?: { tools?: ToolListing[]; isError?: boolean; content?: { text: string }[] };
  error?: { code: number; message: string };
};

/** The tools Claude Desktop sees: the stdio server, listed by a real MCP client. */
async function stdioTools(): Promise<ToolListing[]> {
  const server = createAppPasswordGmailMcpServer({
    getClient: () => { throw new Error('listing tools must not resolve a mailbox'); },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'parity-test', version: '0' });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools;
}

function context(overrides: Partial<McpRequestContext> & { onCredentialsRead?: () => void } = {}): McpRequestContext {
  return {
    subject: 'subject',
    scopes: [...MAIL_SCOPES],
    enableLegacySse: false,
    resolveCredentials: async () => { overrides.onCredentialsRead?.(); return null; },
    ...overrides,
  };
}

async function rpc(method: string, params: Record<string, unknown>, ctx: McpRequestContext): Promise<RpcBody> {
  const response = await handleMcpStreamableHttp(
    new Request('https://gmail.mcp.xgi.io/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    ctx,
  );
  return await response.json() as RpcBody;
}

const callTool = (name: string, args: Record<string, unknown>, ctx: McpRequestContext) =>
  rpc('tools/call', { name, arguments: args }, ctx);

test('the hosted Worker lists exactly the stdio server\'s tools, with the same input schemas', async () => {
  const stdio = await stdioTools();
  const hosted = (await rpc('tools/list', {}, context())).result?.tools ?? [];

  assert.deepEqual(hosted.map((tool) => tool.name).sort(), stdio.map((tool) => tool.name).sort());
  const stdioSchemas = new Map(stdio.map((tool) => [tool.name, tool.inputSchema]));
  for (const tool of hosted) {
    assert.deepEqual(tool.inputSchema, stdioSchemas.get(tool.name), tool.name);
  }
});

test('the shared tool set is the full Gmail suite', () => {
  assert.deepEqual([...APP_PASSWORD_TOOL_NAMES].sort(), [
    'archive_email', 'batch_modify_labels', 'create_draft', 'create_forward_draft', 'create_label',
    'create_reply_draft', 'delete_draft', 'delete_email_permanently', 'delete_label', 'forward_email',
    'get_attachment', 'get_draft', 'get_email', 'get_profile', 'get_raw_email', 'get_recent_emails',
    'get_thread', 'list_drafts', 'list_labels', 'mark_email_read', 'modify_email_labels', 'move_emails',
    'rename_label', 'reply_email', 'search_emails', 'send_draft', 'send_email', 'star_email',
    'trash_email', 'untrash_email', 'update_draft',
  ]);
});

/** The smallest valid arguments for each tool, so a refusal is about the scope, not the input. */
const VALID_ARGS: Record<string, Record<string, unknown>> = {
  get_email: { id: '1' },
  get_thread: { id: '1' },
  get_attachment: { id: '1', attachmentId: 'a.pdf' },
  get_raw_email: { id: '1' },
  send_email: { to: 'a@example.com', subject: 's', bodyText: 'b' },
  reply_email: { id: '1', bodyText: 'b' },
  forward_email: { id: '1', to: 'a@example.com' },
  create_reply_draft: { id: '1', bodyText: 'b' },
  create_forward_draft: { id: '1', to: 'a@example.com' },
  update_draft: { draftId: '1' },
  get_draft: { draftId: '1' },
  send_draft: { draftId: '1' },
  delete_draft: { draftId: '1' },
  create_label: { name: 'x' },
  rename_label: { oldName: 'x', newName: 'y' },
  delete_label: { name: 'x' },
  modify_email_labels: { id: '1', addLabels: ['x'] },
  batch_modify_labels: { ids: ['1'], addLabels: ['x'] },
  archive_email: { id: '1' },
  star_email: { id: '1' },
  mark_email_read: { id: '1' },
  trash_email: { id: '1' },
  untrash_email: { id: '1' },
  move_emails: { sourceFolder: 'INBOX', targetFolder: 'Done', ids: ['1'] },
  delete_email_permanently: { id: '1', confirm: true },
};

test('every tool on the Worker is refused without its scope, and no mailbox credentials are read', async () => {
  for (const name of APP_PASSWORD_TOOL_NAMES) {
    const scope = requiredScopeForTool(name);
    assert.ok(scope, name);
    let credentialsRead = false;
    const body = await callTool(name, VALID_ARGS[name] ?? {}, context({
      scopes: MAIL_SCOPES.filter((candidate) => candidate !== scope),
      onCredentialsRead: () => { credentialsRead = true; },
    }));
    assert.equal(body.result?.isError, true, name);
    assert.match(body.result?.content?.[0]?.text ?? '', new RegExp(`not authorized for ${scope.replace('.', '\\.')}`), name);
    assert.equal(credentialsRead, false, name);
  }
});

test('a call with no scopes at all is refused for its scope before credentials are read', async () => {
  let credentialsRead = false;
  const body = await callTool('create_reply_draft', { id: '42', bodyText: 'Thanks!' }, context({
    scopes: [],
    onCredentialsRead: () => { credentialsRead = true; },
  }));
  assert.equal(body.result?.isError, true);
  assert.match(body.result?.content?.[0]?.text ?? '', /not authorized for mail\.manage/);
  assert.equal(credentialsRead, false);
});

test('create_reply_draft is callable on the Worker and reaches the caller\'s mailbox', async () => {
  let credentialsRead = false;
  const body = await callTool('create_reply_draft', { id: '42', bodyText: 'Thanks!', replyAll: true }, context({
    scopes: ['mail.manage'],
    onCredentialsRead: () => { credentialsRead = true; },
  }));
  assert.equal(credentialsRead, true);
  assert.equal(body.result?.isError, true);
  assert.match(body.result?.content?.[0]?.text ?? '', /No Gmail mailbox is linked/);
});

test('the Worker refuses local file paths and saveToPath before reading credentials', async () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ['create_draft', { to: 'a@example.com', attachments: ['/etc/passwd'] }, /attachments cannot be file paths/],
    ['send_email', { to: 'a@example.com', subject: 's', attachments: ['/etc/hosts'] }, /attachments cannot be file paths/],
    ['get_attachment', { id: '1', attachmentId: 'a.pdf', saveToPath: '/tmp/a.pdf' }, /saveToPath is not available/],
    ['get_raw_email', { id: '1', saveToPath: '/tmp/a.eml' }, /saveToPath is not available/],
  ];
  for (const [name, args, message] of cases) {
    let credentialsRead = false;
    const body = await callTool(name, args, context({ onCredentialsRead: () => { credentialsRead = true; } }));
    assert.equal(body.result?.isError, true, name);
    assert.match(body.result?.content?.[0]?.text ?? '', message, name);
    assert.equal(credentialsRead, false, name);
  }
});

test('the Worker accepts base64 attachment objects', async () => {
  let credentialsRead = false;
  const body = await callTool('create_draft', {
    to: 'a@example.com',
    attachments: [{ filename: 'note.txt', contentType: 'text/plain', dataBase64: Buffer.from('hi').toString('base64') }],
  }, context({ onCredentialsRead: () => { credentialsRead = true; } }));
  assert.equal(credentialsRead, true);
  assert.match(body.result?.content?.[0]?.text ?? '', /No Gmail mailbox is linked/);
});

test('the old hosted tool names still work and need the scope they always needed', async () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['list_folders', {}, 'mail.read'],
    ['create_folder', { name: 'x' }, 'mail.manage'],
    ['rename_folder', { oldName: 'x', newName: 'y' }, 'mail.manage'],
    ['delete_folder', { name: 'x' }, 'mail.delete'],
    ['get_email_content', { folder: 'INBOX', uid: 7, format: 'markdown' }, 'mail.read'],
    ['get_email_thread', { folder: 'INBOX', uidOrMessageId: '7' }, 'mail.read'],
    ['mark_emails', { uids: [1, 2], action: 'flag' }, 'mail.manage'],
    ['mark_emails', { uids: [1], action: 'unread' }, 'mail.manage'],
    ['delete_emails', { uids: [1] }, 'mail.delete'],
    ['delete_emails', { uids: [1], permanent: true }, 'mail.delete'],
    ['reply_email', { uid: 7, bodyText: 'ok' }, 'mail.send'],
    ['forward_email', { uid: 7, to: 'a@example.com' }, 'mail.send'],
    ['move_emails', { sourceFolder: 'INBOX', targetFolder: 'Done', uids: [7] }, 'mail.manage'],
    ['create_draft', { to: ['a@example.com', 'b@example.com'], subject: 's', bodyText: 'b' }, 'mail.manage'],
  ];
  for (const [name, args, scope] of cases) {
    const label = `${name} ${JSON.stringify(args)}`;
    let credentialsRead = false;
    const linked = await callTool(name, args, context({
      scopes: [scope],
      onCredentialsRead: () => { credentialsRead = true; },
    }));
    assert.equal(credentialsRead, true, label);
    assert.match(linked.result?.content?.[0]?.text ?? '', /No Gmail mailbox is linked/, label);

    const refused = await callTool(name, args, context({ scopes: MAIL_SCOPES.filter((s) => s !== scope) }));
    assert.match(refused.result?.content?.[0]?.text ?? '', new RegExp(`not authorized for ${scope.replace('.', '\\.')}`), label);
  }
  for (const [legacy, rewrite] of Object.entries(LEGACY_TOOL_CALLS)) {
    assert.ok(APP_PASSWORD_TOOL_NAMES.includes(rewrite({}).name), legacy);
  }
});

test('a non-numeric message ID is refused instead of acting on another message', async () => {
  const body = await callTool('trash_email', { id: 'abc' }, {
    ...context(),
    resolveCredentials: async () => ({ email: 'user@example.com', appPassword: 'not-used' }),
  });
  assert.equal(body.result?.isError, true);
  assert.match(body.result?.content?.[0]?.text ?? '', /is not a message ID/);
});

test('the Worker serves the shared resources and prompts', async () => {
  const resources = await rpc('resources/list', {}, context()) as { result?: { resources?: { uri: string }[] } };
  assert.deepEqual(resources.result?.resources?.map((r) => r.uri).sort(), ['gmail://labels', 'gmail://profile']);
  const prompts = await rpc('prompts/list', {}, context()) as { result?: { prompts?: { name: string }[] } };
  assert.deepEqual(prompts.result?.prompts?.map((p) => p.name).sort(), ['draft-reply', 'triage-inbox']);
});
