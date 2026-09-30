#!/bin/sh
# Stage the browser build for local testing with tools/serve.py.
#
#   site/public/WiiCompiled.{html,js,wasm,data}   copied from wiicompiled/build-web
#   site/public/game/DATA                          symlink to wiicompiled/Assets/DATA (your disc)
#   site/public/game/save/rksys.dat               copy of your native save with everything unlocked
#   site/public/game/manifest.txt                  "d <dir>" / "f <size> <file>" list mounted at /game
#
# Everything staged here is game-derived and gitignored. Never commit it.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
build="$repo/wiicompiled/build-web"
data="$repo/wiicompiled/Assets/DATA"
public="$repo/site/public"

[ -f "$build/WiiCompiled.wasm" ] || { echo "no web build at $build" >&2; exit 1; }
[ -f "$data/sys/fst.bin" ] || { echo "no extracted disc at $data" >&2; exit 1; }

mkdir -p "$public/game"
for f in WiiCompiled.html WiiCompiled.js WiiCompiled.wasm WiiCompiled.data; do
    [ -f "$build/$f" ] && cp "$build/$f" "$public/"
done
ln -sfn "$data" "$public/game/DATA"

# Your native save (licences, ghosts), copied so the browser starts from the same state. The page
# seeds its NAND from it when it has none of its own (web_platform.cpp).
save="$HOME/Library/Application Support/WiiCompiled/NAND/title/00010004/524d4350/data/rksys.dat"
rm -rf "$public/game/save"
if [ -f "$save" ]; then
    mkdir -p "$public/game/save"
    cp "$save" "$public/game/save/rksys.dat"
    # Everything unlocked in the browser's copy (your native save is not touched).
    python3 "$repo/tools/unlock-all.py" "$public/game/save/rksys.dat" -o "$public/game/save/rksys.dat"
fi

python3 - "$public/game" <<'PY'
import os, sys
game = sys.argv[1]
lines = ["d DATA"]
files = []
for top in ("DATA/sys", "DATA/files", "save"):
    if not os.path.isdir(os.path.join(game, top)):
        continue
    for root, dirs, names in os.walk(os.path.join(game, top), followlinks=True):
        dirs.sort()
        rel = os.path.relpath(root, game)
        lines.append("d " + rel)
        for name in sorted(names):
            path = os.path.join(root, name)
            files.append("f %d %s" % (os.path.getsize(path), os.path.join(rel, name)))
with open(os.path.join(game, "manifest.txt"), "w") as out:
    out.write("\n".join(lines + files) + "\n")
PY

echo "Staged $(grep -c '^f ' "$public/game/manifest.txt") game files."
echo "Run: python3 tools/serve.py site/public   then open http://127.0.0.1:8000/WiiCompiled.html"
