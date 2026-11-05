#!/usr/bin/env python3
"""Measure a complete compression migration on a disposable archive copy."""
import argparse
import hashlib
import json
import tempfile
import time
import zlib
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from portable_store import PortableStore

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('folder', type=Path)
args = parser.parse_args()
files = sorted(args.folder.glob('*_ecg.csv'))
if not files:
    raise SystemExit('No ECG CSV files')
with tempfile.TemporaryDirectory(prefix='bpg-compression-benchmark-') as temp:
    root = Path(temp)
    store = PortableStore(root/'work',root/'shared')
    try:
        original = {}
        sources = {}
        for file in files:
            raw = file.read_bytes()
            original[file.name] = {'__ref': store.save_blob(raw), 'type':'text/csv'}
            sources[file.name] = hashlib.sha256(raw).hexdigest()
        store.batch({'put':[['external',{'id':'polar:benchmark','polar':True,'blobs':original}]]})
        store.publish()
        start = time.perf_counter()
        store.begin('compression')
        store.compress_polar_ecg('polar:benchmark')
        store.end()
        published = store.publish()
        migration_seconds = time.perf_counter()-start
        rec = store.records('external')[0]
        compressed_bytes = 0
        for name, ref in rec['blobs'].items():
            digest = hashlib.sha256()
            for chunk in ref['__deflateChunks']:
                data = store.get_blob(chunk['__ref']).read_bytes()
                compressed_bytes += len(data)
                digest.update(zlib.decompress(data))
            if digest.hexdigest() != sources[name]:
                raise ValueError('Restored source differs')
        start=time.perf_counter()
        for name in rec['blobs']:
            store.ecg_index('polar:benchmark', name)
        print(json.dumps({'source_bytes':sum(f.stat().st_size for f in files),
                          'active_compressed_bytes':compressed_bytes,'files':len(files),
                          'migration_and_publish_seconds':migration_seconds,
                          'index_after_migration_seconds':time.perf_counter()-start,
                          'publication_added_bytes':published['addedBytes'],
                          'all_sources_verified':True},indent=2))
    finally:
        store.close()
