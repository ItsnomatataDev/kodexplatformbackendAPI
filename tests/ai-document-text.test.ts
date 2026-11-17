import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import {
  extractDocumentBytes,
  messageContentForModel,
  ownedAiObjectKey,
  resolveChatDocuments,
} from '../src/ai/document-text.js';

test('plain text and csv bytes are readable', () => {
  const text = extractDocumentBytes(Buffer.from('Revenue,120\nCosts,40\n'), 'report.csv', 'text/csv');
  assert.match(text, /Revenue,120/);
});

test('pdf literal text is extracted from an uncompressed stream', () => {
  const pdf = Buffer.from(
    `%PDF-1.1
1 0 obj
<< /Length 68 >>
stream
BT (Quarterly revenue grew) Tj ET
endstream
endobj
%%EOF`,
  );
  assert.match(extractDocumentBytes(pdf, 'board.pdf', 'application/pdf'), /Quarterly revenue grew/);
});

test('pdf flate streams are inflated before reading', () => {
  const raw = Buffer.from('BT (Compressed board minutes) Tj ET');
  const deflated = deflateRawSync(raw);
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n4 0 obj\n<< /Filter /FlateDecode /Length '),
    Buffer.from(String(deflated.byteLength)),
    Buffer.from(' >>\nstream\n'),
    deflated,
    Buffer.from('\nendstream\nendobj\n%%EOF'),
  ]);
  assert.match(extractDocumentBytes(pdf, 'minutes.pdf', 'application/pdf'), /Compressed board minutes/);
});

test('docx document xml is read from a zip entry', () => {
  const xml = Buffer.from(
    '<w:document><w:p><w:r><w:t>Leave policy update</w:t></w:r></w:p></w:document>',
  );
  const stored = deflateRawSync(xml);
  const name = Buffer.from('word/document.xml');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(stored.byteLength, 18);
  header.writeUInt32LE(xml.byteLength, 22);
  header.writeUInt16LE(name.byteLength, 26);
  const docx = Buffer.concat([header, name, stored]);
  assert.match(
    extractDocumentBytes(docx, 'policy.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    /Leave policy update/,
  );
});

test('stored document text is added to the model turn and foreign paths are ignored', () => {
  const content = messageContentForModel('Summarize this', {
    documents: [{ name: 'notes.txt', text: 'The office opens at 8.' }],
  });
  assert.match(content, /Summarize this/);
  assert.match(content, /The office opens at 8/);
  assert.equal(ownedAiObjectKey('org', 'user', 'ai/org/user/file.txt'), 'ai/org/user/file.txt');
  assert.equal(ownedAiObjectKey('org', 'user', 'ai/org/other/file.txt'), null);
  assert.equal(ownedAiObjectKey('org', 'user', 'https://example.com/file.pdf'), null);
  assert.equal(ownedAiObjectKey('org', 'user', 'ai/org/user/../secret'), null);
});

test('chat attachments read only the signed-in user storage path', async () => {
  const seen: string[] = [];
  const documents = await resolveChatDocuments({
    organizationId: 'org',
    userId: 'user',
    bucket: 'files',
    files: {
      async getObject(_bucket, objectKey) {
        seen.push(objectKey);
        return { body: Buffer.from('Signed contract total 500.') };
      },
    },
    attachments: [
      {
        name: 'secret.txt',
        mimeType: 'text/plain',
        storagePath: 'ai/org/other/secret.txt',
      },
      {
        name: 'report.txt',
        mimeType: 'text/plain',
        storagePath: 'ai/org/user/1-report.txt',
        textContent: 'client copy',
      },
      { name: 'pasted.txt', textContent: 'Inline minutes from Monday.' },
    ],
  });
  assert.deepEqual(seen, ['ai/org/user/1-report.txt']);
  assert.equal(documents.length, 2);
  assert.match(documents[0]?.text ?? '', /Signed contract total 500/);
  assert.doesNotMatch(documents[0]?.text ?? '', /client copy/);
  assert.match(documents[1]?.text ?? '', /Inline minutes/);
});
