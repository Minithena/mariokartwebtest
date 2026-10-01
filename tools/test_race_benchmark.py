import copy
import json
from pathlib import Path
import tempfile
import functools
import http.server
import threading
import urllib.request
import urllib.error
import unittest

from race_benchmark import analyse, compare, Session, BenchmarkHandler


def fixture(pair='1', tail=32, stride=1):
    n = 120
    context = {'run_id': 'fixture', 'players': 2, 'devices': {'host': 'fixture-host', 'peer': 'fixture-peer'},
        'pair_id': pair, 'workload': {'id': 'synthetic-unit-test'}, 'topology': 'same-machine',
        'warmup_steps': 0, 'measure_steps': n, 'player_options': {'host': {'muted': ''}, 'peer': {'muted': ''}},
        'relay': 'http://fixture.invalid', 'build': {'files': {}}}
    document = {'context': context, 'reports': {}, 'build_changed_during_run': False,
                'validation': {'visual_pass': True, 'sync_pass': True, 'race_finished': True}}
    for player in context['devices']:
        intervals = [tail if i in (30, 60, 90) else 16 for i in range(n)]
        t, frames = 100000, []
        for i, dt in enumerate(intervals):
            t += dt
            if i % stride == 0:
                previous = frames[-1][1] if frames else None
                frames.append([i, t, t-previous if previous else None, 4, 0, 0, 0, 0, 3])
        environment = {'visibility': 'visible', 'viewport': [1280, 720], 'canvas': [640, 480],
                       'device_pixel_ratio': 1, 'user_agent': 'fixture', 'hardware_concurrency': 8,
                       'url_options': {'muted': ''}}
        document['reports'][player] = {'schema_version': 3, 'clock': 'emscripten-pthreads-epoch-ms', 'run_id': 'fixture', 'player_id': player,
            'workload_mode': 'multiplayer', 'race_conditions': {'course_id': 0, 'engine_class': 2, 'game_mode': 6, 'player_count': 2, 'is_ghost_replay': False},
            'warmup_steps': 0, 'measure_steps': n, 'started_at_ms': 100000, 'ended_at_ms': t,
            'settings': {'resolution_scale': 1, 'interpolation_fps': 0}, 'aborted': None,
            'steps': [[dt, 2, 0, 1, 1, 1, 0, 0, 1, 2] for dt in intervals], 'frames': frames,
            'environment': environment, 'end_environment': copy.deepcopy(environment), 'events': [],
            'roster': [{'at_ms': 100000, 'players': [{'id': 1, 'inGame': True}, {'id': 2, 'inGame': True}]}]}
    return document


class RaceBenchmarkTests(unittest.TestCase):
    def test_percentiles_retain_spikes_and_drawing_is_separate_from_simulation(self):
        full, skipped = fixture(), fixture(stride=3)
        a = analyse(full['reports']['host'], full['context'])
        b = analyse(skipped['reports']['host'], skipped['context'])
        self.assertTrue(a['valid'])
        self.assertEqual(a['metrics']['p99_frame_ms'], 32)
        self.assertEqual(a['metrics']['simulation_hz'], b['metrics']['simulation_hz'])
        self.assertLess(b['metrics']['presentation_hz'], a['metrics']['presentation_hz'] / 2)
        self.assertAlmostEqual(b['metrics']['drawn_fraction'], 1/3)

    def test_incomplete_hidden_offline_disconnected_and_debug_runs_are_not_valid(self):
        mutations = [lambda r: r['steps'].pop(), lambda r: r['environment'].update(visibility='hidden'),
            lambda r: r['steps'].__setitem__(1, [16, 2, 0, 0, 0, 0, 0, 0, 3, 2]),
            lambda r: r['environment']['url_options'].update(log=''),
            lambda r: r['roster'][0]['players'].pop(),
            lambda r: r.update(events=[{'type': 'resize', 'at_ms': 100050}])]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                d = fixture()
                mutate(d['reports']['host'])
                self.assertFalse(analyse(d['reports']['host'], d['context'])['valid'])
        d = fixture()
        for row in d['reports']['host']['steps']:
            row[3] = row[4] = row[5] = 0
        self.assertFalse(analyse(d['reports']['host'], d['context'])['valid'])

    def test_nan_and_inconsistent_timestamps_are_rejected(self):
        d = fixture()
        d['reports']['host']['steps'][0][0] = float('nan')
        with self.assertRaises(ValueError):
            analyse(d['reports']['host'], d['context'])
        d = fixture()
        d['reports']['host']['frames'][1][2] = 999
        with self.assertRaises(ValueError):
            analyse(d['reports']['host'], d['context'])

    def test_repeatable_tail_improvement_passes_and_more_skipping_does_not(self):
        a = [fixture(str(i), 32) for i in range(3)]
        b = [fixture(str(i), 20) for i in range(3)]
        self.assertEqual(compare(a, b)['status'], 'improvement')
        self.assertEqual(compare(a, [fixture(str(i), 20, stride=2) for i in range(3)])['status'], 'regression')

    def test_noise_one_run_missing_peer_and_missing_human_check_cannot_pass(self):
        a = [fixture(str(i), 32) for i in range(3)]
        noisy = [fixture('0', 20), fixture('1', 34), fixture('2', 33)]
        self.assertNotEqual(compare(a, noisy)['status'], 'improvement')
        self.assertEqual(compare(a[:1], a[:1])['status'], 'invalid')
        b = copy.deepcopy(a)
        b[0]['validation'] = {}
        self.assertEqual(compare(a, b)['status'], 'invalid')
        b = copy.deepcopy(a)
        del b[0]['reports']['peer']
        self.assertEqual(compare(a, b)['status'], 'invalid')

    def test_settings_browser_assets_and_pair_changes_are_rejected(self):
        a = [fixture(str(i), 32) for i in range(3)]
        for mutate in [lambda d: d['reports']['host']['settings'].update(resolution_scale=.5),
                       lambda d: d['reports']['peer']['environment'].update(user_agent='different'),
                       lambda d: d['context']['build']['files'].update({'game/manifest-v2.txt': 'changed'}),
                       lambda d: d['context'].update(pair_id='unpaired')]:
            b = [fixture(str(i), 20) for i in range(3)]
            mutate(b[0])
            self.assertEqual(compare(a, b)['status'], 'invalid')

    def test_capture_saves_partial_pair_atomically_and_refuses_duplicate_player(self):
        d = fixture()
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'result.json'
            session = Session(d['context'], Path(temp), output)
            session.accept(d['reports']['host'])
            self.assertEqual(len(json.loads(output.read_text())['reports']), 1)
            with self.assertRaises(ValueError):
                session.accept(d['reports']['host'])
            session.accept(d['reports']['peer'])
            self.assertEqual(len(json.loads(output.read_text())['reports']), 2)

    def test_real_http_capture_barrier_accepts_both_clients_before_exporting(self):
        d = fixture()
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'synthetic-http-test.json'
            session = Session(d['context'], Path(temp), output)
            handler = type('TestHandler', (BenchmarkHandler,), {'session': session})
            server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(handler, directory=temp))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f'http://127.0.0.1:{server.server_port}'
            def post(path, payload):
                request = urllib.request.Request(base + path, data=json.dumps(payload).encode(),
                    headers={'Content-Type': 'application/json'})
                return urllib.request.urlopen(request, timeout=2)
            try:
                with self.assertRaises(urllib.error.HTTPError) as failure:
                    post('/benchmark/result', d['reports']['host'])
                failure.exception.close()
                for player in ('host', 'peer'):
                    with post('/benchmark/finished', {'run_id': 'fixture', 'player_id': player}):
                        pass
                with urllib.request.urlopen(base + '/benchmark/state?run=fixture') as response:
                    self.assertTrue(json.load(response)['all_finished'])
                for player in ('host', 'peer'):
                    with post('/benchmark/result', d['reports'][player]) as response:
                        self.assertTrue(json.load(response)['valid'])
                self.assertEqual(len(json.loads(output.read_text())['reports']), 2)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_inactive_phase_and_hidden_event_on_the_shared_epoch_are_invalid(self):
        d = fixture()
        d['reports']['host']['steps'][0][9] = 1
        self.assertFalse(analyse(d['reports']['host'], d['context'])['valid'])

    def test_ghost_replay_is_a_separate_native_verified_workload(self):
        d = fixture()
        d['context']['players'] = 1
        d['context']['devices'] = {'host': 'fixture-host'}
        d['context']['workload'].update(mode='ghost', ghost_expected_ms=104178, expected_course_id=0)
        del d['reports']['peer']
        r = d['reports']['host']
        r.update(workload_mode='ghost', roster=[])
        r['race_conditions'].update(game_mode=5, player_count=1, is_ghost_replay=True)
        for row in r['steps']:
            row[3] = row[4] = row[5] = 0
            row[8] = 3
        self.assertTrue(analyse(r, d['context'])['valid'])
        r['race_conditions']['is_ghost_replay'] = False
        self.assertFalse(analyse(r, d['context'])['valid'])
        r['workload_mode'] = 'multiplayer'
        with self.assertRaises(ValueError):
            analyse(r, d['context'])
        d = fixture()
        d['reports']['host']['events'] = [{'type': 'visibilitychange', 'at_ms': 100050, 'visibility': 'hidden'}]
        self.assertFalse(analyse(d['reports']['host'], d['context'])['valid'])


if __name__ == '__main__':
    unittest.main()
