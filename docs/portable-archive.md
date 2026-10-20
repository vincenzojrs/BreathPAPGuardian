# Portable archive branch

This branch uses a local working archive and a Proton Drive folder. `main`
continues to use browser IndexedDB. This branch requires both archive paths;
missing configuration stops startup instead of silently opening browser data.
No application accounts, telemetry, external APIs or database services are used.

## Start on each Mac

Make a private folder in Proton Drive **Available offline** and wait for sync.
Use a different local working folder for each independent archive (for example,
synthetic tests and real recordings). The working folder must be outside Proton
Drive and outside the code repository. Each Mac has its own working folder.

```sh
python3 server.py \
  --data-dir "$HOME/Library/Application Support/BreathPAPGuardian/portable" \
  --shared-dir "/actual/Finder/path/to/your/Proton/archive"
```

Python 3.9+ is sufficient; no pip/npm install is required. Open
http://127.0.0.1:8765. The exact source folders, archive ID, publication date,
local version and visible shared version appear in the permanent archive panel.
`/api/mode` reports `{"portable":true}`. Patient records come from local SQLite,
never browser IndexedDB in portable mode.

## Daily use

1. Wait for Proton Drive synchronization. The app automatically loads the newest
   **locally visible** complete publication. Until you confirm synchronization,
   consultation and backup export work, but editing is blocked by the server.
2. Click **Proton Drive is synchronized · enable editing**. If a newer complete
   version became visible in the meantime, it is loaded before editing begins.
3. Select the entire SD folder. Files are read and hashed; identical active files
   are skipped. Changed files replace their logical device-relative path, while
   new segments extend existing nights. Notes/media are independent records.
4. Completed edits publish automatically after a short delay. SD imports are
   staged progressively in a separate SQLite database and published only after
   the entire import succeeds. An error pauses the import without publishing it;
   select the same SD folder to resume, or preview/discard the pending copy.
   Header-only EDF files whose record count is `-1` or `0` contain no recorded
   samples. They are counted as **empty EDF skipped**, are not stored, and do not
   pause the import. Reimport them once the recorder has finalized real samples.
   A truncated file declaring actual records, or an unknown-count file containing
   a payload, remains an error and is not silently discarded.
5. Click **Save and close** to finish outstanding work. If the browser prevents
   script closing, the app confirms you may close the tab. The browser's own
   generic exit warning is requested when work, a marker form, or publication is
   pending. Browsers do not guarantee this warning or permit custom warning text.
6. Wait for Proton Drive to finish uploading before using the other Mac.

The Python server also debounces publication after ordinary edits, so a browser
crash after a committed edit need not lose its queued publication. Interrupted
imports/restores remain staged and block publication. If the server itself
stops, committed local work is retained for recovery on reopening. A crashed
browser's writer session can be reclaimed with **Recover browser session**;
close other app tabs first. This deliberately invalidates their edit tokens.
Ordinary browser departure also requests session release as a best effort;
publication and local durability never depend on that browser event.

## What synchronization can guarantee

Checksums verify the manifest, record objects and every media/EDF blob before a
version is opened. These checks detect incomplete/corrupt delivery. They cannot
prove Proton has delivered the newest remote version or expose unpublished work
on the other Mac. The UI therefore says **saved in the Proton Drive folder**,
not **uploaded to the cloud**. Use one editing computer at a time.

If a different publication arrives while the local archive has unpublished
changes, publication is blocked. Choose **Use local copy** or **Use shared
copy**, or export a full backup first. The former local database is kept under
`recovery/`; shared history is preserved. No automatic conflict merging occurs.
Clean newer publications can be loaded automatically, requiring a new sync
confirmation before further editing. An advisory lock on one computer cannot
exclude an unseen writer on another computer.

## Incremental format and compatibility

- `latest.json` points to the current manifest and protects it with SHA-256.
- `versions/<id>.json` contains schema, parent version, timestamp, archive ID,
  record hashes and the attachment reference list.
- `objects/<hash>` contains one compressed immutable record (signals, notes,
  deletion records, preferences or cached Glasgow analysis).
- `blobs/<hash>` contains immutable original EDF or attachment bytes.

Unchanged objects are reused without rewriting them. A publication adds only
new/modified record objects and missing blobs, plus its manifest and pointer.
Hash verification still reads existing contents; incremental publication does
not mean zero disk reads. No live SQLite database is synchronized.

Old v1 `.sqlite` publications are verified and loaded automatically. They are
retained. Subsequent changed publications use v2 objects. Use this updated branch
on both Macs before writing v2 data: the previous portable app does not support
v2. Unknown/newer formats block writing. Local migrations create or retain
recovery data; do not manually edit version files.

Glasgow cache keys include the algorithm revision, flow unit, segment timing and
actual flow samples. Unchanged nights reuse their cached result; changes to flow
or algorithm trigger recomputation. The algorithm must bump its revision when
its results can change. Cached data is included in publication and backup.

## Deletions and annotations

Deleting a night removes it from active consultation and records a persistent
deletion marker. Reimporting an original or updated multi-night file cannot make
it visible again until **Manage deleted nights → Allow reimport** is chosen.
Reimport the SD afterwards if the active parsed data had been removed. Markers
and external channels for that night are deleted from the active view.

Updating SD recordings does not overwrite user notes/media. Markers outside the
updated recording intervals are flagged for review. Deletion is not forensic
erasure: retained versions, raw multi-night recordings, recovery files and
backups may contain deleted information.

## Full backups and exact recovery

**Download local backup** produces a self-contained v3 JSON with a checksum,
recordings, parsed signals, notes/media, external channels, deletion records,
Glasgow cache and saved chart preferences. It includes unpublished committed
work in the archive being viewed; a pending copy can be previewed/exported for
recovery. Published history and local recovery history are not embedded.

**Restore backup** verifies its checksum and format, then builds a new empty
local preview database. Extra records in the active archive cannot leak into
the restored copy. Inspect or export the preview; only **Use restored archive**
replaces the active archive and publishes it. The previous copy is retained.
Legacy `pap-local-v2` backups remain supported, but have no checksum. An
interrupted restore may be previewed/exported but cannot be activated as a
complete restore; restore the full backup again after preserving/discarding it.

Published history can be restored as a new publication using **Restore version**.
**Local recovery copies** can be previewed and accepted through the same flow.
Copies are not automatically merged. Keep an independent encrypted backup and
periodically test its restoration with a separate test archive.

## History cleanup and privacy

Protect recovery points with **Toggle protection**. **Preview cleanup** shows
the number of versions/files and bytes before confirmation. The current and
protected versions cannot be selected. Content referenced by any retained
version is preserved; unused content receives a seven-day grace period. Cleanup
does not erase backups, other Macs' working copies, or Proton's own retained
copies. Local recovery databases are retained and are not automatically pruned.

Local working databases, raw blobs, manifests and exported JSON have no
application-level encryption. Protect both Macs with disk encryption and store
independent backups on encrypted media. Keep all patient data outside GitHub.

## Docker

Mount a writable local working folder and the offline Proton folder. The image
uses UID 10001; mounted folders must be writable by that user.

```sh
docker build -t bpg-portable .
docker run --rm --init -it --read-only --cap-drop ALL \
  --security-opt no-new-privileges=true \
  -p 127.0.0.1:8765:8765 \
  -v "/local/working:/data/working" \
  -v "/Proton/archive:/data/shared" bpg-portable
```

For the separate synthetic standalone HTML preview and compatibility tests only,
`python3 server.py --browser-storage` explicitly enables IndexedDB. Normal
portable startup never falls back to it.
