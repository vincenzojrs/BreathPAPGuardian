# PAP Locale

Explore PAP SD-card recordings in your browser, with a local night journal, synchronized charts, markers and exports. No account or cloud service is required.

PAP Locale was developed around recordings from the **ResMed AirCurve 10 CS PaceWave**. It reads EDF files directly in JavaScript and stores imported data in the browser. Compatibility with every PAP device or EDF variant is not established.

> This is a data exploration tool, not a diagnostic tool or a clinical report. Recording time is not necessarily sleep time. Pressure labels and calculated episodes require careful interpretation.

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Using the application](#using-the-application)
- [Data and interpretation](#data-and-interpretation)
- [Privacy and backups](#privacy-and-backups)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Contributing and support](#contributing-and-support)
- [Provenance and licensing](#provenance-and-licensing)

## Features

- Import individual files or an SD-card folder, including multiple nights; drag and drop is supported where the browser allows it.
- Browse night history, usage, annotated events, signal averages and threshold-based snore/flow-limitation episodes.
- Inspect STR settings, raw summary fields and full-night signal statistics.
- Explore synchronized charts with a shared cursor, zoom, pan, time navigation and pressure overlays.
- Add time markers with titles, notes, images and videos (maximum 30 MB per attachment).
- Export each signal as CSV for the full night or visible range.
- Generate PDF reports with settings, statistics, events, visible charts and marker notes. Media attachments are listed, not embedded.
- Download and restore JSON backups, including imported files and attachments.
- Delete a marker, one noon-to-noon night, or the local archive.

The English edition preserves the original interface structure, CSS, application logic, storage identifiers and backup format. Existing launcher filenames and the project name are retained for compatibility.

## Quick start

Download and extract the repository, or clone it from its GitHub **Code** menu. Run the commands below from the folder containing `server.py`.

### Python 3

Requirements: Python 3 and a modern browser with JavaScript, IndexedDB, Canvas and Web Crypto support. No pip or npm packages are needed.

```sh
python3 server.py
```

Open **[http://127.0.0.1:8765](http://127.0.0.1:8765)**. Keep the terminal open; press **Ctrl+C** to stop the server.

On macOS, you can also double-click `Avvia-PAP.command`, or run:

```sh
bash Avvia-PAP.command
```

Use the same browser, profile and URL every time. `localhost` and `127.0.0.1` have separate browser archives.

### Docker

Requirements: Docker running (Docker Desktop on macOS). Internet access is needed for the initial Python base-image download. Once the image is built, the application runs offline.

On macOS:

```sh
bash Avvia-con-Docker.command
```

Or build and run manually:

```sh
docker build -t pap-locale:1 .
docker run --rm --init -it --read-only --cap-drop ALL \
  --security-opt no-new-privileges=true \
  -p 127.0.0.1:8765:8765 pap-locale:1
```

Open **[http://127.0.0.1:8765](http://127.0.0.1:8765)**. Stop with **Ctrl+C**. The container runs as an unprivileged user. Browser data is not stored in the container, and no volume is required for it.

## Using the application

1. Select **Choose SD folder** or **Choose files**, or drop files/folders onto the import panel. Keep the original SD card as your source copy.
2. Use **Trends** to review available nights and choose a metric. A day without data is not evidence of non-use.
3. Select a night or choose **Explore night**. Review its settings, statistics and events, then select the signals to display.
4. Drag on a chart to zoom. Use **Drag: pan**, **Shift + drag**, the arrow buttons or **← / →** to pan. Double-click or press **Esc** to show the full night. **Undo zoom** restores the previous view.
5. Use **+ Marker**, or **Click: marker**, to annotate a time shared by the charts. Attachments remain in the browser and backups.
6. Export CSV from a signal card or choose **Download PDF report**. In the **File ready** dialog, choose **Download file**, **Open file**, or another available save option.
7. Choose **Download local backup** regularly and verify a restore in a separate browser profile before relying on that backup alone.

Only one PAP device per archive is supported. A second serial number detected in identification files causes import to be rejected. Reimporting identical files skips duplicates.

### Transfer an existing archive

In the original browser/application, download the local backup and save the JSON file. Open this local application and choose **Restore backup**, then verify the nights, markers and media. Importing the SD alone does not transfer markers.

Restore accepts the existing `pap-local-v2` backup format. It writes records by ID into the current archive; it does not first clear the archive or resolve concurrent edits. Use a separate browser profile for independent archives.

### Update

Download a backup, replace the program files, and keep using the same browser, profile and URL. With Docker, rebuild the image:

```sh
docker build -t pap-locale:1 .
```

Rebuilding the image does not change IndexedDB data.

## Data and interpretation

### Files and compatibility

| File/group | Interpretation in this application |
| --- | --- |
| `Identification.tgt`, other `.tgt` files | Text tags and device identification; imported originals retained |
| `STR.edf` | Daily summaries and available settings; recognized ASV/ASVAuto fields |
| `BRP.edf` | High-resolution flow and pressure |
| `PLD.edf` | Pressure, leak, respiratory rate, volume, ventilation, snore and flow limitation |
| `EVE.edf` | EDF+ event annotations with times and durations |
| `SAD.edf` | Pulse/SpO₂ channels when usable values exist |
| Other imported files | Retained as originals; not necessarily decoded |

The parser expects supported EDF headers, a known nonnegative record count, consistent file length and 16-bit samples. It is not a universal EDF/BDF reader. CRC channels are excluded; pulse/SpO₂ channels containing only `-1` are omitted. STR raw `-1` samples are treated as missing. Invalid EDF files can be retained with an import error while other files continue importing.

### Time, signals and statistics

- A PAP day runs **noon to noon**, using the recorded device clock. The application represents these values using UTC-based JavaScript operations without automatically converting the device time zone.
- Event times use each EDF file's start time plus its annotation onset. No fixed clock correction is applied.
- Generic `Apnea` annotations are not automatically classified as obstructive or central. Unspecified durations are not invented.
- Source signal labels are retained, including `Press` and `EprPress`; interface labels include IPAP/EPAP interpretations from the original development comparison. They do not establish equivalence for every device or mode.
- Flow/leak in L/s is displayed in L/min; volume in L is displayed in mL.
- Statistics use linearly interpolated sample percentiles and a duration-weighted mean. Zeros are included by default; the checkbox excludes them for respiratory rate, tidal volume and minute ventilation statistics.
- A snore/flow-limitation episode is a consecutive run of finite samples strictly above the chosen threshold. A gap ends an episode. These are calculated episodes, not device-declared clinical events.
- Full equivalence with SleepHQ statistics or proprietary filtering has not been established.

Deleting a night removes its markers and attachments and retains other days from overlapping parsed recordings as derived records. It does not alter the SD card. Reimporting original files or an older backup may restore a deleted night.

## Privacy and backups

All EDF parsing, charts, statistics, exports and backup processing happen in the browser. The Python server serves only the bundled HTML, JavaScript and CSS; it has no upload or remote API routes. The page's Content Security Policy blocks application connections (`connect-src 'none'`). There are no external fonts, CDNs, analytics, or runtime npm dependencies.

The normal Python launch binds to loopback. The Docker command publishes the port only on `127.0.0.1`. This package provides no login, remote synchronization or application-level encryption and is intended for local use.

**Your archive lives in IndexedDB**, associated with the browser profile and `http://127.0.0.1:8765`. It is not inside the repository, Python server or Docker image. Clearing site data, deleting a profile, browser storage eviction or using a different profile can make it unavailable. Use normal browsing mode and keep independent backups.

**Backup JSON is not encrypted by this application.** It contains originals, identifying metadata, notes and attachments. Store it privately. Publishing the program on GitHub does not publish your browser archive; do not commit SD files, backups, attachments or patient screenshots. The repository contains program files and documentation only.

Opening the same program on another device does not synchronize data. Transfer via backup/restore is manual. Cloud storage, end-to-end encryption, authentication and multi-device synchronization discussed during development are not implemented here. Publishing this repository also does not deploy an application server or delete earlier copies elsewhere.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| macOS will not open a `.command` launcher | Run `bash Avvia-PAP.command` or `bash Avvia-con-Docker.command` from Terminal. No macOS security-setting changes are required. |
| Python is unavailable | Install Python 3 from its official distribution, or use the Docker launcher. |
| Docker launcher exits | Start Docker Desktop, wait until it is ready, then rerun the launcher. Keep the terminal error when reporting a failure. |
| Port 8765 is unavailable | Stop the earlier instance with Ctrl+C in its terminal, then start again. |
| The archive appears empty | Verify the URL, browser and profile. Restore a saved backup if needed. |
| A file fails to import | Read the import status; confirm that it is an intact supported EDF file and that browser storage is available. |
| Downloads do not appear | Use **Open file** in the export dialog and save from the browser; additional save/share options depend on browser support. |
| Another device has no history | Archives are local to each browser. Use backup/restore. |
| Statistics differ from another application | Compare zero handling, units, percentile methods and the selected time interval. |

## Development

```text
.
├── server.py                  # Standard-library static server and response policy
├── Dockerfile                 # Python 3.12 Alpine container
├── Avvia-PAP.command          # macOS Python launcher
├── Avvia-con-Docker.command   # macOS Docker launcher
├── LEGGIMI.txt                # English quick-reference instructions (original filename)
└── web/
    ├── index.html             # Interface structure
    ├── style.css              # Layout and styling
    ├── core.js                # EDF parsing, night grouping, statistics and deletion
    ├── app.js                 # IndexedDB, interface, charts, markers and exports
    └── pdf-export.js          # Local PDF generation
```

There is no build step. Run `python3 server.py` after editing and reload the browser. Docker uses the standard-library server; no `edf2ascii` installation is needed.

Optional syntax checks with Node.js installed:

```sh
node --check web/core.js
node --check web/app.js
node --check web/pdf-export.js
bash -n Avvia-PAP.command
bash -n Avvia-con-Docker.command
```

For behavior checks, use synthetic recordings in a separate browser profile. Verify imports, noon boundaries, statistics, navigation, markers/media, CSV, PDF, backup/restore and deletion of overlapping nights. No clinical-data fixtures or automated test suite ship with the original package.

## Contributing and support

Use this repository's GitHub Issues for reproducible bugs and feature requests. Include your OS, browser/version, Python or Docker version, steps to reproduce, expected/actual behavior and a sanitized terminal error. Use synthetic or carefully anonymized examples; never post private recordings or backups in public issues.

Keep pull requests focused and describe behavior changes and validation. Preserve storage/backup compatibility, device time semantics and the local privacy model. Discuss broader changes before implementing them. Review the licensing status below before redistributing modified copies.

For a security concern, avoid posting exploit details or private data publicly; use GitHub private vulnerability reporting if the repository owner has enabled it. No separate security contact or response-time commitment is specified.

## Provenance and licensing

Development began with SD-file analysis and a separate EDF-to-CSV experiment using `edf2ascii` in Docker, followed by a chart prototype. This package reads EDF directly in JavaScript: it does not bundle or invoke `edf2ascii` or EDFlib. Its physical-value conversion uses EDF header scaling. No complete comparative source-provenance audit has been performed.

This README was checked against the delivered source and the two development conversations supplied by the owner. It documents the local package; earlier prototypes and later cloud proposals are not current features. Private conversation links and personal sample results are intentionally not reproduced in this public repository.

ResMed, PaceWave and SleepHQ names identify devices or comparison context; no affiliation or endorsement is claimed.

**No software license has been selected or included.** Public repository visibility alone does not grant a general license to use, modify or redistribute the code. The owner should choose a license and confirm any required notices before presenting this project as open source. The original ZIP contained no license or attribution file; this English documentation does not assert a legal provenance clearance.
