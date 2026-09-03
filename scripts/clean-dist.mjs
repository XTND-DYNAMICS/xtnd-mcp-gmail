import { rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

const projectRoot = resolve(process.cwd());
const distributionDirectory = resolve(projectRoot, 'dist');

if (
  basename(distributionDirectory) !== 'dist'
  || dirname(distributionDirectory) !== projectRoot
) {
  throw new Error('Refusing to clean an unexpected distribution directory.');
}

await rm(distributionDirectory, { recursive: true, force: true });
