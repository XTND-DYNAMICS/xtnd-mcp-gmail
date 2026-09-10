/**
 * Direct TLS (App Password) Engine for @xtnd-dynamics/mcp-gmail
 * Implements high-speed IMAP (imap.gmail.com:993) and SMTP (smtp.gmail.com:465)
 * for zero-setup, permanent Google Workspace & Gmail connectivity.
 */

import * as tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import {
  EmailDetail,
  EmailHeaderSummary,
  GmailAppPasswordCredentials,
  MailboxFolder,
  SearchOptions,
  SendEmailOptions,
} from '../types.js';
import {
  decodeEncodedWords,
  extractFetchLiteral,
  parseHeaderBlock,
  parseMimeMessage,
} from './parser/imap-message.js';
import { htmlToMarkdown } from './parser/markdown.js';

class ImapConnection {
  private socket: tls.TLSSocket | null = null;
  private buffer = '';
  private tagCounter = 1;

  constructor(
    private readonly host: string,
    private readonly port: number
  ) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = tls.connect(
        {
          host: this.host,
          port: this.port,
          servername: this.host,
          rejectUnauthorized: true,
        },
        () => resolve()
      );
      this.socket.setEncoding('utf8');
      this.socket.on('data', (chunk: string) => {
        this.buffer += chunk;
      });
      this.socket.on('error', (err) => reject(err));
    });
  }

  private nextTag(): string {
    return `G${String(this.tagCounter++).padStart(4, '0')}`;
  }

  private async readUntilTag(tag: string, timeoutMs = 15000): Promise<string> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const idx = this.buffer.indexOf(`${tag} `);
      if (idx !== -1) {
        const lineEnd = this.buffer.indexOf('\r\n', idx);
        if (lineEnd !== -1) {
          const result = this.buffer.slice(0, lineEnd + 2);
          this.buffer = this.buffer.slice(lineEnd + 2);
          return result;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`IMAP timeout waiting for response tag ${tag}`);
  }

  async sendCommand(cmd: string): Promise<string> {
    if (!this.socket) throw new Error('IMAP connection not open');
    const tag = this.nextTag();
    const fullCmd = `${tag} ${cmd}\r\n`;
    this.socket.write(fullCmd);
    const response = await this.readUntilTag(tag);
    if (response.includes(`${tag} NO`) || response.includes(`${tag} BAD`)) {
      const line = response.split('\r\n').find((l) => l.startsWith(`${tag} `)) || response;
      throw new Error(`IMAP Error: ${line}`);
    }
    return response;
  }

  async login(user: string, pass: string): Promise<void> {
    await new Promise((r) => setTimeout(r, 300)); // Greeting pause
    this.buffer = '';
    const safePass = pass.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await this.sendCommand(`LOGIN "${user}" "${safePass}"`);
  }

  async select(folder: string): Promise<void> {
    await this.sendCommand(`SELECT "${folder}"`);
  }

  async close(): Promise<void> {
    try {
      if (this.socket) {
        this.socket.end();
        this.socket.destroy();
      }
    } catch {}
    this.socket = null;
  }
}

class SmtpConnection {
  private socket: tls.TLSSocket | null = null;
  private buffer = '';

  constructor(
    private readonly host: string,
    private readonly port: number
  ) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = tls.connect(
        {
          host: this.host,
          port: this.port,
          servername: this.host,
          rejectUnauthorized: true,
        },
        () => resolve()
      );
      this.socket.setEncoding('utf8');
      this.socket.on('data', (chunk: string) => {
        this.buffer += chunk;
      });
      this.socket.on('error', (err) => reject(err));
    });
  }

  private async readResponse(expectedCode: string, timeoutMs = 15000): Promise<string> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const lines = this.buffer.split('\r\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith(expectedCode + ' ') || (line.startsWith(expectedCode) && !line.startsWith(expectedCode + '-'))) {
          const resp = this.buffer;
          this.buffer = '';
          return resp;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`SMTP timeout waiting for code ${expectedCode}. Buffer: ${this.buffer}`);
  }

  async sendCommand(cmd: string, expectedCode: string): Promise<string> {
    if (!this.socket) throw new Error('SMTP connection not open');
    this.socket.write(cmd + '\r\n');
    return this.readResponse(expectedCode);
  }

  async authenticate(user: string, pass: string): Promise<void> {
    await this.readResponse('220');
    await this.sendCommand(`EHLO localhost`, '250');
    await this.sendCommand('AUTH LOGIN', '334');
    await this.sendCommand(Buffer.from(user).toString('base64'), '334');
    await this.sendCommand(Buffer.from(pass).toString('base64'), '235');
  }

  async sendMail(from: string, to: string | string[], rawMime: string): Promise<{ messageId: string }> {
    await this.sendCommand(`MAIL FROM:<${from}>`, '250');
    const toList = Array.isArray(to) ? to : to.split(',');
    const recipients = toList.map((r) => r.trim());
    for (const r of recipients) {
      const cleanTo = r.includes('<') ? r.match(/<([^>]+)>/)?.[1] || r : r;
      await this.sendCommand(`RCPT TO:<${cleanTo}>`, '250');
    }
    await this.sendCommand('DATA', '354');
    if (!this.socket) throw new Error('SMTP connection closed');
    this.socket.write(rawMime + '\r\n.\r\n');
    await this.readResponse('250');
    return { messageId: `<${Date.now()}.${Math.random().toString(36).slice(2)}@gmail.com>` };
  }

  async close(): Promise<void> {
    try {
      if (this.socket) {
        this.socket.write('QUIT\r\n');
        this.socket.end();
        this.socket.destroy();
      }
    } catch {}
    this.socket = null;
  }
}

/**
 * Split an address header into individual addresses.
 *
 * Storing the whole header as one entry looks harmless until reply-all filters
 * out "our own address": a substring match against the blob then discards every
 * other recipient on the line with it.
 *
 * Commas inside a quoted display name do not separate addresses, so the split
 * tracks quoting and angle-bracket depth instead of using String.split.
 */
function splitAddressHeader(value: string): { address: string }[] {
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
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((address) => ({ address }));
}

/** Base64 a UTF-8 body and wrap it to the 76-character MIME line limit. */
function base64Body(value: string): string {
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  return encoded.match(/.{1,76}/g)?.join('\r\n') ?? encoded;
}

function base64Bytes(buf: Buffer): string {
  const encoded = buf.toString('base64');
  return encoded.match(/.{1,76}/g)?.join('\r\n') ?? encoded;
}

/** Content-Type for the few kinds of file that actually get mailed. */
function mediaTypeFor(name: string): string {
  const types: Record<string, string> = {
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.txt': 'text/plain', '.csv': 'text/csv', '.html': 'text/html',
    '.json': 'application/json', '.zip': 'application/zip',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return types[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Filename for Content-Disposition. Plain ASCII goes in quoted form; anything
 * else also gets an RFC 2231 filename* so clients do not mangle the Danish
 * characters a document title is likely to contain.
 */
function dispositionFilename(name: string): string {
  const quoted = `filename="${name.replace(/[\\"]/g, '\\$&')}"`;
  if (/^[\x20-\x7e]*$/.test(name)) return quoted;
  return `${quoted}; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Merge extra Cc addresses into the set derived from the original message,
 * without duplicating anyone already on it. Comparison is on the bare address,
 * so "Britt Siomka <bsi@…>" and "bsi@…" are recognised as the same person.
 */
function mergeCc(derived: string | undefined, additional: string | undefined): string | undefined {
  const entries = [
    ...(derived ? derived.split(',') : []),
    ...(additional ? additional.split(',') : []),
  ].map((entry) => entry.trim()).filter((entry) => entry.length > 0);

  const seen = new Set<string>();
  const unique: string[] = [];

  for (const entry of entries) {
    const bare = (entry.match(/<([^>]+)>/)?.[1] ?? entry).trim().toLowerCase();
    if (seen.has(bare)) continue;
    seen.add(bare);
    unique.push(entry);
  }

  return unique.length > 0 ? unique.join(', ') : undefined;
}

export class AppPasswordGmailClient {
  private readonly email: string;
  private readonly appPassword: string;
  private readonly imapHost: string;
  private readonly imapPort: number;
  private readonly smtpHost: string;
  private readonly smtpPort: number;
  /** Cached \Drafts mailbox name; resolved once per client instance. */
  private draftsFolder?: string;

  constructor(credentials: GmailAppPasswordCredentials) {
    this.email = credentials.email;
    this.appPassword = credentials.appPassword.replace(/\s+/g, '');
    this.imapHost = credentials.imapHost || 'imap.gmail.com';
    this.imapPort = credentials.imapPort || 993;
    this.smtpHost = credentials.smtpHost || 'smtp.gmail.com';
    this.smtpPort = credentials.smtpPort || 465;
  }

  private async getImap(): Promise<ImapConnection> {
    const imap = new ImapConnection(this.imapHost, this.imapPort);
    await imap.connect();
    await imap.login(this.email, this.appPassword);
    return imap;
  }

  async listFolders(): Promise<MailboxFolder[]> {
    const imap = await this.getImap();
    try {
      const resp = await imap.sendCommand('LIST "" "*"');
      const lines = resp.split('\r\n');
      const folders: MailboxFolder[] = [];

      for (const line of lines) {
        const match = line.match(/\* LIST \((.*?)\) "([^"]+)" "?([^"]+)"?/);
        if (match) {
          const flags = match[1].split(' ').filter(Boolean);
          const delimiter = match[2];
          const name = match[3];

          let totalMessages = 0;
          let unreadMessages = 0;
          try {
            const statusResp = await imap.sendCommand(`STATUS "${name}" (MESSAGES UNSEEN)`);
            const mMatch = statusResp.match(/MESSAGES (\d+)/);
            const uMatch = statusResp.match(/UNSEEN (\d+)/);
            if (mMatch) totalMessages = parseInt(mMatch[1], 10);
            if (uMatch) unreadMessages = parseInt(uMatch[1], 10);
          } catch {}

          folders.push({ name, delimiter, flags, totalMessages, unreadMessages });
        }
      }
      return folders;
    } finally {
      await imap.close();
    }
  }

  async createFolder(name: string): Promise<{ success: boolean; folder: string }> {
    const imap = await this.getImap();
    try {
      await imap.sendCommand(`CREATE "${name}"`);
      return { success: true, folder: name };
    } finally {
      await imap.close();
    }
  }

  async renameFolder(oldName: string, newName: string): Promise<{ success: boolean; oldName: string; newName: string }> {
    const imap = await this.getImap();
    try {
      await imap.sendCommand(`RENAME "${oldName}" "${newName}"`);
      return { success: true, oldName, newName };
    } finally {
      await imap.close();
    }
  }

  async deleteFolder(name: string): Promise<{ success: boolean; folder: string }> {
    const imap = await this.getImap();
    try {
      await imap.sendCommand(`DELETE "${name}"`);
      return { success: true, folder: name };
    } finally {
      await imap.close();
    }
  }

  async searchEmails(options: { folder?: string; query?: string; from?: string; to?: string; subject?: string; unreadOnly?: boolean; limit?: number }): Promise<{ total: number; emails: EmailHeaderSummary[] }> {
    const imap = await this.getImap();
    try {
      const folder = options.folder || 'INBOX';
      await imap.select(folder);

      const searchTerms: string[] = ['ALL'];
      if (options.unreadOnly) searchTerms.push('UNSEEN');
      if (options.query) searchTerms.push(`TEXT "${options.query}"`);
      if (options.from) searchTerms.push(`FROM "${options.from}"`);
      if (options.to) searchTerms.push(`TO "${options.to}"`);
      if (options.subject) searchTerms.push(`SUBJECT "${options.subject}"`);

      const resp = await imap.sendCommand(`SEARCH ${searchTerms.join(' ')}`);
      const searchLine = resp.split('\r\n').find((l) => l.startsWith('* SEARCH')) || '';
      const uids = searchLine.replace('* SEARCH', '').trim().split(/\s+/).filter(Boolean).map(Number);

      const limit = options.limit || 20;
      const targetUids = uids.slice(-limit).reverse();

      const emails: EmailHeaderSummary[] = [];
      for (const uid of targetUids) {
        try {
          const fetchResp = await imap.sendCommand(`FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)])`);
          emails.push(this.parseEnvelopeHeader(fetchResp, String(uid)));
        } catch {}
      }

      return { total: uids.length, emails };
    } finally {
      await imap.close();
    }
  }

  async getRecentEmails(folder = 'INBOX', limit = 10): Promise<EmailHeaderSummary[]> {
    return (await this.searchEmails({ folder, limit, unreadOnly: false })).emails;
  }

  async getEmailContent(folder: string, uid: number): Promise<EmailDetail> {
    const imap = await this.getImap();
    try {
      await imap.select(folder);
      const resp = await imap.sendCommand(`FETCH ${uid} (BODY.PEEK[])`);
      return this.parseFullMessage(resp, String(uid));
    } finally {
      await imap.close();
    }
  }

  async getEmailThread(folder: string, uidOrMessageId: string): Promise<{ messageId?: string; count: number; thread: EmailDetail[] }> {
    const uidNum = parseInt(uidOrMessageId, 10);
    const initial = !isNaN(uidNum) ? await this.getEmailContent(folder, uidNum) : null;
    return {
      messageId: initial?.messageId || uidOrMessageId,
      count: initial ? 1 : 0,
      thread: initial ? [initial] : [],
    };
  }

  async markEmails(folder: string, uids: number[], action: 'read' | 'unread' | 'flag' | 'unflag'): Promise<{ success: boolean; updated: number }> {
    const imap = await this.getImap();
    try {
      await imap.select(folder);
      const flagMap = {
        read: '+FLAGS (\\Seen)',
        unread: '-FLAGS (\\Seen)',
        flag: '+FLAGS (\\Flagged)',
        unflag: '-FLAGS (\\Flagged)',
      };
      await imap.sendCommand(`STORE ${uids.join(',')} ${flagMap[action]}`);
      return { success: true, updated: uids.length };
    } finally {
      await imap.close();
    }
  }

  async moveEmails(sourceFolder: string, targetFolder: string, uids: number[]): Promise<{ success: boolean; moved: number }> {
    const imap = await this.getImap();
    try {
      await imap.select(sourceFolder);
      await imap.sendCommand(`MOVE ${uids.join(',')} "${targetFolder}"`);
      return { success: true, moved: uids.length };
    } finally {
      await imap.close();
    }
  }

  async deleteEmails(folder: string, uids: number[], permanent = false): Promise<{ success: boolean; deleted: number }> {
    const imap = await this.getImap();
    try {
      await imap.select(folder);
      if (permanent) {
        await imap.sendCommand(`STORE ${uids.join(',')} +FLAGS (\\Deleted)`);
        await imap.sendCommand('EXPUNGE');
      } else {
        await imap.sendCommand(`MOVE ${uids.join(',')} "[Gmail]/Papirkurv"`);
      }
      return { success: true, deleted: uids.length };
    } finally {
      await imap.close();
    }
  }

  async sendEmail(options: SendEmailOptions): Promise<{ success: boolean; messageId: string }> {
    const smtp = new SmtpConnection(this.smtpHost, this.smtpPort);
    await smtp.connect();
    try {
      await smtp.authenticate(this.email, this.appPassword);

      const toList = Array.isArray(options.to) ? options.to : [options.to];
      const ccList = options.cc ? (Array.isArray(options.cc) ? options.cc : [options.cc]) : [];
      const bccList = options.bcc ? (Array.isArray(options.bcc) ? options.bcc : [options.bcc]) : [];

      const mime = this.composeMime({
        to: toList.join(', '),
        cc: ccList.length > 0 ? ccList.join(', ') : undefined,
        subject: options.subject,
        bodyText: options.bodyText || '',
        bodyHtml: options.bodyHtml,
        inReplyTo: options.inReplyTo,
        references: options.references,
      });

      // Bcc recipients belong in the SMTP envelope, never in the headers.
      const envelopeRecipients = [...toList, ...ccList, ...bccList];
      const result = await smtp.sendMail(this.email, envelopeRecipients, mime);
      return { success: true, messageId: result.messageId };
    } finally {
      await smtp.close();
    }
  }

  async replyEmail(
    folder: string,
    uid: number,
    bodyText: string,
    replyAll = false,
    additionalCc?: string,
    bodyHtml?: string,
  ): Promise<{ success: boolean; messageId: string; to: string; cc?: string; subject: string }> {
    const envelope = await this.buildReplyEnvelope(folder, uid, replyAll);
    const cc = mergeCc(envelope.cc, additionalCc);
    const sent = await this.sendEmail({ ...envelope, cc, bodyText, bodyHtml });

    return {
      success: sent.success,
      messageId: sent.messageId,
      to: envelope.to,
      cc,
      subject: envelope.subject,
    };
  }

  async forwardEmail(folder: string, uid: number, to: string, comment?: string): Promise<{ success: boolean; messageId: string }> {
    const original = await this.getEmailContent(folder, uid);
    const subject = original.subject.startsWith('Fwd:') ? original.subject : `Fwd: ${original.subject}`;
    return this.sendEmail({
      to,
      subject,
      bodyText: `${comment ? comment + '\n\n' : ''}---------- Forwarded message ---------\nFrom: ${original.from.map((f) => f.address).join(', ')}\nSubject: ${original.subject}\n\n${original.bodyText || ''}`,
    });
  }

  /**
   * Locate the mailbox Gmail marks with the \Drafts special-use flag.
   *
   * The display name is localised — "[Gmail]/Udkast" on a Danish account,
   * "[Gmail]/Drafts" on an English one — so hardcoding either silently
   * appends into a folder the user never opens. The flag is stable.
   */
  private async resolveDraftsFolder(imap: ImapConnection): Promise<string> {
    if (this.draftsFolder) return this.draftsFolder;

    const resp = await imap.sendCommand('LIST "" "*"');
    for (const line of resp.split('\r\n')) {
      const match = line.match(/\* LIST \((.*?)\) "([^"]+)" "?([^"]+?)"?$/);
      if (match && match[1].split(' ').includes('\\Drafts')) {
        this.draftsFolder = match[3];
        return this.draftsFolder;
      }
    }

    throw new Error(
      'Could not find the Drafts mailbox: no folder is flagged \\Drafts. '
      + 'Check that IMAP access is enabled for this Gmail account.',
    );
  }

  /**
   * Build an RFC 5322 message.
   *
   * The body is base64 encoded rather than sent as 8-bit: Danish characters in
   * an IMAP APPEND literal are otherwise counted and transmitted inconsistently,
   * which truncates the message. The subject is RFC 2047 encoded for the same
   * reason.
   */
  private composeMime(options: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    bodyText: string;
    bodyHtml?: string;
    inReplyTo?: string;
    references?: string;
    attachments?: string[];
  }): string {
    const subject = `=?UTF-8?B?${Buffer.from(options.subject, 'utf8').toString('base64')}?=`;

    const headers = [
      `From: ${this.email}`,
      `To: ${options.to}`,
      ...(options.cc ? [`Cc: ${options.cc}`] : []),
      ...(options.bcc ? [`Bcc: ${options.bcc}`] : []),
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      ...(options.inReplyTo ? [`In-Reply-To: ${options.inReplyTo}`] : []),
      ...(options.references ? [`References: ${options.references}`] : []),
      'MIME-Version: 1.0',
    ];

    // The body is built first and independently of the envelope, so it can be
    // used on its own or nested inside a multipart/mixed wrapper.
    const body = this.composeBodyPart(options.bodyText, options.bodyHtml);

    if (!options.attachments?.length) {
      return [...headers, ...body, ''].join('\r\n');
    }

    const mixed = `====_Mixed_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}_====`;
    const parts: string[] = [
      ...headers,
      `Content-Type: multipart/mixed; boundary="${mixed}"`,
      '',
      `--${mixed}`,
      ...body,
      '',
    ];

    for (const path of options.attachments) {
      const data = readFileSync(path);
      const name = basename(path);
      parts.push(
        `--${mixed}`,
        `Content-Type: ${mediaTypeFor(name)}; name="${name}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; ${dispositionFilename(name)}`,
        '',
        base64Bytes(data),
        '',
      );
    }

    parts.push(`--${mixed}--`, '');
    return parts.join('\r\n');
  }

  /** The message body: a single text part, or text plus its HTML alternative. */
  private composeBodyPart(bodyText: string, bodyHtml?: string): string[] {
    if (!bodyHtml) {
      return [
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        base64Body(bodyText),
      ];
    }

    // multipart/alternative: mail clients that render HTML show the formatted
    // version, everything else falls back to the plain text. Anything that
    // needs alignment — a table — only survives in the HTML part, because
    // Gmail renders text/plain in a proportional font.
    const boundary = `====_Alt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}_====`;

    return [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(bodyText),
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(bodyHtml),
      '',
      `--${boundary}--`,
    ];
  }

  /**
   * Derive the envelope for a reply from the message being answered, so a
   * drafted reply and a sent reply are addressed and threaded identically.
   */
  private async buildReplyEnvelope(
    folder: string,
    uid: number,
    replyAll: boolean,
  ): Promise<{ to: string; cc?: string; subject: string; inReplyTo: string; references: string }> {
    const original = await this.getEmailContent(folder, uid);

    const recipients = (original.replyTo?.length ? original.replyTo : original.from)
      .map((entry) => entry.address)
      .filter(Boolean);

    // Reply-all keeps the original To and Cc minus our own address, so nobody
    // silently drops off a thread they were already part of.
    const cc = replyAll
      ? [...(original.to ?? []), ...(original.cc ?? [])]
          .map((entry) => entry.address)
          .filter((address) => address && !address.toLowerCase().includes(this.email.toLowerCase()))
          .filter((address) => !recipients.includes(address))
      : [];

    // Gmail threads on References, so the reply must carry the whole chain.
    const references = [original.references, original.messageId]
      .filter((entry): entry is string => Boolean(entry && entry.trim()))
      .join(' ')
      .trim();

    return {
      to: recipients.join(', '),
      cc: cc.length > 0 ? cc.join(', ') : undefined,
      // Danish and German clients prefix with SV:/VS:/AW: rather than Re:.
      // Without recognising those, a reply to a Danish thread reads "Re: SV:".
      subject: /^\s*(re|sv|vs|aw|antw|ref)\s*:/i.test(original.subject)
        ? original.subject
        : `Re: ${original.subject}`,
      inReplyTo: original.messageId,
      references,
    };
  }

  async createDraft(options: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    bodyText: string;
    bodyHtml?: string;
    inReplyTo?: string;
    references?: string;
    attachments?: string[];
  }): Promise<{ success: boolean; folder: string }> {
    const imap = await this.getImap();
    try {
      const folder = await this.resolveDraftsFolder(imap);
      const mime = this.composeMime(options);

      await imap.sendCommand(
        `APPEND "${folder}" (\\Draft) {${Buffer.byteLength(mime)}}\r\n${mime}`,
      );
      return { success: true, folder };
    } finally {
      await imap.close();
    }
  }

  /**
   * Save a reply to Drafts instead of sending it, correctly threaded and
   * addressed. This is the path to prefer whenever a human should read the
   * message before it reaches the recipient.
   */
  async createReplyDraft(
    folder: string,
    uid: number,
    bodyText: string,
    replyAll = false,
    additionalCc?: string,
    bodyHtml?: string,
    attachments?: string[],
  ): Promise<{ success: boolean; folder: string; to: string; cc?: string; subject: string }> {
    const envelope = await this.buildReplyEnvelope(folder, uid, replyAll);
    const cc = mergeCc(envelope.cc, additionalCc);
    const result = await this.createDraft({ ...envelope, cc, bodyText, bodyHtml, attachments });

    return {
      success: result.success,
      folder: result.folder,
      to: envelope.to,
      cc,
      subject: envelope.subject,
    };
  }

  /**
   * Build the envelope summary from an already-parsed header map.
   *
   * Header names arrive lowercased and unfolded, and encoded-words are decoded
   * here so callers see "Anders Rähr" rather than "=?utf-8?B?QW5kZXJz…?=".
   */
  private envelopeFromHeaders(headers: Record<string, string>, id: string): EmailHeaderSummary {
    const header = (name: string) => decodeEncodedWords(headers[name] ?? '');

    const cc = header('cc');
    const replyTo = header('reply-to');
    const references = headers.references ?? '';
    const inReplyTo = headers['in-reply-to'] ?? '';

    return {
      id,
      threadId: id,
      messageId: headers['message-id'] || `<${id}@gmail.com>`,
      from: splitAddressHeader(header('from')),
      to: splitAddressHeader(header('to')),
      // Threading and Cc are what a reply needs to stay in the conversation
      // and keep everyone who was already on it.
      ...(cc ? { cc: splitAddressHeader(cc) } : {}),
      ...(replyTo ? { replyTo: splitAddressHeader(replyTo) } : {}),
      ...(references ? { references } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      subject: header('subject'),
      date: header('date'),
      snippet: '',
      labelIds: [],
      hasAttachments: false,
    };
  }

  private parseEnvelopeHeader(raw: string, id: string): EmailHeaderSummary {
    return this.envelopeFromHeaders(parseHeaderBlock(extractFetchLiteral(raw)), id);
  }

  private parseFullMessage(raw: string, id: string): EmailDetail {
    // Strip the IMAP FETCH wrapper first: without it the response terminator
    // ends up appended to the message body.
    const message = parseMimeMessage(extractFetchLiteral(raw));
    const header = this.envelopeFromHeaders(message.headers, id);
    const text = message.text || (message.html ? htmlToMarkdown(message.html) : '');

    return {
      ...header,
      bodyText: message.text || undefined,
      bodyHtml: message.html || undefined,
      bodyMarkdown: text,
      attachments: [],
    };
  }
}
