# Glasgow Index

Experimental flow-shape analysis: **not a diagnosis, RDI, RERA detector or the
ResMed flow-limitation signal**. No clinical severity labels are assigned.

## Usage

Import your SD card or restore a backup. In Trends → Glasgow Index select an
inclusive date range and click **Analyze selected nights**, or open a night and
click **Analyze this night**. A local worker keeps the UI responsive. Cancel
terminates the current analysis and keeps completed nights.

Choose Overall or one of the nine components. Trailing 3/7/14-calendar-day means
are visualization only. Missing nights are not zeros. Short nights remain
included unless the optional four-hour usage filter is selected. CSV exports
unsmoothed results for the current selection. The night PDF includes calculated
Glasgow values and warnings. Results are in memory: recalculate after reopening,
importing, restoring or deleting archive data. No reimport of existing data is
needed. The archive/backup schema is unchanged.

The map follows signal zoom, shared cursor and marker timestamps. Click the map
to zoom into the flow. Cells average flags of inspirations **starting** in that
bin. Gray means no analyzed inspiration starts there, not necessarily a full
signal gap. Darker means more flags, without clinical severity bands. Overall
map cells average per-breath flag count (0–9), not the rounded nightly GI.

## Method

Input: `Flow.40ms`, 25 Hz (0.04 s/sample), L/s converted to L/min or L/min directly.
Unsupported rates and units are reported, not guessed or silently resampled.
Each original flow segment and each finite run separated by NaN/Infinity is
independent. Gaps are never concatenated or filled. Original device timestamps
and existing noon-to-noon night grouping are preserved.

Component fractions (0–1, not events/hour): Skew, Spike, Flat Top, Top Heavy,
Multi Peak, No Pause, Inspir Rate, Multi Breath, Variable Amp. Per-run fractions
use reference rounding to two decimals. Night fractions are duration-weighted
across analyzable runs and rounded to two decimals. Overall GI sums all **nine**
rounded fractions (0–9), matching `groupByNight` in the source multi-night
analyzer. This differs from the legacy eight-component cumulative total in
upstream `prepIndices`, which excludes Top Heavy and is not used as our total.

Runs shorter than 51 samples or with no complete detected inspirations are
excluded with warnings. No usable run means unavailable, never GI=0. Analyzed
hours are separate from PAP usage hours. Below five minutes analyzed, a warning
is shown. Partial coverage and segment boundaries can affect results. Thresholds
and per-breath decisions come from the reference; this is not clinical validation.

The summary across nights is an unweighted mean of nightly totals. Smoothing
uses trailing calendar days, skipping null results. Mean measured Press and mean
EprPress appear beside GI. Their difference is a difference of means, not an
inferred setting, and may have different recording coverage. A trend does not
establish that pressure changes caused a GI change.

## Privacy and licensing

No analytics, CDN, remote processing or uploads. Same-origin workers are allowed
by the server CSP; external application connections remain blocked. Source,
revision, attribution and changes: [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
License: [GPL-3.0-or-later](../LICENSE). Calculations are adapted from the credited
code and are not represented as an independently invented algorithm.

## Verification

`node --test tests/glasgow.test.js` checks units, totals, timestamps, unavailable
inputs, gaps, duration weighting, heatmap bins and date smoothing. Node is only
needed for development. A runnable browser smoke check is provided in `tests/browser-smoke.cjs`; it
requires Playwright with Chromium installed. Browser checks were not completed
in the implementation environment because the browser download was unavailable.
