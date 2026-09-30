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
    // Pages opened with "?log" post their console here; locally serve.py prints it.
    if (url.pathname === '/log') return new Response(null, { status: 204 });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    if (url.pathname === '/') return Response.redirect(new URL('/WiiCompiled.html', url), 302);

    const key = decodeURIComponent(url.pathname.slice(1));
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
    const offset = 'suffix' in range ? object.size - range.suffix : range.offset ?? 0;
    const length = 'suffix' in range ? range.suffix : range.length ?? object.size - offset;
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set('Content-Length', String(length));
    return new Response(request.method === 'HEAD' ? null : object.body, { status: 206, headers });
  },
};
