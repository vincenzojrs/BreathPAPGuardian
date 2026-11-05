import os
import datetime as dt
import unittest

from tools import rr_screening_experiment as exp


def rows_for(intervals, rejected=()):
    rows, t = [], 0
    for i, rr in enumerate(intervals):
        t += round(rr*1e9)
        rows.append({'t': t, 'rr': rr, 'valid': .3 <= rr <= 2, 'contact':'true',
                     'accepted':i not in rejected, 'reason':'over_20pct_recent_median' if i in rejected else '',
                     'connection':'1'})
    return rows


class IsolatedMaskTests(unittest.TestCase):
    def test_singleton_keeps_exact_times_and_masks_two_intervals(self):
        rows = rows_for([1]*12, [5])
        segments, count = exp.isolated_segments(rows)
        self.assertEqual(count,1)
        self.assertEqual(segments[0]['times'],[r['t'] for r in rows])
        self.assertEqual([i for i,m in enumerate(segments[0]['masked']) if m],[5,6])

    def test_hard_barriers_never_bridged(self):
        for kind in ('contact','connection','gap','reversal','invalid','reason','unknown_contact','pair'):
            with self.subTest(kind=kind):
                rows = rows_for([1]*12,[5])
                if kind == 'contact': rows[5]['contact']='false'
                if kind == 'unknown_contact': rows[5]['contact']=''
                if kind == 'connection': rows[5]['connection']='2'
                if kind == 'gap':
                    for r in rows[5:]: r['t'] += 5_000_000_000
                if kind == 'reversal': rows[5]['valid']=False
                if kind == 'invalid': rows[5]['valid']=False; rows[5]['rr']=3
                if kind == 'reason': rows[5]['reason']='unknown'
                if kind == 'pair': rows[6]['accepted']=False
                segments, count = exp.isolated_segments(rows)
                self.assertEqual(count,0)
                self.assertFalse(any(min(s['times']) < rows[4]['t'] and max(s['times']) > rows[6]['t'] for s in segments))

    def test_no_interpolation_at_edges_or_over_four_seconds(self):
        for intervals, rejected in [([1]*12,[0]),([1]*12,[11]),([1.5]*12,[5])]:
            self.assertEqual(exp.isolated_segments(rows_for(intervals,rejected))[1],0)


@unittest.skipUnless(os.environ.get('BPG_TEST_SLEEP') == '1', 'optional SleepECG runtime')
class FeatureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ.setdefault('KERAS_BACKEND','torch')
        import numpy as np
        import sleepecg
        cls.np, cls.sleepecg = np, sleepecg
        cls.classifier = sleepecg.load_classifier('wrn-gru-mesa','SleepECG')

    def record(self, times):
        return self.sleepecg.SleepRecord(sleep_stage_duration=30, recording_start_time=dt.time(0), heartbeat_times=times)

    def test_clean_features_and_inference_are_identical_to_baseline(self):
        np = self.np
        beats = np.cumsum(1+.03*np.sin(np.arange(900)*.2))
        record = self.record(beats)
        expected, _, names = self.sleepecg.extract_features([record],**self.classifier.feature_extraction_params)
        X, actual_names, *_ = exp.extract_masked_features(self.sleepecg,self.classifier,record,[False]*len(beats))
        self.assertEqual(names,actual_names)
        np.testing.assert_allclose(X,expected[0],equal_nan=True,rtol=0,atol=0)
        ns = [round(t*1e9) for t in beats]
        strict, _ = exp.infer_segments(self.sleepecg,self.classifier,[{'times':ns}],'UTC')
        candidate, _ = exp.infer_segments(self.sleepecg,self.classifier,[{'times':ns,'masked':[False]*len(ns)}],'UTC',.01)
        self.assertEqual(strict['epochs'],candidate['epochs'])
        public = self.sleepecg.stage(self.classifier,self.record(np.asarray([n/1e9 for n in ns])),return_mode='prob')
        for epoch in strict['epochs']:
            index=int(epoch['start_utc_ns'])//30_000_000_000
            np.testing.assert_allclose([epoch['probabilities'][n] for n in exp.LABELS],public[index],rtol=1e-6,atol=1e-7)

    def test_synthetic_displaced_beat_reduces_rmssd_error(self):
        np=self.np
        beats=np.cumsum(1+.03*np.sin(np.arange(900)*.2))
        truth, _, names = self.sleepecg.extract_features([self.record(beats)],**self.classifier.feature_extraction_params)
        corrupted=beats.copy(); corrupted[400]+=.3
        input_before=corrupted.copy()
        raw, _, _ = self.sleepecg.extract_features([self.record(corrupted)],**self.classifier.feature_extraction_params)
        mask=[False]*len(beats); mask[400]=mask[401]=True
        corrected, _, *_ = exp.extract_masked_features(self.sleepecg,self.classifier,self.record(corrupted),mask)
        col=names.index('RMSSD'); window=slice(10,18)
        raw_error=np.abs(raw[0][window,col]-truth[0][window,col]).mean()
        masked_error=np.abs(corrected[window,col]-truth[0][window,col]).mean()
        self.assertLess(masked_error,raw_error*.1)
        np.testing.assert_array_equal(corrupted, input_before)

    def test_quality_gate_requires_clean_epoch_and_both_budgets(self):
        np=self.np
        times=list(range(0,601_000_000_000,1_000_000_000))
        rr=np.ones(600); rt=np.arange(1,601); mask=np.zeros(600,dtype=bool)
        mask[279:281]=True
        gates=exp.eligible_epochs(times,rr,rt,mask,20,.01)
        self.assertEqual(gates[9],'suspect_interval_in_epoch')
        self.assertEqual(gates[10],'')
        self.assertEqual(exp.eligible_epochs(times,rr,rt,mask,20,.005)[10],'context_quality_budget')
        rr[279:281]=1.8
        self.assertEqual(exp.eligible_epochs(times,rr,rt,mask,20,.01)[10],'context_quality_budget')
