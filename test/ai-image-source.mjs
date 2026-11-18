import assert from 'node:assert/strict';
import test from 'node:test';
import { imageSourceUrl, loadSourceImages } from '../src/ai-image-source.js';
import { imageSize } from '../src/ai-images.js';

const item = { requestId: 'a'.repeat(32), url: 'https://images.example/banner.png' };
const permissions = { contains: async ({ origins }) => {
  assert.deepEqual(origins, ['https://images.example/*']);
  return true;
} };

test('original banners keep their dimensions while large images remain bounded', () => {
  assert.deepEqual(imageSize(496, 37), { width: 496, height: 37 });
  assert.deepEqual(imageSize(37, 496), { width: 37, height: 496 });
  assert.deepEqual(imageSize(1984, 148), { width: 512, height: 38 });
  assert.deepEqual(imageSize(20, 20), { width: 64, height: 64 });
  assert.equal(imageSourceUrl('https://user:secret@images.example/a'), null);
  assert.equal(imageSourceUrl('file:///a'), null);
});

test('stale documents and missing host access cannot fetch image sources', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('must not fetch'); };
  assert.deepEqual(await loadSourceImages([item], async () => false, { permissions, fetchImpl }), { images: [] });
  assert.deepEqual(await loadSourceImages([item], async () => true, {
    permissions: { contains: async () => false }, fetchImpl,
  }), { images: [] });
  assert.equal(calls, 0);
});

test('shared image URLs are fetched once without credentials or redirects and non-images are rejected', async () => {
  let calls = 0;
  const response = await loadSourceImages([item, { ...item, requestId: 'b'.repeat(32) }], async () => true, {
    permissions,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, item.url);
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return new Response('<html>private data</html>', { headers: { 'Content-Type': 'text/html' } });
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(response, { images: [] });
});

test('oversized and failed image downloads never return data', async () => {
  for (const fetchImpl of [
    async () => new Response(null, { status: 403 }),
    async () => new Response('x', { headers: { 'Content-Type': 'image/png', 'Content-Length': String(9 * 1024 * 1024) } }),
    async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'image/png' } }),
    async () => { throw new Error('network failure'); },
  ]) {
    assert.deepEqual(await loadSourceImages([item], async () => true, { permissions, fetchImpl }), { images: [] });
  }
});
