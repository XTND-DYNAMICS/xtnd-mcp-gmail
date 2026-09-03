import type { GmailAppPasswordCredentials } from '../types.js';

const RECORD_VERSION = 1 as const;
const RECORD_ALGORITHM = 'AES-256-GCM' as const;
const STORAGE_PREFIX = 'mailbox:';
const AAD_CONTEXT = 'xtnd-mcp-gmail/credential-vault/v1';
const AES_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MAX_SUBJECT_BYTES = 256;

export interface CredentialVaultStorage {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CredentialVaultBindings {
  KV: CredentialVaultStorage;
  CREDENTIALS_MASTER_KEY: string;
}

export interface CredentialVaultStatus {
  configured: boolean;
  version: typeof RECORD_VERSION | null;
}

interface EncryptedCredentialRecordV1 {
  version: typeof RECORD_VERSION;
  algorithm: typeof RECORD_ALGORITHM;
  iv: string;
  ciphertext: string;
}

export class CredentialVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialVaultError';
  }
}

/**
 * Stores one encrypted mailbox credential set per authenticated caller.
 *
 * `subject` must be a stable authenticated subject or a one-way token hash,
 * never a raw bearer token. The subject is included in AES-GCM additional
 * authenticated data, so a record copied to another caller cannot decrypt.
 */
export class CredentialVault {
  private readonly storage: CredentialVaultStorage;
  private masterKeyBytes: Uint8Array | null;
  private masterKeyPromise: Promise<CryptoKey> | null = null;

  constructor(storage: CredentialVaultStorage, masterKeySecret: string) {
    this.storage = storage;
    this.masterKeyBytes = decodeMasterKey(masterKeySecret);
  }

  static fromBindings(bindings: CredentialVaultBindings): CredentialVault {
    return new CredentialVault(bindings.KV, bindings.CREDENTIALS_MASTER_KEY);
  }

  async save(subject: string, credentials: GmailAppPasswordCredentials): Promise<CredentialVaultStatus> {
    const validatedSubject = validateSubject(subject);
    const canonicalCredentials = canonicalizeCredentials(credentials);
    const plaintext = new TextEncoder().encode(JSON.stringify(canonicalCredentials));
    const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));

    try {
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv,
          additionalData: additionalAuthenticatedData(validatedSubject),
          tagLength: 128,
        },
        await this.getMasterKey(),
        plaintext
      );

      const record: EncryptedCredentialRecordV1 = {
        version: RECORD_VERSION,
        algorithm: RECORD_ALGORITHM,
        iv: encodeBase64Url(iv),
        ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
      };

      await this.storage.put(storageKey(validatedSubject), JSON.stringify(record));
      return { configured: true, version: RECORD_VERSION };
    } finally {
      plaintext.fill(0);
    }
  }

  async load(subject: string): Promise<GmailAppPasswordCredentials | null> {
    const validatedSubject = validateSubject(subject);
    const stored = await this.storage.get(storageKey(validatedSubject));
    if (stored === null) return null;

    const record = parseRecord(stored);
    const iv = decodeRecordBase64Url(record.iv, 'IV');
    const ciphertext = decodeRecordBase64Url(record.ciphertext, 'ciphertext');

    if (iv.byteLength !== GCM_IV_BYTES || ciphertext.byteLength <= GCM_TAG_BYTES) {
      throw new CredentialVaultError('Credential vault record is invalid.');
    }

    let decrypted: ArrayBuffer;
    try {
      decrypted = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv,
          additionalData: additionalAuthenticatedData(validatedSubject),
          tagLength: 128,
        },
        await this.getMasterKey(),
        ciphertext
      );
    } catch {
      throw new CredentialVaultError('Credential vault record could not be decrypted.');
    }

    const plaintext = new Uint8Array(decrypted);
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plaintext);
      const parsed: unknown = JSON.parse(decoded);
      return canonicalizeCredentials(parsed);
    } catch (error) {
      if (error instanceof CredentialVaultError) throw error;
      throw new CredentialVaultError('Credential vault record is invalid.');
    } finally {
      plaintext.fill(0);
    }
  }

  async delete(subject: string): Promise<void> {
    const validatedSubject = validateSubject(subject);
    await this.storage.delete(storageKey(validatedSubject));
  }

  async status(subject: string): Promise<CredentialVaultStatus> {
    const validatedSubject = validateSubject(subject);
    const stored = await this.storage.get(storageKey(validatedSubject));
    if (stored === null) return { configured: false, version: null };

    parseRecord(stored);
    return { configured: true, version: RECORD_VERSION };
  }

  private getMasterKey(): Promise<CryptoKey> {
    if (this.masterKeyPromise === null) {
      const keyBytes = this.masterKeyBytes;
      if (keyBytes === null) {
        throw new CredentialVaultError('Credential vault master key is unavailable.');
      }

      this.masterKeyPromise = crypto.subtle
        .importKey('raw', keyBytes, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
        .finally(() => {
          keyBytes.fill(0);
          this.masterKeyBytes = null;
        });
    }

    return this.masterKeyPromise;
  }
}

function storageKey(subject: string): string {
  return `${STORAGE_PREFIX}${subject}`;
}

function additionalAuthenticatedData(subject: string): Uint8Array {
  return new TextEncoder().encode(`${AAD_CONTEXT}\u0000${subject}`);
}

function validateSubject(subject: string): string {
  if (
    typeof subject !== 'string' ||
    subject.length === 0 ||
    subject.trim() !== subject ||
    /[\u0000-\u001f\u007f]/.test(subject) ||
    new TextEncoder().encode(subject).byteLength > MAX_SUBJECT_BYTES
  ) {
    throw new CredentialVaultError(
      'Credential vault subject must be a non-empty identifier of at most 256 UTF-8 bytes without surrounding whitespace or control characters.'
    );
  }

  return subject;
}

function canonicalizeCredentials(value: unknown): GmailAppPasswordCredentials {
  if (!isObject(value)) {
    throw new CredentialVaultError('Mailbox credentials are invalid.');
  }

  const { email, password, appPassword, imapHost, imapPort, smtpHost, smtpPort } = value;
  const pass = typeof appPassword === 'string' ? appPassword : (typeof password === 'string' ? password : '');
  if (
    typeof email !== 'string'
    || pass.length === 0
    || pass.length > 4_096
    || /[\u0000\r\n]/.test(pass)
  ) {
    throw new CredentialVaultError('Mailbox credentials require a non-empty email and password.');
  }

  const normalizedEmail = email.trim().toLowerCase();
  const credentials: GmailAppPasswordCredentials = { email: normalizedEmail, appPassword: pass };
  if (imapHost !== undefined) credentials.imapHost = validateHost(imapHost, 'IMAP');
  if (imapPort !== undefined) credentials.imapPort = validatePort(imapPort, 'IMAP');
  if (smtpHost !== undefined) credentials.smtpHost = validateHost(smtpHost, 'SMTP');
  if (smtpPort !== undefined) credentials.smtpPort = validatePort(smtpPort, 'SMTP');
  return credentials;
}

function validateHost(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || /\s/.test(value)) {
    throw new CredentialVaultError(`${label} host is invalid.`);
  }
  return value;
}

function validatePort(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new CredentialVaultError(`${label} port is invalid.`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(stored: string): EncryptedCredentialRecordV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    throw new CredentialVaultError('Credential vault record is invalid.');
  }

  if (!isObject(parsed)) {
    throw new CredentialVaultError('Credential vault record is invalid.');
  }

  const keys = Object.keys(parsed).sort();
  const expectedKeys = ['algorithm', 'ciphertext', 'iv', 'version'];
  if (
    keys.length !== expectedKeys.length ||
    !keys.every((key, index) => key === expectedKeys[index]) ||
    parsed.version !== RECORD_VERSION ||
    parsed.algorithm !== RECORD_ALGORITHM ||
    typeof parsed.iv !== 'string' ||
    typeof parsed.ciphertext !== 'string'
  ) {
    throw new CredentialVaultError('Credential vault record is invalid or uses an unsupported version.');
  }

  return {
    version: RECORD_VERSION,
    algorithm: RECORD_ALGORITHM,
    iv: parsed.iv,
    ciphertext: parsed.ciphertext,
  };
}

function decodeMasterKey(secret: string): Uint8Array {
  if (typeof secret !== 'string') {
    throw invalidMasterKey();
  }

  if (/^[0-9a-fA-F]{64}$/.test(secret)) {
    const bytes = new Uint8Array(AES_KEY_BYTES);
    for (let index = 0; index < secret.length; index += 2) {
      bytes[index / 2] = Number.parseInt(secret.slice(index, index + 2), 16);
    }
    return bytes;
  }

  const isStandardBase64 = /^[A-Za-z0-9+/]{43}=?$/.test(secret);
  const isUrlBase64 = /^[A-Za-z0-9_-]{43}=?$/.test(secret);
  if (!isStandardBase64 && !isUrlBase64) {
    throw invalidMasterKey();
  }

  const normalized = secret.replace(/-/g, '+').replace(/_/g, '/');
  let decoded: Uint8Array;
  try {
    decoded = decodeBase64(normalized.length === 43 ? `${normalized}=` : normalized);
  } catch {
    throw invalidMasterKey();
  }

  const canonical = encodeBase64(decoded).replace(/=$/, '');
  if (decoded.byteLength !== AES_KEY_BYTES || canonical !== normalized.replace(/=$/, '')) {
    decoded.fill(0);
    throw invalidMasterKey();
  }

  return decoded;
}

function invalidMasterKey(): CredentialVaultError {
  return new CredentialVaultError(
    'CREDENTIALS_MASTER_KEY must be exactly 32 bytes encoded as 64 hexadecimal characters or canonical base64/base64url.'
  );
}

function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeRecordBase64Url(value: string, label: string): Uint8Array {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new CredentialVaultError(`Credential vault ${label} is invalid.`);
  }

  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  let decoded: Uint8Array;
  try {
    decoded = decodeBase64(normalized + padding);
  } catch {
    throw new CredentialVaultError(`Credential vault ${label} is invalid.`);
  }

  if (encodeBase64Url(decoded) !== value) {
    decoded.fill(0);
    throw new CredentialVaultError(`Credential vault ${label} is invalid.`);
  }

  return decoded;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
