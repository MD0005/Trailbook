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
- Explorer tiles: visited zoom-14 tiles, max square, cluster.
- Per-activity analysis: route, charts of streams (HR, pace/speed, power, cadence,
  altitude), laps, best efforts.
- Fitness model: training load, fitness (CTL), fatigue (ATL), form (TSB); power and
  pace duration curves.
- A modern UI, shown inside Home Assistant (Ingress panel) or in an iframe.
- Near-zero CPU and small RAM footprint when idle.
- English UI first, Polish translation; more languages via translation files.

### Non-goals (for now)
- Syncing with Strava or other cloud services (Garmin Connect only through each person's
  own personal API key, see §3a).
- Sleep, HRV and other non-activity FIT data (skipped on import for now; the files are
  archived, so the Wellbeing stage can read them later). Daily monitoring files are read
  only for the Calendar's steps, floors and stress (`daily_parts`, see docs/MANUAL.md); the
  Garmin API daily summary wins over them. Scale files (FIT type weight, e.g. Garmin Index) are
  read for Wellbeing › Body (`body_parts`: weight, fat %, water %, muscle and bone kg, BMI per
  weigh-in; files skipped before are read by `importer.backfill_body` on the next import run);
  Garmin Connect's weigh-ins come in too (§3a).
- Editing activities beyond category, name and deletion.

---

## 2. Target platform

| Item | Decision |
|---|---|
| Architectures | `aarch64` (HA Yellow, Raspberry Pi 4/5) and `amd64`. Both images built in CI. |
| Base image | HA `base-python` (Alpine). Possible because every dependency is pure Python; a native dependency would need musl wheels or a move to a Debian base. |
| Rule for dependencies | Every dependency must ship prebuilt `aarch64` wheels or be pure Python. Nothing is compiled on the device. |
| Excluded | pandas, pyarrow, vegafusion, GDAL and other heavy native stacks. |
| Distribution | Public GitHub repository usable as an HA add-on repository; images published to GHCR (`trailbook-{arch}` for HA, multi-arch `trailbook` for plain Docker); a Windows installer on each GitHub release (§12). |

---

## 3. Architecture

```
HA automation / user ──► /share/trailbook/<person>/*.fit
                                   │
         trigger (stdin / API / button / optional interval)
                                   ▼
┌──────────────────────── add-on container ────────────────────────┐
│  API server (Starlette + uvicorn, 1 worker)                         │
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
| Backend | Python 3.12, Starlette, uvicorn (h11) | Pure Python, small: ~45 MB idle RSS measured for the API process (FastAPI/pydantic dropped to save memory). |
| Database | SQLite via stdlib `sqlite3`, WAL mode, hand-written migrations | No server process, single file, part of HA backups. |
| FIT parsing | Garmin FIT SDK for Python (`garmin-fit-sdk`) | Official, pure Python, knows all sports and fields. |
| Frontend | TypeScript + Vite, static build | Architecture-independent; served by the add-on. UI framework decided when UI design starts (Svelte is the default candidate). |
| Map | MapLibre GL JS, vector tiles | WebGL handles 1M+ line vertices. |
| Charts | ECharts (uPlot for dense time series if needed) | Fully stylable, modern look. |
| i18n | JSON translation files, `en` default, `pl` second | Contributors can add languages without code changes. |

---

## 3a. Data connection

Settings › Data sources › *Data connection* chooses where new activities come from (setting
`data_source`); only the options of the chosen source are shown below it. Garmin Connect is
the recommended source and the UI says so: it gives the most complete data — the same
original FIT files as an export or a folder, plus the values only the Garmin Connect API has
(see [`GARMIN-DATA.md`](GARMIN-DATA.md)). Goal: import the full set of activity data and,
with the Wellbeing stage, the full set of lifestyle data (steps, sleep, stress, HRV, weight, …).

1. **Garmin Connect** — each person connects their own account with a Garmin *personal API
   key* (self-service in Garmin Connect, expires after 30/90/180/365 days). Module `garmin.py`
   (stdlib `urllib` only):
   - `POST personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token`
     with `Authorization: ApiKey <key>` → access token (24 h, no refresh tokens; JSON or plain
     text accepted), stored in `garmin_accounts` and reused until it expires; then
     `Authorization: Bearer <token>`.
   - `GET /activitylist-service/activities/search/activities?start&limit&sortOrder=desc&startDate`
     (newest first, 50 per page) and `GET /download-service/files/activity/{id}` (original
     file, a ZIP with the FIT).
   - Runs inside the normal low-priority import process (phase `garmin` before the queue),
     on the same schedule as folder scans (`scan_interval_min`) or with *Download now*.
   - Slow on purpose: one request every 3 s, at most 60 downloads per run. A run first fetches
     new activities (until it meets known ones), then continues the history from a stored
     offset (`backfill_offset`, re-reading 10 rows) until the end (`backfill_done`).
   - 429 / 5xx / network errors stop the whole run (retried next run); 401/403 on the token
     marks the account `auth_error`; a single failing download is recorded
     (`garmin_activities.status = error`) and not retried.
   - **Refused key** (expired, deleted, wrong): `auth_error_since` keeps the first refusal,
     `auth_checked_at` the last try. Scheduled runs try it again every 3 h with one token
     request only (never a key that is empty, e.g. after restoring an export without keys); an
     accepted token, a successful run or a new key clears both. After **12 h** every page shows
     a yellow banner under the header (`GET /garmin/alerts`, `garmin.key_alerts`) with a link to
     Settings. After **24 h** the add-on creates a Home Assistant persistent notification
     (`homeassistant.py`, Supervisor API, `homeassistant_api: true`; id
     `trailbook_garmin_key_<person>`), once per refusal, and dismisses it when the key works
     again or the account is removed. The open ones are kept in the setting `garmin_ha_notified`
     (not exported). The scheduler wakes for a due notification even with automatic runs off.
     Outside Home Assistant there is no notification.
   - Downloads are saved as `uploads/<person>/garmin-<id>.zip` and queued like uploads, so
     the FIT id dedup applies (activities already imported from a folder become `duplicate`).
     `garmin_activities` remembers every downloaded id → nothing is downloaded twice.
   - Optional *Download from* date per person limits the history.
   - The Garmin card says up front that downloading is slow on purpose and estimates the
     history time (`GET /garmin` → `estimate`, `garmin.history_estimate`): the pace is measured
     from what was downloaded (once it covers ≥ 30 days and ≥ 10 activities), otherwise assumed
     as 5 years with an activity every 3 days (≈ 608 activities); the history ends at
     *Download from* or 5 years back. Runs = remaining ÷ 60 (shared by all people), time = runs
     × (~3 min per run) + the interval between runs. With the default 1 hour: a typical
     history ≈ 11 runs ≈ 11 h. Each person row shows the activities left; *Automatic download*
     shows the total left or "history complete".
   - What starts a download: the automatic run every `scan_interval_min` (default 1 h,
     counted from the end of the last run; 0 = off), *Download now*, and later the HA stdin
     trigger of the add-on. After the history is complete each run only reads the first page of
     the activity list until it meets known activities (1–2 requests when nothing is new).
   - The key is stored in the database (never returned by the API, only `…last4`).
   - Daily summaries (`GET /usersummary-service/v2/dailysummaries?startDate&endDate`, verified
     with the personal key): one JSON per day (steps, floors, stress, resting HR, Body Battery,
     calories, intensity minutes…) kept in `garmin_days` (person, day; a day asked for again
     replaces its row). Each run asks for the last 3 days again (today is still counting) and
     for every day since the previous run's newest day (`days_to`: no gap after the server was
     off), then fills the history backwards, 31 days a request and 4 requests a run, down to
     *Download from* or the first activity, else a year (`days_from`; an earlier date later
     continues it, `days_done`). A key without access to the service skips it quietly. Used by the Calendar today; the Wellbeing tab will read it too.
   - Weigh-ins (`/weight-service/weight/range/{start}/{end}?includeAll=true`): every run the
     last 7 days and any days since the previous run (`weights_to`), then the history backwards
     180 days a request, two a run (`weights_from`), down to the same start as the daily
     summaries; stored in `garmin_weights` (kg, the composition NULL when not measured). Body
     merges them with the scale files' weigh-ins: the same minute counts once, the file's values
     first.
   - Later: sleep, HRV for the Wellbeing tab. Stored with
     the key person + day (+ metric), written as upserts, so a day fetched again (or the same
     day from another source, e.g. sleep FIT files from a folder) replaces the row instead of
     adding one. Priority when two sources disagree: Garmin API values (Garmin's own
     processed result) over values computed from raw FIT files.
     Everything Garmin offers (activities and lifestyle, FIT vs API) is listed in
     [`GARMIN-DATA.md`](GARMIN-DATA.md).
2. **Upload a ZIP** — one-time import of a Garmin export / ZIP of FIT files / single .fit for a
   chosen person (`POST /api/uploads`). Uploads are kept in `uploads/` next to the database,
   tracked as `@uploads/<person>/<file>` and never touched by folder scans.
3. **Watch a folder** — watched folder, assigning files to people (with the watch table when
   "assign by watch" is chosen), automatic folder scan. Scheduled runs happen in folder and
   Garmin mode (never for uploads).

**Other sources: Intervals.icu** (Settings › Data sources, a card under the Strava one; `icufiles.py`,
`/api/icu-files`; the card says *Testing phase — not working yet*): for each person with an intervals.icu key (Settings › Workouts API) a *Check:
On/Off* badge (stored per person, `icu_accounts.files_on`, default Off). When on, the activity
list of today and the 2 days before is asked for (one request, no files) at 12:00–17:30 every
30 min and 18:00–23:00 every 15 min (local time), and once when switched on. Activities from
Garmin Connect or Strava (`source`) are never fetched. Any other is fetched once
(`/activity/{id}/file`) and kept only when its FIT `file_id` manufacturer is `virtualtraining`;
its recording device (manufacturer, product, serial in `file_id` and the creator's
`device_info`, product name emptied) becomes the Tacx training app (Android), same size, CRC
recomputed, nothing else changes. The file is **not imported**: it waits in
`icu-files/<person>/` as a *Download · <date> <name>* badge until it is downloaded (several can
wait). After the download the file is deleted and the activity is removed from intervals.icu
(retried at the next check when not reachable); the person puts the file into Garmin Connect,
and it comes back the normal way. `icu_files` keeps every activity looked at, so none is
fetched twice.

**Other sources: Strava** (Settings › Data sources, a card shown whatever the data connection is): one-time
imports of history kept elsewhere, uploaded for a chosen person through the same
`POST /api/uploads`, one file after another (several files can be picked; the running import
picks up files that arrive meanwhile). Files over 8 MB go in 8 MB parts (`POST /api/uploads/part?part=<id>&offset=<n>`,
appended in `upload-parts/` next to the database; unfinished ones dropped after a day), then
`POST /api/uploads?...&part=<id>` takes the joined file: Home Assistant's Ingress refuses big
requests (413). Today: **Strava** — the bulk export ZIP or single
files. Formats read everywhere (folder, ZIPs, uploads): `.fit`, `.gpx`, `.tcx`, each also
gzipped (`.gz`); the content decides the parser (`trackfile.kind`), not the name.
- GPX/TCX (`trackfile.py`): time, position, altitude, distance (TCX; summed from positions in
  GPX), heart rate, cadence (doubled on foot like FIT), power, temperature, speed (TCX; else
  over a 5 s window); TCX laps, calories and totals; title (GPX `name`, TCX `Notes`), sport
  (GPX `type`, TCX `Sport`). Ascent/descent from altitude with a 3 m dead band.
- Strava ZIP (`strava.py`): `activities.csv` gives each file its title, description
  (`activities.description`) and — for GPX/TCX without a sport — the Strava type; totals the
  file lacks (calories, power) are taken from it. Activities entered by hand on Strava have
  only a CSV row: imported as activities without a route (file row `activities.csv#<id>`,
  id `strava:<id>`). Photos and other files in the ZIP are ignored. Optional **From / To**
  dates on the card (`from`, `to` on `POST /api/uploads`, both included): only the ZIP's
  activities whose date in `activities.csv` is in the range are queued (files without a CSV
  row are kept) — e.g. only the years before Garmin. The stored ZIP is then cut down to the
  queued files and `activities.csv` (photos and the activities left out are deleted); with
  nothing to import the upload is deleted. After each import run (`importer.prune_uploads`)
  the person's own uploads lose their duplicates (copies of activities already there), files
  and rows; skipped files and errors stay (a later version may read them); a ZIP keeps the rest
  and its activities.csv, an upload with nothing left is deleted. Strava's TCX files start with
  spaces before `<?xml`: white space and a BOM are dropped before parsing. Garmin downloads and watched-folder
  copies are never touched. Exports in another language (same columns, headers
  translated) are read by column place; Polish month names and activity types are translated.
- No time zone in GPX/TCX/CSV: estimated (see `MANUAL.md` › Imported files without a time zone).
- Duplicates: see 5.3.

**One archive for every source** (unified on the Garmin API model): every file Trailbook
reads is kept in `uploads/` next to the database. Garmin downloads and uploads are saved there
directly; files of the watched folder are copied there after the scan (phase `archive` of the
import process, `uploads/_folder/<path in the folder>`, mtime kept, written as `.part` and
renamed) — activities and also sleep, monitoring and other files skipped today. So every file
can be read again by a later importer version (more fields, wellness), even after it was
deleted from the folder or the folder was changed. `files.source_rel` is the path in the
watched folder, `files.rel_path` where the bytes are read (`@uploads/_folder/…` once archived).
A changed folder file is copied again. Cost: folder files take disk space twice (the folder
may be cleaned up at any time). Existing installs archive their folder files on the next run,
also when the data source is no longer the folder (as long as the folder exists).

## 4. Folders and people

The watched folder is configurable in Settings (absolute path; in the add-on it must lie
inside the folders shared with it, enforced via `TRAILBOOK_ALLOWED_ROOTS`).

FIT files carry **no Garmin account id** (`user_profile.friendly_name` is empty), but every
file — activities, sleep, monitoring — carries the **serial number of the watch**. Two
person modes (setting `person_mode`):

- **folders** (default): one subfolder per person, layout below. Watches are linked to the
  folder's person automatically.
- **devices**: one shared folder (any layout). Each file goes to the person linked to its
  watch; files of unknown watches go to *Unassigned* until the user links the watch on the
  People page, which moves its files and activities.

**Rule: settings apply to files imported from now on.** Switching the person mode or
re-linking a watch never moves activities that already have a person, and nothing is
imported twice (each activity is recognised by its FIT id = watch serial + creation time).
The one exception: activities still *Unassigned* (they never had a person) move to the
person a watch is linked to — so a first scan in shared-folder mode with several unlinked
watches simply waits in *Unassigned* until the watches are linked.

In folder mode, files lying directly in the watched folder (not in a person's subfolder) are
assigned by their watch. Two people sharing one watch need folder mode.

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
4. **Automatic scan** every N minutes (setting `scan_interval_min`, default 60, 0 = off),
   counted from the end of the last run — a failed run counts too, so a run that fails is
   not restarted in a loop. One sleeping asyncio task in the API process; no
   CPU while waiting. The Import page shows the next scheduled scan and a *Scan folder now*
   button.

The very first import is started by the user from the Import page after choosing the root folder.

### 5.2 Scan (cheap)
- Walk folders with `os.scandir`; read only `stat` (size, mtime).
- Compare with the `files` table:
  - unknown path → `new`;
  - known path, same size and mtime → unchanged, nothing to do;
  - known path, changed size or mtime → re-hash, re-check;
  - path in DB but not on disk → `missing` (data kept) — only for files not archived yet;
    an archived file deleted from the folder needs nothing.
  - missing path that appears again → back to its previous status.
- A scan of several thousand files must take well under a few seconds on a CM4.
  Measured on a PC: 5 000 files 0.25 s, 20 000 files 1 s (first and repeated scan).
- Unchanged files cause no database writes, so frequent scans do not wear the eMMC/SD card.

### 5.3 Identity and duplicates
Three keys, from cheap to strong:
1. `rel_path + size + mtime` — fast change detection.
2. `sha256` of the file — the same file under a different name.
3. FIT `file_id` (`serial_number` + `time_created`, fallback: first `record` timestamp + sport)
   — the same activity exported twice. Second occurrence → `duplicate`.
4. GPX/TCX and manual Strava activities have no watch id (`gpx:<start>:<points>`,
   `tcx:…`, `strava:<id>`): one that starts within 120 s of an activity the person already
   has is a `duplicate` of it (a Strava copy of a watch activity imported from Garmin).
5. The FIT recording always wins, whatever arrives first: a FIT file that starts within
   120 s of such a copy of the same person replaces it in place (same activity id, so the
   user's changes stay; the copy's files become `duplicate`). The copy's title and
   description stay unless the FIT brings its own. A Strava file that is a `duplicate` still
   gives the activity its `activities.csv` title and description.

### 5.4 Statuses (`files.status`)
| Status | Meaning |
|---|---|
| `new` | Detected, waiting in queue. |
| `imported` | Parsed, activity stored. |
| `skipped` | Not an activity (sleep, monitoring, settings, …). Reason stored. |
| `duplicate` | Activity already exists from another file. |
| `error` | Could not be parsed. Error message stored; can be retried. |
| `missing` | File gone from disk before it was archived. **Activity data stays** until the user deletes it. |
| `removed` | The user deleted the activity. The file is not imported again by later scans. |

For every processed file the manager stores the FIT `file_id` (`fit_uid` = device serial +
creation time, file type, creation time) and the processing time, also for skipped files.

### 5.5 Missing files and user actions
Missing files are only flagged. The Import page lists them with two actions:
"keep data" (dismiss) and "delete activity". Nothing is removed automatically.

**Remove from history** (any file): deletes the file's row from the import history, so the
next scan treats the file as new and processes it again. If the file created an activity,
that activity is deleted too and rebuilt on re-import (manual type changes are lost); files
that were duplicates of it are queued again.

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

**Activity name**, first that exists: the name the user set (`name_overridden`, never
replaced) → the title in a GPX/TCX file or Strava's `activities.csv` → the Garmin Connect
title (`activityName`, kept in `garmin_activities`). `activities.name_source` says where it
came from (`file` / `garmin`). FIT files carry no title, so an activity from a folder or
upload has no name and the UI shows its type until Garmin delivers or matches the same
activity. Clearing the name falls back to the Garmin Connect title.

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
FIT sport known to the SDK has a type. Each activity also has an `indoor` flag (a type the person picks sets it from that type).
A ride or run without a sub-sport recorded by a virtual training app (the file creator's maker
is Zwift, Tacx, Rouvy, Bkool, TrainerRoad…) is virtual: files edited by tools often lose the
sub-sport.
Users can change the type of an activity (the group follows); the override survives
reprocessing. When the importer version increases, `trailbook reprocess` rebuilds older
activities from files still on disk.

### 7.2 Thresholds per person (with `valid_from`)
`hr_max`, `hr_rest`, `lthr` (lactate threshold HR), `ftp` (W), `threshold_pace` (s/km),
`swim_css` (s/100 m), `weight` (kg). All optional.

Each field, in this order:
1. **Own value** — set with the pencil in the People table (Settings › People), as rows with
   a *valid from* date; each field comes from the latest row that sets it, so older
   activities keep older values. An own value replaces the watch value.
2. **Watch** — what the watch had set when the activity was recorded, read from each
   activity FIT file: HR max, threshold HR, FTP (`zones_target`), resting HR, weight
   (`user_profile`), with the session's `time_in_zone` as a fallback; 0 / out-of-range
   values are ignored. Stored per activity (`activities.watch_*`); an activity uses its own
   values, otherwise those of the person's nearest activity (latest before, else first
   after). **FTP is per sport**: a run file carries the running-power FTP (~1.6× the cycling
   one on a Garmin), so rides borrow FTP only from rides and runs only from runs; other
   groups take none from the watch, and Settings shows the cycling one. An activity whose
   file has no FTP or a wrong one (e.g. Rouvy with a substituted device) can get its own in
   its Edit panel (`activities.ftp_override`, kept on reimport; empty = automatic); load and
   workout kind are recomputed. Activities imported before this are read once more in the
   `thresholds` phase (`watch_version`). Garmin API values (lactate threshold pace, FTP
   history) may follow.
3. **Estimate** — HR max = highest plausible max HR recorded (100–230 bpm), resting HR
   = 60 bpm, threshold HR = 90 % of HR max.

An activity whose load used an estimated or default value is flagged
(`activities.load_estimated`). Estimates are normal (threshold HR = 90 % of the watch HR max
is no warning), so the Fitness page warns only about what can really distort the load of
the period's activities — one ⚠ icon after the page title, a short list on click, link to
Settings › People:
- a value the load method needs has no basis in the person's data: resting HR default, or
  HR max from the highest recorded HR (no watch value, none set);
- a year whose activities borrow a watch value more than a year away (no watch data that
  year).
In the editor, a field with such an estimate has *Use estimate*: accepting it stops the
warning for that field (stored per person in settings, `accepted_estimates:<person>`;
clicking again turns the warning back on). Saving or deleting an own value recomputes the
load of that person's activities in the background. The People table shows the values in
use (estimated ones marked); the pencil opens an editor under the row with the value in
use, its source (Watch / Set / Estimated) and the watch value per field.

### 7.3 Training load
Computed after import by `analysis.py` from the stored streams (phase `analysis` of the
importer process; `activities.analysis_version` marks what is done, 0 = to do — set on
(re)import, type change and threshold change). Chosen per activity, first available:
1. Power: weighted power (4th-power mean of the 30 s rolling power) + FTP,
   load = h × intensity² × 100 with intensity = weighted power / FTP.
2. Running pace: runs with threshold pace, intensity = avg speed / threshold speed.
3. Heart rate: Banister TRIMP per second (HRr × 0.64 e^(1.92 HRr)), scaled so that one hour
   at threshold HR = 100; average HR × the timer time when there is no HR stream.
4. None (activity counts in totals but not in load).
The method used is stored with the value (`load`, `load_method`).

### 7.4 Fitness model
Daily load per person (by the activity's local day) → CTL (42-day exponential average),
ATL (7-day), TSB = CTL − ATL (yesterday's values). Computed on request (`GET /api/fitness`,
a few ms for ten years), so it can never be stale; the `daily_load` table stays unused.
Form zones: > 25 transition, 5…25 fresh, −10…5 grey zone, −30…−10 optimal, < −30 high risk.

### 7.5 Best efforts
- Power: 5 s, 15 s, 30 s, 1 min, 5 min, 10 min, 20 min, 60 min (any activity with power;
  Statistics filters cycling / running).
- Pace (running group): 400 m, 1 km, 1 mile, 5 km, 10 km, half marathon, marathon —
  fastest time within any run from the distance stream (interpolated), not only races.
- HR: max average over 1, 5, 20, 60 min.
- Longest (runs and rides, each on its own: same category): the activity's distance. Not
  stored — added to the stored efforts in the queries (`api.EFFORTS_SQL`, kind `longest`, key
  0, higher is better), so it gets records, YTD and the previous best like the others. Shown
  on the activity page after the distances as **Distance** (tooltip: longest distance in one
  activity), the distance in each column; hovering highlights the whole activity.
- Top speed (rides, kind `speed`, key 60, m/s): the best mean speed over 1 min from the
  distance stream, only over seconds the data can be trusted (`analysis.top_speed_at`): samples
  at most 5 s apart, at most 80 km/h, the speed changing by at most 3 m/s per second (more is
  a jump of the position, not riding), agreeing with the device's own speed (Doppler or a
  sensor) within 1,5 m/s or 15 %, 5 s around a doubtful second dropped too, and the window's
  distance agreeing with the track's length within 10 %. Shown as **Speed1m** after Distance.
- Distance within a time (kind `within`, key = s, value = m, higher is better): the longest
  distance covered in 12 min on runs (the Cooper test) and in 1 h on rides (the hour), two
  pointers over the distance stream with the end interpolated (`analysis.best_distance_in_at`).
  Best efforts only (no curve). Activity page: **Cooper** / **Hour** after Distance.
- Elevation gain (kind `ascent`, key 0): the activity's whole elevation gain, added in the
  queries like `longest`. Activity page: **Ascent** after Distance; Records: Max elevation gain.
- Biggest climb (kind `climb`, key 0, m) and steepest 1 km (kind `grade`, key 1000, % average
  grade), runs and rides; the biggest climb in Records only, the steepest 1 km also on the activity page (**Steepest**, after Ascent). The altitude is cleaned first (`analysis.clean_altitude`:
  a change faster than 4 m/s between samples is a jump and is taken out). A climb runs from a low
  point to its top; dips on the way allowed while each is at most 25 % as long as the rise before
  it and loses at most a third of the height gained (as the climbs on the altitude chart), at
  least 20 m. The steepest 1 km (the measure climb databases use, e.g. CyclingCols) counts only
  when the height was gained at most 1,5 m/s, the grade is at most 40 % and no 50 m of it is
  steeper than 30 % (a distance jump, or the altitude drifting while hardly moving).
- **Indoor rides are records of their own** (virtual rides, trainer): their distances, times
  over a distance, longest distance, distance in 1 h, top speed, elevation gain, biggest climb
  and steepest 1 km are ranked apart (`v = 1` in
  `records.EFFORTS_SQL`, a trainer's speed is no road speed); their power counts with every
  ride.
Streams are resampled to 1 s; gaps > 10 s break a window. Stored in `best_efforts`; shown on
the activity page and in Statistics › Records. On the activity page each effort is compared
with the person's best **in the same category** (running power is no record for a ride; indoor
and outdoor rides apart as above), and the power curve tooltip shows the date that best was
set. The middle column is the best of the activity's **whole year**: YTD for this year, the
year's number (e.g. 2025) for an older activity (all activities of that year count, also the
later ones).

### 7.6 Training type
In the UI "training type" (Edit row, activity tile, Help tab); `workout` in the code and
the database.
Three groups of sports (`workout.PROFILES`; the thresholds in `workout.RULES` — the code and
Help › Training types read the same values, served in `/api/types`):
- **Endurance sports** get one of **Easy · Long · Tempo · Intervals · Hills · Race · Commute**,
  detected: running, cycling (not downhill / BMX), cross-country skiing (also skitour, ski
  erg), skating (inline, ice), rowing (also the erg), paddling (kayak, canoe, SUP), swimming,
  cardio machines (elliptical, stair stepper). Each family has its share of the threshold HR
  (rides, skating, rowing, machines 95 %, paddling 93 %, swimming 92 %), its shortest Long
  (run 75, ride 150, ski 120, skate 90, row 75, paddle 120, swim 60, machines 75 min), Hills
  only where terrain counts (run, ride, ski) and Commute only for rides and skates. Walks and
  hikes (also snowshoe) are always Commute.
- **Team and racket sports** get **Match · Training · Recreation**, from the heart rate over the
  whole game (pauses included — a game is all stop-and-go): Match when 45 %+ of it is at 85 %+
  of threshold HR, Recreation when the average is under 70 %, else Training; none without HR.
- **Everything else** (strength, yoga, climbing, motor, multisport…) — no kind.
Detected after import (`workout.py`, `activities.workout`, the reason and interval bouts in
`workout_detail`); the person can pick another kind of the sport in the activity's Edit panel
(`workout_override`, kept on reimport, "Automatic" goes back). Shown in the activity header
after the place; statistics per kind and calendar charts come later. Interval workouts get
section lines on the activity charts (`GET /api/activities/{id}/intervals`, computed on request;
CHARTS.md › Activity page, MANUAL › Interval sections). Lines the person moves on Intervals or
Hills are saved per activity (`activities.section_lines`, schema v22: `{"kind", "splits": [s]}`,
`PATCH /api/activities/{id}` with `section_lines`, null = back to the detected ones; kept on
reimport, dropped when the training type no longer matches the kind). Interval channel per
sport: power (bike, running, erg), speed (runs without power — grade-adjusted on hilly runs —,
skating, paddling, skiing), pool swims: speed from the laps (rests at the wall; the HR drop is
not checked, wrist HR under water is unreliable), estimated power (rides without a power meter),
heart rate alone (machines). Everything is relative to the person — HR as a share of the sport's threshold HR,
power as a share of FTP, "typical" = median of their own activities of the group (in-motion
power, speed, estimated power, time; per-activity medians in `workout_stats`). FTP as
in §7.2 (per sport, correctable per activity). First rule that fits:
1. **Commute** — walks and hikes always; rides that are easy (little time at 90 %+ threshold
   HR, intensity < 0.7) and under 45 min or from A to B (end > 1 km from start).
2. **Intervals** — at least 3 work bouts (or 2 of 5+ min), each cycle bout / recovery / bout
   clearly above its recovery (power ×1.25, running power or speed ×1.2), work at least 8 %
   above the person's typical (else it is the normal pace with stops), heart rate falling in
   the recoveries by 10 %+ of threshold HR (in a race with surges it stays up), bouts alike
   (length within ×3, intensity CV ≤ 15 %), 3+ min of work (5+ on a bike; bike bouts under
   60 s only above 120 % FTP — starts after a stop are not intervals). Bouts up a hill or
   clearly steeper than the recoveries around them do not count. Channel: power (running
   power too) → speed (grade-adjusted on hilly runs, Minetti) → power estimated from speed and
   grade (rides without a power meter; heart rate must rise through each bout, recoveries
   ridden, stricter ratios) → heart rate alone (bouts of 3+ min only).
3. **Hills** — the same climb repeated 3+ times (bouts start within 60 m), or a hilly
   activity: run 25+ m/km (200+ m), ride 15+ m/km (500+ m).
4. **Race** — 60 %+ of the time at 95 %+ threshold HR in every sport (rides with power: and
   intensity ≥ 0.9; no heart rate, no race), at least 95 % of
   the person's best intensity for a similar duration (±25 %, ±365 days) and 3 %+ above
   typical, few stops.
5. **Long** — time ≥ 1.5× the person's median, at least 75 min (run) / 150 min (ride).
6. **Tempo** — 40 %+ of the time at 90 %+ threshold HR with a 12+ min block (dips ≤ 60 s),
   or 50 %+ of the time there in any stretches (a steady ride whose HR hovers at the line,
   broken by junctions), or (rides with power) half the time at 80 %+ FTP with a 15+ min block.
7. **Easy** — the rest.
Re-detected when the version changes, the type is changed, the activity is reimported or the
person's thresholds change.

---

## 8. Database schema (v1, outline)

```
schema_version(version)

persons(id TEXT PK /* folder name */, label, color, created_at, archived)
person_thresholds(person_id, valid_from DATE, hr_max, hr_rest, lthr, ftp,
                  threshold_pace, swim_css, weight)

files(id PK, person_id, rel_path /* read from */, source_rel /* path in folder */,
      zip_member, size, mtime, sha256,
      status, skip_reason, error, activity_id,
      first_seen, last_seen, missing_since, imported_at)

activities(id PK, person_id, fit_uid UNIQUE, start_time_utc, utc_offset_s,
           sport, sub_sport, category, indoor, category_overridden,
           name, device,
           elapsed_s, time_s (= timer), distance_m, ascent_m, descent_m,
           avg_hr, max_hr, avg_speed, max_speed,
           avg_power, max_power, np_power, avg_cadence, calories,
           load, load_method, has_gps,
           start_lat, start_lon, bbox_min_lat, bbox_min_lon, bbox_max_lat, bbox_max_lon,
           importer_version, created_at)

tracks(activity_id PK, polyline, point_count)
streams(activity_id, channel, encoding, data BLOB, PK(activity_id, channel))
laps(activity_id, idx, start_offset_s, elapsed_s, timer_s, distance_m,
     avg_hr, max_hr, avg_speed, avg_power, avg_cadence, ascent_m,
     target /* hr|power|speed|cadence: workout step target */, target_low, target_high)
best_efforts(activity_id, kind /* power|pace|ride|hr */, key /* seconds or metres */, value,
             start_s, end_s /* where: seconds from the start */)
daily_load(person_id, date, load, ctl, atl, tsb, PK(person_id, date))
import_runs(id, started_at, finished_at, trigger, scanned, new, imported,
            skipped, duplicates, errors, missing)
settings(key PK, value)
segments(id PK, name, category /* NULL = any */, polyline, point_count, distance_m, ascent_m,
         start_lat, start_lon, end_lat, end_lon, bbox_*, source, source_activity_id,
         match_version, created_at)
segment_efforts(id PK, segment_id, activity_id, start_time_utc, start_s, end_s, elapsed_s,
                avg_speed, avg_hr, max_hr, avg_power, avg_cadence)
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
| PATCH | `/activities/{id}` | Name, type, training type, FTP, section lines; `fix` (`altitude` / `speed`: fixes.py, the streams are rewritten); `excluded` (true / false). |
| GET | `/activities/{id}/export?format=fit\|gpx` | Activity › Export: FIT = the whole activity (the own FIT file; one written from the stored data when the activity was corrected or came as GPX/TCX/Strava); GPX = the route only (positions and altitude, no times or heart rate). |
| DELETE | `/activities/{id}` | Delete activity (used for missing files). |
| GET | `/tracks` | All simplified tracks for a filter, as compact binary/GeoJSON, cacheable (ETag). |
| GET | `/fitness?person&from&to` | Daily load, CTL, ATL, TSB, ramp rate (CTL change in 7 days); methods; thresholds in use; threshold warnings of the period. |
| GET | `/calendar?from&to&person&chart` | Activities by local day (`chart=1`: with the small chart of each), and for one person the day's steps, floors, ascent and average stress. |
| GET | `/forecast?person` | 16-day forecast (Open-Meteo, cached 3 h) and the latitude for the day length, at the start of the person's latest activity with a route. |
| GET | `/stats/totals?person&by&type&year` | Totals per year / month / week and per group. |
| GET | `/stats/records?person&from&to&last&years` | Records per sport and best effort, and per segment: 3 best of all time, the best in the Time filter. |
| GET/PUT | `/thresholds/{person}` | Threshold rows, values in use (set / auto / default). |
| DELETE | `/thresholds/{person}/{valid_from}` | Delete a threshold row. |
| PUT | `/thresholds/{person}/accept` | Accept (or not) the estimate of HR max / resting HR: `{field, accepted}`. |
| GET | `/segments?person` | Segments with effort count, best and last effort (for a person or everyone). |
| POST | `/segments` | Create from an activity slice (`activity_id`, `start_s`, `end_s`, `name`, `any_type`). |
| POST | `/segments/snap` | Pins → slice of the best matching own activity (preview, nothing stored). |
| GET/PATCH/DELETE | `/segments/{id}` | Detail with stats, top 10, trend, per person / rename / delete. |
| GET | `/segments/{id}/efforts?person&offset` | All efforts, fastest first. |
| GET | `/import/status` | Queue progress, last run. |
| POST | `/import/scan` | Start scan + import. |
| GET | `/garmin` | Garmin account state per person (key hint, status, counts; never the key). |
| PUT | `/garmin/{person}` | Save a key and/or *Download from* date, then test it. |
| POST | `/garmin/{person}/test` | Get a token and read the newest activity. |
| DELETE | `/garmin/{person}` | Disconnect (delete the key; imported activities stay). |
| GET | `/garmin/alerts` | Keys refused for 12 h or more (person, label, since): the banner. |
| GET | `/import/files?status=…` | Import manager list. |
| GET | `/backup` | Running job, export / restore progress, exports list (with manifest summary), exports folder, whether the install is empty, default folder for restored files. |
| POST | `/export` | Start an export (`files`, `secrets`). |
| GET/DELETE | `/export/{name}` | Download / delete an export. |
| POST | `/restore?name|confirm&root` | Restore an export from the exports folder (`name`) or from the request body (upload); `confirm=1` needed when the install has data. |
| POST | `/import/files/{id}/retry` | Retry an errored file. |
| POST | `/import/files/{id}/dismiss` | Acknowledge a missing file, keep data. |
| GET | `/tiles/...` | Map tile / style / glyph proxy with disk cache. |
| GET | `/ha/records` | What the add-on pushes as `sensor.trailbook_records` (§12a). |
| GET | `/ha/setup` | Add-on or not, what the last install of the dashboard card did, the card's resource URL (§12b). |
| GET/POST | `/ha/cards` | Dashboard cards / make one (`name`, `kind`, `config`; the id comes from the name). |
| GET/PUT/DELETE | `/ha/cards/{id}` | One card / change its name, kind or config (the id stays) / delete it. |

---

## 10. Frontend

The visual design is defined by the project owner; the technical preview follows these rules.

### UI rules (apply everywhere)
- **One button style: the badge** (`button.badge`) — every button (Reset, Delete activity as
  `badge danger`, Create segment, Summary, Options). A button with nothing to do is hidden.
- **One control style.** Choices in a page or card header are badges like the Map filters
  ("Colour: None", "Markers: Every 1 km", "Group: 1 lap"), with a panel of radio items
  (`pickList`) — metric choices show their icon. Option/edit panels look like Map › Options
  (`opt-panel` rows). Badge labels are text only; buttons inside panels are plain text buttons
  (`button.small`, `.danger`), no decorative icons. No plain `<select>` in headers.
- **Maps**: zoom buttons bottom right; distance scale bottom left on every map (a plain line
  with a label, no box); the small attribution bottom right under the buttons; a full-screen
  button top right (maps that are not already full screen); the colour legend of the activity route stays top left on a
  semi-transparent block.
- **One level below a tab** (an activity, a segment, the segment creator): a square back button
  with a left arrow, separate from the page header but framed like it and sticky with it, in
  the left margin. When the screen is too narrow for the margin it folds above the header as
  the text link "← Activities", scrolling away as before. Use `backLink(href, label)`.
  The activity page has **‹ Next · Previous ›** (newer left, older right, like the newest-first
  list) at the right end of its header, in the style
  of the view switch (Tiles / List): the previous / next activity of the same person (of
  everyone in the All view); a missing one is left out. Use `prevNextHtml(prev, next)`.
  They stay within the filters set on the Activities list, and the arrow keys press them
  (← Next, → Previous; not while typing). The list's filters and sort are kept for the tab:
  coming back (back button, tab link) restores them; another tab or a reload forgets them.
- **List tables** (`tableHtml`: activities, files; also laps): each column as wide as its content; the
  spare width becomes equal visible gaps between neighbouring columns' contents (text is
  left-aligned, numbers right-aligned, so each gap goes to the free side; number → text gets
  left padding). The gap after the first column stays small (`gapPlan`, `spreadColumns`,
  redone on resize and when rows load). Segment effort tables
  (segment page, segment cards on an activity) follow the same rule (`fitEffortCols`); tables
  with the same columns share one set of widths, so tables one under another line up.
- **Charts** follow `docs/CHARTS.md`. Distance is always shown with two decimals.
- **Numbers**: decimal comma and a space between thousands (`1 234,56`) everywhere (`num()`).
- **Waiting**: one loader everywhere (`loaderHtml()`): a road bike in the accent colour and its
  rider in a darker shade of it (leaning to the bar, hands on it) riding along a dashed road
  (wheels turning, the legs pedalling round the crank — knee from thigh and shin length, the far
  leg faint —, the road passing under, a slight bob; still with reduced motion except the legs)
  over a small "Loading…". At the end of lists that load more on scroll (activities, segments,
  efforts…) and, on the page background (no card) in the middle, in place of the page when a
  page or a tab takes over 0,4 s to load (only while the old page is still shown).
- **Durations**: no space between a number and its unit, two digits after the first unit —
  `1h 05min`, `45min 07s` (`dur()`).
- **Defaults vs user settings.** Two kinds, decided per setting with the owner:
  - *Fixed every visit* — reset whenever the tab is entered (`TAB` state in `preview.js`):
    first view of a tab (Activities → Tiles, Map → Heatmap), Summary off, filters Time: All /
    Type: All, activity route Colour: None and km markers on (1 km, 5 km for rides and
    activities ≥ 40 km), lap grouping 1 / 5, chart x axis Distance. Options panels open on
    their first section.
  - *Remembered user settings* — saved on the server per person (`ui_settings`, 'all' =
    Everyone; `GET /api/ui-settings?person=`, `PUT /api/ui-settings/{key}?person=`), so they
    follow the person to every device: Map › Options (base map, tone, heatmap and tiles style).
  - When a new default comes up, ask the owner which kind it is.
- Turning Summary on scrolls the page to the top, where the summary appears.

### Navigation
- Main header: **Activities · Calendar · Map · Segments · Fitness · Statistics**, then on the right
  the **person picker** (the only coloured icon), the light/dark switch, a **question mark** for
  the Manual and a **gear** for
  Settings.
- **Phones** (screens up to 760 px; wider ones are unchanged): the top bar shows the app icon
  on the left, the page title centred (an activity's name cut short, its date small under
  it) and a hamburger on the right; the hamburger opens a menu with the tabs one under another
  and the person picker, theme switch, Manual and Settings under them. The page header is one
  row: the view switch (Tiles / Charts / List, the Settings tabs…) as buttons, scrolling
  sideways when it does not fit, and an icon at the right that shows or hides the header's
  badges (filters, options); a page with neither has no header frame. Badge panels open across the whole screen
  under the top bar. A tap outside the open menu only closes it. Tables keep values and dates
  on one line and scroll sideways inside their card (Statistics › Records with the names column
  fixed), never the whole page. The activity tiles span the
  full width (the small cards in two equal columns).
- Person picker: one person or **Everyone**. The first person in the configured order is the
  default (never Everyone). The choice is remembered per browser.
- With **Everyone** selected, Fitness and Statistics are hidden (they are per person) and a
  **Compare** tab appears: people side by side (activities, distance, time, ascent; per group).
- Settings has tabs: **General** (appearance, road surface), **Data** (data connection and its
  options, other sources), **People** (label, icon, colour, drag & drop order, watches,
  thresholds via the pencil), **Workouts** (the intervals.icu API key per person, §11b),
  **Imported** (status card + file table), **Backup**. Read-only lists are not shown (the activity type list was removed;
  types are changed per activity).
- Settings rules: different settings one below the other, the options of one setting side by
  side; selects and radio choices save on change (only free text such as the folder path has a
  *Save* button); a card that cannot be used yet is hidden, not shown with a warning; short
  notes go into the title (grey, in brackets) or into a numbered step, never as a loose line.
- Imported status card: *Current setting* (data connection, folder) with a *Change* link,
  *Automatic* (interval, next run), *Last run* (time and only the non-zero counts), *To review*
  when there are missing files. The button appears only when running it can change something:
  *Scan now* with a folder set, *Download now* with a connected Garmin account (or queued
  files), *Import N queued files* for uploads with files waiting.
- Imported file table: one line per row. *File* shows only the file name (`…name.fit`, the ZIP
  member for a file inside a ZIP), the full path on hover. Besides files it lists Garmin
  Connect's daily summaries, one row per day (`garmin_days`, File *Garmin Connect*, Recorded =
  the day, Processed = when it was fetched; a recent day fetched again moves to the top): the
  content is *Daily summary* and an icon in the metric colour for each part the day holds
  (`garmin.day_contents`: steps, floors, resting heart rate, stress, Body Battery, respiration,
  Pulse Ox, intensity minutes, calories, hydration), the value on hover. Sorting, filters and
  paging cover files and days together (`IMPORT_ITEMS_SQL`).

### Views
| View | Content |
|---|---|
| Activities | KPI row (count, distance, time, ascent, calories for the current filters); Tiles / Charts / List switch (Charts: a rounded card with four bars as its icon). Tile names stay on one line, a long one cut with "…". **Tiles**: the route on a static map (always the Faded light tone; in the dark theme dark, like the segment maps), the stats under the title. **Charts**: tiles about 17 % narrower (one more tile per row), the box 25 % lower (120 px), under it only the title and date with the distance and the time (timer) in two bold lines on the right (no labels); hovering the tile shows the averages in a lighter frame at the top centre, in one row with the training type (left) and the segment (right), cut with "…" when space is short (heart rate, pace on foot or speed, power on rides; no speed for team and racket sports); and in the box a **chart** (`tilechart.py`, no numbers, fills the box, the activity charts' colours; the training type sits in its top left corner on the frame of the map weather widget — translucent surface, blur, soft shadow — instead of in the line under the title). Heart rate blocks — side by side without gaps, width = time, height = average heart rate on a scale from the resting HR (watch, else the person's, else the default) to the maximum HR (Garmin's top zone limit), colour = its Garmin HR zone (green → red; grey below zone 1) under a light vertical gloss (lighter at the top) with a faint shadow along each block's left edge, so two blocks of one zone side by side read as two, a dashed line at the activity's average heart rate (no heart rate but power, e.g. a bike computer without an HR strap: the same blocks from power — height from 0 W to the top of Garmin's power zones, an open last zone ending 10 % above its start; colour = the power zone in the power zone colours, hysteresis 3 % of the top): **Intervals** — a block per section between the interval lines (the saved ones, else the detected); **Easy, Tempo, Race, team and racket sports** — a block per phase of the session: stretches of one zone (15 s means; the zone changes only when the heart rate is 3 bpm past its limit, so hovering at a limit stays one block; a stretch shorter than 1/12 of the activity, at least 1 min, merged into the neighbour closer in heart rate); **Long** — the same, less sensitive: at least 1/20. **Hills** — the altitude profile along the distance in the altitude green, the climbs between the profile's turning points darker. **Commute and sports without a training type** (motor sports, other, multisport…) — the route alone (no map) as a thick line in the HR zone colours (below zone 1 in the zone 1 colour; no heart rate: one plain zone 1 green) on a plain tinted background, in proportion; without a route the heart rate blocks, else speed, else the sport's icon large and faint. Without the data a kind needs: speed over time. The switch sits at the right of the page title, Tiles first; sortable columns (no filter row; filters are the badges). |
| Activity | Back button; header with type icon, name, start date (smaller, lighter), place (Garmin Connect's location name), country (of the route: `countries.py`, `activities.country`, set by the analysis; virtual = the app route's country; none without GPS or in a made-up world) (the training type is a tile, §7.6), Charts and Options badges (Options: X-axis, power averaging), an **Edit** badge (panel like Map › Options: name — empty = back to the Connect title or the type —, type, kind — Automatic (the detected one) or one of the seven, §7.6 —, FTP for this activity — activities with power, empty = automatic, the automatic value as placeholder, §7.2 —, delete) and **Create segment** (activities with a route; opens the segment creator on this activity). FIT activity files carry no surface type, so the route has no surface colouring. Tiles at the top, each its own card, side by side (flex, wrapping on narrow screens, as low and as even as possible; columns have different widths — power widest, best efforts narrow): first column four small tiles one under another — **Distance**, **Time** (timer) with the **Elapsed time** under it, **Calories** (active / total; active = total − the resting share the watch writes) — each with a title like a chart title (same font, 18 px icon) and the value below; **Gear** (icon in the title; small pictures; from the FIT `device_info`: the watch or bike computer and the sensors — HR strap, power meter, radar, lights…; a drawing per kind, or the owner's own photo from `<data>/device-images/<product>.png|jpg|webp`, e.g. `edge_850.png`; unknown or older devices show a generic picture; no battery status); **Heart rate in zones** and under it, in the same column, **Surface** (its own tile: a stacked bar in the surface hatching and the share of paved / gravel / dirt / unknown); heart rate zones: (Garmin's time in HR zones from the FIT `time_in_zone` message — one bar per zone with its share; time and zone range on hover; a grey row for the time below zone 1; files without it — virtual rides: apps write none — get it counted from the HR and power streams at analysis time with the zone limits of the person's activity of the same sport nearest in time, `analysis.stream_zones`, stored in `activities.zones` marked `computed`, so Calendar and Activities › Charts get them too; a tooltip on the title says so); **Power curve** (rides only, i.e. a power meter, not running power): the power curve (a chart of the standard filling the tile: best average power 5 s … 5 h on a log axis — every duration labelled, a stop counts as 0 W —, this activity filled, the comparison dashed and lightly filled, crosshair with the values; hovering a point highlights that effort on the charts and the map); **Power in zones** a small tile of its own under the heart rate zones (with the Surface tile when that has no other place): the time in power zones as **one bar** (as high as the surface bar; each zone its share of the width in fixed colours — Z1 grey, Z2 blue, Z3 green, Z4 yellow, Z5 red, Z6 violet, Z7 black; the share in % over a zone and its name under it only for a zone of at least 15 % and where they fit with a little room, so a bar may show one or no label; hovering a zone: its range, share and time, and where it was on the charts and the map). **Power zone colours** are the same everywhere (this bar, the route coloured by power, the zone in the chart flag, the power blocks of Activities › Charts, the workout creator): Z1 grey, Z2 blue, Z3 green, Z4 yellow, Z5 red, Z6 violet, Z7 black; **Best efforts** (laurel icon; fastest time per distance — runs 400 m … marathon, rides 5, 10, 20, 30, 40, 50, 100 km and the best 20 min and 1 h power — in columns: distance, time, average speed (rides) or pace (runs) and the best of the comparison under a short header (ATH, YTD, 12 mo…), a laurel there when this activity is the best; hovering highlights the stretch on the charts and the map). Best efforts columns: Activity | YTD (best from 1 January to today; for an activity of an earlier year that year's number and its best of the whole year) | the comparison. Rides also show **Speed1m** (top speed over 1 min, §7.5). Row names: the distances, **Distance** (the longest), Speed1m, **Power20m**, Power1h. On an indoor ride (virtual, trainer) the tile is titled **Best efforts virtual** (its distances and top speed compare with indoor rides only). Options › **Compare with** (the last column): All time (default, ATH) | Last 12 months | Last 3 months | Last 30 days, saved per person (`ui_settings` key `activity-compare`); used by the power curve and the best efforts. Zone colours are fixed: HR zones green → red and power zones grey, blue, green, yellow, red, violet, black, the same scales as the route colouring. Titles of all tiles and of the Route card use the chart title font with an icon; the route map is 414 px high. The **Effort** tile (second column) holds the activity's **Load** (tooltip: training load from the method, one hour at threshold = 100), Garmin's training load, the Body Battery change and the **Recovery** time the watch showed after the activity (earlier training included). Training effect and Garmin's load come from Garmin Connect; without it from the FIT file (`fitfile.garmin_metrics`: the session's training effect and `training_load_peak`, the recovery time from Garmin's undocumented message 140 field 9, minutes, and the VO2 max after the activity from its field 7, × 3,5 / 65536, shown in the Effect tile under the training effect), read once per activity in the background (`importer.backfill_metrics`, `activities.fit_metrics`); the Body Battery change and the training effect label only come from Garmin Connect. Options › **Route lines**: where the route runs twice (out and back) the lines are drawn side by side (default) or on top; saved per person (`ui_settings` key `activity-route-offset`). FIT activity files (Edge included) carry no road surface and no gear (bike, shoes: those live in Garmin Connect only); it comes from OpenStreetMap (`surface.py`): the route is cut into ~1 km boxes, the ways with a highway tag in them are fetched from an Overpass server (`overpass_url` setting, default overpass-api.de; only these boxes are sent), each track point (every 20 m) takes the surface of the nearest way within 25 m (surface tag; without it roads count as paved, tracks by their grade, paths unknown) and the result is cached in `activities.surface` as runs along the distance with shares. Runs shorter than 80 m join their neighbours (no flicker when a few points catch a road beside a gravel path; the stored runs stay point by point, the page gets them smoothed). Settings › General › Road surface: when an activity is opened or all activities in the background (default; newest first, in batches of 10 activities 20 s apart, then a 10 min pause; the end of an import starts a batch at once, so new activities get theirs right away; setting `surface_mode`). One request covers at most ~30 km of the route (30 boxes; longer routes in several, 2 s apart), so a long ride does not time out on the server. A server that refuses (HTTP 429 / 5xx, no answer) is left alone for 10 min, doubled with each further refusal up to 6 h (or as long as its Retry-After says), a success takes one step back (no reset); meanwhile an opened activity does not ask either. An activity that failed waits 1 h, then 4 h, then a day before its next try (the others go on meanwhile) and is then asked in half-size requests. Shown for every activity with a route outdoors; never for virtual rides and runs (no tile, no strip on the chart, no map layer, not computed in the background). Hovering a surface kind in its tile highlights all its stretches on the charts and the map. With at most one device the Surface tile shares the Devices column and heart rate zones take a full column; without a device tile the Surface tile goes under the heart rate zones (no column of its own taking room from the power curve). Best efforts rows: the distances, then Distance, Ascent, Steepest, Speed1m, Hour (Cooper on runs), Power20m, Power1h. When there is no power tile, a **Heart rate curve** tile (same chart as the power curve: best average HR for 10 s … 1 h, this activity and the comparison) takes its place. Tiles without a value are hidden, and values that belong to a chart (HR, pace, power, cadence, ascent…) live only next to it, even when it is hidden. Route card: Data badge (single colour, speed, heart rate, power / cadence / altitude when recorded, surface — one colour per kind with a legend of the kinds, intervals — interval workouts only: the sections between the chart lines, work orange and recovery grey (work = faster than halfway between the slowest and the fastest section), following the lines as they are moved; 5–95 % range, legend with the scale on the map; HR green → red, power → violet, altitude green → brown like a relief map) and Markers badge (numbered dot in the accent colour: None or every 1, 5, 10 or 25 km — rides from 5 km, only steps giving at least two markers; default every 25 km from 125 km, every 10 km from 50 km, else every 5 km for rides and activities ≥ 40 km and every 1 km for the rest); a distance scale is always on the map; a reset view button (refresh pictogram, in a block like Fullscreen, under it) appears only after the map was moved, zoomed or rotated. Charts right below the map (docs/CHARTS.md), laps (Group badge: every 1, 2, 5 or 10 km — default 1 km, 5 km for rides and activities ≥ 40 km — built from the device auto-laps when they are 1 km long, else cut from the streams; device laps of another kind — manual laps, workout steps — as the extra choice Device laps; rides show speed, runs pace), best efforts. Indoor and virtual activities show no weather on the map; virtual rides and runs show a small **Virtual** frame in its place (top left, the weather frame's style, smaller). **New tiles** (last card, above Source files; only when the route visited a tile no earlier activity of the person had, virtual included): a map with the route line and those tiles, a **Size** badge (only the sizes with new tiles, the largest first and default) and the count top right in the Virtual frame's style ("9 new squares"); computed in the browser from the earlier routes near the activity (`/api/activities/{id}/earlier-tracks`). Gear from a training app's file lists its sensors too (they carry no source type there). |
| Calendar | Weeks down the page, newest on top (always one whole week ahead, one after the last planned workout; §11b); older weeks load while scrolling down, after **Go to** (date panel like Time: slider, editable date, Today, years) newer ones also while scrolling up. Day: number, then steps, floors (else ascent) and average stress of the whole day (Garmin daily summary, else the watch's monitoring files); today (not over yet: no values) and the days after it show the day length (8:37) and the forecast on the same line (latitude and place of the latest activity's start; narrower days drop the rain, the wind unit, then the wind). The day's values and the forecast each stay on one line: narrower days switch to short forms (12k steps, 8:47), the narrowest show coloured numbers without icons. Activity: header (type icon, distance or time, training type) over the small chart of Activities › Charts. Hovering the activity shows over the chart, in the middle, its values on a soft pill (the style of the values over the activity charts): time or distance (the one the header does not show), pace or power / speed, load — one line; a narrow day drops the load. A day is at least as high as one with two activities. Today: accent tint (8 %) and an accent frame; Saturday and Sunday: one lighter accent tint (4 %). The week on the right is plain text in a narrower column (no rule, no tile, no column label): distance (big), time and load, the activity count with a dot per day (filled = active), time per sport with a bar of its target (8 px high, all of one width over the calendar; the value column only as wide as the longest time), and the week's steps, floors and average stress; on screens wide enough (as the back button of an activity) the ISO week number and year as plain text in the left margin, moving with the week and hidden under the header and at the bottom edge. **Summary** (off on each visit) shows the month of the first week row under the header (its Thursday; the weeks ahead count as the current month, so on 30 November it is still November): month name and year first, then activities, distance, time, elevation, load, steps, floors, stress. **Plan workouts** (one person only, off on each visit) shows the tray of workout templates under the header (§11b). **Next workout** (one person only, between Plan workouts and Summary, off on each visit) shows a panel like the workouts tray — the title *Next workout* with the **Model** badge on its right, the strip under it: the last 7 days and the workouts planned for the next 3 days (title *Last 7 days + next 3 planned*) split into Easy / Moderate / Hard by the thresholds — under LT1 (89 % of LTHR, Garmin records none) / up to LTHR / over it, from the heart rate stream; Garmin's zones 1–2 / 3–4 / 5 as the backup — (a bar each: done solid, planned hatched, the model's share as a mark), the form now (value and what its zone means, e.g. "Neutral: neither fresh nor tired"; the tooltip says planned workouts do not count) and under it *Estimated after plan* (the form the day after the last planned workout, from their estimated loads), and the suggested next session under *Next training · today | tomorrow* (today, or tomorrow when something is done today: rest, easy, long, tempo or intervals, its sport and length, with the reasons) and notes on which planned workout pulls the week away from the model; the **Model** badge (Polarized default | Pyramidal | Threshold, saved per person, `ui_settings` key `training-model`); `GET /api/suggest`, `suggest.py`, Manual › Next workout. Opening Summary, Next workout or Plan workouts scrolls the page to the top. The switch on the right: **Weeks** (this view) · Year. On phones (≤ 760 px) one day a row — weekday and date, the day's values, then the activities as one-line cards (no charts) — and each week starts with its number and its sums. Wider than a phone the Summary stays under the page header with the weekday names under it (other months can be read while scrolling); Next workout and Workouts scroll away; on phones all of them scroll away and the weekday names are not shown; planned workouts sit in the days like activities. Year view: 12 small month grids coloured by time; a month opens the weeks at its end. With Everyone: a person dot on each activity, no daily values. |
| Heatmap | All routes as low-opacity lines; explorer tiles, max square, cluster. |
| Fitness | Header: Time filter (opens on the last 6 months, fixed for everyone; All time is kept as `last=all`, Clear filter goes back to 6 months), Options (activity icons under the fitness chart, fitness filled / line, fatigue, form zones; saved per person) and a Summary toggle (off when the tab is entered); on the right three toggles with icons (Fitness, Form, VO2 max), each shows or hides its chart (all on by default; a toggle added later starts on), any number may be on (remembered in the browser). A ⚠ icon after the title only when thresholds can distort the load (§7.2). Summary (fitness, fatigue, form with zone, ramp rate, 7-day load) at the end of the period; charts per docs/CHARTS.md (Fitness page): fitness and fatigue lines, and form (fresher = higher), zone bands and the line coloured by its zone; ramp rate (fitness change in 7 days; above 8 too fast, below 0 losing fitness) is only a summary value, as it is the slope of the fitness line. How it is computed lives in Manual › Fitness (no explanation card on the page). **VO2 max** under Form (the same height, linked to the others): the watch's estimate after each run and ride from the FIT file (`fit_metrics`), running and cycling as two lines, each day the latest estimate of its sport (`/api/fitness` `vo2_run`, `vo2_ride`); pills: the latest value and the highest of the period per sport. |
| Wellbeing | One person. Header: the title, then **Time** (1 year, the last 12 months, on every visit; the time filter also offers "2 years" everywhere), on Movement **X-axis** (Mixed, the default: by day, the columns by week | Weeks | Months; kept while on the page) and **Options** with the goals, saved per person (`ui_settings` key `wellbeing-goals`): steps a day (10 000), floors a day (empty: no goal), intensity minutes a week (150); top right the tabs **Movement**, **Sleep**, **Recovery**, **Body** (Sleep and Recovery planned). **Movement** (`/api/wellbeing/movement`, daily data: steps and floors from monitoring files or Garmin Connect, intensity minutes and active calories from Garmin Connect): **Steps a day** and **Floors a day** — each Dots or Columns, a switch with two icons in the chart's header (steps: Dots, floors: Columns by default; kept while on the page). **Dots**: Mixed a row per month (newest on top, from the first month with data), the days across; Weeks / Months a row per year, its weeks or months across (the average day); size and colour against the goal (full colour at it, turning red from 1,5 to 2,5 × the goal, fading and shrinking towards none; without a goal up to the busiest tenth); each row's average right of the plot (hovering it marks the row); stats Avg, Goal met, Best, Streak. **Columns**: steps by day in Mixed, the years compared (a line per year over W1 … W53 or Jan … Dec) when Weeks / Months span several years, else by week or month. Then columns per week or month: **Intensity minutes a week** (vigorous count twice; the activities as icons under the x axis, as on Fitness) and **Active calories a day**. All charts are linked: a day, week or month hovered shows its week or month on every other chart; one left and right edge for all. Goal met marks every period at the goal; a click on a stat keeps its marking. **Body** (`/api/wellbeing/body`; X-axis: Measurements, the default: every weigh-in | Weeks | Months: their averages; Options: weight goal kg and body fat goal %, none by default): on top, about a sixth of the width, the **silhouette** of the last full body composition (female or male by the person's Sex in Settings › People, male when not set; a smooth outline with a soft light, no table): fat, muscle and bone fill it from the feet up in their share of the weight, the rest stays empty; the fat goal dashed. Beside it **Weight**: a dot per weigh-in, the moving average of the last 90 days dashed (the 90 days in its tooltip), the goal dashed grey, value pills on the right; **Additional series** (a badge in the chart's header: None | Training load) adds a series on its own y axis on the right — training load: the 30-day moving average of the daily load, then a point every day. Two columns, so both charts have one width: the silhouette over two tiles in the style of the activity's tiles — **BMI** (the last weigh-in's, max and min of the period) and **Fitness age** (from VO2 max, max and min of the period) — beside the weight over **Composition**: fat, muscle and bone as a share of the weight, stacked (fat at the bottom), the y range from the data (not 0–100); pills in the order of the layers; a click on one leaves that layer alone as a line with its own y range (again: all); the fat goal dashed; linked with the weight chart; one right edge with it | Weeks | Months: their averages; Options: weight goal kg and body fat goal %, none by default): on top a quarter of the width a silhouette in its card (female or male by the person's Sex in Settings › People; male when not set), filled from the feet up with the layers of the last full body composition (fat at the bottom, muscle, bone, other — their share of the weight; without one the weight only), the fat goal dashed across it, the values under it; beside it **Weight** with its moving average (30 days; 4 weeks; 3 months) and the weight goal dashed. Under them the whole width **Body composition**: the layers as a share of the weight, stacked (fat at the bottom, the fat goal dashed); a click on a layer's pill hides it (the stack and the y range follow), so fat alone can be compared; linked with the weight chart; one right edge. |
| Statistics | Header: **Time** and **Type** (as on Activities) and **X-axis**; on the right the switch **Compare years** · **Timeline** · **Records**. Compare years and Timeline open on the last 7 calendar years when there are more years of data (else all time; All time is kept as `last=all`, Clear filter keeps all time) and share Time, Type and X-axis while on the tab (an X-axis the other view lacks falls back to its default); Records opens on all time. Year column charts with narrow columns label every k-th year (the newest always) and show the totals only when they fit (else on the hovered or clicked year). X-axis: Compare years **Mixed** (default: each per-period chart by month, each running total by week) | Weeks | Months; Timeline Weeks (default) | Months | Years (the style of Activities › Tiles / Charts / List; the filters stay when switching). *Compare years*: each year one series over its weeks (the server's `%W` weeks, week 0 counted in week 1) or months; on top **Distance / Activities / Elevation gain per year** (three column charts, a third of the width each, each year split into running, cycling and other; hovering a year marks it on all three and on the charts below, a click keeps it marked until clicked again or a reload; `stats/totals?parts=1`); then four pairs, each chart the full width, one under the other — Distance per period, cumulative and Distance per period, then Activities, Elevation gain, Time — a dot per value, and **Steps** per period (daily data, `stats/totals?steps=1`, no running total); a year covers only the filtered days (the current year ends today; its running total goes on dashed and level to the end of the year); every chart of the page has the same left and right edge (docs/CHARTS.md). *Timeline* (`GET /stats/activities`: one short row per activity, everything worked out in the browser; Manual › Statistics): a summary strip always on top (Activities, Distance, Avg distance, Avg speed with pace, Around the world ×, To the Moon ×, Steps of the period from the daily data); then half-width cards two per row — **Time of day** | **Day of the week** (chart kind as two icons in each card's head — Columns (default, one colour) | Pie —, one choice for both; framed plot, axis titles, dashed grid, small points; an activity counts in every hour it spans, so the hours add up to more than the activities; tooltips: count, avg distance, avg elevation, avg pace on foot else avg speed), **Activity types** | **Countries** (two icons in each card's head, one choice for both: Pie (default: a ring in the middle of the card, the biggest slice centred on the right, a label with the share and the count — "Poland 54% (181)" — beside each slice of at least 1 % on a leader line (smaller ones: tooltip only), the card higher with many slices; in the middle of Countries the number of countries, of Activity types the number of types; nothing in the middle of the time of day and day of the week rings) | Columns; every activity type and country its own slice (no Other); Countries has a *Virtual* badge: Included — virtual routes count in their route's country — | Excluded — they join Indoor —; Indoor = no route and indoor, No route = no route outdoors), then three cards in a row: **Distance breakdown** (Running and Cycling each a table of its own, its icon and name in the first column head, both with the same column widths; runs: under 5 km, 5–10, 10 km–half, half–marathon, marathon +; rides: under 25 km, 25–50, 50–100, 100–200, 200 +) | **Weather breakdown** (kinds from the weather code, each with its sky icon as on the route map; the most common first, Unknown last) | **Temperature breakdown** (bands; the temperature of the activity's weather — Open-Meteo, the hour and the area —, not the watch's sensor); weather and temperature for outdoor activities only (a route, not marked indoor, not virtual), Unknown = weather not fetched yet; tables: activities, distance, share. At the bottom **Explorer tiles**: size icons (Squares | Explorer tiles) in the head of the summary card and of both charts, one choice for all three, for its summary strip (Tiles, Max square, Max cluster, Cluster tiles, Cluster span, Connected tiles, Longest column, Longest row, Most visited, One activity — the tiles of the routes in the period) and its two charts on the date axis (X-axis Weeks | Months | Years): tiles visited by the end of each period, cumulative as a filled line (tiles from before the Time filter count from its start), and new tiles per period as columns (pills: Most and the average per period). The choices are kept while on the tab. All Statistics charts (docs/CHARTS.md › Statistics): a pill per series at its last value with the label and the value inside; a click on a pill hides / shows that series on every chart of the page (the pill stays, grey); hovering a dot shows its value and lights the same series' dot on the other charts. *Records* (header: Time only; `GET /stats/records`): tiles in the style of the activity's top tiles, in one grid — a table tile (one width for all, as wide as its content needs on one line — each result column as wide as its widest cell in any table, `fitRecordTables`; the curves beside give way) beside its curve tile, each pair one height: **Running best efforts** | Running speed curve; **Cycling power best efforts** | Power curve; **Cycling best efforts** (outdoor) | Cycling speed curve; **Cycling virtual best efforts** (indoor rides, records of their own) | **Walking & hiking best efforts** (walks and hikes together, no speeds: Max distance, Most steps — from the cadence —, Max elevation gain, Biggest climb, Steepest 1 km; as wide as the other tables); under them **Segment best efforts** (one row per segment the person has an effort on, the name links to the segment; the time and pace or speed by the activity's group; as wide as the other tables). A table tile's title: the sport icon and name, then the laurel and BEST EFFORTS in capitals. Tables in the rows of the activity's Best efforts tile, with fixed columns (the same in every tile, so the solid vertical dividers run at the same places through every row and tile) and full names (Max distance, Top speed 1 min): with a Time filter the best in that time and the best of all time (when the best in that time is the all-time best itself, its cell shows the laurel, centred, instead of the same value twice), without one the 3 best of all time (Best, 2nd, 3rd); each cell the result, its pace or speed (the time for the longest) and the date (both in the small muted font), the activity on hover, a click opens it. Running: 400 m … marathon, Max distance, Cooper 12 min, Max elevation gain, Biggest climb, Steepest 1 km. Cycling: 5 … 100 km, Max distance, Max in 1 h, Top speed 1 min, Max elevation gain, Biggest climb, Steepest 1 km. A value without a speed (power, top speed, elevation, grade) sits in the middle of its value and speed columns. Power: 5 s … 2 h (the curve every duration, all rides). Curves: the activity's duration curve with a dot per value, the main series the best in the Time filter (or of all time), the all-time best dashed; the series pills of the chart standard on the right (label and value inside, at the height of the last value, in a column of one width so the curves end evenly); hovering shows the values, a click on a point opens its activity. Heart rate and segments have no records here. |
| Compare | Everyone side by side (only with “Everyone” selected). |
| Manual (?) | A knowledge base of how Trailbook computes things and how to read them, tabs like Settings: **Training types** (what a training type is, the types with what they do and the recovery, sports and their settings, the detection rules, intervals in detail, relative to you, changing the type, terms) and **Training effect** (what it is, Garmin's aerobic / anaerobic scale, primary benefit with the codes, how to read it, how it relates to the training type, where it is shown). **Weather help** (what the meter shows, which activities, how it is counted with the levels, weights per sport, examples, limits; the weights come from `HELP_PROFILES`, the values the meter uses). **Fitness** (what the charts show, load per activity by method, the fitness model, form and ramp zones, thresholds and the ⚠, terms; constants from `/api/types` › `fitness_rules`, zones from the charts' own tables). **Next workout** (what the Calendar panel shows, the easy / moderate / hard split, models, the rules for the next session, sport and length, form and plan notes; constants from `/api/types` › `next_rules`). Every table is fitted to its content: when every cell fits on one line, the columns keep their natural width and only the last column takes the rest (measured in `fitManualTables`, again on resize); otherwise short columns stay on one line and the text columns share the rest and wrap; row lines run across the card; rules and terms are tables too. A section's text and tables sit 16 px in from its title (the first column without cell padding, so text and tables line up); tiles inside a section are not indented. Built only from the app's existing pieces (grey tiles, ranked rows and panel titles, plain data tables), no colours of its own; the first card holds the contents as tiles that jump to the sections. All of Trailbook's own numbers come from the server (`/api/types`), the same values the code uses; new topics get a tab of their own. |
| Settings | Tabs: General (appearance, road surface), **Data** (data connection, Garmin Connect / upload / watched folder cards, automatic download or scan, other sources), People, Workouts, Imported, Backup, **Log** (last: the app log, newest first — time, level, area, message; info green, warnings yellow, errors red, a traceback folded under its first line; Show: All / Warnings and errors / Errors, fixed on every visit; refreshed every 10 s while open). The log (`applog.py`): every process (server and import / export jobs) logs the same lines to stdout — the add-on's log in Home Assistant — and to `<data>/trailbook.log` (1 MB, two older files), `GET /api/log?limit`. Line: `2026-11-20T08:15:02Z WARNING garmin: …` (UTC). Trailbook's own loggers from INFO, libraries (uvicorn…) warnings and errors. Logged: import runs (start, summary, failure with traceback), every file that failed to import, Garmin (refused key, failed sync, activities not downloaded, daily summaries or details not available, the run's summary), intervals.icu sends that failed, road surface and weather servers not available, Home Assistant calls that failed, export / restore failures, unexpected errors of the background loops and of API requests. |
| Settings › Backup | Export (with / without FIT files, optionally with Garmin keys), list of exports (download, restore, delete), restore from an uploaded export (one file picker, no folder choice: every file goes into the archive); progress while a job runs, page reloads after a restore. |

### Page structure
Every tab has the same header: the **title**, then **badges** in one row (order: Filter,
Options, Summary; the per-tab badge is called *Options* to keep it apart from the app
Settings behind the gear) (rectangular, slightly
rounded, clearly interactive). A badge either toggles something (e.g. KPIs) or opens a panel
with settings; panels stay open while settings change. A main switch (e.g. Heatmap | Explorer
tiles) is slightly larger than the other badges. Tab-specific tools (e.g. list/tile view) sit
at the right end of the row.

The header row is a **frame** (translucent surface, thin border, soft shadow) in exactly the
same place on every tab, the map included. It stays below the top bar while the page scrolls;
content scrolling up to it fades out over a short strip (~18 px) just below the frame. On the
map the same frame floats over the map without the fade.

### Style rules
- Light theme by default, dark theme via a toggle (remembered per browser).
- Accent colour: sky by default; Settings › General offers sky, teal, indigo, violet, rose,
  amber, green, graphite (saved per browser, applied before first paint). Logo icon before
  “Trailbook” uses the accent.
- **Filters are the same on every tab** that has them (Activities, Map, Segments and a
  segment, Statistics › Totals and Records, Compare): first **Time**, then **Type**, then the
  tab's own badges (Options, Summary, …). Activities also has **Training type** after Type
  (URL `workouts`: comma list of training type keys, `none` = not set; counts under the other
  filters). Each opens its own panel; nothing changes until
  **Apply**, and **Clear filter** (next to Apply, only while that filter is set) removes just
  that filter (Clear filter and Apply side by side on the right, the same outlined button like
  the badges). URL parameters `from` / `to` (local days, inclusive; left out at the ends of
  the data), `last` (`1m`, `3m`, `6m`, `ytd`, `1y`: a period up to today), `years` (comma
  list, gaps allowed) and `types` (comma list of type keys; `g:<group>` = a whole group),
  handled by one function on the server (`activity_filters`) for every endpoint.
  - *Time*: a range slider with a dot at each end, from the first activity (`GET
    /api/time-range?person=`) to today; under the dots the two dates in small muted numbers
    (no dash between them) — a click on the year, month or day makes that number editable in
    place, without a box (digits only, Enter keeps it, Escape cancels, the day is clipped to
    the month). Under that two rows of chips:
    1. *All time · 1 month · 3 months · 6 months · YTD · 1 year* — one choice. A period up to
       today, kept relative in the URL (`last=3m`), so a saved link or the kept filter stays
       "the last 3 months". Months are calendar months back from today (the day clipped to
       the month), YTD from 1 January, 1 year = 12 months.
    2. One chip per year — several can be on, also with a gap (2023 and 2025).
    Choosing one kind clears the others: a period clears the years, a year clears the period,
    moving the slider or typing a date is a range of your own and clears both. The slider
    shows the choice; years with a gap cannot be one range, so the slider shows their span
    dashed and "*n* years selected". The badge shows *All time*, *Last 3 months*, *Year to
    date*, *Last 12 months*, a year, `2023–2025` (side by side), `2023, 2025`, *n years* (more
    than three with gaps), or `from – to`. Fitness shows the whole span from the first to the
    last chosen year (fitness is a continuous model; a cut year would be a jump in the line).
  - *Type*: the panel is the list itself — a checkbox per type with its icon and count,
    under a small heading per group; the heading of a group with more than one type is itself
    a checkbox that selects the whole group (half-checked when only some types are); only types with
    activities of the selected person. The badge shows *All*, the group, one or two type
    names, or *n types*. In Records › Running pace the type is fixed (running) and the badge
    is hidden.
  Action buttons in Settings have the same size (30 px high, 13 px semibold): the primary ones
  stay blue, the others are outlined like the filter buttons; selects and the file picker
  line up at 30 px.
  Calendar and Fitness have no filters: their time is the page navigation (Go to / year,
  range switch). Name and person stay as column filters in the Activities list.
- The main switch (e.g. Heatmap | Explorer tiles, List | Tiles | Large tiles, settings tabs)
  looks like the main navigation: no box, the selected option on a light tint in the accent
  colour.
- The vertical scrollbar is always shown (`html { overflow-y: scroll }`), so nothing jumps
  when a page gets long and the header ends at the scrollbar; the full-screen map has no
  scrollbar and shifts header and bar by the measured scrollbar width to line up.
- Scrollbars are thin, without arrow buttons, a rounded thumb in the theme colours (all
  scroll areas, the page included).
- The heatmap / explorer tiles page is called **Map** in the navigation and its title.
- A click on a route opens a small window over it: one flat row per activity under the click
  (up to 6) — its type icon, type and date (and the person with Everyone) — a link to it.
- The full-screen look of the Map page (no page padding, the floating header) is switched in the
  same moment the page content is replaced, entering and leaving, so nothing jumps meanwhile.
- Map start view: fit all routes, then zoom out 4 levels — but never further than a view of
  central Europe (lon 2…24°, lat 40…52°: about zoom 5 on a laptop
  screen, where Malta gets its label) on the current screen. If the routes do not fit even
  there (activities on several continents), the map starts at that level centred on the 10°
  area with most activities.
- **Activity type icons** (“Trailbook B” set, `assets/icons/`, served from `static/icons/`,
  `TrailbookIcons.render(key, {size})`, unknown → `other`): small (18 px) next to activity
  names and types in every list and filter, larger (28 px) only on Segments cards; Activities › tiles use the standard size too.
  The Type filter (see *Filters* above) lists only types with activities of the selected
  person, each with its count (`GET /api/types/counts?person=`).
- **Metric icons** (`assets/metric-icons/`, served from `static/icons/`, 20 or 32 px) coloured
  by metric group — sets, colours and usage in `docs/ICONS.md`. Used so far in
  Settings › Imported in front of FIT files that are not activities.
- Lists load **50 rows at a time** while scrolling (no page buttons) — the rule for every
  list (activities, tiles, import files, later calendar lists).
- Summary instead of big KPI cards: one compact strip (label, value, small note), e.g.
  activities + active days, distance + average, time + per week, elevation gain, longest,
  calories.
- Every section is a card with a background (no borders).
- Descriptions always use the same small muted style; states (next scan, saved, running,
  errors, file statuses) always the same small size in a state colour.
- **Numbers are always shown with their unit** (km, m, bpm, W, spm/rpm, kcal, h, /km).
- Works inside the HA Ingress panel and in an iframe; usable on phone width.

---

## 11. Map

- Library: MapLibre GL JS 4.7.1 (BSD), shipped in `static/vendor/` and loaded only on map
  pages — the browser never calls a CDN.
- Base map: OpenStreetMap raster tiles fetched by the add-on (`/api/basemap/{z}/{x}/{y}.png`)
  with a proper User-Agent and a permanent disk cache next to the database, as the OSMF tile
  policy requires; each tile is downloaded once. Source configurable (setting `basemap_url`).
  Dark theme: desaturated and darkened tiles. Vector tiles (as in HA 2026.10) are a later
  option.
- The Heatmap page is full screen: the map fills the page and the header row (title, badges
  Settings · Filter · Summary, and the Heatmap | Explorer tiles switch with icons on the right)
  floats above it, aligned with the content column of the other tabs.
  Settings is one panel with three columns, always all of them: Map, Heatmap, Explorer tiles
  (the base map is shared; settings of the hidden mode are kept for when you switch):
  - Base map: OpenStreetMap, OpenTopoMap, CyclOSM, Humanitarian (HOT, default) or none (CARTO
    was tried: it needs an API key now; a base map no longer offered falls back to the default); Trails: None (default) | Hiking | Cycling | MTB — the marked routes of Waymarked
    Trails drawn over it (transparent tiles, `basemap.OVERLAYS` `trails-<kind>`); colours (faded light, original,
    muted, grayscale, soft dark, slate, dusk, dark (high contrast)) chosen for the light and the
    dark theme apart — the row is for the theme shown, saved as `toneLight` / `toneDark`; defaults
    muted in light, dusk in dark (`MAP_TONE`); a choice saved before for both themes goes to the
    theme it suits. The soft dark tones lift blacks and lower contrast so routes stand out without
    a harsh map. The chosen colours belong to the Map tab only. Route maps (activity, segment,
    segment creator) always have fixed colours per theme: faded light in light, soft dark in
    dark (`ROUTE_TONE`); the activity tiles' static maps likewise.
  - Relief: On (default) | Off — hills shaded over the base map (under the routes) on every
    map, the static route maps too (remembered with the other map settings). Elevation from
    Terrain Tiles (open data on AWS, Terrarium encoding, up to zoom 15; `basemap.OVERLAYS`,
    fetched and cached by the server like the base maps): interactive maps shade them with a
    MapLibre hillshade layer, static maps get the shading drawn in the browser (sun from the
    north-west, slopes 3× steeper so gentle hills show).
  - Dark theme on maps: outlines of lines, dots and km markers are near black (`--map-halo`)
    instead of white; map buttons, attribution and scale dark; road surface colours lighter.
  - Heatmap: style (density, coverage, heat glow), colour (presets or any colour from a
    colour wheel; gradient for heat glow; a colour per person for Everyone), line width,
    overlap strength.
  - Explorer tiles: size (zoom 13 squares, 14 explorer tiles), style (coverage / by visits), colours, display (single tiles / one area),
    highlights (max square, cluster, routes on top of tiles), **Regions coverage
    statistics**: a Choose badge opens a small window with a searchable list of countries,
    each expandable to its regions; any number can be ticked, OK applies them. The chosen
    ones are listed under the badge (a region with its country), each with × to remove it (saved per person with the
    other options). Each chosen country / region adds an item to
    Summary: its name, share of visited tiles, "visited of all" (`regions.js`).
  Colour, width and strength changes only update paint properties (instant); the map starts
  directly at the data bounds (no world-view jump).
- All choices are saved per browser and separately per mode, so switching between heatmap
  and tiles restores each mode's colours.
- Tiles, max square and cluster on this page are computed **in the browser** from the route
  polylines for the chosen tile size; the server stores zoom-14 tiles per activity for
  statistics. MapLibre has no blend modes, so overlapping people are not colour-mixed.
- Region boundaries: Natural Earth 1:10m admin-0 / admin-1 (public domain), built by
  `tools/build_regions.py` into `static/regions/` (index + one file per country, ~5,8 MB in
  all, kept under 6 MB; Antarctica left out). A country file is fetched only when that
  country or one of its regions is chosen.

---

## 11a. Segments

A segment is a piece of route (a climb, a sprint, a lap of the park). Every activity that
covers it gets an *effort* with its time; the Segments tab ranks and tracks them.

- **Shared by the install.** Segments belong to no person; everyone's activities are matched.
  With one person selected, only segments that person has ridden appear (with their efforts);
  with **Everyone**, all segments with any effort and leaderboards across people. Segments
  still being matched always show (state *matching…*), so a new one gives feedback at once.
- **Two creators**, both ending in a slice of one recorded activity (full-resolution
  `lat`/`lon` from `streams`, simplified to 2 m, at least 100 m long):
  1. *From an activity* — choose an activity, pick start and end with one two-thumb slider
     right under the elevation profile (along the distance, so the thumbs line up with it);
     the map highlights the slice; below: length, time, climb, name, any type, Create.
  2. *From the map* — place pins in riding order on a map that shows your routes; the server
     snaps them to **your own tracks**: the activity that passes all pins in order (within
     50 m) is cut between the first and the last pin (closest match wins, then the newest).
     No routing engine and no external service.
  A segment matches activities of its group (the source activity's group) unless *any type*
  is chosen.
- **Matching** (`segments.py`, phase `segments` of the importer process, after analysis):
  1. Prefilter in SQL: activity bbox contains the segment start and end (+ ~50 m, more with a
     wider corridor), group fits.
  2. Checkpoints every 25 m along the segment. An effort starts where the track crosses the
     start (within 25 m, interpolated along the segment direction, so waiting before the
     start does not count), passes **every checkpoint in order** within 30 m (edge distance,
     so sparse GPS works; at most 200 m of track between two checkpoints, so detours and the
     opposite direction fail) and ends at the first crossing of the end (within 25 m).
  3. Travelled distance must be 0.8–1.3× the segment length (+100 m). One activity can have
     several efforts (laps); the search continues after each end.
  4. **Both directions on flat segments**: when the end is at most 30 m and at most 3 % of the
     length above or below the start (`segments.net_climb_m`, set at creation; older segments
     take it from their source activity), the segment is also matched reversed. Those efforts
     share the leaderboard and are marked `reverse` (⇄ next to the date, explained on hover). A short
     steep ramp stays one way even under 30 m. Edit › Direction overrides it per segment:
     Automatic (default) | Both ways | One way (`segments.two_way_mode`).
  5. **How loosely, per segment** (Edit, sliders at the top of their labels; saved on release,
     the segment is matched again): **Match width** — the corridor's half width, 15–75 m in steps of 5 (default 30 m;
     the start and end lines grow with it: 25 m × width / 30), e.g. the other side of the
     street (`segments.match_width_m`); a width other than the default shows on the route map
     as a soft shadow around the dashed line, live while the slider moves. **One detour** —
     0–500 m in steps of 25 (default none): once per effort the checkpoints along up to that
     many metres of the segment may be missed (around a block, a closed path), when the track
     comes back within twice the detour + 200 m of track; the allowed length grows by twice
     the detour (`segments.match_detour_m`). NULL = the default. A checkpoint counts where the
     track first enters its corridor; over a switchback a wide corridor catches checkpoints of
     the lane after the turn already on the lane before it, so the track falls behind the
     segment — that lag (segment metres passed minus track metres travelled) is added to the
     track allowed to the next checkpoint, so a wider corridor never loses an effort.
  6. Effort values: elapsed time (the ranking; the only time shown), average speed, max speed (from
     the speed stream), average / max HR, average power and cadence over the slice, start time.
  `segments.match_version` / `activities.segments_version` (0 = to do) say what is done; a new
  or changed segment is matched against all activities, a new or reimported activity (or a
  type change) against all segments. ~ms per candidate on the CM4.
- **List** (`#/segments`): *New segment* (from map / from activity), cards in three columns
  (two on a tablet, one on a phone). A card has a small static map (OSM tiles from the tile
  cache as `<image>` elements + the line in SVG — never one WebGL map per card, browsers allow
  ~16), name, distance, ascent, group and the number of efforts (bold), then **Best** and
  **Last** side by side with a divider (no grey boxes): icon and label, the date on the right,
  the time big, then speed or pace, average HR and power with their icons (and the person with
  Everyone). Options: show segments without efforts of the selected person.
- **Segment lines** are dashed on every map (cards, detail), so a segment never looks like an
  activity. A segment counted in both directions has both ends yellow and a ⇄ mark (top right
  of the card map, next to the Route title on the detail page); one way: green start, red end.
- **Detail** (`#/segment/{id}`): header like an activity — group icon, name, then the date
  and place of the source activity (small, links to it); badges Time, Type (only the types
  of this segment's efforts in the period, with counts), **Edit** (name, Counts: *<group>
  only* — every type of the group — or *Any activity type*, Direction: Automatic | Both ways |
  One way, Delete segment) and **Summary**
  (shows the strip above the Route card: distance, ascent, grade, direction (one way / both ways
  with the end vs start altitude), efforts, both ways also **By direction** (efforts this way ·
  the other way), best, average, median, most recent;
  on by default, saved per person, `ui_settings` key `segment-summary`). Route card (title
  with icon, 414 px map, a **Data** badge: None | Altitude | Surface — altitude and surface
  of an effort ridden in the segment's own direction, its activity cut to the segment, drawn
  like the activity route; None shows the dashed segment line), Most recent effort and Best
  effort cards one under the other (title, date and activity on the left, the values as small
  tiles in one row; a value neither effort has — a ride without cadence — is left out, both
  cards have the same set, so the columns line up), **Trend** chart
  (docs/CHARTS.md: every effort's time over the Time filter, faster higher, a dashed trend
  curve — robust local regression, Manual › Segments: trend line; value pills Most recent, Trend,
  Best, Avg on the right at the height of their values), top 10 (fastest
  first) and all efforts (newest first by default, 50 at a time; Date and Time headers sort) with the activity list's icon headers: Avg speed and Max
  speed (on foot: Avg pace, Best pace), Avg HR, Max HR, Avg power only when an effort has it. With Everyone also a table per person (best, average, efforts, most recent).
  The route map has the height grip like the activity route.
- **On an activity** every segment it covers gets a card: title "Segment: <name>" (route
  icon, the name links to the segment) and a **Show segment** badge on the right, then three
  separate full-width tables like the one on the segment page, each with its own title in
  the text colour and space between them: **Last** (this effort and the two before it),
  **Best**, **Best · last 12 months**. This activity's row says "This activity" in the
  Activity column in orange (apart from the blue links); rows are not tinted.
- **Weather of an effort** (last column of the effort tables on the segment page and in the
  segment card on an activity): sky icon, temperature, wind arrow (where it blows) and speed,
  then a small diverging meter: from the middle to the right when the weather helped, to the
  left when it held back (a full half at 15 points); hovering it shows this case's breakdown
  (wind, temperature, rain with their points and the sum). Data: the activity's weather (Open-Meteo,
  hourly for the area, see the Activity page); an activity without it is looked up when the
  table is shown (one at a time, cached). Rides and runs outdoors only, each with its own
  weights; indoor and virtual activities leave the cell empty. The same meter
  sits under the weather widget on an activity's route map (whole route, no background).
  The formula, the sport profiles and examples: `docs/MANUAL.md` › Weather help.
- **VO2 max** of the period is shown only once it is stored (Garmin API, Wellbeing stage);
  until then nothing is shown.

---

## 11b. Planned workouts (Calendar › Plan workouts)

Own structured workouts sent to the Garmin watch without Garmin's business API: through
**intervals.icu** (free), which the person connects to Garmin Connect with *Upload planned
workouts* on. Code: `planner.py` (workouts, estimates, text), `icu.py` (key, sync), `workouts.js`.

- **Settings › Workouts API**: numbered steps (account and Garmin connection in intervals.icu,
  Upload planned workouts, threshold heart rate, API key) and one key field per person, in the
  style of the Garmin keys (Connect / Save, Test, Disconnect; state chip). Athlete `0` = the
  key's own athlete, so no athlete ID is asked for.
- **Templates** are per person (`workout_templates`). Starters, each added once (the setting
  `workouts_seeded:<person>` counts them, so later starters reach people who have the first
  ones): 5 × 1 km VO2max, 3 × 10 min threshold, Tempo 25 min, Long run 90 min (run, heart
  rate); 2 × 20 min FTP, 5 × 3 min VO2max, Tempo 30 min, Endurance 2 h (ride, power).
- **Tray**: a frame under the Summary strip (both as wide as the page header and plain like
  the Activities summary), scrolling sideways: one tile per template (like an activity tile: sport icon, expected
  time, kind — Intervals, Tempo, Long, Easy — and a chart of the steps; the header in the plan
  colour `--plan`, yellow, not the accent; hovering the chart shows the name, the header the
  time, distance and load), edit (pencil) and delete (bin) at the top right on hover, order by
  dragging, and an **Add new** tile with a dashed frame at the end. A tile dragged onto today
  or a later day plans it there.
- **Step chart** (tiles and creator): a block per step, width = its time; on the zone scale a
  solid block up to the bottom of its zone and the zone itself 30 % opaque, both in the colour
  of its top zone (a range: from the bottom of its lowest zone to the top of its highest; a
  bpm / watt range: its values; no target: a low grey block).
- **Creator** (a window, fading in): workout name (a normal-size field; left empty, it shows a
  suggested name — the kind and the main part, "Intervals 5 × 1 km", or the kind and the whole
  length, "Easy 45 min" — which Save uses), *Sport* badge (Run /
  Ride), *Target* badge (Run: Heart rate or Pace; Ride: Heart rate or Power). Under it the canvas
  across the whole width (fixed height; only the text "Drop the first step here" while empty,
  the zone grid once there are steps): the step chart; on each block, centred in its solid
  part, the zone and under it the length (white, semi-bold, small); the steps take a share of the width that grows with their number and with the
  workout's length (0,3 + 0,05 per step + 0,6 · (1 − e^(−time / 90 min)), at most 96 %: a short
  workout with a few steps stands in the middle, a long one fills the width), centred; blocks move and grow animated. A repeat is a
  frame around its steps (its count as ×N, the copies follow lighter); the frame's edges are
  dragged over neighbouring steps to take them in or leave them out, its ×N tag drags the
  whole repeat. **Repeat** from the column is only a dashed frame: dropped on a step it frames
  that step (×4; not a step already in a repeat — one level only), dropped on empty space it
  is an empty frame ("Drop a step") that takes the first step or ready set dropped into it
  (empty frames are never saved); clicked, it frames the selected step or adds an empty frame
  after the selection. While dragging (a step, a repeat, a new one from the columns, a frame's edge)
  the canvas shows the result live — the blocks make room, the new step sits in its place, the
  frame takes in or leaves out steps — and nothing changes until the mouse is let go. Steps may mix time
  and distance lengths (Garmin keeps a length type per step).
  Under the canvas, inside its frame, one centred line of fields — Time, Distance, Load, Kind,
  Watch steps — the labels grey, the values semi-bold.
  Below three framed columns: **Steps** (Warm-up, Interval, Recovery, Rest, Cool-down, Repeat),
  **Ready steps** (repeats per sport: run 5 × 1 km, 3 × 10 min, 8 × 400 m, 4 × 4 min,
  6 × 800 m, 2 × 15 min; ride 2 × 20 min, 5 × 3 min, 3 × 12 min, 10 × 1 min, 4 × 8 min,
  2 × 30 min — once added they are ordinary steps; the Steps and Ready steps columns have a
  very light tint behind their tiles) and
  **Step settings** (the widest, empty until a step is clicked; the three columns have a fixed
  height, so the window does not jump; one row under another, the label on the left and its
  control to the right, all controls 28 px high:
  Type, the target — Zone (click one, drag across several for a range; the limits from the
  latest activity of the sport; small zone buttons) or a bpm / watt range or None —, Length —
  a Time | Distance switch and a slider (time 15 s … 6 h, distance 100 m … 50 km, finer steps
  at short lengths; switching keeps about the same time at the step's speed); its value is a
  field too (15, 15:30, 1:05:00, 90s; 1,6 or 800 m) —, Cue on the
  watch; Duplicate and Remove at the bottom right; for a repeat its count and Remove repeat). Steps are added by clicking (after the selected one) or dragging onto the canvas,
  and moved by dragging. **Delete** (outside a field) removes the selected step, or the
  selected repeat with its steps. **Undo** at the bottom left (also Ctrl+Z outside a text field) takes
  back the last change of the steps, repeats, sport or target, one at a time (up to 100).
  Cancel / Save at the bottom right.
- **Only what reliably reaches the watch**: lengths in time or distance (no lap button),
  heart rate, power or (runs, on trial) pace targets — pace as a min/km range (fast – slow),
  sent as % of intervals.icu's threshold pace, its own form for pace (without a threshold pace
  intervals.icu gives Garmin "no target"; to be checked on a Forerunner 965 and a Venu 3S) —
  no cadence, no ramps, one target kind per workout, repeats one level
  deep, at most 50 watch steps. Default lengths: time; a running interval: distance.
- **Planned workouts** (`planned_workouts`) keep a copy of the template as it was placed. A
  placed one waits 1 minute (it may still be moved or removed) and then goes to intervals.icu
  as a WORKOUT event on its day (description in intervals.icu's text syntax, zones sent as
  numbers: % of intervals.icu's LTHR — else % of its max HR — and watts, so the watch shows
  Garmin's limits). Moving it (drag to another day, today or later) updates the event; the
  pencil edits this one entry in the creator (its template in the tray stays as it is) and
  sends it again; the bin removes it here at once and from intervals.icu (and so Garmin) on the next send. A background
  task sleeps until the next send is due (idle: one look an hour).
- **In the calendar** a planned workout looks like an activity tile with the plan header; on
  hover the kind gives way to edit and remove at the right. A struck-through sync icon (right
  after the time) (hover: the reason) when it cannot reach the watch: no key, key
  refused, an error; nothing when all is well. Up to today a planned workout goes with an
  activity of its sport on its day: the activity gets a small calendar icon (hover: what was
  planned) and the plan tile is hidden. A past plan without an activity is hidden (kept in the
  database: the watch may sync weeks later).
- **The week on the right**: a week ahead with plans has the same lines as a week done, from
  the plan's estimates in the plan colour: ≈ distance (big), time · ≈ load, the activity count
  with its day dots (planned days in the plan colour), then the bars. Bars have one width
  whether or not a sport has time yet. Steps, floors and stress sit a little lower, without a rule. Estimates: docs/MANUAL.md › Planned workouts.
- **Targets** (Calendar badge left of Plan workouts and Summary, one person; saved per person,
  `ui_settings` key `week-targets`): a compact panel, one line each with a − value + stepper
  (saved at once; − and + in the accent colour; the value can also be typed: time as 2:30,
  2h 30min or minutes) — *Weekly targets*: time per sport (step 30 min; the person's sports
  first); *Daily targets*: steps (step 500), floors (step 5). An empty field = no target.
  The activity count keeps its plain form (count and a dot per day). In the week on the
  right a target is a bar: done in the accent colour, what the open planned workouts add in
  the plan colour (so one sees whether the plan reaches the target), red past the target, the
  value beside it; hovering: done, planned, target and the share done (with the plan).
  Without a target: the activity count with the day dots, sports only as icon + time side by
  side (planned time in the plan colour), steps and floors as compact icons, as before.

## 12. Add-on packaging

- Repository layout: `repository.yaml` at root, add-on in `trailbook/` (`config.yaml`,
  `Dockerfile`, `build.yaml`, `DOCS.md`). The Dockerfile is built from the repository root
  (`docker build -f trailbook/Dockerfile .`) so it can install `backend/`.
- `config.yaml`: `arch: [aarch64, amd64]`, `ingress: true` (port 8099, no published port),
  `panel_icon`, `map: share (rw), media (ro), addon_config (rw)`,
  `image: ghcr.io/md0005/trailbook-{arch}`. No add-on options yet: everything is set in the UI
  and stored in the database.
- Image: HA `base-python` (Alpine), `pip install backend` (pure Python), one process
  `trailbook serve`; `init: true` reaps the job subprocesses. Environment: `TRAILBOOK_DB=
  /data/trailbook.db`, `TRAILBOOK_ALLOWED_ROOTS=/share:/media:/config`, `TRAILBOOK_EXPORT_DIR=
  /share/trailbook-exports`, `TRAILBOOK_VERSION` (= add-on version, shown in the UI).
- The UI works under Ingress because every URL is relative and routing uses `#`; static files
  are sent with `Cache-Control: no-cache`, and `index.html` (`no-store`, built once per start) names every local script and stylesheet as `file?v=<first 10 hex of its SHA-1>`: an update gives changed files new addresses, so no cache on the way (browser, Ingress, the companion app, a proxy) keeps an old UI.
- **Shipping a change:** commit to `main` with a bumped `version` in `trailbook/config.yaml`.
  GitHub Actions (`.github/workflows/addon.yml`) runs lint + tests on every push and builds both
  images only when that version is not on GHCR yet. When the run is green: HA › Settings ›
  Add-ons › Add-on store › ⋮ › Check for updates → Update. Commits without a bump are not
  shipped.
- Database changes ship by themselves: migrations (`db.MIGRATIONS`) run on start. They only go
  forward — an older version refuses a newer database — so a rollback is an HA backup of the
  add-on taken before the update.
- **Without Home Assistant (plain Docker):** the same image runs with `docker run` /
  `docker-compose.yml` (repository root): port 8099, volumes `/data` and `/share`. CI also
  pushes `ghcr.io/md0005/trailbook:{version|latest}`, a manifest list over the two arch images
  (HA keeps using `trailbook-{arch}`). Outside HA there is no Ingress login, so
  `TRAILBOOK_PASSWORD` turns on Trailbook's own login (`auth.py`, middleware installed only when
  the variable is set — never in the add-on): login page on any unauthenticated page, `401
  {"error", "login": true}` from the API (the UI reloads to the login page), `POST /login`,
  `GET /logout`. Session cookie = HMAC-SHA256 of the password under a random key in
  `<data>/session.key` (HttpOnly, SameSite=Lax, Secure behind HTTPS, 400 days); a new password
  ends all sessions; a wrong one waits 1 s. Notifications to HA are off (no `SUPERVISOR_TOKEN`).
- **Windows app (no Docker, no HA):** `windows/build.py` freezes the backend with PyInstaller
  (one folder, `windows/trailbook.spec`, entry `trailbook.desktop`) and wraps it in an Inno
  Setup installer (`windows/trailbook.iss`): per user, no admin rights, installed in
  `%LOCALAPPDATA%\Programs\Trailbook`, Start menu entry, optional desktop icon and start with
  Windows (`--background`, no browser tab); uninstalling asks whether to delete the data in
  `%LOCALAPPDATA%\Trailbook` too (default No; not asked when silent). Free: the exe is not signed, so SmartScreen warns
  once on the first download. `Trailbook.exe` without arguments serves on `127.0.0.1:8099`
  (another free port when 8099 is taken by something else; a second start only opens the
  window), shows a tray icon (Open / Quit, pystray + Pillow, only in the exe) and opens
  `http://trailbook.localhost:<port>/` (browsers send *.localhost to this computer) in a
  window of its own: Microsoft Edge with `--app` (no address bar or tabs; found through App
  Paths in the registry or its usual folders; its taskbar icon is the page icon,
  `static/app-icon.png` with `manifest.json`), without Edge the default browser; with arguments it is the CLI, so the job subprocesses run the same exe. Data in
  `%LOCALAPPDATA%\Trailbook` (database, archive, log, exports), apart from the program. No
  login (only this PC reaches it). `TRAILBOOK_DESKTOP=1` marks the app: the API reports
  `desktop: true`.
- **Windows build in CI:** the `windows` job of `addon.yml` runs with the image builds (a new
  version), builds the installer on `windows-latest` and creates the GitHub release
  `v<version>` with `Trailbook-Setup-<version>.exe` and the changelog section as its notes;
  the older releases and their tags are deleted (only the newest is kept).
- **Windows updates, one click** (`update.py`): `GET /api/update` compares this version with
  the newest GitHub release (asked at most once a day, an hour after a failure; `?check=1`
  asks now). A newer one shows a line in the header bar and the Updates card in Settings ›
  General with its notes and *Update to <version>*. `POST /api/update` (refused while a job
  runs) downloads the installer to `<data>/updates`, checks its size and SHA-256 (the release
  asset's digest), starts it silently (`/VERYSILENT`) and ends the process; the installer
  replaces the program and starts it again; the open page reloads when `/api/info` reports the
  new version. Migrations run on start as in the add-on.
- To do: `hassio.addon_stdin` trigger (5.1), add-on icon/logo.
- Local development: backend and frontend run on a PC against a sample folder; no HA needed.

---

## 12a. Record notifications in Home Assistant

- Trailbook decides everything; HA only shows it. After every import run (`records.py`,
  `cli.cmd_import`) new records become **record events**, and each new event is pushed once as
  the state of `sensor.trailbook_records` through the Supervisor API
  (`homeassistant.set_state`). Outside HA nothing is sent; `GET /api/ha/records` shows the
  latest event.
- **Record:** a new activity (`activities.records_seen = 0`) that is fully processed (analysis
  and segments at the current version), started at most **14 days** ago, and took a top-3 place
  on a list (all time, or this year) by beating a result already there (rank ≤ the list's length
  without the new activities). Only runs and rides (`SPORTS`; a segment counts by the
  activity's group). Lists: per person, group and best effort (`pace` for runs, `ride` for
  rides, `power`: every duration of all time, only 20 min and 1 h for the year), the longest
  distance (`longest`), the top speed over 1 min (`speed`, rides) — indoor rides' distances,
  times and top speed on lists of their own ("virtual ride 20 km") — and per segment (the faster effort when ridden twice). No heart rate. Each activity is checked once, then `records_seen = 1`; one still
  unprocessed after 3 days is marked seen without events. Not a record: adding or editing a
  segment, analysing again, deleting an activity, importing history (older than 14 days), the
  first results on a list.
- **Event = one record** (`record_events`, last 100 kept): who, the activity, what, the result,
  `scope` (`all` when it placed of all time, else `year`), `rank`, the result it beat (`beaten`:
  value, label, date), `delta_label`, and a ready notification in the style of the other home
  notifications: `title` (`ALL-TIME RECORD`, `ALL-TIME 2ND BEST`, `2026 RECORD`, `2026 3RD
  BEST`), `message` (two lines: `Asia · run 5 km · 21:20 (4:16 /km)` / `20 s better than 21:40
  on 2024-05-01`), `icon` (`mdi:trophy` all-time record, `mdi:trophy-variant-outline` all-time
  2nd/3rd, `mdi:medal` / `mdi:medal-outline` for this year), `color` `#E8B86D`. English only.
- **Push:** state = the event id, attributes = the event (about 1 KB). Events go out oldest
  first, each as its own state change; `pushed_at` is set only when HA accepted it. Events HA
  missed (restart, away) are sent again every 5 min (`HA_RECORDS_RETRY_S`); one older than
  2 days is dropped unsent. A pushed state does not survive an HA restart, so on start and every
  5 min the server checks the sensor and creates it with state `0` (no new record) when it is
  missing; the automation ignores `0`, so a restart never repeats a notification.
- **No false notifications:** a record always arrives as a change from a number — before
  pushing, `publish` creates the sensor with `0` when HA does not have it. So the automation
  can ignore every change that does not start from a number (the sensor appearing after an HA
  restart, `unavailable`, `unknown`); an event pushed again after a restart cannot notify twice.
- **In HA** (set up by hand, not shipped): automation *Trailbook - record notification*
  (`automation.notification_trailbook_record`): state trigger on the sensor (`not_from` /
  `not_to` unavailable, unknown; `not_to` 0), conditions `from_state` exists and is a number,
  state above 0 → `custom_log_event` with the event's title, message, icon, color.

---

## 12b. Home Assistant dashboard cards

- **Made in Trailbook, shown in Home Assistant.** The house icon in the header (beside Settings)
  opens *Home Assistant* with two tabs: **Cards** (the card creator, first) and **Record
  automation** (what §12a sends, and the automation to paste in YAML: a persistent
  notification per record, a comment for a phone).
- **A card** (`ha_cards`, `hacards.py`): id (from the first name, ASCII; it never changes, the
  dashboard names it), name, kind, config (JSON, up to 20 KB). The dashboard holds only:
  ```yaml
  type: custom:trailbook-card
  card: <id>
  ```
  so a change made in Trailbook shows on the dashboard without editing it.
- **Cards tab:** *New card* in the page header (a badge, like Create segment on an activity);
  the page lists a frame for each card made: name (type), a small preview at half size, the
  dashboard text, Edit and Copy (no cards: a short hint). New card and Edit open the
  **creator in a window** over the page (as the workout creator): title (New card / Edit
  card: name), a "Label: value" badge each, the preview under them (it shows every change at
  once: `#/embed/_creator` reads the creator's card), then the buttons: *Delete card* (editing,
  left), *Cancel* and *Create card* / *Save*. Nothing is saved before Create card / Save;
  Cancel or Esc drops the changes. `#/ha/cards?card=<id>` opens that card's window.
- **Theme** (every kind): Light / Dark, the card's own, whatever theme Trailbook or Home
  Assistant shows (a new card starts with Trailbook's; it stays when the type changes). Map ›
  Options › Colours edits the colours of the card's theme.
- **Kinds and their settings:**
  - *Map*: People (any, none = everyone), Period (All time or the time filter's last periods),
    Sport (a group), Layer (Heatmap / Explorer tiles / Squares / Cluster), View (where the map
    starts: All routes / Home area: the routes starting in the half-degree square with the most
    starts / Last activity / Fixed place: the preview's view, set with a button), Zoom (Fit to
    the view's routes, or a level 3–16), Colours (the base map's colours for the card's theme,
    the same as Options › Colours), Move and zoom (on / off), Map buttons (on / off), People button (with Map buttons, default
    off: one person or all — the card's people when it has several, else everyone; a card of one
    person starts on them),
    Height (250–800 px), Options (as Map › Options: base map, colours per theme, relief,
    trails, heatmap, explorer tiles; no regions). A new card starts from the Map tab's options.
    **Map buttons**: icon buttons on the right, in the middle, one under another — what the map
    shows (Heatmap, Explorer tiles, Squares, Cluster), the base map, the shading (and People
    when set); each opens a
    list to its left. They change only what the card shows now; opened again it is back to the
    card's settings.
  - *Activity*: Person (or everyone), Activity (latest, 2nd, 3rd latest), Sport, Values (any of
    distance, time, elapsed time, pace / speed, max speed, avg / max HR, ascent, avg power,
    normalized power, cadence, calories, load, training type, in the order picked), Map
    (the route on a map that does not move, on / off; Base map, Colours (default: the route maps' colours of
    the card's theme) and Shading of its own, and
    the base map and shading buttons on it, for the moment, as on the map card),
    Chart (the tile chart of the training type, on / off). The values in an even grid.
  - *Activity detailed*: Person (or everyone), Activity (latest, 2nd, 3rd latest), Sport, Base
    map, Colours (as on the Activity card), Shading (also as buttons on its map, for the moment), Route colour (the page's Data:
    single colour, speed, heart rate, power, cadence, altitude, surface, intervals; single
    colour when the activity has no such data). The activity's page as a phone shows it (laid out 420 px wide; the Lovelace
    card zooms it to a wider card, up to 1,6 ×, with CSS zoom so nothing is cut; a card given a
    fixed height scrolls inside), dense: the route map on top edge to edge as a square (no Route
    card, no attribution: it covered the scale), then the name, then a small line with the date
    and time (type; person for everyone), then the small cards in rows (the n-th card of each
    column side by side, starting level, small gaps), then the bigger cards and charts clearly
    apart; no header controls, no source files, links do nothing.
  - *Records*: Person, Records (any tables of Statistics › Records, in the order picked: running,
    cycling power, cycling, cycling virtual, walking & hiking, segments), Columns (1–3), Period (all time: the 3 best; a
    period: its best and the best of all time).
  - *Calendar*: Person (or everyone), Weeks (1–6, up to this one), Next week (on / off), Week
    summary (on / off). The Calendar's weeks without its header and panels.
- **The card's page** `#/embed/<id>`: in the card's theme, no header, the card's surface, links do
  nothing. While it loads (from the first paint, `html.embed-page`): no header, a clear
  background (the dashboard card's own), the loader in the middle of the whole card. It tells the frame around it its height (`postMessage` `{trailbook: "size", height,
  fill}`): the map fills the card (at least its Height), the others are as tall as they are.
- **The Lovelace card** (`static/ha/trailbook-card.js`, no dependencies) finds the add-on
  (`supervisor/api` `/addons`, slug `trailbook` or `*_trailbook`), opens an Ingress session
  as the add-on's panel does (`/ingress/session`, cookie `ingress_session`, checked every
  60 s) and shows `ingress_url#/embed/<id>` in a frame. It works wherever Home Assistant opens
  (also remotely and in the app), for **administrators only** (Supervisor API); others see a
  short message.
- **Install** (add-on only, at start; `config.yaml` maps `homeassistant_config`): the card file
  is copied to `/homeassistant/www/trailbook/` when it changed, and registered as a dashboard
  resource `/local/trailbook/trailbook-card.js?v=<hash>` over Home Assistant's websocket API
  (Supervisor proxy, `lovelace/resources` create / update). Dashboards in YAML mode or a failed
  call: Cards shows the resource URL to add by hand. A `www` folder made by Trailbook needs one
  restart of Home Assistant before `/local` serves it; Cards says so.

## 13. Migration to another device (export / restore)

Moving Trailbook to a new server (new HA box, different architecture, fresh install) must be
a single, documented operation.

### Export
- One ZIP archive (`backup.py`):
  ```
  trailbook-export-2026-11-13-201500.zip
  ├── manifest.json        ← format version, Trailbook + schema version, date, people, counts,
  │                          size + sha256 + mtime of every entry, source folder and data source
  ├── trailbook.db         ← consistent snapshot (SQLite online backup API, not a raw file copy)
  └── files/
      ├── root/...         ← watched-folder files not archived yet, same structure (.fit, .gpx,
      │                      .tcx, .gz, .zip: activities, sleep, monitoring and every other FIT)
      └── uploads/...      ← the whole archive, every file: uploads, Garmin downloads, folder
                             copies (_folder/)
  ```
- Settings (people, watches, thresholds, accent, data source...) live in the database, so there
  is no separate `app/` folder. Transient state (import progress) is removed from the snapshot.
- **Secrets:** Garmin access tokens are never exported. API keys only with *Include Garmin API
  keys*; otherwise the restored accounts show *key refused* until the key is entered again.
- Started from Settings › Backup, `POST /api/export` or `trailbook export [--no-files]
  [--include-secrets] [--out DIR]`. Runs as the low-priority job process (only one job — import,
  export or restore — at a time) and streams to disk in 1 MB chunks (ZIP64; FIT deflated, ZIP
  members stored); written as `.part` and renamed when complete.
- Saved in `TRAILBOOK_EXPORT_DIR` (add-on: a folder in `/share`, e.g. `/share/trailbook-exports`),
  default `exports/` next to the database; downloadable and deletable in the UI.
- Option to export without the FIT files (database + settings only) for a small archive.
- Progress goes to `export-progress.json` / `restore-progress.json` next to the database (a
  restore replaces the database itself, so it cannot hold the progress).

### Restore
- Settings › Backup: upload an export or pick one from the list; `trailbook restore ZIP
  [--yes]` from the CLI.
- Steps: validate `manifest.json` → refuse an export from a newer format or schema → refuse an
  install with data unless confirmed → restore every file into the archive (`files/uploads/…`
  into `uploads/`, watched-folder files not archived on the old install `files/root/…` into
  `uploads/_folder/…`), each checked against its size + sha256 and given back its mtime, unsafe
  paths rejected → check the database copy (`PRAGMA integrity_check`) and copy it into the live
  database with the backup API → run migrations if the export is older → point the restored
  folder rows at the archive; keep the watched-folder setting only if that folder exists on
  this device (otherwise it is cleared and chosen in Settings › Data sources) → scan (Garmin
  downloads wait for the next run). Nothing depends on a folder of the old device.
- A damaged archive stops before the database is touched; files already written stay.
- Restoring onto a non-empty install requires explicit confirmation and replaces the database.
- SQLite files and FIT files are architecture-independent, so `amd64` ↔ `aarch64` moves are fine.

### Relation to HA backups
The database lives in the add-on `/data` dir and is part of HA backups of the add-on; the FIT
folder in `/share` is only included if the HA backup includes the share folder. The Trailbook
export is the self-contained way to move everything at once.

API: `GET /api/backup`, `POST /api/export`, `GET/DELETE /api/export/{name}`, `POST /api/restore`
(see section 9).

---

## 14. Milestones

1. **Importer core** *(done)* — FIT parsing, skip non-activities, sport mapping, summary, SQLite,
   import manager (scan, statuses, duplicates, missing), CLI to run it on a PC. Tested on a
   real Garmin export.
2. **API + minimal UI** — activity list and detail with streams. *(done: `trailbook serve`, technical preview UI)*
3. **Map / Heatmap** *(done)* — all routes, heatmap effect, tile proxy, explorer tiles (visited tiles, max square, cluster).
4. **Statistics** *(done)* — thresholds, training load, CTL/ATL/TSB (Fitness), best efforts and
   record curves, totals (Statistics), Calendar.
5. **Add-on** — packaging, Ingress, stdin trigger, multi-arch CI, install on HA Yellow.
6. **Export / restore** *(done; the move to HA Yellow is tested with milestone 5)* — migration ZIP
   (section 13), Settings › Backup, CLI `export` / `restore`.
6a. **Segments** *(done)* — two creators, matching in the importer, list and detail (11a).
7. **UI design pass** — owner's design, i18n EN/PL, docs and screenshots, first public release.

---

## 15. Known gaps (people & files)

- **Folder renamed / files moved** (folder mode): old rows become *missing*, the same files in
  the new place become *duplicates*, and activities stay with the old person. Planned fix:
  treat a *missing* file whose content (sha256) reappears elsewhere as a **move** — transfer
  the row and re-resolve the person.
- **Mode switch / watch re-link does not re-assign** existing activities (by design, see
  section 4). Possible later: an explicit "re-apply rules" action the user starts on purpose.
- **No per-activity person override** yet (needed for a shared watch in shared-folder mode).

## 16. Open questions

- UI framework (Svelte vs. plain TS) — decide at milestone 2 with the design.
- Exact OSMF vector tile/style endpoint and its usage policy for many installations.
- Units: metric only at first, or imperial from the start?
- Should HA receive sensors (weekly distance, last activity, form) — milestone 5 or later?

---

## Credits

Training-load concepts follow publicly documented models
(power-based load, Banister TRIMP and impulse-response model, CTL/ATL/TSB; form zone limits
after Joe Friel). Trailbook uses its own names for them: "load", "weighted power", "intensity".


### Garmin Connect data beyond the FIT file

Activities already here from a FIT file (e.g. from a folder) are matched to Connect activities
by start time (±120 s) and not downloaded again; a GPX/TCX or manual copy (e.g. from Strava)
is not matched, so the FIT is downloaded and replaces it (5.3). The activity-list entry is
kept (`garmin_activities.summary`): title (becomes the name only when the activity has no
title of its own, see Activity name), location, training effect (aerobic /
anaerobic, label), Garmin's training load, Body Battery change, elevation-corrected flag,
BMR calories, intensity minutes. Activity details (one request per activity, within the
download budget) give extra streams kept in `connect_streams` (not dropped on a FIT
reimport): Body Battery, grade adjusted speed and Garmin's elevation, which replaces the
altitude chart when Garmin corrected the elevation. The page shows location after the date,
Training effect and Body Battery as small cards (two columns when there are more than four).
Gear (bike, shoes) is not available through the personal API key (gear-service: 404) and is
not in FIT files.

### Export, corrections and Exclude (activity page)

- **Export** (badge after Create segment, a pick list): *FIT · the whole activity* (the
  activity's own FIT file; written from the stored records, laps and session when it was
  corrected or came as GPX/TCX/Strava) and *GPX · the route only* (positions and altitude, no
  times or heart rate: to send to someone). The file is downloaded, named
  `<local date>-<name>.<fit|gpx>` (ASCII).
- **Edit panel**, at the bottom, rows like the others (label with a short hint, a badge):
  *Altitude › Correct altitude* (spikes smoothed out), *Speed › Correct speed* (GPS jumps
  taken out of positions, speed and distance), *Statistics › Exclude from statistics /
  Include again*. Each asks first; the corrections say the values are replaced for good (only
  a reimport of the file brings them back). How they work: MANUAL › Corrections.
- Corrections are kept in `activities.fixes` (JSON list) and applied again when the file is
  imported again; load, best efforts, segments and the training type are computed again.
- **Excluded** (`activities.excluded`): the activity stays in Activities, Calendar, Map and
  Fitness, but is left out of Statistics (totals, Timeline), records and best efforts (Records,
  the activity page's YTD / ATH columns, record notifications) and has no segment efforts. The
  header shows "Excluded from statistics".

### Segments on the activity page

Segment colour: a dark indigo (`--segment`), used for everything segment-related. Activity
tiles show a small **SEGMENT** badge after the name when the activity rides a segment. Each
segment ridden gets a card before the laps: its static map, a link to the segment and a table
(rank, date, time, speed or pace, avg HR, avg power, behind best) with this activity, the 3
best, the 3 best of the last 12 months and the 2 efforts before this one. The segments are
also rows in Best efforts (time, best this year, all-time best; hover highlights the stretch).
Best efforts: power values span both columns of their group; the tile keeps its natural
width. Small cards: Effect (aerobic / anaerobic training effect on two lines) and Body
Battery whenever Garmin Connect data exists. The height handle of chart and map cards is a
small lozenge with a bar on the card's bottom edge.

### Weather on the activity map

FIT files and the Garmin personal API carry no weather (no weather messages in the files; the
Connect weather service answers 404). It comes from Open-Meteo (`weather.py`, no key): the hour
of the activity at the start point, and for routes over 30 km also the middle and the end
(coordinates rounded to 0.01°; forecast API for the last ~80 days, the archive before), cached
in `activities.weather`. Every activity outdoors (a route, not indoor, not virtual) gets it in
the background too, newest first: 20 activities 3 s apart, then a 2 min pause; a failing server
is left alone for 10 min, doubled with each further failure up to 6 h, a success takes one step
back (`weather.cooldown_left`), and meanwhile an opened activity does not ask either. A small one-line widget top left of the route map: a small sky icon
(by WMO code), the temperature (range when the points differ), rain in mm when there was some,
and the wind: an arrow pointing exactly where it blows, and the speed (no compass letters;
details in the tooltip). The colour legend sits under the widget. Model data for the hour and
the area (~10 km).
On activity maps the © OpenStreetMap attribution sits under the +/- buttons.
Best efforts: the Year and ATH values link to the activity that set them; the tooltip gives
its date.

Small cards: one **Time** card — the timer time (what pace and speed use; Trailbook has no
moving time anywhere), and under it, small, the elapsed time when the two differ by a minute
or more.
Small cards, final order: column 1 Distance, Time, Calories; column 2 Training type (the
workout kind, no longer in the page title), Effect (only Garmin's primary benefit, e.g. "Tempo"; the tooltip
explains just that benefit and gives the aerobic and anaerobic scores), Body Battery.
