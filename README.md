# mariokartwebtest

An experiment to run [WiiCompiled](https://github.com/patchzyy/wiicompiled), the native PC port of
Mario Kart Wii, in a web browser via WebAssembly.

This repository contains no Nintendo code, assets or game data, and none may be added. The game
is built locally from your own PAL (`RMCP01`) disc; the build never goes into git.

The plan, the rules and the known porting work are in [CLAUDE.md](CLAUDE.md).

## Local test server

A threaded WebAssembly build needs cross-origin isolation headers:

```sh
python3 tools/serve.py site/public --port 8000
```

It listens on `127.0.0.1` only.
