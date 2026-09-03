/**
 * Offline stdio smoke test.
 *
 * Connects an in-memory MCP client to the server factory with a stub Gmail
 * client, so the tool, prompt and resource surface can be verified without a
 * Google account or any network access.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createGmailMcpServer } from '../src/mcp/server.js';
import type { GmailClient } from '../src/core/client.js';

const stubClient = {
  mailbox: 'stub@example.com',
  listLabels: async () => [
    { id: 'INBOX', name: 'INBOX', type: 'system' as const, messagesTotal: 0 },
  ],
  getProfile: async () => ({
    emailAddress: 'stub@example.com',
    messagesTotal: 0,
    threadsTotal: 0,
    historyId: '1',
  }),
} as unknown as GmailClient;

async function main(): Promise<void> {
  const server = createGmailMcpServer(() => stubClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: 'smoke-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const { tools } = await client.listTools();
  const { prompts } = await client.listPrompts();
  const { resources } = await client.listResources();

  process.stdout.write(`tools:     ${tools.length}\n`);
  process.stdout.write(`prompts:   ${prompts.length}\n`);
  process.stdout.write(`resources: ${resources.length}\n\n`);

  for (const tool of tools) {
    process.stdout.write(`  ${tool.name}\n`);
  }

  // Every tool needs a description and an input schema, or a model cannot use
  // it correctly. Fail the smoke test rather than shipping a silent gap.
  const undocumented = tools.filter((tool) => !tool.description || !tool.inputSchema);
  if (undocumented.length > 0) {
    throw new Error(`Tools missing description or schema: ${undocumented.map((t) => t.name).join(', ')}`);
  }

  const labels = await client.readResource({ uri: 'gmail://labels' });
  const content = labels.contents[0];
  if (!content || !('text' in content) || !content.text.includes('INBOX')) {
    throw new Error('gmail://labels did not return the stub label catalog.');
  }

  process.stdout.write('\nOK\n');
  await client.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
