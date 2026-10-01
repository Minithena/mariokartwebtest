#!/usr/bin/env python3
"""Capture real multiplayer race measurements locally, then compare paired repeated runs."""
from __future__ import annotations

import argparse
import functools
import hashlib
import http.server
import json
import math
import re
from pathlib import Path
import shutil
import statistics
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
import uuid

from serve import Handler

REPO = Path(__file__).resolve().parent.parent
SCHEMA = 3
MAX_REPORT_BYTES = 8 * 1024 * 1024


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def git_identity(directory):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(directory), *args])
    return {'commit': git('rev-parse', 'HEAD').decode().strip(),
            'tracked_diff_sha256': hashlib.sha256(git('diff', 'HEAD', '--')).hexdigest(),
            'dirty': bool(git('status', '--porcelain').strip())}


def build_identity(public):
    required = ['WiiCompiled.html', 'WiiCompiled.js', 'WiiCompiled.wasm', 'WiiCompiled.data',
                'game/manifest-v2.txt']
    if 'mkw-benchmark-' not in (public / 'WiiCompiled.js').read_text():
        raise ValueError('This staged build has no benchmark collector. Build and stage it first.')
    files = {name: sha256(public / name) for name in required}
    seed = public / 'game/save/rksys.dat'
    if seed.exists():
        files['game/save/rksys.dat'] = sha256(seed)
    return {'files': files, 'source': git_identity(REPO),
            'runtime_source': git_identity(REPO / 'wiicompiled')}


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def percentile(values, quantile):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(quantile * len(ordered)) - 1)] if ordered else None


def race_time(text):
    match = re.fullmatch(r'(\d+):([0-5]\d)\.(\d{3})', text)
    if not match:
        raise ValueError('Ghost time must be M:SS.mmm')
    minutes, seconds, millis = map(int, match.groups())
    return (minutes * 60 + seconds) * 1000 + millis


def analyse(report, context):
    """Never infer displayed FPS, CPU execution time, physics, or sync correctness from submissions."""
    reasons = []
    if not isinstance(report, dict):
        raise ValueError('Expected a benchmark report object')
    player = report.get('player_id')
    if report.get('schema_version') != SCHEMA or report.get('run_id') != context['run_id']:
        raise ValueError('Report belongs to a different schema or session')
    if report.get('clock') != 'emscripten-pthreads-epoch-ms':
        raise ValueError('Unknown capture clock')
    if player not in context['devices']:
        raise ValueError('Unknown benchmark player')
    if report.get('measure_steps') != context['measure_steps'] or report.get('warmup_steps') != context['warmup_steps']:
        raise ValueError('Capture duration differs from the session')
    if report.get('input_recipe') != context['workload'].get('input_recipe'):
        raise ValueError('Controller recipe differs from the session')
    mode = context['workload'].get('mode', 'multiplayer')
    if report.get('workload_mode') != mode:
        raise ValueError('Ghost and multiplayer measurements cannot be mixed')
    conditions = report.get('race_conditions')
    if not isinstance(conditions, dict) or not all(finite(conditions.get(k)) and conditions[k] >= 0
        for k in ('course_id', 'engine_class', 'game_mode', 'player_count')):
        raise ValueError('Missing native race conditions')
    if mode == 'ghost' and not conditions.get('is_ghost_replay'):
        reasons.append('native race scenario is not a ghost replay')
    if mode == 'ghost' and conditions['course_id'] != context['workload'].get('expected_course_id'):
        reasons.append('ghost replay is on a different course')
    if mode == 'multiplayer' and conditions['player_count'] < context['players']:
        reasons.append('native race has fewer players than the room workload')
    steps, frames = report.get('steps'), report.get('frames')
    if not isinstance(steps, list) or not isinstance(frames, list) or len(steps) > 12000 or len(frames) > 24000:
        raise ValueError('Invalid sample arrays')
    for row in steps:
        if not isinstance(row, list) or len(row) != 10 or not all(finite(v) and v >= 0 for v in row) or row[0] <= 0:
            raise ValueError('Invalid simulation sample')
        if row[9] != 2:
            reasons.append('intro/countdown/finished phase included in the capture')
    previous_time = None
    per_step = {}
    for index, row in enumerate(frames):
        if not isinstance(row, list) or len(row) != 9:
            raise ValueError('Invalid frame sample')
        if not all(finite(v) and v >= 0 for i, v in enumerate(row) if i != 2):
            raise ValueError('Invalid frame timing')
        if not isinstance(row[0], int) or row[0] >= context['measure_steps']:
            raise ValueError('Frame has an invalid simulation-step index')
        if index == 0 and row[2] is not None:
            raise ValueError('First interval must exclude the warmup boundary')
        if index and (not finite(row[2]) or row[2] <= 0 or row[1] <= previous_time or abs(row[2] - (row[1] - previous_time)) > .01):
            raise ValueError('Frame intervals and timestamps disagree')
        per_step[row[0]] = per_step.get(row[0], 0) + 1
        previous_time = row[1]
    start, end = report.get('started_at_ms'), report.get('ended_at_ms')
    if not finite(start) or not finite(end) or end <= start:
        reasons.append('capture has no complete time window')
        elapsed = None
    else:
        elapsed = end - start
        if abs(sum(row[0] for row in steps) - elapsed) > .02:
            reasons.append('step intervals do not cover the measured window')
        if any(row[1] < start or row[1] > end for row in frames):
            reasons.append('presentation falls outside the measured window')
    if len(steps) != context['measure_steps'] or report.get('aborted'):
        reasons.append('capture incomplete: ' + str(report.get('aborted') or len(steps)))
    if len(frames) < 2:
        reasons.append('fewer than two presented frames')
    if any(count > 1 for count in per_step.values()):
        reasons.append('multiple presentations per step; interpolation/duplication needs a separate benchmark')
    settings = report.get('settings', {})
    if settings.get('interpolation_fps', 0) != 0:
        reasons.append('frame interpolation enabled')
    env, end_env = report.get('environment', {}), report.get('end_environment', {})
    if env.get('visibility') != 'visible' or end_env.get('visibility') != 'visible':
        reasons.append('game tab not visible')
    for event in report.get('events', []):
        if finite(start) and finite(end) and start <= event.get('at_ms', -1) <= end:
            if event.get('type') == 'visibilitychange' and event.get('visibility') != 'visible':
                reasons.append('tab hidden during measurement')
            if event.get('type') == 'resize':
                reasons.append('viewport changed during measurement')
            if event.get('type') == 'keydown' and event.get('key') in ('F10', 'Enter', 'Escape'):
                reasons.append('settings or pause input during measurement; review required')
    for key in ('viewport', 'canvas', 'device_pixel_ratio'):
        if env.get(key) != end_env.get(key):
            reasons.append(key + ' changed during measurement')
    options = env.get('url_options', {})
    if any(key in options for key in ('log', 'netlog', 'pacetrace')):
        reasons.append('diagnostic logging/sampling enabled; use a separate attribution run')
    expected_options = context['player_options'][player]
    if options != expected_options:
        reasons.append('URL options differ from the requested workload')
    if mode == 'multiplayer' and any(row[8] != 1 for row in steps):
        reasons.append('room connection not open throughout capture')
    if mode == 'multiplayer' and sum(row[3] for row in steps) < len(steps) * .5:
        reasons.append('insufficient online race checks; this is not an online race sample')
    if mode == 'multiplayer' and (not sum(row[4] for row in steps) or not sum(row[5] for row in steps)):
        reasons.append('no bidirectional peer UDP traffic')
    rosters = report.get('roster', [])
    if mode == 'multiplayer' and (not rosters or any(sum(bool(p.get('inGame')) for p in roster.get('players', [])) < context['players'] for roster in rosters)):
        reasons.append('not all expected game clients were connected')
    intervals = [row[2] for row in frames[1:]]
    frame_span = frames[-1][1] - frames[0][1] if len(frames) > 1 else None
    worst_one_percent = statistics.mean(sorted(intervals, reverse=True)[:max(1, math.ceil(len(intervals) * .01))]) if intervals else None
    metrics = {
        'elapsed_ms': elapsed, 'steps': len(steps), 'presentations': len(frames),
        'simulation_hz': len(steps) * 1000 / elapsed if elapsed else None,
        'presentation_hz': (len(frames) - 1) * 1000 / frame_span if frame_span else None,
        'drawn_fraction': len(frames) / len(steps) if steps else None,
        'p50_frame_ms': percentile(intervals, .5), 'p95_frame_ms': percentile(intervals, .95),
        'p99_frame_ms': percentile(intervals, .99), 'max_frame_ms': max(intervals) if intervals else None,
        'worst_one_percent_mean_ms': worst_one_percent,
        'one_percent_low_hz': 1000 / worst_one_percent if worst_one_percent else None,
        'over20_per_1000': sum(v > 20 for v in intervals) * 1000 / len(intervals) if intervals else None,
        'over25_per_1000': sum(v > 25 for v in intervals) * 1000 / len(intervals) if intervals else None,
        'over50_per_1000': sum(v > 50 for v in intervals) * 1000 / len(intervals) if intervals else None,
        'over100_per_1000': sum(v > 100 for v in intervals) * 1000 / len(intervals) if intervals else None,
        'disc_ms': sum(row[2] for row in steps), 'udp_sent': sum(row[4] for row in steps),
        'udp_received': sum(row[5] for row in steps),
        'max_send_queue_bytes': max((row[6] for row in steps), default=0),
        'max_receive_queue_bytes': max((row[7] for row in steps), default=0),
    }
    return {'valid': not reasons, 'invalid_reasons': sorted(set(reasons)), 'metrics': metrics}


def comparison_identity(document):
    c = document['context']
    reports = document['reports']
    return {'workload': c['workload'], 'devices': c['devices'], 'topology': c['topology'],
            'warmup_steps': c['warmup_steps'], 'measure_steps': c['measure_steps'],
            'player_options': c['player_options'], 'relay': c['relay'],
            'assets': {k: v for k, v in c['build']['files'].items() if k.startswith('game/')},
            'players': {p: {'settings': r['settings'], 'race_conditions': r['race_conditions'], 'environment': {
                k: r['environment'].get(k) for k in ('user_agent', 'hardware_concurrency', 'device_pixel_ratio', 'viewport', 'canvas')
            }} for p, r in reports.items()}}


def compare(baselines, candidates, minimum_runs=3, min_percent=5.0, min_ms=.5):
    reasons = []
    minimum_runs = max(3, minimum_runs)
    if len(baselines) < minimum_runs or len(candidates) < minimum_runs:
        reasons.append(f'at least {minimum_runs} complete paired runs per build are required')
    all_runs = baselines + candidates
    if not all_runs:
        return {'status': 'invalid', 'reasons': ['no runs'], 'players': {}}
    reference = comparison_identity(all_runs[0])
    for document in all_runs:
        if document['context'].get('label') == 'pilot':
            reasons.append('pilot captures are smoke tests, not baseline/candidate cohorts')
        if comparison_identity(document) != reference:
            reasons.append('workload, devices, settings, browser, assets or relay changed')
        if document.get('build_changed_during_run'):
            reasons.append('served build changed during capture')
        if len(document['reports']) != document['context']['players']:
            reasons.append('a player report is missing')
        else:
            starts = [r.get('started_at_ms') for r in document['reports'].values()]
            ends = [r.get('ended_at_ms') for r in document['reports'].values()]
            if all(finite(v) for v in starts + ends) and max(starts) >= min(ends):
                reasons.append('player capture windows did not overlap')
        for p, report in document['reports'].items():
            result = analyse(report, document['context'])
            reasons.extend(f'{p}: {reason}' for reason in result['invalid_reasons'])
        validation = document.get('validation', {})
        if not validation.get('visual_pass') or not validation.get('race_finished'):
            reasons.append('completed race and visual review are required')
        if document['context']['workload'].get('mode', 'multiplayer') == 'multiplayer':
            if not validation.get('sync_pass'):
                reasons.append('multiplayer sync review is required')
        elif validation.get('ghost_time_ms') != document['context']['workload'].get('ghost_expected_ms'):
            reasons.append('observed ghost finish must match the recorded reference time')
    a_pairs = {d['context']['pair_id'] for d in baselines}
    b_pairs = {d['context']['pair_id'] for d in candidates}
    if a_pairs != b_pairs or len(a_pairs) != len(baselines) or len(b_pairs) != len(candidates):
        reasons.append('baseline and candidate must have unique matching pair IDs')
    for group in (baselines, candidates):
        if len({d['context']['build']['files'].get('WiiCompiled.wasm') for d in group}) > 1 or \
           len({d['context']['build']['files'].get('WiiCompiled.js') for d in group}) > 1:
            reasons.append('one build per cohort is required')
    if reasons:
        return {'status': 'invalid', 'reasons': sorted(set(reasons)), 'players': {}}
    players, regression, improved = {}, False, False
    for player in reference['devices']:
        a = {d['context']['pair_id']: analyse(d['reports'][player], d['context'])['metrics'] for d in baselines}
        b = {d['context']['pair_id']: analyse(d['reports'][player], d['context'])['metrics'] for d in candidates}
        med_a = {key: statistics.median(v[key] for v in a.values()) for key in next(iter(a.values()))}
        med_b = {key: statistics.median(v[key] for v in b.values()) for key in next(iter(b.values()))}
        # The slowest 1% mean includes rare spikes that a p99 cutoff can miss entirely.
        gains = [a[p]['worst_one_percent_mean_ms'] - b[p]['worst_one_percent_mean_ms'] for p in a]
        noise = statistics.median(abs(g - statistics.median(gains)) for g in gains)
        required = max(min_ms, med_a['worst_one_percent_mean_ms'] * min_percent / 100, 2 * noise)
        gain = statistics.median(gains)
        agreement = sum(g >= min_ms for g in gains) / len(gains)
        tail_improved = gain >= required and agreement >= .8
        player_regression = (med_b['simulation_hz'] < med_a['simulation_hz'] * .99 or
            med_b['presentation_hz'] < med_a['presentation_hz'] * .99 or
            med_b['p95_frame_ms'] > med_a['p95_frame_ms'] + max(.5, med_a['p95_frame_ms'] * .05) or
            med_b['over50_per_1000'] > med_a['over50_per_1000'] + 1)
        regression |= player_regression
        improved |= tail_improved
        players[player] = {'baseline_median': med_a, 'candidate_median': med_b,
                           'worst_one_percent_gain_ms': gain, 'paired_noise_mad_ms': noise,
                           'required_gain_ms': required, 'paired_agreement': agreement,
                           'tail_improved': tail_improved, 'regression': player_regression}
    fingerprints = [{key: group[0]['context']['build']['files'].get(key)
                     for key in ('WiiCompiled.wasm', 'WiiCompiled.js')} for group in (baselines, candidates)]
    same_build = fingerprints[0] == fingerprints[1] and fingerprints[0]['WiiCompiled.wasm'] is not None
    return {'status': 'regression' if regression else 'calibration' if same_build else 'improvement' if improved else 'inconclusive',
            'reasons': [], 'players': players,
            'same_build_calibration': same_build,
            'measurement': 'presentation submission intervals; not physical display scan-out or CPU-only timings'}


class Session:
    def __init__(self, context, public, output):
        self.context, self.public, self.output = context, public, output
        self.lock = threading.Lock()
        self.reports = {}
        self.finished = set()

    def accept(self, report):
        analysis = analyse(report, self.context)
        player = report['player_id']
        with self.lock:
            if player in self.reports:
                raise ValueError('A result for this player already exists; use a new run')
            self.reports[player] = report
            changed = len(self.reports) == self.context['players'] and any(
                sha256(self.public / key) != digest for key, digest in self.context['build']['files'].items())
            document = {'schema_version': SCHEMA, 'context': self.context, 'reports': self.reports,
                        'build_changed_during_run': changed, 'validation': {},
                        'analysis': {p: analyse(r, self.context) for p, r in self.reports.items()}}
            temporary = self.output.with_suffix('.tmp')
            temporary.write_text(json.dumps(document, indent=2) + '\n')
            temporary.replace(self.output)
        print(f'Saved {player}: {analysis["metrics"]["presentation_hz"]} presentations/s; '
              f'valid={analysis["valid"]}; {len(self.reports)}/{self.context["players"]} clients', flush=True)
        return analysis


class BenchmarkHandler(Handler):
    session: Session

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        if url.path != '/benchmark/state':
            return super().do_GET()
        if urllib.parse.parse_qs(url.query).get('run') != [self.session.context['run_id']]:
            self.send_error(400, 'Unknown benchmark session')
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        with self.session.lock:
            self.wfile.write(json.dumps({'all_finished': len(self.session.finished) == self.session.context['players']}).encode())

    def do_POST(self):
        if self.path not in ('/benchmark/result', '/benchmark/finished'):
            return super().do_POST()
        try:
            length = int(self.headers.get('Content-Length', 0))
            if not 0 < length <= MAX_REPORT_BYTES:
                raise ValueError('Invalid report length')
            report = json.loads(self.rfile.read(length))
            if self.path == '/benchmark/finished':
                if not isinstance(report, dict) or report.get('run_id') != self.session.context['run_id'] or report.get('player_id') not in self.session.context['devices']:
                    raise ValueError('Unknown benchmark participant')
                with self.session.lock:
                    self.session.finished.add(report['player_id'])
                self.send_response(204)
                self.end_headers()
                return
            if len(self.session.finished) != self.session.context['players']:
                raise ValueError('Wait for both clients to finish before exporting')
            analysis = self.session.accept(report)
        except (ValueError, KeyError, TypeError) as error:
            self.send_error(400, str(error))
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(analysis).encode())

    def log_message(self, fmt, *args):
        if self.path.startswith('/benchmark/') or self.path == '/log':
            super().log_message(fmt, *args)


def record(args):
    public = args.public.resolve()
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise ValueError('Output exists; choose a new run filename')
    if args.mode == 'ghost':
        code = None
    elif args.room_code:
        code = args.room_code
    else:
        request = urllib.request.Request(args.relay.rstrip('/') + '/v1/rooms', method='POST')
        with urllib.request.urlopen(request, timeout=10) as response:
            code = json.load(response)['code']
    if args.mode == 'multiplayer' and (not isinstance(code, str) or not code.isalnum() or not 6 <= len(code) <= 32):
        raise ValueError('Invalid room code')
    relay = urllib.parse.urlsplit(args.relay)
    room_url = urllib.parse.urlunsplit(('wss' if relay.scheme == 'https' else 'ws', relay.netloc,
                                      f'/v1/rooms/{code}/ws', '', ''))
    options = {'host': {'muted': ''}}
    devices = {'host': args.host_device}
    if args.mode == 'multiplayer':
        options['peer'] = {'muted': ''}
        devices['peer'] = args.peer_device
    if args.peer_burn_ms and args.mode == 'multiplayer':
        options['peer']['burn'] = str(args.peer_burn_ms)
    context = {'schema_version': SCHEMA, 'run_id': str(uuid.uuid4()), 'label': args.label,
        'pair_id': args.pair_id, 'players': len(devices), 'devices': devices,
        'topology': args.topology, 'warmup_steps': args.warmup_steps, 'measure_steps': args.measure_steps,
        'workload': {'id': args.workload, 'course': args.course, 'scenario': args.scenario, 'mode': args.mode,
                     'ghost_expected_ms': race_time(args.expected_ghost_time) if args.mode == 'ghost' else None,
                     'expected_course_id': args.expected_course_id if args.mode == 'ghost' else None,
                     'input_recipe': args.input_recipe, 'cache_state': args.cache_state,
                     'asset_latency_ms': args.asset_latency_ms},
        'player_options': options, 'relay': args.relay.rstrip('/'), 'room_code': code,
        'build': build_identity(public)}
    output.with_suffix('.session.json').write_text(json.dumps(context, indent=2) + '\n')
    session = Session(context, public, output)
    handler = type('SessionHandler', (BenchmarkHandler,), {'session': session, 'latency': args.asset_latency_ms / 1000})
    for player in devices:
        host = '127.0.0.1' if player == 'host' else 'localhost'
        query = {'benchmark': context['run_id'], 'bench_player': player, 'bench_mode': args.mode,
                 'bench_clients': len(devices), 'bench_course_id': args.expected_course_id,
                 'bench_warmup': args.warmup_steps, 'bench_steps': args.measure_steps,
                 'bench_input': args.input_recipe, **options[player]}
        if args.mode == 'multiplayer':
            query['room'] = room_url
        if args.topology == 'two-machines':
            host = args.public_hostname
        print(f'{player}: http://{host}:{args.port}/WiiCompiled.html?{urllib.parse.urlencode(query)}', flush=True)
    print('Watch the saved reference ghost; the ghost supplies all racing inputs.' if args.mode == 'ghost' else
          'Enter the same online VS race in both clients; keep both windows visible. '
          'A slow-peer run adds CPU work per drawn frame; it does not emulate a GPU or network delay.', flush=True)
    with http.server.ThreadingHTTPServer(('127.0.0.1', args.port), functools.partial(handler, directory=str(public))) as server:
        server.serve_forever()


def snapshot(public, output):
    identity = build_identity(public)
    if output.exists():
        raise ValueError('Snapshot directory already exists')
    output.mkdir(parents=True)
    for name in ('WiiCompiled.html', 'WiiCompiled.js', 'WiiCompiled.wasm', 'WiiCompiled.data'):
        shutil.copy2(public / name, output / name)
    game = output / 'game'
    game.mkdir()
    for name in ('manifest.txt', 'manifest-v2.txt'):
        shutil.copy2(public / 'game' / name, game / name)
    for name in ('DATA', 'web-videos', 'file-packs'):
        source = public / 'game' / name
        if source.exists():
            (game / name).symlink_to(source.resolve(), target_is_directory=True)
    if (public / 'game/save').exists():
        shutil.copytree(public / 'game/save', game / 'save')
    (output / 'build.json').write_text(json.dumps(identity, indent=2) + '\n')
    print(f'Frozen local build: {output}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    p = commands.add_parser('snapshot')
    p.add_argument('--public', type=Path, default=REPO / 'site/public')
    p.add_argument('--output', type=Path, required=True)
    p = commands.add_parser('record')
    p.add_argument('--public', type=Path, default=REPO / 'site/public')
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--label', choices=['baseline', 'candidate', 'pilot'], required=True)
    p.add_argument('--pair-id', required=True)
    p.add_argument('--workload', required=True)
    p.add_argument('--course', required=True)
    p.add_argument('--mode', choices=['multiplayer', 'ghost'], default='multiplayer')
    p.add_argument('--expected-ghost-time', default='1:44.178')
    p.add_argument('--expected-course-id', type=int, default=0, help='Native course ID; Mario Circuit is 0')
    p.add_argument('--input-recipe', choices=['manual-v1', 'autodrive-v1', 'ghost-v1'], required=True)
    p.add_argument('--scenario', choices=['healthy', 'slow-peer', 'first-use-stress'], default='healthy')
    p.add_argument('--cache-state', choices=['warm', 'cold'], default='warm')
    p.add_argument('--host-device', required=True)
    p.add_argument('--peer-device')
    p.add_argument('--topology', choices=['same-machine', 'two-machines'], default='same-machine')
    p.add_argument('--public-hostname', default='127.0.0.1')
    p.add_argument('--relay', default='http://127.0.0.1:8787')
    p.add_argument('--room-code')
    p.add_argument('--port', type=int, default=8013)
    p.add_argument('--warmup-steps', type=int, default=300)
    p.add_argument('--measure-steps', type=int, default=1800)
    p.add_argument('--peer-burn-ms', type=float, default=0)
    p.add_argument('--asset-latency-ms', type=float, default=0)
    p = commands.add_parser('compare')
    p.add_argument('--baseline', nargs='+', type=Path, required=True)
    p.add_argument('--candidate', nargs='+', type=Path, required=True)
    p.add_argument('--minimum-runs', type=int, default=3)
    p.add_argument('--output', type=Path)
    p = commands.add_parser('validate')
    p.add_argument('result', type=Path)
    p.add_argument('--race-finished', action='store_true', required=True)
    p.add_argument('--visual-pass', action='store_true', required=True)
    p.add_argument('--sync-pass', action='store_true')
    p.add_argument('--ghost-time')
    p.add_argument('--observer', choices=['human', 'agent'], default='human')
    p.add_argument('--notes', required=True)
    args = parser.parse_args()
    try:
        if args.command == 'snapshot':
            snapshot(args.public.resolve(), args.output.resolve())
        elif args.command == 'record':
            if not 0 <= args.warmup_steps <= 3600 or not 60 <= args.measure_steps <= 12000:
                raise ValueError('Duration out of bounds')
            if args.peer_burn_ms < 0 or args.asset_latency_ms < 0:
                raise ValueError('Latency and synthetic load must be non-negative')
            if args.scenario == 'slow-peer' and not args.peer_burn_ms:
                raise ValueError('A slow-peer workload requires --peer-burn-ms')
            if args.mode == 'ghost' and (args.input_recipe != 'ghost-v1' or args.peer_burn_ms):
                raise ValueError('Ghost mode uses ghost-v1 and has no artificial peer')
            if args.mode == 'multiplayer' and (not args.peer_device or args.input_recipe == 'ghost-v1'):
                raise ValueError('Multiplayer mode requires a peer device and a multiplayer input recipe')
            if args.topology == 'two-machines':
                raise ValueError('Use an existing isolated hosted/tunnel origin for two physical machines; this collector only binds localhost')
            record(args)
        elif args.command == 'validate':
            document = json.loads(args.result.read_text())
            ghost = document['context']['workload'].get('mode') == 'ghost'
            if not ghost and not args.sync_pass:
                raise ValueError('Multiplayer validation requires --sync-pass')
            if ghost and (not args.ghost_time or race_time(args.ghost_time) != document['context']['workload']['ghost_expected_ms']):
                raise ValueError('Ghost validation requires its observed reference finish time')
            document['validation'] = {'race_finished': True, 'visual_pass': True, 'sync_pass': args.sync_pass,
                                      'ghost_time_ms': race_time(args.ghost_time) if args.ghost_time else None,
                                      'notes': args.notes, 'evidence': args.observer + ' UI observation supplied to validate command'}
            args.result.write_text(json.dumps(document, indent=2) + '\n')
        else:
            result = compare([json.loads(p.read_text()) for p in args.baseline],
                             [json.loads(p.read_text()) for p in args.candidate], args.minimum_runs)
            text = json.dumps(result, indent=2) + '\n'
            print(text, end='')
            if args.output:
                args.output.write_text(text)
            return 0 if result['status'] in ('improvement', 'calibration') else 2 if result['status'] == 'inconclusive' else 1
    except (ValueError, OSError, KeyError) as error:
        parser.error(str(error))
    return 0


if __name__ == '__main__':
    sys.exit(main())
