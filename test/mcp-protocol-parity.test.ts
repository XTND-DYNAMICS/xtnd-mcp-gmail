import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createWorker } from '../src/worker/index.js';
import type { WorkerEnv } from '../src/types.js';

function createMemoryKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string, type?: string) {
      const val = store.get(key) ?? null;
      if (val === null) return null;
      return type === 'json' ? JSON.parse(val) : val;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list() {
      return { keys: [], list_complete: true, cacheStatus: null };
    },
  } as unknown as KVNamespace;
}

function makeEnv(): WorkerEnv {
  return {
    KV: createMemoryKv(),
    OAUTH_KV: createMemoryKv(),
    MCP_RESOURCE_URL: 'https://gmail.mcp.xgi.io/',
    CREDENTIALS_MASTER_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    API_KEYS_SHA256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  } as unknown as WorkerEnv;
}

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

test('public brand icon routes serve SVG, ICO, and PNG with CORP cross-origin before auth', async () => {
  const worker = createWorker();
  const env = makeEnv();

  const cases: Array<[string, string]> = [
    ['/favicon.svg', 'image/svg+xml; charset=utf-8'],
    ['/icon.svg', 'image/svg+xml; charset=utf-8'],
    ['/favicon.ico', 'image/x-icon'],
    ['/icon-192.png', 'image/png'],
    ['/apple-touch-icon.png', 'image/png'],
  ];

  for (const [path, expectedType] of cases) {
    const res = await worker.fetch(new Request(`https://gmail.mcp.xgi.io${path}`), env, ctx);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('Content-Type'), expectedType, path);
    assert.equal(res.headers.get('Cross-Origin-Resource-Policy'), 'cross-origin', path);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*', path);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.ok(bytes.byteLength > 100, `${path} should return non-empty asset payload`);

    const head = await worker.fetch(new Request(`https://gmail.mcp.xgi.io${path}`, { method: 'HEAD' }), env, ctx);
    assert.equal(head.status, 200, `HEAD ${path}`);
    assert.equal((await head.arrayBuffer()).byteLength, 0, `HEAD ${path} body`);
  }
});

test('server-card and OAuth protected-resource metadata advertise SEP-973 icons and logo_uri', async () => {
  const worker = createWorker();
  const env = makeEnv();

  const cardRes = await worker.fetch(new Request('https://gmail.mcp.xgi.io/.well-known/mcp/server-card.json'), env, ctx);
  assert.equal(cardRes.status, 200);
  const card = await cardRes.json() as {
    icon: string;
    icons: Array<{ src: string }>;
    serverInfo: { title: string; websiteUrl: string; icons: Array<{ src: string }> };
  };
  assert.equal(card.serverInfo.title, 'XMAIL | Gmail');
  assert.equal(card.serverInfo.websiteUrl, 'https://gmail.mcp.xgi.io');
  assert.equal(card.icon, 'https://gmail.mcp.xgi.io/favicon.svg');
  assert.equal(card.serverInfo.icons.length, 3);

  const prmRes = await worker.fetch(new Request('https://gmail.mcp.xgi.io/.well-known/oauth-protected-resource'), env, ctx);
  assert.equal(prmRes.status, 200);
  const prm = await prmRes.json() as { resource_name: string; logo_uri: string; icons: Array<{ src: string }> };
  assert.equal(prm.resource_name, 'XMAIL | Gmail');
  assert.equal(prm.logo_uri, 'https://gmail.mcp.xgi.io/favicon.svg');
  assert.equal(prm.icons.length, 3);
});

test('MCP initialize and tools/list expose SEP-973 icons, instructions, and 4-boolean tool annotations', async () => {
  const worker = createWorker();
  const env = makeEnv();
  const headers = {
    Authorization: 'Bearer test',
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  const initRes = await worker.fetch(
    new Request('https://gmail.mcp.xgi.io/', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
      }),
    }),
    env,
    ctx,
  );
  assert.equal(initRes.status, 200);
  const initBody = await initRes.json() as {
    result: {
      protocolVersion: string;
      instructions: string;
      serverInfo: { name: string; title: string; websiteUrl: string; icons: Array<{ src: string }> };
    };
  };
  assert.equal(initBody.result.protocolVersion, '2025-11-25');
  assert.equal(initBody.result.serverInfo.name, '@xtnd-dynamics/mcp-gmail');
  assert.equal(initBody.result.serverInfo.title, 'XMAIL | Gmail');
  assert.equal(initBody.result.serverInfo.websiteUrl, 'https://gmail.mcp.xgi.io');
  assert.equal(initBody.result.serverInfo.icons.length, 3);
  assert.match(initBody.result.instructions, /create_draft/);

  const toolsRes = await worker.fetch(
    new Request('https://gmail.mcp.xgi.io/', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    }),
    env,
    ctx,
  );
  assert.equal(toolsRes.status, 200);
  const toolsBody = await toolsRes.json() as {
    result: { tools: Array<{ name: string; annotations?: Record<string, unknown> }> };
  };
  assert.equal(toolsBody.result.tools.length, 31);
  for (const tool of toolsBody.result.tools) {
    assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} readOnlyHint`);
    assert.equal(typeof tool.annotations?.destructiveHint, 'boolean', `${tool.name} destructiveHint`);
    assert.equal(typeof tool.annotations?.idempotentHint, 'boolean', `${tool.name} idempotentHint`);
    assert.equal(typeof tool.annotations?.openWorldHint, 'boolean', `${tool.name} openWorldHint`);
  }
});
