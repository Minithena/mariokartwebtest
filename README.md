# mariokartwebtest

An experiment to run [WiiCompiled](https://github.com/patchzyy/wiicompiled), the native PC port of
Mario Kart Wii, in a web browser via WebAssembly.

This repository contains no Nintendo code, assets or game data, and none may be added. The game
is built locally from your own PAL (`RMCP01`) disc; the build never goes into git.

The plan, the rules and the known porting work are in [CLAUDE.md](CLAUDE.md).

## Building and running

Everything is built on the Mac from your own disc; the setup is in [CLAUDE.md](CLAUDE.md).

```sh
source ../tools/emsdk/emsdk_env.sh
cmake --build wiicompiled/build-web --target WiiCompiled
./tools/stage-web.sh                       # copies the build and links your extracted disc into site/public
python3 tools/serve.py site/public --port 8000
```

Then open `http://127.0.0.1:8000/WiiCompiled.html` (add `?muted`, `?log` or `?resetsave`).
`tools/serve.py` sends the cross-origin isolation headers a threaded WebAssembly build needs and
listens on `127.0.0.1` only.

## Private hosting

`tools/cloudflare/` is a Cloudflare Worker that serves the staged build from a private R2 bucket,
with the same headers. It must stay behind Cloudflare Access (only the owner can sign in), since
the bucket holds files from the disc. After staging, upload what changed:

```sh
python3 tools/deploy-web.py            # add --worker to also deploy the Worker
```
