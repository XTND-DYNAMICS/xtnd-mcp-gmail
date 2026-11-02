import { strict as assert } from 'node:assert';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  LocalProfileStore,
  LocalProfileStoreError,
  ProfileNotFoundError,
  resolveLocalProfileConfigDir,
} from '../src/credentials/local-profile-store.js';
import type { GmailCredentials } from '../src/types.js';

const posix = process.platform !== 'win32';
const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mcp-gmail-profiles-'));
  roots.push(root);
  return root;
}

async function freshStore(): Promise<LocalProfileStore> {
  return new LocalProfileStore({ configDir: join(await freshRoot(), 'config') });
}

function credentials(email: string, secret = `secret-for-${email}`): GmailCredentials {
  return {
    email,
    clientId: 'client-id.apps.googleusercontent.com',
    clientSecret: `client-${secret}`,
    refreshToken: `refresh-${secret}`,
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],
  };
}

const mode = async (path: string) => (await stat(path)).mode & 0o777;

test('the directory is 0700 and the credentials file 0600', { skip: !posix }, async () => {
  const store = await freshStore();
  await store.save('work', credentials('work@example.com'));
  assert.equal(await mode(store.configDir), 0o700);
  assert.equal(await mode(store.credentialsFile), 0o600);
});

test('a credentials file someone loosened is tightened back to 0600 on the next read', { skip: !posix }, async () => {
  const store = await freshStore();
  await store.save('work', credentials('work@example.com'));
  await chmod(store.credentialsFile, 0o644);
  await chmod(store.configDir, 0o755);

  await store.load('work');

  assert.equal(await mode(store.credentialsFile), 0o600);
  assert.equal(await mode(store.configDir), 0o700);
});

test('list() returns metadata only; load() is the one call that returns the secrets', async () => {
  const store = await freshStore();
  const saved = credentials('work@example.com');
  await store.save('work', saved);

  const listed = await store.list();
  assert.deepEqual(listed, [{ name: 'work', email: 'work@example.com', active: true, scopes: saved.scopes }]);
  const serialized = JSON.stringify(listed);
  assert.doesNotMatch(serialized, new RegExp(`${saved.clientSecret}|${saved.refreshToken}`));

  assert.deepEqual(await store.load('work'), saved);
});

test('the first profile becomes active; select and remove move the active profile', async () => {
  const store = await freshStore();
  await store.save('first', credentials('first@example.com'));
  await store.save('second', credentials('second@example.com'));
  assert.equal(await store.getActiveProfileName(), 'first');

  await store.select('second');
  assert.equal((await store.load())?.email, 'second@example.com');

  assert.equal(await store.remove('second'), true);
  assert.equal(await store.getActiveProfileName(), null);
  assert.equal(await store.load(), null);
  assert.equal(await store.remove('second'), false);
  await assert.rejects(store.select('missing'), ProfileNotFoundError);
});

test('profile names cannot escape the store or reach object prototypes', async () => {
  const store = await freshStore();
  for (const name of ['', '../escape', 'a/b', 'a\\b', '.hidden', '-flag', '__proto__', 'x'.repeat(65), 'name with space']) {
    await assert.rejects(store.save(name, credentials('x@example.com')), LocalProfileStoreError, JSON.stringify(name));
  }

  await store.save('work', credentials('work@example.com'));
  for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(await store.load(name), null, name);
  }
});

test('invalid credentials are rejected with a message that never repeats the secret', async () => {
  const store = await freshStore();
  const secret = 'line-one\nline-two-secret';
  for (const bad of [
    { ...credentials('x@example.com'), clientSecret: secret },
    { ...credentials('x@example.com'), refreshToken: secret },
    { ...credentials('x@example.com'), refreshToken: '' },
    { ...credentials('x@example.com'), scopes: [] },
    { ...credentials('x@example.com'), email: 'not an address\r\nBcc: attacker@example.com' },
  ]) {
    await assert.rejects(store.save('work', bad as GmailCredentials), (error: unknown) => {
      assert.ok(error instanceof LocalProfileStoreError);
      assert.doesNotMatch(error.message, /line-two-secret|attacker/);
      return true;
    });
  }
  assert.deepEqual(await store.list(), []);
});

test('a symlinked credentials file is refused for reading and writing', { skip: !posix }, async () => {
  const root = await freshRoot();
  const configDir = join(root, 'config');
  await mkdir(configDir, { mode: 0o700 });
  const elsewhere = join(root, 'elsewhere.json');
  await writeFile(elsewhere, 'untouched');
  await symlink(elsewhere, join(configDir, 'credentials.json'));
  const store = new LocalProfileStore({ configDir });

  await assert.rejects(store.list(), /symbolic link/);
  await assert.rejects(store.save('work', credentials('work@example.com')), /symbolic link/);
  assert.equal(await readFile(elsewhere, 'utf8'), 'untouched');
});

test('a symlinked configuration directory is refused', { skip: !posix }, async () => {
  const root = await freshRoot();
  const realDir = join(root, 'real');
  await mkdir(realDir);
  await symlink(realDir, join(root, 'config'));
  const store = new LocalProfileStore({ configDir: join(root, 'config') });

  await assert.rejects(store.save('work', credentials('work@example.com')), /symbolic link/);
  assert.deepEqual(await readdir(realDir), []);
});

test('a corrupt file is reported without quoting any of its contents', async () => {
  const store = await freshStore();
  await store.save('work', credentials('work@example.com'));
  await writeFile(store.credentialsFile, '{"version":1,"profiles":{"work":{"clientSecret":"leaked-fragment"');

  await assert.rejects(store.list(), (error: unknown) => {
    assert.ok(error instanceof LocalProfileStoreError);
    assert.doesNotMatch(error.message, /leaked-fragment/);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('a file naming a missing active profile, or another format version, is refused', async () => {
  const store = await freshStore();
  await store.save('work', credentials('work@example.com'));
  const document = JSON.parse(await readFile(store.credentialsFile, 'utf8'));

  await writeFile(store.credentialsFile, JSON.stringify({ ...document, activeProfile: 'ghost' }));
  await assert.rejects(store.list(), /active profile that does not exist/);

  await writeFile(store.credentialsFile, JSON.stringify({ ...document, version: 2 }));
  await assert.rejects(store.list(), /unsupported format/);
});

test('saves are atomic and serialised: concurrent writers all land, and no temporary file remains', async () => {
  const store = await freshStore();
  const names = Array.from({ length: 12 }, (_, index) => `profile-${index}`);

  await Promise.all(names.map((name) => store.save(name, credentials(`${name}@example.com`))));

  assert.deepEqual((await store.list()).map((profile) => profile.name), [...names].sort());
  assert.deepEqual(await readdir(store.configDir), ['credentials.json']);
});

test('the default location follows the platform, and MCP_GMAIL_CONFIG_DIR overrides it', () => {
  assert.equal(
    resolveLocalProfileConfigDir({ platform: 'darwin', homeDir: '/Users/a', env: {} }),
    '/Users/a/Library/Application Support/xtnd-mcp-gmail',
  );
  assert.equal(
    resolveLocalProfileConfigDir({ platform: 'linux', homeDir: '/home/a', env: {} }),
    '/home/a/.config/xtnd-mcp-gmail',
  );
  assert.equal(
    resolveLocalProfileConfigDir({ platform: 'linux', homeDir: '/home/a', env: { XDG_CONFIG_HOME: '/xdg' } }),
    '/xdg/xtnd-mcp-gmail',
  );
  assert.equal(
    resolveLocalProfileConfigDir({ platform: 'linux', homeDir: '/home/a', env: { MCP_GMAIL_CONFIG_DIR: '/custom' } }),
    '/custom',
  );
  assert.throws(() => resolveLocalProfileConfigDir({ configDir: '' }), LocalProfileStoreError);
});
