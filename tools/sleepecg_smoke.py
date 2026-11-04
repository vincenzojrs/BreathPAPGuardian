#!/usr/bin/env python3
"""Exercise the optional SleepECG classifier on generated, non-clinical beats."""
import os
import time

os.environ.setdefault('KERAS_BACKEND', 'torch')
import numpy as np
import sleepecg

rng = np.random.default_rng(42)
beats = np.cumsum(rng.uniform(.75, 1.0, 8 * 3600))
record = sleepecg.SleepRecord(sleep_stage_duration=30, heartbeat_times=beats)
classifier = sleepecg.load_classifier('wrn-gru-mesa', 'SleepECG')
start = time.perf_counter()
probabilities = sleepecg.stage(classifier, record, return_mode='prob')
assert probabilities.ndim == 2 and probabilities.shape[1] == 4
assert np.isfinite(probabilities).all()
print('SleepECG', sleepecg.__version__, 'mode', classifier.stages_mode,
      'epochs', len(probabilities), 'seconds', round(time.perf_counter()-start, 3))
