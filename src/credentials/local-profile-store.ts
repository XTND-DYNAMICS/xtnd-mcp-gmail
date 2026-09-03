/**
 * Local named-profile storage for the stdio MCP client.
 *
 * Security boundary: the OAuth client secret and refresh token are stored as
 * filesystem-protected plaintext. They are not encrypted. Confidentiality
 * relies on the profile directory being mode 0700 and the credentials file
 * being mode 0600 on platforms that enforce POSIX permissions. Callers should
 * never print the loaded credential object.
 *
 * A refresh token is a bearer credential for the entire granted scope set and
 * does not expire on its own. This store performs no network I/O, so deleting
 * a profile only removes the local copy; `mcp-gmail accounts remove` revokes
 * the grant at Google before calling `remove()`.
 */

import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GmailCredentials } from '../types.js';
import { parseMailbox } from '../core/parser/headers.js';

const STORE_VERSION = 1;
const CONFIG_DIRECTORY_MODE = 0o700;
const CREDENTIALS_FILE_MODE = 0o600;
const CREDENTIALS_FILE_NAME = 'credentials.json';
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NO_FOLLOW_FLAG = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;

interface StoredProfileDocument {
  version: typeof STORE_VERSION;
  activeProfile: string | null;
  profiles: Record<string, GmailCredentials>;
}

export interface LocalProfileMetadata {
  name: string;
  email: string;
  active: boolean;
  /** Scopes the stored grant holds. Never includes the tokens themselves. */
  scopes: string[];
}

export interface LocalProfileStoreOptions {
  /** Explicit path, primarily for embedding and tests. */
  configDir?: string;
  /** Environment source used to resolve MCP_GMAIL_CONFIG_DIR. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Platform override, primarily for testing default-path resolution. */
  platform?: NodeJS.Platform;
  /** Home directory override, primarily for testing default-path resolution. */
  homeDir?: string;
}

export interface SaveProfileOptions {
  /** Select this profile after saving it. The first saved profile is always selected. */
  select?: boolean;
}

export class LocalProfileStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LocalProfileStoreError';
  }
}

export class ProfileNotFoundError extends LocalProfileStoreError {
  constructor(profileName: string) {
    super(`No local Gmail credential profile named "${profileName}" exists.`);
    this.name = 'ProfileNotFoundError';
  }
}

/** Resolve the private application configuration directory for the current OS. */
export function resolveLocalProfileConfigDir(
  options: LocalProfileStoreOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const pathImplementation = platform === 'win32' ? win32 : posix;

  if (options.configDir !== undefined) {
    if (options.configDir.length === 0) {
      throw new LocalProfileStoreError('The local profile configuration directory cannot be empty.');
    }
    return pathImplementation.resolve(options.configDir);
  }

  const env = options.env ?? process.env;
  const configuredPath = env.MCP_GMAIL_CONFIG_DIR;
  if (configuredPath) {
    return pathImplementation.resolve(configuredPath);
  }

  const homeDirectory = options.homeDir ?? homedir();

  if (platform === 'darwin') {
    return pathImplementation.join(homeDirectory, 'Library', 'Application Support', 'xtnd-mcp-gmail');
  }

  if (platform === 'win32') {
    const appDataDirectory = env.APPDATA || pathImplementation.join(homeDirectory, 'AppData', 'Roaming');
    return pathImplementation.join(appDataDirectory, 'xtnd-mcp-gmail');
  }

  const xdgConfigDirectory = env.XDG_CONFIG_HOME || pathImplementation.join(homeDirectory, '.config');
  return pathImplementation.join(xdgConfigDirectory, 'xtnd-mcp-gmail');
}

/**
 * A small persistent store for named Gmail OAuth profiles.
 *
 * The class deliberately has no logging surface so a caller cannot accidentally
 * leak a password through store diagnostics. `list()` returns metadata only;
 * `load()` is the sole operation that returns a password.
 */
export class LocalProfileStore {
  readonly configDir: string;
  readonly credentialsFile: string;

  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: LocalProfileStoreOptions = {}) {
    this.configDir = resolveLocalProfileConfigDir(options);
    this.credentialsFile = join(this.configDir, CREDENTIALS_FILE_NAME);
  }

  async save(
    profileName: string,
    credentials: GmailCredentials,
    options: SaveProfileOptions = {},
  ): Promise<LocalProfileMetadata> {
    validateProfileName(profileName);
    const safeCredentials = validateAndCloneCredentials(credentials);

    return this.enqueueWrite(async () => {
      const document = await this.readDocument();
      document.profiles[profileName] = safeCredentials;

      if (document.activeProfile === null || options.select === true) {
        document.activeProfile = profileName;
      }

      await this.writeDocument(document);
      return toMetadata(profileName, safeCredentials, document.activeProfile);
    });
  }

  async list(): Promise<LocalProfileMetadata[]> {
    const document = await this.readDocument();

    return Object.entries(document.profiles)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, credentials]) => toMetadata(name, credentials, document.activeProfile));
  }

  async select(profileName: string): Promise<LocalProfileMetadata> {
    validateProfileName(profileName);

    return this.enqueueWrite(async () => {
      const document = await this.readDocument();
      const credentials = document.profiles[profileName];

      if (!credentials) {
        throw new ProfileNotFoundError(profileName);
      }

      document.activeProfile = profileName;
      await this.writeDocument(document);
      return toMetadata(profileName, credentials, document.activeProfile);
    });
  }

  async remove(profileName: string): Promise<boolean> {
    validateProfileName(profileName);

    return this.enqueueWrite(async () => {
      const document = await this.readDocument();
      if (!Object.hasOwn(document.profiles, profileName)) {
        return false;
      }

      delete document.profiles[profileName];
      if (document.activeProfile === profileName) {
        document.activeProfile = null;
      }

      await this.writeDocument(document);
      return true;
    });
  }

  async load(profileName?: string): Promise<GmailCredentials | null> {
    if (profileName !== undefined) {
      validateProfileName(profileName);
    }

    const document = await this.readDocument();
    const resolvedName = profileName ?? document.activeProfile;
    if (resolvedName === null) {
      return null;
    }

    const credentials = document.profiles[resolvedName];
    return credentials ? cloneCredentials(credentials) : null;
  }

  async getActiveProfileName(): Promise<string | null> {
    const document = await this.readDocument();
    return document.activeProfile;
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async ensureConfigDirectory(): Promise<void> {
    await mkdir(this.configDir, {
      recursive: true,
      mode: CONFIG_DIRECTORY_MODE,
    });

    const directoryStat = await lstat(this.configDir);
    if (directoryStat.isSymbolicLink()) {
      throw new LocalProfileStoreError(
        `Refusing to use a symbolic link as the local profile directory: ${this.configDir}`,
      );
    }
    if (!directoryStat.isDirectory()) {
      throw new LocalProfileStoreError(
        `The local profile configuration path is not a directory: ${this.configDir}`,
      );
    }

    await chmod(this.configDir, CONFIG_DIRECTORY_MODE);
  }

  private async readDocument(): Promise<StoredProfileDocument> {
    await this.ensureConfigDirectory();
    const fileStat = await this.getCredentialsFileStat();
    if (fileStat === null) {
      return emptyDocument();
    }
    if (!fileStat.isFile()) {
      throw new LocalProfileStoreError(
        `The local credentials path is not a regular file: ${this.credentialsFile}`,
      );
    }

    let handle;
    try {
      handle = await open(this.credentialsFile, constants.O_RDONLY | NO_FOLLOW_FLAG);
      await handle.chmod(CREDENTIALS_FILE_MODE);
      const contents = await handle.readFile({ encoding: 'utf8' });
      return parseDocument(contents);
    } catch (error) {
      if (isSymlinkOpenError(error)) {
        throw symlinkCredentialsError(this.credentialsFile, error);
      }
      if (error instanceof LocalProfileStoreError) {
        throw error;
      }
      throw new LocalProfileStoreError('Unable to read the local Gmail credential profiles.', {
        cause: error,
      });
    } finally {
      await handle?.close();
    }
  }

  private async writeDocument(document: StoredProfileDocument): Promise<void> {
    await this.ensureConfigDirectory();
    await this.assertCredentialsFileIsNotSymlink();

    const temporaryFile = join(
      dirname(this.credentialsFile),
      `.${CREDENTIALS_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle;

    try {
      handle = await open(
        temporaryFile,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW_FLAG,
        CREDENTIALS_FILE_MODE,
      );
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8' });
      await handle.chmod(CREDENTIALS_FILE_MODE);
      await handle.sync();
      await handle.close();
      handle = undefined;

      // Re-check immediately before replacement so a pre-existing symlink is
      // rejected rather than silently replaced.
      await this.assertCredentialsFileIsNotSymlink();
      await rename(temporaryFile, this.credentialsFile);
      await this.enforceCredentialsFileMode();
      await syncDirectory(this.configDir);
    } catch (error) {
      if (isSymlinkOpenError(error)) {
        throw symlinkCredentialsError(this.credentialsFile, error);
      }
      if (error instanceof LocalProfileStoreError) {
        throw error;
      }
      throw new LocalProfileStoreError('Unable to save the local Gmail credential profiles.', {
        cause: error,
      });
    } finally {
      await handle?.close();
      await unlink(temporaryFile).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
    }
  }

  private async getCredentialsFileStat(): Promise<Awaited<ReturnType<typeof lstat>> | null> {
    try {
      const fileStat = await lstat(this.credentialsFile);
      if (fileStat.isSymbolicLink()) {
        throw symlinkCredentialsError(this.credentialsFile);
      }
      return fileStat;
    } catch (error) {
      if (isErrorWithCode(error, 'ENOENT')) {
        return null;
      }
      throw error;
    }
  }

  private async assertCredentialsFileIsNotSymlink(): Promise<void> {
    await this.getCredentialsFileStat();
  }

  private async enforceCredentialsFileMode(): Promise<void> {
    await this.assertCredentialsFileIsNotSymlink();
    let handle;
    try {
      handle = await open(this.credentialsFile, constants.O_RDONLY | NO_FOLLOW_FLAG);
      await handle.chmod(CREDENTIALS_FILE_MODE);
    } catch (error) {
      if (isSymlinkOpenError(error)) {
        throw symlinkCredentialsError(this.credentialsFile, error);
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }
}

function validateProfileName(profileName: string): void {
  if (typeof profileName !== 'string' || !PROFILE_NAME_PATTERN.test(profileName)) {
    throw new LocalProfileStoreError(
      'Profile names must be 1-64 characters, start with a letter or number, and contain only letters, numbers, dots, underscores, or hyphens.',
    );
  }
}

function validateAndCloneCredentials(credentials: GmailCredentials): GmailCredentials {
  if (typeof credentials !== 'object' || credentials === null) {
    throw new LocalProfileStoreError('Gmail credentials must be an object.');
  }
  if (typeof credentials.email !== 'string' || credentials.email.trim().length === 0) {
    throw new LocalProfileStoreError('Gmail credentials require a non-empty email address.');
  }
  let normalizedEmail: string;
  try {
    normalizedEmail = parseMailbox(credentials.email, 'Mailbox address');
  } catch {
    throw new LocalProfileStoreError('Gmail credentials contain an invalid email address.');
  }

  validateSecret(credentials.clientId, 'OAuth client ID');
  validateSecret(credentials.clientSecret, 'OAuth client secret');
  validateSecret(credentials.refreshToken, 'OAuth refresh token');

  if (!Array.isArray(credentials.scopes) || credentials.scopes.length === 0) {
    throw new LocalProfileStoreError('Gmail credentials require at least one granted scope.');
  }
  for (const scope of credentials.scopes) {
    if (typeof scope !== 'string' || scope.trim().length === 0 || scope.length > 512) {
      throw new LocalProfileStoreError('Granted scopes must be non-empty strings.');
    }
  }

  if (
    credentials.accessTokenExpiresAt !== undefined
    && (typeof credentials.accessTokenExpiresAt !== 'number'
      || !Number.isFinite(credentials.accessTokenExpiresAt))
  ) {
    throw new LocalProfileStoreError('The access token expiry must be epoch milliseconds.');
  }

  return cloneCredentials({ ...credentials, email: normalizedEmail });
}

/**
 * Reject empty or control-bearing secrets. The value is never echoed back, so
 * the message names only the field it rejected.
 */
function validateSecret(value: unknown, label: string): void {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 4_096
    || /[\u0000\r\n]/.test(value)
  ) {
    throw new LocalProfileStoreError(`Gmail credentials require a valid ${label}.`);
  }
}

function cloneCredentials(credentials: GmailCredentials): GmailCredentials {
  return {
    email: credentials.email,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    refreshToken: credentials.refreshToken,
    scopes: [...credentials.scopes],
    ...(credentials.accessToken === undefined ? {} : { accessToken: credentials.accessToken }),
    ...(credentials.accessTokenExpiresAt === undefined
      ? {}
      : { accessTokenExpiresAt: credentials.accessTokenExpiresAt }),
  };
}

function toMetadata(
  name: string,
  credentials: GmailCredentials,
  activeProfile: string | null,
): LocalProfileMetadata {
  return {
    name,
    email: credentials.email,
    active: name === activeProfile,
    scopes: [...credentials.scopes],
  };
}

function emptyDocument(): StoredProfileDocument {
  return {
    version: STORE_VERSION,
    activeProfile: null,
    profiles: Object.create(null) as Record<string, GmailCredentials>,
  };
}

function parseDocument(contents: string): StoredProfileDocument {
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    // Do not retain JSON.parse's error as a cause: newer runtimes may include a
    // fragment of the malformed document, which could expose a password.
    throw new LocalProfileStoreError('The local Gmail credential profile file is not valid JSON.');
  }

  if (!isPlainRecord(value) || value.version !== STORE_VERSION) {
    throw new LocalProfileStoreError('The local Gmail credential profile file has an unsupported format.');
  }
  if (value.activeProfile !== null && typeof value.activeProfile !== 'string') {
    throw new LocalProfileStoreError('The local Gmail credential profile file has an invalid active profile.');
  }
  if (!isPlainRecord(value.profiles)) {
    throw new LocalProfileStoreError('The local Gmail credential profile file has invalid profiles.');
  }

  const profiles = Object.create(null) as Record<string, GmailCredentials>;
  for (const [name, rawCredentials] of Object.entries(value.profiles)) {
    validateProfileName(name);
    profiles[name] = validateAndCloneCredentials(rawCredentials as GmailCredentials);
  }

  const activeProfile = value.activeProfile;
  if (activeProfile !== null) {
    validateProfileName(activeProfile);
    if (!Object.hasOwn(profiles, activeProfile)) {
      throw new LocalProfileStoreError(
        'The local Gmail credential profile file refers to an active profile that does not exist.',
      );
    }
  }

  return {
    version: STORE_VERSION,
    activeProfile,
    profiles,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function isSymlinkOpenError(error: unknown): boolean {
  return isErrorWithCode(error, 'ELOOP') || isErrorWithCode(error, 'EMLINK');
}

function symlinkCredentialsError(path: string, cause?: unknown): LocalProfileStoreError {
  return new LocalProfileStoreError(
    `Refusing to use a symbolic link as the local credentials file: ${path}`,
    cause === undefined ? undefined : { cause },
  );
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch {
    // Some filesystems/platforms do not support fsync on a directory. The file
    // itself has already been fsynced and atomically renamed at this point.
  } finally {
    await handle?.close();
  }
}
