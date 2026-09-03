/**
 * Gmail message payload decoding.
 *
 * Gmail returns a recursive MIME tree with base64url bodies rather than raw
 * RFC 822, so this module walks that tree instead of parsing MIME text. The
 * `raw` format is still available for callers that want the original source.
 */

import { htmlToMarkdown } from './markdown.js';
import type { EmailAddress, EmailAttachment, EmailDetail } from '../../types.js';

interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPayloadPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPayloadPart[];
}

export interface GmailMessageResource {
  id: string;
  threadId: string;
  historyId?: string;
  labelIds?: string[];
  snippet?: string;
  sizeEstimate?: number;
  internalDate?: string;
  payload?: GmailPayloadPart;
  raw?: string;
}

/** Convert a Gmail message resource into this package's normalised shape. */
export function parseMessage(resource: GmailMessageResource): EmailDetail {
  const headers = indexHeaders(resource.payload?.headers);
  const bodies = { text: '', html: '' };
  const attachments: EmailAttachment[] = [];

  if (resource.payload) {
    walkPart(resource.payload, bodies, attachments);
  }

  const bodyHtml = bodies.html || undefined;
  const bodyText = bodies.text || undefined;

  return {
    id: resource.id,
    threadId: resource.threadId,
    historyId: resource.historyId,
    messageId: headers['message-id'] ?? '',
    from: parseAddressList(headers.from),
    to: parseAddressList(headers.to),
    cc: headers.cc ? parseAddressList(headers.cc) : undefined,
    bcc: headers.bcc ? parseAddressList(headers.bcc) : undefined,
    replyTo: headers['reply-to'] ? parseAddressList(headers['reply-to']) : undefined,
    subject: headers.subject ?? '',
    date: headers.date ?? isoFromInternalDate(resource.internalDate),
    internalDate: resource.internalDate,
    snippet: decodeEntities(resource.snippet ?? ''),
    labelIds: resource.labelIds ?? [],
    sizeEstimate: resource.sizeEstimate,
    hasAttachments: attachments.length > 0,
    inReplyTo: headers['in-reply-to'],
    references: headers.references,
    bodyText,
    bodyHtml,
    bodyMarkdown: bodyHtml ? htmlToMarkdown(bodyHtml) : bodyText,
    attachments: attachments.length > 0 ? attachments : undefined,
    raw: resource.raw ? decodeBase64Url(resource.raw) : undefined,
  };
}

/**
 * Depth-first walk collecting the best text and HTML alternatives plus every
 * attachment part. The last non-empty alternative wins, which matches how mail
 * clients treat `multipart/alternative` ordering.
 */
function walkPart(
  part: GmailPayloadPart,
  bodies: { text: string; html: string },
  attachments: EmailAttachment[],
): void {
  const mimeType = (part.mimeType ?? '').toLowerCase();
  const filename = part.filename ?? '';
  const data = part.body?.data;

  if (filename.length > 0 || part.body?.attachmentId) {
    const headers = indexHeaders(part.headers);
    attachments.push({
      attachmentId: part.body?.attachmentId,
      filename: filename || 'attachment',
      contentType: mimeType || 'application/octet-stream',
      size: part.body?.size ?? 0,
      contentId: stripAngleBrackets(headers['content-id']),
    });
  } else if (data) {
    if (mimeType === 'text/plain') {
      bodies.text = decodeBase64Url(data);
    } else if (mimeType === 'text/html') {
      bodies.html = decodeBase64Url(data);
    }
  }

  for (const child of part.parts ?? []) {
    walkPart(child, bodies, attachments);
  }
}

function indexHeaders(headers: GmailHeader[] | undefined): Record<string, string> {
  const index: Record<string, string> = {};
  for (const header of headers ?? []) {
    index[header.name.toLowerCase()] = header.value;
  }
  return index;
}

/**
 * Split an address header into individual addresses.
 *
 * Commas inside a quoted display name do not separate addresses, so the split
 * tracks quoting and angle-bracket depth rather than using `String.split`.
 */
export function parseAddressList(value: string | undefined): EmailAddress[] {
  if (!value) return [];

  const entries: string[] = [];
  let current = '';
  let inQuotes = false;
  let inAngles = false;

  for (const character of value) {
    if (character === '"') {
      inQuotes = !inQuotes;
    } else if (character === '<' && !inQuotes) {
      inAngles = true;
    } else if (character === '>' && !inQuotes) {
      inAngles = false;
    } else if (character === ',' && !inQuotes && !inAngles) {
      entries.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  entries.push(current);

  return entries
    .map((entry) => parseSingleAddress(entry.trim()))
    .filter((entry): entry is EmailAddress => entry !== null);
}

function parseSingleAddress(entry: string): EmailAddress | null {
  if (entry.length === 0) return null;

  const angled = /^(.*?)<([^>]+)>$/.exec(entry);
  if (angled) {
    const name = decodeWord(angled[1].trim().replace(/^"|"$/g, '').trim());
    const address = angled[2].trim();
    return name.length > 0 ? { name, address } : { address };
  }

  return { address: entry };
}

/**
 * Decode RFC 2047 encoded-words (`=?UTF-8?B?...?=`) in display names. Gmail
 * usually decodes these already, but forwarded and imported mail can carry
 * them through untouched.
 */
export function decodeWord(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (match, _charset: string, encoding: string, payload: string) => {
      try {
        if (encoding.toUpperCase() === 'B') {
          return new TextDecoder().decode(base64ToBytes(payload));
        }
        const quoted = payload
          .replace(/_/g, ' ')
          .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
        return quoted;
      } catch {
        return match;
      }
    },
  );
}

export function decodeBase64Url(value: string): string {
  return new TextDecoder().decode(base64UrlToBytes(value));
}

export function base64UrlToBytes(value: string): Uint8Array {
  return base64ToBytes(value.replace(/-/g, '+').replace(/_/g, '/'));
}

function base64ToBytes(value: string): Uint8Array {
  const padded = value.padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function stripAngleBrackets(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/^<|>$/g, '');
}

function isoFromInternalDate(internalDate: string | undefined): string {
  if (!internalDate) return '';
  const milliseconds = Number(internalDate);
  if (!Number.isFinite(milliseconds)) return '';
  return new Date(milliseconds).toISOString();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
