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
                url = f'http://127.0.0.1:{ports[0]}/api/blob/{key}'
                for header, expected, bounds in [('bytes=0-2', b'EDF', 'bytes 0-2/13'),
                                                  ('bytes=4-', b'synthetic', 'bytes 4-12/13'),
                                                  ('bytes=-3', b'tic', 'bytes 10-12/13')]:
                    req = Request(url, headers={'X-BPG-Local': '1', 'Range': header})
                    with urlopen(req) as response:
                        self.assertEqual(response.status, 206)
                        self.assertEqual(response.headers['Content-Range'], bounds)
                        self.assertEqual(response.read(), expected)
                for header in ['bytes=13-', 'bytes=4-2', 'bytes=1-2,4-5', 'bytes=-0']:
                    req = Request(url, headers={'X-BPG-Local': '1', 'Range': header})
                    with self.assertRaises(HTTPError) as error:
                        urlopen(req)
                    self.assertEqual(error.exception.code, 416)
                with urlopen(Request(url, headers={'X-BPG-Local': '1'})) as response:
                    self.assertEqual(response.read(), b'EDF synthetic')
                call(ports[0], 'batch', {'put': [['files', {'id': 'demo', 'blob': {'__ref': key}}]]})
                ecg = b'timestamp_unix_ns,ecg_uv\n100,1\n200,2\n900,3\n'
                first = call(ports[0], 'blob', ecg[:29], 'application/octet-stream')['key']
                second = call(ports[0], 'blob', ecg[29:], 'application/octet-stream')['key']
                call(ports[0], 'batch', {'put': [['external', {'id': 'polar:test', 'polar': True,
                     'blobs': {'000_ecg.csv': {'__blobChunks': [{'__ref': first}, {'__ref': second}]}}}]]})
                index = call(ports[0], 'ecg-index', {'id': 'polar:test', 'filename': '000_ecg.csv'})
                self.assertEqual(index['source_sha256'], hashlib.sha256(ecg).hexdigest())
                self.assertEqual(index['source_bytes'], len(ecg))
                self.assertEqual(index['blocks'][0]['start_ns'], '100')
                self.assertEqual([p['size'] for p in index['parts']], [29, len(ecg)-29])
                with self.assertRaises(HTTPError):
                    call(ports[0], 'ecg-index', {'id': 'polar:test', 'filename': '../other.csv'})
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

    def test_cold_open_defers_ecg_and_media_but_validates_on_use_and_publish(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a = self.store(root / 'a', root / 'shared')
            ecg = a.save_blob(b'ecg synthetic')
            media = a.save_blob(b'photo synthetic')
            hr = a.save_blob(b'hr synthetic')
            a.batch({'put': [
                ['external', {'id': 'polar:one', 'polar': True, 'blobs': {
                    '000_ecg.csv': {'__ref': ecg}, '000_hr.csv': {'__ref': hr}}}],
                ['markers', {'id': 'note', 'media': [{'blob': {'__ref': media}}]}]]})
            initial = a.publish()['base']
            b = self.store(root / 'b', root / 'shared')
            with patch('portable_store.digest', wraps=digest) as calls:
                b.open_shared()
                reads = {Path(c.args[0]).name for c in calls.call_args_list}
            self.assertNotIn(ecg, reads)
            self.assertNotIn(media, reads)
            self.assertIn(hr, reads)
            self.assertFalse(b.blob(ecg).exists())
            self.assertFalse(b.blob(media).exists())
            self.assertTrue(b.blob(hr).exists())
            shared_ecg = b.shared / 'blobs' / ecg
            shared_ecg.write_bytes(b'incomplete')
            with self.assertRaisesRegex(ValueError, 'incomplete or damaged'):
                b.get_blob(ecg)
            self.assertFalse(b.blob(ecg).exists())
            b.batch({'put': [['markers', {'id': 'another', 'media': []}]]})
            with self.assertRaisesRegex(ValueError, 'incomplete or damaged'):
                b.publish()
            self.assertEqual(b.latest(), initial)
            shared_ecg.write_bytes(b'ecg synthetic')
            self.assertEqual(b.get_blob(ecg).read_bytes(), b'ecg synthetic')
            b.publish()
            self.assertTrue(b.blob(media).exists())

    def test_lossless_ecg_compression_is_resumable_and_versions_remain_readable(self):
        import zlib
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a = self.store(root/'a', root/'shared')
            header = b'timestamp_unix_ns,ecg_uv,connection_segment\n'
            ecg = header + b''.join(f'{i*10000000},{i%100},1\n'.encode() for i in range(140000))
            first, second = a.save_blob(ecg[:1000017]), a.save_blob(ecg[1000017:])
            original = {'id':'polar:one','polar':True,'blobs':{'000_ecg.csv':{'type':'text/csv','__blobChunks':[{'__ref':first},{'__ref':second}]}}}
            a.batch({'put':[['external',original]]})
            old_version = a.publish()['base']
            self.assertEqual(json.loads((a.shared/'versions'/(old_version+'.json')).read_text())['schema'], 2)
            a.begin('compression')
            self.assertEqual(a.compress_polar_ecg('polar:one')['files'], 1)
            pending_record = a.records('external')[0]
            blocks = pending_record['blobs']['000_ecg.csv']['__deflateChunks']
            reconstructed = b''.join(zlib.decompress(a.get_blob(x['__ref']).read_bytes()) for x in blocks)
            self.assertEqual(reconstructed, ecg)
            a.pause()
            self.assertEqual(a.records('external'), [original])
            self.assertEqual(a.latest(), old_version)
            a.begin('compression')
            self.assertEqual(a.compress_polar_ecg('polar:one')['files'], 0)
            a.end()
            new_version = a.publish()['base']
            self.assertEqual(json.loads((a.shared/'versions'/(new_version+'.json')).read_text())['schema'], 3)
            from unittest.mock import patch
            with patch('portable_store.SCHEMA', 2):
                with self.assertRaisesRegex(ValueError, 'Unsupported'):
                    a._compatible(json.loads((a.shared/'versions'/(new_version+'.json')).read_text()))
            self.assertEqual(a._load_version(old_version)[2][0][1], 'polar:one')
            index = a.ecg_index('polar:one', '000_ecg.csv')
            self.assertEqual(index['source_sha256'], hashlib.sha256(ecg).hexdigest())
            self.assertTrue(all(part['codec'] == 'deflate' for part in index['parts']))
            b = self.store(root/'b', root/'shared')
            b.open_shared()
            self.assertTrue(all(not b.blob(x['__ref']).exists() for x in blocks))
            self.assertEqual(b.ecg_index('polar:one', '000_ecg.csv')['source_sha256'], hashlib.sha256(ecg).hexdigest())
            with b.connect() as db:
                self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 3)
            a.begin('import')
            next_ref = a.save_blob(ecg)
            a.batch({'put':[['external',{'id':'polar:next','polar':True,'blobs':{'001_ecg.csv':{'__ref':next_ref}}}]]})
            self.assertEqual(a.compress_polar_ecg('polar:next')['files'], 1)
            self.assertIn('__deflateChunks', next(x for x in a.records('external') if x['id']=='polar:next')['blobs']['001_ecg.csv'])
            a.end(); a.publish()

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
