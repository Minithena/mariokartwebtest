# Multiplayer race benchmarks

Use two complementary workloads: spectate the saved reference ghost for a deterministic driving
route and physics/rendering baseline, and run two real game clients in one invite room for online
peer/lag verification. Ghost replay does not exercise multiplayer traffic. Both multiplayer clients
run the normal WFC/peer protocol and render a race. A relay-only packet test, a title movie, or an
audio-kernel microbenchmark cannot establish race FPS.

The collector is opt-in. Normal game URLs do not start it or the scripted controller. Benchmark
URLs capture each simulation-step interval and each presentation-completion timestamp. They keep
frame skipping separate from simulation speed, and record online checks, peer UDP activity,
WebSocket send backlog, receive backlog, disc-read time, VI sleep, and the existing frame buckets.
These are **submission/presentation intervals**, not physical monitor scan-out measurements.
Guest/present buckets include waits; do not label them CPU-only execution time.

## Prepare and freeze the baseline

Run from `mariokartwebtest`:

```sh
source ../tools/emsdk/emsdk_env.sh
cmake --build wiicompiled/build-web --target WiiCompiled -j 4
./tools/stage-web.sh
python3 tools/race_benchmark.py snapshot --output perf-results/builds/baseline
```

The snapshot copies the compiled files, manifests and save seed; it links the local disc and
content-addressed assets. It stays in the git-ignored `perf-results/` directory. Never upload it
or add it to git. The benchmark source is on `codex/race-performance-benchmarks` in both repositories.
Binary SHA-256 values identify the actual measured build, including any uncommitted changes.
Rebuilding or staging the candidate cannot replace the frozen baseline binary.

Start the existing room relay separately:

```sh
cd tools/cloudflare/rooms
npm ci
npm run dev
```

Finish all builds before taking measurements. Close other game instances. Use a stable power mode
and the same browser versions, window sizes, graphics settings, course and player count. Keep both
game windows visible; a selected tab in a hidden app pane is not a reliable baseline. Separate
origins (`127.0.0.1` and `localhost`) isolate the two browser saves.

## Workloads

| Workload | Capture | Purpose |
| --- | --- | --- |
| Spectated reference ghost | 300 warmup steps, 1,800 measured steps | Repeatable real driving and physics/rendering checks |
| Healthy online race | 300 warmup steps, 1,800 measured steps | Normal multiplayer frame-time spikes |
| Slow peer | Same, with `--peer-burn-ms 12` | A costly player and its effect on the healthy peer |
| First-use stress | Zero warmup, up to 5,400 measured steps; declared cold/warm state | Item, music, pipeline and asset hitches |

An added `burn` is CPU work per **drawn** frame. It does not emulate a slow GPU, a low-memory
machine, Wi-Fi loss, or Internet round-trip time. Local two-client tests share the Mac's CPU/GPU;
they exercise multiplayer and contention but do not prove performance across two physical machines.
The record command binds localhost only. Separate-machine testing needs an explicitly configured
isolated host/tunnel; this tool does not expose the disc over a network automatically.

`autodrive-v1` supplies a versioned GameCube controller recipe: short confirm pulses during room
setup, then acceleration, timed steering and item-use pulses based on **simulation steps**. It
changes no stored bindings and runs only at benchmark URLs. It is a movement stress recipe, not a
competent racing AI: crashes and missed item boxes are expected. Confirm the course actually chosen
by the normal voting UI. Stop scripted input with the result panel's button to finish/review manually.

`manual-v1` leaves controls to the players. Use it for a full driven race and item/lap-specific
stress. Record the route and actions in validation notes; variation requires more repetitions.
The script does not automatically reproduce random item outcomes or a fixed Internet condition.

`ghost-v1` supplies no racing inputs. The game's own ghost playback follows the saved route.
The benchmark panel provides held Confirm/Back/direction buttons for menu setup only; these stop
injecting input when the race becomes active. Native race mode/player-type checks reject a normal
race labelled as a ghost replay. Native course ID, engine class, game mode and player count must
also match across repetitions/builds, protecting comparisons against changing the course or load.

## Spectate the reference ghost

```sh
python3 tools/race_benchmark.py record \
  --public perf-results/builds/baseline \
  --output perf-results/ghost/baseline-01.json \
  --label baseline --pair-id 01 --mode ghost \
  --workload mario-circuit-reference-v1 --course 'Mario Circuit' \
  --input-recipe ghost-v1 --host-device 'M5 Chrome' \
  --expected-ghost-time 1:44.178
```

Open the printed URL, start the game, choose the licence with the saved ghost, then Time Trials →
Mario Circuit → the personal 1:44.178 ghost → Watch Replay. Use the benchmark panel's held menu
buttons if short synthetic keyboard/mouse taps do not register. Let playback finish. Capture
starts automatically after GO and warmup; the normal game supplies all driving.

After observing the finish and visuals:

```sh
python3 tools/race_benchmark.py validate perf-results/ghost/baseline-01.json \
  --race-finished --visual-pass --ghost-time 1:44.178 \
  --notes 'Observed the reference ghost finish and reviewed rendering.'
```

`--observer agent` records agent UI observation explicitly; it does not turn it into a human check.
Keep ghost and multiplayer results in separate cohorts. Repeat the same ghost/camera view before
and after optimisations, then verify the candidate with the multiplayer workload below.

Before warm-cache measurements, run that workload once without counting the result, then reload.
For genuinely cold browser/driver shader caches, use a fresh browser profile and label it separately;
zero warmup alone does not clear a GPU cache. Do not mix cold and warm measurements.

## Capture paired repetitions

```sh
python3 tools/race_benchmark.py record \
  --public perf-results/builds/baseline \
  --output perf-results/healthy/baseline-01.json \
  --label baseline --pair-id 01 \
  --workload online-luigi-v1 --course 'Luigi Circuit' \
  --input-recipe autodrive-v1 \
  --host-device 'M5 Chrome host' --peer-device 'M5 Chrome peer'
```

Open the two printed URLs in separate visible browser windows and press **Play online** in both.
They join one disposable local room. Recording starts after GO (the game's active-racing stage),
after the configured warmup; it ends after a fixed number of simulation steps, not a wall-clock timer.
The same simulated section is therefore covered even if a client runs in slow motion. The warmup
counts active racing steps only. Leaving that phase before capture completes makes the run incomplete.

Both reports are written into one JSON result. Keep the server running until both clients finish.
Large result cloning, file hashing and saving wait until both measurement windows end, so exporting
the healthy client's data cannot add an artificial hitch to a slower peer's window.
It rejects duplicate reports instead of overwriting an earlier player's result. Stop it with Ctrl-C
before starting the next repetition on the same port. Use new filenames for every run.

Repeat with the candidate snapshot, `--label candidate`, the same `--pair-id`, and all other options
unchanged. Alternate baseline/candidate order (AB, BA, AB, BA, AB) to reduce warm-cache and thermal
drift. **Five pairs are recommended; three pairs are the minimum.** Repeat the healthy, slow-peer
and first-use workloads separately. Add `--scenario slow-peer --peer-burn-ms 12` for the slow-peer
cohort; the healthy peer has no artificial load.

Do not add `?log`, `?netlog`, or `?pacetrace` to measured URLs. Those start extra diagnostics and
make a capture invalid. Use a separate diagnostic run to attribute a reproduced slow frame.

After actually finishing and reviewing both clients, attach the human observation:

```sh
python3 tools/race_benchmark.py validate perf-results/healthy/baseline-01.json \
  --race-finished --visual-pass --sync-pass \
  --notes 'Observed course, both race finishes, peer motion, HUD/effects and any exceptions.'
```

These flags are an explicit UI-observation attestation (human by default), not an automatic correctness test. Do not supply
them merely because frames were collected. For changes to translated maths, also replay the
existing Mario Circuit reference ghost and confirm its **1:44.178** result before accepting the
candidate. Full-race visual/sync checks and two-machine validation remain necessary release gates.

## Decide whether an optimisation helped

```sh
python3 tools/race_benchmark.py compare \
  --baseline perf-results/healthy/baseline-*.json \
  --candidate perf-results/healthy/candidate-*.json \
  --output perf-results/healthy/comparison.json
```

The comparison reports each player's median presentation rate, simulation rate, p50/p95/p99 and
maximum presented-frame intervals, slowest-1% mean (and its reciprocal, the 1% low rate), counts over
20/25/50/100 ms per 1,000 intervals, draw fraction, disc time and peer queues. It compares matching
pair IDs and preserves the healthy peer's result when evaluating a slow-peer improvement.

An improvement must reduce the slowest-1% mean by at least the largest of **5%, 0.5 ms, or twice
the paired median absolute deviation**, with agreement in at least 80% of pairs. Simulation rate
and presentation rate may not regress by more than 1%; p95 and long-stall counts have guardrails.
Rare large stalls remain in this metric even when the p99 cutoff itself misses them. There is no
guaranteed speedup threshold that makes every noisy experiment conclusive.

Invalid results include missing peers, offline captures, disconnected/no-traffic sessions, hidden
or resized tabs, changed browsers/settings/assets/workloads, changed binaries during capture,
incomplete windows, mismatched pair IDs, interpolation/duplicate presents, and missing human
finish/visual/sync checks. A faster average with more frame skipping or slower simulation cannot
pass. Comparing the same binary is labelled a **calibration**, never a code improvement. Pilot
captures (`--label pilot`) are excluded from optimisation cohorts.

Exit status: 0 for an improvement or same-build calibration, 2 for inconclusive evidence, 1 for
invalid evidence or a regression. Save the raw result JSON alongside each comparison.

## Validation commands

```sh
node --test tools/cloudflare/test/worker.test.mjs wiicompiled/runtime/src/platform/web/tests/*.test.mjs
python3 -m unittest discover -s tools -p 'test_*.py'
ctest --test-dir wiicompiled/build-macos --output-on-failure
```

Collector/comparison unit fixtures are synthetic and are not race baselines. The relay's live
smoke test proves protocol transport only; it cannot prove FPS or multiplayer race completion.
