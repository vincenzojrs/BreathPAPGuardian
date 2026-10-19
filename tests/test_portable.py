"""Synthetic, temporary two-computer exercise for the portable archive."""
import json
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from portable_store import PortableStore


class PortableTests(unittest.TestCase):
    def test_http_two_local_servers(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ports = []
            for _ in range(2):
                with socket.socket() as sock:
                    sock.bind(('127.0.0.1', 0))
                    ports.append(sock.getsockname()[1])
            processes = [subprocess.Popen([sys.executable, str(Path(__file__).resolve().parents[1] / 'server.py'), '--port', str(port),
                                            '--data-dir', str(root / ('mac-' + str(i))), '--shared-dir', str(root / 'shared')],
                                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for i, port in enumerate(ports)]
            def call(port, path, data=None, content_type='application/json'):
                body = None if data is None else data if isinstance(data, bytes) else json.dumps(data).encode()
                req = Request(f'http://127.0.0.1:{port}/api/{path}', data=body,
                              headers={'X-BPG-Local': '1', 'Content-Type': content_type})
                with urlopen(req, timeout=10) as response:
                    return json.loads(response.read())
            try:
                for port in ports:
                    for attempt in range(100):
                        try:
                            call(port, 'status')
                            break
                        except OSError:
                            time.sleep(.02)
                    else:
                        self.fail('Portable server did not start.')
                key = call(ports[0], 'blob', b'EDF synthetic', 'application/octet-stream')['key']
                call(ports[0], 'batch', {'put': [['files', {'id': 'demo', 'blob': {'__ref': key}}]]})
                call(ports[0], 'publish', {})
                call(ports[1], 'open-shared', {})
                self.assertEqual(call(ports[1], 'records/files')[0]['id'], 'demo')
                req = Request(f'http://127.0.0.1:{ports[0]}/api/publish', data=b'{}')
                with self.assertRaises(HTTPError) as denied:
                    urlopen(req)
                self.assertEqual(denied.exception.code, 403)
            finally:
                for p in processes:
                    p.terminate()
                    p.wait(timeout=5)

    def test_round_trip_and_conflict(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            shared = root / 'shared'
            a = PortableStore(root / 'mac-a', shared)
            content = b'synthetic EDF and media bytes'
            key = a.save_blob(content)
            night = {'id': 'synthetic', 'blob': {'__ref': key, 'type': 'application/octet-stream'},
                     'parsed': {'signal': {'__float': [1.5, None, -2.0]}}}
            marker = {'id': 'observation', 'night': '2026-01-01', 'media': [{'name': 'image.png', 'blob': {'__ref': key, 'type': 'image/png'}}]}
            a.batch({'put': [['files', night], ['markers', marker]]})
            self.assertTrue(a.status()['dirty'])
            v1 = a.publish()['base']
            b = PortableStore(root / 'mac-b', shared)
            with self.assertRaisesRegex(ValueError, 'newer shared version'):
                b.batch({'put': [['external', {'id': 'x'}]]})
            self.assertEqual(b.open_shared()['base'], v1)
            self.assertEqual(b.records('files'), [night])
            self.assertEqual(b.records('markers'), [marker])
            self.assertEqual(b.blob(key).read_bytes(), content)
            b.batch({'put': [['external', {'id': 'other', 'night': '2026-01-01'}]]})
            v2 = b.publish()['base']
            self.assertNotEqual(v1, v2)
            with self.assertRaisesRegex(ValueError, 'newer shared version'):
                a.batch({'put': [['external', {'id': 'stale'}]]})
            a.open_shared()
            self.assertEqual(a.records('external')[0]['id'], 'other')
            self.assertTrue((a.local / 'previous.sqlite').exists())

    def test_incomplete_snapshot_does_not_replace_working_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a = PortableStore(root / 'a', root / 'shared')
            a.batch({'put': [['files', {'id': 'synthetic'}]]})
            version = a.publish()['base']
            b = PortableStore(root / 'b', root / 'shared')
            snapshot = root / 'shared' / 'versions' / (version + '.sqlite')
            snapshot.write_bytes(b'incomplete')
            with self.assertRaisesRegex(ValueError, 'incomplete or damaged'):
                a.open_shared()
            with self.assertRaisesRegex(ValueError, 'incomplete or damaged'):
                b.open_shared()
            self.assertEqual(b.status()['base'], '')


if __name__ == '__main__':
    unittest.main()
