#!/usr/bin/env python3
"""Serve a folder on 127.0.0.1 with the headers a threaded WebAssembly build needs.

Threads (pthreads) use SharedArrayBuffer, which browsers only allow on a page that is
cross-origin isolated: Cross-Origin-Opener-Policy: same-origin and
Cross-Origin-Embedder-Policy: require-corp. Python's http.server does not send them.

Usage: python3 tools/serve.py [folder] [--port 8000]
It listens on 127.0.0.1 only, so the game stays on this machine.
"""

import argparse
import functools
import http.server
import mimetypes

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".mjs")


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("folder", nargs="?", default="site/public")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    handler = functools.partial(Handler, directory=args.folder)
    with http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
        print(f"Serving {args.folder} at http://127.0.0.1:{args.port}/")
        server.serve_forever()


if __name__ == "__main__":
    main()
