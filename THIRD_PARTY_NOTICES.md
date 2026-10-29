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

## Philips Respironics PRS1 reader

`web/philips.js` adapts the unencrypted family 0/version 6 format decoding from
[OSCAR](https://gitlab.com/pholy/OSCAR-code), revision
`d16e40388d7b4dcbfc97afef85df43c520a03ccb`:

- `oscar/SleepLib/loader_plugins/prs1_parser.cpp`: block headers, checksums and
  CRC-32/MPEG-2 over zero-extended 32-bit data words.
- `oscar/SleepLib/loader_plugins/prs1_parser_xpap.cpp`: `ParseSummaryF0V6`,
  `ParseSettingsF0V6`, `ParseEventsF0V6`.
- `oscar/SleepLib/loader_plugins/prs1_loader.cpp`: waveform signedness and scaling.

Copyright (c) 2019–2024 The OSCAR Team. Portions copyright (c) 2011–2018
Mark Watkins. OSCAR is distributed under GNU GPL version 3 (its `COPYING`,
the same license text as this repository's `LICENSE`). The adapted
`web/philips.js` is marked **GPL-3.0-only**; preserve that notice. The original
BreathPAPGuardian and Glasgow code retain their existing license notices.

Modifications dated 2026-10-28–29: JavaScript implementation; explicit F0V6 scope;
strict bounds/checksum validation; local browser data model; interval coverage
and mask-on use; compact signed waveform storage; unsupported records rejected
rather than guessed. No OSCAR executable, Qt dependency, sample recordings or
patient identifiers are bundled. `web/import-files.js` is a separate local ZIP
reader using native `DecompressionStream` and does not bundle a ZIP library.

## DreamStation 2 encrypted envelope

`web/dreamstation2.js` adapts `PRDS2File::parseDS2Header`, `initializeKey` and
`decryptData` from the same pinned OSCAR revision above, plus algorithm parameters
from `oscar/SleepLib/crypto.cpp`. Copyright (c) 2021–2024 The OSCAR Team.
Distributed under GPL-3.0-only, with the full license in `LICENSE`.

Modifications dated 2026-10-29: strict JavaScript header bounds; native Web Crypto
PBKDF2-SHA256/AES-256-GCM; per-import bounded key cache; explicit authentication
failures. The common format constant is the result of AES-256-ECB decryption of
OSCAR's published COMMON_KEY using its published OSCAR_KEY. No Botan/Qt code or
binary is bundled. OSCAR's zero-tag recovery mode is deliberately omitted.
Synthetic test envelopes use independent Node/OpenSSL encryption and the original
published constants rather than the browser decoder to generate test inputs.
