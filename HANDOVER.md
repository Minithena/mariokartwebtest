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
