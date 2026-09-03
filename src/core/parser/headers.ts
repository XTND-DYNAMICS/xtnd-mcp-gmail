const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const LOCAL_PART = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const MESSAGE_ID = /^<[^<>\s@]+@[^<>\s@]+>$/;

export function assertNoHeaderControls(value: string, label: string): string {
  if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value)) {
    throw new Error(`${label} contains unsupported control characters.`);
  }
  return value;
}

/** Validate one mailbox value and return its envelope address without display text. */
export function parseMailbox(value: string, label = 'Mailbox'): string {
  const trimmed = assertNoHeaderControls(value, label).trim();
  if (!trimmed || trimmed.length > 998) throw new Error(`${label} is invalid.`);

  let address = trimmed;
  if (trimmed.includes('<') || trimmed.includes('>')) {
    const match = /^(?:[^<>]*)<([^<>]+)>$/.exec(trimmed);
    if (!match) throw new Error(`${label} must contain exactly one mailbox.`);
    address = match[1].trim();
  }
  if (/\s|,|;/.test(address) || address.length > 254) {
    throw new Error(`${label} must contain exactly one mailbox.`);
  }

  const at = address.lastIndexOf('@');
  if (at <= 0 || at !== address.indexOf('@')) throw new Error(`${label} is invalid.`);
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (
    local.length > 64
    || !LOCAL_PART.test(local)
    || local.startsWith('.')
    || local.endsWith('.')
    || local.includes('..')
    || domain.length === 0
    || domain.length > 253
    || !domain.split('.').every((part) => DOMAIN_LABEL.test(part))
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return `${local}@${domain.toLowerCase()}`;
}

export function validatedMailboxHeader(value: string, label: string): string {
  parseMailbox(value, label);
  return value.trim();
}

export function validatedMessageId(value: string, label: string): string {
  const trimmed = assertNoHeaderControls(value, label).trim();
  if (!MESSAGE_ID.test(trimmed)) throw new Error(`${label} is not a valid Message-ID.`);
  return trimmed;
}

export function validatedReferences(value: string): string {
  const trimmed = assertNoHeaderControls(value, 'References').trim();
  const identifiers = trimmed.split(/\s+/).filter(Boolean);
  if (identifiers.length === 0 || identifiers.length > 100 || !identifiers.every((id) => MESSAGE_ID.test(id))) {
    throw new Error('References must contain valid Message-ID values.');
  }
  return identifiers.join(' ');
}

export function validatedMediaType(value: string): string {
  const trimmed = assertNoHeaderControls(value, 'Attachment content type').trim();
  if (!MEDIA_TYPE.test(trimmed)) throw new Error('Attachment content type is invalid.');
  return trimmed.toLowerCase();
}

export function encodedFilenameParameter(value: string): string {
  const filename = assertNoHeaderControls(value, 'Attachment filename').trim();
  if (!filename || filename.length > 255) throw new Error('Attachment filename is invalid.');
  return encodeURIComponent(filename)
    .replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function canonicalBase64(value: string): string {
  const compact = value.replace(/[\t\r\n ]+/g, '');
  if (
    compact.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)
  ) {
    throw new Error('Attachment content is not canonical base64.');
  }
  try {
    if (btoa(atob(compact)) !== compact) throw new Error('non-canonical');
  } catch {
    throw new Error('Attachment content is not canonical base64.');
  }
  return compact;
}
