#!/usr/bin/env python3
"""Offline research prototype: estimate sleep stages from PolarPAP RR files.

This intentionally does not access or modify a BreathPAPGuardian archive. It
writes an explicitly requested JSON output and requires the optional SleepECG
runtime. Predictions are experimental and have not been validated on the user.
"""
import argparse
import csv
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
from zoneinfo import ZoneInfo

EPOCH_NS = 30_000_000_000
PREPROCESSING = 'bpg-rr-segments-v2'


def read_segments(folder, bounds=None, diagnostics=None):
    """Split at rejected beats, gaps, changed connections, or bad RR timing."""
    if bounds is not None and bounds[1] <= bounds[0]:
        raise ValueError('Invalid RR session interval')
    stats = diagnostics if diagnostics is not None else {}
    stats.update(rows=0, outside_session=0, accepted=0, rejected=0,
                 invalid_rr=0, screen_rejected=0, contact_lost=0,
                 nonmonotonic=0, connection_breaks=0, timing_breaks=0)
    stats['screen_reasons'] = {}
    segments, current = [], []
    previous_ns = previous_connection = last_seen_ns = None
    hashes = {}
    for path in sorted(folder.glob('*_rr.csv')):
        hashes[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
        with path.open(newline='', encoding='utf-8-sig') as src:
            reader = csv.DictReader(src)
            required = {'timestamp_unix_ns', 'rr_ms', 'sensor_contact', 'screen_accepted', 'connection_segment'}
            if not reader.fieldnames or not required.issubset(reader.fieldnames):
                raise ValueError('Missing RR CSV columns: ' + path.name)
            for row in reader:
                try:
                    timestamp = int(row['timestamp_unix_ns'])
                except (ValueError, TypeError):
                    timestamp = None
                try:
                    rr = float(row['rr_ms']) / 1000
                except (ValueError, TypeError):
                    rr = math.nan
                stats['rows'] += 1
                # An export can contain a final notification after recording stop.
                # Exclude it before it can affect ordering or segmentation.
                if bounds is not None and timestamp is not None and not bounds[0] <= timestamp <= bounds[1]:
                    stats['outside_session'] += 1
                    continue
                invalid = timestamp is None or not math.isfinite(rr) or not .3 <= rr <= 2
                stats['invalid_rr'] += int(invalid)
                stats['screen_rejected'] += int((row['screen_accepted'] or '').lower() != 'true')
                if (row['screen_accepted'] or '').lower() != 'true':
                    reason = row.get('screen_reason') or 'unspecified'
                    stats['screen_reasons'][reason] = stats['screen_reasons'].get(reason, 0) + 1
                stats['contact_lost'] += int((row['sensor_contact'] or '').lower() == 'false')
                accepted = (timestamp is not None and math.isfinite(rr) and .3 <= rr <= 2 and
                            (row['screen_accepted'] or '').lower() == 'true' and
                            (row['sensor_contact'] or '').lower() != 'false')
                connection = row['connection_segment']
                if timestamp is not None:
                    if last_seen_ns is not None and timestamp <= last_seen_ns:
                        accepted = False
                        stats['nonmonotonic'] += 1
                    last_seen_ns = max(last_seen_ns, timestamp) if last_seen_ns is not None else timestamp
                if current:
                    delta = (timestamp - previous_ns) / 1e9 if timestamp is not None else -1
                    continuous = (accepted and connection == previous_connection and .3 <= delta <= 2 and
                                  abs(delta-rr) <= max(.25, rr*.25))
                    if accepted and connection != previous_connection:
                        stats['connection_breaks'] += 1
                    elif accepted and not continuous:
                        stats['timing_breaks'] += 1
                    if not continuous:
                        if len(current) >= 2:
                            segments.append(current)
                        current = []
                stats['accepted' if accepted else 'rejected'] += 1
                if accepted:
                    current.append(timestamp)
                    previous_ns, previous_connection = timestamp, connection
                else:
                    previous_ns = previous_connection = None
    if len(current) >= 2:
        segments.append(current)
    if not hashes:
        raise ValueError('No Polar RR files found')
    return segments, hashes


def coverage_diagnostics(folder):
    """Signal/context availability only; no model or sleep-stage inference."""
    start, end, session_hash, _ = session_info(folder)
    stats = {}
    segments, hashes = read_segments(folder, (start, end), stats)
    hashes['session.json'] = session_hash
    # Match the inference's segment-length and full-context gates exactly.
    candidates = 0
    short = 0
    for segment in segments:
        origin = segment[0] // EPOCH_NS * EPOCH_NS
        if segment[-1] - origin < 300_000_000_000:
            short += 1
            continue
        first = -(-(segment[0] + 120_000_000_000) // EPOCH_NS)
        last = (segment[-1] - 150_000_000_000) // EPOCH_NS
        candidates += max(0, last - first + 1)
    total = max(0, end // EPOCH_NS - (-(-start // EPOCH_NS)))
    return {'preprocessing': PREPROCESSING, 'samples': stats,
            'segments': len(segments), 'segments_skipped_by_length': short,
            'segments_at_least_300s': sum(s[-1] - s[0] >= 300_000_000_000 for s in segments),
            'complete_session_epochs': total,
            'epochs_with_rr_context': candidates,
            'rr_context_minutes': candidates / 2,
            'sources_sha256': hashes,
            'limitation': 'Context availability before timezone and finite-feature checks; no stage inference or accuracy assessment. Rejection counters may overlap.'}


def session_info(folder):
    path = folder / 'session.json'
    raw = path.read_bytes()
    session = json.loads(raw)
    if session.get('schema_version') != 1:
        raise ValueError('Unsupported Polar session schema')
    start, end = int(session['start_unix_ns']), int(session['end_unix_ns'])
    if end <= start:
        raise ValueError('Invalid Polar session interval')
    shifted = session.get('time_shift_applied') is True
    if shifted:
        source = int(session['time_shift_source_start_unix_ns'])
        target = int(session['time_shift_target_start_unix_ns'])
        offset = int(session['time_shift_offset_ns'])
        if source + offset != target or start != target:
            raise ValueError('Inconsistent Polar shift metadata')
    return start, end, hashlib.sha256(raw).hexdigest(), shifted


def predict(folder, zone_name):
    os.environ.setdefault('KERAS_BACKEND', 'torch')
    import numpy as np
    import sleepecg
    zone = ZoneInfo(zone_name)
    start, end, session_hash, shifted = session_info(folder)
    segments, hashes = read_segments(folder, (start, end))
    if any(segment[0] < start or segment[-1] > end for segment in segments):
        raise ValueError('RR times fall outside the declared session interval')
    hashes['session.json'] = session_hash
    if sleepecg.__version__ != '0.6.0':
        raise ValueError('Sleep staging requires SleepECG 0.6.0')
    classifier = sleepecg.load_classifier('wrn-gru-mesa', 'SleepECG')
    model_hash = hashlib.sha256(classifier.source_file.read_bytes()).hexdigest()
    if model_hash != '5622a858c855b0090e1fbcbdc35334ea459707c830eae1a26a4375e33091e869':
        raise ValueError('Unexpected SleepECG model weights')
    if classifier.stages_mode != 'wake-rem-nrem':
        raise ValueError('Unexpected classifier stage mapping')
    results = []
    labels = ('UNDEFINED', 'NREM', 'REM', 'WAKE')
    for segment in segments:
        origin = segment[0] // EPOCH_NS * EPOCH_NS
        relative = np.asarray([(n-origin)/1e9 for n in segment], dtype=float)
        if relative[-1] < 300:
            continue
        local = dt.datetime.fromtimestamp(origin / 1e9, dt.timezone.utc).astimezone(zone)
        # A wall-clock reversal within a segment crosses a clock change and must
        # not silently project onto the PAP timeline.
        end_local = dt.datetime.fromtimestamp(segment[-1] / 1e9, dt.timezone.utc).astimezone(zone)
        if local.utcoffset() != end_local.utcoffset():
            continue
        record = sleepecg.SleepRecord(sleep_stage_duration=30, recording_start_time=local.time(), heartbeat_times=relative)
        features, _, names = sleepecg.extract_features([record], **classifier.feature_extraction_params)
        required = ('meanNN', 'SDNN', 'RMSSD', 'LF_norm', 'HF_norm', 'LF_HF_ratio')
        columns = [names.index(name) for name in required]
        probabilities = sleepecg.stage(classifier, record, return_mode='prob')
        if probabilities.ndim != 2 or probabilities.shape[1] != len(labels):
            raise ValueError('Unexpected model output shape')
        for index, row in enumerate(probabilities):
            start = origin + index * EPOCH_NS
            # Require the entire feature window to fall inside one clean segment.
            if start - 120_000_000_000 < segment[0] or start + 150_000_000_000 > segment[-1]:
                continue
            if not np.isfinite(row).all() or not np.isfinite(features[0][index, columns]).all():
                continue
            choice = int(np.argmax(row))
            wall = dt.datetime.fromtimestamp(start/1e9, dt.timezone.utc).astimezone(zone)
            results.append({'start_utc_ns': str(start), 'start_pap_wall': wall.replace(tzinfo=None).isoformat(),
                            'duration_seconds': 30, 'class': labels[choice],
                            'probabilities': {name: float(value) for name, value in zip(labels, row)}})
    return {'experimental': True, 'method': 'sleepecg-wrn-gru-mesa', 'sleepecg_version': sleepecg.__version__, 'model_sha256': model_hash, 'preprocessing': PREPROCESSING,
            'timezone': zone_name, 'shift_already_applied': shifted, 'sources_sha256': hashes, 'epochs': results,
            'limitation': 'Only epochs with full clean feature windows are included; omitted times are not estimable. No individual reference validation.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    parser.add_argument('--zone', help='PAP timezone; required for inference')
    parser.add_argument('--diagnostics-only', action='store_true', help='Measure RR/context availability without loading SleepECG')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit('Refusing to overwrite existing output')
    if not args.diagnostics_only and not args.zone:
        parser.error('--zone is required for inference')
    data = coverage_diagnostics(args.folder) if args.diagnostics_only else predict(args.folder, args.zone)
    with args.output.open('x', encoding='utf-8') as out:
        json.dump(data, out, indent=2, allow_nan=False)


if __name__ == '__main__':
    main()
