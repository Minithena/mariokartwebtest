#!/usr/bin/env python3
"""Serve a folder on 127.0.0.1 with the headers a threaded WebAssembly build needs.

Threads (pthreads) use SharedArrayBuffer, which browsers only allow on a page that is
cross-origin isolated: Cross-Origin-Opener-Policy: same-origin and
Cross-Origin-Embedder-Policy: require-corp. Python's http.server does not send them.

It also answers HTTP range requests (single ranges), which the game's lazily fetched disc files
rely on: without them every file would be downloaded whole on first use. POST /log prints what a
page opened with "?log" forwards from its console.

Usage: python3 tools/serve.py [folder] [--port 8000]
It listens on 127.0.0.1 only, so the game stays on this machine.
"""

import argparse
import functools
import http.server
import mimetypes
import os
import re

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".mjs")

RANGE = re.compile(r"bytes=(\d*)-(\d*)$")


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_head(self):
        path = self.translate_path(self.path)
        match = RANGE.match(self.headers.get("Range", "").strip())
        if self.command != "GET" or not match or not os.path.isfile(path):
            response = super().send_head()
            return response
        size = os.path.getsize(path)
        first, last = match.groups()
        if first:
            start, end = int(first), int(last) if last else size - 1
        else:
            start, end = max(0, size - int(last or 0)), size - 1
        end = min(end, size - 1)
        if start >= size or start > end:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._remaining = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        remaining = getattr(self, "_remaining", None)
        if remaining is None:
            return super().copyfile(source, outputfile)
        self._remaining = None
        while remaining > 0:
            chunk = source.read(min(remaining, 1 << 20))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)

    def do_POST(self):
        # Pages opened with "?log" forward their console here (shell.html), so browsers that
        # cannot be inspected from this machine's tools can still be debugged.
        if self.path != "/log":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        text = self.rfile.read(length).decode("utf-8", "replace")
        agent = self.headers.get("User-Agent", "")
        browser = "firefox" if "Firefox/" in agent else "chrome" if "Chrome/" in agent else "browser"
        for line in text.splitlines():
            print(f"[{browser}] {line}", flush=True)
        self.send_response(204)
        self.end_headers()

    def send_response(self, code, message=None):
        super().send_response(code, message)
        if code == 200:
            self.send_header("Accept-Ranges", "bytes")


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
