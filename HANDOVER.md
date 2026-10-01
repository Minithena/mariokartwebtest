# Handover

State as of 2026-10-01. Read [CLAUDE.md](CLAUDE.md) first for the rules (this repository is public:
nothing derived from the game may ever be committed) and the design; this file is the practical
"where things stand and how to carry on".

## What this is

Mario Kart Wii in the browser: [WiiCompiled](https://github.com/patchzyy/wiicompiled) (a static
recompilation of the game) built to WebAssembly with Emscripten, WebGPU rendering, a lazily fetched
disc, and private invite rooms for online play through a Cloudflare relay. Single player and
direct-entry multiplayer run; the owner plays it on a hosted URL.

## Where everything lives

| Thing | Where |
| --- | --- |
| This repo (page tooling, Worker, notes) | `Minithena/mariokartwebtest`, branch `claude/vigilant-ride-auy5y2` (not merged to `main`) |
| Runtime and renderer changes | fork `Minithena/Wiicompiled`, branch `web` (submodule `wiicompiled/`); upstream is `patchzyy/wiicompiled` |
| Toolchain (not in git) | `../tools`: `emsdk` (Emscripten 6.0.10), `nodtool`; `dotnet@8` and cmake/ninja from Homebrew |
| The owner's disc | `Mario Kart Wii (Europe, Australia) ... .wbfs` in the repo root, extracted to `wiicompiled/Assets/DATA`. Git-ignored; never commit, upload or describe contents |
| Reference save | `../saves/m0-baseline/rksys.dat` (Mario Circuit ghost 1:44.178) |
| Hosted game | `https://mkw-web.athenaaa.workers.dev` (Worker `mkw-web`, R2 bucket `mkw-web-eu`) |
| Room relay | `https://mkw-rooms.athenaaa.workers.dev` (`tools/cloudflare/rooms`, AGPL-3.0) |

Cloudflare Access is **off** at the owner's request for the current test window. Do not turn it on or
off yourself and do not describe the hosted page as private. Never create a Worker under a new name
with wrangler (it would have no Access); renames go through the dashboard.

## Currently deployed

Pushed and deployed on 2026-10-01: fork `web` at `52a5043`, this repo's branch at the commit that
adds this file. Hosted `WiiCompiled.wasm` is 122,015,230 bytes; the loader and page HTML match the
local staged files (SHA-256 checked); `mkw-web` Worker version `41c94fe7-a074-45ce-a2d1-04795f0ca1b9`.
The room relay was not changed or redeployed. Not yet opened in a browser on the hosted URL.

## Day-to-day commands

```sh
cd mariokartwebtest
source ../tools/emsdk/emsdk_env.sh
export DOTNET_ROOT=/opt/homebrew/opt/dotnet@8/libexec
cmake --build wiicompiled/build-web --target WiiCompiled     # incremental ~1.5 min
./tools/stage-web.sh
python3 tools/serve.py site/public                           # then http://127.0.0.1:8000/WiiCompiled.html?muted&log
python3 tools/deploy-web.py [--worker]                       # needs `npx wrangler login`; uploads only changed files
```

Tests: 45 JS (`node --test tools/cloudflare/test/worker.test.mjs wiicompiled/runtime/src/platform/web/tests/*.test.mjs`),
4 Python (`python3 -m unittest discover -s tools -p 'test_web_menu_videos.py'`), the relay suite in
`tools/cloudflare/rooms`, and 9 native (`ctest` in `wiicompiled/build-macos`). The native build
(`cmake --build wiicompiled/build-macos`, ~15 s incremental) must keep compiling: web edits to shared
files stay behind `__EMSCRIPTEN__`.

## What changed in the last session (2026-10-01)

Fixes, all measured before and after:

1. **Boot stall**: a web-only `std::regex` rewrite of every shader (~6 ms each) is now a linear scan
   with identical output. Prewarm went from 9.1 s of ~3 FPS to ~4-5 s, mostly the game's own boot.
2. **Bricked page**: an empty `Config.toml` in browser storage gave "No DVD root is configured"
   forever. The web build no longer saves window geometry, repairs an empty file and forces `dvd_root`.
3. **Frame loop**: `emscripten_sleep` polling cost every frame ~4.7 ms (browsers clamp nested timers
   to ~4 ms). Now event-driven. Under +9 ms synthetic load: 59 FPS instead of 46.
4. **Race start**: the save's shadow copy on browser storage took ~330 ms twice; now chunked (<20 ms).
5. **Pipeline prewarm** is time-budgeted per frame; **no-JSPI browsers** get a clear message
   instead of a cryptic assertion.
6. **Hosting**: the Worker lets browsers keep `game/DATA/*` for a day (disc files never change).
   Deployed with the Worker.

Diagnostics added (all `?log`): per-frame time split, true busy time, slow-frame attribution, guest
sampling profiler, slow NAND operations. `?burn=<ms>` and `?oldyield` exist for A/B tests. See
CLAUDE.md, "Diagnostics".

## Known issues and what to do next

In rough priority order:

1. **Verify on real hardware.** Everything was measured in the desktop app's browser pane on an Apple
   M5 at 60 Hz. The owner reports random hitches and occasional low FPS while driving and lag when a
   map loads; on this machine steady racing uses ~6.5 ms of CPU per frame, so their machine or
   display probably differs. Ask for a `?log` console export from it (look at `busy_per_frame`,
   `[web-perf] slow frame`, `[web-prof] slow frame`) before guessing.
2. **Frame pacing vs display refresh.** The game paces on its own wall-clock VI timeline
   (`wiicompiled/runtime/src/hle/vi.cpp`), not the display. 75/120/144 Hz or 59.94 Hz screens may
   judder. The fix is tying presentation to the browser's frame callback; it is a real rendering
   change and needs testing on those displays.
3. **Race-load cost**: ~200 ms guest frames (`RaceScene::CreateAndInitInstances`, `EGG::ExpHeap::Alloc`,
   Mii model loading). On a far-away connection serial disc reads dominate (hosted TTFB was 0.4-0.5 s
   per request from the US east coast; the bucket is in Western Europe).
4. **Multiplayer**: a fully driven race and a test across two physical machines are unverified.
5. Firefox smoothness is unverified. Firefox ESR cannot run the game (no JSPI).
6. One audio "output queue full" drop was seen in a race; unexplained.
7. The owner's scene-over-HUD corruption screenshot has not been reproduced.
8. M3 (players bring their own disc) is deferred at the owner's request.

## Gotchas learned the hard way

- `-sGROWABLE_ARRAYBUFFERS` breaks WebGPU (`setBindGroup` rejects resizable buffers). `-sASSERTIONS=0`
  and fixed memory gave nothing.
- Compare only the same scene (title logo, attract video and race differ a lot) and repeat runs;
  page-load noise is about ±1.5 ms. The 3 s `[web-perf]` lines mix scenes.
- The in-app browser pane may have remapped keys (Confirm was the **U** key), the console reader keeps
  only recent lines and its filter is a plain substring, and the owner sometimes plays in the same
  pane. Always use `?muted` and close your tabs afterwards.
- A staged build is only used after `tools/stage-web.sh`; the server sends `no-cache`, a plain reload
  picks it up. Opening the pane twice can leave a second game running and skew timing.
- `deploy-web.py` only uploads changed files; the `.wasm` is ~122 MB (~28 MB compressed).
- Hosted startup bugs fixed earlier: WASMFS double slashes in R2 keys and `bytes NaN-NaN` range
  headers (both covered by `tools/cloudflare/test/worker.test.mjs`).

## Repository hygiene

Tracked files are only source, tooling and notes. Build output (`wiicompiled/build-*`, `generated/`,
`site/public/*`, `*.wasm`), the disc, and local state (`.wrangler/`, `site/deployed.json`) are
git-ignored; check `git status` before every commit. Stale build directories from the first day were
removed. Do all web work on the fork's `web` branch.
