"""Optional local sleep estimation and durable results for portable archives."""
import datetime as dt
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

METHOD = 'sleepecg-wrn-gru-mesa-0.6.0-bpg-rr-segments-v2'
MODEL_HASH = '5622a858c855b0090e1fbcbdc35334ea459707c830eae1a26a4375e33091e869'


def signature(record):
    blobs = record.get('blobs', {})
    if not isinstance(blobs, dict):
        raise ValueError('Invalid Polar recording')
    source = {k: record.get(k) for k in ('id', 'night', 'zone', 'start', 'end', 'shift', 'session')}
    source['rr'] = {k: blobs[k] for k in sorted(blobs) if re.fullmatch(r'\d{3}_rr\.csv', k)}
    source['method'] = METHOD
    return hashlib.sha256(json.dumps(source, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def status_for(records, analyses):
    by_night = {}
    for rec in records:
        if rec.get('polar') and isinstance(rec.get('night'), str):
            by_night.setdefault(rec['night'], []).append(rec)
    saved = {r['id'][6:]: r for r in analyses if isinstance(r.get('id'), str) and r['id'].startswith('sleep:')}
    result = {}
    for night in set(by_night) | set(saved):
        rows = by_night.get(night, [])
        if not rows:
            result[night] = {'status': 'polar_absent'}
        elif len(rows) != 1:
            result[night] = {'status': 'multiple_recordings'}
        elif night not in saved:
            result[night] = {'status': 'needs_compute'}
        else:
            item = saved[night]
            current = item.get('input_signature') == signature(rows[0]) and item.get('method') == METHOD
            result[night] = {'status': ('available' if item.get('summary', {}).get('classified', 0) else 'not_estimable') if current else 'stale',
                             'summary': item.get('summary') if current else None,
                             'result': item if current else None}
    return result


def materialize(store, rec, folder):
    (folder / 'session.json').write_text(json.dumps(rec['session'], ensure_ascii=False), encoding='utf-8')
    names = [name for name in rec['blobs'] if re.fullmatch(r'\d{3}_rr\.csv', name)]
    if not names:
        raise ValueError('No Polar RR files are available.')
    for name in sorted(names):
        value = rec['blobs'][name]
        if not isinstance(value, dict):
            raise ValueError('Invalid RR attachment.')
        chunks = value.get('__blobChunks') if '__blobChunks' in value else [value]
        if not isinstance(chunks, list) or not chunks:
            raise ValueError('Invalid RR attachment.')
        with (folder / name).open('xb') as out:
            for chunk in chunks:
                if not isinstance(chunk, dict) or not isinstance(chunk.get('__ref'), str):
                    raise ValueError('Invalid RR attachment.')
                with store.get_blob(chunk['__ref']).open('rb') as source:
                    while data := source.read(1024*1024):
                        out.write(data)


def normalize(rec, raw, sig):
    night = rec['night']
    date = dt.date.fromisoformat(night)
    noon = dt.datetime.combine(date, dt.time(12), tzinfo=dt.timezone.utc).timestamp() * 1000
    begin, end = max(noon, float(rec['start'])), min(noon + 86400000, float(rec['end']))
    first = math.ceil(begin / 30000) * 30000
    if end <= first:
        raise ValueError('Polar recording does not overlap this PAP night.')
    epochs = [{'start': t, 'end': t+30000, 'stage': 'UNDEFINED', 'reason': 'Insufficient usable RR context'}
              for t in range(int(first), int(end)-29999, 30000)]
    positions = {e['start']: e for e in epochs}
    for item in raw['epochs']:
        wall = dt.datetime.fromisoformat(item['start_pap_wall'])
        if wall.tzinfo is not None:
            raise ValueError('Unexpected sleep time zone encoding.')
        t = round(wall.replace(tzinfo=dt.timezone.utc).timestamp()*1000)
        if t not in positions:
            continue
        stage = item['class']
        probabilities = item['probabilities']
        if stage not in ('WAKE', 'REM', 'NREM', 'UNDEFINED') or not isinstance(probabilities, dict) or set(probabilities) != {'WAKE', 'REM', 'NREM', 'UNDEFINED'}:
            raise ValueError('Invalid sleep model result.')
        if any(not isinstance(x, (int, float)) or not math.isfinite(x) or x < 0 or x > 1 for x in probabilities.values()):
            raise ValueError('Invalid sleep model probabilities.')
        if abs(sum(probabilities.values())-1) > .001 or probabilities[stage] < max(probabilities.values()):
            raise ValueError('Inconsistent sleep model probabilities.')
        positions[t].update(stage=stage, probabilities=probabilities,
                            reason='Model abstained' if stage == 'UNDEFINED' else '')
    counts = {name: sum(e['stage'] == name for e in epochs) for name in ('WAKE', 'REM', 'NREM', 'UNDEFINED')}
    classified = sum(counts[k] for k in ('WAKE', 'REM', 'NREM'))
    return {'id': 'sleep:'+night, 'night': night, 'method': METHOD, 'input_signature': sig,
            'model_sha256': MODEL_HASH, 'experimental': True, 'epochs': epochs,
            'summary': {'WAKE': counts['WAKE']/2, 'REM': counts['REM']/2, 'NREM': counts['NREM']/2,
                        'unestimable': counts['UNDEFINED']/2, 'classified': classified/2,
                        'coverage': classified/len(epochs) if epochs else 0},
            'warning': 'Estimated from RR, not individually validated; missing epochs are not estimable.'}


def compute(store, night, token):
    if not isinstance(night, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', night):
        raise ValueError('Invalid PAP night.')
    with store.lock:
        store.require_writer(token)
        if store.operation or store.preview or store.pending.exists():
            raise ValueError('Finish the current operation before sleep analysis.')
        records = [r for r in store.records('external') if r.get('polar') and r.get('night') == night]
        if len(records) != 1:
            raise ValueError('Sleep estimation requires exactly one Polar recording for the night.')
        rec = records[0]
        sig = signature(rec)
        existing = status_for(records, store.records('analysis')).get(night)
        if existing and existing['status'] in ('available', 'not_estimable'):
            return existing['result']
        if night in store.sleep_jobs:
            raise ValueError('Sleep analysis is already running for this night.')
        store.sleep_jobs.add(night)
    try:
        with tempfile.TemporaryDirectory(prefix='sleep-', dir=store.local) as tmp:
            folder = Path(tmp)
            materialize(store, rec, folder)
            output = folder / 'result.json'
            root = Path(__file__).resolve().parent
            bundled = root / '.venv-sleep' / 'bin' / 'python'
            python = os.environ.get('BPG_SLEEP_PYTHON') or (str(bundled) if bundled.is_file() else sys.executable)
            script = root / 'tools' / 'polar_rr_prototype.py'
            env = dict(os.environ, KERAS_BACKEND='torch')
            try:
                completed = subprocess.run([python, str(script), str(folder), '--zone', rec['zone'], '--output', str(output)],
                                           env=env, capture_output=True, timeout=600, check=False)
            except (OSError, subprocess.TimeoutExpired) as exc:
                raise ValueError('Sleep model runtime unavailable or timed out.') from exc
            if completed.returncode != 0 or not output.is_file():
                raise ValueError('Sleep analysis failed. Install the optional SleepECG runtime or check the Polar RR data.')
            raw = json.loads(output.read_text(encoding='utf-8'))
            if (raw.get('model_sha256') != MODEL_HASH or raw.get('sleepecg_version') != '0.6.0'
                    or raw.get('preprocessing') != 'bpg-rr-segments-v2' or raw.get('timezone') != rec['zone']
                    or raw.get('shift_already_applied') != (rec['session'].get('time_shift_applied') is True)):
                raise ValueError('Unexpected sleep model version or weights.')
            result = normalize(rec, raw, sig)
        with store.lock:
            store.require_writer(token)
            current = [r for r in store.records('external') if r.get('polar') and r.get('night') == night]
            if len(current) != 1 or signature(current[0]) != sig:
                raise ValueError('Polar data changed during analysis; result was not saved.')
            store.batch({'put': [['analysis', result]]}, token)
        return result
    finally:
        with store.lock:
            store.sleep_jobs.discard(night)
