#!/usr/bin/env python3
"""Upload the staged browser build (tools/stage-web.sh) to the private R2 bucket behind the
mkw-web Worker (tools/cloudflare). Only files that changed since the last upload are sent, so a
rebuild re-uploads just the page and the .wasm. Needs `npx wrangler login` once.

The bucket holds files from your disc: keep the Worker behind Cloudflare Access.

Usage: python3 tools/deploy-web.py [--worker] [--jobs 8] [--dry-run]
  --worker   also deploy the Worker code in tools/cloudflare
"""

import argparse
import concurrent.futures
import hashlib
import json
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(REPO, "site", "public")
STATE = os.path.join(REPO, "site", "deployed.json")  # gitignored; what the bucket holds
BUCKET = "mkw-web-eu"
PAGE_FILES = ["WiiCompiled.html", "WiiCompiled.js", "WiiCompiled.wasm", "WiiCompiled.data"]


def staged_files():
    """Every key the page can fetch: the build, and the files game/manifest.txt lists."""
    keys = [f for f in PAGE_FILES if os.path.isfile(os.path.join(PUBLIC, f))]
    keys.append("game/manifest.txt")
    with open(os.path.join(PUBLIC, "game", "manifest.txt")) as manifest:
        keys += ["game/" + line.split(" ", 2)[2].rstrip("\n") for line in manifest if line.startswith("f ")]
    if os.path.isfile(os.path.join(PUBLIC, "game", "background.jpg")):
        keys.append("game/background.jpg")
    return keys


def fingerprint(key):
    """Disc files never change, so size and mtime do; the build is re-copied on every stage, so hash it."""
    path = os.path.join(PUBLIC, key)
    stat = os.stat(path)
    if key.startswith("game/DATA/"):
        return "%d:%d" % (stat.st_size, stat.st_mtime_ns)
    digest = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return "%d:%s" % (stat.st_size, digest.hexdigest())


def wrangler(*args):
    return subprocess.run(["npx", "--yes", "wrangler@4", *args], cwd=os.path.join(REPO, "tools", "cloudflare"),
                          capture_output=True, text=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--jobs", type=int, default=8)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.worker and not args.dry_run:
        result = wrangler("deploy")
        print(result.stdout[-600:] or result.stderr[-600:])
        if result.returncode != 0:
            sys.exit("Worker deploy failed")

    try:
        with open(STATE) as f:
            state = json.load(f)
    except FileNotFoundError:
        state = {}

    keys = staged_files()
    todo = []
    for key in keys:
        fp = fingerprint(key)
        if state.get(key) != fp:
            todo.append((key, fp))
    size = sum(os.path.getsize(os.path.join(PUBLIC, k)) for k, _ in todo)
    print("%d of %d files to upload (%.1f MB)" % (len(todo), len(keys), size / 1e6))
    if args.dry_run or not todo:
        return

    def upload(item):
        key, fp = item
        result = wrangler("r2", "object", "put", BUCKET + "/" + key, "--file", os.path.join(PUBLIC, key),
                          "--remote")
        return key, fp, result

    failures = 0
    with concurrent.futures.ThreadPoolExecutor(args.jobs) as pool:
        for done, (key, fp, result) in enumerate(pool.map(upload, todo), 1):
            if result.returncode == 0:
                state[key] = fp
            else:
                failures += 1
                print("FAILED %s: %s" % (key, (result.stderr or result.stdout).strip()[-300:]))
            if done % 50 == 0 or done == len(todo):
                print("%d/%d" % (done, len(todo)), flush=True)
                with open(STATE, "w") as f:  # saved as it goes, so a rerun resumes
                    json.dump(state, f, indent=0, sort_keys=True)
    if failures:
        sys.exit("%d uploads failed; run again to retry them" % failures)
    print("Done.")


if __name__ == "__main__":
    main()
