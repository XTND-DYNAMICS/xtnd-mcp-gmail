/**
 * RFC 5322 composer for Gmail's `raw` upload format.
 *
 * Adapted from the xtnd-mcp-one SMTP composer. Two differences matter for
 * Gmail:
 *
 *  - Gmail accepts the whole message as one base64url blob, so there is no
 *    separate SMTP envelope. `Bcc` therefore belongs in the headers; Gmail
 *    strips it before delivery. Omitting it, as the SMTP path must, would
 *    silently drop blind recipients.
 *  - Gmail assigns the final `Message-ID`, so this composer does not invent
 *    one. It only sets the threading headers the caller supplies.
 */

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import {
  assertNoHeaderControls,
  canonicalBase64,
  encodedFilenameParameter,
  parseMailbox,
  validatedMailboxHeader,
  validatedMediaType,
  validatedMessageId,
  validatedReferences,
} from './headers.js';
import type { SendEmailOptions, OutboundAttachment, AttachedEmail } from '../../types.js';

const USER_AGENT = 'xtnd-mcp-gmail/0.1.0';

function mediaTypeFor(name: string): string {
  const types: Record<string, string> = {
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.txt': 'text/plain', '.csv': 'text/csv', '.html': 'text/html',
    '.json': 'application/json', '.zip': 'application/zip',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.eml': 'message/rfc822',
  };
  return types[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

function normalizeAttachment(item: string | OutboundAttachment): { filename: string; contentType: string; dataBase64: string } {
  if (typeof item === 'string') {
    const data = readFileSync(item);
    const filename = basename(item);
    return {
      filename,
      contentType: mediaTypeFor(filename),
      dataBase64: data.toString('base64'),
    };
  }

  if (item.filePath) {
    const data = readFileSync(item.filePath);
    const filename = item.filename || basename(item.filePath);
    return {
      filename,
      contentType: item.contentType || mediaTypeFor(filename),
      dataBase64: data.toString('base64'),
    };
  }

  return {
    filename: item.filename,
    contentType: item.contentType || mediaTypeFor(item.filename),
    dataBase64: item.dataBase64 || '',
  };
}

/** Build the RFC 5322 message text for a Gmail send, draft, or insert. */
export function composeMimeMessage(options: SendEmailOptions, senderEmail: string): string {
  const authenticatedSender = parseMailbox(senderEmail, 'Authenticated sender');
  const from = validatedMailboxHeader(options.from || authenticatedSender, 'From');
  const toList = options.to ? mailboxHeaderList(options.to, 'To') : '';
  const ccList = options.cc ? mailboxHeaderList(options.cc, 'Cc') : undefined;
  const bccList = options.bcc ? mailboxHeaderList(options.bcc, 'Bcc') : undefined;
  const subject = assertNoHeaderControls(options.subject || '', 'Subject');
  const bodyText = options.bodyText || '';

  const headers: string[] = [
    `From: ${from}`,
    ...(toList ? [`To: ${toList}`] : []),
    `Subject: =?UTF-8?B?${utf8Base64(subject)}?=`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `User-Agent: ${USER_AGENT}`,
  ];

  if (ccList) headers.push(`Cc: ${ccList}`);
  if (bccList) headers.push(`Bcc: ${bccList}`);
  if (options.inReplyTo) {
    headers.push(`In-Reply-To: ${validatedMessageId(options.inReplyTo, 'In-Reply-To')}`);
  }
  if (options.references) {
    headers.push(`References: ${validatedReferences(options.references)}`);
  }

  const rawAttachments = options.attachments ?? [];
  const normalizedAttachments = rawAttachments.map(normalizeAttachment);
  const attachedEmails = options.attachedEmails ?? [];
  const hasAttachments = normalizedAttachments.length > 0 || attachedEmails.length > 0;
  const hasHtml = Boolean(options.bodyHtml);

  if (!hasAttachments && !hasHtml) {
    headers.push('Content-Type: text/plain; charset=UTF-8');
    headers.push('Content-Transfer-Encoding: 8bit');
    return `${headers.join('\r\n')}\r\n\r\n${bodyText}\r\n`;
  }

  const mixedBoundary = `====_Mixed_${randomToken()}_====`;
  const altBoundary = `====_Alt_${randomToken()}_====`;

  if (!hasAttachments && hasHtml) {
    headers.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    return [
      headers.join('\r\n'),
      '',
      `--${altBoundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      bodyText,
      '',
      `--${altBoundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      options.bodyHtml,
      '',
      `--${altBoundary}--`,
      '',
    ].join('\r\n');
  }

  headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);

  const parts: string[] = [headers.join('\r\n'), '', `--${mixedBoundary}`];

  if (hasHtml) {
    parts.push(
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      '',
      `--${altBoundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      bodyText,
      '',
      `--${altBoundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      options.bodyHtml!,
      '',
      `--${altBoundary}--`,
    );
  } else {
    parts.push(
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      bodyText,
    );
  }

  for (const attachment of normalizedAttachments) {
    const contentType = validatedMediaType(attachment.contentType ?? 'application/octet-stream');
    const encodedFilename = encodedFilenameParameter(attachment.filename);
    parts.push(
      `--${mixedBoundary}`,
      `Content-Type: ${contentType}; name*=UTF-8''${encodedFilename}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename*=UTF-8''${encodedFilename}`,
      '',
      wrapBase64(attachment.dataBase64),
    );
  }

  for (let idx = 0; idx < attachedEmails.length; idx++) {
    const email = attachedEmails[idx];
    const filename = email.filename || `attached-message-${idx + 1}.eml`;
    const encodedFilename = encodedFilenameParameter(filename);
    parts.push(
      `--${mixedBoundary}`,
      `Content-Type: message/rfc822; name*=UTF-8''${encodedFilename}`,
      'Content-Transfer-Encoding: 8bit',
      `Content-Disposition: attachment; filename*=UTF-8''${encodedFilename}`,
      '',
      email.rawEml.trim(),
    );
  }

  parts.push(`--${mixedBoundary}--`, '');
  return parts.join('\r\n');
}

/** Encode a composed message for the Gmail `raw` field. */
export function toGmailRaw(message: string): string {
  const bytes = new TextEncoder().encode(message);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Derive the threading headers for a reply. Gmail groups by `References`, so a
 * reply must carry the whole chain, not just the immediate parent.
 */
export function buildReplyHeaders(parent: {
  messageId: string;
  references?: string;
}): { inReplyTo?: string; references?: string } {
  if (!parent.messageId) return {};

  const chain = [parent.references, parent.messageId]
    .filter((entry): entry is string => Boolean(entry && entry.trim().length > 0))
    .join(' ')
    .trim();

  return { inReplyTo: parent.messageId, references: chain };
}

/** Prefix a reply subject with `Re:` unless it already carries one. */
export function replySubject(subject: string): string {
  return /^\s*(re|sv|vs|aw|antw|ref)\s*:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

/** Prefix a forwarded subject with `Fwd:` unless it already carries one. */
export function forwardSubject(subject: string): string {
  return /^(fwd|fw):/i.test(subject.trim()) ? subject : `Fwd: ${subject}`;
}

function wrapBase64(value: string, lineLength = 76): string {
  const clean = canonicalBase64(value);
  const chunks: string[] = [];
  for (let index = 0; index < clean.length; index += lineLength) {
    chunks.push(clean.slice(index, index + lineLength));
  }
  return chunks.join('\r\n');
}

function mailboxHeaderList(value: string | string[], label: string): string {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 || values.length > 100) {
    throw new Error(`${label} is invalid.`);
  }
  return values.map((mailbox) => validatedMailboxHeader(mailbox, label)).join(', ');
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function utf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
