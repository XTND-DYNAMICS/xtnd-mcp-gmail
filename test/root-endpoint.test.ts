import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import worker from '../src/worker/index.js';
import type { WorkerEnv } from '../src/types.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const TOKEN = 'root-endpoint-test-token';

function env(): WorkerEnv {
  return {
    KV: { get: async () => null, put: async () => {}, delete: async () => {} },
    API_KEYS_SHA256: sha256(TOKEN),
  } as unknown as WorkerEnv;
}

function initialize(path: string): Request {
  return new Request(`https://gmail.mcp.xgi.io${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
}

const ctx = {} as ExecutionContext;

test('the bare origin is the MCP endpoint', async () => {
  const response = await worker.fetch(initialize('/'), env(), ctx);
  assert.equal(response.status, 200);
  const body = await response.json() as { result?: { serverInfo?: { name?: string } } };
  assert.equal(body.result?.serverInfo?.name, '@xtnd-dynamics/mcp-gmail');
});

test('/mcp keeps working as an alias', async () => {
  const response = await worker.fetch(initialize('/mcp'), env(), ctx);
  assert.equal(response.status, 200);
});

test('a browser GET on the origin still gets the landing page, unauthenticated', async () => {
  const response = await worker.fetch(
    new Request('https://gmail.mcp.xgi.io/', { headers: { Accept: 'text/html' } }),
    env(),
    ctx,
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type') ?? '', /text\/html/);
});

test('an event-stream GET on the origin is MCP and must authenticate', async () => {
  const response = await worker.fetch(
    new Request('https://gmail.mcp.xgi.io/', { headers: { Accept: 'text/event-stream' } }),
    env(),
    ctx,
  );
  assert.equal(response.status, 401);
});

test('an unauthenticated POST on the origin is refused, not served HTML', async () => {
  const response = await worker.fetch(
    new Request('https://gmail.mcp.xgi.io/', { method: 'POST', body: '{}' }),
    env(),
    ctx,
  );
  assert.equal(response.status, 401);
});
