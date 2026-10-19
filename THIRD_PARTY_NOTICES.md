# Third-party notices

## Glasgow Index calculations

`web/vendor/glasgow-reference.js` adapts calculation functions from:

- Project: [Multi-Night Glasgow Index Analyzer](https://github.com/VibeCoder75321/Multi-Night-Glasgow-Index-Analyzer)
- Revision: `7529ae400f0c8cc680c0c9c2aec2552c1dbbb88a`
- File: `FlowLimits.js`
- Copyright notice in that file: **Copyright 2025 DaveSkvn**
- Original algorithm: [DaveSkvn/GlasgowIndex](https://github.com/DaveSkvn/GlasgowIndex)
- License: **GPL-3.0-or-later**, full text in `LICENSE`.

Modifications dated 2026-10-19:

- Retained `findMins`, `findInspirations`, `calcCycleBasedIndicators`,
  `inspirationAmplitude`, `prepIndices` and their supporting constants.
- Removed unused plotting, DOM, EDF parsing, ideal-curve and flow-balance routines.
- Scoped the functions in a module and declared `top_t90` locally, instead of
  assigning an implicit global. Added guards for short/empty/constant input and no breaths.
- Added the `analyze` entry point for worker and Node usage.
- Detection thresholds, per-inspiration flags, and component rounding remain
  unchanged. The legacy eight-component total in `prepIndices` is not used by
  BreathPAPGuardian. Our adapter computes the nine-component total, matching
  `groupByNight` in the referenced `multi_night_analyzer.html` (including Top Heavy).

No upstream page, Google Analytics snippet, CDN script, Chart.js library, or
external network dependency is bundled. The EDF reader remains BreathPAPGuardian's
existing reader; this integration does not introduce edf2ascii or EDFlib.

BreathPAPGuardian is distributed under GPL-3.0-or-later. Preserve the upstream
copyright and license notices when redistributing this code or modifications.
