#!/usr/bin/env python3
"""Launch one of two test clients against a separate copy of a shared archive."""
import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import webbrowser
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--test-root', type=Path, required=True)
parser.add_argument('--client', choices=('A', 'B'), required=True)
parser.add_argument('--port', type=int, help='Override the default local test port')
args = parser.parse_args()
source = args.source.expanduser().resolve()
root = args.test_root.expanduser().resolve()
repo = Path(__file__).resolve().parents[1]
if source == root or source in root.parents or root in source.parents:
    raise SystemExit('The test directory must be separate from the original archive.')
if not (source/'latest.json').is_file():
    raise SystemExit('Original shared archive was not found. Nothing was changed.')
root.mkdir(parents=True, exist_ok=True)
shared = root/'shared-copy'
marker = root/'.bpg-test-source.json'
if shared.is_symlink():
    raise SystemExit('The test shared folder must not be a symbolic link.')
if not shared.exists():
    print('Creating an independent test copy of the shared archive. This can require several GB and take time.', flush=True)
    parent = Path(tempfile.mkdtemp(prefix='.bpg-copy-', dir=root))
    try:
        before = (source/'latest.json').read_bytes()
        shutil.copytree(source, parent/'shared-copy')
        after = (source/'latest.json').read_bytes()
        if before != after:
            raise RuntimeError('The source publication changed during copying; wait for synchronization and retry.')
        os.rename(parent/'shared-copy', shared)
        marker.write_text(json.dumps({'source': str(source)}), encoding='utf-8')
    finally:
        shutil.rmtree(parent, ignore_errors=True)
else:
    if not marker.is_file() or json.loads(marker.read_text(encoding='utf-8')).get('source') != str(source):
        raise SystemExit('Existing test folder is not a verified isolated copy; choose another test directory.')
    print('Reusing the existing isolated test copy.', flush=True)
work = root/('client-'+args.client.lower())
port = args.port or (18765 if args.client == 'A' else 18766)
if not 1 <= port <= 65535:
    raise SystemExit('Invalid local port.')
print(f'Test client {args.client}; working folder: {work}; shared test copy: {shared}', flush=True)
print('The original shared archive is not used for writing. Close this terminal to stop the test.', flush=True)
def stop_on_signal(_signum, _frame):
    raise KeyboardInterrupt

signal.signal(signal.SIGTERM, stop_on_signal)
process = subprocess.Popen([sys.executable, str(repo/'server.py'), '--port', str(port), '--data-dir', str(work), '--shared-dir', str(shared)], cwd=repo)
try:
    time.sleep(1)
    if process.poll() is not None:
        raise SystemExit('Test server could not start. Check whether the port is already in use.')
    webbrowser.open(f'http://127.0.0.1:{port}')
    process.wait()
except KeyboardInterrupt:
    pass
finally:
    if process.poll() is None:
        process.terminate()
        process.wait(timeout=10)
