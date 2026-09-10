import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AppPasswordGmailClient } from '../src/core/app-password-client.js';
import { parseMimeMessage } from '../src/core/parser/imap-message.js';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

/** composeMime is private; exercise it through a narrow cast rather than exporting it. */
function compose(options: Record<string, unknown>): string {
  const client = new AppPasswordGmailClient({
    email: 'pam@stejle.dk',
    appPassword: 'not-a-real-password',
  });
  return (client as unknown as {
    composeMime: (o: Record<string, unknown>) => string;
  }).composeMime(options);
}

test('a text-only message stays a single text/plain part', () => {
  const mime = compose({ to: 'a@b.dk', subject: 'Hej', bodyText: 'Goddag' });
  const parsed = parseMimeMessage(mime);

  assert.equal(parsed.text.trim(), 'Goddag');
  assert.equal(parsed.html, '');
  assert.ok(parsed.headers['content-type'].startsWith('text/plain'));
});

test('supplying bodyHtml produces multipart/alternative with both parts', () => {
  const mime = compose({
    to: 'mbo@atriumcph.com',
    cc: 'jjuul@stejle.dk',
    subject: 'SV: Webordre',
    bodyText: 'Ordrenummer: TEST-1\nPris: 6.950,00 kr.',
    bodyHtml: '<p>Ordre</p><table><tr><td>Pris</td><td>6.950,00 kr.</td></tr></table>',
  });
  const parsed = parseMimeMessage(mime);

  assert.ok(parsed.headers['content-type'].startsWith('multipart/alternative'));
  assert.ok(parsed.text.includes('6.950,00 kr.'), 'plain text fallback missing');
  assert.ok(parsed.html.includes('<table>'), 'html part missing');
  assert.equal(parsed.headers.cc, 'jjuul@stejle.dk');
});

test('Danish characters survive the round trip in both parts', () => {
  const mime = compose({
    to: 'a@b.dk',
    subject: 'Ændring på ordre',
    bodyText: 'Beløbet er reserveret hos Nets — København Ø',
    bodyHtml: '<p>Beløbet er reserveret hos Nets — København Ø</p>',
  });
  const parsed = parseMimeMessage(mime);

  assert.ok(parsed.text.includes('Beløbet er reserveret hos Nets — København Ø'));
  assert.ok(parsed.html.includes('København Ø'));
  // The subject is RFC 2047 encoded on the wire, so it must not appear raw.
  assert.ok(parsed.headers.subject.startsWith('=?UTF-8?B?'));
});

test('threading headers are emitted when supplied', () => {
  const mime = compose({
    to: 'a@b.dk',
    subject: 'Re: Sag',
    bodyText: 'Svar',
    inReplyTo: '<parent@example.com>',
    references: '<root@example.com> <parent@example.com>',
  });
  const parsed = parseMimeMessage(mime);

  assert.equal(parsed.headers['in-reply-to'], '<parent@example.com>');
  assert.equal(parsed.headers.references, '<root@example.com> <parent@example.com>');
});

test('attachments wrap the body in multipart/mixed and carry the file', () => {
  const file = join(tmpdir(), `js-test-${Date.now()}.pdf`);
  writeFileSync(file, Buffer.from('%PDF-1.4\nhej æøå\n', 'utf8'));

  try {
    const mime = compose({
      to: 'mbo@atriumcph.com',
      subject: 'Statusnotat',
      bodyText: 'Rapporten er vedhæftet.',
      bodyHtml: '<p>Rapporten er vedhæftet.</p>',
      attachments: [file],
    });

    assert.ok(mime.includes('Content-Type: multipart/mixed'), 'missing mixed wrapper');
    // The text/html alternative must survive nested inside the mixed part.
    assert.ok(mime.includes('multipart/alternative'), 'alternative part lost');
    assert.ok(mime.includes('Content-Type: application/pdf'), 'wrong media type');
    assert.ok(
      mime.includes(`Content-Disposition: attachment; filename="${basename(file)}"`),
      'missing disposition',
    );
    // The file arrives byte-for-byte, not as text.
    const body = readFileSync(file).toString('base64');
    assert.ok(mime.replace(/\r\n/g, '').includes(body.replace(/\r\n/g, '')), 'payload altered');
  } finally {
    unlinkSync(file);
  }
});

test('a message without attachments keeps its previous shape', () => {
  const mime = compose({ to: 'a@b.dk', subject: 'Hej', bodyText: 'Goddag' });
  assert.ok(!mime.includes('multipart/mixed'), 'wrapper added unnecessarily');
  assert.ok(mime.includes('Content-Type: text/plain'));
});
