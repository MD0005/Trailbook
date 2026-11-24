"""Import manager: folder scan, file statuses and the import queue."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import sqlite3
import zipfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path

from . import IMPORTER_VERSION, db, explorer, fitfile, geo, sports, strava, streams, trackfile

log = logging.getLogger("trailbook.import")

TRACK_TOLERANCE_M = 5.0

# Bump when the tile computation changes; activities are then re-tiled from stored streams.
TILES_VERSION = 2  # 2: tiles whose corner the line cuts count too
WATCH_VERSION = 1  # watch thresholds read from the FIT file, see backfill_watch
METRICS_VERSION = 1  # Garmin's values read from the FIT file, see backfill_metrics

STATUSES = ("new", "imported", "skipped", "duplicate", "error", "missing", "removed")

# How files are assigned to people (setting `person_mode`):
# - "folders": each first-level subfolder of the root is one person (watches are learned);
# - "devices": one shared folder; the watch serial number decides, unknown watches go to
#   the "Unassigned" person until the user assigns the watch.
PERSON_MODES = ("folders", "devices")

# Where new data comes from (setting `data_source`): a watched folder, one-time ZIP/FIT
# uploads, or the Garmin Connect personal API. Every source ends in the same archive: the
# `uploads` folder next to the database, tracked in `files` with this path prefix. Garmin
# downloads and uploads are saved there directly; files of the watched folder are copied
# there by `archive_folder` (under `_folder/`, same layout), so later importer versions can
# always re-read every file, even after it was deleted from the folder.
DATA_SOURCES = ("folder", "upload", "garmin")
UPLOADS_PREFIX = "@uploads/"
FOLDER_ARCHIVE = "_folder"
UNASSIGNED = "_unassigned"

# Files read in folders, ZIPs and uploads: FIT, GPX and TCX, also gzipped (Strava exports).
ACTIVITY_SUFFIXES = trackfile.ACTIVITY_SUFFIXES
# Two activities of one person that start this close are the same activity (e.g. a Strava
# copy of a watch activity). Used for imports and for Garmin Connect matching.
SAME_START_S = 120
# Activities that do not come from a FIT file: GPX/TCX files and Strava's manual activities
# (see trackfile and strava: their fit_uid starts with these). They are copies with less
# data, so a FIT recording of the same activity replaces them, whichever arrives first.
COPY_UID_PREFIXES = ("gpx:", "tcx:", "strava:")
COPY_UID_SQL = "(fit_uid LIKE 'gpx:%' OR fit_uid LIKE 'tcx:%' OR fit_uid LIKE 'strava:%')"

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

    "folders" mode: a first-level subfolder is the person; files lying directly in the root
    are resolved from the watch at import (like "devices" mode).
    "devices" mode: every file is resolved from the watch at import.
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
            # Files directly in the root have no folder person: the watch decides.
            yield from _file_entries(root, person_dir.path, person_dir.name, UNASSIGNED, result)
            continue
        yield from _walk_dir(root, Path(person_dir.path), person_dir.name, result)


def _walk_dir(root: Path, start: Path, person_id: str, result: ScanResult) -> Iterator[_Entry]:
    for dirpath, dirnames, filenames in os.walk(start):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            yield from _file_entries(root, os.path.join(dirpath, name), name, person_id, result)


def _file_entries(
    root: Path, full: str, name: str, person_id: str, result: ScanResult
) -> Iterator[_Entry]:
    lower = name.lower()
    if not lower.endswith((*ACTIVITY_SUFFIXES, ".zip")):
        return
    st = os.stat(full)
    rel = Path(full).relative_to(root).as_posix()
    if lower.endswith(".zip"):
        yield from _zip_entries(full, person_id, rel, st, result)
    else:
        yield _Entry(person_id, rel, "", st.st_size, st.st_mtime)


def _zip_entries(full: str, person_id: str, rel: str, st: os.stat_result, result: ScanResult):
    try:
        with zipfile.ZipFile(full) as zf:
            members = zip_members(zf)
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
        "INSERT OR IGNORE INTO persons (id, label, sort_order) VALUES (?, 'Unassigned', 100000)",
        (UNASSIGNED,),
    )


def scan(conn: sqlite3.Connection, root: str | Path, mode: str | None = None) -> ScanResult:
    """Compare the folder with the `files` table and update statuses.

    Cheap: only `stat` information is used. Hashing and parsing happen in `run_queue`.
    """
    root = Path(root)
    if not root.is_dir():
        raise FileNotFoundError(f"Root folder not found: {root}")
    mode = mode or person_mode(conn)

    result = ScanResult()
    stamp = now_iso()
    known = {
        (r["source_rel"], r["zip_member"]): r
        for r in conn.execute("SELECT * FROM files WHERE source_rel IS NOT NULL").fetchall()
    }
    persons = {r["id"] for r in conn.execute("SELECT id FROM persons")}
    seen: set[tuple[str, str]] = set()

    conn.execute("BEGIN")
    try:
        for e in _walk(root, result, mode):
            result.scanned += 1
            key = (e.rel_path, e.zip_member)
            seen.add(key)

            if e.person_id not in persons and e.person_id == UNASSIGNED:
                ensure_unassigned(conn)
                persons.add(UNASSIGNED)
            elif e.person_id not in persons:
                conn.execute(
                    """INSERT INTO persons (id, label, sort_order)
                       VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM persons))""",
                    (e.person_id, e.person_id),
                )
                persons.add(e.person_id)
                result.new_persons.append(e.person_id)

            row = known.get(key)
            if row is None:
                conn.execute(
                    """INSERT INTO files (person_id, rel_path, source_rel, zip_member, size,
                                          mtime, status, first_seen, last_seen)
                       VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?)""",
                    (
                        e.person_id, e.rel_path, e.rel_path, e.zip_member, e.size, e.mtime,
                        stamp, stamp,
                    ),
                )  # fmt: skip
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
                # Changed in the folder: read it from the folder and archive the new version.
                result.changed += 1
                conn.execute(
                    """UPDATE files SET status = 'new', sha256 = NULL, error = NULL,
                              skip_reason = NULL, size = ?, mtime = ?, last_seen = ?,
                              rel_path = source_rel
                       WHERE id = ?""",
                    (e.size, e.mtime, stamp, row["id"]),
                )

        for key, row in known.items():
            if row["rel_path"].startswith(UPLOADS_PREFIX):
                continue  # archived: gone from the folder, but nothing is lost
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


def folder_archive_rel(source_rel: str) -> str:
    """`files.rel_path` of the archived copy of a watched-folder file."""
    return f"{UPLOADS_PREFIX}{FOLDER_ARCHIVE}/{source_rel}"


def archive_folder(
    conn: sqlite3.Connection,
    root: str | Path | None,
    uploads_dir: Path,
    progress: Callable[[int, int, str], None] | None = None,
) -> int:
    """Copy watched-folder files that are not archived yet into the archive.

    Every file is kept (activities, but also sleep, monitoring and other files skipped
    today), so a later importer can read it again. A ZIP is copied once for all its members.
    The copy keeps the file's mtime and is written as `.part` and renamed when complete.
    Files that vanished before they were copied are left to the scan (`missing`).
    Returns the number of files copied.
    """
    if not root:
        return 0
    root = Path(root)
    pending = [
        r[0]
        for r in conn.execute(
            """SELECT DISTINCT source_rel FROM files
               WHERE source_rel IS NOT NULL AND rel_path = source_rel AND status != 'missing'
               ORDER BY source_rel"""
        )
    ]
    copied = 0
    for i, source_rel in enumerate(pending, start=1):
        src = root / source_rel
        if src.is_file():
            target = uploads_dir / FOLDER_ARCHIVE / source_rel
            target.parent.mkdir(parents=True, exist_ok=True)
            part = target.with_name(target.name + ".part")
            shutil.copy2(src, part)
            os.replace(part, target)
            conn.execute(
                "UPDATE files SET rel_path = ? WHERE source_rel = ? AND rel_path = source_rel",
                (folder_archive_rel(source_rel), source_rel),
            )
            copied += 1
        if progress:
            progress(i, len(pending), source_rel)
    return copied


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


WATCH_FIELDS = ("hr_max", "hr_rest", "lthr", "ftp", "weight")


def backfill_watch(
    conn: sqlite3.Connection, root: Path | None, uploads_dir: Path | None = None, progress=None
) -> int:
    """Read the watch thresholds of activities imported before they were stored. Each file
    is decoded once; an activity whose file cannot be read is marked done without values.
    The load of an activity that got values is computed again."""
    rows = conn.execute(
        """SELECT a.id, f.rel_path, f.zip_member FROM activities a
           LEFT JOIN files f ON f.id = (SELECT MIN(id) FROM files
                                        WHERE activity_id = a.id AND status = 'imported')
           WHERE a.watch_version < ?""",
        (WATCH_VERSION,),
    ).fetchall()
    for i, r in enumerate(rows, start=1):
        values: dict = {}
        if r["rel_path"]:
            try:
                data = read_file_bytes(root, r["rel_path"], r["zip_member"] or "", uploads_dir)
                values = fitfile.parse_watch_thresholds(data)
            except Exception:  # missing file or a decoder error: keep the activity as it is
                values = {}
        found = any(v is not None for v in values.values())
        conn.execute(
            f"""UPDATE activities SET {", ".join(f"watch_{k} = ?" for k in WATCH_FIELDS)},
                       watch_version = ?{", analysis_version = 0" if found else ""}
                WHERE id = ?""",
            (*(values.get(k) for k in WATCH_FIELDS), WATCH_VERSION, r["id"]),
        )
        if progress:
            progress(i, len(rows))
    return len(rows)


def backfill_metrics(
    conn: sqlite3.Connection, root: Path | None, uploads_dir: Path | None = None, progress=None
) -> int:
    """Garmin's own values of each activity from its FIT file (training effect, training load,
    recovery time; fitfile.garmin_metrics), once per activity: new ones after their import,
    older ones the first time. Nothing else of the activity changes."""
    rows = conn.execute(
        """SELECT a.id, f.rel_path, f.zip_member FROM activities a
           LEFT JOIN files f ON f.id = (SELECT MIN(id) FROM files
                                        WHERE activity_id = a.id AND status = 'imported')
           WHERE a.metrics_version < ?""",
        (METRICS_VERSION,),
    ).fetchall()
    for i, r in enumerate(rows, start=1):
        values: dict = {}
        if r["rel_path"] and not strava.is_manual(r["zip_member"] or ""):
            try:
                data = read_file_bytes(root, r["rel_path"], r["zip_member"] or "", uploads_dir)
                if trackfile.kind(data) == "fit":
                    values = fitfile.parse_garmin_metrics(data)
            except Exception:  # missing file or a decoder error: no values
                values = {}
        conn.execute(
            "UPDATE activities SET fit_metrics = ?, metrics_version = ? WHERE id = ?",
            (json.dumps(values) if values else None, METRICS_VERSION, r["id"]),
        )
        if progress:
            progress(i, len(rows))
    return len(rows)


def zip_members(zf: zipfile.ZipFile) -> list[str]:
    """Activities in a ZIP: activity files (Garmin or Strava export, a ZIP of files) and
    the manual activities of a Strava export's activities.csv."""
    files = [
        i.filename for i in zf.infolist()
        if not i.is_dir() and i.filename.lower().endswith(ACTIVITY_SUFFIXES)
    ]  # fmt: skip
    try:
        manual = strava.manual_members(strava.read_zip(zf))
    except (KeyError, UnicodeError, ValueError):
        manual = []
    return sorted(files + manual)


def read_file_bytes(
    root: Path | None, rel_path: str, zip_member: str, uploads_dir: Path | None = None
) -> bytes:
    if rel_path.startswith(UPLOADS_PREFIX):
        if uploads_dir is None:
            raise OSError("uploads folder unknown")
        path = uploads_dir / rel_path[len(UPLOADS_PREFIX) :]
    elif root is None:
        raise OSError("no watched folder configured")
    else:
        path = root / rel_path
    if zip_member:
        with zipfile.ZipFile(path) as zf:
            data = zf.read(zip_member)
    else:
        data = path.read_bytes()
    return trackfile.gunzip(data)


def _file_path(rel: str, root: Path | None, uploads_dir: Path | None) -> Path | None:
    if rel.startswith(UPLOADS_PREFIX):
        return uploads_dir / rel[len(UPLOADS_PREFIX) :] if uploads_dir else None
    return root / rel if root else None


def _store_tiles(conn: sqlite3.Connection, activity_id: int, lats: list, lons: list) -> int:
    tiles = explorer.tiles_of_track(lats, lons) if lats and lons else set()
    conn.execute("DELETE FROM activity_tiles WHERE activity_id = ?", (activity_id,))
    conn.executemany(
        "INSERT INTO activity_tiles (activity_id, x, y) VALUES (?, ?, ?)",
        [(activity_id, x, y) for x, y in tiles],
    )
    conn.execute(
        "UPDATE activities SET tiles_version = ? WHERE id = ?", (TILES_VERSION, activity_id)
    )
    return len(tiles)


def backfill_tiles(conn: sqlite3.Connection, progress=None) -> int:
    """Compute explorer tiles for activities that have none yet, from stored GPS streams.

    No FIT file is read, so this also works for activities whose file is gone.
    """
    ids = [
        r[0]
        for r in conn.execute(
            "SELECT id FROM activities WHERE has_gps = 1 AND tiles_version < ?", (TILES_VERSION,)
        )
    ]
    for i, activity_id in enumerate(ids, start=1):
        rows = {
            r["channel"]: streams.decode(r["encoding"], r["data"])
            for r in conn.execute(
                """SELECT channel, encoding, data FROM streams
                   WHERE activity_id = ? AND channel IN ('lat', 'lon')""",
                (activity_id,),
            )
        }
        conn.execute("BEGIN")
        try:
            _store_tiles(conn, activity_id, rows.get("lat", []), rows.get("lon", []))
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        if progress:
            progress(i, len(ids))
    return len(ids)


def register_upload(
    conn: sqlite3.Connection,
    uploads_dir: Path,
    person_id: str,
    path: Path,
    date_from: str | None = None,
    date_to: str | None = None,
) -> int:
    """Queue an uploaded activity file or ZIP (already saved under `uploads_dir`).

    `date_from` / `date_to` (YYYY-MM-DD, both ends included): of a Strava export only the
    activities whose date in activities.csv is in the range; members without a date are kept.
    A Strava export is then cut down to the queued files and its activities.csv (photos and
    the activities left out are not kept); an upload with nothing to import is deleted."""
    rel = UPLOADS_PREFIX + path.relative_to(uploads_dir).as_posix()
    csv_name = None
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as zf:
            members = zip_members(zf)
            csv_name = strava.find_csv(zf.namelist())
            if date_from or date_to:
                try:
                    rows = strava.read_zip(zf)
                except (KeyError, UnicodeError, ValueError):
                    rows = {}

                def inside(m: str) -> bool:
                    row = rows.get(m)
                    if row is None or row.start is None:
                        return True
                    day = row.start.date().isoformat()
                    return (not date_from or day >= date_from) and (not date_to or day <= date_to)

                members = [m for m in members if inside(m)]
        if not members:
            path.unlink(missing_ok=True)
            return 0
        if csv_name:
            _trim_zip(path, {*members, csv_name})
    else:
        members = [""]
    st = path.stat()
    stamp = now_iso()
    conn.executemany(
        """INSERT OR IGNORE INTO files (person_id, rel_path, zip_member, size, mtime, status,
                                         first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?, 'new', ?, ?)""",
        [(person_id, rel, m, st.st_size, st.st_mtime, stamp, stamp) for m in members],
    )
    return len(members)


def _trim_zip(path: Path, keep: set[str]) -> None:
    """Rewrite a ZIP with only the members in `keep` (copied as they are, not recompressed)."""
    with zipfile.ZipFile(path) as zf:
        infos = [i for i in zf.infolist() if i.filename in keep]
        if len(infos) == len(zf.infolist()):
            return
        tmp = path.with_suffix(".trim.tmp")
        with zipfile.ZipFile(tmp, "w") as out:
            for info in infos:
                with (
                    zf.open(info) as src,
                    out.open(info, "w", force_zip64=info.file_size > 0x7FFFFFFF) as dst,
                ):
                    shutil.copyfileobj(src, dst, 1 << 20)
    os.replace(tmp, path)


def prune_uploads(conn: sqlite3.Connection, uploads_dir: Path) -> int:
    """After an import: drop from the person's own uploads the copies of activities already
    there (duplicate). Skipped files and errors stay: a later version may read them (Strava's
    TCX files with spaces before <?xml were once skipped as damaged). A ZIP keeps the
    rest (and its activities.csv); an upload with nothing left is deleted. Garmin downloads and
    watched-folder copies are left alone. Returns the number of files dropped."""
    prunable = "(status = 'duplicate')"
    uploads = [
        r[0] for r in conn.execute(
            f"""SELECT DISTINCT rel_path FROM files f
                WHERE rel_path LIKE ? AND source_rel IS NULL AND {prunable}
                  AND NOT EXISTS (SELECT 1 FROM files n WHERE n.rel_path = f.rel_path
                                  AND n.status = 'new')
                  AND rel_path NOT IN (SELECT file_rel FROM garmin_activities
                                       WHERE file_rel IS NOT NULL)""",
            (UPLOADS_PREFIX + "%",),
        )
    ]  # fmt: skip
    dropped = 0
    for rel in uploads:
        if rel.startswith(f"{UPLOADS_PREFIX}{FOLDER_ARCHIVE}/"):
            continue
        rows = conn.execute(
            f"SELECT id, zip_member, {prunable} AS drop_it FROM files WHERE rel_path = ?",
            (rel,),
        ).fetchall()
        gone = [r for r in rows if r["drop_it"]]
        keep = {r["zip_member"] for r in rows if not r["drop_it"]}
        path = uploads_dir / rel[len(UPLOADS_PREFIX) :]
        try:
            if not keep:
                path.unlink(missing_ok=True)
            elif path.suffix.lower() == ".zip" and path.is_file():
                with zipfile.ZipFile(path) as zf:
                    csv_name = strava.find_csv(zf.namelist())
                _trim_zip(
                    path,
                    {m for m in keep if not strava.is_manual(m)}
                    | ({csv_name} if csv_name else set()),
                )
                st = path.stat()
                conn.execute(
                    "UPDATE files SET size = ?, mtime = ? WHERE rel_path = ?",
                    (st.st_size, st.st_mtime, rel),
                )
        except (OSError, zipfile.BadZipFile):
            continue  # left as it is; tried again after the next import
        conn.executemany("DELETE FROM files WHERE id = ?", [(r["id"],) for r in gone])
        dropped += len(gone)
    return dropped


def run_queue(
    conn: sqlite3.Connection,
    root: str | Path | None,
    progress: ProgressFn | None = None,
    limit: int | None = None,
    uploads_dir: Path | None = None,
) -> ImportResult:
    """Process all files with status `new`, oldest first, committing after each file."""
    root = Path(root) if root else None
    result = ImportResult()
    done: set[int] = set()
    # Files uploaded while the queue runs are picked up in another round.
    while True:
        rows = [
            r for r in conn.execute(
                "SELECT * FROM files WHERE status = 'new' ORDER BY mtime, rel_path, zip_member"
            ).fetchall()
            if r["id"] not in done
        ]  # fmt: skip
        if limit is not None:
            rows = rows[: max(0, limit - len(done))]
        if not rows:
            return result
        offset = len(done)
        for i, row in enumerate(rows, start=offset + 1):
            done.add(row["id"])
            outcome = import_file(conn, root, row, uploads_dir)
            setattr(result, _RESULT_FIELD[outcome], getattr(result, _RESULT_FIELD[outcome]) + 1)
            if progress:
                progress(i, offset + len(rows), row, outcome)


_RESULT_FIELD = {
    "imported": "imported",
    "skipped": "skipped",
    "duplicate": "duplicates",
    "error": "errors",
}


def import_file(
    conn: sqlite3.Connection, root: Path | None, row: sqlite3.Row, uploads_dir: Path | None = None
) -> str:
    """Import one file row. Returns the resulting status."""
    status = _import_file(conn, root, row, uploads_dir)
    if status == "duplicate":
        # A Strava copy of an activity we already have still brings its title and text.
        csv_row = _strava_row(row, root, uploads_dir)
        if csv_row is not None:
            apply_strava_text(conn, row["id"], csv_row)
    if status in ("imported", "duplicate"):
        apply_connect_name(conn, row["id"])
    return status


def apply_strava_text(conn: sqlite3.Connection, file_id: int, csv_row: strava.Row) -> None:
    """Title and description from Strava's activities.csv for the file's activity. The
    title wins over a Garmin Connect title; the user's own name and an existing
    description are kept."""
    conn.execute(
        """UPDATE activities SET
               name = CASE WHEN name_overridden = 0 AND ? IS NOT NULL THEN ? ELSE name END,
               name_source = CASE WHEN name_overridden = 0 AND ? IS NOT NULL THEN 'file'
                                  ELSE name_source END,
               description = COALESCE(description, ?)
           WHERE id = (SELECT activity_id FROM files WHERE id = ?)""",
        (csv_row.title, csv_row.title, csv_row.title, csv_row.description, file_id),
    )


def apply_connect_name(conn: sqlite3.Connection, file_id: int) -> None:
    """Give the file's activity its Garmin Connect title (see `apply_connect_title`)."""
    row = conn.execute("SELECT activity_id FROM files WHERE id = ?", (file_id,)).fetchone()
    if row is not None and row[0] is not None:
        apply_connect_title(conn, row[0])


def apply_connect_title(conn: sqlite3.Connection, activity_id: int) -> None:
    """Give an activity its Garmin Connect title, when it is linked to a Connect activity
    (downloaded from Garmin, or matched by its start).

    FIT files carry no title, so activities are unnamed (the UI shows the type) until a
    Connect title arrives — also later, when Garmin delivers an activity already imported
    from a folder (a duplicate). A name the user set and a title from the activity file or
    Strava's activities.csv are kept.
    """
    hit = conn.execute(
        """SELECT g.name FROM garmin_activities g
           WHERE COALESCE(g.name, '') != ''
             AND (g.trailbook_id = ? OR EXISTS (
                   SELECT 1 FROM files f
                   WHERE f.activity_id = ? AND f.person_id = g.person_id
                     AND f.rel_path = g.file_rel))
           ORDER BY g.activity_id LIMIT 1""",
        (activity_id, activity_id),
    ).fetchone()
    if hit is None:
        return
    conn.execute(
        """UPDATE activities SET name = ?, name_source = 'garmin'
           WHERE id = ? AND name_overridden = 0
             AND (name IS NULL OR name_source IS NULL OR name_source = 'garmin')""",
        (hit[0], activity_id),
    )


def _import_file(
    conn: sqlite3.Connection, root: Path | None, row: sqlite3.Row, uploads_dir: Path | None
) -> str:
    file_id = row["id"]
    csv_row = _strava_row(row, root, uploads_dir)
    if strava.is_manual(row["zip_member"]):
        if csv_row is None:
            return _set_status(conn, file_id, "error", error="row missing in activities.csv")
        try:
            parsed = strava.manual_activity(csv_row)
        except trackfile.TrackFileError as exc:
            return _set_status(conn, file_id, "skipped", skip_reason=str(exc))
        sha = hashlib.sha256(f"strava:{csv_row.activity_id}".encode()).hexdigest()
        return _store_other(conn, row, parsed, sha)
    try:
        data = read_file_bytes(root, row["rel_path"], row["zip_member"], uploads_dir)
    except (OSError, KeyError, zipfile.BadZipFile, trackfile.TrackFileError) as exc:
        return _set_status(conn, file_id, "error", error=f"cannot read file: {exc}")

    sha = hashlib.sha256(data).hexdigest()
    if trackfile.kind(data) in ("gpx", "tcx"):
        return _import_track_file(conn, row, data, sha, csv_row)
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
    if file_type in fitfile.FILE_TYPES_MONITORING:
        _store_monitoring(conn, file_id, data)
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

    replace_id = existing["id"] if existing else None
    if replace_id is None:
        # A GPX/TCX or manual copy of this recording (e.g. from Strava) is replaced by it.
        replace_id = same_start(conn, person_id, parsed.start_time, copies_only=True)

    if csv_row is not None:
        strava.apply(parsed, csv_row, from_file_only=False)
    conn.execute("BEGIN")
    try:
        activity_id = _store_activity(
            conn, person_id, parsed, replace_id, fid.serial_number if fid else None
        )
        # This file owns the activity now; the files of a replaced copy are duplicates.
        conn.execute(
            """UPDATE files
               SET status = CASE WHEN status = 'imported' THEN 'duplicate' ELSE status END,
                   prev_status = CASE WHEN prev_status = 'imported' THEN 'duplicate'
                                      ELSE prev_status END
               WHERE activity_id = ? AND id != ?""",
            (activity_id, file_id),
        )
        _set_status(
            conn, file_id, "imported", sha=sha, fid=fid, fit_uid=parsed.fit_uid,
            activity_id=activity_id,
        )  # fmt: skip
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return "imported"


def _store_monitoring(conn: sqlite3.Connection, file_id: int, data: bytes) -> None:
    """Daily values of a monitoring file (steps, ascent, stress) for the Calendar; they belong
    to the file's person. The file itself stays `skipped` (not an activity); a file that
    cannot be read adds nothing."""
    try:
        parts = fitfile.parse_monitoring(data)
    except Exception:  # the SDK raises a variety of exception types
        parts = {}
    conn.execute("BEGIN")
    try:
        conn.execute("DELETE FROM daily_parts WHERE file_id = ?", (file_id,))
        conn.executemany(
            "INSERT INTO daily_parts (file_id, day, metric, value, n) VALUES (?, ?, ?, ?, ?)",
            [(file_id, d, m, v, n) for (d, m), (v, n) in parts.items()],
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise


def _strava_row(row: sqlite3.Row, root: Path | None, uploads_dir: Path | None) -> strava.Row | None:
    """The activities.csv row of a file inside a Strava export ZIP."""
    if not row["zip_member"]:
        return None
    path = _file_path(row["rel_path"], root, uploads_dir)
    return strava.rows_of(path).get(row["zip_member"]) if path else None


def _import_track_file(
    conn: sqlite3.Connection, row: sqlite3.Row, data: bytes, sha: str,
    csv_row: strava.Row | None,
) -> str:  # fmt: skip
    """A GPX or TCX file. It has no watch serial, so the file row's person owns it."""
    file_id = row["id"]
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
    try:
        parsed = trackfile.parse(data)
    except trackfile.TrackFileError as exc:
        return _set_status(conn, file_id, "skipped", sha=sha, skip_reason=str(exc)[:200])
    if csv_row is not None:
        strava.apply(parsed, csv_row, from_file_only=True)
    return _store_other(conn, row, parsed, sha)


def _store_other(
    conn: sqlite3.Connection, row: sqlite3.Row, parsed: fitfile.ParsedActivity, sha: str
) -> str:
    """Store a GPX/TCX or manual Strava activity, unless the person already has it (same id,
    or another activity starting within SAME_START_S)."""
    file_id = row["id"]
    person_id = row["person_id"]
    if parsed.utc_offset_s is None:
        parsed.utc_offset_s = estimate_utc_offset(conn, person_id, parsed)
    existing = conn.execute(
        "SELECT id FROM activities WHERE fit_uid = ?", (parsed.fit_uid,)
    ).fetchone()
    if existing is not None and existing["id"] != row["activity_id"]:
        return _set_status(
            conn, file_id, "duplicate", sha=sha, fit_uid=parsed.fit_uid,
            activity_id=existing["id"],
        )  # fmt: skip
    if existing is None:
        same = same_start(conn, person_id, parsed.start_time)
        if same is not None:
            return _set_status(
                conn, file_id, "duplicate", sha=sha, fit_uid=parsed.fit_uid, activity_id=same
            )

    conn.execute("BEGIN")
    try:
        activity_id = _store_activity(conn, person_id, parsed, existing["id"] if existing else None)
        _set_status(
            conn, file_id, "imported", sha=sha, fit_uid=parsed.fit_uid, activity_id=activity_id
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return "imported"


def same_start(
    conn: sqlite3.Connection, person_id: str, start: datetime, *, copies_only: bool = False
) -> int | None:
    """The person's activity starting within SAME_START_S of `start` (the nearest one);
    `copies_only`: only GPX/TCX files and Strava's manual activities."""
    start = start.astimezone(UTC)
    row = conn.execute(
        f"""SELECT id FROM activities
            WHERE person_id = ? AND start_time_utc BETWEEN ? AND ?
                  {"AND " + COPY_UID_SQL if copies_only else ""}
            ORDER BY ABS(julianday(start_time_utc) - julianday(?)), id LIMIT 1""",
        (person_id, _iso(start - timedelta(seconds=SAME_START_S)),
         _iso(start + timedelta(seconds=SAME_START_S)), _iso(start)),
    ).fetchone()  # fmt: skip
    return row[0] if row else None


def _iso(t: datetime) -> str:
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def estimate_utc_offset(
    conn: sqlite3.Connection, person_id: str, p: fitfile.ParsedActivity
) -> int | None:
    """GPX/TCX files and Strava's CSV carry no time zone. Taken from the person's activity
    nearest in time that has one, when it is within 120 days and in the same summer-time
    season; otherwise from the longitude (+ EU summer time in Europe); then from the nearest
    activity shifted by the summer-time hour; nothing known → UTC."""
    start = p.start_time.astimezone(UTC)
    near = conn.execute(
        """SELECT utc_offset_s, start_time_utc FROM activities
           WHERE person_id = ? AND utc_offset_s IS NOT NULL
           ORDER BY ABS(julianday(start_time_utc) - julianday(?)) LIMIT 1""",
        (person_id, _iso(start)),
    ).fetchone()
    other = None
    if near is not None:
        other = datetime.fromisoformat(near["start_time_utc"].replace("Z", "+00:00"))
        if abs((other - start).days) <= 120 and eu_summer(other) == eu_summer(start):
            return near["utc_offset_s"]
    lon = p.summary.get("start_lon")
    if lon is not None:
        europe = -25 <= lon <= 45
        return round(lon / 15) * 3600 + (3600 * eu_summer(start) if europe else 0)
    if other is not None:
        return near["utc_offset_s"] + 3600 * (eu_summer(start) - eu_summer(other))
    return None


def eu_summer(t: datetime) -> int:
    """1 between the last Sundays of March and October (01:00 UTC), as in the EU."""

    def last_sunday(month: int) -> datetime:
        d = datetime(t.year, month, 31, 1, tzinfo=UTC)
        return d - timedelta(days=(d.weekday() + 1) % 7)

    return int(last_sunday(3) <= t.astimezone(UTC) < last_sunday(10))


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
    """Link a watch to a person.

    Rule: settings never re-assign data that already belongs to someone. The new link applies
    to files imported from now on. The only data that moves is what is still *Unassigned*
    (it never had a person), so a first scan with unlinked watches is not a dead end.
    Returns the number of activities that moved from Unassigned to the person.
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
        moved = 0
        if person_id is not None:
            conn.execute(
                "UPDATE files SET person_id = ? WHERE device_serial = ? AND person_id = ?",
                (person_id, serial, UNASSIGNED),
            )
            moved = conn.execute(
                "UPDATE activities SET person_id = ? WHERE device_serial = ? AND person_id = ?",
                (person_id, serial, UNASSIGNED),
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
    if status == "error":
        f = conn.execute(
            "SELECT rel_path, zip_member FROM files WHERE id = ?", (file_id,)
        ).fetchone()
        name = (
            f"{f['rel_path']} › {f['zip_member']}"
            if f and f["zip_member"]
            else (f["rel_path"] if f else file_id)
        )
        log.warning("File %s not imported: %s", name, error)
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
    "elapsed_s timer_s time_s distance_m ascent_m descent_m avg_hr max_hr avg_speed "
    "max_speed avg_power max_power np_power avg_cadence max_cadence calories has_gps "
    "zones metabolic_calories devices "
    "start_lat start_lon bbox_min_lat bbox_min_lon bbox_max_lat bbox_max_lon"
).split()


# Rows rebuilt on reimport (activities themselves are updated in place).
_PER_ACTIVITY_TABLES = (
    "tracks", "streams", "laps", "best_efforts", "activity_tiles", "segment_efforts",
)  # fmt: skip


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
        # FIT has no title (a Garmin Connect title is set after import); GPX/TCX files
        # and Strava exports may give one.
        "name": p.title,
        "name_source": "file" if p.title else None,
        "description": p.description,
        "device": p.device,
        "importer_version": IMPORTER_VERSION,
        "analysis_version": 0,  # load and best efforts are computed after import
        "segments_version": 0,  # segment efforts too
        "workout_version": 0,  # and the workout kind (the person's choice is kept)
        "workout_stats": None,
        **{c: p.summary.get(c) for c in _ACTIVITY_COLUMNS},
        **{f"watch_{k}": p.profile.get(k) for k in WATCH_FIELDS},
        "watch_version": WATCH_VERSION,
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
            values.pop("indoor")
        if current["name_overridden"] or p.title is None:
            # A file without a title (FIT) keeps the name the activity has: the user's, a
            # Strava title of the copy it replaces, or the Garmin Connect title.
            values.pop("name")
            values.pop("name_source")
        if p.description is None:
            values.pop("description")
        assignments = ", ".join(f"{c} = ?" for c in values)
        conn.execute(
            f"UPDATE activities SET {assignments} WHERE id = ?", [*values.values(), activity_id]
        )
        for table in _PER_ACTIVITY_TABLES:
            conn.execute(f"DELETE FROM {table} WHERE activity_id = ?", (activity_id,))

    if p.track:
        simplified = geo.simplify(p.track, TRACK_TOLERANCE_M)
        conn.execute(
            "INSERT INTO tracks (activity_id, polyline, point_count) VALUES (?, ?, ?)",
            (activity_id, geo.encode_polyline(simplified), len(simplified)),
        )

    if p.track:
        _store_tiles(conn, activity_id, p.streams.get("lat", []), p.streams.get("lon", []))

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
                                 avg_cadence, ascent_m, descent_m, intensity,
                                 target, target_low, target_high)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
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
                lap.target,
                lap.target_low,
                lap.target_high,
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
    """User override of the activity type; the group and indoor follow the type (a ride made
    virtual gets the indoor records, a virtual ride made a road ride the outdoor ones)."""
    t = sports.TYPES[type_key]
    conn.execute(
        """UPDATE activities SET activity_type = ?, category = ?, indoor = ?, type_overridden = 1,
                  analysis_version = 0, segments_version = 0, workout_version = 0,
                  workout_stats = NULL
           WHERE id = ?""",
        (t.key, t.group, int(t.indoor), activity_id),
    )


def dismiss_missing(conn: sqlite3.Connection, file_id: int) -> None:
    """Acknowledge a missing file and keep its activity data."""
    conn.execute("UPDATE files SET dismissed = 1 WHERE id = ? AND status = 'missing'", (file_id,))
