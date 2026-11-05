import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import sleep_staging
from portable_store import PortableStore


class SleepTests(unittest.TestCase):
    def test_persistence_cache_invalidation_and_gaps(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a = PortableStore(root/'a', root/'shared')
            self.addCleanup(a.close)
            start = int(dt.datetime(2026, 1, 1, 23, 50, tzinfo=dt.timezone.utc).timestamp()*1000)
            ref = a.save_blob(b'timestamp_unix_ns,rr_ms\n')
            rec = {'id': 'polar:test', 'night': '2026-01-01', 'polar': True, 'zone': 'UTC',
                   'start': start, 'end': start+20*60000, 'session': {'schema_version': 1},
                   'blobs': {'000_rr.csv': {'__ref': ref}}}
            a.batch({'put': [['external', rec], ['analysis', {'id': '2026-01-01', 'method': 'gi'}]]})
            self.assertEqual(sleep_staging.status_for([rec], a.records('analysis'))['2026-01-01']['status'], 'needs_compute')
            def fake_run(args, **kwargs):
                wall = dt.datetime.fromtimestamp((start+600000)/1000, dt.timezone.utc).replace(tzinfo=None).isoformat()
                data = {'model_sha256': sleep_staging.MODEL_HASH, 'sleepecg_version':'0.6.0',
                        'preprocessing':'bpg-rr-segments-v2','timezone':'UTC','shift_already_applied':False,
                        'epochs':[{'start_pap_wall':wall,'class':'REM','probabilities':{'UNDEFINED':0.0,'NREM':0.2,'REM':0.7,'WAKE':0.1}}]}
                Path(args[args.index('--output')+1]).write_text(json.dumps(data))
                return type('Result', (), {'returncode': 0})()
            with patch('sleep_staging.subprocess.run', side_effect=fake_run) as run:
                result = sleep_staging.compute(a, '2026-01-01', None)
                self.assertEqual(result['summary']['REM'], .5)
                self.assertEqual(result['summary']['unestimable'], 19.5)
                self.assertEqual(result['summary']['coverage'], 1/40)
                self.assertEqual(sleep_staging.compute(a, '2026-01-01', None), result)
                self.assertEqual(run.call_count, 1)
            self.assertEqual({r['id'] for r in a.records('analysis')}, {'2026-01-01', 'sleep:2026-01-01'})
            a.publish()
            b = PortableStore(root/'b', root/'shared')
            self.addCleanup(b.close)
            b.open_shared()
            status = sleep_staging.status_for(b.records('external'), b.records('analysis'))['2026-01-01']
            self.assertEqual(status['status'], 'available')
            self.assertEqual(status['result'], result)
            changed = dict(rec, zone='Europe/Rome')
            self.assertEqual(sleep_staging.status_for([changed], b.records('analysis'))['2026-01-01']['status'], 'stale')
            self.assertEqual(sleep_staging.status_for([], b.records('analysis'))['2026-01-01']['status'], 'polar_absent')

    def test_changed_source_is_not_saved_and_retry_is_possible(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a = PortableStore(root/'a', root/'shared')
            self.addCleanup(a.close)
            start = int(dt.datetime(2026, 1, 1, 23, 50, tzinfo=dt.timezone.utc).timestamp()*1000)
            ref = a.save_blob(b'timestamp_unix_ns,rr_ms\n')
            rec = {'id':'polar:test','night':'2026-01-01','polar':True,'zone':'UTC','start':start,'end':start+600000,
                   'session':{'schema_version':1},'blobs':{'000_rr.csv':{'__ref':ref}}}
            a.batch({'put':[['external',rec]]})
            def alter(args, **kwargs):
                changed = dict(rec, zone='Europe/Rome')
                a.batch({'put':[['external',changed]]})
                output = {'model_sha256': sleep_staging.MODEL_HASH, 'sleepecg_version':'0.6.0',
                          'preprocessing':'bpg-rr-segments-v2','timezone':'UTC','shift_already_applied':False,'epochs':[]}
                Path(args[args.index('--output')+1]).write_text(json.dumps(output))
                return type('Result', (), {'returncode': 0})()
            with patch('sleep_staging.subprocess.run', side_effect=alter):
                with self.assertRaisesRegex(ValueError, 'changed during analysis'):
                    sleep_staging.compute(a, '2026-01-01', None)
            self.assertFalse(a.records('analysis'))
            self.assertFalse(a.sleep_jobs)

    def test_previous_preprocessing_result_is_stale(self):
        rec = {'id':'polar:test','night':'2026-01-01','polar':True,'blobs':{}}
        old = {'id':'sleep:2026-01-01', 'method':'sleepecg-wrn-gru-mesa-0.6.0-bpg-rr-segments-v1',
               'input_signature': sleep_staging.signature(rec), 'summary':{'classified': 1}}
        self.assertEqual(sleep_staging.status_for([rec], [old])['2026-01-01']['status'], 'stale')

    def test_rejects_invalid_model_output(self):
        rec = {'night':'2026-01-01','start':1767268800000,'end':1767269400000}
        with self.assertRaises((ValueError, KeyError)):
            sleep_staging.normalize(rec, {'epochs':[{'start_pap_wall':'2026-01-01T12:01:00', 'class':'BAD', 'probabilities':{}}]}, 'x')
