import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('ecgindex', Path(__file__).parents[1] / 'tools' / 'polar_ecg_index.py')
ecgindex = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ecgindex)


class ECGIndexTests(unittest.TestCase):
    def test_ranges_preserve_original_rows_across_gaps(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / '000_ecg.csv'
            raw = b'timestamp_unix_ns,ecg_uv,connection_segment\r\n100,1,1\r\n200,-2,1\r\n900,3,2\r\n1000,4,2\r\n'
            path.write_bytes(raw)
            index = ecgindex.build_index(path, rows_per_block=2)
            selected = ecgindex.select_blocks(index, 850, 1000)
            self.assertEqual(len(selected), 1)
            block = selected[0]
            self.assertEqual(raw[block['offset']:block['end_offset']], b'900,3,2\r\n1000,4,2\r\n')
            self.assertEqual(ecgindex.select_blocks(index, 300, 800), [])
            self.assertEqual(len(ecgindex.select_blocks(index, 200, 900)), 2)

    def test_malformed_or_backwards_rows_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'ecg.csv'
            for content in [b'timestamp_unix_ns,ecg_uv\n100,1\n90,2\n',
                            b'timestamp_unix_ns,ecg_uv\n100,not-a-number\n',
                            b'timestamp_unix_ns,ecg_uv\n100,"broken\nline"\n']:
                path.write_bytes(content)
                with self.assertRaises(ValueError):
                    ecgindex.build_index(path)

    def test_composite_index_and_range_cross_blob_boundaries(self):
        import hashlib
        with tempfile.TemporaryDirectory() as tmp:
            raw = b'timestamp_unix_ns,ecg_uv\n100,1\n200,2\n900,3\n1000,4\n'
            # Split in the middle of both a header and a data row.
            chunks = [raw[:13], raw[13:33], raw[33:]]
            paths = [Path(tmp) / str(i) for i in range(len(chunks))]
            for path, chunk in zip(paths, chunks):
                path.write_bytes(chunk)
            parts = [(path, hashlib.sha256(chunk).hexdigest()) for path, chunk in zip(paths, chunks)]
            index = ecgindex.build_composite_index(parts, rows_per_block=2)
            self.assertEqual(index['source_sha256'], hashlib.sha256(raw).hexdigest())
            self.assertEqual(index['source_bytes'], len(raw))
            for block in index['blocks']:
                self.assertEqual(ecgindex.read_composite_range(paths, block['offset'], block['end_offset']),
                                 raw[block['offset']:block['end_offset']])
            self.assertEqual(ecgindex.read_composite_range(paths, 10, 43), raw[10:43])
            paths[1].write_bytes(b'broken')
            with self.assertRaises(ValueError):
                ecgindex.build_composite_index(parts)
            with self.assertRaises(ValueError):
                ecgindex.read_composite_range(paths, 0, 9999)

    def test_overview_preserves_connection_and_timing_gaps(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'ecg.csv'
            path.write_bytes(b'timestamp_unix_ns,ecg_uv,connection_segment\n0,3,1\n10000000,-2,1\n20000000,8,2\n100000000,1,2\n')
            blocks = ecgindex.build_index(path)['blocks']
            self.assertEqual(len(blocks), 3)
            self.assertEqual((blocks[0]['minimum'], blocks[0]['maximum']), (-2, 3))
            self.assertEqual([b['rows'] for b in blocks], [2, 1, 1])
