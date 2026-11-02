import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BUILD_STAMP } from '../src/version.generated.js';
import worker from '../src/worker/index.js';
import { handleMcpStreamableHttp } from '../src/worker/mcp-streamable-http.js';
import { getOpenApiSpec } from '../src/worker/openapi.js';
import type { WorkerEnv } from '../src/types.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const env = { KV: { get: async () => null, put: async () => {}, delete: async () => {} } } as unknown as WorkerEnv;
const get = (path: string) => worker.fetch(new Request(`https://gmail.mcp.xgi.io${path}`), env, {} as never);

test('the build stamp is package.json\'s version, from xsuite-stamp', () => {
  assert.equal(BUILD_STAMP.version, pkg.version);
  assert.equal(BUILD_STAMP.service, 'mcp-gmail');
  assert.match(BUILD_STAMP.sha, /^[0-9a-f]{7}$/);
});

test('/health has exactly the five keys of AGENTS.md §3', async () => {
  const response = await get('/health');
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, string>;
  assert.deepEqual(Object.keys(body).sort(), ['service', 'status', 'time', 'timestamp', 'version']);
  assert.equal(body.status, 'ok');
  assert.equal(body.service, BUILD_STAMP.service);
  assert.equal(body.version, BUILD_STAMP.version);
  assert.equal(body.time, body.timestamp);
});

test('/version names the build: service, version, commit and its time', async () => {
  const response = await get('/version');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    service: BUILD_STAMP.service,
    version: BUILD_STAMP.version,
    sha: BUILD_STAMP.sha,
    committed_at: BUILD_STAMP.committedAt,
  });
});

test('the MCP server and the OpenAPI document report the same version', async () => {
  const response = await handleMcpStreamableHttp(
    new Request('https://gmail.mcp.xgi.io/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    }),
    { subject: 's', scopes: [], resolveCredentials: async () => null, enableLegacySse: false },
  );
  const body = await response.json() as { result: { serverInfo: { version: string } } };
  assert.equal(body.result.serverInfo.version, BUILD_STAMP.version);
  assert.equal(getOpenApiSpec().info.version, BUILD_STAMP.version);
});
