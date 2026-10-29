# BreathPAPGuardian

Both branches share the same importers, charts, statistics, Glasgow analysis, and exports.
`main` defaults to local browser IndexedDB; `feature/portable-archive` defaults to a
versioned archive published through a locally synchronized Proton Drive folder.
There is no direct Proton account/API connection. See the [portable archive guide](docs/portable-archive.md).

The default is selected by `storage-mode.json`. Keep `web/` and the tests identical
on both branches when adding analytical or import features. Merge shared changes
between branches and preserve the destination branch's default storage setting.

A local PAP data explorer with interactive charts, a night journal and exports. Supports **ResMed EDF** recordings and **Philips DreamStation and DreamStation 2 PRS1 family 0/version 6** recordings.

## Features

- Import EDF files, a Philips P-SERIES ZIP or an SD-card folder and browse multiple nights.
- Explore synchronized charts, pressure overlays, settings and statistics.
- Add markers with notes, images and videos.
- Export CSV signals and PDF reports.
- Back up and restore your archive, including attachments.
- Automatically calculate Glasgow Index and nine component fractions for supported 25 Hz ResMed flow. Philips 5 Hz flow remains viewable without a GI estimate.
- Compare colored, selectable metrics in a multi-night bar chart, including mean GI.
- View five summary measures: annotated AHI, flow limitation, use and mean GI
  across the latest seven available nights, plus total nights in the archive.
- Switch between the classic GI timeline and component curves; reorder visible
  signals by drag and drop. PDF reports preserve the selected chart and order.
- Inspect the two key GI statistics alongside signal statistics; expand component
  fractions if needed. The night list starts collapsed.

See [Glasgow Index: method and usage](docs/glasgow-index.md) and
[Philips DreamStation: supported data and limitations](docs/philips-dreamstation.md).
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

Requires Python 3.9+ and a modern browser; no pip/npm install or build is needed.
On `main`, run `python3 server.py` (or `Avvia-PAP.command`): data stays in IndexedDB.

On `feature/portable-archive`, make the Proton Drive archive folder available offline, wait for synchronization,
then run from the repository folder:

```sh
python3 server.py \
  --data-dir "$HOME/Library/Application Support/BreathPAPGuardian/portable" \
  --shared-dir "/actual/Finder/path/to/your/Proton/archive"
```

Open [http://127.0.0.1:8765](http://127.0.0.1:8765). Keep the terminal open.
Confirm Proton Drive synchronization before editing. Use **Save and close**
before switching devices, and wait for Proton Drive to finish uploading.

See the [portable guide](docs/portable-archive.md) for setup on the second Mac,
Docker mounts, migration, interrupted imports, conflict recovery and cleanup.

## Usage

Choose **Choose SD folder** or **Choose files**, then select a night. Drag on charts to zoom; **Shift + drag** pans, and **Esc** resets the view. Use **+ Marker** for notes and **Download local backup** to save your archive.

## Privacy and storage

Processing happens on the device. A local SQLite working archive is published
to the selected Proton Drive folder as immutable record objects and blobs.
Unchanged content is reused; no live database is synchronized. Local work is
saved immediately and complete operations publish automatically.

The archive panel identifies the folders, archive and versions in use.
Consultation starts read only; editing requires synchronization confirmation.
The app can verify file integrity but cannot determine whether Proton has
delivered the newest cloud publication. Use one editing computer at a time.

Backups are complete and self-contained, including recordings, notes and media.
They are not encrypted by the app. Keep an independent backup on encrypted
storage and all patient data outside GitHub. Restores build an empty preview
archive before replacing the active copy.

[Read the complete storage and recovery documentation](docs/portable-archive.md).

## Limitations

- Intended for data exploration, **not diagnosis**.
- One PAP device per archive. Use separate browser profiles for Philips and ResMed.
- DreamStation support is validated on a 500X150 in CPAP mode. DreamStation 2 decryption/import is tested with independently encrypted synthetic fixtures; real DS2 card validation is pending. Other PRS1 families are unsupported.
- Nights run noon to noon using the device clock, without time zone conversion.
- Calculated episodes and statistics may differ from SleepHQ.
- Attachments are limited to 30 MB each; PDFs list media without embedding it.
- Portable mode requires the local Python server and configured local/shared folders.
- The standalone HTML preview uses a separate synthetic browser archive.

## Support and contributions

Report bugs or propose changes through the repository issue tracker. Include reproduction steps and your environment; use synthetic examples rather than private health data.

See [LEGGIMI.txt](LEGGIMI.txt) for additional startup, transfer and update notes.

## License

Original project code is licensed under **GNU GPL version 3 or, at your option, any later version**
([LICENSE](LICENSE)). The OSCAR-derived Philips reader retains its GPL-3.0-only notice. Distributed without warranty.

Glasgow calculations adapt DaveSkvn's code through VibeCoder75321's multi-night
analyzer. Copyright notices, pinned source revision and modifications are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The app reads EDF directly in JavaScript and does not bundle or invoke
edf2ascii or EDFlib.

