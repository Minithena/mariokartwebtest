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
- The proof of concept normally stays **private**: localhost or Cloudflare Access.
  **Current test state (2026-10-01):** the owner intentionally disabled Cloudflare Access for
  testing. No Access setting was changed during this work; leave the current state unchanged and
  do not describe the hosted page as Access-protected. This does not authorise putting game data in git.
- A later version asks each player for their own disc image in the browser (read locally, never
  uploaded). Skipping that step is only for the private proof of concept.
- WiiCompiled is GPLv3, so the port's source changes are published (in the fork, below).

## Layout

- `wiicompiled/`: the owner's GitHub fork of `patchzyy/wiicompiled`, added as a git submodule;
  work on a `web` branch. Runtime and CMake changes for the browser go here, so upstream updates
  can be merged. Its own `.gitignore` already excludes `Assets/`, `generated/` and `build-*/`.
- This repository: the web page, Cloudflare config, scripts and notes.
- `tools/serve.py`: local server with the headers that threads need (see "Hosting").

## Status (2026-10-01) — read first

- **M0 done.** Native build in `wiicompiled/build-macos`. Reference ghost: Mario Circuit 1:44.178;
  backup of the native save at `../saves/m0-baseline/rksys.dat` (outside the repo).
- **M1 done** in Chrome 152 and Firefox 156: races run, the M0 ghost replays with an identical time.
- The runtime update is published in `Minithena/Wiicompiled`, branch `web`, at `7f747d7`.
  This repository records the matching relay source, submodule revision and deployment results.
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
    player 1's bindings as JSON to `window.mkwSetBindings` when they change; `[data-bind]` buttons
    use GameCube button keys (a, b, start, l, r, up...) or `axisN` (PAD_AXIS_* index).
    Click one to rebind through the existing capture/persistence path.
    Keyboard rebinding and persistence after reload were verified in the browser. The sidebar
    also has master volume and mute controls; volume applies while dragging and saves on release.
  - `tools/unlock-all.py` unlocks everything in the staged save (stage-web.sh runs it); checked in
    game: all characters, vehicles and cups are selectable.
  - Key/mouse taps shorter than a frame latch until the next `PADRead` (aurora `input.cpp`
    `take_taps`), so quick taps, including automated ones, reach the game and the F10 rebind prompt.
- Current priorities (owner's latest direction: focus on multiplayer; defer M3 until asked):
  1. Multiplayer: two fresh localhost origins on ports 8005 and 8006 both reached online character
     select automatically, matched, and shared a Moo Moo Meadows 100cc race start. The lobby shows
     named participants immediately; each participant has one paired lobby/game slot. Auto-join
     follows the expected controller route through title, profile, WFC and VS menus to character
     select, with a manual fallback. It does not accept generic prompts. No completed driven race or
     cross-physical-laptop test is verified. A production R2/room invite reached character select
     in Chromium's in-app browser after one Play click; the roster showed one participant in-game.
     Five consecutive 3-second samples settled near 60 FPS with no frames above 25 ms. This does not
     establish Firefox smoothness. The game retains its own inactivity disconnects, so a parked
     client is not an endurance test.
  2. Performance: the browser rebuilds 1,199 pipeline recipes into GPU pipeline objects per page
     session. Browser/driver binary reuse is opaque, and no performance seed pruning has been done.
     Earlier pipeline warmup and menu frame-rate measurements are historical; do not present them as
     current browser smoothness. Firefox smoothness is not verified: a native Firefox screenshot and
     accessibility tree showed mismatched pages, and that test tab was closed. The renderer now
     resolves the current RAM texture again when a previously bound EFB copy has been evicted.
     A hosted single-player Bowser's Castle first-race check rendered the starting HUD and minimap
     correctly. This did not reproduce the owner's exact scene-over-HUD corruption later on the
     course, so that screenshot's cause and resolution remain unconfirmed.
  3. M3 (players bring their own disc) is deferred at the owner's request.
- Multiplayer details:
  - Each invite is an isolated Cloudflare Durable Object with up to 12 browser clients. TCP WFC
    services and peer UDP datagrams travel over a WebSocket; no public Nintendo/Wiimmfi service
    or native TCP/UDP access is involved. This is a relay, not WebRTC. Each participant occupies
    one paired lobby/game slot, and the lobby displays named participants immediately.
  - Use **Create room / Join room / Copy invite** before starting. Auto-join follows the expected
    controller route through title, profile, WFC and VS menus to character select, with a manual
    fallback; it does not accept generic prompts. Add `?manual` to bypass auto-join, then choose
    **Nintendo WFC → Worldwide → VS Race** yourself. Local pages use the room Worker at
    `127.0.0.1:8787`; a full `?room=ws://...` or `?room=wss://...` remains available for
    diagnostics. The hosted page uses `mkw-rooms.athenaaa.workers.dev`.
  - Online browser tabs bypass Aurora's focus/hidden pause path. Its 100 ms event wait and GX
    retries were slowing background clients enough to disconnect them. ImGui draws also scale
    to the actual render attachment, fixing a resize-time WebGPU scissor crash.
  - Tests: `cd tools/cloudflare/rooms && npm test` (17 checks); the web suites pass 56 JS checks:
    fetch 27, room UI 4, relay 17 and asset Worker 8. Web and native builds pass, as do all 8
    configured native CTest checks.
  - Current deployment: relay version `5779cf00e4b44e90ab333e4be674e2f8` is deployed, and the
    production live smoke passed lobby/roster/reservation cleanup, NAS, fragmented GameSpy,
    cloned-save IDs, 360 datagrams and room isolation. The R2 upload completed (3 files, 122.2 MB);
    hosted HTML and loader SHA-256 match local, and WASM Content-Length and ETag match the local
    MD5. The hosted Chromium in-app-browser end-to-end test passed: one Play click reached online
    character select, roster presence showed the participant in-game, and five 3-second samples
    were near 60 FPS with no frame over 25 ms. This does not verify Firefox smoothness. Access is
    intentionally disabled for testing per the owner; no Access setting was changed.
  - Room code is AGPL-3.0; its licence, source attribution and setup are in the room folder.
    No game-derived code or files may be included in that Worker or in git.
- **M2 (hosting)**: Worker `mkw-web` (`tools/cloudflare/`) at
  `https://mkw-web.athenaaa.workers.dev`, serving the private R2 bucket `mkw-web-eu` (Western
  Europe). Cloudflare Access is normally used for privacy, but the owner intentionally disabled it
  for the current test window; no Access setting was changed during this work (see Rules). Upload with
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
  (8 tests pass). `?log` forwards the page console to `/log` in bounded batches, readable with
  `wrangler tail mkw-web --format json`. The current Access state is recorded under Rules.
- Final startup correction: a hosted/cached HEAD response was yielding a zero-length manifest.
  The fetch backend now loads the manifest with one uncached GET and serves those same bytes to
  C++. Empty/invalid manifests fail with a visible Reload/error screen. The hosted URL has been
  observed mounting all 2038 game files; the owner subsequently reached the game menus.
- Browser assets now use `game/manifest-v2.txt`. Optional `u [logicalPath, web-videos/hash.thp]`
  records map only the selected menu videos to immutable files. Legacy manifest/disc paths stay
  unchanged, so deployments do not replace video bytes in an already-running session.
  `tools/web_menu_videos.py` stages 19 video-only previews, reducing them from 489.9 to 244.9 MB.
  All linked frames/durations were validated and FFmpeg decoded-pixel hashes matched retained
  source frames. `./tools/stage-web.sh --original-videos` restores the original previews for new
  sessions. Original `Assets/DATA` and racing physics are not modified.
  Tests: `python3 -m unittest discover -s tools -p 'test_web_menu_videos.py'` (4), and the fetch
  frontend suite now has 27 checks; the room UI suite has 4.
- Loading optimisation: `p [logicalPath, file-packs/hash.bin, offset, size]` records in manifest-v2
  map 143 unchanged assets of at most 64 KiB each into one 2,777,464-byte immutable download.
  The browser checks its SHA-256, shares the download, and serves file-relative slices. The pack
  excludes saves; legacy clients retain the individual disc paths. Worker responses permit private
  browser caching only for content-addressed packs and previews.
  Video reads stream four 1 MiB chunks ahead and publish each completed chunk immediately, without
  waiting for the full 4 MiB response tail. Concurrent requests share in-flight downloads; lifecycle
  cancellation prevents completed work from repopulating a freed file, and failed prefetches retry
  on demand. SZS archives up to 16 MiB download at the first header read to avoid serial range round
  trips. Tests cover concurrent reads, corruption/bounds, retries, streamed read-ahead, archive
  limits and file lifetime. The WebAssembly build passes. Across the web suites, 56 JS checks pass:
  fetch 27, room UI 4, relay 17 and asset Worker 8. All 143 packed payloads match their source bytes, and
  the actual remote R2 pack plus deployed loader were verified through a localhost-only Worker
  proxy, including a staff-ghost read using just the manifest and pack requests.
- Diagnostic `?log` launches enable `MKW_WEB_PERF`. `web_performance.cpp` reports frame counts,
  frames above 25/50/100 ms, average/maximum guest and graphics timings, and DVD read timing every
  three seconds. This is opt-in instrumentation to distinguish the remaining selection-menu
  hitch from one-time network loads; it is not itself a performance fix.
- Menu warming fetches common menu/model archives, including `Font.szs`, `BackModel.szs` and
  `o_Start2_32_fan.brstm`, the first 16 MiB of the sound archive in bounded ranges, and the first
  2 MiB of each aliased menu preview. It starts during boot, uses two background jobs and totals
  about 62.96 MiB under the 64 MiB cap. Demand reads share the same resource cache and in-flight
  jobs; optional warmup failures retry on demand.
- Hosting test state: Cloudflare Access is intentionally disabled by the owner for testing, and no
  Access setting was changed during this work. Do not describe the current hosted page as
  Access-protected; see Rules above.
- The overnight QA tabs, extra servers on ports 8004–8006 and diagnostic tail were closed.
  The original local game server on port 8000 and room server on port 8787 remain available.
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
