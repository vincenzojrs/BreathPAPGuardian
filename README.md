# BreathPAPGuardian

A local PAP data explorer with interactive charts, a night journal and exports. Built around **ResMed AirCurve 10 CS PaceWave** recordings.

## Features

- Import EDF files or an SD-card folder and browse multiple nights.
- Explore synchronized charts, pressure overlays, settings and statistics.
- Add markers with notes, images and videos.
- Export CSV signals and PDF reports.
- Back up and restore your archive, including attachments.
- Automatically calculate Glasgow Index and nine component fractions on import.
- Compare colored, selectable series in a multi-night line chart, including mean GI.
- Switch between the classic GI timeline and component curves; reorder visible
  signals by drag and drop. PDF reports preserve the selected chart and order.
- Inspect GI statistics alongside signal statistics and collapse the night list.

See [Glasgow Index: method and usage](docs/glasgow-index.md).
An offline [interactive preview](docs/glasgow-preview.html) uses synthetic data only;
download and open the HTML file in your browser. GI remains experimental flow-shape
analysis, not a diagnostic index or RDI.

## Dashboard preview

Screenshots from real-world use of the original Italian interface. The current application is in English.

**Night settings and signal statistics**

![Night overview showing PAP settings and full-night signal statistics](docs/images/night-overview.png)

**Synchronized signal charts**

![Zoomed respiratory flow, pressure with EPAP overlay, leak and flow limitation charts](docs/images/signal-charts.png)

## Quick start

Download or clone this repository. From its folder, run:

```sh
python3 server.py
```

Open **[http://127.0.0.1:8765](http://127.0.0.1:8765)**. Keep the terminal open; press **Ctrl+C** to stop.

Requires Python 3 and a modern browser. No pip/npm dependencies or build step.

**macOS launchers:**

```sh
bash Avvia-PAP.command
# Or, with Docker Desktop running:
bash Avvia-con-Docker.command
```

**Docker on other platforms:**

```sh
docker build -t pap-locale:1 .
docker run --rm --init -it --read-only --cap-drop ALL \
  --security-opt no-new-privileges=true \
  -p 127.0.0.1:8765:8765 pap-locale:1
```

The initial Docker build needs Internet access; subsequent use works offline.

## Usage

Choose **Choose SD folder** or **Choose files**, then select a night. Drag on charts to zoom; **Shift + drag** pans, and **Esc** resets the view. Use **+ Marker** for notes and **Download local backup** to save your archive.

## Privacy and storage

Processing happens in your browser, with no accounts, analytics or external application services. Data stays in **IndexedDB**, not in the program folder or Docker container.

Always use the same browser, profile and URL: `localhost` and `127.0.0.1` have separate archives. Clearing browser data can erase your history.

**Download backups regularly.** Backup JSON includes recordings and attachments and is not encrypted by the app. Keep it private and out of GitHub. Transfer between devices uses manual backup/restore.

## Limitations

- Intended for data exploration, **not diagnosis**.
- One PAP device per archive; compatibility with other devices is not guaranteed.
- Nights run noon to noon using the device clock, without time zone conversion.
- Calculated episodes and statistics may differ from SleepHQ.
- Attachments are limited to 30 MB each; PDFs list media without embedding it.

## Support and contributions

Report bugs or propose changes through [GitHub Issues](https://github.com/vincenzojrs/BreathPAPGuardian/issues). Include reproduction steps and your environment; use synthetic examples rather than private health data.

See [LEGGIMI.txt](LEGGIMI.txt) for additional startup, transfer and update notes.

## License

Licensed under **GNU GPL version 3 or, at your option, any later version**
([LICENSE](LICENSE)). Distributed without warranty.

Glasgow calculations adapt DaveSkvn's code through VibeCoder75321's multi-night
analyzer. Copyright notices, pinned source revision and modifications are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The app reads EDF directly in JavaScript and does not bundle or invoke
edf2ascii or EDFlib.

