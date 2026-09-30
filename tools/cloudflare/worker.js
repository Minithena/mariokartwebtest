// Serves the browser build from the private R2 bucket "mkw-web-eu" (Western Europe, uploaded by
// tools/deploy-web.py) with what tools/serve.py gives it locally: the cross-origin isolation
// headers threads need, and single-range responses for the lazily fetched disc files. Keep this Worker behind Cloudflare
// Access: the bucket holds files from the owner's disc.

const TYPES = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript',
  wasm: 'application/wasm',
  txt: 'text/plain; charset=utf-8',
  jpg: 'image/jpeg',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Opt-in diagnostics from pages opened with ?log. Access protects this route too.
    // Keep each batch bounded and send it only to the Worker's live diagnostic stream.
    if (url.pathname === '/log') {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const reader = request.body?.getReader();
      if (!reader) return new Response(null, { status: 204 });
      const decoder = new TextDecoder();
      let text = '', length = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 65536) {
          await reader.cancel();
          return new Response('Diagnostic batch too large', { status: 413 });
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      console.log('[browser]', text);
      return new Response(null, { status: 204 });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    if (url.pathname === '/') return Response.redirect(new URL('/WiiCompiled.html', url), 302);

    // WASMFS joins its backend root and file paths with an extra slash (game//DATA/...).
    // The local filesystem server collapses those separators; R2 keys are exact strings.
    // Normalise here too, including the manifest's HEAD/read requests, before looking in R2.
    let key;
    try {
      key = decodeURIComponent(url.pathname).replace(/\/+/g, '/').slice(1);
    } catch {
      return new Response('Invalid path', { status: 400 });
    }
    let object;
    try {
      object = await env.BUCKET.get(key, { range: request.headers, onlyIf: request.headers });
    } catch {
      return new Response('Range not satisfiable', { status: 416 }); // R2 rejects bad ranges
    }
    if (object === null) return new Response('Not found', { status: 404 });

    const headers = new Headers({
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Type': TYPES[key.split('.').pop()] ?? 'application/octet-stream',
      'Cache-Control': 'private, no-cache',
      'Accept-Ranges': 'bytes',
      ETag: object.httpEtag,
    });
    // onlyIf failed (If-None-Match matched): the browser's copy is current.
    if (!('body' in object)) return new Response(null, { status: 304, headers });

    const range = request.headers.has('Range') ? object.range : undefined;
    if (!range) {
      headers.set('Content-Length', String(object.size));
      return new Response(request.method === 'HEAD' ? null : object.body, { headers });
    }
    // Native R2 descriptors expose optional properties even when their value is undefined.
    // Testing `"suffix" in range` misclassifies ordinary offset ranges and produces NaN headers.
    const suffix = typeof range.suffix === 'number' ? Math.min(range.suffix, object.size) : undefined;
    const offset = range.offset ?? (suffix === undefined ? 0 : object.size - suffix);
    const length = Math.min(range.length ?? suffix ?? object.size - offset, object.size - offset);
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set('Content-Length', String(length));
    return new Response(request.method === 'HEAD' ? null : object.body, { status: 206, headers });
  },
};
