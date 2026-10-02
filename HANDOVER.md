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
| This repo (page tooling, Worker, notes) | `Minithena/mariokartwebtest`, branch `main`, the GitHub default (on 2026-10-02 it absorbed `claude/vigilant-ride-auy5y2` and both `codex/*` branches, which were then deleted) |
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

**2026-10-02 (morning):** fork `web` `843c6e7`, this repo's `main`. Page, loader, `.wasm` (108,006,071 bytes) and
`.data` uploaded with `deploy-web.py`; all four hosted files SHA-256-match the staged build. Worker and room relay
unchanged. Earlier record below.


Pushed and deployed on 2026-10-01: fork `web` at `52a5043`, this repo's branch at the commit that
adds this file. Hosted `WiiCompiled.wasm` is 122,015,230 bytes; the loader and page HTML match the
local staged files (SHA-256 checked); `mkw-web` Worker version `41c94fe7-a074-45ce-a2d1-04795f0ca1b9`.
The room relay was not changed or redeployed. Not yet opened in a browser on the hosted URL.

## Day-to-day commands

### Local browser compatibility update (2026-10-01)

Built and staged locally; **not deployed** by this change. The existing game data and saves were preserved.

- The page's adapter probe and the renderer (`aurora-main/lib/webgpu/gpu.cpp`) both try
  high-performance, browser-default, then low-power selection. Failure of the preferred request
  no longer prevents an available default/integrated adapter from being used.
- The generated loader sits in an inert HTML template until the asynchronous GPU probe finishes.
  Browsers missing JSPI, WebGPU, isolation, or all three adapter choices do not download/compile
  the large Wasm module. JSPI detection checks both callable `Suspending` and `promising` APIs.
- Combined failures show all remedies. The adapter message no longer labels acceleration as the
  cause. Details include each request result/error and both JSPI APIs; asynchronous adapter info
  refreshes an already visible report. Clipboard rejection gets a manual-copy instruction.
- Validation: web build succeeded; 76 frontend/hosting tests passed. Browser fixtures exercised
  default and low-power page selection and the unsupported-browser gate. In a live browser test,
  high-performance requests were deliberately forced to return null in both the page and loader
  worker; the actual rebuilt game selected the browser-default adapter and rendered its title screen.
- The reported RX 5700 XT machine was not tested. A driver/browser blocklist can still deny every
  adapter. This runtime still requires JSPI for guest fibres; a non-JSPI/Asyncify build needs an
  alternative fibre implementation and performance/memory validation, rather than a flag change.

Follow-up compatibility work (local, not deployed):

- A rejected enhanced device request now retries with a fresh adapter, core device limits and no
  optional features. The renderer reads its enabled texture limit and BC-compression support from
  the created device. Device-loss callbacks carry request generations so a late FailedCreation
  from a rejected request cannot mark the replacement device as lost.
- The initial pthread pool is eight instead of 24; PROXY_TO_PTHREAD permits additional workers
  to be created through the browser main thread. The 512 MiB initial Wasm memory is unchanged.
- The page probes persistent saving before loading the runtime. Denied/missing storage selects
  the existing memory filesystem through MKW_WEB_SESSION_STORAGE, with a visible warning that
  progress and settings are lost on reload/close. Binding guidance follows that storage mode.
- Validation: web build and native aurora_core build succeeded; 84 frontend/hosting tests passed.
  A Chromium browser test deliberately rejected enhanced device requirements and denied saving;
  the repaired core-default device rendered the title/attract scene. Firefox 156 also loaded and
  rendered the game on the same Apple-silicon Mac. These are startup/rendering checks, not full-race
  or cross-machine acceptance.
- Safari 27 passed feature detection and pipeline prewarm but failed at the first game scene with
  `WebGPU error 2: encoder state is not valid`. A bounded command trace showed balanced pass
  begin/end calls; operation scopes reported the failure at encoder finish. The cause is unresolved,
  so Safari must not be called supported. The temporary tracing/scoping loaders were diagnostic
  fixtures only and are excluded from the staged build. No WebGL backend was added.

### Loading and multiplayer queue update (2026-10-01; local)

Not deployed. `mkw_fetchfs.js` now separates related-file discovery from warmup state: reading a
course that was prefetched by its predecessor continues warming the next Grand Prix course.
Failed warmups can retry with 1–10 second backoff, and evicted files can be warmed again. Selected
roster assets take the next free slot ahead of speculative course/music jobs; at most six race
warmups run concurrently. New demand fetches request high priority and background fetches low
priority; these are browser hints. Demand reads do not wait for a warmup scheduler slot and still
share in-flight downloads.

`web_vnet.cpp` uses a head-indexed incoming FIFO, releases consumed payloads immediately and
compacts periodically. Each connected pump processes at most 128 packets and approximately
256 KiB (one final packet can cross the byte threshold), leaving the rest queued. Socket calls and
the per-frame pump continue draining it. The original 8,192-message/16 MiB limits, owned outgoing
bytes, wire format and terminal full-drain/disconnect behaviour are preserved. Existing per-socket
UDP overflow behaviour is unchanged; no new dropping or prioritisation of wire packets was added.

Tests cover course-chain continuation, retry backoff, cache eviction, final-lap cache hits, bounded
warmups, demand reads while warmups are stalled, and selected-asset priority. Network queue tests
cover 6,000 mixed ordered messages, compaction/limits, byte accounting and send-buffer ownership.
The standalone compiled socket adapter test delivers 1,310 ordered TCP payloads, checks both pump
budgets and final data at disconnect. Run it after sourcing emsdk:
`python3 tools/test_web_vnet_native.py`. No game data is used by that test. The relay remains
unchanged. Full driven races across two physical machines remain unverified.
Final checks: 98 frontend/hosting tests and 17 room relay tests passed; the socket harness and full
web build succeeded. Only the normal compiled build is staged; test outputs use temporary directories.

### Commands

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

## Later on 2026-10-01 (pushed and deployed; fork web 3e63179, wasm 122,019,767 bytes)

- **Lobby names in the game** work (see CLAUDE.md, "Lobby names in the game"). Smoke-tested on the hosted
  site with one client (room, character select, matching); a two-client name check there is still to do.
- **Race-start stalls on the hosted site**: the warm-up now covers the sound-archive blocks and race
  archives a race fetches at load and at GO (CLAUDE.md, "Race-start warm-up"). Measured only by request
  logs locally; the hosted effect is unmeasured. Mid-race, the next course (about 2.7 MiB) is still
  fetched on demand, and a race still reads about 12 small kart archives one by one at load.
- **First visit in a cold browser compiles shaders for ~67 s** (real Chrome, hosted): 1,199 pipelines,
  the game waits on "Compiling shaders". A reload takes 2.6 s (Chrome's own shader cache). Idea: start
  the game once the title/menu set is built and finish in the background, or say "first visit only".
- OPFS allows one open handle per file, so a second page on the same origin cannot open
  `web_pipelines.bin` ("new pipelines will not be remembered"); two-tab tests should use two origins.
- The in-app pane renders only while it is displayed (no animation frames when hidden); real Chrome
  through the extension works, and the extension and pane together give two visible clients.

## Stutter pass, 2026-10-01 night (fork `web` 143272a, pushed and deployed: wasm 122,019,929 bytes, hashes checked, Worker unchanged)

A disc read blocks the whole game (the guest thread suspends on the fetch), so on the hosted site every
file that is not yet downloaded costs one 0.4-0.5 s round trip. Changes, all in `mkw_fetchfs.js` unless noted:

- **Final-lap music**: the first read of a course's `*_n.brstm` also starts a background fetch of its `*_f.brstm`
  sibling (2-17 MiB, matched case-insensitively). Verified locally: `n_Circuit32_f.brstm` is requested with the `_n`.
- **Next Grand Prix course**: the first read of a course file also fetches the next course of its cup (table
  `NEXT_COURSE`; nitro cups are certain, the retro cup order is from memory). Locally the game used to read
  the next course 7 s into the race; it is now fetched with the race load. Triggered on a data read, not on
  `describe`: the game stats every course at boot and a first version prefetched ~35 MB from that.
- **Streams up to 32 MiB** (was 8) are fetched in one request; the 21 MB Factory stream was going chunk by chunk.
- **`[web-disc] read took N ms: <file> +offset (bytes)`** (dvd.cpp, `?log`, reads over 30 ms): a `?log` console
  export from a hosted race now names the files behind lap and item hitches (known issues 8 and 9).

Not changed: the 67 s cold-browser shader wait. Only ~350 of the 1,199 bundled pipelines are first used in the
title and menu frames (`first_frame_used` below ~5000 in the seed); the boot gate (`UpdateBootShaderState` in
`settings_overlay.cpp`) waits for all. Releasing it early is the obvious win, but unfinished pipelines may drop
draws, so it needs a cold-browser test. The hot guest addresses in `[web-prof]` are idle waits
(`OS::ReceiveMessage`, `GX::CopyDisp`), not CPU. In the hidden app pane, 200-600 ms stalls appear in the
post-present step with ~10 ms of guest time; they may be pane throttling, so confirm in real Chrome.

### Second pass: boot and menus under simulated latency (fork c3125ce, deployed; loader only, wasm unchanged)

`python3 tools/serve.py site/public --latency-ms 450` delays every `/game/` response like a far-away host, so
each blocking disc read shows as a `[web-disc]` line (a fast local disk hides them; the browser's own HTTP cache
hides repeats on the hosted site, and on the hosted site from London the real cost of an uncached read was
90-410 ms). Measured with it: boot and menus stalled ~13 s on serial reads (StaticR.rel 2.3 s as five chunks,
HomeButton.arc 1.4 s, then single ~460 ms reads of a dozen start-up files, the title video start, the two
fanfares and the picked character's kart-select model). Fixes in `mkw_fetchfs.js`: the nine start-up files are
requested at once on mount, `.rel`/`.arc` up to 8 MiB are fetched whole, and the menu warm-up adds the title
video start, `o_Crs_In_Fan`/`o_Start32_fan` and every `*-allkart.szs` (budget now 160 MiB). Result: boot plus
menus show no read over 38 ms.

Still there, found the same way: a race load reads about 12 opponent kart archives (`Race/Kart/<vehicle>_kart-<driver>.szs`,
~130 KB each, 1,528 files / 178 MB in all, so they cannot be warmed) one after another, ~470 ms each at 450 ms
latency, plus the course and the music stream: about 6.6 s on the loading screen there (maybe 2-3 s on the real
host). The guest runs its own `DVDOpen`, so the C++ DVD layer only sees reads; the way in is to hook
`ArchiveMgr::RequestLoadKartArchives` (0x80542210, queues every player's archive) and prefetch all the paths at
once. (Correction: a hook mechanism exists, see "Real-time simulation" below; and 0x80542210 turned out to be the
menu `*-allkart.szs` loader, not the opponent files.) No read blocked during ~40 s of driving after the
start, but that run did not prove an item was picked up.

### Third pass: asynchronous pipeline prewarm (fork f2e90d4, deployed, hashes checked)

Prewarm used one blocking `CreateRenderPipeline` per frame (`build_synchronous_pipelines_for_frame`, at least one
per frame even over budget). On a cold GPU shader cache each takes ~50 ms, so the first-visit "Compiling shaders"
screen took ~67 s in real Chrome. GX pipelines (1,193 of 1,199) now go through `CreateRenderPipelineAsync`
(`gx::create_pipeline_async`, `build_pipeline_async` in `gx.cpp`; up to 24 in flight, finished in their callback,
blocking create as the fallback if creation fails); draws that need one still in flight use the existing on-demand
path. Verified: fresh origin, all 1,199 finish (2.0 s vs 3.1 s before), no failures, attract race renders, hosted
page boots. **Not measured:** the gain on a truly cold GPU shader cache (the app pane's cache was already warm).
Ask for a first-visit time from a friend's real Chrome, or try a fresh Chrome profile.

Also learned: the quickest way to a stall list is `serve.py --latency-ms` plus `tee` of its output to a file;
the pane's log reader filters on whole chunks, so a file with `grep` is easier. Hosted boot and menus: loader only.

### Race-load investigation, 2026-10-01 (nothing changed in code; findings only)

Measured a 50cc Mushroom Cup Grand Prix (Mario, Standard Kart M, 11 opponents) in the app pane against
`serve.py --latency-ms 150`, console via `?muted&log`:

- **Disc reads dominate the load.** After `Scene Exit`, about 15 consecutive frames take ~165 ms with 94-97%
  of guest samples in `0x8015e834` (`DVDReadPrio`). That is the course (`beginner_course.szs`, 2 MB) plus
  12 opponent archives `Race/Kart/<vehicle>_kart-<driver>.szs` (100-150 KB each), read strictly one after
  another, each costing one round trip (~158 ms here). The game's own CPU work in the load is small: one
  ~190 ms frame (`RaceScene::CreateAndInitInstances`), then ~50-110 ms ones. Cost scales with latency:
  ~13 round trips, so about 2 s at 150 ms, 6+ s at 450 ms.
- **The "no hook mechanism" note was wrong.** `MKW_STATIC_TRANSLATED_CALL` (emitted by
  `TranslatedBuildShardEmitter.cs`) runs `TryHandleRuntimeCall` and `ApplyRuntimeCallOptions` before every
  static call, and `abi_bridge.h` already uses it for web code (`WebRoomLaunch::BeforeGuestCall`). A web-only
  check on a target address is a few lines there.
- **The obvious target is the wrong function.** `ArchiveMgr::RequestLoadKartArchives` (0x80542210) is called
  once per player slot (r4 = slot, r5 and r6 stored at slot+1468/+1472), then queues
  `LoadKartArchiveAsync` (0x80541E44) on the task thread. Its name table (0x808B0000+14992, ids below 48) is
  for the `*-allkart.szs` menu archives, which the menu warm-up already fetches. The per-opponent files are
  built from the format `Race/Kart/%s%s-%s%s` (vehicle name + `_kart`/`_bike`, driver name, split-screen
  suffix `""`/`_2`/`_4`) in StaticR.rel, used near `ArchiveMgr::LoadKartArchive(playerId)` (0x80540E3C),
  `GetKartArchivePrefix` (0x805419EC) and `GetKartArchivePostfix` (0x805419C8). Hook one of those (they know
  the final per-player name) or the roster setup before them.
- **Fix, in order of value:** (1) at the hook, ask `mkw_fetchfs.js` to fetch all the players' archives at
  once (12 round trips become ~1); (2) hook earlier, when the roster is fixed (at "Start?"), so they are
  already there when the load begins; (3) the course read could be prefetched with the cup choice. A larger
  structural fix would let a pending disc read yield to the other guest threads instead of suspending the
  whole game (reads are issued from the JSPI context that waits; the scheduler never runs meanwhile), but
  it changes thread interleaving and is risky for online play.
- Test recipe: `python3 tools/serve.py site/public --port 8011 --latency-ms 150 | tee <file>`, load
  `WiiCompiled.html?muted&log`, click Start, then (confirm = left click on the canvas) title, Single
  Player, Grand Prix, 50cc, Mario, Standard Kart M, Automatic, Mushroom Cup, OK. Note the line count of
  the file before OK; `grep Race/Kart` after it lists the reads in order.

### Real-time simulation and no lobby slow-down (2026-10-01; fork `web`, deployed with this section)

- **Why a slow player slowed the room** (known issue 10, partly): the game counts, per player, the frames that
  player lagged, sends the count in the race header, and every client that sees a higher count than its own idles
  one frame and raises its own (`RKNet::PacketMgr::ProcessLagFrames` 0x80654B00, flag at scene+9529, consumed in
  `GameScene::calc` 0x8051B3C8). So the whole room ran at the slowest player's speed. `web_guest_hooks.cpp` skips
  that function (default; `?lagwait` restores it). **Read from the game's code, not tested with two real clients.**
- **Real-time simulation** (default; `?nocatchup` turns it off): the game steps its simulation once per loop
  iteration (`RKSystem::Run`: wait, draw, copy/present, calc), so a late frame meant slow motion. When the wall
  clock is a step or more ahead of the race steps, the scene draw (`RKSceneManager::draw` 0x80009988) and the
  `GXCopyDisp` present are skipped (at most 5 in a row, races only, detected by `RaceScene::OnCalc` 0x80554E6C) and
  the VI timeline is moved back one period (`WebPacing::BorrowRetrace`, vi.cpp) so the next waits return at once; if
  the game slept at least 3 ms in an iteration it is ahead and owes nothing. Measured in the app pane on an M5 with
  `?burn=12` (extra cost per drawn frame): 46-48 steps/s without, 60.0 with, drawing ~45 fps; healthy: 60 steps,
  60 drawn, 0 skipped. Not measured: a genuinely slow machine, or one whose CPU cannot do the game logic at 60/s
  (draw_guest_ms ~3 ms and render ~3 ms of ~8.7 ms busy per frame here, so the upper bound is about 2x headroom).
- Hook mechanism: `TryHandleRuntimeCall` in `abi_bridge.h` matches a **compile-time** list of guest addresses (so
  the ~100k generated static calls fold it away; a runtime-slot version grew the wasm by 7.8 MB) and calls
  `WebGuestHooks::Handle`. Editing `web_guest_hooks.h` rebuilds every translated function (~3 min); put anything
  new in `web_pacing.h` instead. `?pacetrace` prints the first 240 race iterations (dt, idle sleep, fractional lag).
- `?log` adds a `[web-pace]` line: race steps/s, drawn/s, skipped/s, step_ms (one simulation step), drawn_ms,
  draw_guest_ms.
- **Browser pre-flight** (shell.html): asks for a WebGPU adapter before Start and says why when there is none (no
  API: advice per browser family; API but no adapter: hardware acceleration/driver/VM), plus a "Technical details"
  box with a Copy button. Out-of-memory aborts get their own advice. Firefox users hit
  `InternalError: out of memory` / "failed to allocate executable memory for module" (32 GB RAM, Linux Mint, so not
  RAM: Firefox's cap on compiled code for a 122 MB module; reloading does not free it). MAXIMUM_MEMORY lowered from
  4 GiB to 2 GiB. Candidates, unproven: fewer pre-started workers (`PTHREAD_POOL_SIZE=24`, about 8 are used), a
  smaller module.
- JSPI: Safari 27 added it (MDN data, merged 2026-09-16) and Safari 26+ has WebGPU, so Safari 27+ may now work; untested.

### Smoother draw rhythm, race-load prefetch, trick label (2026-10-02; fork `web`)

- **Players reported "fps better but shaky".** Skipping a draw on demand makes the next frame show two simulation
  steps and every ~5th frame take longer. Now the game measures what an iteration costs with and without a draw
  (EMAs, `work_ms(draw/skip)` in `[web-pace]`) and, when more than a fifth of the draws would have to go, draws on a
  fixed rhythm instead: every 2nd, 3rd... step (`draw_every=N`). Mild lag still skips on demand. Measured with
  `?burn=20` (a drawn iteration ~32 ms): `draw_every=3`, 59.9-60.0 steps/s, a perfectly regular drawn/skipped/skipped
  cycle (20 fps, steady). Healthy: `draw_every=1`, 60/60. The 20% threshold is a judgement call; ask players for a
  `?log` export (F12 console, filter `web-p`, right-click, Save as / Export) before tuning further.
- **Race-load prefetch** (`web_race_warm.cpp` + `listenForPrefetch` in `mkw_fetchfs.js`): the first read of a course
  file reads the roster from guest memory (race scenario pointer at 0x809BD728, player count at +36, 240-byte
  records, vehicle +48, character +52; name tables at 0x808B3B50 vehicles, 0x808B3A90 drivers, kind table 0x808B3BE0
  = "_red", "_blue", "" (the game uses index 2 except in team modes 3/9/10 where it uses record+244), suffix table
  0x808B3BEC) and posts the 12 `Race/Kart/<vehicle>-<driver>.szs` paths over a `BroadcastChannel` to the fetcher,
  which starts all the downloads at once. At 150 ms simulated latency: 12 serial ~160 ms stalls (~1.9 s) became 0.
  Left: the course file itself (0.3-0.5 s) and the first music-stream read (~0.17 s); the course is known when the cup
  is picked, so it could be fetched then. Split-screen suffix and team-mode names are not prefetched (they load as
  before). Worker consoles are not forwarded by `?log`; the `[web-warm]` line is, and the proof is in the server log.
- **Tricks:** the web build presents a GameCube controller (no motion option). A trick is the D-pad (arrow keys), not
  R; the controls panel said right-click did "Drift, hop, trick" and now lists "↑ Trick (in the air, as you leave a
  ramp)". Read from `GCNController::UpdateImpl`; not verified in play.

## Race CPU pass, 2026-10-02 night (fork `web` e8b61f8 .. 843c6e7; pushed and deployed 2026-10-02)

Measured in the app pane (Apple M5, Chrome 152) on the Mario Circuit 1:44.178 ghost replay, `?log`
`busy_per_frame` over the race windows; baseline is fork `a033aa6`. One run each unless noted.

| Build | CPU per frame | Renderer seal | Notes |
| --- | --- | --- | --- |
| a033aa6 (baseline) | 5.88 ms | 1.39 ms | |
| e8b61f8 | 4.33-4.41 ms | 0.07 ms | -25%; menus 4.5 -> 3.0 ms |
| ae53a10 | 4.55-4.58 ms | 0.07 ms | same within noise; 12-kart 150cc GP ~6.0 ms |

1. **Staging copy (the big one).** emdawnwebgpu backs a write-mode `GetMappedRange` with its own wasm-heap block
   and copies the whole block into the JS mapping on `Unmap`. Aurora mapped its 37 MiB staging buffer every frame,
   so every frame did a 37 MiB `memalign` + copy + `free` however little was drawn. The web build now records into one
   persistent heap block and copies only the used bytes with `WriteMappedRange` (`gfx/common.cpp`,
   `g_webStagingShadow`). Expect a larger gain on machines with slower memory than the M5.
   Tried and rejected: `queue.writeBuffer` per ring and no staging buffers at all (4.88 ms: each call costs more on
   the game thread than writing into the mapped buffer).
2. **Resolved guest ranges.** The translator groups accesses through one base register into a resolved range;
   `ResolveRangeHost` returned null on wasm, so ~180k such accesses went through an out-of-line fallback. It now
   resolves through the 1 MiB bias tables (`memory_access.h`). Safe because ranges end at every memory-epoch boundary
   (calls that can suspend, switch threads or run guest code) and `RegisterDeferredRead` has no callers. With the
   sparse sub-page store tier moved out of line, `WiiCompiled.wasm` went from 122.0 MB to 108.0 MB.
3. **Compact staging rings** (web only): 2/6/1/3 MiB instead of 3/24/2/8 MiB, about 3x the largest per-frame use
   seen in a 12-kart Grand Prix (566 KiB / 1.8 MiB / 367 KiB / 836 KiB). No CPU change on the M5; saves ~75 MB of
   GPU buffers and 25 MB of wasm heap, and the browser no longer has a 37 MiB mapped range to move per frame.
   Overflow splits the batch as before; `?log` prints `[web-perf] staging high water ... splits=` (0 in races).
4. **Pipeline seed 1,199 -> 1,784** (`runtime/assets/pipeline/initial_pipeline_cache.db`): merged the native
   cache from the M0 session (260 new) and this pane's `web_pipelines.bin` (325 new, all `msaaSamples=1`). In a
   fresh origin, boot + menus + the whole ghost race now record **0** on-demand pipelines (~180 before) and there
   was no slow frame during the race. Warm-cache prewarm: 1,706 unique pipelines in 2.8 s. Cold-cache boot is
   longer in proportion; unmeasured. To repeat: read `WiiCompiled/Cache/web_pipelines.bin` from OPFS on a
   non-game page of the same origin (records: u32 type, u32 version, u64 hash, u32 size, config blob; the loader
   re-checks the XXH3 hash) and insert rows not yet in the seed.

5. **Course fetched at the pick** (`web_race_warm.cpp` `OnFrame`, called from `GX__CopyDisp`): RaceConfig keeps
   the race being set up at +0xC10 (course ID at +0xB48; the race scenario at +0x20 is copied from it at load). A
   new value stable for 30 frames (the boot default is skipped) posts `Race/Course/<name>.szs` over the existing
   prefetch channel. At 150 ms simulated latency, confirming Moo Moo Meadows fetched `farm_course.szs` at once and
   the race load read it with no stall. The attract demo also triggers it for its own courses (harmless: it loads
   them anyway). Course music is NOT prefetched: only 14 `n_*_n.brstm` names exist for 42 courses, so the mapping
   is not derivable from the course name; the first stream read is still one round trip (169 ms at 150 ms).
6. `?log` adds `[web-perf] memory slow paths per frame` (sparse sub-page stores, slow reads/writes, resolved-range
   fallbacks): all 0 once a race runs, so the guest memory path is clean.

Tried and rejected this night: translated shards at `-O3` (4.54 vs 4.55-4.66 ms, no change; note the target's
`-O2` overrides the global `-O3` because it comes later on the command line); `queue.writeBuffer` (above). The
benchmark's `autodrive-v1` recipe walks the single-player menus by itself (A pulses) into a 50cc Mushroom Cup Grand
Prix, but its fixed weave wedges the kart against the first wall of Luigi Circuit, so it is useless for item or lap
coverage. Replays loop straight back to the countdown and hide the timer, so a replay cannot show 1:44.178; the loops
repeated at the same ~115 s cadence (the ghost completes the course), and no change touched FP semantics.

Where the remaining time goes (diagnostic build with `web_guest_profile.h` set to 1; `[web-gprof]` self and
inclusive profiles, attribute host work to the guest function that called it): in the ghost race ~42% of the
frame is the idle VI wait and ~34% the present call (mostly pacing). Simulation ~12% (~2 ms: race instances,
kart physics, scene-graph update) and drawing ~9% (~1.5 ms: nw4r model/material drawing; the GX display-list
HLE shows as `ResShp::CallPrePrimitiveDisplayList` self time, ~0.4 ms). No single guest hotspot is left.

Measuring recipe that worked: `race_benchmark.py snapshot` per build, serve each with `record --mode ghost` (a
helper restarted it per run), drive the menus with the benchmark panel's **Confirm** button and the arrow keys
(the panel's held direction buttons move two rows), add `&log` for diagnostics. **Touch the snapshot's
`WiiCompiled.*` before serving an older build after a newer one:** `serve.py` answers `If-Modified-Since` with
304, so the browser mixed a cached newer `.wasm` with an older loader (`LinkError ... emwgpuBufferWriteMappedRange`).
The benchmark's own "busy" (interval minus VI idle) still counts the present pacing wait, so it barely moves when
renderer work shrinks; use `?log` `busy_per_frame` for CPU. The pane's screenshots lag the canvas by tens of
seconds at boot while the game already runs at 60 FPS; the game boots in ~13 s.

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
8. **Hitches or stutters at the start of a new lap** in a race (reported by the owner, not yet
   diagnosed). Likely candidates, unverified: the final-lap music (the faster `_F` stream, which a
   hosted race fetches on demand) and lap jingles and HUD data read for the first time, each a blocking
   disc read of ~0.4-0.5 s on the hosted site; compare with a local run to separate fetch cost from
   frame cost. Reproduce with `?log` over several laps and look at `[web-perf] slow frame` and
   `[web-prof] slow frame` lines lining up with the lap change.
9. **Hitches or stutters when new items appear or are used** (reported by the owner, not yet
   diagnosed). Likely candidates, unverified: effect pipelines for an item that are not in the
   bundled seed (they are built the first time they are drawn: single present stalls of 40-490 ms were
   seen at race start, and a browser remembers them only for its next visit), and item models, effect
   archives or sounds read from the disc for the first time. Use `?log`, collect a race that uses many
   different items, and check whether the slow frames are `present` (pipeline) or `DVDReadPrio` (disc).
10. **Players on slower machines run in slow motion, which shows up as rubberbanding for their
    friends** (reported by the owner: friends with low FPS are slower). Not a netcode problem. The game
    steps its simulation once per presented frame, and `hle/vi.cpp` deliberately presents a late frame
    at once instead of catching up ("keeps a heavy scene at e.g. 50 fps instead of hard 30"), so a
    machine at 40 FPS runs the race at about two-thirds speed. The web build already renders at the
    lowest setting (native 1x), so there is no cheap quality knob; the cost is mostly the game's own
    code (~8-9 ms of CPU per frame on an Apple M5). Options, none built: get a friend's `?log` export
    to see where their time goes (known issue 1); skip drawing some frames while behind so the
    simulation keeps real time (saves only the encode and present cost, and has to leave alone
    anything rendered into textures that later frames reuse; test with `?burn=<ms>` and compare the
    race timer with wall-clock time); an on-screen "running at N% speed" indicator beside the FPS
    counter; speed up the game code. Advice for affected players: Chrome, plugged in on high
    performance, hardware acceleration on, other tabs closed.
11. M3 (players bring their own disc) is deferred at the owner's request.

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

## Benchmark harness, 2026-10-01 (local, not deployed)

`BENCHMARKING.md` and `tools/race_benchmark.py` describe frozen build snapshots, per-step/per-present
captures, paired repeat comparisons and explicit finish/visual/sync observations. `perf-results/`
is ignored and contains compiled snapshots plus raw observations; never commit or upload it.
The runtime collector uses `?benchmark` without `?log`, so the sampling profiler stays off.
Native race stage, course, engine class, game mode and player count identify the measured workload.
Result export waits until all clients finish, avoiding export-induced peer frame spikes.

Use the existing Mario Circuit 1:44.178 **spectated ghost** as the deterministic driving baseline;
keep multiplayer verification in a separate cohort. `ghost-v1` only offers held menu buttons and
does not supply racing input. Normal game URLs have no scripted controller. `autodrive-v1` is an
online movement stress recipe that hits walls; it is not full-race or item/lap coverage.

Live smoke evidence: two online Chrome clients with +12 ms CPU work per drawn frame on the peer
recorded 600 active-racing steps each; peer ~29.3 presentations/s, host ~58.8, with bidirectional
peer UDP. This is `perf-results/pilot-slow-peer-v2-20261001.json`, a pilot from an older collector
schema, not an optimisation cohort or a complete multiplayer race. The earlier title-demo capture
was correctly rejected as not a ghost replay and saved as `ghost/setup-rejected-title-demo.json`.

Latest frozen build: `perf-results/builds/instrumented-baseline-v3b-20261001`. The ghost run setup is
served on localhost port 8013, with a temporary Chrome incognito tab at session
`157be5f9-3b14-4846-b1f5-197cdb6df421`. It reached the licence/main-menu setup, then the Mac locked.
**No accepted reference-ghost capture or repeated baseline cohort exists yet.** Unlock, select
Time Trials → Mario Circuit → the personal 1:44.178 ghost → Watch Replay, collect repeated runs and
observe actual finishes before annotating validation. Do not count the attract demo or unit fixtures.

Validation at this point: web/native builds compiled, 97 JS tests, 14 Python tests, 9 native tests
passed, and the local room relay's 17 tests plus its live 360-datagram smoke passed. Other changes
to browser startup/GPU compatibility and fetch prewarming are being made concurrently; preserve
them and identify the measured binaries by their saved SHA-256 values. No FPS optimisation has
been enabled as part of this benchmarking work. The source checkpoint is committed on
`codex/race-performance-benchmarks` in both repositories; nothing was pushed or deployed.
