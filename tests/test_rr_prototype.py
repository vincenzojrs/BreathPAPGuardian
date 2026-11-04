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
