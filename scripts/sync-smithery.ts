/**
 * Update Smithery metadata and publish @xtnd-dynamics/mcp-gmail
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface PackageMetadata {
  name: string;
  description: string;
  license?: string;
  version: string;
}

async function syncSmithery(): Promise<void> {
  const apiKey = process.env.SMITHERY_API_KEY;
  if (!apiKey) {
    process.stdout.write('SMITHERY_API_KEY is not set; public metadata sync was skipped.\n');
    return;
  }

  const pkg = JSON.parse(
    readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
  ) as PackageMetadata;

  const serverQualifiedName = 'xtnd/mcp-gmail';
  const targetUrl = `https://api.smithery.ai/servers/${encodeURIComponent(serverQualifiedName)}`;
  const payload = {
    displayName: 'XTND | MCP | GMAIL',
    description: pkg.description,
    homepage: 'https://github.com/XTND-DYNAMICS/xtnd-mcp-gmail#readme',
    repositoryUrl: 'https://github.com/XTND-DYNAMICS/xtnd-mcp-gmail',
    iconUrl: 'https://raw.githubusercontent.com/XTND-DYNAMICS/xtnd-mcp-gmail/main/assets/icon.svg',
    license: pkg.license ?? 'MIT',
    unlisted: false,
  };

  try {
    const response = await fetch(targetUrl, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      redirect: 'error',
    });

    if (response.ok) {
      process.stdout.write('✅ Smithery metadata updated and listed successfully.\n');
    } else if (response.status === 404) {
      process.stdout.write('Smithery server record not found; will be created on CLI publish.\n');
    } else {
      process.stdout.write(`Smithery PATCH returned status: ${response.status}\n`);
    }
  } catch (err: any) {
    process.stdout.write(`Smithery metadata sync notice: ${err.message}\n`);
  }
}

syncSmithery().catch((error: unknown) => {
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  process.stderr.write(`Smithery metadata sync notice (${errorName}).\n`);
});
