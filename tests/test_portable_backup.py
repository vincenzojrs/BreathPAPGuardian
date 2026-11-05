"""Integrity and transaction tests for disk-backed backups."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile

from portable_backup import BackupTransfers, export_zip, restore_zip, unpack_record
from portable_store import PortableStore, digest


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.store('source')
        raw = b'timestamp_unix_ns,ecg_uv,connection_segment\n' + b'1000000000,42,1\n' * 10000
        self.original = raw
        key = self.source.save_blob(raw)
        self.source.batch({'put': [
            ['external', {'id': 'polar:test', 'night': '2026-11-01', 'polar': True,
                          'blobs': {'000_ecg.csv': {'__ref': key, 'type': 'text/csv'}}}],
            ['markers', {'id': 'marker', 'night': '2026-11-01', 'note': 'preserve me'}],
            ['analysis', {'id': 'sleep:2026-11-01', 'method': 'legacy', 'epochs': []}],
            ['preferences', {'id': 'view', 'signalOrder': ['Flow.40ms']}],
            ['tombstones', {'id': '2026-10-01', 'deleted': 1}]]})
        self.source.begin('compression')
        self.source.compress_polar_ecg('polar:test')
        self.source.end()
        self.backup = self.root / 'backup.bpg.zip'
        export_zip(self.source, self.backup)

    def store(self, name):
        store = PortableStore(self.root/name/'local', self.root/name/'shared')
        self.addCleanup(store.close)
        return store

    def rewrite(self, change):
        target = self.root/'changed.zip'
        with zipfile.ZipFile(self.backup) as source:
            data = {name: source.read(name) for name in source.namelist()}
        change(data)
        with zipfile.ZipFile(target, 'w') as output:
            for name, value in data.items():
                output.writestr(name, value)
        return target

    def test_independent_restore_preserves_records_and_original_ecg_bytes(self):
        target = self.store('target')
        target.batch({'put': [['markers', {'id':'old'}]]})
        # No read_bytes call is allowed on attachments in either direction.
        with patch.object(Path, 'read_bytes', side_effect=AssertionError('whole-file read')):
            export_zip(self.source, self.root/'bounded.zip')
            state = restore_zip(target, self.backup)
        self.assertTrue(state['preview'])
        self.assertTrue(state['complete'])
        self.assertEqual(target.records('markers'), self.source.records('markers'))
        with target.connect() as database:
            self.assertEqual(database.execute("SELECT COUNT(*) FROM records WHERE store='markers' AND id='old'").fetchone()[0],1)
        for kind in ['external','analysis','preferences','tombstones']:
            self.assertEqual(target.records(kind),self.source.records(kind))
        record = target.records('external')[0]
        import zlib
        restored = b''.join(zlib.decompress(target.blob(c['__ref']).read_bytes()) for c in record['blobs']['000_ecg.csv']['__deflateChunks'])
        self.assertEqual(restored, self.original)
        target.accept_restore()
        target.publish()
        self.assertEqual(target.status()['format_version'], 3)
        # A second client can load the restored publication.
        other = PortableStore(self.root/'other',target.shared)
        self.addCleanup(other.close)
        other.open_shared()
        self.assertEqual(other.records('external'),target.records('external'))

    def test_corrupt_or_extra_entries_leave_active_archive_untouched(self):
        def corrupt_blob(data):
            key=next(n for n in data if n.startswith('blobs/'))
            data[key]=b'x'*len(data[key])
        def corrupt_record(data):
            key=next(n for n in data if n.startswith('records/'))
            data[key]=b'corrupted'
        def missing_blob(data):
            del data[next(n for n in data if n.startswith('blobs/'))]
        for change in [corrupt_blob,corrupt_record,missing_blob,lambda data:data.update({'../escape':b'x'})]:
            with self.subTest(change=change):
                target=self.store('target-'+str(id(change)))
                target.batch({'put':[['markers',{'id':'preserved'}]]})
                before=digest(target.database)
                with self.assertRaises((ValueError,KeyError,zipfile.BadZipFile)):
                    restore_zip(target,self.rewrite(change))
                self.assertEqual(digest(target.database),before)
                self.assertFalse(target.pending.exists())
                self.assertFalse(target.preview)
        self.assertFalse((self.root/'escape').exists())

    def test_manifest_schema_and_device_validation_preserve_active_archive(self):
        def alter_manifest(data):
            manifest=json.loads(data['manifest.json'])
            manifest['archiveSchema']=2
            raw=json.dumps(manifest).encode()
            data['manifest.json']=raw
            data['manifest.sha256']=hashlib.sha256(raw).hexdigest().encode()
        target=self.store('target')
        with self.assertRaisesRegex(ValueError,'schema 3'):
            restore_zip(target,self.rewrite(alter_manifest))
        self.assertFalse(target.pending.exists())
        self.source.batch({'put':[
            ['files',{'id':'a','device':{'serial':'one','vendor':'Philips'}}],
            ['files',{'id':'b','device':{'serial':'two','vendor':'Philips'}}]]})
        export_zip(self.source,self.root/'multiple-devices.zip')
        with self.assertRaisesRegex(ValueError,'multiple PAP devices'):
            restore_zip(target,self.root/'multiple-devices.zip')
        self.assertFalse(target.pending.exists())

    def test_duplicate_entries_and_truncation_are_rejected(self):
        duplicate=self.root/'duplicate.zip'
        duplicate.write_bytes(self.backup.read_bytes())
        with warnings.catch_warnings():
            warnings.simplefilter('ignore',UserWarning)
            with zipfile.ZipFile(duplicate,'a') as archive:
                archive.writestr('manifest.json',b'{}')
        target=self.store('target')
        with self.assertRaises(ValueError):restore_zip(target,duplicate)
        truncated=self.root/'truncated.zip'
        truncated.write_bytes(self.backup.read_bytes()[:-30])
        with self.assertRaises(zipfile.BadZipFile):restore_zip(target,truncated)
        self.assertFalse(target.pending.exists())

    def test_stored_compressed_ecg_with_wrong_original_hash_cannot_be_exported(self):
        record=self.source.records('external')[0]
        record['blobs']['000_ecg.csv']['source_sha256']='0'*64
        self.source.batch({'put':[['external',record]]})
        path=self.root/'bad.zip'
        with self.assertRaisesRegex(ValueError,'Original ECG'):
            export_zip(self.source,path)
        self.assertFalse(path.exists())

    def test_upload_retries_and_session_ownership(self):
        target=self.store('target')
        session=target.start()['token']
        target.confirm(session)
        transfers=BackupTransfers(target)
        self.addCleanup(transfers.close)
        raw=self.backup.read_bytes()
        upload=transfers.upload_start(session,len(raw))
        key=upload['id']
        first=raw[:100]
        self.assertEqual(transfers.upload_chunk(session,key,0,first)['offset'],100)
        self.assertEqual(transfers.upload_chunk(session,key,0,first)['offset'],100)
        with self.assertRaises(ValueError):transfers.upload_chunk(session,key,0,b'x'*100)
        with self.assertRaises(ValueError):transfers.upload_finish(session,key)
        with self.assertRaises(ValueError):transfers.upload_chunk('other',key,100,raw[100:])
        transfers.upload_chunk(session,key,100,raw[100:])
        state=transfers.upload_finish(session,key)
        self.assertTrue(state['preview'])
        self.assertTrue(transfers.upload_finish(session,key)['preview'])
        self.assertEqual(target.records('markers'),self.source.records('markers'))

    def test_read_only_download_and_unknown_capability(self):
        transfers=BackupTransfers(self.source)
        self.addCleanup(transfers.close)
        token=self.source.start()['token']
        self.assertIsNone(self.source.writer)
        job=transfers.prepare(token)
        with transfers.download(job['id']) as source:
            self.assertEqual(source.read(4),b'PK\x03\x04')
        with self.assertRaises(ValueError):transfers.download('0'*32)
        with self.assertRaises(ValueError):transfers.prepare('missing-session')


if __name__=='__main__':unittest.main()
