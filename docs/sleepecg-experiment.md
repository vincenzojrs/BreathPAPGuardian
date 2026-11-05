# SleepECG feasibility experiment

On 2026-11-04, SleepECG 0.6.0, Keras 3.3.3, torch 2.15.0 and packaging 26.3 were installed in an isolated Python 3.12 environment. `KERAS_BACKEND=torch python tools/sleepecg_smoke.py` loads the bundled `wrn-gru-mesa` classifier and runs a synthetic sequence of generated heartbeat times; one run returned 840 rows with four finite probabilities in approximately 0.41 seconds after model loading. This checks execution only, not prediction accuracy. The installed test environment occupied approximately 928 MB.

The classifier requests time and frequency HRV features plus recording start time, age and gender; it uses a 120-second lookback and 150-second lookforward. Its four output positions include an undefined class, so callers must respect the model's label mapping instead of assuming three columns. The documented implementation and known limits are described by the [SleepECG documentation](https://sleepecg.readthedocs.io/en/stable/classification/). SleepECG 0.5.9 tried to import TensorFlow; version 0.6.0 supported the isolated Keras/torch test.

The portable app previously supported this model on Polar R–R; sleep estimation is disabled in the current release. A synthetic two-client test covers persistence, gaps, backup and restore; individual clinical accuracy has not been established.

`tools/polar_rr_prototype.py` is a separate offline experiment. It accepts one PolarPAP export folder, validates session shift metadata without applying the shift again, separates segments at rejected samples, contact loss, repeated or reversed timestamps, large timing discrepancies, gaps and changed connections, and writes a new JSON file only when explicitly requested. It uses the selected PAP time zone, drops segments crossing an offset change, and emits an epoch only if the entire 120-second lookback and 150-second lookforward fall inside one accepted segment and key HRV features are finite. Missing epochs are not estimable. The thresholds are conservative engineering choices, not validated clinical quality criteria. Age and gender are not supplied. The integration has been exercised on synthetic data. RR segmentation and context availability have also been checked on four real Polar exports; this does not validate sleep-stage accuracy. Existing saved results remain in the archive, while the application hides the sleep summary and timeline.

With the optional environment prepared, an example invocation is `KERAS_BACKEND=torch python tools/polar_rr_prototype.py /path/to/export --zone Europe/Rome --output /safe/new/result.json`. Protect the output as sensitive data. Test on a copy; the command refuses to replace an existing output. Do not interpret the resulting stages as a diagnosis.


## Session boundaries and reproducible coverage diagnostics (2026-11-05)

Preprocessing `bpg-rr-segments-v2` excludes timestamped rows outside the declared
session **before** ordering and segmentation. Inclusive boundary timestamps are
retained. Out-of-session data remains included in source hashes. In-session
rejections, gaps, contact loss, connection changes and clock checks keep their
previous behavior. Saved v1 results become stale and require explicit recompute.

To inspect an extracted Polar export without NumPy, SleepECG or model weights:

```sh
python3 tools/polar_rr_prototype.py /path/to/export --diagnostics-only --output /safe/new/coverage.json
```

The report counts out-of-session rows, accepted/rejected rows, overlapping
rejection causes, exporter screening reasons, connection/timing breaks, segments
and epochs with complete RR context. `segments_skipped_by_length` matches the
inference gate measured from the epoch-aligned origin; `segments_at_least_300s`
measures the actual first-to-last-beat duration. Context epochs are an upper bound:
timezone changes, invalid features or model abstention can reduce classified
coverage further. The diagnostic does not run inference or change any archive.

For the real 2026-11-01 export, this reproduces 30,864 rows, one out-of-session
row, 1,267 rejected in-session rows, 600 segments, 11 actual segments of at least
300 seconds, and 151 epochs with full context (75.5 minutes out of 555). Of the
screen rejections, 1,200 are marked `over_20pct_recent_median`, 63
`outside_300_2000ms`, and four are contact loss. There are also 111 connection
breaks between otherwise accepted rows. Exporter reasons identify the source
screening decision; they do not establish physiological invalidity or justify
accepting rejected beats. No isolated-beat repair or coverage improvement is
implemented in v2.

## Offline isolated-rejection experiment (2026-11-05)

`tools/rr_screening_experiment.py` compares v2 with a **separate**, incompatible
experimental result. It does not update the application's preprocessing or save
analyses in an archive. Use the optional Python 3.12 environment:

```sh
.venv-sleep/bin/python tools/rr_screening_experiment.py /path/to/copied/export \
  --zone Europe/Rome --output /safe/new/experiment.json
BPG_TEST_SLEEP=1 .venv-sleep/bin/python -m unittest discover -s tests -p 'test_rr_screening_experiment.py'
```

A candidate must be a single `over_20pct_recent_median` rejection, in the range
300–2000 ms, with sensor contact, two accepted beats on either side, unchanged
connection, increasing times, and RR/timestamp agreement within 2 ms. Pairs of
rejections, other reasons, observed gaps, clock reversals and connection changes
remain barriers. The interpolation anchors must be at most four seconds apart.
The suspect NN interval **and its successor** are masked, since a displaced beat
can affect both intervals. Original timestamps and total elapsed time stay intact.

Time-domain features omit those NN values using NaNs, which also prevents RMSSD
from pairing intervals across the omission. The frequency-domain branch alone
uses linear interpolation between valid NN values at the original times. The
experiment uses pinned SleepECG 0.6.0 feature functions without modifying the
installed package. A clean-input test compares both features and predictions to
the baseline and to the public `sleepecg.stage` API. A synthetic displaced-beat
test checks RMSSD error against the known uncorrupted signal; this is a numerical
test of one artifact pattern, not physiological or sleep-stage validation.

An epoch with a suspect interval in its own 30 seconds is withheld. Within the
120/150-second context, both the fraction of masked intervals and their duration
must stay below the chosen engineering budget. Sensitivity runs use 0.5%, 1% and
2%; these are not validated clinical thresholds. Ineligible windows containing
suspect intervals are wholly masked before inference. Other edge windows keep the
baseline inputs. The model remains recurrent: changing sequence boundaries or
masking can affect predictions for otherwise clean epochs.

The JSON includes runtime/model/source hashes, strict and candidate results,
class totals, evaluated exclusions with timestamps, and comparisons on common
epochs. `short_segments` and `clock_change_segments` count segments; the other
exclusion counters count evaluated model windows, including edge windows. They
cannot be added to obtain missing full-night minutes. Unexamined periods around
hard barriers or short segments also remain unestimable.

On all four real exports the baseline reproduces the prior context counts. At
1%, classified minutes change as follows: 164.5→183.5 (Oct 30), 75.5→91 (Nov 1),
76.5→88.5 (Nov 2), 79→127 (Nov 3). Respectively 33/329, 28/151, 22/152 and
17/158 common epochs change class. Features on common epochs are unchanged up
to floating-point rounding; recurrent context changes their predictions. One
baseline epoch on Nov 2 is excluded by the stricter finite-feature gate in the
candidate's spectral branch.

**Decision:** keep v2 in the application. The isolated-mask candidate shows a
limited coverage gain and material context sensitivity; it is not ready to replace
the saved production results. Accepting longer runs or relaxing the context gate
would be a new experiment requiring its own evidence. No accuracy of WAKE/REM/NREM
can be inferred without independent reference sleep labels.
