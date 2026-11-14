# Trailbook — Specification

Status: draft v0.1 (2026-11-13)

Trailbook is a self-hosted Home Assistant add-on that imports FIT activity files
from a shared folder and turns them into training statistics, a map of every route
and per-activity charts. It is open source (MIT) and designed to run comfortably on
small ARM boards such as the Home Assistant Yellow (Raspberry Pi CM4).

---

## 1. Goals and non-goals

### Goals
- Import FIT files dropped into a folder by HA automations, Garmin exports or by hand.
- Support several people; each person is a subfolder.
- Statistics: totals and trends per sport, week, month, year.
- Map: every route of a person drawn as lines; overlapping routes produce a heatmap effect.
- Per-activity analysis: route, charts of streams (HR, pace/speed, power, cadence,
  altitude), laps, best efforts.
- Fitness model: training load, fitness (CTL), fatigue (ATL), form (TSB); power and
  pace duration curves.
- A modern UI, shown inside Home Assistant (Ingress panel) or in an iframe.
- Near-zero CPU and small RAM footprint when idle.
- English UI first, Polish translation; more languages via translation files.

### Non-goals (for now)
- Explorer tiles / max square / clusters.
- Syncing with Garmin Connect, Strava or other cloud services.
- Archiving original FIT files. The folder is the source of truth for files;
  the database keeps the derived data.
- Sleep, daily monitoring, HRV and other non-activity FIT data (skipped on import).
- Editing activities beyond category, name and deletion.

---

## 2. Target platform

| Item | Decision |
|---|---|
| Architectures | `aarch64` (HA Yellow, Raspberry Pi 4/5) and `amd64`. Both images built in CI. |
| Base image | Debian-based (glibc) HA base image, because prebuilt Python wheels exist for ARM on glibc, not on Alpine/musl. |
| Rule for dependencies | Every dependency must ship prebuilt `aarch64` wheels or be pure Python. Nothing is compiled on the device. |
| Excluded | pandas, pyarrow, vegafusion, GDAL and other heavy native stacks. |
| Distribution | Public GitHub repository usable as an HA add-on repository; images published to GHCR. |

---

## 3. Architecture

```
HA automation / user ──► /share/trailbook/<person>/*.fit
                                   │
         trigger (stdin / API / button / optional interval)
                                   ▼
┌──────────────────────── add-on container ────────────────────────┐
│  API server (FastAPI + uvicorn, 1 worker)                         │
│   • serves the static frontend                                    │
│   • JSON API                                                      │
│   • map tile proxy + disk cache                                   │
│   • spawns the importer when there is work                        │
│                                                                   │
│  Importer (separate process, nice 19 / ionice idle)               │
│   • scans folders, parses FIT, writes SQLite, then exits          │
│                                                                   │
│  SQLite (WAL) in /data/trailbook.db                               │
└───────────────────────────────────────────────────────────────────┘
                                   ▲
Browser: static HTML/JS (MapLibre GL + ECharts) — all rendering client-side
```

### Key principles
- **The server does not draw anything.** It returns data; the browser renders map and charts.
- **The importer is not resident.** It starts only when there is work and exits afterwards,
  so its memory (FIT SDK, numeric code) is released.
- **The API process stays lean.** No numeric libraries are imported in the API process.
  Target idle RSS: below 80 MB; idle CPU: ~0 (no polling loops).
- **Derived data is precomputed at import** (summaries, simplified tracks, best efforts,
  daily load), so page loads are cheap reads.

### Stack
| Layer | Choice | Reason |
|---|---|---|
| Backend | Python 3.12, FastAPI, uvicorn | Small, async, well known. |
| Database | SQLite via stdlib `sqlite3`, WAL mode, hand-written migrations | No server process, single file, part of HA backups. |
| FIT parsing | Garmin FIT SDK for Python (`garmin-fit-sdk`) | Official, pure Python, knows all sports and fields. |
| Frontend | TypeScript + Vite, static build | Architecture-independent; served by the add-on. UI framework decided when UI design starts (Svelte is the default candidate). |
| Map | MapLibre GL JS, vector tiles | WebGL handles 1M+ line vertices. |
| Charts | ECharts (uPlot for dense time series if needed) | Fully stylable, modern look. |
| i18n | JSON translation files, `en` default, `pl` second | Contributors can add languages without code changes. |

---

## 4. Folders and people

```
/share/trailbook/            ← root folder (configurable; must be inside an HA-mapped dir)
├── alice/                   ← person id = folder name
│   ├── 2024-05-01-run.fit
│   └── export.zip           ← Garmin bulk export, unpacked on import
└── bob/
```

- Allowed roots: `/share`, `/media`, `/config` or the add-on config dir (HA mapping limits).
- Each first-level subfolder is a person. Subfolders below that are scanned recursively.
- A new subfolder shows up in the app as "new person — configure".
- Folder renamed: the app does not silently create a new person; it asks whether to attach
  the folder to an existing person.
- Per-person settings in the app: label, color, and threshold values used in statistics
  (see 7.2). Thresholds are stored with a `valid_from` date, because they change over time.

---

## 5. Import manager

### 5.1 Triggers
1. **HA automation** → `hassio.addon_stdin` with `{"action": "scan"}` (optionally `"person": "alice"`).
2. **API** → `POST /api/import/scan`.
3. **Button** in the Import page.
4. **Optional interval** (off by default) for users without automations.

The very first import is started by the user from the Import page after choosing the root folder.

### 5.2 Scan (cheap)
- Walk folders with `os.scandir`; read only `stat` (size, mtime).
- Compare with the `files` table:
  - unknown path → `new`;
  - known path, same size and mtime → unchanged, nothing to do;
  - known path, changed size or mtime → re-hash, re-check;
  - path in DB but not on disk → `missing` (data kept).
  - missing path that appears again → back to its previous status.
- A scan of several thousand files must take well under a few seconds on a CM4.

### 5.3 Identity and duplicates
Three keys, from cheap to strong:
1. `rel_path + size + mtime` — fast change detection.
2. `sha256` of the file — the same file under a different name.
3. FIT `file_id` (`serial_number` + `time_created`, fallback: first `record` timestamp + sport)
   — the same activity exported twice. Second occurrence → `duplicate`.

### 5.4 Statuses (`files.status`)
| Status | Meaning |
|---|---|
| `new` | Detected, waiting in queue. |
| `imported` | Parsed, activity stored. |
| `skipped` | Not an activity (sleep, monitoring, settings, …). Reason stored. |
| `duplicate` | Activity already exists from another file. |
| `error` | Could not be parsed. Error message stored; can be retried. |
| `missing` | File gone from disk. **Activity data stays** until the user deletes it. |

### 5.5 Missing files
Missing files are only flagged. The Import page lists them with two actions:
"keep data" (dismiss) and "delete activity". Nothing is removed automatically.

### 5.6 Processing order and load
- Queue ordered oldest-first by mtime; one file at a time.
- Importer runs under `nice -n 19` and `ionice -c3`.
- Commits after each file, so an interrupted import resumes where it stopped.
- Progress (done / total / current file / errors) exposed at `GET /api/import/status`.
- ZIP files are read in place (members streamed), never unpacked to disk.

---

## 6. Importer pipeline

Each file goes through stages. Each stage writes its own table.

| # | Stage | Output |
|---|---|---|
| 1 | Read `file_id` only | `type != activity` → `skipped` and stop (sleep files are cheap to skip). |
| 2 | Detect sport | `sport` + `sub_sport` → Trailbook category via mapping table (7.1). Unknown → `other`. |
| 3 | Summary | Row in `activities`. |
| 4 | Track | Simplified polyline in `tracks` (only if GPS present). |
| 5 | Streams | Compressed per-channel arrays in `streams`. |
| 6 | Laps | Rows in `laps`. |
| 7 | Best efforts | Power / pace / HR bests in `best_efforts`. |
| 8 | Load | Training load on the activity; `daily_load` recomputed from that date on. |

Every activity stores `importer_version`. When a later version adds a metric, activities
whose file still exists can be reprocessed in the background; others keep their data and
are recomputed from stored streams where possible.

### 6.1 Track simplification
- Douglas–Peucker with ~5 m tolerance (configurable); typical 1 h activity: 3600 → 200–400 points.
- Stored as an encoded polyline (precision 1e-5).
- Bounding box and start point stored on the activity for filtering.
- Full-resolution lat/lon kept in `streams` for the activity detail map.

### 6.2 Streams storage
- One row per activity per channel, never one row per sample.
- Channels: `time`, `distance`, `lat`, `lon`, `altitude`, `hr`, `speed`, `power`,
  `cadence`, `temperature` (when present).
- Encoding: little-endian float32/int32 array, zlib-compressed. Missing values as NaN / sentinel.
- Time base: seconds from activity start; gaps (pauses) preserved.

---

## 7. Domain rules

### 7.1 Activity groups and types
Two levels, both defined in `backend/src/trailbook/sports.py` with EN and PL names:
- **Group** (`activities.category`) for totals and filters: `run`, `ride`, `swim`, `walk`,
  `hike`, `winter`, `water`, `fitness`, `mind_body`, `climbing`, `racket`, `team`, `combat`,
  `multisport`, `other`.
- **Type** (`activities.activity_type`) for detailed analysis, ~120 types covering the Garmin
  sport list: e.g. `trail_run`, `treadmill_run`, `gravel_ride`, `virtual_ride`, `pool_swim`,
  `ski_skate`, `yoga`, `pilates`, `strength`, `hiit`, `padel`, `bouldering`.

Mapping from FIT `sport`/`sub_sport`: exact pair → sub-sport that means the same under any
sport (yoga, strength_training, padel, …) → sport default → `other`. A test checks that every
FIT sport known to the SDK has a type. Each activity also has an `indoor` flag.
Users can change the type of an activity (the group follows); the override survives
reprocessing. When the importer version increases, `trailbook reprocess` rebuilds older
activities from files still on disk.

### 7.2 Thresholds per person (with `valid_from`)
`hr_max`, `hr_rest`, `lthr` (lactate threshold HR), `ftp` (W), `threshold_pace` (s/km),
`swim_css` (s/100 m), `weight` (kg). All optional.

### 7.3 Training load
Chosen per activity, first available:
1. Power-based TSS (power data + FTP).
2. Pace-based load for running (pace + threshold pace).
3. HR-based TRIMP/hrTSS (HR + LTHR or HR max/rest).
4. None (activity counts in totals but not in load).
The method used is stored with the value.

### 7.4 Fitness model
Daily load per person → CTL (42-day exponential average), ATL (7-day), TSB = CTL − ATL
(yesterday's values). Stored in `daily_load`, recomputed incrementally from the earliest
changed date.

### 7.5 Best efforts
- Power: 5 s, 15 s, 30 s, 1 min, 5 min, 10 min, 20 min, 60 min.
- Pace (run): 400 m, 1 km, 5 km, 10 km, half marathon, marathon.
- HR: max average over 1, 5, 20, 60 min.
These feed the duration curves (all-time, per year, last 90 days).

---

## 8. Database schema (v1, outline)

```
schema_version(version)

persons(id TEXT PK /* folder name */, label, color, created_at, archived)
person_thresholds(person_id, valid_from DATE, hr_max, hr_rest, lthr, ftp,
                  threshold_pace, swim_css, weight)

files(id PK, person_id, rel_path, zip_member, size, mtime, sha256,
      status, skip_reason, error, activity_id,
      first_seen, last_seen, missing_since, imported_at)

activities(id PK, person_id, fit_uid UNIQUE, start_time_utc, utc_offset_s,
           sport, sub_sport, category, indoor, category_overridden,
           name, device,
           elapsed_s, moving_s, distance_m, ascent_m, descent_m,
           avg_hr, max_hr, avg_speed, max_speed,
           avg_power, max_power, np_power, avg_cadence, calories,
           load, load_method, has_gps,
           start_lat, start_lon, bbox_min_lat, bbox_min_lon, bbox_max_lat, bbox_max_lon,
           importer_version, created_at)

tracks(activity_id PK, polyline, point_count)
streams(activity_id, channel, encoding, data BLOB, PK(activity_id, channel))
laps(activity_id, idx, start_offset_s, elapsed_s, moving_s, distance_m,
     avg_hr, max_hr, avg_speed, avg_power, avg_cadence, ascent_m)
best_efforts(activity_id, kind /* power|pace|hr */, key /* seconds or metres */, value)
daily_load(person_id, date, load, ctl, atl, tsb, PK(person_id, date))
import_runs(id, started_at, finished_at, trigger, scanned, new, imported,
            skipped, duplicates, errors, missing)
settings(key PK, value)
```

Indexes on `activities(person_id, start_time_utc)`, `activities(person_id, category)`,
`files(status)`, `best_efforts(kind, key, value)`.

---

## 9. API (v1, outline)

All JSON, prefix `/api`. Read endpoints accept `person`, `from`, `to`, `category`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/persons` | People with labels, colors, current thresholds. |
| PATCH | `/persons/{id}` | Label, color. |
| POST | `/persons/{id}/thresholds` | New threshold set with `valid_from`. |
| GET | `/activities` | Paged list with summary fields. |
| GET | `/activities/{id}` | Summary + laps + best efforts. |
| GET | `/activities/{id}/streams?channels=…` | Streams for charts (optionally downsampled). |
| PATCH | `/activities/{id}` | Name, category override. |
| DELETE | `/activities/{id}` | Delete activity (used for missing files). |
| GET | `/tracks` | All simplified tracks for a filter, as compact binary/GeoJSON, cacheable (ETag). |
| GET | `/stats/summary` | Totals per period and category. |
| GET | `/stats/fitness` | Daily load, CTL, ATL, TSB. |
| GET | `/stats/curves` | Power / pace / HR duration curves. |
| GET | `/import/status` | Queue progress, last run. |
| POST | `/import/scan` | Start scan + import. |
| GET | `/import/files?status=…` | Import manager list. |
| POST | `/import/files/{id}/retry` | Retry an errored file. |
| POST | `/import/files/{id}/dismiss` | Acknowledge a missing file, keep data. |
| GET | `/tiles/...` | Map tile / style / glyph proxy with disk cache. |

---

## 10. Frontend

The visual design is defined separately by the project owner. This section lists only
the views and data each one needs.

| View | Content |
|---|---|
| Dashboard | Recent activities, this week/month totals, current fitness/form. |
| Activities | Filterable list (person, category, date range, search). |
| Activity | Route map, stream charts with linked cursor (hover on chart ↔ point on map), laps, best efforts. |
| Map | All routes of selected people/categories/years as low-opacity lines (heatmap effect); click a line → activity. |
| Fitness | CTL / ATL / TSB chart, weekly load. |
| Progress | Totals by week/month/year per category; year-over-year comparison. |
| Curves | Power, pace and HR duration curves; compare periods. |
| Import | Root folder, people found, queue progress, files by status, missing-file actions. |
| Settings | People (label, color, thresholds), units, language, map style. |

Display requirements: works inside the HA Ingress panel and in an iframe; light and dark
themes; usable on phone width.

---

## 11. Map

- Base map: OpenStreetMap Foundation vector tiles (as used by Home Assistant since 2026.10),
  fetched and cached on disk by the add-on proxy. Style URL configurable so users can use
  another provider.
- Routes: one MapLibre line layer per person; opacity ~0.15–0.3 so frequent routes saturate.
- Target: 5 000 activities × ~300 points renders smoothly on a mid-range phone.

---

## 12. Add-on packaging

- Repository layout: `repository.yaml` at root, add-on in `trailbook/`.
- `config.yaml`: `arch: [aarch64, amd64]`, `ingress: true`, `panel_icon`, `stdin: true`,
  `map: [share, media, addon_config]`, `image: ghcr.io/<owner>/trailbook-{arch}`.
- Options: root folder, optional scan interval, log level.
- GitHub Actions: lint + tests, build frontend, build multi-arch images, publish on tag.
- Local development: backend and frontend run on a PC against a sample folder; no HA needed.

---

## 13. Migration to another device (export / restore)

Moving Trailbook to a new server (new HA box, different architecture, fresh install) must be
a single, documented operation.

### Export
- One ZIP archive containing:
  ```
  trailbook-export-2026-11-13.zip
  ├── manifest.json        ← Trailbook version, schema version, export date, people, file count, checksums
  ├── trailbook.db         ← consistent snapshot (SQLite online backup API, not a raw file copy)
  ├── app/                 ← add-on settings, people config, map style config, translations overrides
  └── files/               ← all FIT/ZIP files from the root folder, same structure
      ├── alice/...
      └── bob/...
  ```
- Started from Settings or `POST /api/export`; runs in the background at low priority
  (same as the importer) and streams to disk (ZIP64, no full archive in RAM).
- Written to a chosen folder inside an HA-mapped dir (e.g. `/share/trailbook-exports/`)
  and downloadable from the UI.
- Option to export without the FIT files (database + settings only) for a small archive.

### Restore
- On a fresh install: Import page → "Restore from export" (upload or pick a ZIP from a mapped folder).
- Steps: validate `manifest.json` and checksums → refuse if export comes from a newer schema
  than the running version → restore FIT files into the root folder (keeping structure) →
  restore database and settings → run schema migrations if the export is older → run a scan
  so file paths and statuses match the new disk.
- Restoring onto a non-empty install requires explicit confirmation and replaces the database.
- SQLite files and FIT files are architecture-independent, so `amd64` ↔ `aarch64` moves are fine.

### Relation to HA backups
The database lives in the add-on `/data` dir and is part of HA backups of the add-on; the FIT
folder in `/share` is only included if the HA backup includes the share folder. The Trailbook
export is the self-contained way to move everything at once.

API: `POST /api/export`, `GET /api/export/status`, `GET /api/export/{name}` (download),
`POST /api/restore`, `GET /api/restore/status`.

---

## 14. Milestones

1. **Importer core** — FIT parsing, skip non-activities, sport mapping, summary, SQLite,
   import manager (scan, statuses, duplicates, missing), CLI to run it on a PC. Tested on a
   real Garmin export.
2. **API + minimal UI** — activity list and detail with streams.
3. **Map** — all routes, heatmap effect, tile proxy.
4. **Statistics** — totals, load, CTL/ATL/TSB, best efforts and curves.
5. **Add-on** — packaging, Ingress, stdin trigger, multi-arch CI, install on HA Yellow.
6. **Export / restore** — migration ZIP (section 13), tested by moving a PC install to HA Yellow.
7. **UI design pass** — owner's design, i18n EN/PL, docs and screenshots, first public release.

---

## 15. Open questions

- UI framework (Svelte vs. plain TS) — decide at milestone 2 with the design.
- Exact OSMF vector tile/style endpoint and its usage policy for many installations.
- Units: metric only at first, or imperial from the start?
- Should HA receive sensors (weekly distance, last activity, form) — milestone 5 or later?

---

## Credits

Training-load concepts follow publicly documented models
(TSS, TRIMP, CTL/ATL/TSB).
