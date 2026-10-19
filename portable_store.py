"""Explicitly published, integrity checked portable archive. Python standard library only."""
import hashlib
import json
import os
import sqlite3
import tempfile
import threading
import uuid
import zlib
from pathlib import Path

STORES = ('files', 'markers', 'external')


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


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
    os.replace(temp, path)


def refs(value):
    if isinstance(value, dict):
        if '__ref' in value:
            yield value['__ref']
        else:
            for child in value.values():
                yield from refs(child)
    elif isinstance(value, list):
        for child in value:
            yield from refs(child)


class PortableStore:
    def __init__(self, local, shared):
        self.local = Path(local).expanduser().resolve()
        self.shared = Path(shared).expanduser().resolve()
        if self.local == self.shared or self.local in self.shared.parents or self.shared in self.local.parents:
            raise ValueError('Local and shared folders must be separate.')
        self.local.mkdir(parents=True, exist_ok=True)
        self.shared.mkdir(parents=True, exist_ok=True)
        self.blobs = self.local / 'blobs'
        self.blobs.mkdir(exist_ok=True)
        self.database = self.local / 'working.sqlite'
        self.lock = threading.RLock()
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS records (store TEXT NOT NULL, id TEXT NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(store,id))')
            db.execute('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
            db.execute("INSERT OR IGNORE INTO meta VALUES ('base', '')")
            db.execute("INSERT OR IGNORE INTO meta VALUES ('dirty', '0')")

    def connect(self):
        return sqlite3.connect(self.database, timeout=30)

    def meta(self, db, key):
        return db.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()[0]

    def latest(self):
        path = self.shared / 'latest.json'
        if not path.exists():
            return ''
        value = json.loads(path.read_text())['id']
        if not isinstance(value, str) or len(value) != 32 or any(c not in '0123456789abcdef' for c in value):
            raise ValueError('Invalid shared version pointer.')
        return value

    def status(self):
        with self.lock, self.connect() as db:
            counts = {store: db.execute('SELECT COUNT(*) FROM records WHERE store=?', (store,)).fetchone()[0] for store in STORES}
            return dict(base=self.meta(db, 'base'), dirty=self.meta(db, 'dirty') == '1', latest=self.latest(), counts=counts)

    def records(self, store):
        if store not in STORES:
            raise ValueError('Invalid store.')
        with self.lock, self.connect() as db:
            return [json.loads(zlib.decompress(row[0])) for row in db.execute('SELECT payload FROM records WHERE store=?', (store,))]

    def blob(self, key):
        if len(key) != 64 or any(c not in '0123456789abcdef' for c in key):
            raise ValueError('Invalid blob digest.')
        return self.blobs / key

    def save_blob(self, data):
        key = hashlib.sha256(data).hexdigest()
        path = self.blob(key)
        with self.lock:
            if not path.exists():
                atomic_bytes(path, data)
        return key

    def batch(self, changes):
        with self.lock, self.connect() as db:
            if self.meta(db, 'base') != self.latest():
                raise ValueError('A newer shared version exists. Open it before editing.')
            for store in changes.get('clear', []):
                if store not in STORES:
                    raise ValueError('Invalid store.')
                db.execute('DELETE FROM records WHERE store=?', (store,))
            for store, key in changes.get('delete', []):
                if store not in STORES or not isinstance(key, str):
                    raise ValueError('Invalid deletion.')
                db.execute('DELETE FROM records WHERE store=? AND id=?', (store, key))
            for store, obj in changes.get('put', []):
                if store not in STORES or not isinstance(obj, dict) or not isinstance(obj.get('id'), str):
                    raise ValueError('Invalid record.')
                for key in refs(obj):
                    path = self.blob(key)
                    if not path.is_file() or digest(path) != key:
                        raise ValueError('Missing or damaged local attachment.')
                packed = zlib.compress(json.dumps(obj, allow_nan=False, separators=(',', ':')).encode())
                db.execute('INSERT OR REPLACE INTO records VALUES (?,?,?)', (store, obj['id'], packed))
            db.execute("UPDATE meta SET value='1' WHERE key='dirty'")

    def _verify(self, version):
        manifest_path = self.shared / 'versions' / (version + '.json')
        manifest = json.loads(manifest_path.read_text())
        if manifest['id'] != version:
            raise ValueError('Snapshot ID mismatch.')
        snapshot = self.shared / 'versions' / (version + '.sqlite')
        if digest(snapshot) != manifest['database']:
            raise ValueError('Snapshot is incomplete or damaged. Wait for Proton Drive sync.')
        for key in manifest['blobs']:
            if digest(self.shared / 'blobs' / key) != key:
                raise ValueError('Attachment is incomplete or damaged. Wait for Proton Drive sync.')
        return manifest, snapshot

    def publish(self):
        with self.lock, self.connect() as db:
            base = self.meta(db, 'base')
            if base != self.latest():
                raise ValueError('Shared archive changed. Open the latest version before publishing.')
            version = uuid.uuid4().hex
            keys = set()
            for (payload,) in db.execute('SELECT payload FROM records'):
                keys.update(refs(json.loads(zlib.decompress(payload))))
            for key in keys:
                path = self.blob(key)
                if digest(path) != key:
                    raise ValueError('Local attachment is missing or damaged.')
            folder = self.shared / 'versions'
            folder.mkdir(parents=True, exist_ok=True)
            (self.shared / 'blobs').mkdir(exist_ok=True)
            for key in sorted(keys):
                target = self.shared / 'blobs' / key
                if not target.exists() or digest(target) != key:
                    atomic_bytes(target, self.blob(key).read_bytes())
            temp = self.local / ('snapshot-' + version + '.sqlite')
            try:
                with sqlite3.connect(temp) as copy:
                    db.backup(copy)
                    copy.execute("UPDATE meta SET value=? WHERE key='base'", (version,))
                    copy.execute("UPDATE meta SET value='0' WHERE key='dirty'")
                target = folder / (version + '.sqlite')
                atomic_bytes(target, temp.read_bytes())
                manifest = dict(id=version, parent=base, database=digest(target), blobs=sorted(keys))
                atomic_bytes(folder / (version + '.json'), json.dumps(manifest).encode())
                if self.latest() != base:
                    raise ValueError('Shared archive changed while publishing. This snapshot was not activated.')
                atomic_bytes(self.shared / 'latest.json', json.dumps({'id': version}).encode())
                db.execute("UPDATE meta SET value=? WHERE key='base'", (version,))
                db.execute("UPDATE meta SET value='0' WHERE key='dirty'")
                db.commit()
            finally:
                temp.unlink(missing_ok=True)
            return self.status()

    def open_shared(self):
        with self.lock:
            db = self.connect()
            try:
                return self._open_shared(db)
            finally:
                db.close()

    def _open_shared(self, db):
            version = self.latest()
            if not version:
                raise ValueError('No published version in shared folder.')
            if self.meta(db, 'dirty') == '1':
                raise ValueError('Local changes are unpublished. Publish them before opening shared data.')
            if version == self.meta(db, 'base'):
                return self.status()
            manifest, snapshot = self._verify(version)
            with sqlite3.connect(snapshot) as source:
                integrity = source.execute('PRAGMA integrity_check').fetchone()[0]
                if integrity != 'ok':
                    raise ValueError('Shared database failed integrity check.')
                actual = set()
                for (payload,) in source.execute('SELECT payload FROM records'):
                    actual.update(refs(json.loads(zlib.decompress(payload))))
                if actual != set(manifest['blobs']):
                    raise ValueError('Snapshot attachment list mismatch.')
            for key in manifest['blobs']:
                target = self.blob(key)
                if not target.exists() or digest(target) != key:
                    atomic_bytes(target, (self.shared / 'blobs' / key).read_bytes())
            # Keep a local recovery copy before replacing the working archive.
            recovery = self.local / 'previous.sqlite'
            with sqlite3.connect(recovery) as backup:
                db.backup(backup)
            db.close()
            atomic_bytes(self.database, snapshot.read_bytes())
            return self.status()
