#!/usr/bin/env python3
"""Measure independent zlib blocks and verify byte-identical reconstruction.

Usage: python3 tools/benchmark_polar_compression.py /path/to/export
No source files are changed. Compressed blocks are held one at a time in memory.
"""
import argparse
import hashlib
import json
import time
import zlib
from pathlib import Path


def benchmark(folder):
    result = []
    for path in sorted(folder.iterdir()):
        if not path.is_file() or path.name.startswith('.'):
            continue
        original = hashlib.sha256()
        restored = hashlib.sha256()
        source_bytes = compressed_bytes = 0
        compression_seconds = restoration_seconds = 0.0
        with path.open('rb') as f:
            while chunk := f.read(1024 * 1024):
                source_bytes += len(chunk)
                original.update(chunk)
                start = time.perf_counter()
                compressed = zlib.compress(chunk, 3)
                compression_seconds += time.perf_counter() - start
                compressed_bytes += len(compressed) + 4  # frame length
                start = time.perf_counter()
                restored.update(zlib.decompress(compressed))
                restoration_seconds += time.perf_counter() - start
        if original.digest() != restored.digest():
            raise ValueError('Round-trip checksum differs for ' + path.name)
        result.append(dict(source_bytes=source_bytes, compressed_bytes=compressed_bytes,
                           compression_seconds=compression_seconds,
                           restoration_seconds=restoration_seconds))
    if not result:
        raise ValueError('No input files found')
    return {k: sum(r[k] for r in result) for k in result[0]} | {'files': len(result), 'verified': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    print(json.dumps(benchmark(parser.parse_args().folder), indent=2))
