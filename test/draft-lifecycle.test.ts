import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AppPasswordGmailClient } from '../src/core/app-password-client.js';
import { parseMimeMessage } from '../src/core/parser/imap-message.js';

function compose(options: Record<string, unknown>): string {
  const client = new AppPasswordGmailClient({
    email: 'pam@stejle.dk',
    appPassword: 'not-a-real-password',
  });
  return (client as unknown as {
    composeMime: (o: Record<string, unknown>) => string;
  }).composeMime(options);
}

test('create draft MIME includes attached email and custom headers', () => {
  const rawEmail = [
    'From: Customer <customer@example.com>',
    'To: pam@stejle.dk',
    'Subject: Query about invoice 999',
    'Date: Sun, 15 Feb 2026 09:00:00 +0000',
    'Message-ID: <msg999@customer.com>',
    '',
    'Please find my query regarding invoice 999.',
  ].join('\r\n');

  const mime = compose({
    to: 'colleague@stejle.dk',
    subject: 'Draft for review: Invoice 999 query',
    bodyText: 'Hey, I drafted this reply with the customer email attached.',
    bodyHtml: '<p>Hey, I drafted this reply with the customer email attached.</p>',
    attachedEmails: [
      {
        filename: 'Invoice 999 query.eml',
        rawEml: rawEmail,
      },
    ],
  });

  const parsed = parseMimeMessage(mime);
  assert.equal(parsed.text.trim(), 'Hey, I drafted this reply with the customer email attached.');
  assert.equal(parsed.html.trim(), '<p>Hey, I drafted this reply with the customer email attached.</p>');
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].contentType, 'message/rfc822');
  assert.equal(parsed.attachments[0].filename, 'Invoice 999 query.eml');
});

test('reply draft subject handles Danish and German prefixes without duplication', () => {
  const client = new AppPasswordGmailClient({
    email: 'pam@stejle.dk',
    appPassword: 'not-a-real-password',
  });

  const mime1 = compose({
    to: 'a@b.dk',
    subject: 'SV: Møde i morgen',
    bodyText: 'Tak',
  });
  const parsed1 = parseMimeMessage(mime1);
  assert.ok(parsed1.headers.subject.includes('=?UTF-8?B?'));

  const mime2 = compose({
    to: 'a@b.dk',
    subject: 'VS: Videresendt sag',
    bodyText: 'Noteret',
  });
  const parsed2 = parseMimeMessage(mime2);
  assert.ok(parsed2.headers.subject.includes('=?UTF-8?B?'));
});
