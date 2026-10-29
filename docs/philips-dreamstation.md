# Philips DreamStation import

Import a **P-SERIES ZIP** with **Choose files**, or select the extracted SD-card
folder with **Choose SD folder**. Include the device's `PROP.TXT`; loose session
files alone cannot establish which device produced them. Import and decoding
remain local to the browser, including ZIP extraction. There is no server upload.

The supported scope is **unencrypted PRS1 family 0, family version 6, data file
version 3**. Real-card validation used DreamStation Auto CPAP **500X150** in CPAP
mode. Other F0V6 models/modes have not been validated on real cards. ASV family 5,
ventilator family 3, older System One formats and encrypted DreamStation 2 files
are not supported by this reader.

Use a separate browser profile for Philips if your current archive contains
ResMed recordings. The existing one-device-per-archive constraint is checked
before any import writes and before restoring a backup.

## Imported information

| Source | Result |
| --- | --- |
| `PROP.TXT` | Model, serial for local identity checks, firmware and family |
| `.001` | Session settings and mask-on/off intervals; duration uses actual mask-on time |
| `.002` | Pressure settings, total leak, snore count and Flex/average pressure intervals; OA, clear-airway apnea, hypopnea, RERA, flow limitation, snore and breathing/leak flags when present |
| `.005` | Signed respiratory flow in L/min at the rate encoded in the header; optional second pressure waveform channel |
| `D/*.003`, `E/*.004`, `LOG.SEQ` | Ignored system/daily logs; no invented therapy metrics |
| macOS metadata | Ignored, including `__MACOSX`, AppleDouble files and `.DS_Store` |

The supplied card encodes flow at **5 Hz**. It uses an Auto-capable model, but its
`.001` settings specify **CPAP**; the reader uses recorded settings, not the model
name, to determine therapy mode.

Device flags are plotted on the shared timeline. For OA, clear-airway apnea,
hypopnea and RERA, the trailing event byte is a reporting delay: it is subtracted
from the event clock, and **not presented as apnea duration**. Periodic breathing
and large leak records carry durations and are represented as spans in the model.

Total leak includes intentional mask venting. It is a separate `PRS1.TotalLeak`
channel and is not compared directly with ResMed's unintentional leak. Philips
flow-limitation flags are events, not the continuous ResMed `FlowLim.2s` signal.
Snore count is a count over a recorded statistics interval, not a 2-second
severity signal. Philips interval percentiles are weighted by recorded duration.
CSV exports for interval signals include `duration_seconds`, including the clipped
duration when exporting a visible range.

Glasgow Index is explicitly unavailable for Philips in this release: the current
implementation is validated for 25 Hz input. No synthetic upsampling is applied.

## Incomplete data and integrity

Headers, block boundaries, the 8-bit header checksum and the Philips data CRC
are checked before decoding. An invalid or unknown record makes that file
unavailable; its raw bytes and error remain in the local archive. Other valid
files can still be imported. ZIP entries also have their standard ZIP CRC checked;
unsupported encryption/compression and unsafe paths fail explicitly. If native
ZIP decompression is unavailable in your browser, extract the ZIP and choose the
folder instead. ZIP64 and split ZIPs are unsupported.

Nights without waveforms can still show use and settings from `.001`. Event
counts used for AHI require a summary and coverage of all mask-on intervals
(with at most one second of clock tolerance). Missing `.002` data therefore
produces unavailable metrics, not zero events. Waveform-only nights have charts
and a recording-duration estimate, but no complete-therapy AHI. Partial event
flags remain inspectable even when aggregate counts are unavailable.

Repeated imports use content hashes. The night builder also merges identical
summary identities and overlapping time intervals, preventing copies in multiple
`P0`/`P1`/... folders from doubling use. Each `.001` session keeps its own settings;
the settings panel shows the latest session and lists all snapshots below.
Original device timestamps are preserved, displayed without timezone conversion,
and grouped noon-to-noon as in the existing EDF reader. Verify clock alignment
against a trusted report before comparing to external sensors.

Waveform chunks merge only when contiguous. Signed samples stay in `Int8Array`
to avoid expanding a multi-year archive eightfold; backups preserve this type.
Night deletion clips interval metadata, events and waveforms, including files
crossing noon. Reimporting the SD can restore deleted nights, as before.

## Validation

Run all synthetic tests (Node 24 was used; runtime use needs no Node/npm):

```sh
node --test tests/*.test.js
```

Opt-in validation against a private ZIP, never checked into git:

```sh
node tests/validate-philips-archive.js /private/path/P-SERIES.zip
```

A private multi-year 500X150 archive was also used to check complete ZIP
decoding; one empty event file was rejected explicitly. No recordings, identifiers
or patient reports are included in this repository. This verifies structural
decoding and integration, **not clinical equivalence** to OSCAR/Encore. A
side-by-side report comparison remains a release check.

Browser checks exercise both the existing ResMed/Glasgow workflow and the Philips
workflow (ZIP/folder import, charts, CSV/PDF, reimport, device isolation,
backup/restore/reload, deletion and corrupt input):

```sh
# Optional developer tooling; not needed to run the application.
npm install --no-save playwright
npx playwright install chromium
node tests/browser-smoke.cjs
node tests/philips-browser.cjs
```

Set `BPG_BROWSER_PATH` if using an existing Chromium executable. All fixtures
generated by `philips-browser.cjs` are synthetic and are removed after the test.

Format references and licensing are pinned in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
