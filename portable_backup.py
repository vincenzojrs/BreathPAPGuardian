"""Disk-backed portable backups. Attachment memory is bounded by BLOCK_SIZE."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import time
import uuid
import zipfile
import zlib

from portable_store import STORES, SCHEMA, digest, refs, valid_key

BLOCK_SIZE = 1024 * 1024
UPLOAD_BLOCK_SIZE = 8 * BLOCK_SIZE
MAX_BACKUP_SIZE = 100 * 1024**3
MAX_METADATA_SIZE = 128 * BLOCK_SIZE
FORMAT = 'bpg-backup-v4'


def read_json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('Duplicate backup metadata key.')
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=unique)


def unpack_record(payload):
    decoder = zlib.decompressobj()
    raw = decoder.decompress(payload, MAX_METADATA_SIZE + 1)
    if len(raw) > MAX_METADATA_SIZE or not decoder.eof or decoder.unused_data:
        raise ValueError('Invalid or oversized backup record.')
    return read_json(raw)


def copy_verified(source, destination, expected, size=None):
    checksum = hashlib.sha256()
    copied = 0
    while block := source.read(BLOCK_SIZE):
        destination.write(block)
        checksum.update(block)
        copied += len(block)
    if checksum.hexdigest() != expected or size is not None and copied != size:
        raise ValueError('Backup attachment checksum or size mismatch.')
    return copied


def verify_ecg(record, blob_path):
    """Check original bytes as well as hashes of stored compressed chunks."""
    blobs = record.get('blobs', {})
    if not isinstance(blobs, dict):
        return
    for value in blobs.values():
        if not isinstance(value, dict) or '__deflateChunks' not in value:
            continue
        chunks = value['__deflateChunks']
        if not isinstance(chunks, list) or not chunks:
            raise ValueError('Invalid compressed ECG in backup.')
        original = hashlib.sha256()
        for chunk in chunks:
            size = chunk.get('size')
            if type(size) is not int or not 0 < size <= BLOCK_SIZE:
                raise ValueError('Invalid compressed ECG chunk size.')
            path = blob_path(valid_key(chunk['__ref']))
            if path.stat().st_size > 2 * BLOCK_SIZE:
                raise ValueError('Oversized compressed ECG chunk.')
            with path.open('rb') as source:
                encoded = source.read(2 * BLOCK_SIZE + 1)
            decoder = zlib.decompressobj()
            raw = decoder.decompress(encoded, size + 1)
            if (len(raw) != size or not decoder.eof or decoder.unused_data
                    or hashlib.sha256(raw).hexdigest() != chunk['sha256']):
                raise ValueError('Original ECG verification failed.')
            original.update(raw)
        if original.hexdigest() != value.get('source_sha256'):
            raise ValueError('Original ECG file checksum mismatch.')


def export_zip(store, destination):
    """Export one consistent snapshot with only its referenced attachments."""
    destination = Path(destination)
    try:
        with store.lock, store.connect(store.active()) as database:
            if store.operation or store.preview and store.meta(database, 'complete') != '1':
                raise ValueError('Finish or pause the current operation before backup.')
            schema = database.execute('PRAGMA user_version').fetchone()[0]
            manifest = {'format': FORMAT, 'schema': 4, 'archiveSchema': schema,
                        'created': time.time(), 'records': {s: {} for s in STORES}, 'blobs': {}}
            keys = set()
            def blob_path(key):
                local = store.blob(key)
                return local if local.is_file() else store.shared / 'blobs' / key
            with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
                written = set()
                for kind, key, payload in database.execute('SELECT store,id,payload FROM records ORDER BY store,id'):
                    record = unpack_record(payload)
                    store._validate_record(kind, key, record)
                    verify_ecg(record, blob_path)
                    content = hashlib.sha256(payload).hexdigest()
                    manifest['records'][kind][key] = content
                    if content not in written:
                        archive.writestr('records/' + content, payload)
                        written.add(content)
                    keys.update(refs(record))
                for key in sorted(keys):
                    with blob_path(key).open('rb') as source, archive.open('blobs/' + key, 'w', force_zip64=True) as target:
                        manifest['blobs'][key] = copy_verified(source, target, key)
                raw = json.dumps(manifest, sort_keys=True, allow_nan=False, separators=(',', ':')).encode()
                if len(raw) > MAX_METADATA_SIZE:
                    raise ValueError('Backup manifest is too large.')
                archive.writestr('manifest.json', raw)
                archive.writestr('manifest.sha256', hashlib.sha256(raw).hexdigest())
        return destination
    except BaseException:
        destination.unlink(missing_ok=True)
        raise


def restore_zip(store, source, token=None):
    """Validate in staging, then atomically expose a complete restore preview."""
    with store.lock:
        store.require_writer(token)
        if store.operation or store.preview or store.pending.exists():
            raise ValueError('Finish or discard the current operation before restoring.')
        with store.connect() as current:
            base = store.meta(current, 'base')
            archive_id = store.meta(current, 'archive')
        if store.latest() != base:
            raise ValueError('Shared archive changed. Reload or resolve first.')
        with tempfile.TemporaryDirectory(prefix='backup-restore-', dir=store.local) as temp:
            folder = Path(temp)
            blobs = folder / 'blobs'
            blobs.mkdir()
            database_path = folder / 'restore.sqlite'
            store._initialize(database_path)
            with zipfile.ZipFile(source) as archive:
                entries = archive.infolist()
                names = {entry.filename for entry in entries}
                if len(entries) > 250000 or len(names) != len(entries):
                    raise ValueError('Duplicate or excessive backup entries.')
                if any(entry.compress_type != zipfile.ZIP_STORED or entry.flag_bits & 1 for entry in entries):
                    raise ValueError('Unsupported backup ZIP encoding.')
                if archive.getinfo('manifest.json').file_size > MAX_METADATA_SIZE:
                    raise ValueError('Oversized backup manifest.')
                raw = archive.read('manifest.json')
                if archive.getinfo('manifest.sha256').file_size != 64 or hashlib.sha256(raw).hexdigest().encode() != archive.read('manifest.sha256'):
                    raise ValueError('Backup manifest checksum mismatch.')
                manifest = read_json(raw)
                schema = manifest.get('archiveSchema')
                if (manifest.get('format') != FORMAT or manifest.get('schema') != 4
                        or type(schema) is not int or schema not in (2, SCHEMA)
                        or not isinstance(manifest.get('records'), dict) or set(manifest['records']) != set(STORES)
                        or not isinstance(manifest.get('blobs'), dict)):
                    raise ValueError('Unsupported backup format.')
                expected = {'manifest.json', 'manifest.sha256'}
                keys = set()
                serials, vendors = set(), set()
                with store.connect(database_path) as database:
                    for kind, records in manifest['records'].items():
                        if not isinstance(records, dict):
                            raise ValueError('Invalid backup record index.')
                        for key, content in records.items():
                            name = 'records/' + valid_key(content)
                            expected.add(name)
                            if archive.getinfo(name).file_size > MAX_METADATA_SIZE:
                                raise ValueError('Oversized backup record.')
                            payload = archive.read(name)
                            if hashlib.sha256(payload).hexdigest() != content:
                                raise ValueError('Backup record checksum mismatch.')
                            record = unpack_record(payload)
                            store._validate_record(kind, key, record)
                            if kind == 'files':
                                if any(record.get(field) is not None and not isinstance(record[field], dict) for field in ('tags', 'device', 'parsed')):
                                    raise ValueError('Invalid PAP backup metadata.')
                                serial = (record.get('tags') or {}).get('SRN') or (record.get('device') or {}).get('serial')
                                if serial:
                                    serials.add(str(serial))
                                if (record.get('device') or {}).get('vendor') == 'Philips' or (record.get('parsed') or {}).get('vendor') == 'Philips':
                                    vendors.add('Philips')
                                elif record.get('parsed') or str(record.get('name', '')).lower().endswith(('.edf', '.tgt')):
                                    vendors.add('ResMed')
                            keys.update(refs(record))
                            database.execute('INSERT INTO records VALUES (?,?,?)', (kind, key, payload))
                    if len(serials) > 1 or len(vendors) > 1:
                        raise ValueError('Backup contains multiple PAP devices.')
                    if keys != set(manifest['blobs']):
                        raise ValueError('Backup attachment index mismatch.')
                    for key, size in manifest['blobs'].items():
                        name = 'blobs/' + valid_key(key)
                        expected.add(name)
                        if type(size) is not int or size < 0 or archive.getinfo(name).file_size != size:
                            raise ValueError('Backup attachment size mismatch.')
                    if names != expected:
                        raise ValueError('Unexpected or missing backup entries.')
                    for key, size in manifest['blobs'].items():
                        with archive.open('blobs/' + key) as source_stream, (blobs / key).open('xb') as target:
                            copy_verified(source_stream, target, key, size)
                    for (payload,) in database.execute("SELECT payload FROM records WHERE store='external'"):
                        record = unpack_record(payload)
                        record_blobs = record.get('blobs')
                        if schema < 3 and isinstance(record_blobs, dict) and any(isinstance(v, dict) and '__deflateChunks' in v for v in record_blobs.values()):
                            raise ValueError('Compressed ECG requires archive schema 3.')
                        verify_ecg(record, lambda key: blobs / valid_key(key))
                    database.execute('PRAGMA user_version=' + str(schema))
                    for key, value in [('base', base), ('archive', archive_id), ('dirty', '1'), ('operation', 'restore'), ('complete', '1')]:
                        database.execute('UPDATE meta SET value=? WHERE key=?', (value, key))
                if store.latest() != base:
                    raise ValueError('Shared archive changed during restore. Retry after reloading.')
                for blob in blobs.iterdir():
                    target = store.blob(blob.name)
                    if not target.exists() or digest(target) != blob.name:
                        os.replace(blob, target)
                if store.save_timer:
                    store.save_timer.cancel()
                os.replace(database_path, store.pending)
                store.preview = True
                return store.status()


class BackupTransfers:
    """Temporary download capabilities and bounded, retryable file uploads."""
    def __init__(self, store):
        self.store = store
        self.directory = tempfile.TemporaryDirectory(prefix='backup-transfers-', dir=store.local)
        self.jobs = {}
        self.lock = threading.RLock()

    def close(self):
        self.directory.cleanup()

    def create(self, kind, owner, size=0):
        with self.lock:
            # Expire abandoned transfers when a new transfer is requested.
            for key, job in list(self.jobs.items()):
                if time.time() - job['created'] > 3600:
                    job['path'].unlink(missing_ok=True)
                    del self.jobs[key]
            if len(self.jobs) >= 16:
                raise ValueError('Too many temporary backups. Restart the server after saving your work.')
            key = uuid.uuid4().hex
            path = Path(self.directory.name) / (key + '.zip')
            job = {'kind': kind, 'owner': owner, 'size': size, 'offset': 0,
                   'path': path, 'created': time.time()}
            self.jobs[key] = job
            return key, job

    def prepare(self, token):
        with self.store.lock:
            if token not in self.store.sessions:
                raise ValueError('Session expired. Reload this page.')
            key, job = self.create('download', token)
            try:
                export_zip(self.store, job['path'])
            except BaseException:
                with self.lock:
                    self.jobs.pop(key, None)
                raise
            job['ready'] = True
            return {'id': key, 'size': job['path'].stat().st_size,
                    'url': '/api/backup/download/' + key, 'filename': 'bpg-backup-' + key[:12] + '.bpg.zip'}

    def download(self, key):
        with self.lock:
            job = self.jobs.get(valid_key(key, 32))
            if not job or job['kind'] != 'download' or not job.get('ready'):
                raise ValueError('Backup download expired. Prepare it again.')
            # Open while holding the registry lock, before cleanup can unlink it.
            return job['path'].open('rb')

    def upload_start(self, token, size):
        with self.store.lock:
            self.store.require_writer(token)
            if self.store.operation or self.store.preview or self.store.pending.exists():
                raise ValueError('Finish the current operation first.')
            if type(size) is not int or not 0 < size <= MAX_BACKUP_SIZE:
                raise ValueError('Invalid backup size (maximum 100 GiB).')
            if shutil.disk_usage(self.store.local).free < 2 * size + 256 * BLOCK_SIZE:
                raise ValueError('Insufficient disk space for upload and verified restore.')
            key, job = self.create('upload', token, size)
            job['path'].touch(exist_ok=False)
            return {'id': key, 'offset': 0, 'chunkSize': UPLOAD_BLOCK_SIZE}

    def upload_chunk(self, token, key, offset, data):
        with self.store.lock, self.lock:
            self.store.require_writer(token)
            job = self.jobs.get(valid_key(key, 32))
            if not job or job['kind'] != 'upload' or job['owner'] != token:
                raise ValueError('Backup upload expired or belongs to another session.')
            if not data or len(data) > UPLOAD_BLOCK_SIZE or offset < 0 or offset + len(data) > job['size']:
                raise ValueError('Invalid backup block.')
            if offset == job['offset']:
                with job['path'].open('r+b') as target:
                    target.seek(offset)
                    target.truncate()
                    try:
                        target.write(data)
                        target.flush()
                    except OSError:
                        target.seek(offset)
                        target.truncate()
                        raise
                job['offset'] += len(data)
            elif offset + len(data) <= job['offset']:
                with job['path'].open('rb') as target:
                    target.seek(offset)
                    if target.read(len(data)) != data:
                        raise ValueError('Retried backup block differs.')
            else:
                raise ValueError('Unexpected backup upload offset.')
            return {'offset': job['offset']}

    def upload_finish(self, token, key):
        with self.store.lock, self.lock:
            self.store.require_writer(token)
            job = self.jobs.get(valid_key(key, 32))
            if job and job['kind'] == 'restored' and job['owner'] == token:
                return self.store.status()
            if not job or job['kind'] != 'upload' or job['owner'] != token or job['offset'] != job['size']:
                raise ValueError('Incomplete or expired backup upload.')
            try:
                result = restore_zip(self.store, job['path'], token)
            except BaseException:
                del self.jobs[key]
                raise
            finally:
                job['path'].unlink(missing_ok=True)
            job['kind'] = 'restored'
            return result
