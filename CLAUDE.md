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

A handover for whoever picks this up next is in [HANDOVER.md](HANDOVER.md).

- **M0 done.** Native build in `wiicompiled/build-macos`. Reference ghost: Mario Circuit 1:44.178;
  backup of the native save at `../saves/m0-baseline/rksys.dat` (outside the repo).
- **M1 done** in Chrome 152 and Firefox 156: races run, the M0 ghost replays with an identical time.
- **M2 done**: the build is hosted at `https://mkw-web.athenaaa.workers.dev` (see "Hosting").
- **Multiplayer**: private invite rooms with direct entry into online setup work between two local
  clients; a fully driven race and a test across two physical machines are still unverified.
- **Performance**: steady racing is 60 FPS (about 6.5 ms of CPU per frame on an Apple M5); the
  frame loop and race-start fixes below are in. Slower hardware is untested.
- M3 (players bring their own disc) is deferred at the owner's request.
- Source of truth for code: the fork `Minithena/Wiicompiled`, branch `web` (submodule
  `wiicompiled/`), plus this repository's branch `claude/vigilant-ride-auy5y2`.

### Build, run, test, deploy

Tools live in `../tools` (`emsdk`, `nodtool`); dotnet@8 comes from Homebrew (keg-only: export
`DOTNET_ROOT=/opt/homebrew/opt/dotnet@8/libexec`).

```sh
source ../tools/emsdk/emsdk_env.sh
cmake --build wiicompiled/build-web --target WiiCompiled     # ~1.5 min incremental
./tools/stage-web.sh                                         # copies the build, links the disc, writes manifests
python3 tools/serve.py site/public                           # http://127.0.0.1:8000/WiiCompiled.html
python3 tools/deploy-web.py [--worker]                       # uploads only changed files to R2 (needs wrangler login)
```

Page options: `?muted`, `?log` (diagnostics, below), `?resetsave`, `?manual` (skip direct entry),
`?room=ws(s)://...`, `?burn=<ms>` (synthetic CPU load), `?oldyield` (old timer-based waits).
Tests: `node --test tools/cloudflare/test/worker.test.mjs wiicompiled/runtime/src/platform/web/tests/*.test.mjs`
(45), `python3 -m unittest discover -s tools -p 'test_web_menu_videos.py'` (4), the room relay suite in
`tools/cloudflare/rooms`, and `ctest` in `wiicompiled/build-macos` (9).

### How the web build works

All web code is in `wiicompiled/runtime/src/platform/web/` or behind `__EMSCRIPTEN__`.

- Guest threads are JSPI coroutines on one worker (`host_context.cpp`, `mkw_fibers.js`), not
  pthreads. A switch costs about 3 µs.
- Guest memory: `guest_flat_memory_wasm.cpp`, all accesses on the checked page-table path.
  Peak used heap in a race is ~240 MB of the 512 MB initial memory; growth never happens.
- Disc: WASMFS fetch backend with our own JS half (`mkw_fetchfs.js`; the stock one corrupts files)
  reading `site/public/game/` via `game/manifest-v2.txt`.
- User state in OPFS at `/persist` (`web_platform.cpp`); the staged save seeds the NAND once.
  The web build does not save or honour window size/position, rewrites an empty `Config.toml`, and
  forces `dvd_root` to `/game/DATA` (an empty file used to brick the page).
- Firefox needs core WGSL: aurora `gx/shader.cpp` rewrites storage-pointer helpers on the web (with
  a linear scan; the earlier `std::regex` version cost ~6 ms per shader and ~5 s of boot).
- The controls panel follows F10 remapping: `PublishWebBindings()` in `settings_overlay.cpp` sends
  player 1's bindings as JSON to `window.mkwSetBindings`; `[data-bind]` buttons use GameCube button
  keys (a, b, start, l, r, up...) or `axisN`. The sidebar also has master volume and mute.
- Key/mouse taps shorter than a frame latch until the next `PADRead` (aurora `input.cpp`
  `take_taps`). `tools/unlock-all.py` unlocks everything in the staged save.
- Browsers without JSPI or WebGPU get a plain "This browser is missing: ..." message (Chrome 137+
  works; Firefox ESR does not).
- Pipeline prewarm: 1,199 bundled recipes plus this browser's own log are queued at boot and built
  on the render thread within a per-frame time budget (`pipeline_cache.cpp`).
- Render loop: the staging-buffer map wait is a promise resolved by the MapAsync callback and the
  canvas yield is a MessageChannel message (`gfx/common.cpp`, `gfx/staging_map.hpp`, `aurora.cpp`).
  Browsers clamp nested timers to ~4 ms, so the old `emscripten_sleep` polling cost every frame
  ~4.7 ms; under +9 ms of synthetic load the same scene runs at 59 FPS instead of 46.
- Race start: `NANDOpen` shadows the 2.8 MB save before a write open; on OPFS `copy_file` took ~330 ms
  twice, so the web build copies in 1 MiB chunks (`hle/storage/nand_api.cpp`, under 20 ms now).

- Lobby names in the game (2026-10-01): MKW labels every built-in default Mii "Player" and gives it a
  generic face (`Mii::Load` sets a flag at `mii+165` when the Mii's ID is in the default table at
  `0x8024C4D0`; `MiiNameMsgPrinter` and the Racers/globe screens print the literal for flagged Miis),
  and the web build has no Mii database, so every profile's Mii was a default one. When a lobby name is
  set, `AddDatabaseMii` (`web_room_launch.cpp`) copies the profile's default record, with the name,
  into slot 0 of the in-memory RFL database (`*(state+16)+4`, 74-byte records, ID at +0x18; flags byte
  at `state+6972` low two bits must be clear), then flips the default table's IDs off in memory so a Mii
  received from another player is not flagged either (received Miis are rebuilt as source 6 and looked
  up in the default table). The saved licence and Mii ID are untouched and nothing is written to the
  NAND. Verified with two clients (Chrome plus the app pane): both show both names on the Racers screen.
- Race-start warm-up (2026-10-01): a hosted race stalled on blocking disc reads (about one round trip
  each) at load and at GO, from the sound archive (`revo_kart.brsar` blocks at 19-22, 25-27 and
  45-78 MiB) and the race archives. `mkw_fetchfs.js` now warms `Race/Common.szs`, `Scene/UI/Race.szs`,
  `Race_E.szs` and those archive ranges, with a 128 MiB budget, and fetches `.brstm` music streams whole.
  Found by running a Grand Prix against `serve.py`, which now logs the byte range of every request.

### Multiplayer

- Each invite is an isolated Cloudflare Durable Object with up to 12 browser clients. TCP WFC
  services and peer UDP datagrams travel over a WebSocket; no public Nintendo/Wiimmfi service or
  native TCP/UDP access is involved. This is a relay, not WebRTC. Each participant occupies one
  paired lobby/game slot and the lobby shows named participants immediately.
- Use **Create room / Join room / Copy invite**, then Play: `web_room_launch.cpp` uses engine
  lifecycle hooks (after `SectionManager::init`) to load the selected license and Mii through the
  game's own services, set initial section 55, register player 1, run the real
  `RKNet::Controller::Init(1)`, select Worldwide VS and activate native `GlobeSearch` (8F), which
  opens Character Select (6B). It synthesizes no input, calls no automation from `PADRead` and
  writes no saved consent settings. If the save needs attention or no profile/Mii exists it hands
  off to normal manual setup; `?manual` skips direct entry. ABI hooks keep the live `CpuContext`
  across scheduler-yielding service calls (fixed a repeat-login stack crash).
- Verified: two fresh local origins reached Character Select from one Play, matched, voted and
  entered the same race (N64 Bowser's Castle, GCN Peach Beach) with each peer visible; reload and
  Continue-manually cancellation clean up the roster. A parked race disconnects after ~1,800 idle
  frames, consistent with the game's own idle timeout.
- Local pages use the room Worker at `127.0.0.1:8787`; the hosted page uses
  `mkw-rooms.athenaaa.workers.dev`; `?room=ws://...` works for diagnostics.
- Online tabs bypass Aurora's focus/hidden pause path (its 100 ms event wait and GX retries were
  disconnecting background clients). ImGui draws scale to the real render attachment (fixed a
  resize-time WebGPU scissor crash).
- Room code is AGPL-3.0; licence, attribution and setup are in `tools/cloudflare/rooms`. No
  game-derived code or files may be included in that Worker or in git.

### Hosting and assets

- Worker `mkw-web` (`tools/cloudflare/`) serves the private R2 bucket `mkw-web-eu` (Western Europe).
  Access state: see Rules. Never create a Worker under a new name with wrangler (it would have no
  Access); renames go through the dashboard. An empty leftover bucket `mkw-web` (ENAM) can be
  deleted by the owner.
- WASMFS requests paths such as `game//manifest.txt`; R2 keys are exact, so the Worker collapses
  repeated separators. Range responses use the optional `offset/length/suffix` values (a
  `'suffix' in range` test produced `bytes NaN-NaN`). `node --test tools/cloudflare/test/worker.test.mjs`
  covers these.
- The manifest is loaded with one uncached GET and the same bytes are served to C++; an empty or
  invalid manifest shows a Reload/error screen. The hosted URL mounts all 2,038 game files.
- `game/manifest-v2.txt`: `f <size> <path>` files, `u [logicalPath, web-videos/hash.thp]` immutable
  menu-video previews (`tools/web_menu_videos.py` stages 19 video-only previews, 489.9 to 244.9 MB;
  `./tools/stage-web.sh --original-videos` restores the originals), and
  `p [logicalPath, file-packs/hash.bin, offset, size]` records that map 143 unchanged assets of at
  most 64 KiB into one 2,777,464-byte immutable download (SHA-256 checked, shared, saves excluded).
- Fetch backend: video reads stream four 1 MiB chunks ahead; SZS archives up to 16 MiB download at
  the first header read; concurrent requests share in-flight downloads; freed files cannot be
  repopulated; failed prefetches retry. Menu warming fetches common menu/model archives, the first
  16 MiB of the sound archive and 2 MiB of each menu preview (~63 MiB, two background jobs, cap 64 MiB).
- Caching: content-addressed packs/previews are `immutable` for a year; `game/DATA/*` (the
  unmodified disc) is cached privately for a day; manifests, saves, page and loader revalidate.
- Hosted TTFB measured 0.4-0.5 s per request from the US east coast (bucket is WEUR), so serial
  disc reads dominate race loads on a far-away connection.
- The page shows an original bunny backdrop; the owner's own picture is used when
  `site/public/game/background.jpg` exists (gitignored, never commit it).

### Diagnostics (`?log`)

`?log` forwards the console to `serve.py` stdout (or `/log` on the Worker, readable with
`wrangler tail mkw-web --format json`) and turns on, every 3 s: `[web-perf]` frame counts, frames
over 25/50/100 ms, per-bucket timings, the present split (end_frame / schedule wait / yield), map
latency, VI sleep and `busy_per_frame` (frame time minus every sleep: the real CPU load);
`[web-perf] slow frame` for each frame over 40 ms; `[web-prof]` a sampling profile of the guest's
innermost indirect-call target (map addresses with `generated/guest_symbol_table.cpp`) plus one
line per frame over 150 ms; `[web-nand]` for NAND operations over 20 ms; a watchdog line with
context switches, heap, used heap and switch latency. Only compare the same scene (title, attract
video and race differ a lot) and repeat runs: page-load noise is about ±1.5 ms.

Findings on an Apple M5, Chrome 152, 60 Hz: steady racing 60 FPS; mid-race hitches about one frame
over 25 ms per 3 s; no on-demand pipeline builds; no single CPU hotspot (`RaceScene::OnCalc` ~6%,
`G3dProc` ~5%). Race load is a few ~200 ms frames of real work (`RaceScene::CreateAndInitInstances`,
heap alloc, Mii models); the 1.5 s frames at startup are the game's own StrapScene wait.

Tried and rejected: `-sGROWABLE_ARRAYBUFFERS` (WebGPU `setBindGroup` refuses resizable buffers: the
game dies at the first draw), `-sASSERTIONS=0` and fixed memory without growth (no measurable gain).

### Open items and unverified

- Slower hardware, Firefox smoothness, and non-60 Hz displays are untested. The game paces itself
  on its own wall-clock VI timeline (`hle/vi.cpp`), not the display refresh, so 75/120/144 Hz or
  59.94 Hz displays may judder (fix would tie presentation to the browser's frame callback).
- One audio "output queue full" drop was seen in a race (a crackle, not lag).
- A fully driven multiplayer race and a two-machine test.
- Hitches at the start of a new lap, and when new items appear or are used (reported by the owner,
  not yet diagnosed; see HANDOVER.md, known issues 8 and 9, for the likely causes and how to look).
- The owner's scene-over-HUD corruption screenshot (later on a course) has not been reproduced.
- Performance changes from 2026-10-01 were measured only in the app's browser pane; real Chrome via
  the extension was not connected.

## Milestones

The original plan, kept for the reasoning behind the design. M0-M2 are done and their outcome is
in Status above; M3 and M4 are still open (M4 exists as the invite-room relay described there).

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
