import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { composeMimeMessage } from '../src/core/parser/rfc822.js';
import { parseMimeMessage } from '../src/core/parser/imap-message.js';

test('composeMimeMessage with attached emails (message/rfc822)', () => {
  const rawOriginalEml = [
    'From: Alice <alice@example.com>',
    'To: Bob <bob@example.com>',
    'Subject: Previous discussion',
    'Date: Mon, 1 Jan 2026 10:00:00 +0000',
    'Content-Type: text/plain; charset="utf-8"',
    '',
    'Here is the original text.',
  ].join('\r\n');

  const mime = composeMimeMessage(
    {
      to: 'charlie@example.com',
      subject: 'Fwd with attached email',
      bodyText: 'Please review the attached email message.',
      attachedEmails: [
        {
          filename: 'Previous discussion.eml',
          rawEml: rawOriginalEml,
        },
      ],
    },
    'sender@example.com'
  );

  assert.ok(mime.includes('multipart/mixed'));
  assert.ok(mime.includes('Content-Type: message/rfc822'));
  assert.ok(mime.includes('Previous%20discussion.eml') || mime.includes('Previous discussion.eml'));
  assert.ok(mime.includes('Here is the original text.'));

  // Test parsing the composed message back
  const parsed = parseMimeMessage(mime);
  assert.equal(parsed.text.trim(), 'Please review the attached email message.');
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].contentType, 'message/rfc822');
  assert.ok(parsed.attachments[0].filename.includes('Previous discussion.eml'));
});

test('composeMimeMessage with both file attachment and attached email', () => {
  const rawOriginalEml = [
    'From: Support <support@example.com>',
    'To: User <user@example.com>',
    'Subject: Ticket 12345',
    'Date: Tue, 2 Jan 2026 12:00:00 +0000',
    '',
    'Ticket details here.',
  ].join('\r\n');

  const mime = composeMimeMessage(
    {
      to: 'manager@example.com',
      subject: 'Report and Ticket',
      bodyText: 'See attached report and ticket.',
      bodyHtml: '<p>See attached report and ticket.</p>',
      attachments: [
        {
          filename: 'report.pdf',
          contentType: 'application/pdf',
          dataBase64: Buffer.from('%PDF-1.4 test').toString('base64'),
        },
      ],
      attachedEmails: [
        {
          filename: 'Ticket 12345.eml',
          rawEml: rawOriginalEml,
        },
      ],
    },
    'sender@example.com'
  );

  assert.ok(mime.includes('multipart/mixed'));
  assert.ok(mime.includes('multipart/alternative'));
  assert.ok(mime.includes('application/pdf'));
  assert.ok(mime.includes('message/rfc822'));

  const parsed = parseMimeMessage(mime);
  assert.equal(parsed.text.trim(), 'See attached report and ticket.');
  assert.equal(parsed.html.trim(), '<p>See attached report and ticket.</p>');
  assert.equal(parsed.attachments.length, 2);

  const pdfAtt = parsed.attachments.find((a) => a.filename === 'report.pdf');
  assert.ok(pdfAtt);
  assert.equal(pdfAtt.contentType, 'application/pdf');

  const emlAtt = parsed.attachments.find((a) => a.filename === 'Ticket 12345.eml');
  assert.ok(emlAtt);
  assert.equal(emlAtt.contentType, 'message/rfc822');
});

test('parseMimeMessage decodes Danish filenames in attachments', () => {
  const boundary = 'MIXED_BOUNDARY_1';
  const raw = [
    'Content-Type: multipart/mixed; boundary="MIXED_BOUNDARY_1"',
    '',
    '--MIXED_BOUNDARY_1',
    'Content-Type: text/plain; charset="utf-8"',
    '',
    'Mail text',
    '--MIXED_BOUNDARY_1',
    'Content-Type: application/pdf; name*=UTF-8\'\'Regnskab%202026%20%C3%A5rsrapport.pdf',
    'Content-Disposition: attachment; filename*=UTF-8\'\'Regnskab%202026%20%C3%A5rsrapport.pdf',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('PDF test data').toString('base64'),
    '--MIXED_BOUNDARY_1--',
  ].join('\r\n');

  const parsed = parseMimeMessage(raw);
  assert.equal(parsed.text.trim(), 'Mail text');
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].filename, 'Regnskab 2026 årsrapport.pdf');
  assert.equal(parsed.attachments[0].size, 13);
});
