"""Compile the actual browser socket adapter and exercise it with controlled WebSocket traffic.

Run after sourcing ../tools/emsdk/emsdk_env.sh. Uses temporary outputs, no game data or browser UI.
"""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile


def main():
    compiler = shutil.which('em++')
    node = shutil.which('node') or os.environ.get('EMSDK_NODE')
    if not compiler or not node:
        raise SystemExit('Source ../tools/emsdk/emsdk_env.sh before running this socket test')
    repo = Path(__file__).resolve().parents[1]
    web = repo / 'wiicompiled/runtime/src/platform/web'
    node_flags = []
    probe = subprocess.run([node, '-p', 'typeof WebAssembly.Suspending'], capture_output=True, text=True, check=True)
    if probe.stdout.strip() != 'function':
        node_flags = ['--experimental-wasm-jspi']
    with tempfile.TemporaryDirectory(prefix='mkw-vnet-harness-') as directory:
        output = Path(directory) / 'transport.js'
        subprocess.run([
            compiler, '-std=c++23', '-O1', '-Wno-invalid-pp-token', '-sJSPI', '-sENVIRONMENT=node',
            '-sALLOW_MEMORY_GROWTH', '-sASSERTIONS=1',
            '--pre-js', str(web / 'tests/vnet_socket_harness_pre.js'),
            '-I', str(web), str(web / 'web_vnet.cpp'),
            str(repo / 'wiicompiled/runtime/tests/web_vnet_socket.cpp'), '-o', str(output),
        ], check=True)
        result = subprocess.run([node, *node_flags, str(output)], capture_output=True, text=True, timeout=30)
        if result.returncode or 'VNET_HARNESS_OK' not in result.stdout:
            print(result.stdout)
            print(result.stderr)
            raise SystemExit(result.returncode or 1)
        print(next(line for line in result.stdout.splitlines() if line.startswith('VNET_HARNESS_OK')))


if __name__ == '__main__':
    main()
