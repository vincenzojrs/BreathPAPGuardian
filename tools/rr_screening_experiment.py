#!/usr/bin/env python3
"""Offline comparison of strict RR segmentation and bounded isolated masking.

Never reads or writes an archive. Experimental output is deliberately incompatible
with sleep_staging.compute. No clinical accuracy claim or production integration.
"""
import argparse
from collections import Counter
import csv
import datetime as dt
import hashlib
from importlib.metadata import version
import json
import math
import os
from pathlib import Path
import warnings
from zoneinfo import ZoneInfo

try:
    from . import polar_rr_prototype as strict
except ImportError:
    import polar_rr_prototype as strict

METHOD = 'bpg-rr-isolated-mask-experiment-v1'
MODEL_HASH = '5622a858c855b0090e1fbcbdc35334ea459707c830eae1a26a4375e33091e869'
LABELS = ('UNDEFINED', 'NREM', 'REM', 'WAKE')
KEY_FEATURES = ('meanNN', 'SDNN', 'RMSSD', 'LF_norm', 'HF_norm', 'LF_HF_ratio')


def read_rows(folder):
    start, end, session_hash, _ = strict.session_info(folder)
    rows, hashes = [], {'session.json': session_hash}
    last = None
    for path in sorted(folder.glob('*_rr.csv')):
        hashes[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
        with path.open(newline='', encoding='utf-8-sig') as src:
            reader = csv.DictReader(src)
            required = {'timestamp_unix_ns', 'rr_ms', 'sensor_contact', 'screen_accepted', 'connection_segment'}
            if not reader.fieldnames or not required.issubset(reader.fieldnames):
                raise ValueError('Missing RR columns: ' + path.name)
            for row in reader:
                try:
                    t = int(row['timestamp_unix_ns'])
                except (ValueError, TypeError):
                    t = None
                if t is not None and not start <= t <= end:
                    continue
                try:
                    rr = float(row['rr_ms']) / 1000
                except (ValueError, TypeError):
                    rr = math.nan
                monotonic = t is not None and (last is None or t > last)
                if t is not None:
                    last = max(t, last) if last is not None else t
                valid = monotonic and math.isfinite(rr) and .3 <= rr <= 2
                rows.append({'t': t, 'rr': rr, 'valid': valid,
                             'contact': (row['sensor_contact'] or '').lower(),
                             'accepted': (row['screen_accepted'] or '').lower() == 'true',
                             'reason': row.get('screen_reason') or '',
                             'connection': row['connection_segment']})
    if len(hashes) == 1:
        raise ValueError('No Polar RR files found')
    return rows, hashes


def connected(a, b):
    """Cumulative RR timing within 2 ms; never infer across a missing row."""
    if not (a['valid'] and b['valid'] and a['connection'] and a['connection'] == b['connection']):
        return False
    delta = (b['t'] - a['t']) / 1e9
    return .3 <= delta <= 2 and abs(delta - b['rr']) <= .002


def isolated_segments(rows):
    """Retain singleton median rejections only with two clean beats each side.

    A rejection denotes a suspect interval and possibly a displaced beat boundary,
    so mask that interval and its successor. Never change/add/remove timestamps.
    Reject pairs requiring >4 s between spectral interpolation anchors.
    """
    def clean(r):
        return r['valid'] and r['accepted'] and r['contact'] != 'false'

    soft = set()
    for i in range(2, len(rows)-2):
        r = rows[i]
        if not (r['valid'] and not r['accepted'] and r['contact'] == 'true'
                and r['reason'] == 'over_20pct_recent_median'):
            continue
        if not all(clean(rows[j]) for j in (i-2, i-1, i+1, i+2)):
            continue
        if not all(connected(rows[j], rows[j+1]) for j in range(i-2, i+2)):
            continue
        if rows[i+2]['t'] - rows[i-1]['t'] > 4_000_000_000:
            continue
        soft.add(i)
    # Consecutive masked pairs must retain a clean interpolation anchor between
    # them. Check the union, so nearby candidates cannot extend a masked run.
    masks = {j for i in soft for j in (i, i+1)}
    crowded = {i for i in soft if i-1 in masks or i+2 in masks}
    soft -= crowded
    masks = {j for i in soft for j in (i, i+1)}
    segments, current = [], []
    for i, row in enumerate(rows):
        usable = clean(row) or i in soft
        if current and (not usable or not connected(rows[current[-1]], row)):
            if len(current) >= 2:
                segments.append(current)
            current = []
        if usable:
            current.append(i)
    if len(current) >= 2:
        segments.append(current)
    return [{'times': [rows[i]['t'] for i in s],
             'masked': [i in masks for i in s]} for s in segments], len(soft)


def extract_masked_features(sleepecg, classifier, record, masked):
    """Pinned SleepECG internals; identical features on an unmasked recording.

    Time features use NaN to omit suspect intervals and their successive pairs.
    Only the frequency branch receives linear interpolation, at unchanged times.
    """
    import numpy as np
    from sleepecg import feature_extraction as fe
    features, _, names = sleepecg.extract_features([record], **classifier.feature_extraction_params)
    X = features[0]
    params = classifier.feature_extraction_params
    if (sleepecg.__version__ != '0.6.0' or params['lookback'] != 120 or params['lookforward'] != 150
            or params['feature_selection'] != ['hrv-time', 'hrv-frequency', 'recording_start_time', 'age', 'gender']):
        raise ValueError('Unsupported SleepECG feature contract')
    rr = np.diff(record.heartbeat_times)
    times = record.heartbeat_times[1:]
    mask = np.asarray(masked[1:], dtype=bool)
    stages = np.arange(len(X)) * 30
    if mask.any():
        masked_rr = rr.copy()
        masked_rr[mask] = np.nan
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', RuntimeWarning)
            temporal = fe._hrv_timedomain_features(masked_rr, times, stages, 120, 150)
        spectral_rr = rr.copy()
        # Brackets and run lengths were checked by isolated_segments. No edge
        # extrapolation: a missing anchor indicates a broken experiment contract.
        if mask[0] or mask[-1]:
            raise ValueError('Unbracketed interpolation')
        spectral_rr[mask] = np.interp(times[mask], times[~mask], rr[~mask])
        spectral = fe._hrv_frequencydomain_features(spectral_rr, times, stages, 120, 150, 4, 0)
        for group, values in [('hrv-time', temporal), ('hrv-frequency', spectral)]:
            for col, name in enumerate(fe._FEATURE_GROUPS[group]):
                X[:, names.index(name)] = values[:, col]
    return X, names, rr, times, mask


def eligible_epochs(times_ns, rr, rr_times, mask, epoch_count, fraction):
    """Both count and elapsed-duration budgets; a central epoch needs real RR."""
    import numpy as np
    origin = times_ns[0] // strict.EPOCH_NS * strict.EPOCH_NS
    gates = []
    for i in range(epoch_count):
        t = origin + i * strict.EPOCH_NS
        relative = i * 30
        window = (rr_times >= relative-120) & (rr_times < relative+150)
        suspect = window & mask
        reason = ''
        if t-120_000_000_000 < times_ns[0] or t+150_000_000_000 > times_ns[-1]:
            reason = 'insufficient_context'
        elif np.any(mask & (rr_times >= relative) & (rr_times < relative+30)):
            reason = 'suspect_interval_in_epoch'
        elif (not window.any() or suspect.sum()/window.sum() > fraction
              or rr[suspect].sum()/270 > fraction):
            reason = 'context_quality_budget'
        gates.append(reason)
    return gates


def infer_segments(sleepecg, classifier, segments, zone_name, fraction=None):
    import numpy as np
    zone = ZoneInfo(zone_name)
    epochs, reasons, retained_features, excluded_epochs = [], Counter(), {}, []
    for s in segments:
        times = s['times']
        origin = times[0] // strict.EPOCH_NS * strict.EPOCH_NS
        relative = np.asarray([(n-origin)/1e9 for n in times])
        if relative[-1] < 300:
            reasons['short_segments'] += 1
            continue
        local = dt.datetime.fromtimestamp(origin/1e9, dt.timezone.utc).astimezone(zone)
        last = dt.datetime.fromtimestamp(times[-1]/1e9, dt.timezone.utc).astimezone(zone)
        if local.utcoffset() != last.utcoffset():
            reasons['clock_change_segments'] += 1
            continue
        record = sleepecg.SleepRecord(sleep_stage_duration=30, recording_start_time=local.time(), heartbeat_times=relative)
        if fraction is None:
            features, _, names = sleepecg.extract_features([record], **classifier.feature_extraction_params)
            X = features[0]
            rr, rt, mask = np.diff(relative), relative[1:], np.zeros(len(relative)-1, dtype=bool)
        else:
            X, names, rr, rt, mask = extract_masked_features(sleepecg, classifier, record, s['masked'])
        gates = eligible_epochs(times, rr, rt, mask, len(X), fraction or 0)
        columns = [names.index(n) for n in KEY_FEATURES]
        for i, row in enumerate(X):
            if not gates[i] and not np.isfinite(row[columns]).all():
                gates[i] = 'nonfinite_features'
        model_input = X.copy()
        model_input[~np.isfinite(model_input)] = classifier.mask_value
        # Candidate ineligible rows overlapping suspect intervals are wholly masked to avoid feeding their
        # suspect HRV into the recurrent model. The strict baseline uses the
        # exact original inputs, including edge windows, for comparability.
        if fraction is not None:
            for i, reason in enumerate(gates):
                if reason and (mask & (rt >= i*30-120) & (rt < i*30+150)).any():
                    model_input[i] = classifier.mask_value
        probabilities = classifier.model.predict(model_input[np.newaxis, ...], verbose=0)[0]
        if probabilities.shape != (len(X), 4) or not np.isfinite(probabilities).all():
            raise ValueError('Invalid classifier probabilities')
        for i, row in enumerate(probabilities):
            if gates[i]:
                reasons[gates[i]] += 1
                excluded_epochs.append({'start_utc_ns': str(origin+i*strict.EPOCH_NS), 'reason':gates[i]})
                continue
            t = origin + i * strict.EPOCH_NS
            choice = int(row.argmax())
            epochs.append({'start_utc_ns': str(t), 'stage': LABELS[choice],
                           'probabilities': {n:float(v) for n,v in zip(LABELS,row)}})
            retained_features[t] = {n:float(X[i,names.index(n)]) for n in KEY_FEATURES}
    return {'epochs': epochs, 'exclusions': dict(reasons), 'excluded_epochs': excluded_epochs}, retained_features


def summarize(result, total):
    counts = Counter(e['stage'] for e in result['epochs'])
    classified = sum(counts[n] for n in LABELS if n != 'UNDEFINED')
    return {'classified_minutes': classified/2, 'coverage': classified/total if total else 0,
            'stage_minutes': {n:counts[n]/2 for n in LABELS}, 'unestimable_minutes':(total-classified)/2,
            'exclusions': result['exclusions']}


def compare(baseline, candidate, bf, cf):
    import numpy as np
    b = {int(e['start_utc_ns']):e for e in baseline['epochs']}
    c = {int(e['start_utc_ns']):e for e in candidate['epochs']}
    common = sorted(b.keys() & c.keys())
    flips = sum(b[t]['stage'] != c[t]['stage'] for t in common)
    changes = {n: {'median_absolute_change': float(np.median([abs(cf[t][n]-bf[t][n]) for t in common])) if common else None,
                   'max_absolute_change': max((abs(cf[t][n]-bf[t][n]) for t in common), default=None)} for n in KEY_FEATURES}
    return {'common_epochs': len(common), 'changed_stages': flips,
            'new_context_epochs': len(c.keys()-b.keys()), 'lost_context_epochs': len(b.keys()-c.keys()),
            'feature_changes_on_common_epochs': changes,
            'interpretation': 'Agreement and coverage are not accuracy; recurrent context differs between methods.'}


def run(folder, zone_name):
    os.environ.setdefault('KERAS_BACKEND', 'torch')
    import sleepecg
    classifier = sleepecg.load_classifier('wrn-gru-mesa', 'SleepECG')
    model_hash = hashlib.sha256(classifier.source_file.read_bytes()).hexdigest()
    if sleepecg.__version__ != '0.6.0' or model_hash != MODEL_HASH or classifier.stages_mode != 'wake-rem-nrem':
        raise ValueError('Unexpected SleepECG runtime/model')
    rows, hashes = read_rows(folder)
    candidate_segments, soft = isolated_segments(rows)
    start, end, _, _ = strict.session_info(folder)
    strict_segments, _ = strict.read_segments(folder, (start, end))
    baseline, bf = infer_segments(sleepecg, classifier, [{'times':s} for s in strict_segments], zone_name)
    total = strict.coverage_diagnostics(folder)['complete_session_epochs']
    results = {}
    for fraction in (.005, .01, .02):
        result, cf = infer_segments(sleepecg, classifier, candidate_segments, zone_name, fraction)
        results[str(fraction)] = {'summary': summarize(result,total), 'comparison':compare(baseline,result,bf,cf), **result}
    return {'experiment': METHOD, 'experimental': True, 'production_compatible': False,
            'model_sha256': model_hash, 'timezone': zone_name, 'sources_sha256': hashes,
            'runtime_versions': {n:version(n) for n in ('sleepecg','numpy','scipy','keras','torch')},
            'experiment_source_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'complete_session_epochs': total, 'singleton_rejections_retained_as_missing': soft,
            'strict_summary': summarize(baseline,total), 'strict': baseline, 'candidates':results,
            'limitations': ['Engineering thresholds, not validated quality criteria.',
                'No individual reference sleep labels; accuracy cannot be measured.',
                'Only singleton median rejections; hard gaps, contact loss and connections remain barriers.',
                'No timestamps changed. Two suspect NN intervals omitted from time features; bounded linear interpolation for frequency only.',
                'Epochs containing suspect NN intervals are not classified. Recurrent context can still change other epochs.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    parser.add_argument('--zone', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit('Refusing to overwrite existing output')
    result = run(args.folder,args.zone)
    with args.output.open('x') as out:
        json.dump(result,out,indent=2,allow_nan=False)


if __name__ == '__main__':
    main()
