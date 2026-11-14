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
        rel_path        TEXT NOT NULL,          -- relative to root, '/' separators
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
