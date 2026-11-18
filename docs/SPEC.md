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
- Sleep, daily monitoring, HRV and other non-activity FIT data (skipped on import for now;
  the files are archived, so the Wellbeing stage can read them later).
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

Settings › General › *Data connection* chooses where new activities come from (setting
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
     marks the account `auth_error` and it is skipped until a new key is saved; a single
     failing download is recorded (`garmin_activities.status = error`) and not retried.
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
   - Later: sleep, HRV, stress, resting HR, steps, weight for the Wellbeing tab. Stored with
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
   counted from the end of the last run. One sleeping asyncio task in the API process; no
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

**Activity name** = the Garmin Connect title (`activityName`, kept in `garmin_activities`).
FIT files carry no title, so an activity from a folder or upload has no name and the UI
shows its type. When Garmin later delivers the same activity (imported or duplicate), its
title replaces the empty name. A name the user set (`name_overridden`) is never replaced.

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
1. Power TSS: NP (4th-power mean of the 30 s rolling power) + FTP,
   TSS = h × IF² × 100 with IF = NP / FTP.
2. Running pace (rTSS): runs with threshold pace, IF = avg speed / threshold speed.
3. hrTSS: Banister TRIMP per second (HRr × 0.64 e^(1.92 HRr)), scaled so that one hour
   at threshold HR = 100; average HR × moving time when there is no HR stream.
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
Streams are resampled to 1 s; gaps > 10 s break a window. Stored in `best_efforts`; shown on
the activity page and as records + curve in Statistics (all time, last 90 days, per year,
with the all-time curve dashed for comparison). On the activity page each effort is compared
with the person's best **in the same category** (running power is no record for a ride), and
the power curve tooltip shows the date that best was set.

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
power as a share of FTP, "typical" = median of their own activities of the group (moving
power, speed, estimated power, moving time; per-activity medians in `workout_stats`). FTP as
in §7.2 (per sport, correctable per activity). First rule that fits:
1. **Commute** — walks and hikes always; rides that are easy (little time at 90 %+ threshold
   HR, IF < 0.7) and under 45 min or from A to B (end > 1 km from start).
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
   IF ≥ 0.9; no heart rate, no race), at least 95 % of
   the person's best intensity for a similar duration (±25 %, ±365 days) and 3 %+ above
   typical, few stops.
5. **Long** — moving time ≥ 1.5× the person's median, at least 75 min (run) / 150 min (ride).
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
           elapsed_s, moving_s, distance_m, ascent_m, descent_m,
           avg_hr, max_hr, avg_speed, max_speed,
           avg_power, max_power, np_power, avg_cadence, calories,
           load, load_method, has_gps,
           start_lat, start_lon, bbox_min_lat, bbox_min_lon, bbox_max_lat, bbox_max_lon,
           importer_version, created_at)

tracks(activity_id PK, polyline, point_count)
streams(activity_id, channel, encoding, data BLOB, PK(activity_id, channel))
laps(activity_id, idx, start_offset_s, elapsed_s, moving_s, distance_m,
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
                moving_s, avg_speed, avg_hr, max_hr, avg_power, avg_cadence)
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
| GET | `/fitness?person&from&to` | Daily load, CTL, ATL, TSB, ramp rate (CTL change in 7 days); methods; thresholds in use; threshold warnings of the period. |
| GET | `/calendar?from&to&person` | Activities by local day. |
| GET | `/stats/totals?person&by&type&year` | Totals per year / month / week and per group. |
| GET | `/stats/records?person&kind&range&type` | Best effort per distance / duration. |
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
| GET | `/import/files?status=…` | Import manager list. |
| GET | `/backup` | Running job, export / restore progress, exports list (with manifest summary), exports folder, whether the install is empty, default folder for restored files. |
| POST | `/export` | Start an export (`files`, `secrets`). |
| GET/DELETE | `/export/{name}` | Download / delete an export. |
| POST | `/restore?name|confirm&root` | Restore an export from the exports folder (`name`) or from the request body (upload); `confirm=1` needed when the install has data. |
| POST | `/import/files/{id}/retry` | Retry an errored file. |
| POST | `/import/files/{id}/dismiss` | Acknowledge a missing file, keep data. |
| GET | `/tiles/...` | Map tile / style / glyph proxy with disk cache. |

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
- **Waiting**: one loader everywhere (`loaderHtml()`): a cyclist in the accent colour riding along
  a dashed road (wheels turning, the road passing under, a slight bob; still with reduced motion)
  over a small "Loading…". At the end of lists that load more on scroll (activities, segments,
  efforts…) and in a card in place of the page when a page takes over 0,4 s to load (only while
  the old page is still shown).
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
- Person picker: one person or **Everyone**. The first person in the configured order is the
  default (never Everyone). The choice is remembered per browser.
- With **Everyone** selected, Fitness and Statistics are hidden (they are per person) and a
  **Compare** tab appears: people side by side (activities, distance, time, ascent; per group).
- Settings has tabs: **General** (appearance, data connection and its options), **People**
  (label, icon, colour, drag & drop order, watches, thresholds via the pencil), **Imported** (status card +
  file table), **Backup**. Read-only lists are not shown (the activity type list was removed;
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

### Views
| View | Content |
|---|---|
| Activities | KPI row (count, distance, time, ascent, calories for the current filters); Tiles / Charts / List switch (Charts: a rounded card with four bars as its icon). Tile names stay on one line, a long one cut with "…". **Tiles**: the route on a static map (always the Faded light tone), the stats under the title. **Charts**: tiles about 17 % narrower (one more tile per row), the box 25 % lower (120 px), under it only the title and date with the distance and the moving time in two bold lines on the right (no labels); hovering the tile shows the averages in a lighter frame at the top centre, in one row with the training type (left) and the segment (right), cut with "…" when space is short (heart rate, pace on foot or speed, power on rides; no speed for team and racket sports); and in the box a **chart** (`tilechart.py`, no numbers, fills the box, the activity charts' colours; the training type sits in its top left corner on the frame of the map weather widget — translucent surface, blur, soft shadow — instead of in the line under the title). Heart rate blocks — side by side without gaps, width = time, height = average heart rate on a scale from the resting HR (watch, else the person's, else the default) to the maximum HR (Garmin's top zone limit), colour = its Garmin HR zone (green → red; grey below zone 1) under a light vertical gloss (lighter at the top) with a faint shadow along each block's left edge, so two blocks of one zone side by side read as two, a dashed line at the activity's average heart rate (no heart rate but power, e.g. a bike computer without an HR strap: the same blocks from power — height from 0 W to the top of Garmin's power zones, an open last zone ending 10 % above its start; colour = the power zone in the heart rate colours, hysteresis 3 % of the top): **Intervals** — a block per section between the interval lines (the saved ones, else the detected); **Easy, Tempo, Race, team and racket sports** — a block per phase of the session: stretches of one zone (15 s means; the zone changes only when the heart rate is 3 bpm past its limit, so hovering at a limit stays one block; a stretch shorter than 1/12 of the activity, at least 1 min, merged into the neighbour closer in heart rate); **Long** — the same, less sensitive: at least 1/20. **Hills** — the altitude profile along the distance in the altitude green, the climbs between the profile's turning points darker. **Commute and sports without a training type** (motor sports, other, multisport…) — the route alone (no map) as a thick line in the HR zone colours (below zone 1 in the zone 1 colour; no heart rate: one plain zone 1 green) on a plain tinted background, in proportion; without a route the heart rate blocks, else speed, else the sport's icon large and faint. Without the data a kind needs: speed over time. The switch sits at the right of the page title, Tiles first; sortable columns (no filter row; filters are the badges). |
| Activity | Back button; header with type icon, name, start date (smaller, lighter), place (the training type is a tile, §7.6), Charts and Options badges (Options: X axis, power averaging), an **Edit** badge (panel like Map › Options: name — empty = back to the Connect title or the type —, type, kind — Automatic (the detected one) or one of the seven, §7.6 —, FTP for this activity — activities with power, empty = automatic, the automatic value as placeholder, §7.2 —, delete) and **Create segment** (activities with a route; opens the segment creator on this activity). FIT activity files carry no surface type, so the route has no surface colouring. Tiles at the top, each its own card, side by side (flex, wrapping on narrow screens, as low and as even as possible; columns have different widths — power widest, best efforts narrow): first column four small tiles one under another — **Distance**, **Moving time**, **Elapsed time**, **Calories** (active / total; active = total − the resting share the watch writes) — each with a title like a chart title (same font, 18 px icon) and the value below; **Gear** (icon in the title; small pictures; from the FIT `device_info`: the watch or bike computer and the sensors — HR strap, power meter, radar, lights…; a drawing per kind, or the owner's own photo from `<data>/device-images/<product>.png|jpg|webp`, e.g. `edge_850.png`; unknown or older devices show a generic picture; no battery status); **Heart rate in zones** and under it, in the same column, **Surface** (its own tile: a stacked bar in the surface hatching and the share of paved / gravel / dirt / unknown); heart rate zones: (Garmin's time in HR zones from the FIT `time_in_zone` message — one bar per zone with its share; time and zone range on hover; a grey row for the time below zone 1); **Power** (rides only, i.e. a power meter, not running power) as a sliding tile: first the **power curve** (a chart of the standard filling the tile: best average power 5 s … 5 h on a log axis — every duration labelled, a stop counts as 0 W —, this activity filled, the comparison dashed and lightly filled, crosshair with the values; hovering a point highlights that effort on the charts and the map), then **Power in zones**; dots under it switch; **Best efforts** (laurel icon; fastest time per distance — runs 400 m … marathon, rides 5, 10, 20, 30, 40, 50, 100 km and the best 20 min and 1 h power — in columns: distance, time, average speed (rides) or pace (runs) and the best of the comparison under a short header (ATH, Year, 12 mo…), a laurel there when this activity is the best; hovering highlights the stretch on the charts and the map). Best efforts columns: This activity | This year | the comparison. Options › **Compare with** (the last column): All time (default, ATH) | Last 12 months | Last 3 months | Last 30 days, saved per person (`ui_settings` key `activity-compare`); used by the power curve and the best efforts. Zone colours are fixed: HR zones green → red and power zones yellow → violet, the same scales as the route colouring. Titles of all tiles and of the Route card use the chart title font with an icon; the route map is 414 px high. No training load card on this page. Options › **Route lines**: where the route runs twice (out and back) the lines are drawn side by side (default) or on top; saved per person (`ui_settings` key `activity-route-offset`). FIT activity files (Edge included) carry no road surface and no gear (bike, shoes: those live in Garmin Connect only); it comes from OpenStreetMap (`surface.py`): the route is cut into ~1 km boxes, the ways with a highway tag in them are fetched from an Overpass server (`overpass_url` setting, default overpass-api.de; only these boxes are sent), each track point (every 20 m) takes the surface of the nearest way within 25 m (surface tag; without it roads count as paved, tracks by their grade, paths unknown) and the result is cached in `activities.surface` as runs along the distance with shares. Runs shorter than 80 m join their neighbours (no flicker when a few points catch a road beside a gravel path; the stored runs stay point by point, the page gets them smoothed). Settings › General › Road surface: when an activity is opened (default) or all activities slowly in the background (newest first, one at a time with a 15 s pause, 10 min after a server error; setting `surface_mode`). Shown for every activity with a route for now (later maybe only wheeled sports). Hovering a surface kind in its tile highlights all its stretches on the charts and the map. With at most one device the Surface tile shares the Devices column and heart rate zones take a full column. When there is no power tile, a **Heart rate curve** tile (same chart as the power curve: best average HR for 10 s … 1 h, this activity and the comparison) takes its place. Tiles without a value are hidden, and values that belong to a chart (HR, pace, power, cadence, ascent…) live only next to it, even when it is hidden. Route card: Data badge (single colour, speed, heart rate, power / cadence / altitude when recorded, surface — one colour per kind with a legend of the kinds, intervals — interval workouts only: the sections between the chart lines, work orange and recovery grey (work = faster than halfway between the slowest and the fastest section), following the lines as they are moved; 5–95 % range, legend with the scale on the map; HR green → red, power → violet, altitude green → brown like a relief map) and Markers badge (numbered dot in the accent colour every 1 km, every 5 km for rides and activities ≥ 40 km); a distance scale is always on the map; a reset view button (refresh pictogram, in a block like Fullscreen, under it) appears only after the map was moved, zoomed or rotated. Charts right below the map (docs/CHARTS.md), laps (Group badge: every 1, 2, 5 or 10 km — default 1 km, 5 km for rides and activities ≥ 40 km — built from the device auto-laps when they are 1 km long, else cut from the streams; device laps of another kind — manual laps, workout steps — as the extra choice Device laps; rides show speed, runs pace), best efforts. Indoor and virtual activities show no weather on the map; virtual rides and runs show a small **Virtual** frame in its place (top left, the weather frame's style, smaller). |
| Calendar | Month view (Mon–Sun, activity chips with type icon and distance or time, week totals: time, distance, load, count) and year view (12 small month grids coloured by moving time per day); ‹ › and Today; summary strip for the shown month/year. With Everyone: a person dot on each chip. |
| Heatmap | All routes as low-opacity lines; explorer tiles, max square, cluster. |
| Fitness | Header: Time filter, Options (activity icons under the fitness chart, fitness filled / line, fatigue, form zones; saved per person) and a Summary toggle (off when the tab is entered); on the right two toggles with icons (Fitness, Form), each shows or hides its chart, any number may be on (remembered in the browser). A ⚠ icon after the title only when thresholds can distort the load (§7.2). Summary (fitness, fatigue, form with zone, ramp rate, 7-day load) at the end of the period; charts per docs/CHARTS.md (Fitness page): fitness and fatigue lines, and form (fresher = higher), zone bands and the line coloured by its zone; ramp rate (fitness change in 7 days; above 8 too fast, below 0 losing fitness) is only a summary value, as it is the slope of the fitness line. How it is computed lives in Manual › Fitness (no explanation card on the page). |
| Wellbeing | Sleep, stress, heart rate (mostly charts), from the Garmin API; some daily values also in the Calendar. Later stage. |
| Statistics | *Totals*: filter (type, year, group by year/month/week, chart metric), bar chart, table per period (years link to their months), moving time by group. *Records*: running pace / power / heart rate, range all / 90 days / year, curve + table with links to activities. |
| Compare | Everyone side by side (only with “Everyone” selected). |
| Manual (?) | A knowledge base of how Trailbook computes things and how to read them, tabs like Settings: **Training types** (what a training type is, the types with what they do and the recovery, sports and their settings, the detection rules, intervals in detail, relative to you, changing the type, terms) and **Training effect** (what it is, Garmin's aerobic / anaerobic scale, primary benefit with the codes, how to read it, how it relates to the training type, where it is shown). **Weather help** (what the meter shows, which activities, how it is counted with the levels, weights per sport, examples, limits; the weights come from `HELP_PROFILES`, the values the meter uses). **Fitness** (what the charts show, load per activity by method, the fitness model, form and ramp zones, thresholds and the ⚠, terms; constants from `/api/types` › `fitness_rules`, zones from the charts' own tables). Every table is fitted to its content: when every cell fits on one line, the columns keep their natural width and only the last column takes the rest (measured in `fitManualTables`, again on resize); otherwise short columns stay on one line and the text columns share the rest and wrap; row lines run across the card; rules and terms are tables too. A section's text and tables sit 16 px in from its title (the first column without cell padding, so text and tables line up); tiles inside a section are not indented. Built only from the app's existing pieces (grey tiles, ranked rows and panel titles, plain data tables), no colours of its own; the first card holds the contents as tiles that jump to the sections. All of Trailbook's own numbers come from the server (`/api/types`), the same values the code uses; new topics get a tab of their own. |
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
  the data) and `types` (comma list of type keys; `g:<group>` = a whole group), handled by
  one function on the server (`activity_filters`) for every endpoint.
  - *Time*: a range slider with a dot at each end, from the first activity (`GET
    /api/time-range?person=`) to today; under the dots the two dates in small muted numbers
    (no dash between them) — a click on the year, month or day makes that number editable in
    place, without a box (digits only, Enter keeps it, Escape cancels, the day is clipped to
    the month); under that one chip per year (and *All time*) to pick a whole year. The badge shows *All time*, the year, or `from – to`.
  - *Type*: the panel is the list itself — a checkbox per type with its icon and count,
    under a small heading per group; the heading of a group with more than one type is itself
    a checkbox that selects the whole group (half-checked when only some types are); only types with
    activities of the selected person. The badge shows *All*, the group, one or two type
    names, or *n types*. In Records › Running pace the type is fixed (running) and the badge
    is hidden.
  Action buttons in Settings have the same size (30 px high, 13 px semibold): the primary ones
  stay blue, the others are outlined like the filter buttons; selects and the file picker
  line up at 30 px.
  Calendar and Fitness have no filters: their time is the page navigation (month / year,
  range switch). Name and person stay as column filters in the Activities list.
- The main switch (e.g. Heatmap | Explorer tiles, List | Tiles | Large tiles, settings tabs)
  looks like the main navigation: no box, the selected option on a light tint in the accent
  colour.
- The vertical scrollbar is always shown (`html { overflow-y: scroll }`), so nothing jumps
  when a page gets long and the header ends at the scrollbar; the full-screen map has no
  scrollbar and shifts header and bar by the measured scrollbar width to line up.
- The heatmap / explorer tiles page is called **Map** in the navigation and its title.
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
  - Base map: OpenStreetMap (default), OpenTopoMap, CyclOSM or none; colours: faded light
    (default), original, muted, grayscale, soft dark, slate, dusk, dark (high contrast). The
    soft dark tones lift blacks and lower contrast so routes stand out without a harsh map.
  - Heatmap: style (density, coverage, heat glow), colour (presets or any colour from a
    colour wheel; gradient for heat glow; a colour per person for Everyone), line width,
    overlap strength.
  - Explorer tiles: size (zoom 13 large squares, 14 explorer tiles, 16 medium, 17
    small squares), style (coverage / by visits), colours, display (single tiles / one area),
    highlights (max square, cluster, routes on top of tiles).
  Colour, width and strength changes only update paint properties (instant); the map starts
  directly at the data bounds (no world-view jump).
- All choices are saved per browser and separately per mode, so switching between heatmap
  and tiles restores each mode's colours.
- Tiles, max square and cluster on this page are computed **in the browser** from the route
  polylines for the chosen tile size; the server stores zoom-14 tiles per activity for
  statistics. MapLibre has no blend modes, so overlapping people are not colour-mixed.

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
  1. Prefilter in SQL: activity bbox contains the segment start and end (+ ~50 m), group fits.
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
     steep ramp stays one way even under 30 m.
  5. Effort values: elapsed time (the ranking), moving time, average speed, max speed (from
     the speed stream), average / max HR, average power and cadence over the slice, start time.
  `segments.match_version` / `activities.segments_version` (0 = to do) say what is done; a new
  or changed segment is matched against all activities, a new or reimported activity (or a
  type change) against all segments. ~ms per candidate on the CM4.
- **List** (`#/segments`): *New segment* (from map / from activity), cards in two columns
  (one on a phone). A card has a small static map (OSM tiles from the tile cache as
  `<image>` elements + the line in SVG — never one WebGL map per card, browsers allow ~16),
  name, distance, ascent, number of efforts, the best effort with its date and the last
  effort with its time, pace/speed, average and max HR, power. Options: show segments
  without efforts of the selected person.
- **Detail** (`#/segment/{id}`): header like an activity — group icon, name, then the date
  and place of the source activity (small, links to it); badges Time, Type (only the types
  of this segment's efforts in the period, with counts), **Edit** (name, Counts: *<group>
  only* — every type of the group — or *Any activity type*, Delete segment) and **Summary**
  (shows the strip under the map: distance, ascent, grade, direction (one way / both ways
  with the end vs start altitude), efforts, best, average, median;
  on by default, saved per person, `ui_settings` key `segment-summary`). Route card (title
  with icon, 414 px map), Last effort and Best effort cards (tile titles with icons, values
  as small tiles), **Trend** chart (docs/CHARTS.md: every effort's time over the Time
  filter, faster higher; Best / Avg / Last on the right), top 10 and all efforts (50 at a
  time; Date and Time headers sort) with the activity list's icon headers: Avg speed and Max
  speed (on foot: Avg pace, Best pace), Avg HR, Max HR, Avg power only when an effort has it. With Everyone also a table per person (best, average, efforts, last).
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
- One ZIP archive (`backup.py`):
  ```
  trailbook-export-2026-11-13-201500.zip
  ├── manifest.json        ← format version, Trailbook + schema version, date, people, counts,
  │                          size + sha256 + mtime of every entry, source folder and data source
  ├── trailbook.db         ← consistent snapshot (SQLite online backup API, not a raw file copy)
  └── files/
      ├── root/...         ← watched-folder files not archived yet, same structure
      └── uploads/...      ← the archive: uploads, Garmin downloads, folder copies (_folder/)
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
  this device (otherwise it is cleared and chosen in Settings › General) → scan (Garmin
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
(TSS, TRIMP, CTL/ATL/TSB).


### Garmin Connect data beyond the FIT file

Activities already here (e.g. from a folder) are matched to Connect activities by start time
(±90 s) and not downloaded again; their activity-list entry is kept (`garmin_activities.summary`):
title (becomes the name unless the user set one), location, training effect (aerobic /
anaerobic, label), Garmin's training load, Body Battery change, elevation-corrected flag,
BMR calories, intensity minutes. Activity details (one request per activity, within the
download budget) give extra streams kept in `connect_streams` (not dropped on a FIT
reimport): Body Battery, grade adjusted speed and Garmin's elevation, which replaces the
altitude chart when Garmin corrected the elevation. The page shows location after the date,
Training effect and Body Battery as small cards (two columns when there are more than four).
Gear (bike, shoes) is not available through the personal API key (gear-service: 404) and is
not in FIT files.

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
in `activities.weather`. A small one-line widget top left of the route map: a small sky icon
(by WMO code), the temperature (range when the points differ), rain in mm when there was some,
and the wind: an arrow pointing exactly where it blows, and the speed (no compass letters;
details in the tooltip). The colour legend sits under the widget. Model data for the hour and
the area (~10 km).
On activity maps the © OpenStreetMap attribution sits under the +/- buttons.
Best efforts: the Year and ATH values link to the activity that set them; the tooltip gives
its date.

Small cards: one **Time** card — moving time (what pace and speed use), and under it, small,
the elapsed time when the two differ by a minute or more.
Small cards, final order: column 1 Distance, Time, Calories; column 2 Training type (the
workout kind, no longer in the page title), Effect (only Garmin's primary benefit, e.g. "Tempo"; the tooltip
explains just that benefit and gives the aerobic and anaerobic scores), Body Battery.
