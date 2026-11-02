/**
 * Writes src/version.ts from package.json, so the Worker, both MCP servers and
 * the OpenAPI document report the version the release step set. The file is
 * git-ignored and never edited by hand. A missing or malformed version fails
 * the build: there is no fallback value.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`package.json has no valid version (found ${JSON.stringify(version)}).`);
}

writeFileSync(
  new URL('../src/version.ts', import.meta.url),
  `// Generated from package.json by scripts/write-version.mjs. Do not edit or commit.\nexport const VERSION = '${version}';\n`,
);
