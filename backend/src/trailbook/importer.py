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

from . import IMPORTER_VERSION, fitfile, geo, sports, streams

TRACK_TOLERANCE_M = 5.0

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


def _walk(root: Path, result: ScanResult) -> Iterator[_Entry]:
    """Yield every FIT file (or ZIP member) below the person folders of `root`."""
    with os.scandir(root) as it:
        top = sorted(it, key=lambda e: e.name)
    for person_dir in top:
        if person_dir.name.startswith("."):
            continue
        if not person_dir.is_dir():
            result.ignored.append(person_dir.name)  # files directly in root belong to nobody
            continue
        person_id = person_dir.name
        for dirpath, dirnames, filenames in os.walk(person_dir.path):
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


def scan(conn: sqlite3.Connection, root: str | Path) -> ScanResult:
    """Compare the folder with the `files` table and update statuses.

    Cheap: only `stat` information is used. Hashing and parsing happen in `run_queue`.
    """
    root = Path(root)
    if not root.is_dir():
        raise FileNotFoundError(f"Root folder not found: {root}")

    result = ScanResult()
    stamp = now_iso()
    known = {
        (r["rel_path"], r["zip_member"]): r for r in conn.execute("SELECT * FROM files").fetchall()
    }
    persons = {r["id"] for r in conn.execute("SELECT id FROM persons")}
    seen: set[tuple[str, str]] = set()

    conn.execute("BEGIN")
    try:
        for e in _walk(root, result):
            result.scanned += 1
            key = (e.rel_path, e.zip_member)
            seen.add(key)

            if e.person_id not in persons:
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
                conn.execute("UPDATE files SET last_seen = ? WHERE id = ?", (stamp, row["id"]))
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

    # Same bytes already handled under another name: reuse that outcome.
    twin = conn.execute(
        f"""SELECT status, skip_reason, activity_id FROM files
            WHERE sha256 = ? AND id != ? AND status IN {DONE_STATUSES}
            ORDER BY id LIMIT 1""",
        (sha, file_id),
    ).fetchone()
    if twin is not None:
        if twin["status"] == "skipped":
            return _set_status(conn, file_id, "skipped", sha=sha, skip_reason=twin["skip_reason"])
        return _set_status(conn, file_id, "duplicate", sha=sha, activity_id=twin["activity_id"])

    file_type = fitfile.peek_file_type(data)
    if file_type is not None and file_type != fitfile.FILE_TYPE_ACTIVITY:
        return _set_status(
            conn, file_id, "skipped", sha=sha, skip_reason=fitfile.file_type_name(file_type)
        )

    try:
        parsed = fitfile.parse_activity(data)
    except Exception as exc:  # the SDK raises a variety of exception types
        if file_type is None:
            return _set_status(conn, file_id, "skipped", sha=sha, skip_reason="not a FIT file")
        return _set_status(conn, file_id, "error", sha=sha, error=f"{type(exc).__name__}: {exc}")

    existing = conn.execute(
        "SELECT id FROM activities WHERE fit_uid = ?", (parsed.fit_uid,)
    ).fetchone()
    if existing is not None and existing["id"] != row["activity_id"]:
        return _set_status(conn, file_id, "duplicate", sha=sha, activity_id=existing["id"])

    conn.execute("BEGIN")
    try:
        activity_id = _store_activity(
            conn, row["person_id"], parsed, existing["id"] if existing else None
        )
        _set_status(conn, file_id, "imported", sha=sha, activity_id=activity_id)
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return "imported"


def _set_status(
    conn: sqlite3.Connection,
    file_id: int,
    status: str,
    *,
    sha: str | None = None,
    skip_reason: str | None = None,
    error: str | None = None,
    activity_id: int | None = None,
) -> str:
    conn.execute(
        """UPDATE files SET status = ?, sha256 = COALESCE(?, sha256), skip_reason = ?,
                  error = ?, activity_id = ?, imported_at = ?
           WHERE id = ?""",
        (status, sha, skip_reason, error, activity_id, now_iso(), file_id),
    )
    return status


_ACTIVITY_COLUMNS = (
    "elapsed_s timer_s moving_s distance_m ascent_m descent_m avg_hr max_hr avg_speed "
    "max_speed avg_power max_power np_power avg_cadence max_cadence calories has_gps "
    "start_lat start_lon bbox_min_lat bbox_min_lon bbox_max_lat bbox_max_lon"
).split()


def _store_activity(
    conn: sqlite3.Connection, person_id: str, p: fitfile.ParsedActivity, replace_id: int | None
) -> int:
    values = {
        "person_id": person_id,
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
    """Delete an activity and its data. Linked file rows keep their status history."""
    conn.execute("BEGIN")
    try:
        conn.execute(
            "UPDATE files SET activity_id = NULL, dismissed = 1 WHERE activity_id = ?",
            (activity_id,),
        )
        cur = conn.execute("DELETE FROM activities WHERE id = ?", (activity_id,))
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return cur.rowcount > 0


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
