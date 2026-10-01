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

The game needs both WebAssembly JSPI and a usable WebGPU adapter. For troubleshooting, first try
current desktop Chrome or Edge and fully restart the browser after updating. A JSPI flag does not
add the implementation to an older browser. Hardware acceleration being enabled also does not
guarantee WebGPU is available: a driver blocklist or the platform can still prevent adapter access.
The page and renderer try the high-performance adapter, the browser's default, then the low-power
adapter. A failed browser requirement stops the loader before downloading and compiling the game.
If enhanced GPU device creation fails, the renderer retries standard device limits without optional
features. If browser saving is denied, the game can use temporary storage and shows a warning;
progress and settings are then lost on reload or close.
Check `chrome://gpu` or `edge://gpu` (WebGPU and Problems Detected), or Firefox's `about:support`
(Graphics). The error page's **Technical details → Copy** includes the browser, both JSPI APIs,
and the WebGPU adapter request result. A GPU model alone cannot identify the cause.

Click a key in the controls sidebar to rebind it after starting the game. The sidebar also has
a master volume slider and mute button; changes are saved when browser storage is available.

Staging prepares browser-only menu previews at about 30 FPS, preserving playback duration and
the retained frames' image quality. Racing still targets 60 FPS. The extracted disc stays intact;
use `./tools/stage-web.sh --original-videos` to stage the original previews instead.

## Private multiplayer

Choose **Create room** in the page's controls, then **Copy invite**. Each player opens that link,
starts the game, and chooses **Nintendo WFC → Worldwide → VS Race**. Matchmaking stays inside the
invite's room. Cloudflare Access is normally what keeps the hosted game private; the owner has
switched it off for the current test window, so check its state before sharing a link.

For local testing, also start the room service in a second terminal:

```sh
cd tools/cloudflare/rooms
npm ci
npm run dev
```

Use separate browser profiles, or `127.0.0.1` for one player and `localhost` for the other, so each
game has its own save. Online tabs keep running in the background, but the original game can
disconnect a player who stays idle during a race.

Two local clients have been verified through a shared race start. Full-race completion with both
players driving and testing on separate physical machines are still pending. See the
[room service instructions](tools/cloudflare/rooms/README.md) for the protocol tests and deployment.

The client processes incoming packets in bounded FIFO batches, so a backlog can be serviced over
several socket calls without repeatedly shifting the entire queue. Race asset warmups use bounded
requests, retry transient failures, and continue through successive Grand Prix courses. These changes
do not alter the room wire protocol or remove Internet latency.

## Race benchmarks

Repeatable multiplayer performance captures, frozen baseline builds and the comparison gate are
described in [BENCHMARKING.md](BENCHMARKING.md). Benchmark URLs can run a scripted controller and
collect both clients' frame times without the diagnostic sampling profiler.

## Private hosting

`tools/cloudflare/` is a Cloudflare Worker that serves the staged build from a private R2 bucket,
with the same headers. It is meant to stay behind Cloudflare Access (only the owner can sign in),
since the bucket holds files from the disc. After staging, upload what changed:

```sh
python3 tools/deploy-web.py            # add --worker to also deploy the Worker
```

See [HANDOVER.md](HANDOVER.md) for the current state, what changed recently and what to do next.
