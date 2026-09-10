import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AppPasswordGmailClient,
  extractBareEmail,
  formatAddresses,
  formatQuotedReply,
  mergeCc,
  splitAddressHeader,
} from '../src/core/app-password-client.js';
import { composeMimeMessage, replySubject, forwardSubject } from '../src/core/parser/rfc822.js';
import { parseMimeMessage } from '../src/core/parser/imap-message.js';
import type { EmailDetail } from '../src/types.js';

test('1. Reply threading and subject derivation', () => {
  const originalSubject = 'Project Update Q3';
  const replySubj = replySubject(originalSubject);
  assert.equal(replySubj, 'Re: Project Update Q3');

  // Should not double Re:
  assert.equal(replySubject('Re: Project Update Q3'), 'Re: Project Update Q3');
  assert.equal(replySubject('Sv: Projekt status'), 'Sv: Projekt status');
  assert.equal(replySubject('Aw: Angebot'), 'Aw: Angebot');
});

test('2. Reply to all carries over everyone except the account itself', () => {
  const myEmail = 'pam@stejle.dk';
  const originalTo = splitAddressHeader('"Peter Mølgaard" <pam@stejle.dk>, "Bob Builder" <bob@example.com>');
  const originalCc = splitAddressHeader('"Charlie Chaplin" <charlie@example.com>, <pam@stejle.dk>');
  const recipients = ['alice@example.com']; // Original sender

  const allOriginal = [...originalTo, ...originalCc];
  const toBare = recipients.map(extractBareEmail);
  const myBare = extractBareEmail(myEmail);

  const seen = new Set<string>();
  const ccList: string[] = [];
  for (const item of allOriginal) {
    const bare = extractBareEmail(item.address);
    if (!bare || bare === myBare || toBare.includes(bare) || seen.has(bare)) {
      continue;
    }
    seen.add(bare);
    ccList.push(item.name ? `"${item.name}" <${item.address}>` : item.address);
  }

  assert.deepEqual(ccList, [
    '"Bob Builder" <bob@example.com>',
    '"Charlie Chaplin" <charlie@example.com>',
  ]);
  // Verify pam@stejle.dk was cleanly excluded
  assert.ok(!ccList.some((c) => c.includes('pam@stejle.dk')));
});

test('3. Original message is quoted below reply text and HTML', () => {
  const mockEmail: EmailDetail = {
    id: '100',
    threadId: '100',
    messageId: '<msg100@example.com>',
    from: [{ name: 'Alice Smith', address: 'alice@example.com' }],
    to: [{ address: 'pam@stejle.dk' }],
    subject: 'Meeting tomorrow',
    date: 'Wed, 10 Sep 2026 10:00:00 +0000',
    labelIds: ['INBOX'],
    hasAttachments: false,
    bodyText: 'Can we meet at 2pm?\nLet me know.',
  };

  const reply = formatQuotedReply('Sounds good, see you then.', mockEmail, true);
  assert.ok(reply.bodyText.includes('Sounds good, see you then.'));
  assert.ok(reply.bodyText.includes('On Wed, 10 Sep 2026 10:00:00 +0000, "Alice Smith" <alice@example.com> wrote:'));
  assert.ok(reply.bodyText.includes('> Can we meet at 2pm?'));
  assert.ok(reply.bodyText.includes('> Let me know.'));
});

test('4. Attachment metadata returned without large base64 payload when includeAttachmentData=false', () => {
  const boundary = '====_Mixed_Test_====';
  const rawMime = [
    'From: alice@example.com',
    'To: pam@stejle.dk',
    'Subject: Invoice with large PDF',
    'Date: Wed, 10 Sep 2026 10:00:00 +0000',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'Here is the invoice.',
    '',
    `--${boundary}`,
    'Content-Type: application/pdf',
    'Content-Disposition: attachment; filename="invoice_2026.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjQKJcTl8uXrp/Og0MTGCjQgMCBvYmoKPDw...',
    '',
    `--${boundary}--`,
  ].join('\r\n');

  const parsed = parseMimeMessage(rawMime);
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].filename, 'invoice_2026.pdf');
  assert.equal(parsed.attachments[0].contentType, 'application/pdf');

  const client = new AppPasswordGmailClient({
    email: 'pam@stejle.dk',
    appPassword: 'dummy',
  });

  const emailDetail = (client as any).parseFullMessage(rawMime, '123', false);
  assert.equal(emailDetail.hasAttachments, true);
  assert.equal(emailDetail.attachments.length, 1);
  assert.equal(emailDetail.attachments[0].filename, 'invoice_2026.pdf');
  assert.equal(emailDetail.attachments[0].dataBase64, undefined);

  const withData = (client as any).parseFullMessage(rawMime, '123', true);
  assert.ok(withData.attachments[0].dataBase64.length > 0);
});

test('5. Forward subject and header preservation', () => {
  assert.equal(forwardSubject('Project Specs'), 'Fwd: Project Specs');
  assert.equal(forwardSubject('Fwd: Project Specs'), 'Fwd: Project Specs');
  assert.equal(forwardSubject('FW: Project Specs'), 'FW: Project Specs');
});
