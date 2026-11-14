"""Import manager: folder scan, file statuses and the import queue."""

from __future__ import annotations

import hashlib
import os
import sqlite3
import zipfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from . import IMPORTER_VERSION, db, fitfile, geo, sports, streams

TRACK_TOLERANCE_M = 5.0

STATUSES = ("new", "imported", "skipped", "duplicate", "error", "missing", "removed")

# How files are assigned to people (setting `person_mode`):
# - "folders": each first-level subfolder of the root is one person (watches are learned);
# - "devices": one shared folder; the watch serial number decides, unknown watches go to
#   the "Unassigned" person until the user assigns the watch.
PERSON_MODES = ("folders", "devices")
UNASSIGNED = "_unassigned"

# Statuses that describe a finished outcome for a file.
DONE_STATUSES = ("imported", "skipped", "duplicate")


def now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------------------
# Scan
# --------------------------------------------------------------------------------------


@dataclass
class ScanResult:
    scanned: int = 0
    new: int = 0
    changed: int = 0
    missing: int = 0
    returned: int = 0
    new_persons: list[str] = field(default_factory=list)
    ignored: list[str] = field(default_factory=list)


@dataclass
class _Entry:
    person_id: str
    rel_path: str
    zip_member: str
    size: int
    mtime: float


def _walk(root: Path, result: ScanResult, mode: str) -> Iterator[_Entry]:
    """Yield every FIT file (or ZIP member) below `root`.

    "folders" mode: only files inside first-level subfolders count (subfolder = person).
    "devices" mode: every file counts; the person is resolved from the watch at import.
    """
    if mode == "devices":
        yield from _walk_dir(root, root, UNASSIGNED, result)
        return
    with os.scandir(root) as it:
        top = sorted(it, key=lambda e: e.name)
    for person_dir in top:
        if person_dir.name.startswith("."):
            continue
        if not person_dir.is_dir():
            result.ignored.append(person_dir.name)  # files directly in root belong to nobody
            continue
        yield from _walk_dir(root, Path(person_dir.path), person_dir.name, result)


def _walk_dir(root: Path, start: Path, person_id: str, result: ScanResult) -> Iterator[_Entry]:
    for dirpath, dirnames, filenames in os.walk(start):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            lower = name.lower()
            if not (lower.endswith(".fit") or lower.endswith(".zip")):
                continue
            full = os.path.join(dirpath, name)
            st = os.stat(full)
            rel = Path(full).relative_to(root).as_posix()
            if lower.endswith(".fit"):
                yield _Entry(person_id, rel, "", st.st_size, st.st_mtime)
            else:
                yield from _zip_entries(full, person_id, rel, st, result)


def _zip_entries(full: str, person_id: str, rel: str, st: os.stat_result, result: ScanResult):
    try:
        with zipfile.ZipFile(full) as zf:
            members = [
                i.filename
                for i in zf.infolist()
                if not i.is_dir() and i.filename.lower().endswith(".fit")
            ]
    except (zipfile.BadZipFile, OSError):
        result.ignored.append(rel)
        return
    for member in sorted(members):
        # A ZIP member is tracked by the ZIP's own size and mtime.
        yield _Entry(person_id, rel, member, st.st_size, st.st_mtime)


def person_mode(conn: sqlite3.Connection) -> str:
    mode = db.get_setting(conn, "person_mode")
    return mode if mode in PERSON_MODES else "folders"


def ensure_unassigned(conn: sqlite3.Connection) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO persons (id, label) VALUES (?, 'Unassigned')", (UNASSIGNED,)
    )


def scan(conn: sqlite3.Connection, root: str | Path, mode: str | None = None) -> ScanResult:
    """Compare the folder with the `files` table and update statuses.

    Cheap: only `stat` information is used. Hashing and parsing happen in `run_queue`.
    """
    root = Path(root)
    if not root.is_dir():
        raise FileNotFoundError(f"Root folder not found: {root}")
    mode = mode or person_mode(conn)
    if mode == "devices":
        ensure_unassigned(conn)

    result = ScanResult()
    stamp = now_iso()
    known = {
        (r["rel_path"], r["zip_member"]): r for r in conn.execute("SELECT * FROM files").fetchall()
    }
    persons = {r["id"] for r in conn.execute("SELECT id FROM persons")}
    seen: set[tuple[str, str]] = set()

    conn.execute("BEGIN")
    try:
        for e in _walk(root, result, mode):
            result.scanned += 1
            key = (e.rel_path, e.zip_member)
            seen.add(key)

            if e.person_id not in persons and e.person_id != UNASSIGNED:
                conn.execute(
                    "INSERT INTO persons (id, label) VALUES (?, ?)", (e.person_id, e.person_id)
                )
                persons.add(e.person_id)
                result.new_persons.append(e.person_id)

            row = known.get(key)
            if row is None:
                conn.execute(
                    """INSERT INTO files (person_id, rel_path, zip_member, size, mtime,
                                          status, first_seen, last_seen)
                       VALUES (?, ?, ?, ?, ?, 'new', ?, ?)""",
                    (e.person_id, e.rel_path, e.zip_member, e.size, e.mtime, stamp, stamp),
                )
                result.new += 1
                continue

            unchanged = row["size"] == e.size and abs(row["mtime"] - e.mtime) < 1e-3
            if row["status"] == "missing":
                result.returned += 1
                status = row["prev_status"] if unchanged and row["prev_status"] else "new"
                conn.execute(
                    """UPDATE files SET status = ?, prev_status = NULL, missing_since = NULL,
                              dismissed = 0, size = ?, mtime = ?, last_seen = ?,
                              sha256 = CASE WHEN ? = 'new' THEN NULL ELSE sha256 END
                       WHERE id = ?""",
                    (status, e.size, e.mtime, stamp, status, row["id"]),
                )
            elif unchanged:
                # Nothing to write: keeps repeated scans cheap and spares the eMMC/SD card.
                continue
            else:
                result.changed += 1
                conn.execute(
                    """UPDATE files SET status = 'new', sha256 = NULL, error = NULL,
                              skip_reason = NULL, size = ?, mtime = ?, last_seen = ?
                       WHERE id = ?""",
                    (e.size, e.mtime, stamp, row["id"]),
                )

        for key, row in known.items():
            if key not in seen and row["status"] != "missing":
                result.missing += 1
                conn.execute(
                    """UPDATE files SET prev_status = status, status = 'missing',
                              missing_since = ?
                       WHERE id = ?""",
                    (stamp, row["id"]),
                )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return result


# --------------------------------------------------------------------------------------
# Import queue
# --------------------------------------------------------------------------------------


@dataclass
class ImportResult:
    imported: int = 0
    skipped: int = 0
    duplicates: int = 0
    errors: int = 0


ProgressFn = Callable[[int, int, sqlite3.Row, str], None]


def read_file_bytes(root: Path, rel_path: str, zip_member: str) -> bytes:
    path = root / rel_path
    if zip_member:
        with zipfile.ZipFile(path) as zf:
            return zf.read(zip_member)
    return path.read_bytes()


def run_queue(
    conn: sqlite3.Connection,
    root: str | Path,
    progress: ProgressFn | None = None,
    limit: int | None = None,
) -> ImportResult:
    """Process all files with status `new`, oldest first, committing after each file."""
    root = Path(root)
    rows = conn.execute(
        "SELECT * FROM files WHERE status = 'new' ORDER BY mtime, rel_path, zip_member"
    ).fetchall()
    if limit is not None:
        rows = rows[:limit]

    result = ImportResult()
    for i, row in enumerate(rows, start=1):
        outcome = import_file(conn, root, row)
        setattr(result, _RESULT_FIELD[outcome], getattr(result, _RESULT_FIELD[outcome]) + 1)
        if progress:
            progress(i, len(rows), row, outcome)
    return result


_RESULT_FIELD = {
    "imported": "imported",
    "skipped": "skipped",
    "duplicate": "duplicates",
    "error": "errors",
}


def import_file(conn: sqlite3.Connection, root: Path, row: sqlite3.Row) -> str:
    """Import one file row. Returns the resulting status."""
    file_id = row["id"]
    try:
        data = read_file_bytes(root, row["rel_path"], row["zip_member"])
    except (OSError, KeyError, zipfile.BadZipFile) as exc:
        return _set_status(conn, file_id, "error", error=f"cannot read file: {exc}")

    sha = hashlib.sha256(data).hexdigest()
    fid = fitfile.peek_file_id(data)
    person_id = _resolve_person(conn, row, fid)

    # Same bytes already handled under another name: reuse that outcome.
    twin = conn.execute(
        f"""SELECT status, skip_reason, activity_id FROM files
            WHERE sha256 = ? AND id != ? AND status IN {DONE_STATUSES}
            ORDER BY id LIMIT 1""",
        (sha, file_id),
    ).fetchone()
    if twin is not None:
        if twin["status"] == "skipped":
            return _set_status(
                conn, file_id, "skipped", sha=sha, fid=fid, skip_reason=twin["skip_reason"]
            )
        return _set_status(
            conn, file_id, "duplicate", sha=sha, fid=fid, activity_id=twin["activity_id"]
        )

    file_type = fid.type if fid else None
    if file_type is not None and file_type != fitfile.FILE_TYPE_ACTIVITY:
        return _set_status(
            conn,
            file_id,
            "skipped",
            sha=sha,
            fid=fid,
            skip_reason=fitfile.file_type_name(file_type),
        )

    try:
        parsed = fitfile.parse_activity(data)
    except Exception as exc:  # the SDK raises a variety of exception types
        if fid is None:
            return _set_status(conn, file_id, "skipped", sha=sha, skip_reason="not a FIT file")
        return _set_status(
            conn, file_id, "error", sha=sha, fid=fid, error=f"{type(exc).__name__}: {exc}"
        )

    existing = conn.execute(
        "SELECT id FROM activities WHERE fit_uid = ?", (parsed.fit_uid,)
    ).fetchone()
    if existing is not None and existing["id"] != row["activity_id"]:
        return _set_status(
            conn, file_id, "duplicate", sha=sha, fid=fid, fit_uid=parsed.fit_uid,
            activity_id=existing["id"],
        )  # fmt: skip

    conn.execute("BEGIN")
    try:
        activity_id = _store_activity(
            conn, person_id, parsed, existing["id"] if existing else None,
            fid.serial_number if fid else None,
        )  # fmt: skip
        _set_status(
            conn, file_id, "imported", sha=sha, fid=fid, fit_uid=parsed.fit_uid,
            activity_id=activity_id,
        )  # fmt: skip
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return "imported"


def _resolve_person(conn: sqlite3.Connection, row: sqlite3.Row, fid) -> str:
    """Decide who a file belongs to and remember the watch for later.

    Folder mode: the subfolder decides; an unknown watch is linked to that person.
    Device mode: the person linked to the watch decides, otherwise "Unassigned".
    """
    serial = fid.serial_number if fid else None
    person_id = row["person_id"]
    if serial is not None:
        device = conn.execute(
            "SELECT person_id FROM devices WHERE serial = ?", (serial,)
        ).fetchone()
        now = now_iso()
        if device is None:
            learned = person_id if person_id != UNASSIGNED else None
            conn.execute(
                """INSERT INTO devices (serial, person_id, product, first_seen, last_seen)
                   VALUES (?, ?, ?, ?, ?)""",
                (serial, learned, fid.product, now, now),
            )
        else:
            conn.execute(
                "UPDATE devices SET last_seen = ?, product = COALESCE(product, ?) WHERE serial = ?",
                (now, fid.product, serial),
            )
            if person_id == UNASSIGNED and device["person_id"]:
                person_id = device["person_id"]
    conn.execute(
        "UPDATE files SET person_id = ?, device_serial = ? WHERE id = ?",
        (person_id, serial, row["id"]),
    )
    return person_id


def assign_device(conn: sqlite3.Connection, serial: int, person_id: str | None) -> int:
    """Link a watch to a person and move its files and activities there.

    Folder mode: files keep their folder person, so only still-unassigned activities move.
    Device mode: all activities of the watch move. Returns the number of moved activities.
    """
    conn.execute("BEGIN")
    try:
        now = now_iso()
        conn.execute(
            """INSERT INTO devices (serial, person_id, first_seen, last_seen)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(serial) DO UPDATE SET person_id = excluded.person_id""",
            (serial, person_id, now, now),
        )
        if person_id is None:
            ensure_unassigned(conn)
        target = person_id or UNASSIGNED
        extra = " AND person_id = ?" if person_mode(conn) == "folders" else ""
        params = (target, serial, UNASSIGNED) if extra else (target, serial)
        conn.execute(f"UPDATE files SET person_id = ? WHERE device_serial = ?{extra}", params)
        moved = conn.execute(
            f"UPDATE activities SET person_id = ? WHERE device_serial = ?{extra}", params
        ).rowcount
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return moved


def _set_status(
    conn: sqlite3.Connection,
    file_id: int,
    status: str,
    *,
    sha: str | None = None,
    fid: fitfile.FileId | None = None,
    fit_uid: str | None = None,
    skip_reason: str | None = None,
    error: str | None = None,
    activity_id: int | None = None,
) -> str:
    fit_type = fitfile.file_type_name(fid.type) if fid and fid.type is not None else None
    fit_created = (
        fid.time_created.strftime("%Y-%m-%dT%H:%M:%SZ") if fid and fid.time_created else None
    )
    conn.execute(
        """UPDATE files SET status = ?, sha256 = COALESCE(?, sha256), skip_reason = ?,
                  error = ?, activity_id = ?, imported_at = ?,
                  fit_uid = ?, fit_type = ?, fit_created = ?
           WHERE id = ?""",
        (
            status, sha, skip_reason, error, activity_id, now_iso(),
            fit_uid or (fid.fit_uid if fid else None), fit_type, fit_created, file_id,
        ),
    )  # fmt: skip
    return status


_ACTIVITY_COLUMNS = (
    "elapsed_s timer_s moving_s distance_m ascent_m descent_m avg_hr max_hr avg_speed "
    "max_speed avg_power max_power np_power avg_cadence max_cadence calories has_gps "
    "start_lat start_lon bbox_min_lat bbox_min_lon bbox_max_lat bbox_max_lon"
).split()


def _store_activity(
    conn: sqlite3.Connection,
    person_id: str,
    p: fitfile.ParsedActivity,
    replace_id: int | None,
    device_serial: int | None = None,
) -> int:
    values = {
        "person_id": person_id,
        "device_serial": device_serial,
        "fit_uid": p.fit_uid,
        "start_time_utc": p.start_time.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "utc_offset_s": p.utc_offset_s,
        "sport": p.sport,
        "sub_sport": p.sub_sport,
        "category": p.category,
        "activity_type": p.activity_type,
        "indoor": int(p.indoor),
        "name": p.name,
        "device": p.device,
        "importer_version": IMPORTER_VERSION,
        **{c: p.summary.get(c) for c in _ACTIVITY_COLUMNS},
    }

    if replace_id is None:
        cols = ", ".join(values)
        marks = ", ".join("?" for _ in values)
        cur = conn.execute(
            f"INSERT INTO activities ({cols}) VALUES ({marks})", list(values.values())
        )
        activity_id = cur.lastrowid
    else:
        activity_id = replace_id
        current = conn.execute(
            "SELECT type_overridden, name_overridden FROM activities WHERE id = ?",
            (activity_id,),
        ).fetchone()
        if current["type_overridden"]:
            values.pop("category")
            values.pop("activity_type")
        if current["name_overridden"]:
            values.pop("name")
        assignments = ", ".join(f"{c} = ?" for c in values)
        conn.execute(
            f"UPDATE activities SET {assignments} WHERE id = ?", [*values.values(), activity_id]
        )
        for table in ("tracks", "streams", "laps", "best_efforts"):
            conn.execute(f"DELETE FROM {table} WHERE activity_id = ?", (activity_id,))

    if p.track:
        simplified = geo.simplify(p.track, TRACK_TOLERANCE_M)
        conn.execute(
            "INSERT INTO tracks (activity_id, polyline, point_count) VALUES (?, ?, ?)",
            (activity_id, geo.encode_polyline(simplified), len(simplified)),
        )

    for channel, values_list in p.streams.items():
        kind = "f64" if channel in ("lat", "lon", "time") else "f32"
        encoding, blob = streams.encode(values_list, kind)
        conn.execute(
            """INSERT INTO streams (activity_id, channel, encoding, length, data)
               VALUES (?, ?, ?, ?, ?)""",
            (activity_id, channel, encoding, len(values_list), blob),
        )

    for lap in p.laps:
        conn.execute(
            """INSERT INTO laps (activity_id, idx, start_offset_s, elapsed_s, timer_s,
                                 distance_m, avg_hr, max_hr, avg_speed, max_speed, avg_power,
                                 avg_cadence, ascent_m, descent_m, intensity)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                activity_id,
                lap.idx,
                lap.start_offset_s,
                lap.elapsed_s,
                lap.timer_s,
                lap.distance_m,
                lap.avg_hr,
                lap.max_hr,
                lap.avg_speed,
                lap.max_speed,
                lap.avg_power,
                lap.avg_cadence,
                lap.ascent_m,
                lap.descent_m,
                lap.intensity,
            ),
        )
    return activity_id


# --------------------------------------------------------------------------------------
# User decisions
# --------------------------------------------------------------------------------------


def delete_activity(conn: sqlite3.Connection, activity_id: int) -> bool:
    """Delete an activity and its data (user decision).

    Its files get status `removed`, so later scans do not import them again. To import such
    a file again, remove it from the history with `forget_file`.
    """
    conn.execute("BEGIN")
    try:
        conn.execute(
            """UPDATE files
               SET status = CASE WHEN status = 'missing' THEN status ELSE 'removed' END,
                   prev_status = CASE WHEN status = 'missing' THEN 'removed' ELSE prev_status END,
                   dismissed = 1
               WHERE activity_id = ?""",
            (activity_id,),
        )
        cur = conn.execute("DELETE FROM activities WHERE id = ?", (activity_id,))
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return cur.rowcount > 0


def forget_file(conn: sqlite3.Connection, file_id: int) -> bool:
    """Remove a file from the import history, so the next scan treats it as new.

    If the file created an activity, that activity is deleted too (it will be rebuilt when
    the file is imported again). Other files that were duplicates of it are queued again.
    """
    row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
    if row is None:
        return False
    owner = row["status"] == "imported" or (
        row["status"] == "missing" and row["prev_status"] == "imported"
    )
    conn.execute("BEGIN")
    try:
        if owner and row["activity_id"] is not None:
            conn.execute(
                """UPDATE files SET status = 'new', activity_id = NULL
                   WHERE activity_id = ? AND id != ? AND status != 'missing'""",
                (row["activity_id"], file_id),
            )
            conn.execute("DELETE FROM activities WHERE id = ?", (row["activity_id"],))
        conn.execute("DELETE FROM files WHERE id = ?", (file_id,))
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return True


def requeue_outdated(conn: sqlite3.Connection, everything: bool = False) -> int:
    """Queue imported files again so their activities are rebuilt by the current importer.

    Only files that are still on disk are requeued; activities of missing files keep their
    data. User overrides (type, name) survive. Returns the number of queued files.
    """
    sql = """UPDATE files SET status = 'new'
             WHERE status = 'imported' AND activity_id IS NOT NULL"""
    params: tuple = ()
    if not everything:
        sql += " AND activity_id IN (SELECT id FROM activities WHERE importer_version < ?)"
        params = (IMPORTER_VERSION,)
    return conn.execute(sql, params).rowcount


def set_activity_type(conn: sqlite3.Connection, activity_id: int, type_key: str) -> None:
    """User override of the activity type; the group follows the type."""
    t = sports.TYPES[type_key]
    conn.execute(
        """UPDATE activities SET activity_type = ?, category = ?, type_overridden = 1
           WHERE id = ?""",
        (t.key, t.group, activity_id),
    )


def dismiss_missing(conn: sqlite3.Connection, file_id: int) -> None:
    """Acknowledge a missing file and keep its activity data."""
    conn.execute("UPDATE files SET dismissed = 1 WHERE id = ? AND status = 'missing'", (file_id,))
