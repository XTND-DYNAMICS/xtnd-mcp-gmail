/**
 * RFC 5322 / MIME reader for IMAP FETCH responses.
 *
 * The naive approach — slice at the first blank line and hand the rest back as
 * the body — fails in four separate ways that all corrupt what the caller
 * reads:
 *
 *  - the IMAP response wrapper (`* 5 FETCH (BODY[] {2048}` … `)` … `OK`) ends
 *    up inside the message,
 *  - folded headers are truncated at the first line, silently dropping every
 *    recipient after the first on a wrapped Cc,
 *  - quoted-printable and base64 bodies are never decoded, so `æ` reads as
 *    `=C3=A6`,
 *  - multipart messages return the raw MIME soup rather than the text part.
 *
 * This module addresses all four so callers get the message the sender wrote.
 */

export interface ParsedMimeMessage {
  headers: Record<string, string>;
  text: string;
  html: string;
}

/**
 * Strip the IMAP FETCH wrapper and return the message octets.
 *
 * The `{N}` literal prefix states the exact byte count, which is the only
 * reliable delimiter: a message body can itself contain a line that looks like
 * the closing paren of the response.
 */
export function extractFetchLiteral(response: string): string {
  const literal = response.match(/\{(\d+)\}\r?\n/);
  if (!literal) {
    // No literal: either an empty result or a synthetic response in tests.
    return response;
  }

  const start = literal.index! + literal[0].length;
  const byteCount = parseInt(literal[1], 10);

  // The socket is read with setEncoding('utf8'), so `response` is already
  // decoded text while the literal count is in octets. Measure in UTF-8 bytes
  // and convert back, or a body containing æ would be cut short.
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
  // Continuation lines start with whitespace and belong to the header above.
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  const headers: Record<string, string> = {};

  for (const line of unfolded.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    if (!match) continue;

    const name = match[1].toLowerCase();
    // Duplicate headers (Received, References) keep the first occurrence,
    // which is what address and threading lookups expect.
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
    // Soft line breaks are continuations, not content.
    const joined = body.replace(/=\r?\n/g, '');
    const bytes: number[] = [];

    for (let index = 0; index < joined.length; index += 1) {
      if (joined[index] === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(index + 1, index + 3))) {
        bytes.push(parseInt(joined.slice(index + 1, index + 3), 16));
        index += 2;
        continue;
      }
      // Literal characters are already decoded text, so re-encode them rather
      // than truncating each one to a single byte.
      bytes.push(...Buffer.from(joined[index], 'utf8'));
    }

    return Buffer.from(bytes).toString(toNodeCharset(charset));
  }

  // 7bit, 8bit, binary: the transport already delivered readable text.
  return body;
}

/**
 * Parse a complete message, walking multipart trees to find the text and HTML
 * alternatives. The last non-empty alternative wins, matching how mail clients
 * treat multipart/alternative ordering.
 */
export function parseMimeMessage(raw: string): ParsedMimeMessage {
  const { headers, body } = splitMessage(raw);
  const result: ParsedMimeMessage = { headers, text: '', html: '' };
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

  // A part with a filename is an attachment, not the message text.
  const disposition = headers['content-disposition'] ?? '';
  if (/attachment/i.test(disposition) || parameterOf(disposition, 'filename')) return;

  const decoded = decodeBody(
    body,
    headers['content-transfer-encoding'] ?? '7bit',
    parameterOf(contentType, 'charset') ?? 'utf-8',
  );

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
    // The preamble before the first boundary and the "--" epilogue are not parts.
    if (trimmed.length === 0 || trimmed.startsWith('--')) continue;
    sections.push(trimmed);
  }

  return sections;
}

/** Read a `; name=value` parameter off a structured header value. */
function parameterOf(headerValue: string, name: string): string | undefined {
  const match = headerValue.match(new RegExp(`${name}\\s*=\\s*"([^"]+)"|${name}\\s*=\\s*([^;\\s]+)`, 'i'));
  if (!match) return undefined;
  return (match[1] ?? match[2])?.trim();
}

function toNodeCharset(charset: string): BufferEncoding {
  const normalised = charset.trim().toLowerCase().replace(/^"|"$/g, '');
  if (normalised === 'utf-8' || normalised === 'utf8') return 'utf8';
  if (normalised === 'us-ascii' || normalised === 'ascii') return 'ascii';
  // latin-1 and unknown labels: Node's binary mapping preserves the octets
  // rather than replacing them, which is the least destructive fallback.
  return 'latin1';
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
