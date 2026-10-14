import assert from 'node:assert/strict';
import test from 'node:test';
import { validateImageDataUrl } from './upload-image.schema';

function photo(bytes: number, type = 'image/jpeg') {
  return `data:${type};base64,${Buffer.alloc(bytes).toString('base64')}`;
}

test('verification size is measured from decoded bytes, including padded 5 MiB photos', () => {
  const limit = 5 * 1024 * 1024;
  for (const size of [limit - 2, limit - 1, limit]) {
    const image = photo(size);
    assert.equal(validateImageDataUrl(image, limit), image, `allowed ${size} bytes`);
  }
  assert.equal(validateImageDataUrl(photo(limit + 1), limit), null);
});

test('general image default keeps its 10 MiB boundary', () => {
  const image = photo(10 * 1024 * 1024);
  assert.equal(validateImageDataUrl(image), image);
  assert.equal(validateImageDataUrl(photo(10 * 1024 * 1024 + 1)), null);
});

test('retains supported photo types and rejects URL, non-image, empty and malformed base64 input', () => {
  for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
    const image = photo(4, type);
    assert.equal(validateImageDataUrl(image, 4), image);
  }
  for (const invalid of [undefined, null, {}, '', 'https://example.com/id.jpg',
    photo(4, 'image/svg+xml'), photo(4, 'application/pdf'),
    'data:image/jpeg;base64,', 'data:image/jpeg;base64,AAA',
    'data:image/jpeg;base64,AA=A', 'data:image/jpeg;base64,AA===',
    'data:image/jpeg;base64,AA A']) {
    assert.equal(validateImageDataUrl(invalid), null);
  }
});
