/**
 * Direct TLS (App Password) Engine for @xtnd-dynamics/mcp-gmail
 * Implements high-speed IMAP (imap.gmail.com:993) and SMTP (smtp.gmail.com:465)
 * with full Gmail feature support: drafts lifecycle, attached emails (.eml),
 * file attachments, attachment downloading, X-GM-EXT-1 search & threading,
 * and comprehensive label/triage actions.
 */

import * as tls from 'node:tls';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import {
  AttachedEmail,
  CreateDraftOptions,
  EmailAttachment,
  EmailDetail,
  EmailHeaderSummary,
  GmailAppPasswordCredentials,
  GmailDraft,
  GmailProfile,
  GmailThread,
  MailboxFolder,
  OutboundAttachment,
  SearchOptions,
  SendEmailOptions,
  UpdateDraftOptions,
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
        () => {
          const startTime = Date.now();
          const checkGreeting = () => {
            if (this.buffer.includes('* OK') || this.buffer.includes('* PREAUTH')) {
              resolve();
            } else if (Date.now() - startTime > 10000) {
              resolve(); // Proceed anyway
            } else {
              setTimeout(checkGreeting, 50);
            }
          };
          checkGreeting();
        }
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

  private async readUntilTag(tag: string, timeoutMs = 20000): Promise<string> {
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
    throw new Error(`IMAP timeout waiting for response tag ${tag}. Buffer: ${this.buffer.slice(0, 300)}`);
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

  private async readResponse(expectedCode: string, timeoutMs = 20000): Promise<string> {
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

function base64Body(value: string): string {
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  return encoded.match(/.{1,76}/g)?.join('\r\n') ?? encoded;
}

function base64Bytes(buf: Buffer): string {
  const encoded = buf.toString('base64');
  return encoded.match(/.{1,76}/g)?.join('\r\n') ?? encoded;
}

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

function dispositionFilename(name: string): string {
  const quoted = `filename="${name.replace(/[\\"]/g, '\\$&')}"`;
  if (/^[\x20-\x7e]*$/.test(name)) return quoted;
  return `${quoted}; filename*=UTF-8''${encodeURIComponent(name)}`;
}

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
  public readonly email: string;
  private readonly appPassword: string;
  private readonly imapHost: string;
  private readonly imapPort: number;
  private readonly smtpHost: string;
  private readonly smtpPort: number;
  private specialFolders: Partial<Record<string, string>> = {};

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

  /**
   * Resolve Gmail localized special-use folders by their flag:
   * \Drafts, \Trash, \All, \Sent, \Flagged, \Junk, \Important
   */
  private async resolveSpecialFolder(imap: ImapConnection, flag: string): Promise<string> {
    if (this.specialFolders[flag]) return this.specialFolders[flag]!;

    const resp = await imap.sendCommand('LIST "" "*"');
    for (const line of resp.split('\r\n')) {
      const match = line.match(/\* LIST \((.*?)\) "([^"]+)" "?([^"]+?)"?$/);
      if (match) {
        const flags = match[1].split(' ');
        const folderName = match[3];
        for (const f of flags) {
          if (f.startsWith('\\')) {
            this.specialFolders[f] = folderName;
          }
        }
      }
    }

    if (this.specialFolders[flag]) {
      return this.specialFolders[flag]!;
    }

    // Fallbacks
    if (flag === '\\Drafts') return '[Gmail]/Drafts';
    if (flag === '\\Trash') return '[Gmail]/Trash';
    if (flag === '\\All') return '[Gmail]/All Mail';
    if (flag === '\\Sent') return '[Gmail]/Sent Mail';
    return 'INBOX';
  }

  // ---------------------------------------------------------------- Profile

  async getProfile(): Promise<GmailProfile> {
    const folders = await this.listFolders();
    let totalMessages = 0;
    for (const f of folders) {
      if (f.totalMessages) totalMessages += f.totalMessages;
    }
    return {
      emailAddress: this.email,
      messagesTotal: totalMessages,
      threadsTotal: totalMessages,
      historyId: '1',
    };
  }

  // ---------------------------------------------------------------- Labels / Folders

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
          if (!flags.includes('\\Noselect')) {
            try {
              const statusResp = await imap.sendCommand(`STATUS "${name}" (MESSAGES UNSEEN)`);
              const mMatch = statusResp.match(/MESSAGES (\d+)/);
              const uMatch = statusResp.match(/UNSEEN (\d+)/);
              if (mMatch) totalMessages = parseInt(mMatch[1], 10);
              if (uMatch) unreadMessages = parseInt(uMatch[1], 10);
            } catch {}
          }

          folders.push({ name, delimiter, flags, totalMessages, unreadMessages });
        }
      }
      return folders;
    } finally {
      await imap.close();
    }
  }

  async listLabels() {
    return this.listFolders();
  }

  async createFolder(name: string): Promise<{ success: boolean; folder: string; created: boolean; id: string; name: string }> {
    const imap = await this.getImap();
    try {
      await imap.sendCommand(`CREATE "${name}"`);
      return { success: true, created: true, id: name, name, folder: name };
    } finally {
      await imap.close();
    }
  }

  async renameFolder(oldName: string, newName: string): Promise<{ success: boolean; oldName: string; newName: string; updated: boolean; id: string; name: string }> {
    const imap = await this.getImap();
    try {
      await imap.sendCommand(`RENAME "${oldName}" "${newName}"`);
      return { success: true, updated: true, id: newName, name: newName, oldName, newName };
    } finally {
      await imap.close();
    }
  }

  async deleteFolder(name: string): Promise<{ success: boolean; folder: string; deleted: boolean; labelId: string }> {
    const imap = await this.getImap();
    try {
      await imap.sendCommand(`DELETE "${name}"`);
      return { success: true, deleted: true, labelId: name, folder: name };
    } finally {
      await imap.close();
    }
  }

  // ---------------------------------------------------------------- Search & Read

  async searchEmails(options: {
    folder?: string;
    query?: string;
    from?: string;
    to?: string;
    subject?: string;
    unreadOnly?: boolean;
    starredOnly?: boolean;
    limit?: number;
  }): Promise<{ total: number; emails: EmailHeaderSummary[] }> {
    const imap = await this.getImap();
    try {
      const folder = options.folder || 'INBOX';
      await imap.select(folder);

      let uids: number[] = [];

      // Prefer native Gmail search syntax via X-GM-RAW when query is provided
      if (options.query) {
        try {
          const rawQuery = options.unreadOnly ? `is:unread ${options.query}` : options.query;
          const resp = await imap.sendCommand(`UID SEARCH X-GM-RAW "${rawQuery.replace(/"/g, '\\"')}"`);
          const searchLine = resp.split('\r\n').find((l) => l.startsWith('* SEARCH')) || '';
          uids = searchLine.replace('* SEARCH', '').trim().split(/\s+/).filter(Boolean).map(Number);
        } catch {
          // Fall back to standard IMAP SEARCH
        }
      }

      if (uids.length === 0 && !options.query) {
        const searchTerms: string[] = ['ALL'];
        if (options.unreadOnly) searchTerms.push('UNSEEN');
        if (options.starredOnly) searchTerms.push('FLAGGED');
        if (options.from) searchTerms.push(`FROM "${options.from}"`);
        if (options.to) searchTerms.push(`TO "${options.to}"`);
        if (options.subject) searchTerms.push(`SUBJECT "${options.subject}"`);

        const resp = await imap.sendCommand(`UID SEARCH ${searchTerms.join(' ')}`);
        const searchLine = resp.split('\r\n').find((l) => l.startsWith('* SEARCH')) || '';
        uids = searchLine.replace('* SEARCH', '').trim().split(/\s+/).filter(Boolean).map(Number);
      }

      const limit = options.limit || 20;
      const targetUids = uids.slice(-limit).reverse();

      const emails: EmailHeaderSummary[] = [];
      for (const uid of targetUids) {
        try {
          const fetchResp = await imap.sendCommand(
            `UID FETCH ${uid} (UID X-GM-THRID X-GM-MSGID X-GM-LABELS FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO CC BCC SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES)])`
          );
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
      const resp = await imap.sendCommand(
        `UID FETCH ${uid} (UID X-GM-THRID X-GM-MSGID X-GM-LABELS FLAGS BODY.PEEK[])`
      );
      return this.parseFullMessage(resp, String(uid));
    } finally {
      await imap.close();
    }
  }

  async getRawEmail(folder: string, uid: number, saveToPath?: string): Promise<{ uid: number; raw: string; savedToPath?: string; sizeBytes: number }> {
    const imap = await this.getImap();
    try {
      await imap.select(folder);
      const resp = await imap.sendCommand(`UID FETCH ${uid} (BODY.PEEK[])`);
      const raw = extractFetchLiteral(resp);
      const sizeBytes = Buffer.byteLength(raw, 'utf8');

      if (saveToPath) {
        writeFileSync(saveToPath, raw, 'utf8');
      }

      return { uid, raw, savedToPath: saveToPath, sizeBytes };
    } finally {
      await imap.close();
    }
  }

  async getAttachment(
    folder: string,
    uid: number,
    attachmentIdOrFilename: string,
    saveToPath?: string
  ): Promise<{ filename: string; contentType: string; size: number; dataBase64: string; savedToPath?: string }> {
    const email = await this.getEmailContent(folder, uid);
    const attachments = email.attachments || [];

    const found = attachments.find(
      (a) => a.attachmentId === attachmentIdOrFilename || a.filename.toLowerCase() === attachmentIdOrFilename.toLowerCase()
    ) || attachments[parseInt(attachmentIdOrFilename, 10) - 1];

    if (!found || !found.dataBase64) {
      throw new Error(`Attachment "${attachmentIdOrFilename}" not found on message ${uid}.`);
    }

    if (saveToPath) {
      const buf = Buffer.from(found.dataBase64, 'base64');
      writeFileSync(saveToPath, buf);
    }

    return {
      filename: found.filename,
      contentType: found.contentType,
      size: found.size,
      dataBase64: found.dataBase64,
      savedToPath: saveToPath,
    };
  }

  async getEmailThread(folder: string, idOrThreadId: string): Promise<GmailThread> {
    const imap = await this.getImap();
    try {
      await imap.select(folder);
      let uids: number[] = [];

      // 1. Check if id is an X-GM-THRID
      try {
        const resp = await imap.sendCommand(`UID SEARCH X-GM-THRID ${idOrThreadId}`);
        const searchLine = resp.split('\r\n').find((l) => l.startsWith('* SEARCH')) || '';
        uids = searchLine.replace('* SEARCH', '').trim().split(/\s+/).filter(Boolean).map(Number);
      } catch {}

      // 2. If no messages found, check if it's a direct UID
      if (uids.length === 0) {
        const uidNum = parseInt(idOrThreadId, 10);
        if (!isNaN(uidNum)) {
          // Fetch the message to get its X-GM-THRID
          try {
            const meta = await imap.sendCommand(`UID FETCH ${uidNum} (X-GM-THRID)`);
            const thridMatch = meta.match(/X-GM-THRID (\d+)/);
            if (thridMatch) {
              const thrid = thridMatch[1];
              const resp = await imap.sendCommand(`UID SEARCH X-GM-THRID ${thrid}`);
              const searchLine = resp.split('\r\n').find((l) => l.startsWith('* SEARCH')) || '';
              uids = searchLine.replace('* SEARCH', '').trim().split(/\s+/).filter(Boolean).map(Number);
            }
          } catch {}
          if (uids.length === 0) uids = [uidNum];
        }
      }

      const messages: EmailDetail[] = [];
      for (const uid of uids) {
        try {
          const resp = await imap.sendCommand(`UID FETCH ${uid} (UID X-GM-THRID X-GM-MSGID X-GM-LABELS FLAGS BODY.PEEK[])`);
          messages.push(this.parseFullMessage(resp, String(uid)));
        } catch {}
      }

      return {
        id: idOrThreadId,
        snippet: messages[0]?.snippet,
        messages,
      };
    } finally {
      await imap.close();
    }
  }

  // ---------------------------------------------------------------- Drafts Lifecycle

  async listDrafts(limit = 20): Promise<{ count: number; drafts: GmailDraft[] }> {
    const imap = await this.getImap();
    try {
      const draftsFolder = await this.resolveSpecialFolder(imap, '\\Drafts');
      await imap.select(draftsFolder);

      const resp = await imap.sendCommand('UID SEARCH ALL');
      const searchLine = resp.split('\r\n').find((l) => l.startsWith('* SEARCH')) || '';
      const uids = searchLine.replace('* SEARCH', '').trim().split(/\s+/).filter(Boolean).map(Number).reverse().slice(0, limit);

      const drafts: GmailDraft[] = [];
      for (const uid of uids) {
        try {
          const fetchResp = await imap.sendCommand(
            `UID FETCH ${uid} (UID X-GM-THRID X-GM-MSGID X-GM-LABELS FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO CC BCC SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES)])`
          );
          const header = this.parseEnvelopeHeader(fetchResp, String(uid));
          drafts.push({
            id: String(uid),
            message: {
              ...header,
              attachments: [],
            },
          });
        } catch {}
      }

      return { count: drafts.length, drafts };
    } finally {
      await imap.close();
    }
  }

  async getDraft(draftId: string): Promise<GmailDraft> {
    const imap = await this.getImap();
    try {
      const draftsFolder = await this.resolveSpecialFolder(imap, '\\Drafts');
      await imap.select(draftsFolder);
      const uid = parseInt(draftId, 10);
      const resp = await imap.sendCommand(`UID FETCH ${isNaN(uid) ? 1 : uid} (UID X-GM-THRID X-GM-MSGID X-GM-LABELS FLAGS BODY.PEEK[])`);
      const message = this.parseFullMessage(resp, draftId);
      return { id: draftId, message };
    } finally {
      await imap.close();
    }
  }

  async createDraft(options: CreateDraftOptions): Promise<{ success: boolean; created: boolean; folder: string; draftId: string; subject: string }> {
    const imap = await this.getImap();
    try {
      const folder = await this.resolveSpecialFolder(imap, '\\Drafts');

      // If attachEmailUids are provided, fetch their raw EML and attach them
      const attachedEmails: AttachedEmail[] = [...(options.attachedEmails || [])];
      if (options.attachEmailUids?.length) {
        for (const uid of options.attachEmailUids) {
          try {
            const rawResult = await this.getRawEmail('INBOX', Number(uid));
            const innerHeaders = parseHeaderBlock(rawResult.raw);
            const subject = decodeEncodedWords(innerHeaders.subject || `message-${uid}`);
            attachedEmails.push({
              filename: `${subject.replace(/[/\\?%*:|"<>]/g, '_')}.eml`,
              rawEml: rawResult.raw,
            });
          } catch {}
        }
      }

      const mime = this.composeMime({
        ...options,
        to: options.to ? (Array.isArray(options.to) ? options.to.join(', ') : options.to) : '',
        cc: options.cc ? (Array.isArray(options.cc) ? options.cc.join(', ') : options.cc) : undefined,
        bcc: options.bcc ? (Array.isArray(options.bcc) ? options.bcc.join(', ') : options.bcc) : undefined,
        subject: options.subject || '',
        bodyText: options.bodyText || '',
        bodyHtml: options.bodyHtml,
        attachments: options.attachments,
        attachedEmails,
      });

      const appendResp = await imap.sendCommand(
        `APPEND "${folder}" (\\Draft) {${Buffer.byteLength(mime)}}\r\n${mime}`
      );
      const uidMatch = appendResp.match(/\[APPENDUID \d+ (\d+)\]/i);
      const draftId = uidMatch ? uidMatch[1] : String(Date.now());

      return { success: true, created: true, folder, draftId, subject: options.subject || '' };
    } finally {
      await imap.close();
    }
  }

  async createReplyDraft(
    folder: string,
    uid: number,
    bodyText: string,
    replyAll = false,
    additionalCc?: string,
    bodyHtml?: string,
    attachments?: (string | OutboundAttachment)[],
    attachEmailUids?: (string | number)[],
  ): Promise<{ success: boolean; created: boolean; folder: string; draftId: string; to: string; cc?: string; subject: string }> {
    const envelope = await this.buildReplyEnvelope(folder, uid, replyAll);
    const cc = mergeCc(envelope.cc, additionalCc);
    const result = await this.createDraft({
      ...envelope,
      cc,
      bodyText,
      bodyHtml,
      attachments,
      attachEmailUids,
    });

    return {
      success: result.success,
      created: true,
      folder: result.folder,
      draftId: result.draftId,
      to: envelope.to,
      cc,
      subject: envelope.subject,
    };
  }

  async updateDraft(
    draftId: string,
    options: CreateDraftOptions
  ): Promise<{ success: boolean; updated: boolean; draftId: string; subject: string }> {
    const imap = await this.getImap();
    try {
      const folder = await this.resolveSpecialFolder(imap, '\\Drafts');
      await imap.select(folder);

      // 1. Delete old draft
      const uid = parseInt(draftId, 10);
      if (!isNaN(uid)) {
        try {
          await imap.sendCommand(`UID STORE ${uid} +FLAGS (\\Deleted)`);
          await imap.sendCommand('EXPUNGE');
        } catch {}
      }

      // 2. Append updated draft
      const created = await this.createDraft(options);
      return { success: true, updated: true, draftId: created.draftId, subject: options.subject || '' };
    } finally {
      await imap.close();
    }
  }

  async sendDraft(draftId: string): Promise<{ success: boolean; sent: boolean; draftId: string; messageId: string }> {
    const draft = await this.getDraft(draftId);
    const msg = draft.message;
    const to = msg.to.map((a) => a.address);
    const cc = msg.cc?.map((a) => a.address);
    const bcc = msg.bcc?.map((a) => a.address);

    const sent = await this.sendEmail({
      to,
      cc,
      bcc,
      subject: msg.subject,
      bodyText: msg.bodyText || msg.bodyMarkdown || '',
      bodyHtml: msg.bodyHtml,
      inReplyTo: msg.inReplyTo,
      references: msg.references,
    });

    await this.deleteDraft(draftId);

    return { success: true, sent: true, draftId, messageId: sent.messageId };
  }

  async deleteDraft(draftId: string): Promise<{ success: boolean; deleted: boolean; draftId: string }> {
    const imap = await this.getImap();
    try {
      const folder = await this.resolveSpecialFolder(imap, '\\Drafts');
      await imap.select(folder);
      const uid = parseInt(draftId, 10);
      await imap.sendCommand(`UID STORE ${isNaN(uid) ? 1 : uid} +FLAGS (\\Deleted)`);
      await imap.sendCommand('EXPUNGE');
      return { success: true, deleted: true, draftId };
    } finally {
      await imap.close();
    }
  }

  // ---------------------------------------------------------------- Outbound Sending

  async sendEmail(options: SendEmailOptions): Promise<{ success: boolean; messageId: string }> {
    const smtp = new SmtpConnection(this.smtpHost, this.smtpPort);
    await smtp.connect();
    try {
      await smtp.authenticate(this.email, this.appPassword);

      const toList = Array.isArray(options.to) ? options.to : [options.to];
      const ccList = options.cc ? (Array.isArray(options.cc) ? options.cc : [options.cc]) : [];
      const bccList = options.bcc ? (Array.isArray(options.bcc) ? options.bcc : [options.bcc]) : [];

      // If attachEmailUids are provided, fetch their raw EML and attach them
      const attachedEmails: AttachedEmail[] = [...(options.attachedEmails || [])];
      if (options.attachEmailUids?.length) {
        for (const uid of options.attachEmailUids) {
          try {
            const rawResult = await this.getRawEmail('INBOX', Number(uid));
            const innerHeaders = parseHeaderBlock(rawResult.raw);
            const subject = decodeEncodedWords(innerHeaders.subject || `message-${uid}`);
            attachedEmails.push({
              filename: `${subject.replace(/[/\\?%*:|"<>]/g, '_')}.eml`,
              rawEml: rawResult.raw,
            });
          } catch {}
        }
      }

      const mime = this.composeMime({
        to: toList.join(', '),
        cc: ccList.length > 0 ? ccList.join(', ') : undefined,
        bcc: bccList.length > 0 ? bccList.join(', ') : undefined,
        subject: options.subject,
        bodyText: options.bodyText || '',
        bodyHtml: options.bodyHtml,
        inReplyTo: options.inReplyTo,
        references: options.references,
        attachments: options.attachments,
        attachedEmails,
      });

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
    attachments?: (string | OutboundAttachment)[],
    attachEmailUids?: (string | number)[],
  ): Promise<{ success: boolean; messageId: string; to: string; cc?: string; subject: string }> {
    const envelope = await this.buildReplyEnvelope(folder, uid, replyAll);
    const cc = mergeCc(envelope.cc, additionalCc);
    const sent = await this.sendEmail({
      ...envelope,
      cc,
      bodyText,
      bodyHtml,
      attachments,
      attachEmailUids,
    });

    return {
      success: sent.success,
      messageId: sent.messageId,
      to: envelope.to,
      cc,
      subject: envelope.subject,
    };
  }

  async forwardEmail(
    folder: string,
    uid: number,
    to: string,
    comment?: string,
    bodyHtml?: string,
    attachments?: (string | OutboundAttachment)[],
    attachAsEml = false,
  ): Promise<{ success: boolean; messageId: string }> {
    const original = await this.getEmailContent(folder, uid);
    const subject = original.subject.startsWith('Fwd:') || original.subject.startsWith('Viderestil:') ? original.subject : `Fwd: ${original.subject}`;

    if (attachAsEml) {
      const rawResult = await this.getRawEmail(folder, uid);
      return this.sendEmail({
        to,
        subject,
        bodyText: comment || 'Attached is the forwarded message.',
        bodyHtml,
        attachments,
        attachedEmails: [{
          filename: `${original.subject.replace(/[/\\?%*:|"<>]/g, '_')}.eml`,
          rawEml: rawResult.raw,
        }],
      });
    }

    return this.sendEmail({
      to,
      subject,
      bodyText: `${comment ? comment + '\n\n' : ''}---------- Forwarded message ---------\nFrom: ${original.from.map((f) => f.address).join(', ')}\nDate: ${original.date}\nSubject: ${original.subject}\n\n${original.bodyText || ''}`,
      bodyHtml,
      attachments,
    });
  }

  // ---------------------------------------------------------------- Labels & Triage

  async modifyEmailLabels(folder: string, uids: number[], addLabels: string[] = [], removeLabels: string[] = []): Promise<{ success: boolean; updated: number }> {
    const imap = await this.getImap();
    try {
      await imap.select(folder);
      const uidStr = uids.join(',');

      if (addLabels.length > 0) {
        const labelsArg = addLabels.map((l) => (l.startsWith('\\') ? l : `"${l}"`)).join(' ');
        await imap.sendCommand(`UID STORE ${uidStr} +X-GM-LABELS (${labelsArg})`);
      }
      if (removeLabels.length > 0) {
        const labelsArg = removeLabels.map((l) => (l.startsWith('\\') ? l : `"${l}"`)).join(' ');
        await imap.sendCommand(`UID STORE ${uidStr} -X-GM-LABELS (${labelsArg})`);
      }

      return { success: true, updated: uids.length };
    } finally {
      await imap.close();
    }
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
      await imap.sendCommand(`UID STORE ${uids.join(',')} ${flagMap[action]}`);
      return { success: true, updated: uids.length };
    } finally {
      await imap.close();
    }
  }

  async starEmail(folder: string, uids: number[], star = true): Promise<{ success: boolean; updated: number }> {
    return this.markEmails(folder, uids, star ? 'flag' : 'unflag');
  }

  async archiveEmail(folder: string, uids: number[]): Promise<{ success: boolean; archived: number }> {
    const imap = await this.getImap();
    try {
      await imap.select(folder);
      await imap.sendCommand(`UID STORE ${uids.join(',')} -X-GM-LABELS ("\\\\Inbox")`);
      return { success: true, archived: uids.length };
    } finally {
      await imap.close();
    }
  }

  async moveEmails(sourceFolder: string, targetFolder: string, uids: number[]): Promise<{ success: boolean; moved: number }> {
    const imap = await this.getImap();
    try {
      await imap.select(sourceFolder);
      await imap.sendCommand(`UID MOVE ${uids.join(',')} "${targetFolder}"`);
      return { success: true, moved: uids.length };
    } finally {
      await imap.close();
    }
  }

  async trashEmail(folder: string, uids: number[]): Promise<{ success: boolean; trashed: number }> {
    const imap = await this.getImap();
    try {
      const trashFolder = await this.resolveSpecialFolder(imap, '\\Trash');
      await imap.select(folder);
      try {
        await imap.sendCommand(`UID MOVE ${uids.join(',')} "${trashFolder}"`);
      } catch {
        await imap.sendCommand(`UID STORE ${uids.join(',')} +X-GM-LABELS ("\\\\Trash")`);
      }
      return { success: true, trashed: uids.length };
    } finally {
      await imap.close();
    }
  }

  async untrashEmail(uids: number[]): Promise<{ success: boolean; restored: number }> {
    const imap = await this.getImap();
    try {
      const trashFolder = await this.resolveSpecialFolder(imap, '\\Trash');
      await imap.select(trashFolder);
      await imap.sendCommand(`UID STORE ${uids.join(',')} -X-GM-LABELS ("\\\\Trash") +X-GM-LABELS ("\\\\Inbox")`);
      return { success: true, restored: uids.length };
    } finally {
      await imap.close();
    }
  }

  async deleteEmails(folder: string, uids: number[], permanent = false): Promise<{ success: boolean; deleted: number }> {
    if (!permanent) {
      const res = await this.trashEmail(folder, uids);
      return { success: res.success, deleted: res.trashed };
    }
    return this.deleteEmailsPermanently(folder, uids);
  }

  async deleteEmailsPermanently(folder: string, uids: number[]): Promise<{ success: boolean; deleted: number }> {
    const imap = await this.getImap();
    try {
      await imap.select(folder);
      await imap.sendCommand(`UID STORE ${uids.join(',')} +FLAGS (\\Deleted)`);
      await imap.sendCommand('EXPUNGE');
      return { success: true, deleted: uids.length };
    } finally {
      await imap.close();
    }
  }

  // ---------------------------------------------------------------- MIME Composer

  private composeMime(options: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    bodyText: string;
    bodyHtml?: string;
    inReplyTo?: string;
    references?: string;
    attachments?: (string | OutboundAttachment)[];
    attachedEmails?: AttachedEmail[];
  }): string {
    const subject = `=?UTF-8?B?${Buffer.from(options.subject, 'utf8').toString('base64')}?=`;

    const headers = [
      `From: ${this.email}`,
      ...(options.to ? [`To: ${options.to}`] : []),
      ...(options.cc ? [`Cc: ${options.cc}`] : []),
      ...(options.bcc ? [`Bcc: ${options.bcc}`] : []),
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      ...(options.inReplyTo ? [`In-Reply-To: ${options.inReplyTo}`] : []),
      ...(options.references ? [`References: ${options.references}`] : []),
      'MIME-Version: 1.0',
    ];

    const body = this.composeBodyPart(options.bodyText, options.bodyHtml);

    const attachments = options.attachments || [];
    const attachedEmails = options.attachedEmails || [];
    const hasAttachments = attachments.length > 0 || attachedEmails.length > 0;

    if (!hasAttachments) {
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

    for (const item of attachments) {
      let filename: string;
      let contentType: string;
      let dataBuf: Buffer;

      if (typeof item === 'string') {
        filename = basename(item);
        contentType = mediaTypeFor(filename);
        dataBuf = readFileSync(item);
      } else if (item.filePath) {
        filename = item.filename || basename(item.filePath);
        contentType = item.contentType || mediaTypeFor(filename);
        dataBuf = readFileSync(item.filePath);
      } else {
        filename = item.filename;
        contentType = item.contentType || mediaTypeFor(item.filename);
        dataBuf = Buffer.from(item.dataBase64 || '', 'base64');
      }

      parts.push(
        `--${mixed}`,
        `Content-Type: ${contentType}; name="${filename}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; ${dispositionFilename(filename)}`,
        '',
        base64Bytes(dataBuf),
        '',
      );
    }

    for (let idx = 0; idx < attachedEmails.length; idx++) {
      const email = attachedEmails[idx];
      const filename = email.filename || `attached-email-${idx + 1}.eml`;
      parts.push(
        `--${mixed}`,
        `Content-Type: message/rfc822; name="${filename}"`,
        'Content-Transfer-Encoding: 8bit',
        `Content-Disposition: attachment; ${dispositionFilename(filename)}`,
        '',
        email.rawEml.trim(),
        '',
      );
    }

    parts.push(`--${mixed}--`, '');
    return parts.join('\r\n');
  }

  private composeBodyPart(bodyText: string, bodyHtml?: string): string[] {
    if (!bodyHtml) {
      return [
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        base64Body(bodyText),
      ];
    }

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

  private async buildReplyEnvelope(
    folder: string,
    uid: number,
    replyAll: boolean,
  ): Promise<{ to: string; cc?: string; subject: string; inReplyTo: string; references: string }> {
    const original = await this.getEmailContent(folder, uid);

    const recipients = (original.replyTo?.length ? original.replyTo : original.from)
      .map((entry) => entry.address)
      .filter(Boolean);

    const cc = replyAll
      ? [...(original.to ?? []), ...(original.cc ?? [])]
          .map((entry) => entry.address)
          .filter((address) => address && !address.toLowerCase().includes(this.email.toLowerCase()))
          .filter((address) => !recipients.includes(address))
      : [];

    const references = [original.references, original.messageId]
      .filter((entry): entry is string => Boolean(entry && entry.trim()))
      .join(' ')
      .trim();

    return {
      to: recipients.join(', '),
      cc: cc.length > 0 ? cc.join(', ') : undefined,
      subject: /^\s*(re|sv|vs|aw|antw|ref)\s*:/i.test(original.subject)
        ? original.subject
        : `Re: ${original.subject}`,
      inReplyTo: original.messageId,
      references,
    };
  }

  private envelopeFromHeaders(headers: Record<string, string>, id: string, fetchLine = ''): EmailHeaderSummary {
    const header = (name: string) => decodeEncodedWords(headers[name] ?? '');

    const cc = header('cc');
    const bcc = header('bcc');
    const replyTo = header('reply-to');
    const references = headers.references ?? '';
    const inReplyTo = headers['in-reply-to'] ?? '';

    // Extract X-GM-THRID, X-GM-MSGID, X-GM-LABELS from FETCH line if present
    const thridMatch = fetchLine.match(/X-GM-THRID (\d+)/);
    const msgIdMatch = fetchLine.match(/X-GM-MSGID (\d+)/);
    const labelsMatch = fetchLine.match(/X-GM-LABELS \((.*?)\)/);

    const threadId = thridMatch ? thridMatch[1] : id;
    const historyId = msgIdMatch ? msgIdMatch[1] : undefined;
    const labelIds: string[] = labelsMatch
      ? labelsMatch[1].split(' ').map((l) => l.replace(/^"|"$/g, '')).filter(Boolean)
      : [];

    return {
      id,
      threadId,
      historyId,
      messageId: headers['message-id'] || `<${id}@gmail.com>`,
      from: splitAddressHeader(header('from')),
      to: splitAddressHeader(header('to')),
      ...(cc ? { cc: splitAddressHeader(cc) } : {}),
      ...(bcc ? { bcc: splitAddressHeader(bcc) } : {}),
      ...(replyTo ? { replyTo: splitAddressHeader(replyTo) } : {}),
      ...(references ? { references } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      subject: header('subject'),
      date: header('date'),
      snippet: '',
      labelIds,
      hasAttachments: false,
    };
  }

  private parseEnvelopeHeader(raw: string, id: string): EmailHeaderSummary {
    const firstLine = raw.split('\r\n')[0] || '';
    const literal = extractFetchLiteral(raw);
    return this.envelopeFromHeaders(parseHeaderBlock(literal), id, firstLine);
  }

  private parseFullMessage(raw: string, id: string): EmailDetail {
    const firstLine = raw.split('\r\n')[0] || '';
    const literal = extractFetchLiteral(raw);
    const message = parseMimeMessage(literal);
    const header = this.envelopeFromHeaders(message.headers, id, firstLine);
    const text = message.text || (message.html ? htmlToMarkdown(message.html) : '');

    const attachments: EmailAttachment[] = (message.attachments || []).map((a) => ({
      attachmentId: a.attachmentId,
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
      dataBase64: a.dataBase64,
    }));

    return {
      ...header,
      hasAttachments: attachments.length > 0,
      bodyText: message.text || undefined,
      bodyHtml: message.html || undefined,
      bodyMarkdown: text,
      attachments,
      raw: literal,
    };
  }
}
