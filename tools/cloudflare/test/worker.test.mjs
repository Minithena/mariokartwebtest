import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

const content = new TextEncoder().encode('sample content');
function bucket(expectedKey) {
  return { async get(key, options) {
    if (key !== expectedKey) return null;
    const object = { size: content.length, httpEtag: '"test-etag"' };
    if (options.onlyIf.get('If-None-Match') === object.httpEtag) return object;
    const range = /^bytes=(\d+)-(\d+)$/.exec(options.range.get('Range') || '');
    if (range) {
      const offset = Number(range[1]), end = Math.min(Number(range[2]), content.length - 1);
      object.range = { offset, length: end - offset + 1 };
      object.body = content.slice(offset, end + 1);
    } else object.body = content;
    return object;
  } };
}

test('WASMFS paths with repeated separators resolve to the uploaded R2 keys', async () => {
  for (const pathname of ['/game/manifest.txt', '/game//manifest.txt', '/game///manifest.txt', '/game/%2Fmanifest.txt']) {
    const response = await worker.fetch(new Request(`https://game.test${pathname}`), { BUCKET: bucket('game/manifest.txt') });
    assert.equal(response.status, 200, pathname);
    assert.equal(await response.text(), 'sample content');
  }
});

test('range reads retain exact byte offsets when a disc path is normalised', async () => {
  const response = await worker.fetch(new Request('https://game.test/game//DATA/sys/fst.bin', {
    headers: { Range: 'bytes=2-6' },
  }), { BUCKET: bucket('game/DATA/sys/fst.bin') });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Range'), 'bytes 2-6/14');
  assert.equal(response.headers.get('Content-Length'), '5');
  assert.equal(await response.text(), 'mple ');
});

test('HEAD retains WebAssembly type and cross-origin isolation headers', async () => {
  const response = await worker.fetch(new Request('https://game.test/WiiCompiled.wasm', { method: 'HEAD' }), {
    BUCKET: bucket('WiiCompiled.wasm'),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/wasm');
  assert.equal(response.headers.get('Content-Length'), '14');
  assert.equal(response.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
  assert.equal(response.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
  assert.equal(await response.text(), '');
});

test('an unchanged object returns 304', async () => {
  const response = await worker.fetch(new Request('https://game.test/WiiCompiled.js', {
    headers: { 'If-None-Match': '"test-etag"' },
  }), { BUCKET: bucket('WiiCompiled.js') });
  assert.equal(response.status, 304);
});

test('malformed percent encoding returns a client error', async () => {
  const response = await worker.fetch(new Request('https://game.test/game/%ZZ'), { BUCKET: bucket('none') });
  assert.equal(response.status, 400);
});
