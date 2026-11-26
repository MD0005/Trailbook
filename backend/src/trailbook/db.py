"""SQLite connection and schema migrations."""

from __future__ import annotations

import sqlite3
from pathlib import Path

# Each entry migrates the schema from version i to i + 1. Never edit a released entry;
# append a new one instead.
MIGRATIONS: list[str] = [
    # v1 — initial schema
    """
    CREATE TABLE persons (
        id          TEXT PRIMARY KEY,           -- folder name
        label       TEXT NOT NULL,
        color       TEXT,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        archived    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE person_thresholds (
        person_id       TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
        valid_from      TEXT NOT NULL,          -- YYYY-MM-DD
        hr_max          INTEGER,
        hr_rest         INTEGER,
        lthr            INTEGER,
        ftp             INTEGER,
        threshold_pace  REAL,                   -- s/km
        swim_css        REAL,                   -- s/100 m
        weight          REAL,                   -- kg
        PRIMARY KEY (person_id, valid_from)
    );

    CREATE TABLE activities (
        id                  INTEGER PRIMARY KEY,
        person_id           TEXT NOT NULL REFERENCES persons(id),
        fit_uid             TEXT NOT NULL UNIQUE,
        start_time_utc      TEXT NOT NULL,      -- ISO 8601, UTC
        utc_offset_s        INTEGER,            -- local time = UTC + offset
        sport               TEXT,               -- raw FIT sport
        sub_sport           TEXT,               -- raw FIT sub_sport
        category            TEXT NOT NULL,      -- group, see sports.GROUPS
        activity_type       TEXT NOT NULL,      -- see sports.TYPES
        indoor              INTEGER NOT NULL DEFAULT 0,
        type_overridden     INTEGER NOT NULL DEFAULT 0, -- user changed type, keep on reimport
        name                TEXT,
        name_overridden     INTEGER NOT NULL DEFAULT 0,
        device              TEXT,
        elapsed_s           REAL,
        timer_s             REAL,
        moving_s            REAL,
        distance_m          REAL,
        ascent_m            REAL,
        descent_m           REAL,
        avg_hr              INTEGER,
        max_hr              INTEGER,
        avg_speed           REAL,               -- m/s
        max_speed           REAL,
        avg_power           INTEGER,
        max_power           INTEGER,
        np_power            INTEGER,
        avg_cadence         REAL,               -- spm for on-foot sports, rpm otherwise
        max_cadence         REAL,
        calories            INTEGER,
        load                REAL,
        load_method         TEXT,
        has_gps             INTEGER NOT NULL DEFAULT 0,
        start_lat           REAL,
        start_lon           REAL,
        bbox_min_lat        REAL,
        bbox_min_lon        REAL,
        bbox_max_lat        REAL,
        bbox_max_lon        REAL,
        importer_version    INTEGER NOT NULL,
        created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE INDEX ix_activities_person_time ON activities(person_id, start_time_utc);
    CREATE INDEX ix_activities_person_cat ON activities(person_id, category);
    CREATE INDEX ix_activities_person_type ON activities(person_id, activity_type);

    CREATE TABLE files (
        id              INTEGER PRIMARY KEY,
        person_id       TEXT NOT NULL REFERENCES persons(id),
        rel_path        TEXT NOT NULL,          -- where the bytes are read, see v9
        zip_member      TEXT NOT NULL DEFAULT '',
        size            INTEGER NOT NULL,
        mtime           REAL NOT NULL,
        sha256          TEXT,
        status          TEXT NOT NULL,          -- see importer.STATUSES
        prev_status     TEXT,                   -- status before going missing
        skip_reason     TEXT,
        error           TEXT,
        activity_id     INTEGER REFERENCES activities(id) ON DELETE SET NULL,
        first_seen      TEXT NOT NULL,
        last_seen       TEXT NOT NULL,
        missing_since   TEXT,
        dismissed       INTEGER NOT NULL DEFAULT 0,
        imported_at     TEXT,
        UNIQUE (rel_path, zip_member)
    );
    CREATE INDEX ix_files_status ON files(status);
    CREATE INDEX ix_files_sha ON files(sha256);

    CREATE TABLE tracks (
        activity_id INTEGER PRIMARY KEY REFERENCES activities(id) ON DELETE CASCADE,
        polyline    TEXT NOT NULL,
        point_count INTEGER NOT NULL
    );

    CREATE TABLE streams (
        activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        channel     TEXT NOT NULL,
        encoding    TEXT NOT NULL,              -- e.g. 'zlib-f32le'
        length      INTEGER NOT NULL,
        data        BLOB NOT NULL,
        PRIMARY KEY (activity_id, channel)
    );

    CREATE TABLE laps (
        activity_id     INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        idx             INTEGER NOT NULL,
        start_offset_s  REAL,
        elapsed_s       REAL,
        timer_s         REAL,
        distance_m      REAL,
        avg_hr          INTEGER,
        max_hr          INTEGER,
        avg_speed       REAL,
        max_speed       REAL,
        avg_power       INTEGER,
        avg_cadence     REAL,
        ascent_m        REAL,
        descent_m       REAL,
        intensity       TEXT,
        PRIMARY KEY (activity_id, idx)
    );

    CREATE TABLE best_efforts (
        activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL,              -- power|pace|hr
        key         REAL NOT NULL,              -- seconds or metres
        value       REAL NOT NULL,
        PRIMARY KEY (activity_id, kind, key)
    );
    CREATE INDEX ix_best_efforts ON best_efforts(kind, key, value);

    CREATE TABLE daily_load (
        person_id   TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
        date        TEXT NOT NULL,
        load        REAL NOT NULL,
        ctl         REAL,
        atl         REAL,
        tsb         REAL,
        PRIMARY KEY (person_id, date)
    );

    CREATE TABLE import_runs (
        id          INTEGER PRIMARY KEY,
        started_at  TEXT NOT NULL,
        finished_at TEXT,
        trigger     TEXT NOT NULL,
        scanned     INTEGER NOT NULL DEFAULT 0,
        new         INTEGER NOT NULL DEFAULT 0,
        imported    INTEGER NOT NULL DEFAULT 0,
        skipped     INTEGER NOT NULL DEFAULT 0,
        duplicates  INTEGER NOT NULL DEFAULT 0,
        errors      INTEGER NOT NULL DEFAULT 0,
        missing     INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE settings (
        key     TEXT PRIMARY KEY,
        value   TEXT
    );
    """,
    # v2 — FIT file_id of every file (also skipped ones), shown in the import manager.
    # Status 'removed' (activity deleted by the user) needs no schema change.
    """
    ALTER TABLE files ADD COLUMN fit_uid TEXT;
    ALTER TABLE files ADD COLUMN fit_type TEXT;
    ALTER TABLE files ADD COLUMN fit_created TEXT;
    CREATE INDEX ix_files_fit_uid ON files(fit_uid);
    """,
    # v3 — watches (FIT serial numbers) linked to people, so one shared folder can hold
    # files of several people.
    """
    CREATE TABLE devices (
        serial      INTEGER PRIMARY KEY,
        person_id   TEXT REFERENCES persons(id) ON DELETE SET NULL,
        product     TEXT,
        label       TEXT,
        first_seen  TEXT NOT NULL,
        last_seen   TEXT NOT NULL
    );
    ALTER TABLE files ADD COLUMN device_serial INTEGER;
    ALTER TABLE activities ADD COLUMN device_serial INTEGER;
    CREATE INDEX ix_files_device ON files(device_serial);
    CREATE INDEX ix_activities_device ON activities(device_serial);
    UPDATE files SET device_serial = CAST(substr(fit_uid, 3, instr(fit_uid, ':') - 3) AS INTEGER)
        WHERE fit_uid LIKE 'sn%';
    UPDATE activities
        SET device_serial = CAST(substr(fit_uid, 3, instr(fit_uid, ':') - 3) AS INTEGER)
        WHERE fit_uid LIKE 'sn%';
    INSERT OR IGNORE INTO devices (serial, person_id, first_seen, last_seen)
        SELECT device_serial, MIN(person_id), MIN(first_seen), MAX(first_seen) FROM files
        WHERE device_serial IS NOT NULL GROUP BY device_serial;
    """,
    # v4 — people get a display order (drag & drop) and an icon for the person picker.
    """
    ALTER TABLE persons ADD COLUMN sort_order INTEGER;
    ALTER TABLE persons ADD COLUMN icon TEXT;
    UPDATE persons SET sort_order = (
        SELECT COUNT(*) FROM persons p2 WHERE p2.rowid <= persons.rowid);
    """,
    # v5 — explorer tiles (zoom 14) visited by each activity.
    """
    CREATE TABLE activity_tiles (
        activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        x           INTEGER NOT NULL,
        y           INTEGER NOT NULL,
        PRIMARY KEY (activity_id, x, y)
    ) WITHOUT ROWID;
    CREATE INDEX ix_activity_tiles_xy ON activity_tiles(x, y);
    ALTER TABLE activities ADD COLUMN tiles_version INTEGER NOT NULL DEFAULT 0;
    """,
    # v6 — Garmin Connect personal API: one account (key) per person and the activities
    # already downloaded, so nothing is fetched twice.
    """
    CREATE TABLE garmin_accounts (
        person_id       TEXT PRIMARY KEY REFERENCES persons(id) ON DELETE CASCADE,
        api_key         TEXT NOT NULL,
        key_hint        TEXT,
        history_from    TEXT,                   -- YYYY-MM-DD, NULL = whole history
        token           TEXT,
        token_expires   TEXT,
        status          TEXT NOT NULL DEFAULT 'new',  -- new / ok / error / auth_error
        last_error      TEXT,
        last_sync_at    TEXT,
        backfill_offset INTEGER NOT NULL DEFAULT 0,
        backfill_done   INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL
    );
    CREATE TABLE garmin_activities (
        person_id   TEXT NOT NULL,
        activity_id INTEGER NOT NULL,
        start_gmt   TEXT,
        name        TEXT,
        type_key    TEXT,
        status      TEXT NOT NULL,              -- downloaded / error
        file_rel    TEXT,
        error       TEXT,
        fetched_at  TEXT NOT NULL,
        PRIMARY KEY (person_id, activity_id)
    ) WITHOUT ROWID;
    """,
    # v7 — analysis (training load, best efforts) is computed after import from the stored
    # streams; this version says which analysis an activity has (0 = not yet).
    """
    ALTER TABLE activities ADD COLUMN analysis_version INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX ix_activities_analysis ON activities(analysis_version);
    """,
    # v8 — segments (shared by the install) and the efforts found in activities.
    """
    CREATE TABLE segments (
        id                  INTEGER PRIMARY KEY,
        name                TEXT NOT NULL,
        category            TEXT,               -- activity group matched, NULL = any
        polyline            TEXT NOT NULL,      -- encoded, simplified to ~2 m
        point_count         INTEGER NOT NULL,
        distance_m          REAL NOT NULL,
        ascent_m            REAL,
        start_lat           REAL NOT NULL,
        start_lon           REAL NOT NULL,
        end_lat             REAL NOT NULL,
        end_lon             REAL NOT NULL,
        bbox_min_lat        REAL NOT NULL,
        bbox_min_lon        REAL NOT NULL,
        bbox_max_lat        REAL NOT NULL,
        bbox_max_lon        REAL NOT NULL,
        source              TEXT NOT NULL,      -- activity | map
        source_activity_id  INTEGER REFERENCES activities(id) ON DELETE SET NULL,
        match_version       INTEGER NOT NULL DEFAULT 0,  -- 0 = match against all activities
        created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE segment_efforts (
        id              INTEGER PRIMARY KEY,
        segment_id      INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
        activity_id     INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        start_time_utc  TEXT NOT NULL,
        start_s         REAL NOT NULL,          -- offsets in the activity time stream
        end_s           REAL NOT NULL,
        elapsed_s       REAL NOT NULL,
        moving_s        REAL,
        avg_speed       REAL,                   -- m/s, segment length / elapsed
        avg_hr          REAL,
        max_hr          REAL,
        avg_power       REAL,
        avg_cadence     REAL
    );
    CREATE INDEX ix_segment_efforts_seg ON segment_efforts(segment_id, elapsed_s);
    CREATE INDEX ix_segment_efforts_act ON segment_efforts(activity_id);
    ALTER TABLE activities ADD COLUMN segments_version INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX ix_activities_segments ON activities(segments_version);
    """,
    # v9 — one archive for every source: files of the watched folder are copied into the
    # archive next to the database (like uploads and Garmin downloads). `source_rel` is the
    # path in the watched folder (NULL for uploads / Garmin); `rel_path` is where the bytes
    # are read from: '@uploads/_folder/<source_rel>' once archived, `source_rel` until then.
    """
    ALTER TABLE files ADD COLUMN source_rel TEXT;
    UPDATE files SET source_rel = rel_path WHERE rel_path NOT LIKE '@uploads/%';
    CREATE INDEX ix_files_source ON files(source_rel);
    """,
    # v10 — thresholds the watch used for each activity (from the FIT file: HR max, resting
    # HR, threshold HR, FTP, weight); `watch_version` < importer.WATCH_VERSION = not read
    # yet. `load_estimated` = the load used an estimated or default threshold.
    """
    ALTER TABLE activities ADD COLUMN watch_hr_max INTEGER;
    ALTER TABLE activities ADD COLUMN watch_hr_rest INTEGER;
    ALTER TABLE activities ADD COLUMN watch_lthr INTEGER;
    ALTER TABLE activities ADD COLUMN watch_ftp INTEGER;
    ALTER TABLE activities ADD COLUMN watch_weight REAL;
    ALTER TABLE activities ADD COLUMN watch_version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE activities ADD COLUMN load_estimated INTEGER NOT NULL DEFAULT 0;
    """,
    # v11 — activity names come from Garmin Connect titles only (the FIT sport profile name
    # is no longer used); unnamed activities show their type. Names the user set are kept.
    """
    UPDATE activities SET name = (
        SELECT g.name FROM files f
        JOIN garmin_activities g ON g.person_id = f.person_id AND g.file_rel = f.rel_path
        WHERE f.activity_id = activities.id AND COALESCE(g.name, '') != ''
        ORDER BY f.id LIMIT 1)
    WHERE name_overridden = 0;
    """,
    # v12 — UI settings the user changes (e.g. Map options), per person ('all' = Everyone),
    # stored on the server so they follow the person to every device. Value = JSON text.
    """
    CREATE TABLE ui_settings (
        person_id   TEXT NOT NULL,
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (person_id, key)
    ) WITHOUT ROWID;
    """,
    # v13 — workout step target per lap (structured workouts): stream and range.
    """
    ALTER TABLE laps ADD COLUMN target TEXT;
    ALTER TABLE laps ADD COLUMN target_low REAL;
    ALTER TABLE laps ADD COLUMN target_high REAL;
    """,
    # v14 — Garmin's time in HR / power zones (JSON, see fitfile.time_in_zones) and the
    # resting share of the calories (active = calories - metabolic_calories).
    """
    ALTER TABLE activities ADD COLUMN zones TEXT;
    ALTER TABLE activities ADD COLUMN metabolic_calories INTEGER;
    """,
    # v15 — where each best effort happened (seconds from the start) and the devices that
    # recorded the activity (JSON list, see fitfile.devices).
    """
    ALTER TABLE best_efforts ADD COLUMN start_s REAL;
    ALTER TABLE best_efforts ADD COLUMN end_s REAL;
    ALTER TABLE activities ADD COLUMN devices TEXT;
    UPDATE activities SET analysis_version = 0;
    """,
    # v16 — road surface along the route from OpenStreetMap (JSON, see surface.py), cached.
    """
    ALTER TABLE activities ADD COLUMN surface TEXT;
    """,
    # v17 — Garmin Connect data that FIT files do not have: the activity list entry (JSON:
    # training effect, body battery, location, elevation correction…), the local activity it
    # belongs to (also for activities imported from a folder: matched by start time, nothing
    # downloaded) and extra streams from the activity details (kept apart from `streams`, so
    # a reimport of the FIT file does not drop them).
    """
    ALTER TABLE garmin_activities ADD COLUMN summary TEXT;
    ALTER TABLE garmin_activities ADD COLUMN trailbook_id INTEGER;
    ALTER TABLE garmin_activities ADD COLUMN details_at TEXT;
    CREATE TABLE connect_streams (
        activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        channel     TEXT NOT NULL,
        encoding    TEXT NOT NULL,
        length      INTEGER NOT NULL,
        data        BLOB NOT NULL,
        PRIMARY KEY (activity_id, channel)
    );
    """,
    # v18 — workout kind (see workout.py): detected kind with the reason and the interval
    # bouts (JSON), the person's choice (kept on reimport; NULL = the detected one), the
    # per-activity medians the person's history is built from (JSON) and the detector version.
    """
    ALTER TABLE activities ADD COLUMN workout TEXT;
    ALTER TABLE activities ADD COLUMN workout_detail TEXT;
    ALTER TABLE activities ADD COLUMN workout_override TEXT;
    ALTER TABLE activities ADD COLUMN workout_stats TEXT;
    ALTER TABLE activities ADD COLUMN workout_version INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX ix_activities_workout ON activities(workout_version);
    """,
    # v19 — weather during the activity from Open-Meteo (JSON, see weather.py), cached.
    """
    ALTER TABLE activities ADD COLUMN weather TEXT;
    """,
    # v20 — segments: the end altitude minus the start altitude (flat segments count in both
    # directions), the top speed of an effort and whether it was ridden the other way.
    """
    ALTER TABLE segments ADD COLUMN net_climb_m REAL;
    ALTER TABLE segment_efforts ADD COLUMN max_speed REAL;
    ALTER TABLE segment_efforts ADD COLUMN reverse INTEGER NOT NULL DEFAULT 0;
    """,
    # v21 — FTP the person set for one activity (its file has none or a wrong one; NULL = the
    # file's or the person's FTP, see analysis.activity_thresholds). Kept on reimport.
    """
    ALTER TABLE activities ADD COLUMN ftp_override INTEGER;
    """,
    # v22 — section lines the person moved, added or removed on the activity charts (JSON:
    # {"kind": "intervals" | "hills", "splits": [seconds from the start]}). NULL = the detected
    # ones. Kept on reimport; dropped when the training type no longer matches the kind.
    """
    ALTER TABLE activities ADD COLUMN section_lines TEXT;
    """,
    # v23 — description of an activity (Strava export); NULL = none.
    """
    ALTER TABLE activities ADD COLUMN description TEXT;
    """,
    # v24 — where the name comes from: 'file' (the activity file or Strava's activities.csv)
    # or 'garmin' (Garmin Connect title, used only when no file gave one); NULL = no name or
    # the user's own (name_overridden). Garmin Connect links to GPX/TCX copies and Strava's
    # manual activities are dropped and the history is read again, so the FIT is downloaded
    # and replaces the copy (see importer.COPY_UID_SQL).
    """
    ALTER TABLE activities ADD COLUMN name_source TEXT;
    UPDATE activities SET name_source = CASE WHEN EXISTS (
            SELECT 1 FROM files f
            JOIN garmin_activities g ON g.person_id = f.person_id AND g.file_rel = f.rel_path
            WHERE f.activity_id = activities.id AND g.name = activities.name
        ) OR EXISTS (
            SELECT 1 FROM garmin_activities g
            WHERE g.trailbook_id = activities.id AND g.name = activities.name
        ) THEN 'garmin' ELSE 'file' END
    WHERE name IS NOT NULL AND name_overridden = 0;
    UPDATE garmin_accounts SET backfill_done = 0, backfill_offset = 0
    WHERE person_id IN (
        SELECT g.person_id FROM garmin_activities g JOIN activities a ON a.id = g.trailbook_id
        WHERE g.status = 'matched'
          AND (a.fit_uid LIKE 'gpx:%' OR a.fit_uid LIKE 'tcx:%' OR a.fit_uid LIKE 'strava:%'));
    DELETE FROM garmin_activities
    WHERE status = 'matched' AND trailbook_id IN (
        SELECT id FROM activities
        WHERE fit_uid LIKE 'gpx:%' OR fit_uid LIKE 'tcx:%' OR fit_uid LIKE 'strava:%');
    """,
    # v25 — a refused Garmin key: since when (first refusal, kept while it lasts) and when it
    # was last tried again (every few hours). Accounts refused before this start now.
    """
    ALTER TABLE garmin_accounts ADD COLUMN auth_error_since TEXT;
    ALTER TABLE garmin_accounts ADD COLUMN auth_checked_at TEXT;
    UPDATE garmin_accounts SET auth_error_since = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
        auth_checked_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE status = 'auth_error';
    """,
    # v26 — daily values from the watch's monitoring files (steps, ascent, stress; see
    # fitfile.parse_monitoring), one row per file, day and metric: running totals keep the
    # file's largest value, stress the sum of the readings and their count. The person is the
    # file's (it follows the file). The monitoring files skipped so far are read again.
    """
    CREATE TABLE daily_parts (
        file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        day         TEXT NOT NULL,
        metric      TEXT NOT NULL,
        value       REAL NOT NULL,
        n           INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (file_id, day, metric)
    );
    CREATE INDEX daily_parts_day ON daily_parts(day);
    UPDATE files SET status = 'new'
    WHERE status = 'skipped' AND fit_type IN ('monitoring_a', 'monitoring_b');
    """,
    # v27 — Garmin Connect daily summary of each day (JSON as Garmin sends it: steps, floors,
    # stress, resting HR, Body Battery…; see garmin.fetch_days). It wins over the values read
    # from monitoring files. `days_from` = oldest day asked for so far, `days_done` = the
    # history of days is complete.
    """
    CREATE TABLE garmin_days (
        person_id   TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
        day         TEXT NOT NULL,
        summary     TEXT NOT NULL,
        fetched_at  TEXT NOT NULL,
        PRIMARY KEY (person_id, day)
    );
    ALTER TABLE garmin_accounts ADD COLUMN days_from TEXT;
    ALTER TABLE garmin_accounts ADD COLUMN days_done INTEGER NOT NULL DEFAULT 0;
    """,
    # v28 — newest day asked for (`days_to`): the next run also asks for every day since, so
    # days missed while the server was off are filled.
    """
    ALTER TABLE garmin_accounts ADD COLUMN days_to TEXT;
    """,
    # v29 — segments: both directions chosen by the person: 'auto' (flat segments), 'on', 'off'.
    """
    ALTER TABLE segments ADD COLUMN two_way_mode TEXT NOT NULL DEFAULT 'auto';
    """,
    # v30 — planned workouts (planner.py) and the intervals.icu key that sends them on to
    # Garmin (icu.py). `planned_workouts` keeps a copy of the workout as it was placed;
    # sync_state: pending (sent when send_after has passed) / sent / error / delete (removed
    # here, still to be removed from intervals.icu).
    """
    CREATE TABLE icu_accounts (
        person_id   TEXT PRIMARY KEY REFERENCES persons(id) ON DELETE CASCADE,
        api_key     TEXT NOT NULL,
        key_hint    TEXT,
        athlete_id  TEXT,
        athlete     TEXT,
        status      TEXT NOT NULL DEFAULT 'new',
        last_error  TEXT,
        checked_at  TEXT,
        created_at  TEXT NOT NULL
    );
    CREATE TABLE workout_templates (
        id          INTEGER PRIMARY KEY,
        person_id   TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
        position    INTEGER NOT NULL DEFAULT 0,
        name        TEXT NOT NULL,
        sport       TEXT NOT NULL,
        target      TEXT NOT NULL,
        steps       TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );
    CREATE TABLE planned_workouts (
        id            INTEGER PRIMARY KEY,
        person_id     TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
        day           TEXT NOT NULL,
        template_id   INTEGER,
        name          TEXT NOT NULL,
        sport         TEXT NOT NULL,
        target        TEXT NOT NULL,
        steps         TEXT NOT NULL,
        sync_state    TEXT NOT NULL DEFAULT 'pending',
        send_after    TEXT,
        icu_event_id  TEXT,
        sync_error    TEXT,
        sent_at       TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
    );
    CREATE INDEX planned_person_day ON planned_workouts(person_id, day);
    """,
    # v31 — team, racket, gym… sports: moving time = timer time (sports.TIMER_TIME_GROUPS);
    # their load and training type are computed again.
    """
    UPDATE activities SET moving_s = timer_s, analysis_version = 0, workout_version = 0
    WHERE timer_s IS NOT NULL
      AND category IN ('team', 'racket', 'fitness', 'mind_body', 'climbing', 'combat');
    """,
    # v32 — Garmin Connect's moving time (`movingDuration`) is kept with the list data: the
    # history of each account is read again (list pages only; nothing is downloaded twice).
    """
    UPDATE garmin_accounts SET backfill_offset = 0, backfill_done = 0;
    """,
    # v33 — no moving time anywhere: an activity's time (`moving_s`) is the timer time (pauses
    # on the watch left out), next to the elapsed time; load and training type again.
    """
    UPDATE activities SET moving_s = COALESCE(timer_s, elapsed_s), analysis_version = 0,
           workout_version = 0
    WHERE moving_s IS NOT COALESCE(timer_s, elapsed_s);
    """,
    # v34 — the column says what it holds: `time_s` (the timer time); segment efforts keep only
    # their elapsed time (no moving time anywhere).
    """
    ALTER TABLE activities RENAME COLUMN moving_s TO time_s;
    ALTER TABLE segment_efforts DROP COLUMN moving_s;
    """,
    # v35 — record events for Home Assistant (records.py): an activity is checked for new
    # top-3 places once; everything imported so far counts as checked.
    """
    ALTER TABLE activities ADD COLUMN records_seen INTEGER NOT NULL DEFAULT 0;
    UPDATE activities SET records_seen = 1;
    CREATE TABLE record_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at  TEXT NOT NULL,
        person_id   TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
        activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        data        TEXT NOT NULL,              -- the event as JSON (records.refresh)
        pushed_at   TEXT                        -- sent to Home Assistant (records.publish)
    );
    """,
    # v36 — how loosely a segment matches (segments.py): the corridor's half width and one
    # detour, per segment; NULL = the defaults.
    """
    ALTER TABLE segments ADD COLUMN match_width_m REAL;
    ALTER TABLE segments ADD COLUMN match_detour_m REAL;
    """,
    # v37 — a type the person chose sets indoor too (records of virtual and indoor rides apart,
    # run load by pace): activities changed before got the indoor flag of their file.
    """
    UPDATE activities SET indoor = activity_type IN ('treadmill_run', 'indoor_run',
           'virtual_run', 'indoor_ride', 'spin', 'virtual_ride', 'pool_swim', 'indoor_walk',
           'ski_indoor', 'gym_equipment', 'elliptical', 'stair_stepper', 'indoor_row',
           'indoor_climb', 'esports'), analysis_version = 0
    WHERE type_overridden = 1;
    """,
    # v38 — files from intervals.icu prepared for download (icufiles.py): per person on/off and
    # the first day looked at; one row per intervals.icu activity looked at, so none is fetched
    # twice. state: ready (file waiting) / delete (downloaded, still to be removed from
    # intervals.icu) / done / skipped (not a file to prepare).
    """
    ALTER TABLE icu_accounts ADD COLUMN files_on INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE icu_accounts ADD COLUMN files_from TEXT;
    CREATE TABLE icu_files (
        person_id   TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
        icu_id      TEXT NOT NULL,
        name        TEXT,
        start_local TEXT,
        state       TEXT NOT NULL,
        path        TEXT,
        error       TEXT,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (person_id, icu_id)
    );
    """,
    # v39 — training apps list their sensors without a source type (fitfile.devices): the
    # files of virtual activities are imported again to get them.
    """
    UPDATE files SET status = 'new'
    WHERE status = 'imported' AND activity_id IN (
        SELECT id FROM activities WHERE activity_type LIKE 'virtual%');
    """,
    # v40 — the country of the route (ISO 3166 alpha-3 as in static/regions; NULL: no GPS, at
    # sea or an app's made-up world), set by the analysis (countries.py).
    """
    ALTER TABLE activities ADD COLUMN country TEXT;
    """,
    # v41 — walks and hikes get best efforts too (Statistics › Records: the biggest climb, the
    # steepest 1 km and the steps from the cadence): analysed again.
    """
    UPDATE activities SET analysis_version = 0 WHERE category IN ('walk', 'hike');
    """,
    # v42 — Home Assistant dashboard cards made in Home Assistant › Cards (hacards.py): the
    # dashboard names a card by its id, the look and the data come from `config` (JSON).
    """
    CREATE TABLE ha_cards (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        kind        TEXT NOT NULL,
        config      TEXT NOT NULL,
        position    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    );
    """,
    # v43 — Garmin's own values of an activity read from its FIT file (training effect, training
    # load, recovery time; importer.backfill_metrics): shown when Garmin Connect has none.
    """
    ALTER TABLE activities ADD COLUMN fit_metrics TEXT;
    ALTER TABLE activities ADD COLUMN metrics_version INTEGER NOT NULL DEFAULT 0;
    """,
    # v44 — corrections the person made (fixes.py; JSON list: "altitude", "speed"), applied
    # again on reimport; `excluded`: left out of the statistics, records and segment efforts.
    """
    ALTER TABLE activities ADD COLUMN fixes TEXT;
    ALTER TABLE activities ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0;
    """,
    # v45 — weigh-ins of scale FIT files (file type weight; fitfile.parse_weight), for
    # Wellbeing › Body: one row per measurement, composition NULL when the scale did not measure
    # it. `body_version`: the file was read (importer.backfill_body for files skipped before).
    """
    CREATE TABLE body_parts (
        file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        ts          TEXT NOT NULL,           -- UTC, ISO
        weight      REAL NOT NULL,           -- kg
        fat_pct     REAL,
        water_pct   REAL,
        muscle_kg   REAL,
        bone_kg     REAL,
        bmi         REAL,
        PRIMARY KEY (file_id, ts)
    );
    CREATE INDEX body_parts_ts ON body_parts(ts);
    ALTER TABLE files ADD COLUMN body_version INTEGER NOT NULL DEFAULT 0;
    """,
    # v46 — a person's sex (Settings › People: "male" | "female", NULL: not set), for the
    # silhouette of Wellbeing › Body.
    """
    ALTER TABLE persons ADD COLUMN sex TEXT;
    """,
    # v47 — weigh-ins from Garmin Connect (garmin.fetch_weights), one row per weigh-in, the
    # composition NULL when not measured; `weights_from` / `weights_to`: the days asked for so
    # far (the history is filled backwards like the daily summaries).
    """
    CREATE TABLE garmin_weights (
        person_id   TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
        ts          TEXT NOT NULL,           -- UTC, ISO
        weight      REAL NOT NULL,           -- kg
        fat_pct     REAL,
        water_pct   REAL,
        muscle_kg   REAL,
        bone_kg     REAL,
        bmi         REAL,
        source      TEXT,                    -- Garmin's sourceType (INDEX_SCALE, MANUAL, …)
        fetched_at  TEXT NOT NULL,
        PRIMARY KEY (person_id, ts)
    );
    ALTER TABLE garmin_accounts ADD COLUMN weights_from TEXT;
    ALTER TABLE garmin_accounts ADD COLUMN weights_to TEXT;
    """,
    # v48 — activities two people did together (together.py), cached per pair and radius:
    # `signature` names the versions of both recordings, `result` is JSON (NULL: never together).
    """
    CREATE TABLE together_cache (
        a_id        INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        b_id        INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
        radius_m    INTEGER NOT NULL,
        signature   TEXT NOT NULL,
        result      TEXT,
        PRIMARY KEY (a_id, b_id, radius_m)
    ) WITHOUT ROWID;
    CREATE INDEX together_cache_b ON together_cache(b_id);
    """,
]

SCHEMA_VERSION = len(MIGRATIONS)


def connect(path: str | Path, *, apply_migrations: bool = True) -> sqlite3.Connection:
    """Open the database (applying pending migrations by default) and return the connection.

    The API server migrates once at start-up and then opens short-lived connections per
    request with `apply_migrations=False`.
    """
    path = Path(path)
    if str(path) != ":memory:":
        path.parent.mkdir(parents=True, exist_ok=True)
    # Explicit transactions; the API may use a connection from a worker thread.
    conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 10000")  # importer and API write concurrently
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA synchronous = NORMAL")
    if apply_migrations:
        migrate(conn)
    return conn


def get_setting(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_setting(conn: sqlite3.Connection, key: str, value: str | None) -> None:
    conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, value))


def schema_version(conn: sqlite3.Connection) -> int:
    return conn.execute("PRAGMA user_version").fetchone()[0]


def migrate(conn: sqlite3.Connection) -> None:
    current = schema_version(conn)
    if current > SCHEMA_VERSION:
        raise RuntimeError(
            f"Database schema v{current} is newer than this Trailbook (v{SCHEMA_VERSION})."
        )
    for version in range(current, SCHEMA_VERSION):
        conn.execute("BEGIN")
        try:
            for statement in _split_sql(MIGRATIONS[version]):
                conn.execute(statement)
            conn.execute(f"PRAGMA user_version = {version + 1}")
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise


def _split_sql(script: str) -> list[str]:
    # Migrations contain no semicolons inside literals, so a plain split is enough.
    return [s.strip() for s in script.split(";") if s.strip()]
