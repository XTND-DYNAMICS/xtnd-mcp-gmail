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
  EmailAddress,
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
    const recipients = toList.map((r) => r.trim()).filter(Boolean);
    for (const r of recipients) {
      const cleanTo = extractBareEmail(r) || r;
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

export function extractBareEmail(input: string): string {
  if (!input) return '';
  const match = input.match(/<([^>]+)>/);
  return (match ? match[1] : input).trim().toLowerCase();
}

export function formatAddresses(addresses: EmailAddress[]): string {
  return (addresses || []).map((a) => (a.name ? `"${a.name}" <${a.address}>` : a.address)).join(', ');
}

export function splitAddressHeader(value: string): EmailAddress[] {
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
    .map((raw) => {
      const nameMatch = raw.match(/^"?([^"<]+)"?\s*<([^>]+)>$/);
      if (nameMatch) {
        return { name: nameMatch[1].trim(), address: nameMatch[2].trim() };
      }
      const angleMatch = raw.match(/<([^>]+)>/);
      if (angleMatch) {
        return { address: angleMatch[1].trim() };
      }
      return { address: raw };
    });
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
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.json': 'application/json',
    '.zip': 'application/zip',
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

export function mergeCc(derived: string | undefined, additional: string | undefined): string | undefined {
  const entries = [
    ...(derived ? derived.split(',') : []),
    ...(additional ? additional.split(',') : []),
  ].map((entry) => entry.trim()).filter((entry) => entry.length > 0);

  const seen = new Set<string>();
  const unique: string[] = [];

  for (const entry of entries) {
    const bare = extractBareEmail(entry);
    if (!bare || seen.has(bare)) continue;
    seen.add(bare);
    unique.push(entry);
  }

  return unique.length > 0 ? unique.join(', ') : undefined;
}

export function formatQuotedReply(
  userText: string,
  original: EmailDetail,
  quoteOriginal = true,
  userHtml?: string
): { bodyText: string; bodyHtml?: string } {
  if (!quoteOriginal) {
    return { bodyText: userText, bodyHtml: userHtml };
  }

  if (/^on\s.+wrote:\s*$/im.test(userText) || userText.includes('---------- Forwarded message ---------')) {
    return { bodyText: userText, bodyHtml: userHtml };
  }

  const senderName = original.from.map((f) => (f.name ? `"${f.name}" <${f.address}>` : f.address)).join(', ') || 'Sender';
  const dateStr = original.date || new Date().toUTCString();
  const attribution = `On ${dateStr}, ${senderName} wrote:`;

  const origText = original.bodyText || original.bodyMarkdown || '';
  const quotedLines = origText.split('\n').map((line) => `> ${line}`).join('\n');
  const bodyText = `${userText.trim()}\n\n${attribution}\n${quotedLines}`;

  let bodyHtml: string | undefined;
  if (userHtml || original.bodyHtml) {
    const userPart = userHtml || userText.replace(/\n/g, '<br>');
    const origPart = original.bodyHtml || origText.replace(/\n/g, '<br>');
    const attrHtml = attribution.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    bodyHtml = `<div>${userPart}</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${attrHtml}<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${origPart}</blockquote></div>`;
  }

  return { bodyText, bodyHtml };
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

    if (flag === '\\Drafts') return '[Gmail]/Drafts';
    if (flag === '\\Trash') return '[Gmail]/Trash';
    if (flag === '\\All') return '[Gmail]/All Mail';
    if (flag === '\\Sent') return '[Gmail]/Sent Mail';
    return 'INBOX';
  }

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

      if (options.query) {
        try {
          const rawQuery = options.unreadOnly ? `is:unread ${options.query}` : options.query;
          const resp = await imap.sendCommand(`UID SEARCH X-GM-RAW "${rawQuery.replace(/"/g, '\\"')}"`);
          const searchLine = resp.split('\r\n').find((l) => l.startsWith('* SEARCH')) || '';
          uids = searchLine.replace('* SEARCH', '').trim().split(/\s+/).filter(Boolean).map(Number);
        } catch {}
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
            `UID FETCH ${uid} (UID X-GM-THRID X-GM-MSGID X-GM-LABELS FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO CC BCC SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES CONTENT-TYPE)])`
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

  async getEmailContent(folder: string, uid: number, includeAttachmentData = false): Promise<EmailDetail> {
    const imap = await this.getImap();
    try {
      await imap.select(folder);
      const resp = await imap.sendCommand(
        `UID FETCH ${uid} (UID X-GM-THRID X-GM-MSGID X-GM-LABELS FLAGS BODY.PEEK[])`
      );
      return this.parseFullMessage(resp, String(uid), includeAttachmentData);
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
    const email = await this.getEmailContent(folder, uid, true);
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

  async getEmailThread(folder: string, idOrThreadId: string, includeAttachmentData = false): Promise<GmailThread> {
    const imap = await this.getImap();
    try {
      await imap.select(folder);
      let uids: number[] = [];

      try {
        const resp = await imap.sendCommand(`UID SEARCH X-GM-THRID ${idOrThreadId}`);
        const searchLine = resp.split('\r\n').find((l) => l.startsWith('* SEARCH')) || '';
        uids = searchLine.replace('* SEARCH', '').trim().split(/\s+/).filter(Boolean).map(Number);
      } catch {}

      if (uids.length === 0) {
        const uidNum = parseInt(idOrThreadId, 10);
        if (!isNaN(uidNum)) {
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
          messages.push(this.parseFullMessage(resp, String(uid), includeAttachmentData));
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

  async listDrafts(limit = 20, includeAttachmentData = false): Promise<{ count: number; drafts: GmailDraft[] }> {
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
            `UID FETCH ${uid} (UID X-GM-THRID X-GM-MSGID X-GM-LABELS FLAGS BODY.PEEK[])`
          );
          const message = this.parseFullMessage(fetchResp, String(uid), includeAttachmentData);
          drafts.push({
            id: String(uid),
            message,
          });
        } catch {}
      }

      return { count: drafts.length, drafts };
    } finally {
      await imap.close();
    }
  }

  async getDraft(draftId: string, includeAttachmentData = false): Promise<GmailDraft> {
    const imap = await this.getImap();
    try {
      const draftsFolder = await this.resolveSpecialFolder(imap, '\\Drafts');
      await imap.select(draftsFolder);
      const uid = parseInt(draftId, 10);
      const resp = await imap.sendCommand(`UID FETCH ${isNaN(uid) ? 1 : uid} (UID X-GM-THRID X-GM-MSGID X-GM-LABELS FLAGS BODY.PEEK[])`);
      const message = this.parseFullMessage(resp, draftId, includeAttachmentData);
      return { id: draftId, message };
    } finally {
      await imap.close();
    }
  }

  async createDraft(options: CreateDraftOptions): Promise<{ success: boolean; created: boolean; folder: string; draftId: string; subject: string }> {
    const imap = await this.getImap();
    try {
      const folder = await this.resolveSpecialFolder(imap, '\\Drafts');

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
        inReplyTo: options.inReplyTo,
        references: options.references,
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
    quoteOriginal = true,
  ): Promise<{ success: boolean; created: boolean; folder: string; draftId: string; to: string; cc?: string; subject: string; inReplyTo: string; references: string; threadId?: string }> {
    const envelope = await this.buildReplyEnvelope(folder, uid, replyAll);
    const cc = mergeCc(envelope.cc, additionalCc);
    const quoted = formatQuotedReply(bodyText, envelope.original, quoteOriginal, bodyHtml);

    const result = await this.createDraft({
      to: envelope.to,
      cc,
      subject: envelope.subject,
      bodyText: quoted.bodyText,
      bodyHtml: quoted.bodyHtml,
      inReplyTo: envelope.inReplyTo,
      references: envelope.references,
      threadId: envelope.threadId,
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
      inReplyTo: envelope.inReplyTo,
      references: envelope.references,
      threadId: envelope.threadId,
    };
  }

  async createForwardDraft(
    folder: string,
    uid: number,
    to: string,
    comment?: string,
    bodyHtml?: string,
    attachments?: (string | OutboundAttachment)[],
    attachAsEml = false,
  ): Promise<{ success: boolean; created: boolean; draftId: string; folder: string; to: string; subject: string }> {
    const original = await this.getEmailContent(folder, uid, true);
    const subject = /^\s*(fwd|fw|viderestil|vs)\s*:/i.test(original.subject)
      ? original.subject
      : `Fwd: ${original.subject}`;

    if (attachAsEml) {
      const rawResult = await this.getRawEmail(folder, uid);
      const draft = await this.createDraft({
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
      return { success: true, created: true, draftId: draft.draftId, folder: draft.folder, to, subject };
    }

    const origAttachments: OutboundAttachment[] = (original.attachments || [])
      .filter((a) => a.dataBase64)
      .map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        dataBase64: a.dataBase64,
      }));

    const mergedAttachments = [...origAttachments, ...(attachments || [])];

    const fromFormatted = original.from.map((f) => (f.name ? `"${f.name}" <${f.address}>` : f.address)).join(', ');
    const toFormatted = original.to.map((t) => (t.name ? `"${t.name}" <${t.address}>` : t.address)).join(', ');
    const ccFormatted = original.cc?.length
      ? original.cc.map((c) => (c.name ? `"${c.name}" <${c.address}>` : c.address)).join(', ')
      : undefined;

    const forwardedHeaderText = [
      '---------- Forwarded message ---------',
      `From: ${fromFormatted}`,
      `Date: ${original.date}`,
      `Subject: ${original.subject}`,
      `To: ${toFormatted}`,
      ...(ccFormatted ? [`Cc: ${ccFormatted}`] : []),
      '',
    ].join('\n');

    const bodyText = `${comment ? comment.trim() + '\n\n' : ''}${forwardedHeaderText}${original.bodyText || original.bodyMarkdown || ''}`;

    let forwardHtml: string | undefined;
    if (bodyHtml || original.bodyHtml) {
      const commentHtml = comment ? `<div>${comment.replace(/\n/g, '<br>')}</div><br>` : '';
      const origHtml = original.bodyHtml || (original.bodyText || '').replace(/\n/g, '<br>');
      forwardHtml = `${commentHtml}<div class="gmail_quote"><div dir="ltr" class="gmail_attr">${forwardedHeaderText.replace(/\n/g, '<br>')}<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${origHtml}</blockquote></div>`;
    }

    const draft = await this.createDraft({
      to,
      subject,
      bodyText,
      bodyHtml: forwardHtml,
      attachments: mergedAttachments,
    });

    return { success: true, created: true, draftId: draft.draftId, folder: draft.folder, to, subject };
  }

  async updateDraft(
    draftId: string,
    options: Partial<CreateDraftOptions>
  ): Promise<{ success: boolean; updated: boolean; draftId: string; subject: string; to: string; cc?: string; hasAttachments: boolean }> {
    const existing = await this.getDraft(draftId, true);
    const existingMsg = existing.message;

    const to = options.to !== undefined
      ? (Array.isArray(options.to) ? options.to.join(', ') : options.to)
      : existingMsg.to.map((a) => (a.name ? `"${a.name}" <${a.address}>` : a.address)).join(', ');

    const cc = options.cc !== undefined
      ? (Array.isArray(options.cc) ? options.cc.join(', ') : options.cc)
      : (existingMsg.cc?.length ? existingMsg.cc.map((a) => (a.name ? `"${a.name}" <${a.address}>` : a.address)).join(', ') : undefined);

    const bcc = options.bcc !== undefined
      ? (Array.isArray(options.bcc) ? options.bcc.join(', ') : options.bcc)
      : (existingMsg.bcc?.length ? existingMsg.bcc.map((a) => (a.name ? `"${a.name}" <${a.address}>` : a.address)).join(', ') : undefined);

    const subject = options.subject !== undefined ? options.subject : existingMsg.subject;
    const bodyText = options.bodyText !== undefined ? options.bodyText : (existingMsg.bodyText || existingMsg.bodyMarkdown || '');
    const bodyHtml = options.bodyHtml !== undefined ? options.bodyHtml : existingMsg.bodyHtml;
    const inReplyTo = options.inReplyTo !== undefined ? options.inReplyTo : existingMsg.inReplyTo;
    const references = options.references !== undefined ? options.references : existingMsg.references;
    const threadId = options.threadId !== undefined ? options.threadId : existingMsg.threadId;

    let attachments: (string | OutboundAttachment)[] | undefined = options.attachments;
    if (attachments === undefined && existingMsg.attachments?.length) {
      attachments = existingMsg.attachments
        .filter((a) => a.dataBase64)
        .map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          dataBase64: a.dataBase64,
        }));
    }

    const created = await this.createDraft({
      to,
      cc,
      bcc,
      subject,
      bodyText,
      bodyHtml,
      inReplyTo,
      references,
      threadId,
      attachments,
      attachEmailUids: options.attachEmailUids,
      attachedEmails: options.attachedEmails,
    });

    try {
      await this.deleteDraft(draftId);
    } catch {}

    return {
      success: true,
      updated: true,
      draftId: created.draftId,
      subject,
      to,
      cc,
      hasAttachments: (attachments?.length ?? 0) > 0,
    };
  }

  async sendDraft(draftId: string): Promise<{ success: boolean; sent: boolean; draftId: string; messageId: string }> {
    const draft = await this.getDraft(draftId, true);
    const msg = draft.message;
    const to = msg.to.map((a) => a.address);
    const cc = msg.cc?.map((a) => a.address);
    const bcc = msg.bcc?.map((a) => a.address);

    const attachments: OutboundAttachment[] = (msg.attachments || [])
      .filter((a) => a.dataBase64)
      .map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        dataBase64: a.dataBase64,
      }));

    const sent = await this.sendEmail({
      to,
      cc,
      bcc,
      subject: msg.subject,
      bodyText: msg.bodyText || msg.bodyMarkdown || '',
      bodyHtml: msg.bodyHtml,
      inReplyTo: msg.inReplyTo,
      references: msg.references,
      threadId: msg.threadId,
      attachments,
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

  async sendEmail(options: SendEmailOptions): Promise<{ success: boolean; messageId: string }> {
    const smtp = new SmtpConnection(this.smtpHost, this.smtpPort);
    await smtp.connect();
    try {
      await smtp.authenticate(this.email, this.appPassword);

      const toList = Array.isArray(options.to) ? options.to : [options.to];
      const ccList = options.cc ? (Array.isArray(options.cc) ? options.cc : [options.cc]) : [];
      const bccList = options.bcc ? (Array.isArray(options.bcc) ? options.bcc : [options.bcc]) : [];

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
    quoteOriginal = true,
  ): Promise<{ success: boolean; messageId: string; to: string; cc?: string; subject: string; threadId?: string }> {
    const envelope = await this.buildReplyEnvelope(folder, uid, replyAll);
    const cc = mergeCc(envelope.cc, additionalCc);
    const quoted = formatQuotedReply(bodyText, envelope.original, quoteOriginal, bodyHtml);

    const sent = await this.sendEmail({
      to: envelope.to,
      cc,
      subject: envelope.subject,
      bodyText: quoted.bodyText,
      bodyHtml: quoted.bodyHtml,
      inReplyTo: envelope.inReplyTo,
      references: envelope.references,
      threadId: envelope.threadId,
      attachments,
      attachEmailUids,
    });

    return {
      success: sent.success,
      messageId: sent.messageId,
      to: envelope.to,
      cc,
      subject: envelope.subject,
      threadId: envelope.threadId,
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
  ): Promise<{ success: boolean; messageId: string; subject: string }> {
    const original = await this.getEmailContent(folder, uid, true);
    const subject = /^\s*(fwd|fw|viderestil|vs)\s*:/i.test(original.subject)
      ? original.subject
      : `Fwd: ${original.subject}`;

    if (attachAsEml) {
      const rawResult = await this.getRawEmail(folder, uid);
      const sent = await this.sendEmail({
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
      return { success: true, messageId: sent.messageId, subject };
    }

    const origAttachments: OutboundAttachment[] = (original.attachments || [])
      .filter((a) => a.dataBase64)
      .map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        dataBase64: a.dataBase64,
      }));

    const mergedAttachments = [...origAttachments, ...(attachments || [])];

    const fromFormatted = original.from.map((f) => (f.name ? `"${f.name}" <${f.address}>` : f.address)).join(', ');
    const toFormatted = original.to.map((t) => (t.name ? `"${t.name}" <${t.address}>` : t.address)).join(', ');
    const ccFormatted = original.cc?.length
      ? original.cc.map((c) => (c.name ? `"${c.name}" <${c.address}>` : c.address)).join(', ')
      : undefined;

    const forwardedHeaderText = [
      '---------- Forwarded message ---------',
      `From: ${fromFormatted}`,
      `Date: ${original.date}`,
      `Subject: ${original.subject}`,
      `To: ${toFormatted}`,
      ...(ccFormatted ? [`Cc: ${ccFormatted}`] : []),
      '',
    ].join('\n');

    const bodyText = `${comment ? comment.trim() + '\n\n' : ''}${forwardedHeaderText}${original.bodyText || original.bodyMarkdown || ''}`;

    let forwardHtml: string | undefined;
    if (bodyHtml || original.bodyHtml) {
      const commentHtml = comment ? `<div>${comment.replace(/\n/g, '<br>')}</div><br>` : '';
      const origHtml = original.bodyHtml || (original.bodyText || '').replace(/\n/g, '<br>');
      forwardHtml = `${commentHtml}<div class="gmail_quote"><div dir="ltr" class="gmail_attr">${forwardedHeaderText.replace(/\n/g, '<br>')}<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${origHtml}</blockquote></div>`;
    }

    const sent = await this.sendEmail({
      to,
      subject,
      bodyText,
      bodyHtml: forwardHtml,
      attachments: mergedAttachments,
    });

    return { success: true, messageId: sent.messageId, subject };
  }

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
  ): Promise<{ to: string; cc?: string; subject: string; inReplyTo: string; references: string; threadId?: string; original: EmailDetail }> {
    const original = await this.getEmailContent(folder, uid, true);

    const toRecipients = (original.replyTo?.length ? original.replyTo : original.from)
      .map((entry) => (entry.name ? `"${entry.name}" <${entry.address}>` : entry.address))
      .filter(Boolean);

    const toBareEmails = (original.replyTo?.length ? original.replyTo : original.from)
      .map((entry) => extractBareEmail(entry.address));

    const myBareEmail = extractBareEmail(this.email);

    let ccList: string[] = [];
    if (replyAll) {
      const allOriginal = [...(original.to ?? []), ...(original.cc ?? [])];
      const seen = new Set<string>();
      for (const item of allOriginal) {
        const bare = extractBareEmail(item.address);
        if (!bare || bare === myBareEmail || toBareEmails.includes(bare) || seen.has(bare)) {
          continue;
        }
        seen.add(bare);
        ccList.push(item.name ? `"${item.name}" <${item.address}>` : item.address);
      }
    }

    const references = [original.references, original.messageId]
      .filter((entry): entry is string => Boolean(entry && entry.trim()))
      .join(' ')
      .trim();

    return {
      to: toRecipients.join(', '),
      cc: ccList.length > 0 ? ccList.join(', ') : undefined,
      subject: /^\s*(re|sv|vs|aw|antw|ref|odp|r)\s*:/i.test(original.subject)
        ? original.subject
        : `Re: ${original.subject}`,
      inReplyTo: original.messageId,
      references,
      threadId: original.threadId,
      original,
    };
  }

  private envelopeFromHeaders(headers: Record<string, string>, id: string, fetchLine = ''): EmailHeaderSummary {
    const header = (name: string) => decodeEncodedWords(headers[name] ?? '');

    const cc = header('cc');
    const bcc = header('bcc');
    const replyTo = header('reply-to');
    const references = headers.references ?? '';
    const inReplyTo = headers['in-reply-to'] ?? '';
    const contentType = headers['content-type'] ?? '';

    const thridMatch = fetchLine.match(/X-GM-THRID (\d+)/);
    const msgIdMatch = fetchLine.match(/X-GM-MSGID (\d+)/);
    const labelsMatch = fetchLine.match(/X-GM-LABELS \((.*?)\)/);

    const threadId = thridMatch ? thridMatch[1] : id;
    const historyId = msgIdMatch ? msgIdMatch[1] : undefined;
    const labelIds: string[] = labelsMatch
      ? labelsMatch[1].split(' ').map((l) => l.replace(/^"|"$/g, '')).filter(Boolean)
      : [];

    const hasAttachments = /multipart\/mixed/i.test(contentType) || /boundary/i.test(contentType);

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
      hasAttachments,
    };
  }

  private parseEnvelopeHeader(raw: string, id: string): EmailHeaderSummary {
    const firstLine = raw.split('\r\n')[0] || '';
    const literal = extractFetchLiteral(raw);
    return this.envelopeFromHeaders(parseHeaderBlock(literal), id, firstLine);
  }

  private parseFullMessage(raw: string, id: string, includeAttachmentData = false): EmailDetail {
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
      dataBase64: includeAttachmentData ? a.dataBase64 : undefined,
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
