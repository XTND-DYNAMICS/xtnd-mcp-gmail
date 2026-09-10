import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  decodeBody,
  decodeEncodedWords,
  extractFetchLiteral,
  parseHeaderBlock,
  parseMimeMessage,
} from '../src/core/parser/imap-message.js';

/** Build an IMAP FETCH response around a message, as the server sends it. */
function fetchResponse(message: string): string {
  const octets = Buffer.byteLength(message, 'utf8');
  return `* 5 FETCH (BODY[] {${octets}}\r\n${message})\r\nG0003 OK Success\r\n`;
}

test('extractFetchLiteral strips the IMAP wrapper and terminator', () => {
  const message = 'Subject: Hello\r\n\r\nBody text\r\n';
  const extracted = extractFetchLiteral(fetchResponse(message));

  assert.equal(extracted, message);
  assert.ok(!extracted.includes('OK Success'), 'response terminator leaked into the message');
  assert.ok(!extracted.includes('FETCH'), 'response prefix leaked into the message');
});

test('parseHeaderBlock unfolds a wrapped Cc list', () => {
  // Apple Mail folds a long Cc across lines. Reading only the first line was
  // the bug that made a four-recipient reply look like a one-recipient reply.
  const headers = parseHeaderBlock(
    'From: Peter <pam@stejle.dk>\r\n'
    + 'Cc: =?utf-8?Q?J=C3=B8rgen_Juul?= <jjuul@stejle.dk>,\r\n'
    + ' Marten <moe@privategpt.dk>,\r\n'
    + '\tbsi@atriumcph.com, mbo@atriumcph.com\r\n'
    + 'Subject: Sv: Atrium\r\n',
  );

  assert.ok(headers.cc.includes('jjuul@stejle.dk'));
  assert.ok(headers.cc.includes('moe@privategpt.dk'));
  assert.ok(headers.cc.includes('bsi@atriumcph.com'));
  assert.ok(headers.cc.includes('mbo@atriumcph.com'));
  assert.equal(headers.subject, 'Sv: Atrium');
});

test('decodeBody decodes quoted-printable into real characters', () => {
  const decoded = decodeBody(
    'Tusind tak =E2=80=94 og is=C3=A6r for den hurtige reaktion.',
    'quoted-printable',
    'utf-8',
  );

  assert.equal(decoded, 'Tusind tak — og især for den hurtige reaktion.');
});

test('decodeBody joins quoted-printable soft line breaks', () => {
  const decoded = decodeBody('Der gik seks =\r\nminutter', 'quoted-printable', 'utf-8');
  assert.equal(decoded, 'Der gik seks minutter');
});

test('decodeBody decodes base64', () => {
  const decoded = decodeBody(
    Buffer.from('Der er åbnet', 'utf8').toString('base64'),
    'base64',
    'utf-8',
  );
  assert.equal(decoded, 'Der er åbnet');
});

test('decodeEncodedWords decodes RFC 2047 display names', () => {
  assert.equal(decodeEncodedWords('=?utf-8?B?QW5kZXJzIFLDpGhy?= <ar@planorama.dk>'),
    'Anders Rähr <ar@planorama.dk>');
  assert.equal(decodeEncodedWords('=?UTF-8?Q?Peter_A_M=C3=B8lgaard?='), 'Peter A Mølgaard');
});

test('parseMimeMessage picks the text part out of multipart/alternative', () => {
  const boundary = 'BOUNDARY123';
  const message = [
    'From: Anders <ar@planorama.dk>',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    'MIME-Version: 1.0',
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Der er =C3=A5bnet',
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '<p>Der er =C3=A5bnet</p>',
    `--${boundary}--`,
    '',
  ].join('\r\n');

  const parsed = parseMimeMessage(extractFetchLiteral(fetchResponse(message)));

  assert.equal(parsed.text.trim(), 'Der er åbnet');
  assert.equal(parsed.html.trim(), '<p>Der er åbnet</p>');
  assert.ok(!parsed.text.includes('BOUNDARY123'), 'MIME boundary leaked into the body');
  assert.ok(!parsed.text.includes('OK Success'), 'IMAP terminator leaked into the body');
});

test('parseMimeMessage ignores attachment parts when collecting body text', () => {
  const boundary = 'MIXED9';
  const message = [
    'Content-Type: multipart/mixed; boundary="MIXED9"',
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    '',
    'Se vedhæftede',
    `--${boundary}`,
    'Content-Type: application/pdf; name="rapport.pdf"',
    'Content-Disposition: attachment; filename="rapport.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjQK',
    `--${boundary}--`,
    '',
  ].join('\r\n');

  const parsed = parseMimeMessage(message);

  assert.equal(parsed.text.trim(), 'Se vedhæftede');
  assert.ok(!parsed.text.includes('JVBERi'), 'attachment payload leaked into the body');
});
