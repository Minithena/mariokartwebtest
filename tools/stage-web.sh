#!/bin/sh
# Stage the browser build for local testing with tools/serve.py.
#
#   site/public/WiiCompiled.{html,js,wasm,data}   copied from wiicompiled/build-web
#   site/public/game/DATA                         symlink to the unchanged original disc
#   site/public/game/save/rksys.dat               copy of your native save with everything unlocked
#   site/public/game/manifest-v2.txt              files plus immutable browser-video aliases
#
# Menu previews use half the video frames at the same playback speed to reduce browser decode
# work. Pass --original-videos to stage the original clips instead.
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
python3 "$repo/tools/web_menu_videos.py" "$data" "$repo/site/web-data" "$repo/site/web-videos" "$@"
if [ -e "$public/game/DATA" ] && [ ! -L "$public/game/DATA" ]; then
    echo "refusing to replace non-symlink $public/game/DATA" >&2
    exit 1
fi
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

python3 - "$public/game" "$data" "$repo/site/web-data" "$repo/site/web-videos" <<'PY'
import hashlib, json, os, sys
from pathlib import Path
game, original, shadow, cache = [Path(p).resolve() for p in sys.argv[1:]]
def manifest(data_root, optimized):
    lines, files, aliases = ["d DATA"], [], []
    for base, top, prefix in ((data_root, 'sys', 'DATA/'), (data_root, 'files', 'DATA/'), (game, 'save', '')):
        if not (base / top).is_dir():
            continue
        for root, dirs, names in os.walk(base / top, followlinks=True):
            dirs.sort()
            rel = prefix + Path(root).relative_to(base).as_posix()
            lines.append('d ' + rel)
            for name in sorted(names):
                path = Path(root) / name
                logical = rel + '/' + name
                files.append(f'f {path.stat().st_size} {logical}')
                if optimized and path.resolve().is_relative_to(cache) and path.suffix == '.thp':
                    digest = hashlib.sha256(path.read_bytes()).hexdigest()
                    target = game / 'web-videos' / (digest + '.thp')
                    target.parent.mkdir(exist_ok=True)
                    if not target.exists():
                        # A hard link retains these bytes even when the conversion cache is replaced.
                        os.link(path.resolve(), target)
                    aliases.append('u ' + json.dumps([logical, 'web-videos/' + target.name]))
    return '\n'.join(lines + files + aliases) + '\n'
# Older running clients keep their original manifest/files. New clients capture the alias map
# once per startup, so later deployments cannot mix frames from different video versions.
(game / 'manifest.txt').write_text(manifest(original, False))
(game / 'manifest-v2.txt').write_text(manifest(shadow, True))
PY

echo "Staged $(grep -c '^f ' "$public/game/manifest.txt") game files."
echo "Run: python3 tools/serve.py site/public   then open http://127.0.0.1:8000/WiiCompiled.html"
