"""Export / restore: move a whole Trailbook install with one ZIP archive.

Layout of an export::

    trailbook-export-<date>-<time>.zip
    ├── manifest.json     format, versions, people, counts, size + sha256 + mtime per file
    ├── trailbook.db      consistent snapshot (SQLite online backup API)
    └── files/
        ├── root/...      watched-folder files not archived yet, same structure
        └── uploads/...   the archive: uploads, Garmin downloads, folder copies (_folder/)

Settings live in the database, so they travel with it. Garmin access tokens never do; Garmin
API keys only when asked for. The archive is written and read in chunks (ZIP64), never held
in memory. Both directions run in the low-priority job process; progress goes to a small
JSON file next to the database because a restore replaces the database itself.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import zipfile
from collections.abc import Callable
from contextlib import closing
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

from . import __version__, db, importer

FORMAT = "trailbook-export"
FORMAT_VERSION = 1
MANIFEST = "manifest.json"
DB_NAME = "trailbook.db"
CHUNK = 1 << 20
EXPORT_RE = re.compile(r"^trailbook-export-[0-9A-Za-z_.-]+\.zip$")
FILE_SUFFIXES = (".fit", ".zip")
# Machine-specific or transient settings that must not move with the database.
TRANSIENT_SETTINGS = ("import_progress",)

ProgressFn = Callable[..., None]


class BackupError(Exception):
    """A user-facing problem with an export or restore (bad archive, wrong version...)."""


# ---- paths and progress ------------------------------------------------------------------


def data_dir(db_path: str | Path) -> Path:
    return Path(db_path).resolve().parent


def uploads_dir(db_path: str | Path) -> Path:
    return data_dir(db_path) / "uploads"


def exports_dir(db_path: str | Path) -> Path:
    """Where archives are written; in the add-on a mapped folder (TRAILBOOK_EXPORT_DIR)."""
    env = os.environ.get("TRAILBOOK_EXPORT_DIR")
    return Path(env) if env else data_dir(db_path) / "exports"


def progress_path(db_path: str | Path, kind: str) -> Path:
    return data_dir(db_path) / f"{kind}-progress.json"


def write_progress(db_path: str | Path, kind: str, **progress) -> None:
    path = progress_path(db_path, kind)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(progress), encoding="utf-8")
    os.replace(tmp, path)


def read_progress(db_path: str | Path, kind: str) -> dict:
    try:
        return json.loads(progress_path(db_path, kind).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"state": "idle"}


def now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def list_exports(db_path: str | Path) -> list[dict]:
    folder = exports_dir(db_path)
    if not folder.is_dir():
        return []
    out = []
    for p in folder.iterdir():
        if p.is_file() and EXPORT_RE.match(p.name):
            st = p.stat()
            item = {"name": p.name, "bytes": st.st_size, "modified": st.st_mtime}
            try:
                item["manifest"] = summary(read_manifest(p))
            except BackupError as exc:
                item["error"] = str(exc)
            out.append(item)
    return sorted(out, key=lambda i: i["modified"], reverse=True)


def export_path(db_path: str | Path, name: str) -> Path:
    """Resolve an archive name from the API; only plain export names are allowed."""
    if not EXPORT_RE.match(name):
        raise BackupError("not an export name")
    return exports_dir(db_path) / name


def summary(manifest: dict) -> dict:
    keys = ("created_at", "trailbook_version", "schema_version", "include_files",
            "include_secrets", "persons", "counts")  # fmt: skip
    return {k: manifest.get(k) for k in keys}


# ---- export ------------------------------------------------------------------------------


@dataclass
class ExportResult:
    path: Path
    files: int = 0
    bytes: int = 0


def _collect(base: Path | None, arc_prefix: str) -> list[tuple[Path, str]]:
    if not base or not base.is_dir():
        return []
    found = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames.sort()
        for name in sorted(filenames):
            if name.lower().endswith(FILE_SUFFIXES):
                p = Path(dirpath) / name
                found.append((p, f"{arc_prefix}/{p.relative_to(base).as_posix()}"))
    return found


def _snapshot(db_path: str | Path, target: Path, include_secrets: bool) -> dict:
    """Consistent copy of the live database, cleaned of secrets and transient state."""
    with closing(db.connect(db_path, apply_migrations=False)) as src:
        with closing(sqlite3.connect(target)) as dst:
            src.backup(dst)
    with closing(sqlite3.connect(target, isolation_level=None)) as c:
        c.execute("PRAGMA journal_mode = DELETE")  # one self-contained file
        c.executemany("DELETE FROM settings WHERE key = ?", [(k,) for k in TRANSIENT_SETTINGS])
        c.execute("UPDATE garmin_accounts SET token = NULL, token_expires = NULL")
        if not include_secrets:
            c.execute("UPDATE garmin_accounts SET api_key = '', status = 'auth_error',"
                      " last_error = 'API key not included in the export'")  # fmt: skip
        persons = [r[0] for r in c.execute("SELECT id FROM persons ORDER BY sort_order, id")]
        counts = {
            "activities": c.execute("SELECT COUNT(*) FROM activities").fetchone()[0],
            "files": c.execute("SELECT COUNT(*) FROM files").fetchone()[0],
        }
        version = c.execute("PRAGMA user_version").fetchone()[0]
        settings = dict(c.execute("SELECT key, value FROM settings").fetchall())
    return {"persons": persons, "counts": counts, "schema_version": version, "settings": settings}


def _add_file(zf: zipfile.ZipFile, src: Path, arcname: str) -> dict:
    st = src.stat()
    info = zipfile.ZipInfo(arcname, date_time=_zip_time(st.st_mtime))
    stored = src.suffix.lower() == ".zip"  # already compressed
    info.compress_type = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
    h = hashlib.sha256()
    with src.open("rb") as fh, zf.open(info, "w", force_zip64=st.st_size > 1 << 31) as out:
        while chunk := fh.read(CHUNK):
            h.update(chunk)
            out.write(chunk)
    return {"size": st.st_size, "sha256": h.hexdigest(), "mtime_ns": st.st_mtime_ns}


def _zip_time(mtime: float) -> tuple:
    t = datetime.fromtimestamp(max(mtime, 315532800))  # ZIP cannot store dates before 1980
    return (t.year, t.month, t.day, t.hour, t.minute, t.second)


def export(
    db_path: str | Path,
    out_dir: str | Path | None = None,
    *,
    include_files: bool = True,
    include_secrets: bool = False,
    progress: ProgressFn | None = None,
) -> ExportResult:
    out_dir = Path(out_dir) if out_dir else exports_dir(db_path)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    final = out_dir / f"trailbook-export-{stamp}.zip"
    part = final.with_suffix(".zip.part")
    snap = out_dir / f".snapshot-{stamp}.db"
    report = progress or (lambda **_: None)

    with closing(db.connect(db_path, apply_migrations=False)) as c:
        root_setting = db.get_setting(c, "root")
        # Folder files already copied into the archive travel as `files/uploads/_folder/…`.
        archived = {
            r[0]
            for r in c.execute(
                "SELECT source_rel FROM files WHERE source_rel IS NOT NULL"
                " AND rel_path LIKE '@uploads/%'"
            )
        }
    root = Path(root_setting) if root_setting else None
    items: list[tuple[Path, str]] = []
    if include_files:
        prefix = "files/root/"
        root_items = [
            (p, arc) for p, arc in _collect(root, "files/root")
            if arc[len(prefix):] not in archived
        ]  # fmt: skip
        items = root_items + _collect(uploads_dir(db_path), "files/uploads")
    total_bytes = sum(p.stat().st_size for p, _ in items)

    try:
        report(phase="database", done=0, total=len(items))
        meta = _snapshot(db_path, snap, include_secrets)
        entries: dict[str, dict] = {}
        result = ExportResult(final)
        with zipfile.ZipFile(part, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            entries[DB_NAME] = _add_file(zf, snap, DB_NAME)
            snap.unlink()
            for i, (src, arcname) in enumerate(items, start=1):
                entries[arcname] = _add_file(zf, src, arcname)
                result.files += 1
                result.bytes += entries[arcname]["size"]
                if i % 20 == 0 or i == len(items):
                    report(phase="files", done=i, total=len(items),
                           bytes=result.bytes, total_bytes=total_bytes)  # fmt: skip
            manifest = {
                "format": FORMAT,
                "format_version": FORMAT_VERSION,
                "trailbook_version": __version__,
                "schema_version": meta["schema_version"],
                "created_at": now_iso(),
                "include_files": include_files,
                "include_secrets": include_secrets,
                "persons": meta["persons"],
                "counts": {
                    **meta["counts"],
                    "archived_files": result.files,
                    "archived_bytes": result.bytes,
                },  # fmt: skip
                "source": {
                    "root": root_setting,
                    "data_source": meta["settings"].get("data_source"),
                },  # noqa: E501
                "entries": entries,
            }
            zf.writestr(MANIFEST, json.dumps(manifest, indent=1))
        os.replace(part, final)
    finally:
        part.unlink(missing_ok=True)
        snap.unlink(missing_ok=True)
    return result


# ---- restore -----------------------------------------------------------------------------


def read_manifest(archive: str | Path) -> dict:
    try:
        with zipfile.ZipFile(archive) as zf:
            manifest = json.loads(zf.read(MANIFEST))
    except (OSError, zipfile.BadZipFile) as exc:
        raise BackupError("not a readable ZIP archive") from exc
    except KeyError as exc:
        raise BackupError("not a Trailbook export (no manifest.json)") from exc
    except ValueError as exc:
        raise BackupError("manifest.json is not valid JSON") from exc
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT:
        raise BackupError("not a Trailbook export")
    if int(manifest.get("format_version", 0)) > FORMAT_VERSION:
        raise BackupError("the export was made by a newer Trailbook; update first")
    if int(manifest.get("schema_version", 0)) > db.SCHEMA_VERSION:
        raise BackupError(
            f"the export has database schema v{manifest.get('schema_version')}, this Trailbook "
            f"supports up to v{db.SCHEMA_VERSION}; it comes from a newer version, update first"
        )
    if DB_NAME not in manifest.get("entries", {}):
        raise BackupError("the export has no database")
    return manifest


def _safe_rel(arcname: str, prefix: str) -> PurePosixPath | None:
    """Relative path under `prefix`, or None for anything that could leave the target."""
    if not arcname.startswith(prefix + "/"):
        return None
    rel = PurePosixPath(arcname[len(prefix) + 1 :])
    if rel.is_absolute() or not rel.parts or any(p in ("", ".", "..") for p in rel.parts):
        return None
    if ":" in rel.parts[0] or "\\" in arcname:
        return None
    return rel


def _extract(zf: zipfile.ZipFile, arcname: str, entry: dict, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(target.name + ".part")
    h = hashlib.sha256()
    size = 0
    try:
        with zf.open(arcname) as src, part.open("wb") as out:
            while chunk := src.read(CHUNK):
                h.update(chunk)
                size += len(chunk)
                out.write(chunk)
        if size != entry.get("size") or h.hexdigest() != entry.get("sha256"):
            raise BackupError(f"checksum mismatch in {arcname}: the archive is damaged")
        if entry.get("mtime_ns"):
            os.utime(part, ns=(entry["mtime_ns"], entry["mtime_ns"]))
        os.replace(part, target)
    finally:
        part.unlink(missing_ok=True)


def is_empty_install(db_path: str | Path) -> bool:
    with closing(db.connect(db_path, apply_migrations=False)) as c:
        return not (
            c.execute("SELECT 1 FROM activities LIMIT 1").fetchone()
            or c.execute("SELECT 1 FROM files LIMIT 1").fetchone()
        )


@dataclass
class RestoreResult:
    files: int = 0
    persons: list[str] = field(default_factory=list)
    activities: int = 0


def restore(
    db_path: str | Path,
    archive: str | Path,
    *,
    replace: bool = False,
    progress: ProgressFn | None = None,
) -> RestoreResult:
    """Validate, restore files, then replace the database contents and migrate it.

    Every file goes into the archive next to the database (`uploads/`): watched-folder files
    that were not archived yet on the old install (`files/root/…`) land in `uploads/_folder/`
    and their rows point there. So nothing depends on a folder of the old device; the watched
    folder setting is kept only when that folder exists here.
    """
    report = progress or (lambda **_: None)
    manifest = read_manifest(archive)
    if not replace and not is_empty_install(db_path):
        raise BackupError("this install already has data; confirm that it may be replaced")
    entries: dict[str, dict] = manifest["entries"]
    up_dir = uploads_dir(db_path)
    result = RestoreResult(persons=list(manifest.get("persons") or []))

    with zipfile.ZipFile(archive) as zf:
        names = set(zf.namelist())
        missing = [n for n in entries if n not in names]
        if missing:
            raise BackupError(f"the archive is incomplete ({len(missing)} files missing)")
        plan: list[tuple[str, Path]] = []
        folder_files: list[str] = []  # watched-folder paths restored into the archive
        for arcname in entries:
            if arcname == DB_NAME:
                continue
            if (rel := _safe_rel(arcname, "files/root")) is not None:
                plan.append((arcname, up_dir.joinpath(importer.FOLDER_ARCHIVE, *rel.parts)))
                folder_files.append(rel.as_posix())
            elif (rel := _safe_rel(arcname, "files/uploads")) is not None:
                plan.append((arcname, up_dir.joinpath(*rel.parts)))
            else:
                raise BackupError(f"unexpected path in the archive: {arcname}")

        # 1. Files first: a damaged archive stops before the database is touched.
        report(phase="files", done=0, total=len(plan))
        for i, (arcname, target) in enumerate(plan, start=1):
            _extract(zf, arcname, entries[arcname], target)
            result.files += 1
            if i % 20 == 0 or i == len(plan):
                report(phase="files", done=i, total=len(plan))

        # 2. Database: checked copy next to the live one, then copied in via the backup API
        #    (safe with WAL and with other short-lived connections), then migrated.
        report(phase="database", done=len(plan), total=len(plan))
        tmp = data_dir(db_path) / ".restore.db"
        try:
            _extract(zf, DB_NAME, entries[DB_NAME], tmp)
            with closing(sqlite3.connect(tmp)) as src:
                if src.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise BackupError("the database in the export is damaged")
                with closing(db.connect(db_path, apply_migrations=False)) as dst:
                    src.backup(dst)
        finally:
            tmp.unlink(missing_ok=True)

    with closing(db.connect(db_path)) as c:  # runs migrations if the export is older
        c.executemany(
            "UPDATE files SET rel_path = ? WHERE source_rel = ? AND rel_path = source_rel",
            [(importer.folder_archive_rel(rel), rel) for rel in folder_files],
        )
        root = db.get_setting(c, "root")
        if root and not Path(root).is_dir():
            db.set_setting(c, "root", None)  # a folder of the old device: choose one here
        for key in TRANSIENT_SETTINGS:
            db.set_setting(c, key, None)
        result.activities = c.execute("SELECT COUNT(*) FROM activities").fetchone()[0]
    return result
