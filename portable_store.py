"""Incremental portable archive. The sync folder never holds a live database."""
import hashlib
import json
import os
import platform
import sqlite3
import tempfile
import threading
import time
import uuid
import zlib
from tools.polar_ecg_index import build_composite_index, build_compressed_index
from contextlib import contextmanager
from pathlib import Path

SCHEMA = 3
STORES = ('files', 'markers', 'external', 'tombstones', 'analysis', 'preferences')


def packed(value):
    return zlib.compress(json.dumps(value, sort_keys=True, allow_nan=False, separators=(',', ':')).encode())


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''): h.update(block)
    return h.hexdigest()


def valid_key(value, length=64):
    if not isinstance(value, str) or len(value) != length or any(c not in '0123456789abcdef' for c in value):
        raise ValueError('Invalid content/version identifier.')
    return value


def atomic_bytes(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        temp = Path(f.name)
        try:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        except BaseException:
            temp.unlink(missing_ok=True)
            raise
    try: os.replace(temp, path)
    finally: temp.unlink(missing_ok=True)


def refs(value):
    if isinstance(value, dict):
        if '__ref' in value: yield valid_key(value['__ref'])
        else:
            for child in value.values(): yield from refs(child)
    elif isinstance(value, list):
        # Scalar signal samples cannot contain attachment references.
        for child in value:
            if isinstance(child, (dict, list)):
                yield from refs(child)


class PortableStore:
    def __init__(self, local, shared):
        self.local, self.shared = [Path(p).expanduser().resolve() for p in (local, shared)]
        if self.local == self.shared or self.local in self.shared.parents or self.shared in self.local.parents:
            raise ValueError('Local and shared folders must be separate.')
        self.local.mkdir(parents=True, exist_ok=True)
        self.shared.mkdir(parents=True, exist_ok=True)
        self.blobs = self.local / 'blobs'
        self.blobs.mkdir(exist_ok=True)
        self.database, self.pending = self.local / 'working.sqlite', self.local / 'pending.sqlite'
        self.lock = threading.RLock()
        self.writer, self.operation, self.preview, self.last_error = None, None, False, ''
        self.verified_blobs = {}
        self.sleep_jobs = set()
        self.sessions = set()
        self.save_timer, self.stopping = None, False
        self._lock_file = open(self.local / 'archive.lock', 'a+b')
        try:
            if os.name == 'posix':
                import fcntl
                fcntl.flock(self._lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self._lock_file.close()
            raise ValueError('This local archive is already open in another server.')
        try:
            if self.database.exists():
                with self.connect() as db: prior_schema = db.execute('PRAGMA user_version').fetchone()[0]
                if prior_schema < 2: self.recovery()
            self._initialize(self.database)
        except BaseException:
            self._lock_file.close()
            raise

    def close(self):
        with self.lock:
            self.stopping = True
            if self.save_timer: self.save_timer.cancel()
            self._lock_file.close()

    def _schedule_save(self):
        if self.save_timer: self.save_timer.cancel()
        if not self.writer or self.operation or self.preview or self.pending.exists() or self.stopping: return
        def save():
            with self.lock:
                if self.stopping or not self.writer or self.operation or self.preview or self.pending.exists(): return
                try: self.publish()
                except (ValueError, OSError, sqlite3.Error, zlib.error) as exc: self.last_error = str(exc)
        self.save_timer = threading.Timer(1.5, save)
        self.save_timer.daemon = True
        self.save_timer.start()

    @contextmanager
    def connect(self, path=None):
        db = sqlite3.connect(path or self.database, timeout=30)
        try:
            with db: yield db
        finally: db.close()

    def _initialize(self, path):
        with self.connect(path) as db:
            prior_schema = db.execute('PRAGMA user_version').fetchone()[0]
            if prior_schema > SCHEMA:
                raise ValueError('Archive format is newer than this application. Update the app.')
            db.execute('CREATE TABLE IF NOT EXISTS records (store TEXT NOT NULL, id TEXT NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(store,id))')
            db.execute('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
            for key, value in [('base', ''), ('dirty', '0'), ('archive', uuid.uuid4().hex), ('operation', ''), ('complete', '0'), ('shared-path', str(self.shared))]:
                db.execute('INSERT OR IGNORE INTO meta VALUES (?,?)', (key, value))
            if self.meta(db, 'shared-path') != str(self.shared):
                raise ValueError('This working folder belongs to a different shared folder. Use a separate --data-dir.')
            if prior_schema == 0: db.execute('PRAGMA user_version=2')

    @staticmethod
    def meta(db, key):
        row = db.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
        return row[0] if row else ''

    def latest(self):
        path = self.shared / 'latest.json'
        return valid_key(json.loads(path.read_text())['id'], 32) if path.exists() else ''

    def active(self): return self.pending if self.operation or self.preview else self.database

    def status(self):
        with self.lock, self.connect() as db:
            base, dirty, error = self.meta(db, 'base'), self.meta(db, 'dirty') == '1', self.last_error
            latest, created = '', ''
            try:
                latest = self.latest()
                if latest:
                    manifest = json.loads((self.shared / 'versions' / (latest + '.json')).read_text())
                    self._compatible(manifest)
                    created = manifest.get('created', (self.shared / 'versions' / (latest + '.json')).stat().st_mtime)
            except (ValueError, OSError, KeyError) as exc:
                error = 'Shared publication is unavailable or incompatible: ' + str(exc)
            with self.connect(self.active()) as current:
                counts = {s: current.execute('SELECT COUNT(*) FROM records WHERE store=?', (s,)).fetchone()[0] for s in STORES}
            pending_kind, complete = '', False
            if self.pending.exists():
                with self.connect(self.pending) as pending:
                    pending_kind = self.meta(pending, 'operation')
                    complete = self.meta(pending, 'complete') == '1'
            return dict(schema=SCHEMA, format_version=db.execute('PRAGMA user_version').fetchone()[0], archive=self.meta(db, 'archive'), base=base, dirty=dirty,
                        latest=latest, created=created, counts=counts, conflict=base != latest,
                        pending=pending_kind, complete=complete, operation=bool(self.operation), preview=self.preview,
                        local=str(self.local), shared=str(self.shared), error=error)

    def start(self):
        with self.lock:
            if not self.writer and not self.operation and not self.preview and not self.pending.exists():
                with self.connect() as db: dirty = self.meta(db, 'dirty') == '1'
                if not dirty:
                    try:
                        if self.latest():
                            self.open_shared()
                        self.last_error = ''
                    except (ValueError, OSError, sqlite3.Error, zlib.error) as exc:
                        self.last_error = str(exc)
            token = uuid.uuid4().hex
            self.sessions.add(token)
            return dict(token=token, status=self.status())

    def confirm(self, token):
        with self.lock:
            if token not in self.sessions: raise ValueError('Session expired. Reload this page.')
            if self.writer and self.writer != token:
                raise ValueError('Another tab is editing. Close it and use Recover browser session if it cannot release its session.')
            if not self.writer and not self.pending.exists():
                with self.connect() as db: dirty = self.meta(db, 'dirty') == '1'
                if not dirty and self.latest(): self.open_shared()
            self.last_error = ''
            self.writer = token
            return self.status()

    def require_writer(self, token):
        if token is not None and (token != self.writer or token not in self.sessions):
            raise ValueError('Read-only session. Confirm Proton Drive synchronization before editing.')

    def takeover(self, token):
        with self.lock:
            if token not in self.sessions: raise ValueError('Reload the page first.')
            self.sessions = {token}
            self.writer, self.operation = token, None
            return self.status()

    def release(self, token):
        with self.lock:
            self.require_writer(token)
            result = self.publish()
            self.writer = None
            self.sessions.discard(token)
            return result

    def leave(self, token):
        """Best-effort browser departure. Durable local work never depends on it."""
        with self.lock:
            self.require_writer(token)
            self.operation, self.preview = None, False
            try:
                if not self.pending.exists(): self.publish()
            except (ValueError, OSError, sqlite3.Error, zlib.error) as exc:
                self.last_error = str(exc)
            finally:
                self.writer = None
                self.sessions.discard(token)
            return self.status()

    def records(self, store):
        if store not in STORES: raise ValueError('Invalid store.')
        with self.lock, self.connect(self.active()) as db:
            return [json.loads(zlib.decompress(row[0])) for row in db.execute('SELECT payload FROM records WHERE store=? ORDER BY id', (store,))]

    def write_records_json(self, store, destination):
        """Write validated stored JSON without rebuilding large signal arrays."""
        if store not in STORES: raise ValueError('Invalid store.')
        with self.lock, self.connect(self.active()) as db:
            destination.write(b'[')
            separator = b''
            for (payload,) in db.execute('SELECT payload FROM records WHERE store=? ORDER BY id', (store,)):
                raw = zlib.decompress(payload)
                json.loads(raw)  # Fail before sending a response if a record is damaged.
                destination.write(separator)
                destination.write(raw)
                separator = b','
            destination.write(b']')

    def blob(self, key): return self.blobs / valid_key(key)

    def get_blob(self, key):
        """Read through from shared storage after verifying its content hash."""
        key = valid_key(key)
        with self.lock:
            target = self.blob(key)
            if target.is_file():
                st = target.stat()
                stamp = (st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
                if self.verified_blobs.get(key) != stamp:
                    if digest(target) != key:
                        raise ValueError('Local attachment is incomplete or damaged.')
                    self.verified_blobs[key] = stamp
                return target
            # Only hydrate attachments referenced by the active working copy.
            referenced = False
            with self.connect(self.active()) as db:
                for (payload,) in db.execute('SELECT payload FROM records'):
                    if key in refs(json.loads(zlib.decompress(payload))):
                        referenced = True
                        break
            if not referenced:
                raise ValueError('Attachment is not referenced by this archive.')
            source = self.shared / 'blobs' / key
            data = source.read_bytes()
            if hashlib.sha256(data).hexdigest() != key:
                raise ValueError('Shared attachment is incomplete or damaged. Wait for Proton Drive sync.')
            atomic_bytes(target, data)
            st = target.stat()
            self.verified_blobs[key] = (st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
            return target

    def ecg_index(self, record_id, filename, token=None):
        """Build a disposable, verified byte index for one imported ECG file."""
        if not isinstance(record_id, str) or not isinstance(filename, str) or not filename.endswith('_ecg.csv'):
            raise ValueError('Invalid ECG selection.')
        records = [r for r in self.records('external') if r.get('id') == record_id and r.get('polar')]
        if len(records) != 1:
            raise ValueError('Polar recording not found.')
        blobs = records[0].get('blobs')
        if not isinstance(blobs, dict):
            raise ValueError('Invalid Polar blobs.')
        ref = blobs.get(filename)
        if not isinstance(ref, dict):
            raise ValueError('ECG file not found.')
        signature = hashlib.sha256(packed(ref)).hexdigest()
        index_id = 'ecgidx:' + hashlib.sha256((record_id+'\0'+filename).encode()).hexdigest()
        with self.lock, self.connect(self.active()) as db:
            row = db.execute('SELECT payload FROM records WHERE store=? AND id=?', ('analysis', index_id)).fetchone()
        if row:
            cached = json.loads(zlib.decompress(row[0]))
            if cached.get('signature') == signature and cached.get('method') == 'bpg-ecg-index-v1':
                return cached['index']
        compressed = '__deflateChunks' in ref
        chunks = ref.get('__deflateChunks') if compressed else ref.get('__blobChunks') if '__blobChunks' in ref else [ref]
        if not isinstance(chunks, list) or not chunks or any(not isinstance(c, dict) or '__ref' not in c for c in chunks):
            raise ValueError('Invalid ECG blob references.')
        keys = [valid_key(c['__ref']) for c in chunks]
        paths = [self.get_blob(key) for key in keys]
        parts = [(path, key) for path, key in zip(paths, keys)]
        stored_sizes = [path.stat().st_size for path in paths]
        if compressed:
            sizes = [c.get('size') for c in chunks]
            if any(not isinstance(n, int) or n <= 0 or n > 1048576 for n in sizes): raise ValueError('Invalid compressed ECG size.')
            hashes = [valid_key(c.get('sha256')) for c in chunks]
            index = build_compressed_index([(path, key, size, h) for path, key, size, h in zip(paths, keys, sizes, hashes)])
        else:
            sizes = stored_sizes
            index = build_composite_index(parts)
        if sum(sizes) != index['source_bytes'] or stored_sizes != [path.stat().st_size for path in paths]:
            raise ValueError('ECG source changed during indexing.')
        offset = 0
        descriptors = []
        for i, (key, size) in enumerate(zip(keys, sizes)):
            descriptor = {'key': key, 'offset': offset, 'size': size}
            if compressed: descriptor.update(codec='deflate', sha256=hashes[i], stored_size=stored_sizes[i])
            descriptors.append(descriptor)
            offset += size
        index['parts'] = descriptors
        # JSON numbers cannot exactly represent Unix nanoseconds in JavaScript.
        for block in index['blocks']:
            block['start_ns'] = str(block['start_ns'])
            block['end_ns'] = str(block['end_ns'])
        # Persist derived indexes only under the currently confirmed writer.
        # They contain no source bytes; the source refs are still validated on use.
        if token is not None and token == self.writer and token in self.sessions and not self.preview:
            self.batch({'put': [['analysis', {'id': index_id, 'night': records[0].get('night'),
                        'method': 'bpg-ecg-index-v1', 'signature': signature, 'index': index}]]}, token)
        return index

    def save_blob(self, data, token=None):
        self.require_writer(token)
        key = hashlib.sha256(data).hexdigest()
        with self.lock:
            path = self.blob(key)
            if not path.exists() or digest(path) != key: atomic_bytes(path, data)
        return key

    def batch(self, changes, token=None):
        with self.lock:
            self.require_writer(token)
            if self.preview: raise ValueError('Recovery preview is read-only. Accept or cancel it first.')
            if self.pending.exists() and not self.operation: raise ValueError('Resume or discard the interrupted operation before editing.')
            with self.connect(self.active()) as db:
                if self.meta(db, 'base') != self.latest():
                    raise ValueError('Shared archive changed. Resolve before editing.')
                latest = self.latest()
                if latest: self._compatible(json.loads((self.shared / 'versions' / (latest + '.json')).read_text()))
                before = db.total_changes
                for store in changes.get('clear', []):
                    if store not in STORES: raise ValueError('Invalid store.')
                    db.execute('DELETE FROM records WHERE store=?', (store,))
                for store, key in changes.get('delete', []):
                    if store not in STORES or not isinstance(key, str): raise ValueError('Invalid deletion.')
                    db.execute('DELETE FROM records WHERE store=? AND id=?', (store, key))
                for store, obj in changes.get('put', []):
                    if store not in STORES or not isinstance(obj, dict) or not isinstance(obj.get('id'), str): raise ValueError('Invalid record.')
                    for key in refs(obj):
                        path = self.get_blob(key)
                        if not path.is_file() or digest(path) != key: raise ValueError('Missing or damaged local attachment.')
                    if store == 'external' and isinstance(obj.get('blobs'), dict) and any(isinstance(v, dict) and '__deflateChunks' in v for v in obj['blobs'].values()):
                        db.execute('PRAGMA user_version=3')
                    payload = packed(obj)
                    old = db.execute('SELECT payload FROM records WHERE store=? AND id=?', (store, obj['id'])).fetchone()
                    if old and old[0] == payload: continue
                    db.execute('INSERT OR REPLACE INTO records VALUES (?,?,?)', (store, obj['id'], payload))
                if db.total_changes != before: db.execute("UPDATE meta SET value='1' WHERE key='dirty'")
            self._schedule_save()

    def compress_polar_ecg(self, record_id, token=None):
        """Losslessly replace one session's ECG refs in a pending transaction."""
        with self.lock:
            self.require_writer(token)
            if self.operation not in ('compression', 'import'): raise ValueError('Start or resume compression first.')
            matches = [r for r in self.records('external') if r.get('id') == record_id and r.get('polar')]
            if len(matches) != 1: raise ValueError('Polar recording not found.')
            rec = matches[0]
            blobs = rec.get('blobs')
            if not isinstance(blobs, dict): raise ValueError('Invalid Polar recording.')
            changed = 0
            for name, ref in list(blobs.items()):
                if not name.endswith('_ecg.csv') or '__deflateChunks' in ref: continue
                chunks = ref.get('__blobChunks') if '__blobChunks' in ref else [ref]
                if not isinstance(chunks, list) or not chunks: raise ValueError('Invalid ECG references.')
                compressed, before, after = [], hashlib.sha256(), hashlib.sha256()
                for item in chunks:
                    path = self.get_blob(item['__ref'])
                    with path.open('rb') as source:
                        while raw := source.read(1048576):
                            before.update(raw)
                            encoded = zlib.compress(raw, 3)
                            restored = zlib.decompress(encoded)
                            after.update(restored)
                            if restored != raw: raise ValueError('ECG compression verification failed.')
                            key = self.save_blob(encoded, token)
                            compressed.append({'__ref': key, 'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
                if before.digest() != after.digest() or not compressed: raise ValueError('ECG compression verification failed.')
                blobs[name] = {'__deflateChunks': compressed, 'type': ref.get('type', 'text/csv'), 'source_sha256': before.hexdigest()}
                changed += 1
            if changed: self.batch({'put': [['external', rec]]}, token)
            return {'files': changed}

    def begin(self, kind, token=None):
        with self.lock:
            self.require_writer(token)
            if kind not in ('import', 'restore', 'compression') or self.operation or self.preview: raise ValueError('Another operation is active.')
            with self.connect() as db:
                base = self.meta(db, 'base')
                if base != self.latest(): raise ValueError('Shared archive changed. Reload or resolve first.')
            if self.pending.exists():
                if kind == 'restore': raise ValueError('An interrupted restore exists. Preview/export or discard it first.')
                with self.connect(self.pending) as db:
                    if self.meta(db, 'operation') != kind or self.meta(db, 'base') != base:
                        raise ValueError('A different interrupted operation exists. Preview/export or discard it first.')
            else:
                with self.connect() as source, self.connect(self.pending) as dest: source.backup(dest)
                with self.connect(self.pending) as db:
                    db.execute("UPDATE meta SET value=? WHERE key='operation'", (kind,))
                    if kind == 'restore':
                        db.execute('DELETE FROM records')
                        db.execute('PRAGMA user_version=2')
                        db.execute("UPDATE meta SET value='1' WHERE key='dirty'")
            self.operation = kind
            return self.status()

    def end(self, token=None):
        with self.lock:
            self.require_writer(token)
            if not self.operation: raise ValueError('No operation active.')
            kind, self.operation = self.operation, None
            if kind == 'restore':
                with self.connect(self.pending) as db: db.execute("INSERT OR REPLACE INTO meta VALUES ('complete','1')")
                self.preview = True
            else:
                self._promote_pending()
                self._schedule_save()
            return self.status()

    def pause(self, token=None):
        with self.lock:
            self.require_writer(token)
            self.operation = None
            return self.status()

    def discard(self, token=None):
        with self.lock:
            self.require_writer(token)
            self.operation, self.preview = None, False
            if self.pending.exists():
                self.recovery(self.pending)
                self.pending.unlink()
            return self.status()

    def preview_pending(self, token=None):
        with self.lock:
            self.require_writer(token)
            if not self.pending.exists() or self.operation: raise ValueError('No interrupted operation available.')
            self.preview = True
            return self.status()

    def accept_restore(self, token=None):
        with self.lock:
            self.require_writer(token)
            if not self.preview: raise ValueError('Open the recovery preview first.')
            with self.connect(self.pending) as db:
                if self.meta(db, 'operation') != 'restore': raise ValueError('Resume the SD import before accepting it.')
                if self.meta(db, 'complete') != '1': raise ValueError('Interrupted restore is incomplete. Export it for recovery or restore the full backup again.')
            self._promote_pending()
            self.preview = False
            return self.status()

    def recovery(self, source=None):
        directory = self.local / 'recovery'
        directory.mkdir(exist_ok=True)
        target = directory / (str(int(time.time())) + '-' + uuid.uuid4().hex + '.sqlite')
        with self.connect(source or self.database) as db, self.connect(target) as copy: db.backup(copy)
        return target.name

    def _promote_pending(self):
        with self.connect(self.pending) as db:
            if self.meta(db, 'base') != self.latest(): raise ValueError('Shared archive changed during operation. Pending data preserved.')
            if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok': raise ValueError('Pending archive failed integrity check.')
            db.execute("UPDATE meta SET value='' WHERE key='operation'")
            changed = self.meta(db, 'dirty') == '1'
        if not changed:
            self.pending.unlink()
            return
        self.recovery()
        os.replace(self.pending, self.database)

    @staticmethod
    def _compatible(manifest):
        if manifest.get('schema', 1) not in (1, 2, SCHEMA): raise ValueError('Unsupported shared archive format. Update the application.')

    @staticmethod
    def _validate_record(store, key, obj):
        if store not in STORES or not isinstance(obj, dict) or obj.get('id') != key: raise ValueError('Invalid publication record.')

    @staticmethod
    def _track_record_refs(store, obj, keys, deferred, required):
        record_keys = set(refs(obj))
        keys.update(record_keys)
        if store == 'external' and obj.get('polar') and isinstance(obj.get('blobs'), dict):
            heavy = {k: v for k, v in obj['blobs'].items() if k.endswith('_ecg.csv')}
            deferred.update(refs(heavy))
            other = dict(obj)
            other['blobs'] = {k: v for k, v in obj['blobs'].items() if k not in heavy}
            required.update(refs(other))
        elif store == 'markers':
            deferred.update(refs(obj.get('media', [])))
            other = dict(obj)
            other.pop('media', None)
            required.update(refs(other))
        else:
            required.update(record_keys)

    def _load_version(self, version, defer_heavy=False, deferred_output=None):
        valid_key(version, 32)
        raw = (self.shared / 'versions' / (version + '.json')).read_bytes()
        manifest = json.loads(raw)
        self._compatible(manifest)
        if manifest['id'] != version: raise ValueError('Snapshot ID mismatch.')
        records, keys, deferred, required = [], set(), set(), set()
        if manifest.get('schema', 1) == 1:
            snapshot = self.shared / 'versions' / (version + '.sqlite')
            if digest(snapshot) != manifest['database']: raise ValueError('Snapshot is incomplete or damaged. Wait for Proton Drive sync.')
            with self.connect(snapshot) as source:
                if source.execute('PRAGMA integrity_check').fetchone()[0] != 'ok': raise ValueError('Legacy database failed integrity check.')
                for store, key, payload in source.execute('SELECT store,id,payload FROM records'):
                    obj = json.loads(zlib.decompress(payload))
                    self._validate_record(store, key, obj)
                    records.append((store, key, packed(obj)))
                    self._track_record_refs(store, obj, keys, deferred, required)
            archive = manifest.get('archive', 'legacy-' + version)
        else:
            if manifest.get('format') != 'bpg-portable': raise ValueError('Unknown publication format.')
            archive = manifest['archive']
            for store, entries in manifest['records'].items():
                for key, content in entries.items():
                    path = self.shared / 'objects' / valid_key(content)
                    if digest(path) != content: raise ValueError('Record is incomplete or damaged. Wait for Proton Drive sync.')
                    payload = path.read_bytes()
                    obj = json.loads(zlib.decompress(payload))
                    self._validate_record(store, key, obj)
                    records.append((store, key, payload))
                    self._track_record_refs(store, obj, keys, deferred, required)
        if keys != set(manifest['blobs']): raise ValueError('Publication attachment list mismatch.')
        deferred = deferred - required if defer_heavy else set()
        if deferred_output is not None:
            deferred_output.update(deferred)
        for key in keys:
            path = self.shared / 'blobs' / valid_key(key)
            if not path.is_file(): raise ValueError('Attachment is missing. Wait for Proton Drive sync.')
            if key not in deferred and digest(path) != key: raise ValueError('Attachment is incomplete or damaged. Wait for Proton Drive sync.')
        pointer = json.loads((self.shared / 'latest.json').read_text())
        if pointer['id'] == version and pointer.get('manifest') and hashlib.sha256(raw).hexdigest() != pointer['manifest']:
            raise ValueError('Manifest checksum mismatch.')
        return manifest, archive, records, keys

    def _install(self, version, force=False, historical=False):
        deferred = set()
        manifest, archive, records, keys = self._load_version(version, defer_heavy=True, deferred_output=deferred)
        with self.connect() as db:
            base = self.meta(db, 'base')
            if self.meta(db, 'dirty') == '1' and not force: raise ValueError('Unpublished local changes preserved. Resolve before opening shared data.')
        for key in keys - deferred:
            target = self.blob(key)
            if not target.exists() or digest(target) != key:
                data = (self.shared / 'blobs' / key).read_bytes()
                if hashlib.sha256(data).hexdigest() != key: raise ValueError('Attachment changed during installation.')
                atomic_bytes(target, data)
        if base == version and not force and not historical: return self.status()
        temp = self.local / ('install-' + uuid.uuid4().hex + '.sqlite')
        try:
            self._initialize(temp)
            with self.connect(temp) as db:
                db.executemany('INSERT INTO records VALUES (?,?,?)', records)
                if manifest.get('schema', 1) >= 3: db.execute('PRAGMA user_version=3')
                for key, value in [('base', self.latest() if historical else version), ('dirty', '1' if historical else '0'), ('archive', archive)]:
                    db.execute('UPDATE meta SET value=? WHERE key=?', (value, key))
            self.recovery()
            os.replace(temp, self.database)
        finally: temp.unlink(missing_ok=True)
        return self.status()

    def open_shared(self):
        with self.lock:
            if self.operation or self.preview or self.pending.exists(): raise ValueError('Interrupted operation preserved. Resume or discard it before loading shared data.')
            version = self.latest()
            if not version: raise ValueError('No published version in shared folder.')
            result = self._install(version)
            self.writer = None
            return result

    def publish(self, token=None):
        with self.lock:
            self.require_writer(token)
            if self.operation or self.preview or self.pending.exists(): raise ValueError('Finish or discard pending operation before publishing.')
            with self.connect() as db:
                base = self.meta(db, 'base')
                if base != self.latest(): raise ValueError('Shared archive changed. Both copies preserved; choose a conflict resolution.')
                if base: self._compatible(json.loads((self.shared / 'versions' / (base + '.json')).read_text()))
                if self.meta(db, 'dirty') != '1' and base: return self.status()
                version, index, keys, added = uuid.uuid4().hex, {s: {} for s in STORES}, set(), 0
                for store, key, payload in db.execute('SELECT store,id,payload FROM records'):
                    obj = json.loads(zlib.decompress(payload))
                    self._validate_record(store, key, obj)
                    payload = packed(obj)
                    content = hashlib.sha256(payload).hexdigest()
                    target = self.shared / 'objects' / content
                    if not target.exists() or digest(target) != content:
                        atomic_bytes(target, payload)
                        added += len(payload)
                    index[store][key] = content
                    keys.update(refs(obj))
                for key in keys:
                    local, target = self.get_blob(key), self.shared / 'blobs' / key
                    if digest(local) != key: raise ValueError('Local attachment is missing or damaged.')
                    if not target.exists() or digest(target) != key:
                        data = local.read_bytes()
                        atomic_bytes(target, data)
                        added += len(data)
                publication_schema = db.execute('PRAGMA user_version').fetchone()[0]
                manifest = dict(format='bpg-portable', schema=publication_schema, id=version, parent=base,
                                archive=self.meta(db, 'archive'), created=time.time(), device=platform.node(), records=index, blobs=sorted(keys))
                raw = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
                atomic_bytes(self.shared / 'versions' / (version + '.json'), raw)
                if self.latest() != base: raise ValueError('Shared archive changed during publication. Local changes preserved.')
                atomic_bytes(self.shared / 'latest.json', json.dumps(dict(id=version, schema=publication_schema, manifest=hashlib.sha256(raw).hexdigest())).encode())
                db.execute("UPDATE meta SET value=? WHERE key='base'", (version,))
                db.execute("UPDATE meta SET value='0' WHERE key='dirty'")
                db.commit()
            self.last_error = ''
            return dict(self.status(), addedBytes=added)

    def resolve(self, choice, token=None):
        with self.lock:
            self.require_writer(token)
            if self.operation or self.preview or self.pending.exists(): raise ValueError('Preserve/discard pending operation before resolving.')
            latest = self.latest()
            if choice == 'shared': return self._install(latest, force=True)
            if choice != 'local': raise ValueError('Choose local or shared explicitly.')
            if latest: self._load_version(latest)
            self.recovery()
            with self.connect() as db:
                db.execute("UPDATE meta SET value=? WHERE key='base'", (latest,))
                db.execute("UPDATE meta SET value='1' WHERE key='dirty'")
            return self.status()

    def versions(self):
        with self.lock:
            latest, result = self.latest(), []
            for path in (self.shared / 'versions').glob('*.json'):
                m = json.loads(path.read_text())
                version = valid_key(m['id'], 32)
                result.append(dict(id=version, parent=m.get('parent', ''), created=m.get('created', path.stat().st_mtime),
                                   schema=m.get('schema', 1), current=version == latest, protected=path.with_suffix('.keep').exists()))
            return sorted(result, key=lambda x: x['created'], reverse=True)

    def restore_version(self, version, token=None):
        with self.lock:
            self.require_writer(token)
            if self.pending.exists() or self.operation or self.preview: raise ValueError('Finish pending operation first.')
            if self.status()['dirty'] or self.status()['base'] != self.latest(): raise ValueError('Save or resolve current copy before restoring.')
            return self._install(version, force=True, historical=True)

    def recoveries(self):
        return [dict(id=p.name, created=p.stat().st_mtime, bytes=p.stat().st_size) for p in sorted((self.local / 'recovery').glob('*.sqlite'), reverse=True)]

    def restore_recovery(self, name, token=None):
        with self.lock:
            self.require_writer(token)
            if Path(name).name != name or not name.endswith('.sqlite'): raise ValueError('Invalid recovery identifier.')
            source = self.local / 'recovery' / name
            if not source.is_file() or self.pending.exists() or self.operation or self.preview: raise ValueError('Recovery unavailable or operation pending.')
            with self.connect(source) as db:
                if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok': raise ValueError('Recovery failed integrity check.')
            with self.connect(source) as db, self.connect(self.pending) as dest: db.backup(dest)
            with self.connect(self.pending) as db:
                for key, value in [('operation', 'restore'), ('base', self.latest()), ('dirty', '1'), ('complete', '1')]:
                    db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', (key, value))
            self.preview = True
            return self.status()

    def protect(self, version, enabled, token=None):
        with self.lock:
            self.require_writer(token)
            path = self.shared / 'versions' / (valid_key(version, 32) + '.json')
            if not path.exists(): raise ValueError('Publication not available.')
            if enabled: atomic_bytes(path.with_suffix('.keep'), b'Protected recovery point\n')
            else: path.with_suffix('.keep').unlink(missing_ok=True)
            return self.versions()

    def cleanup(self, versions, execute=False, expected='', token=None):
        with self.lock:
            self.require_writer(token)
            if self.pending.exists() or self.operation or self.preview or self.status()['dirty']: raise ValueError('Finish and save work before cleanup.')
            latest, selected = self.latest(), set(versions)
            entries = {v['id']: v for v in self.versions()}
            if not selected or any(v not in entries or entries[v]['current'] or entries[v]['protected'] for v in selected):
                raise ValueError('Select existing, unprotected historical versions only.')
            keep_objects, keep_blobs = set(), set()
            for version in set(entries) - selected:
                m = json.loads((self.shared / 'versions' / (version + '.json')).read_text())
                self._compatible(m)
                keep_blobs.update(valid_key(k) for k in m['blobs'])
                for records in m.get('records', {}).values(): keep_objects.update(valid_key(k) for k in records.values())
            victims = []
            for version in selected:
                for suffix in ('.json', '.sqlite'):
                    p = self.shared / 'versions' / (valid_key(version, 32) + suffix)
                    if p.exists(): victims.append(p)
            for directory, keep in [('objects', keep_objects), ('blobs', keep_blobs)]:
                for p in (self.shared / directory).glob('*'):
                    if p.is_file() and p.name not in keep and p.stat().st_mtime < time.time() - 7 * 86400: victims.append(p)
            plan = dict(latest=latest, versions=sorted(selected), files=sorted(str(p.relative_to(self.shared)) for p in victims))
            fingerprint = hashlib.sha256(json.dumps(plan, sort_keys=True).encode()).hexdigest()
            result = dict(token=fingerprint, bytes=sum(p.stat().st_size for p in victims), files=len(victims), versions=len(selected))
            if execute:
                if fingerprint != expected or self.latest() != latest: raise ValueError('Cleanup plan changed. Preview again.')
                for p in victims: p.unlink(missing_ok=True)
            return result
