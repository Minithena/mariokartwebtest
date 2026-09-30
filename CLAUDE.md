# Mario Kart Wii in the browser

Goal: run [WiiCompiled](https://github.com/patchzyy/wiicompiled) (a native PC port of Mario Kart
Wii made by static recompilation) in a web browser, compiled to WebAssembly, the way
`halo-web.otherness-bugs.workers.dev` runs a browser build of the Halo CE port
(`cybersecurity/halo-ce-universal`). Later: play with friends through an invite link.

The owner works on an **Apple Silicon Mac** with a clean **PAL `RMCP01`** dump of their own disc.
All builds run on that Mac, because they need the disc.

## Rules

- **This repository is public.** Never commit, push or upload a disc image, extracted game files,
  `main.dol`/`StaticR.rel`, translator output (`generated/`), or the compiled game (`.wasm` and
  its loader `.js`). The translated code embeds the game's code and data, so it counts as game
  content too. `.gitignore` covers the usual paths; check `git status` before every commit.
- The proof of concept stays **private**: served on `127.0.0.1` (`tools/serve.py`), or on
  Cloudflare behind **Cloudflare Access** limited to the owner's email. Do not make it public.
- A later version asks each player for their own disc image in the browser (read locally, never
  uploaded). Skipping that step is only for the private proof of concept.
- WiiCompiled is GPLv3, so the port's source changes are published (in the fork, below).

## Layout

- `wiicompiled/`: the owner's GitHub fork of `patchzyy/wiicompiled`, added as a git submodule;
  work on a `web` branch. Runtime and CMake changes for the browser go here, so upstream updates
  can be merged. Its own `.gitignore` already excludes `Assets/`, `generated/` and `build-*/`.
- This repository: the web page, Cloudflare config, scripts and notes.
- `tools/serve.py`: local server with the headers that threads need (see "Hosting").

## Status (2026-09-30) — read first

- **M0 done.** Native build in `wiicompiled/build-macos`. Reference ghost: Mario Circuit 1:44.178;
  backup of the native save at `../saves/m0-baseline/rksys.dat` (outside the repo).
- **M1 done** in Chrome 152 and Firefox 156: races run, the M0 ghost replays with an identical time.
- Fork `Minithena/Wiicompiled`, branch `web`, and this repo (`Minithena/mariokartwebtest`) are pushed.
- Build and run (tools in `../tools`: `emsdk`, `nodtool`; dotnet@8 via Homebrew, see memory):
  `source ../tools/emsdk/emsdk_env.sh && cmake --build wiicompiled/build-web --target WiiCompiled`,
  then `./tools/stage-web.sh` and `python3 tools/serve.py site/public`, open
  `http://127.0.0.1:8000/WiiCompiled.html` (add `?muted`, `?log`, `?resetsave`).
- Web design (all web code is in `wiicompiled/runtime/src/platform/web/` or behind `__EMSCRIPTEN__`):
  - Guest threads are JSPI coroutines on one worker (`host_context.cpp`, `mkw_fibers.js`), not pthreads.
  - Guest memory: `guest_flat_memory_wasm.cpp`, all accesses on the checked page-table path.
  - Disc: WASMFS fetch backend with our own JS half (`mkw_fetchfs.js`; the stock one corrupts files)
    reading `site/public/game/` via `game/manifest.txt` ("f <size> <path>").
  - User state in OPFS at `/persist` (`web_platform.cpp`); the staged save seeds the NAND once.
  - Firefox needs core WGSL: aurora `gx/shader.cpp` rewrites storage-pointer helpers on the web.
  - `?log` forwards the page console to `serve.py` stdout — the way to debug the user's browsers.
  - The controls panel follows F10 remapping: `PublishWebBindings()` in `settings_overlay.cpp` sends
    player 1's bindings as JSON to `window.mkwSetBindings` when they change; `<kbd data-bind>` cells
    use GameCube button keys (a, b, start, l, r, up...) or `axisN` (PAD_AXIS_* index).
  - `tools/unlock-all.py` unlocks everything in the staged save (stage-web.sh runs it); checked in
    game: all characters, vehicles and cups are selectable.
  - Key/mouse taps shorter than a frame latch until the next `PADRead` (aurora `input.cpp`
    `take_taps`), so quick taps, including automated ones, reach the game and the F10 rebind prompt.
- Current priorities (owner's latest direction: focus on multiplayer; defer M3 until asked):
  1. Multiplayer: room implementation in `tools/cloudflare/rooms`, virtual sockets in
     `runtime/src/platform/web/web_vnet.{cpp,h}`. Two local browser clients have completed login,
     matchmaking, course voting and a shared race start (N64 DK's Jungle Parkway). Race completion
     with both players actively driving and a test across two physical machines remain unverified.
     The game retains its own inactivity disconnects: a parked client is not a valid endurance test.
  2. Performance: pipelines prewarm behind the boot screen from `initial_pipeline_cache.db`
     (about 19 s on a first visit, 8 s later) plus the pipelines this browser met before, which
     aurora appends to `/persist/WiiCompiled/Cache/web_pipelines.bin` (`load_seed_pipelines`,
     `load_web_pipeline_log` in `pipeline_cache.cpp`). Left: course select drops to about 36 FPS on
     the Mushroom Cup preview (probably the video decode; the owner said this slowdown is fine).
  3. M3 (players bring their own disc) is deferred at the owner's request.
- Multiplayer details:
  - Each invite is an isolated Cloudflare Durable Object with up to 12 browser clients. TCP WFC
    services and peer UDP datagrams travel over a WebSocket; no public Nintendo/Wiimmfi service
    or native TCP/UDP access is involved. This is a relay, not WebRTC.
  - Use the page's **Create room / Join room / Copy invite** controls before starting. In the game,
    everyone chooses **Nintendo WFC → Worldwide → VS Race**; matching stays inside the invite.
    Local pages use the room Worker on `127.0.0.1:8787`; a full `?room=ws://...` or `wss://...`
    remains available for diagnostics. The hosted page uses `mkw-rooms.athenaaa.workers.dev`.
  - Online browser tabs bypass Aurora's focus/hidden pause path. Its 100 ms event wait and GX
    retries were slowing background clients enough to disconnect them. ImGui draws also scale
    to the actual render attachment, fixing a resize-time WebGPU scissor crash.
  - Test: `cd tools/cloudflare/rooms && npm test` (9 unit tests), then with Wrangler running,
    `node test/live-smoke.mjs http://127.0.0.1:8787` (NAS/GameSpy proofs, cloned-save profiles,
    360 bidirectional datagrams, room isolation). The same smoke script accepts the hosted URL.
  - Deployment verified on 2026-09-30: `mkw-rooms.athenaaa.workers.dev` is enabled with the
    owner's explicit approval; the live protocol smoke passes. The updated game build is uploaded
    to `mkw-web-eu`; both its page and WASM still redirect unauthenticated visitors to Access.
    R2's public URL is disabled and it has no custom public domains. Web and native builds pass;
    all 8 configured native CTest checks pass. The source is pushed to the existing branches.
  - Room code is AGPL-3.0; its licence, source attribution and setup are in the room folder.
    No game-derived code or files may be included in that Worker or in git.
- **M2 (hosting)**: Worker `mkw-web` (`tools/cloudflare/`) at
  `https://mkw-web.athenaaa.workers.dev`, behind Cloudflare Access (owner's email, set in
  the dashboard), serving the private R2 bucket `mkw-web-eu` (Western Europe). Upload with
  `python3 tools/deploy-web.py` after `stage-web.sh` (sends only changed files; `--worker` also
  deploys the Worker; needs `npx wrangler login`). An empty bucket `mkw-web` (ENAM) is left over
  and can be deleted.
- Hosted startup fix (2026-09-30): WASMFS requests paths such as `game//manifest.txt` and
  `game//DATA/sys/fst.bin`. The Python server normalises them, but R2 does not; the original Worker
  returned 404 for those keys. The Worker now collapses repeated separators after decoding the URL.
  A second real-R2 bug used `'suffix' in range` on native descriptors which expose an undefined
  suffix property, producing `Content-Range: bytes NaN-NaN/...`; use the optional values instead.
  Both fixes are deployed. A localhost-only copy of the Worker using the actual remote R2 binding
  reached the Mario Kart title screen at 60 FPS, and start/middle/suffix range bytes match local
  disc files. Direct hosted-browser confirmation is separate from this proxy test.
  `node --test tools/cloudflare/test/worker.test.mjs` covers these cases and opt-in diagnostics
  (7 tests pass). `?log` forwards the page console to the Access-protected `/log` endpoint, in
  bounded batches, readable with `wrangler tail mkw-web --format json`. Access remains enabled.
- Known: the page shows an original bunny backdrop; the owner's own picture is used when
  `site/public/game/background.jpg` exists (gitignored, never commit it).

## Milestones

### M0. Native baseline on the Mac

Follow `wiicompiled/docs/building-macos.md`, base game only (skip Retro Rewind steps):
extract the disc with `nodtool` into `wiicompiled/Assets/`, check the two SHA-256 hashes, build the
translator (.NET 8), run `translate-recursive`, `emit-base-manifest`, `generate-data-init`,
`emit-build-shards`, then CMake + Ninja. Run `build-macos/WiiCompiled` with `Config.toml` pointing
`dvd_root` at `Assets/DATA`. Record a ghost (time trial) for the physics check in M1.

The translation output in `generated/` is the same for every platform; the web build reuses it
and only replaces the CMake/compile step.

### M1. Offline single player in the browser (Chrome first)

Build with Emscripten (`emsdk`; `emcmake cmake -S runtime -B build-web ...`). Known work, from
reading the code:

1. **CMake**: `runtime/CMakeLists.txt` only accepts Windows x64 (MinGW), macOS arm64 and Linux;
   add an `EMSCRIPTEN` branch. Drop the x86-64-v3 check (`runtime/src/host_cpu_baseline.cpp`).
2. **Guest memory**: `runtime/include/guest_flat_memory.h` and
   `runtime/src/guest_flat_memory*.cpp` reserve a flat **4 GiB** guest space at a fixed host
   address and use page protection to catch MMIO and unmapped pages. WebAssembly has neither
   (wasm32 has 4 GiB total, no `mmap` protections, no fault handlers). The accessors in
   `runtime/include/memory_access.h` have a fast path (`TryReadGuestScalar`) and a slow path
   (`Read32Slow` etc.). The Wii only has about 88 MiB of RAM (MEM1 at `0x80000000`, MEM2 at
   `0x90000000`; `guest_flat_memory.cpp` uses 32 MiB and 256 MiB windows for them, and
   `projects/mkwii/recomp.yml` sets `memory.size: 0x01A00000`). Plan: back only those regions with
   ordinary buffers, with an explicit range check that sends everything else to the slow path.
   Read `guest_flat_memory_macos.cpp` first: macOS already needed a different approach.
3. **Guest threads (fibers)**: `runtime/src/host_context.cpp` switches stacks with hand-written
   assembly (`mkw_co_switch`/`mkw_co_init`) and libco; `runtime/src/fiber_manager.cpp` schedules
   them. WebAssembly cannot switch stacks. Options:
   - Preferred first: each guest thread becomes a real pthread (a Web Worker), with a baton
     (mutex + condition variable) so only one runs at a time, as the fibers do. No code-size
     cost. Watch `thread_local` state (e.g. `GuestFiberManager::s_cpuContext`), which today is
     shared by all fibers on one host thread and would become per-thread.
   - Fallback: Emscripten fibers (Asyncify), limited with `ASYNCIFY_ONLY`/`ASYNCIFY_ADD`.
     Unrestricted Asyncify over the whole translated game would bloat and slow it badly.
4. **Main loop**: the game loop blocks. Run `main` on a pthread (`-sPROXY_TO_PTHREAD`) so it can
   keep blocking, which also fits the thread-based fibers and blocking file reads. Rendering from
   a worker needs the canvas transferred (OffscreenCanvas); check what Emscripten's WebGPU port
   supports, or else restructure into a per-frame callback (`emscripten_set_main_loop`).
5. **Graphics**: aurora (`aurora-main/`) renders with WebGPU through Dawn. On the web, use the
   browser's WebGPU via Emscripten's WebGPU port (`--use-port=emdawnwebgpu`) instead of Dawn, and
   create the surface from the canvas. Turn off the pipeline cache (zstd, `initial_pipeline_cache.db`)
   at first.
6. **SDL3** (window, input, audio): supported by Emscripten. Browsers only start audio after a
   click, so the page needs a "click to start" button. Gamepads work through the Gamepad API;
   real Wii Remotes over Bluetooth will not.
7. **Files**: the runtime reads an extracted disc folder (`dvd_root`, `runtime/src/hle/storage/dvd.cpp`
   scans it with `std::filesystem`). The folder is large, so do not preload it: use WASMFS with a
   fetch-backed directory (lazy, per file; needs pthreads) or a custom lazy loader. Also needed in
   the virtual file system: `dsp_coef.bin`, `wii_bootstrap/`, and a `Config.toml`. Save data (NAND)
   can live in memory for M1.
8. **Floating point**: `runtime/include/isa/ppc_isa_float.h` uses `std::fma` for PowerPC
   multiply-add. WebAssembly has no exact fused multiply-add instruction, so Emscripten falls back
   to a correct but slow software `fma`. Physics stay exact but slower; profile it. Do not
   switch to relaxed-SIMD `madd` (results may differ). Check exactness by replaying the M0 ghost.
9. **Network**: disable for M1.

Done when a race runs in Chrome from `tools/serve.py` and the M0 ghost replays identically.

### M2. Private hosting on Cloudflare

Serve the page, the `.wasm` and the game files with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` (needed for threads/SharedArrayBuffer). Put the site
behind Cloudflare Access (owner's email only). Check current per-file size limits for Workers
static assets; large files (the `.wasm`, big game files) may need R2. Deploy from the Mac with
`wrangler`; the built files never go through git.

### M3. Players bring their own disc

Page asks for the disc image, reads and extracts it in the browser (OPFS), checks it is `RMCP01`,
and serves files to the game from there. Then only the `.wasm` is hosted, still privately.

### M4. Online

Mario Kart Wii has no LAN mode (unlike Halo's System Link): online goes through Wiimmfi-style
servers (login over HTTPS, matchmaking over TCP) and races peer-to-peer over UDP.
`runtime/src/hle/net/` maps the Wii's sockets to native sockets; browsers have neither TCP nor UDP.
TCP can go browser → WebSocket → Cloudflare Worker → TCP (Workers can open outbound TCP). UDP race
traffic needs WebRTC data channels between browsers, or a small UDP relay on a VPS (Workers cannot
do UDP). An invite-link flow needs a friend-room layer on top.

## Background: how the Halo browser build works

`cybersecurity/halo-ce-universal` is a native port of the Halo CE Xbox decompilation (SDL3,
OpenGL 4.5 desktop / OpenGL ES 3 Android). Its internet play has no server: invites
(`halo://join/<id+token>`) are matched through public MQTT brokers, STUN finds public addresses,
and machines connect by UDP hole punching, with the game's System Link traffic tunnelled over it
(`port/linux/src/p2p.c`). The browser build on `workers.dev` is not in the public repos; it would
compile the C code with Emscripten, use WebGL 2, and replace UDP/MQTT with WebSockets or WebRTC
through the Worker. The same recipe applies here.
