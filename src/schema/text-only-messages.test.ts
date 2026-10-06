import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageSchema } from './marketplace.schema';

test('chat accepts trimmed text, multiline messages, and the maximum text length', () => {
  assert.deepEqual(MessageSchema.parse({ content: '  Hello, when are you available?  ' }), { content: 'Hello, when are you available?' });
  assert.equal(MessageSchema.parse({ content: 'Hello\nTomorrow at 10?' }).content, 'Hello\nTomorrow at 10?');
  assert.equal(MessageSchema.parse({ content: 'a'.repeat(2000) }).content.length, 2000);
});

test('chat rejects image payloads, even when they include otherwise valid text', () => {
  const imageUrl = 'https://res.cloudinary.com/servicehub/image/upload/sample.jpg';
  for (const payload of [
    { imageUrl }, { content: 'Photo', imageUrl }, { content: 'Photo', imageUrl: 'data:image/png;base64,YQ==' },
    { content: 'Photo', image: 'data:image/png;base64,YQ==' }, { content: 'Photo', attachments: [imageUrl] },
  ]) {
    assert.equal(MessageSchema.safeParse(payload).success, false);
  }
});

test('chat rejects missing, blank, non-text, and oversized content', () => {
  for (const content of [undefined, null, '', ' \n\t ', 123, {}, 'a'.repeat(2001)]) {
    assert.equal(MessageSchema.safeParse({ content }).success, false);
  }
});
