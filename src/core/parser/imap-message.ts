/**
 * RFC 5322 / MIME reader for IMAP FETCH responses.
 *
 * Robustly parses MIME trees (multipart/mixed, multipart/alternative,
 * multipart/related, message/rfc822), extracts unfolded headers, decodes
 * quoted-printable, base64 and charset variations, and extracts all attachment
 * metadata and base64 payloads.
 */

export interface ParsedAttachment {
  attachmentId: string;
  filename: string;
  contentType: string;
  size: number;
  contentDisposition?: string;
  contentId?: string;
  dataBase64: string;
}

export interface ParsedMimeMessage {
  headers: Record<string, string>;
  text: string;
  html: string;
  attachments: ParsedAttachment[];
  raw?: string;
}

/**
 * Strip the IMAP FETCH wrapper and return the message octets.
 */
export function extractFetchLiteral(response: string): string {
  const literal = response.match(/\{(\d+)\}\r?\n/);
  if (!literal) {
    return response;
  }

  const start = literal.index! + literal[0].length;
  const byteCount = parseInt(literal[1], 10);

  const bytes = Buffer.from(response.slice(start), 'utf8');
  return bytes.subarray(0, byteCount).toString('utf8');
}

/** Split a message into its header block and body, unfolding headers. */
export function splitMessage(raw: string): { headers: Record<string, string>; body: string } {
  const separator = raw.search(/\r?\n\r?\n/);
  const headerBlock = separator === -1 ? raw : raw.slice(0, separator);
  const body = separator === -1 ? '' : raw.slice(separator).replace(/^\r?\n\r?\n/, '');

  return { headers: parseHeaderBlock(headerBlock), body };
}

export function parseHeaderBlock(headerBlock: string): Record<string, string> {
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  const headers: Record<string, string> = {};

  for (const line of unfolded.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    if (!match) continue;

    const name = match[1].toLowerCase();
    if (!(name in headers)) {
      headers[name] = match[2].trim();
    }
  }

  return headers;
}

/** Decode a body according to its Content-Transfer-Encoding and charset. */
export function decodeBody(body: string, encoding: string, charset: string): string {
  const normalised = encoding.trim().toLowerCase();

  if (normalised === 'base64') {
    return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString(toNodeCharset(charset));
  }

  if (normalised === 'quoted-printable') {
    const joined = body.replace(/=\r?\n/g, '');
    const bytes: number[] = [];

    for (let index = 0; index < joined.length; index += 1) {
      if (joined[index] === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(index + 1, index + 3))) {
        bytes.push(parseInt(joined.slice(index + 1, index + 3), 16));
        index += 2;
        continue;
      }
      bytes.push(...Buffer.from(joined[index], 'utf8'));
    }

    return Buffer.from(bytes).toString(toNodeCharset(charset));
  }

  return body;
}

/** Decode raw body into a binary Buffer */
export function decodeBodyToBuffer(body: string, encoding: string): Buffer {
  const normalised = encoding.trim().toLowerCase();
  if (normalised === 'base64') {
    return Buffer.from(body.replace(/\s+/g, ''), 'base64');
  }
  if (normalised === 'quoted-printable') {
    const joined = body.replace(/=\r?\n/g, '');
    const bytes: number[] = [];
    for (let index = 0; index < joined.length; index += 1) {
      if (joined[index] === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(index + 1, index + 3))) {
        bytes.push(parseInt(joined.slice(index + 1, index + 3), 16));
        index += 2;
        continue;
      }
      bytes.push(...Buffer.from(joined[index], 'utf8'));
    }
    return Buffer.from(bytes);
  }
  return Buffer.from(body, 'utf8');
}

/**
 * Parse a complete message, walking multipart trees to find text/html bodies
 * and all attachments.
 */
export function parseMimeMessage(raw: string): ParsedMimeMessage {
  const { headers, body } = splitMessage(raw);
  const result: ParsedMimeMessage = { headers, text: '', html: '', attachments: [], raw };
  walkPart(headers, body, result);
  return result;
}

function walkPart(
  headers: Record<string, string>,
  body: string,
  result: ParsedMimeMessage,
): void {
  const contentType = headers['content-type'] ?? 'text/plain';
  const mediaType = contentType.split(';')[0].trim().toLowerCase();

  if (mediaType.startsWith('multipart/')) {
    const boundary = parameterOf(contentType, 'boundary');
    if (!boundary) return;

    for (const section of splitOnBoundary(body, boundary)) {
      const part = splitMessage(section);
      walkPart(part.headers, part.body, result);
    }
    return;
  }

  const disposition = headers['content-disposition'] ?? '';
  const isExplicitAttachment = /attachment/i.test(disposition);
  const rawFilename = parameterOf(disposition, 'filename')
    ?? parameterOf(disposition, 'filename*')
    ?? parameterOf(contentType, 'name')
    ?? parameterOf(contentType, 'name*');

  const encoding = headers['content-transfer-encoding'] ?? '7bit';
  const charset = parameterOf(contentType, 'charset') ?? 'utf-8';

  if (isExplicitAttachment || rawFilename || (mediaType !== 'text/plain' && mediaType !== 'text/html')) {
    let filename = rawFilename ? decodeFilename(rawFilename) : '';
    if (!filename) {
      if (mediaType === 'message/rfc822') {
        const inner = parseHeaderBlock(body);
        filename = `${decodeEncodedWords(inner.subject || 'attached-message')}.eml`;
      } else {
        const ext = mediaType.split('/')[1] || 'bin';
        filename = `attachment-${result.attachments.length + 1}.${ext}`;
      }
    }

    const buf = decodeBodyToBuffer(body, encoding);
    const attachmentId = String(result.attachments.length + 1);

    result.attachments.push({
      attachmentId,
      filename,
      contentType: mediaType,
      size: buf.byteLength,
      contentDisposition: disposition ? disposition.split(';')[0].trim() : undefined,
      contentId: headers['content-id']?.replace(/^<|>$/g, ''),
      dataBase64: buf.toString('base64'),
    });
    return;
  }

  const decoded = decodeBody(body, encoding, charset);

  if (mediaType === 'text/html') {
    result.html = decoded;
  } else if (mediaType === 'text/plain') {
    result.text = decoded;
  }
}

function splitOnBoundary(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const sections: string[] = [];

  for (const chunk of body.split(delimiter)) {
    const trimmed = chunk.replace(/^\r?\n/, '');
    if (trimmed.length === 0 || trimmed.startsWith('--')) continue;
    sections.push(trimmed);
  }

  return sections;
}

/** Read a `; name=value` parameter off a structured header value. */
function parameterOf(headerValue: string, name: string): string | undefined {
  const safeName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = headerValue.match(new RegExp(`${safeName}\\s*=\\s*"([^"]+)"|${safeName}\\s*=\\s*([^;\\s]+)`, 'i'));
  if (!match) return undefined;
  return (match[1] ?? match[2])?.trim();
}

function toNodeCharset(charset: string): BufferEncoding {
  const normalised = charset.trim().toLowerCase().replace(/^"|"$/g, '');
  if (normalised === 'utf-8' || normalised === 'utf8') return 'utf8';
  if (normalised === 'us-ascii' || normalised === 'ascii') return 'ascii';
  return 'latin1';
}

function decodeFilename(raw: string): string {
  // Handle RFC 2231 filename*=UTF-8''... format
  if (raw.toLowerCase().startsWith("utf-8''")) {
    try {
      return decodeURIComponent(raw.slice(7));
    } catch {
      return raw.slice(7);
    }
  }
  return decodeEncodedWords(raw.replace(/^"|"$/g, ''));
}

/**
 * Decode RFC 2047 encoded-words in a header value, e.g.
 * `=?utf-8?B?QW5kZXJzIFLDpGhy?=` becomes `Anders Rähr`.
 */
export function decodeEncodedWords(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (match, charset: string, encoding: string, payload: string) => {
      try {
        if (encoding.toUpperCase() === 'B') {
          return Buffer.from(payload, 'base64').toString(toNodeCharset(charset));
        }
        return decodeBody(payload.replace(/_/g, ' '), 'quoted-printable', charset);
      } catch {
        return match;
      }
    },
  );
}
