"""Experimental byte index for a local PolarPAP ECG CSV.

The index records complete CSV row boundaries and inclusive timestamp bounds.
It deliberately rejects multiline fields and malformed rows rather than
returning a partial signal. Callers must verify the indexed file hash before
using offsets and convert PAP clock windows to UTC before selecting blocks.
"""
import csv
import hashlib
import io
import math
from pathlib import Path


def build_index(path, rows_per_block=16384):
    with Path(path).open('rb') as stream:
        return build_index_stream(stream, rows_per_block)


def build_index_stream(stream, rows_per_block=16384):
    if not isinstance(rows_per_block, int) or rows_per_block < 1:
        raise ValueError('rows_per_block must be a positive integer')
    source_hash = hashlib.sha256()
    blocks = []
    previous = None
    previous_connection = None
    header_raw = stream.readline()
    source_hash.update(header_raw)
    position = len(header_raw)
    if not header_raw or not header_raw.endswith(b'\n'):
        raise ValueError('ECG CSV header must end with a newline')
    def parse(raw):
        try:
            row = list(csv.reader(io.StringIO(raw.decode('utf-8-sig'), newline=''), strict=True))
        except (UnicodeDecodeError, csv.Error) as exc:
            raise ValueError('Invalid ECG CSV record') from exc
        if len(row) != 1:
            raise ValueError('Multiline ECG CSV record is unsupported')
        return row[0]
    header = parse(header_raw)
    if len(header) != len(set(header)) or not {'timestamp_unix_ns', 'ecg_uv'}.issubset(header):
        raise ValueError('Missing or duplicate ECG CSV columns')
    timestamp_column = header.index('timestamp_unix_ns')
    connection_column = header.index('connection_segment') if 'connection_segment' in header else None
    block = None
    while True:
        start = position
        raw = stream.readline()
        if not raw:
            break
        source_hash.update(raw)
        position += len(raw)
        row = parse(raw)
        if len(row) != len(header):
            raise ValueError('Inconsistent ECG CSV column count')
        try:
            timestamp = int(row[timestamp_column])
            value = float(row[header.index('ecg_uv')])
        except (ValueError, IndexError) as exc:
            raise ValueError('Invalid ECG timestamp or value') from exc
        if not math.isfinite(value):
            raise ValueError('Invalid ECG timestamp or value')
        if previous is not None and timestamp < previous:
            raise ValueError('ECG timestamps are not monotonic')
        connection = row[connection_column] if connection_column is not None else ''
        if block is not None and previous is not None and (timestamp - previous > 50_000_000 or connection != previous_connection):
            block['sha256'] = block_hash.hexdigest()
            blocks.append(block)
            block = None
        previous, previous_connection = timestamp, connection
        if block is None:
            block = {'offset': start, 'start_ns': timestamp, 'rows': 0, 'minimum': value, 'maximum': value}
            block_hash = hashlib.sha256()
        block_hash.update(raw)
        block['minimum'] = min(block['minimum'], value)
        block['maximum'] = max(block['maximum'], value)
        block['end_ns'] = timestamp
        block['end_offset'] = position
        block['rows'] += 1
        if block['rows'] == rows_per_block:
            block['sha256'] = block_hash.hexdigest()
            blocks.append(block)
            block = None
    if block:
        block['sha256'] = block_hash.hexdigest()
        blocks.append(block)
    return {'format': 'bpg-ecg-index-experiment-v1', 'source_sha256': source_hash.hexdigest(),
            'source_bytes': position, 'header': header_raw.decode('utf-8-sig'), 'blocks': blocks}


def select_blocks(index, start_ns, end_ns):
    if end_ns < start_ns:
        raise ValueError('Invalid time interval')
    return [b for b in index['blocks'] if b['start_ns'] <= end_ns and b['end_ns'] >= start_ns]


class VerifiedBlobStream(io.RawIOBase):
    """Concatenate immutable content-addressed blobs, verifying every hash."""
    def __init__(self, parts):
        super().__init__()
        self.parts = iter(parts)
        self.stream = None
        self.hash = None
        self.expected = None

    def readable(self):
        return True

    def readinto(self, target):
        if not target:
            return 0
        while True:
            if self.stream is None:
                try:
                    path, expected = next(self.parts)
                except StopIteration:
                    return 0
                if len(expected) != 64 or any(c not in '0123456789abcdef' for c in expected):
                    raise ValueError('Invalid blob hash')
                self.stream = Path(path).open('rb')
                self.hash = hashlib.sha256()
                self.expected = expected
            count = self.stream.readinto(target)
            if count:
                self.hash.update(memoryview(target)[:count])
                return count
            self.stream.close()
            self.stream = None
            if self.hash.hexdigest() != self.expected:
                raise ValueError('ECG blob failed integrity check')

    def close(self):
        if self.stream is not None:
            self.stream.close()
            self.stream = None
        super().close()


def build_composite_index(parts, rows_per_block=16384):
    with io.BufferedReader(VerifiedBlobStream(parts)) as stream:
        return build_index_stream(stream, rows_per_block)


def read_composite_range(paths, start, end):
    """Read a half-open logical range; source integrity must be verified first."""
    if start < 0 or end < start:
        raise ValueError('Invalid byte range')
    position = 0
    result = bytearray()
    for path in map(Path, paths):
        length = path.stat().st_size
        first, last = max(start, position), min(end, position + length)
        if first < last:
            with path.open('rb') as stream:
                stream.seek(first-position)
                data = stream.read(last-first)
                if len(data) != last-first:
                    raise ValueError('ECG blob changed during range read')
                result.extend(data)
        position += length
        if position >= end:
            break
    if position < end:
        raise ValueError('ECG byte range extends beyond the source')
    return bytes(result)

class VerifiedDeflateStream(io.RawIOBase):
    """Concatenate independently compressed, hash-verified original blocks."""
    def __init__(self, parts):
        super().__init__()
        self.parts = iter(parts)
        self.pending = b''
        self.offset = 0

    def readable(self):
        return True

    def readinto(self, target):
        if not target:
            return 0
        while self.offset == len(self.pending):
            try:
                path, key, expected_size, expected_hash = next(self.parts)
            except StopIteration:
                return 0
            packed_bytes = Path(path).read_bytes()
            if hashlib.sha256(packed_bytes).hexdigest() != key:
                raise ValueError('Compressed ECG blob failed integrity check')
            import zlib
            try:
                raw = zlib.decompress(packed_bytes)
            except zlib.error as exc:
                raise ValueError('Compressed ECG blob is invalid') from exc
            if len(raw) != expected_size or hashlib.sha256(raw).hexdigest() != expected_hash:
                raise ValueError('Restored ECG block failed integrity check')
            self.pending, self.offset = raw, 0
        n = min(len(target), len(self.pending)-self.offset)
        target[:n] = self.pending[self.offset:self.offset+n]
        self.offset += n
        return n


def build_compressed_index(parts, rows_per_block=16384):
    with io.BufferedReader(VerifiedDeflateStream(parts)) as stream:
        return build_index_stream(stream, rows_per_block)
