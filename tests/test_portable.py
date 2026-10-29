"""Synthetic, temporary two-computer exercise for the portable archive."""
import json
import os
import hashlib
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
from portable_store import PortableStore, packed, digest


class PortableTests(unittest.TestCase):
    def store(self, *args):
        value = PortableStore(*args)
        self.addCleanup(value.close)
        return value

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
            tokens = {}
            def call(port, path, data=None, content_type='application/json'):
                body = None if data is None else data if isinstance(data, bytes) else json.dumps(data).encode()
                req = Request(f'http://127.0.0.1:{port}/api/{path}', data=body,
                              headers={'X-BPG-Local': '1', 'Content-Type': content_type, 'X-BPG-Session': tokens.get(port, '')})
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
                for port in ports:
                    tokens[port] = call(port, 'session/start', {})['token']
                    with self.assertRaises(HTTPError): call(port, 'batch', {'put': [['files', {'id': 'blocked'}]]})
                    call(port, 'session/confirm', {})
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
            a = self.store(root / 'mac-a', shared)
            content = b'synthetic EDF and media bytes'
            key = a.save_blob(content)
            night = {'id': 'synthetic', 'blob': {'__ref': key, 'type': 'application/octet-stream'},
                     'parsed': {'signal': {'__float': [1.5, None, -2.0]}}}
            marker = {'id': 'observation', 'night': '2026-01-01', 'media': [{'name': 'image.png', 'blob': {'__ref': key, 'type': 'image/png'}}]}
            a.batch({'put': [['files', night], ['markers', marker]]})
            self.assertTrue(a.status()['dirty'])
            v1 = a.publish()['base']
            b = self.store(root / 'mac-b', shared)
            with self.assertRaisesRegex(ValueError, 'Shared archive changed'):
                b.batch({'put': [['external', {'id': 'x'}]]})
            self.assertEqual(b.open_shared()['base'], v1)
            self.assertEqual(b.records('files'), [night])
            self.assertEqual(b.records('markers'), [marker])
            self.assertEqual(b.blob(key).read_bytes(), content)
            b.batch({'put': [['external', {'id': 'other', 'night': '2026-01-01'}]]})
            v2 = b.publish()['base']
            self.assertNotEqual(v1, v2)
            with self.assertRaisesRegex(ValueError, 'Shared archive changed'):
                a.batch({'put': [['external', {'id': 'stale'}]]})
            a.open_shared()
            self.assertEqual(a.records('external')[0]['id'], 'other')
            self.assertTrue(a.recoveries())

    def test_incomplete_snapshot_does_not_replace_working_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a = self.store(root / 'a', root / 'shared')
            a.batch({'put': [['files', {'id': 'synthetic'}]]})
            version = a.publish()['base']
            b = self.store(root / 'b', root / 'shared')
            manifest = json.loads((root / 'shared' / 'versions' / (version + '.json')).read_text())
            snapshot = root / 'shared' / 'objects' / manifest['records']['files']['synthetic']
            snapshot.write_bytes(b'incomplete')
            with self.assertRaisesRegex(ValueError, 'incomplete or damaged'):
                a.open_shared()
            with self.assertRaisesRegex(ValueError, 'incomplete or damaged'):
                b.open_shared()
            self.assertEqual(b.status()['base'], '')

    def test_delta_reuses_historical_content_and_cleanup_protects_references(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a = self.store(root / 'a', root / 'shared')
            key = a.save_blob(b'synthetic recording')
            a.batch({'put': [['files', {'id': 'night', 'blob': {'__ref': key}}]]})
            v1 = a.publish()['base']
            objects = {p.name: p.stat().st_mtime_ns for p in (a.shared / 'objects').iterdir()}
            a.batch({'put': [['markers', {'id': 'note', 'title': 'new note'}]]})
            v2 = a.publish()['base']
            for name, timestamp in objects.items(): self.assertEqual((a.shared / 'objects' / name).stat().st_mtime_ns, timestamp)
            self.assertEqual(len(list((a.shared / 'objects').iterdir())), 2)
            self.assertEqual(a.publish()['base'], v2)  # Consult-only save is a no-op.
            a.protect(v1, True)
            with self.assertRaises(ValueError): a.cleanup([v1])
            a.protect(v1, False)
            plan = a.cleanup([v1])
            a.cleanup([v1], True, plan['token'])
            self.assertEqual(a._load_version(v2)[3], {key})
            self.assertTrue(a.blob(key).exists())

    def test_interrupted_import_resume_and_complete_restore_preview(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a = self.store(root / 'a', root / 'shared')
            a.batch({'put': [['files', {'id': 'original'}]]})
            version = a.publish()['base']
            a.begin('import')
            a.batch({'put': [['files', {'id': 'partial'}]]})
            a.pause()
            self.assertEqual([x['id'] for x in a.records('files')], ['original'])
            self.assertEqual(a.latest(), version)
            with self.assertRaises(ValueError): a.publish()
            a.close()
            a = self.store(root / 'a', root / 'shared')
            a.begin('import')
            self.assertEqual(len(a.records('files')), 2)
            a.end(); a.publish()
            a.begin('restore')
            a.batch({'put': [['markers', {'id': 'restored-only'}]]})
            a.pause(); a.preview_pending()
            with self.assertRaisesRegex(ValueError, 'incomplete'): a.accept_restore()
            a.discard()
            a.begin('restore')
            a.batch({'put': [['markers', {'id': 'restored-only'}]]})
            a.end()
            self.assertEqual(a.records('files'), [])
            with self.assertRaises(ValueError): a.publish()
            a.accept_restore(); a.publish()
            self.assertEqual(a.records('files'), [])
            self.assertEqual(a.records('markers'), [{'id': 'restored-only'}])
            self.assertTrue(a.recoveries())

    def test_conflict_keeps_both_copies_and_schema_blocks_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a = self.store(root / 'a', root / 'shared')
            a.batch({'put': [['markers', {'id': 'note', 'text': 'initial'}]]})
            a.publish()
            b = self.store(root / 'b', root / 'shared')
            token = b.start()['token']
            b.confirm(token)
            b.batch({'put': [['markers', {'id': 'note', 'text': 'B unpublished'}]]}, token)
            a.batch({'put': [['markers', {'id': 'note', 'text': 'A published'}]]})
            v_a = a.publish()['base']
            with self.assertRaises(ValueError): b.publish(token)
            self.assertEqual(b.records('markers')[0]['text'], 'B unpublished')
            b.resolve('local', token)
            b.publish(token)
            self.assertEqual(b._load_version(v_a)[2][0][1], 'note')
            latest = b.latest()
            path = b.shared / 'versions' / (latest + '.json')
            manifest = json.loads(path.read_text());manifest['schema'] = 999
            path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, 'Unsupported'): b.publish(token)

    def test_legacy_v1_publication_migrates_without_removing_original(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a = self.store(root / 'a', root / 'shared')
            a.batch({'put': [['files', {'id': 'legacy'}]]})
            directory = a.shared / 'versions';directory.mkdir()
            version = 'a' * 32
            snapshot = directory / (version + '.sqlite')
            with a.connect() as source, a.connect(snapshot) as dest: source.backup(dest)
            with a.connect(snapshot) as db:
                db.execute("UPDATE meta SET value='0' WHERE key='dirty'")
                db.execute("UPDATE meta SET value=? WHERE key='base'", (version,))
            (directory / (version + '.json')).write_text(json.dumps(dict(id=version, parent='', database=digest(snapshot), blobs=[])))
            (a.shared / 'latest.json').write_text(json.dumps(dict(id=version)))
            b = self.store(root / 'b', root / 'shared')
            token = b.start()['token'];b.confirm(token)
            self.assertEqual(b.records('files'), [{'id': 'legacy'}])
            b.batch({'put': [['tombstones', {'id': '2024-01-01'}]]}, token)
            b.publish(token)
            self.assertTrue(snapshot.exists())
            self.assertEqual(json.loads((directory / (b.latest()+'.json')).read_text())['schema'], 2)

    def test_server_autosave_and_session_recovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a = self.store(root / 'a', root / 'shared')
            first = a.start()['token']
            with self.assertRaisesRegex(ValueError, 'Read-only'): a.batch({'put': [['markers', {'id': 'x'}]]}, first)
            a.confirm(first)
            a.batch({'put': [['markers', {'id': 'committed-before-browser-crash'}]]}, first)
            for _ in range(100):
                if a.latest(): break
                time.sleep(.03)
            self.assertFalse(a.status()['dirty'])
            second = a.start()['token']
            with self.assertRaisesRegex(ValueError, 'Another tab'): a.confirm(second)
            a.takeover(second)
            with self.assertRaisesRegex(ValueError, 'Read-only'): a.batch({'put': [['markers', {'id': 'old-tab'}]]}, first)
            a.begin('restore', second);a.end(second);a.accept_restore(second)
            a.publish(second)
            self.assertEqual(a.records('markers'), [])  # Empty backups replace exactly.


if __name__ == '__main__':
    unittest.main()
