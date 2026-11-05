import csv
import importlib.util
import tempfile
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('rrproto', Path(__file__).parents[1] / 'tools' / 'polar_rr_prototype.py')
rrproto = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rrproto)


class RRPrototypeTests(unittest.TestCase):
    def test_gaps_rejections_and_connections_split_without_bridging(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            with (folder / '000_rr.csv').open('w', newline='') as out:
                writer = csv.writer(out)
                writer.writerow(['timestamp_unix_ns', 'rr_ms', 'sensor_contact', 'screen_accepted', 'connection_segment'])
                for second, accepted, connection in [(0,'true','1'),(1,'true','1'),(2,'false','1'),(3,'true','1'),(4,'true','1'),(8,'true','1'),(9,'true','1'),(10,'true','2'),(11,'true','2')]:
                    writer.writerow([second*1000000000,1000,'true',accepted,connection])
            segments, hashes = rrproto.read_segments(folder)
            self.assertEqual([[n//1000000000 for n in s] for s in segments], [[0,1],[3,4],[8,9],[10,11]])
            self.assertEqual(list(hashes), ['000_rr.csv'])

    def write_rr(self, folder, rows):
        with (folder / '000_rr.csv').open('w', newline='') as out:
            writer = csv.writer(out)
            writer.writerow(['timestamp_unix_ns', 'rr_ms', 'sensor_contact', 'screen_accepted', 'connection_segment'])
            writer.writerows(rows)

    def test_session_bounds_exclude_samples_before_segmentation(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            ns = 1_000_000_000
            # Outliers, including an interleaved future timestamp, must not
            # poison the monotonicity check or the valid segment.
            self.write_rr(folder, [(n, 1000, 'true', 'true', '1')
                                   for n in [-ns, 0, ns, 4*ns, 2*ns, 3*ns, 3*ns+464_000_000]])
            stats = {}
            segments, hashes = rrproto.read_segments(folder, (0, 3*ns), stats)
            self.assertEqual(segments, [[0, ns, 2*ns, 3*ns]])
            self.assertEqual(stats['outside_session'], 3)
            self.assertEqual(stats['accepted'], 4)
            self.assertEqual(stats['nonmonotonic'], 0)
            import hashlib
            self.assertEqual(hashes['000_rr.csv'], hashlib.sha256((folder/'000_rr.csv').read_bytes()).hexdigest())

    def test_filtering_retains_real_gaps_and_contact_loss(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            ns = 1_000_000_000
            self.write_rr(folder, [(n*ns, 1000, contact, 'true', '1') for n, contact in
                                   [(0,'true'),(1,'true'),(2,'false'),(3,'true'),(4,'true'),(8,'true'),(9,'true'),(11,'true')]])
            segments, _ = rrproto.read_segments(folder, (0, 10*ns))
            self.assertEqual(segments, [[0,ns],[3*ns,4*ns],[8*ns,9*ns]])

    def test_in_range_reversed_timestamps_remain_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            ns = 1_000_000_000
            self.write_rr(folder, [(n*ns,1000,'true','true','1') for n in [0,1,2,1,2,3,4]])
            stats = {}
            segments, _ = rrproto.read_segments(folder, (0, 5*ns), stats)
            self.assertEqual(segments, [[0,ns,2*ns],[3*ns,4*ns]])
            self.assertEqual(stats['nonmonotonic'], 2)

    def test_diagnostics_match_full_context_gates_without_runtime(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            ns = 1_000_000_000
            self.write_rr(folder, [(n*ns,1000,'true','true','1') for n in range(601)])
            (folder/'session.json').write_text(json.dumps({'schema_version':1,
                'start_unix_ns':'0','end_unix_ns':str(600*ns)}))
            report = rrproto.coverage_diagnostics(folder)
            self.assertEqual(report['complete_session_epochs'], 20)
            self.assertEqual(report['epochs_with_rr_context'], 12)
            self.assertEqual(report['samples']['accepted'], 601)
            self.assertEqual(report['segments_skipped_by_length'], 0)
            self.assertNotIn('epochs', report)
            self.write_rr(folder, [(n*ns,1000,'true','false' if n == 300 else 'true','1') for n in range(601)])
            split = rrproto.coverage_diagnostics(folder)
            self.assertEqual(split['epochs_with_rr_context'], 1)
            self.assertEqual(split['samples']['screen_rejected'], 1)
            self.assertEqual(split['samples']['screen_reasons'], {'unspecified': 1})

    def test_shift_metadata_is_checked_without_reapplying_shift(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            session = {'schema_version': 1, 'start_unix_ns': '110', 'end_unix_ns': '200',
                       'time_shift_applied': True, 'time_shift_source_start_unix_ns': '100',
                       'time_shift_target_start_unix_ns': '110', 'time_shift_offset_ns': '10'}
            path = folder / 'session.json'
            path.write_text(json.dumps(session))
            self.assertEqual(rrproto.session_info(folder)[:2], (110, 200))
            session['time_shift_offset_ns'] = '11'
            path.write_text(json.dumps(session))
            with self.assertRaises(ValueError):
                rrproto.session_info(folder)

    def test_no_inputs_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(ValueError):
                rrproto.read_segments(Path(temp))
