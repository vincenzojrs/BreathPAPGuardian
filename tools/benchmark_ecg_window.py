#!/usr/bin/env python3
"""Benchmark synthetic/local Polar ECG indexing and byte-range retrieval."""
import argparse
import hashlib
import json
import time
from pathlib import Path
from polar_ecg_index import build_index, select_blocks


def benchmark(paths, start, duration):
    t = time.perf_counter()
    indices = [(path, build_index(path)) for path in paths]
    index_seconds = time.perf_counter() - t
    def window(at):
        t0 = time.perf_counter()
        read = rows = 0
        for path, index in indices:
            with path.open('rb') as src:
                for block in select_blocks(index, at, at+duration):
                    src.seek(block['offset'])
                    data = src.read(block['end_offset']-block['offset'])
                    if hashlib.sha256(data).hexdigest() != block['sha256']:
                        raise ValueError('Block hash mismatch')
                    read += len(data)
                    rows += block['rows']
        return {'bytes':read, 'rows':rows, 'seconds':time.perf_counter()-t0}
    return {'source_bytes':sum(index['source_bytes'] for _,index in indices), 'files':len(paths),
            'index_seconds':index_seconds, 'first_window':window(start),
            'next_window':window(start+duration)}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    parser.add_argument('--window-start-ns', type=int, required=True)
    parser.add_argument('--duration-seconds', type=int, default=120)
    args = parser.parse_args()
    files = sorted(args.folder.glob('*_ecg.csv'))
    if not files or args.duration_seconds <= 0:
        raise SystemExit('Select ECG CSV files and a positive duration')
    print(json.dumps(benchmark(files,args.window_start_ns,args.duration_seconds*1_000_000_000),indent=2))
