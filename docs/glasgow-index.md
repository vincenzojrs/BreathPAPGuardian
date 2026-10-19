# Glasgow Index

Experimental flow-shape analysis: **not a diagnosis, RDI, RERA detector or the
ResMed flow-limitation signal**. No clinical severity labels are assigned.

## Usage

Import your SD card or restore a backup: all nights are analyzed automatically
in a local worker. Reopening or changing the archive automatically recalculates
the in-memory results. No extra click or reimport is needed. Missing or unsupported
flow is reported as unavailable, never zero. The archive/backup schema is unchanged.

In **Trend over time**, toggle any combination of nightly signals, Mean GI (the
nightly nine-component total), and its components. Each series has a distinct
color. To compare unlike units, vertical position is normalized to each series'
displayed min/max; these raw-value ranges and units appear below the graph.
Hover shows the values; click opens a night. The curves are not a common-unit
comparison. Missing dates break lines. Trailing 3/7/14-calendar-day means are
visualization only. Short nights remain included unless the optional four-hour
usage filter is selected. CSV exports unsmoothed results for the current selection.
**Your nights** can be expanded or collapsed.

Glasgow is a regular **Visible signals** choice. Drag the dotted handle to reorder
any signal, including GI; up/down buttons also work with keyboard or touch.
The order is remembered in this browser. **Classic timeline** shows the component
map. **Component curves** plots any selected components as colored curves with
GI on the left scale (0–9) and fractions on the right (0–1). Each plotted point
averages inspirations starting in a bin of at least 30 seconds (or the entire
visible range if shorter). This is a local breath average, distinct from the
duration-weighted rounded nightly total. Empty bins break the curves.

The PDF includes only visible signal charts, in their selected order, and captures
the chosen GI view, series, zoom, markers and colored legend. The standalone
experimental dashboard has been removed; the method remains experimental.

**Signal statistics** includes the nightly total, all nine component fractions,
and min/median/95th/99.5th percentile/mean of the flag count per inspiration.
These breath-distribution statistics are explicitly separate from the reference
nightly duration-weighted means; missing results remain unavailable. The same
statistics and interpretation note are included in the PDF.

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

Smoothing uses trailing calendar days, skipping null results. Measured Press and
EprPress means can be selected in the trend. Their CSV difference is a difference
of means, not an inferred setting, and may have different recording coverage.
A trend does not establish that pressure changes caused a GI change.

## Privacy and licensing

No analytics, CDN, remote processing or uploads. Same-origin workers are allowed
by the server CSP; external application connections remain blocked. Source,
revision, attribution and changes: [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
License: [GPL-3.0-or-later](../LICENSE). Calculations are adapted from the credited
code and are not represented as an independently invented algorithm.

## Verification

`node --test tests/glasgow.test.js` checks units, totals, timestamps, unavailable
inputs, gaps, duration weighting, heatmap bins and date smoothing. Node is only
needed for development. `node tests/browser-smoke.cjs` starts the local server
and checks automatic analysis, selections, reordering, chart modes, PDF canvas
capture, CSV, markers, reopening and deletion. It requires Playwright and Chromium;
optionally set `BPG_BROWSER_PATH` to an installed Chromium executable.

`node tests/build-preview.cjs` builds `docs/glasgow-preview.html` from the actual
application sources. Open the file locally for an interactive eight-night synthetic
demo, with a separate IndexedDB archive and embedded worker. No patient data or
external network resources are included. Demo data is intentionally short and
not representative of clinical recordings.
