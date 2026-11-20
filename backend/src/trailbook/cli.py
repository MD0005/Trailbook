"""Command-line interface for running the importer without Home Assistant."""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from contextlib import closing
from pathlib import Path

from . import (
    __version__,
    analysis,
    applog,
    backup,
    db,
    garmin,
    importer,
    jobs,
    records,
    segments,
    sports,
    workout,
)

log = logging.getLogger("trailbook.import")


def _set_low_priority() -> None:
    if hasattr(os, "nice"):
        try:
            os.nice(19)
        except OSError:
            pass


def _fmt_duration(seconds: float | None) -> str:
    if seconds is None:
        return "-"
    s = int(round(seconds))
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}"


def _fmt_km(metres: float | None) -> str:
    return "-" if metres is None else f"{metres / 1000:.2f} km"


def cmd_scan(conn, args) -> int:
    out = (lambda *a, **k: None) if args.quiet else print
    uploads_dir = Path(args.db).resolve().parent / "uploads"
    # The folder is scanned only when it is the data source (or given explicitly); queued
    # uploads are processed in any case.
    source = db.get_setting(conn, "data_source") or "folder"
    root = args.root or (db.get_setting(conn, "root") if source == "folder" else None)
    if root:
        root = str(Path(root).resolve())
        db.set_setting(conn, "root", root)
    elif args.root is None and source == "folder" and not args.quiet:
        print("No folder configured: only queued uploads are processed.")

    if args.low_priority:
        _set_low_priority()

    started = importer.now_iso()
    jobs.write_progress(conn, state="running", phase="scan", started_at=started)
    log.info("Import run started (%s)", getattr(args, "trigger", "manual"))
    try:
        t0 = time.monotonic()
        scan = importer.scan(conn, root) if root else importer.ScanResult()
        out(
            f"Scanned {scan.scanned} files in {time.monotonic() - t0:.2f} s: "
            f"{scan.new} new, {scan.changed} changed, {scan.missing} missing, "
            f"{scan.returned} returned."
        )
        for person in scan.new_persons:
            out(f"  new person: {person}")
        for name in scan.ignored:
            out(f"  ignored (not in a person folder or unreadable): {name}")

        # One archive for every source: copy new folder files next to the database.
        jobs.write_progress(conn, state="running", phase="archive", started_at=started, done=0)

        def archive_progress(i, total, name):
            if i % 20 == 0 or i == total:
                jobs.write_progress(
                    conn, state="running", phase="archive", started_at=started,
                    done=i, total=total, current=name,
                )  # fmt: skip

        # Also when the source is no longer the folder: files imported from it earlier are
        # archived as long as the folder is still there.
        archived = importer.archive_folder(
            conn, root or db.get_setting(conn, "root"), uploads_dir, progress=archive_progress
        )
        if archived:
            out(f"Archived {archived} folder files.")

        if source == "garmin" and not args.no_garmin:
            jobs.write_progress(conn, state="running", phase="garmin", started_at=started, done=0)

            def garmin_progress(person, downloaded, name):
                jobs.write_progress(
                    conn, state="running", phase="garmin", started_at=started,
                    done=downloaded, current=f"{person}: {name or ''}",
                )  # fmt: skip

            synced = garmin.sync_all(conn, uploads_dir, progress=garmin_progress)
            (log.warning if synced.errors or synced.stopped else log.info)(
                "Garmin: %s activities downloaded, %s errors%s",
                synced.downloaded, synced.errors,
                f" (stopped: {synced.stopped})" if synced.stopped else "",
            )  # fmt: skip
            out(
                f"Garmin: {synced.downloaded} activities downloaded, {synced.errors} errors"
                + (f" (stopped: {synced.stopped})" if synced.stopped else "")
            )

        result = importer.ImportResult()
        if not args.no_import:
            t1 = time.monotonic()
            last_write = 0.0

            def progress(i, total, row, outcome):
                nonlocal last_write
                if args.verbose or outcome in ("imported", "error"):
                    name = row["rel_path"] + (f"!{row['zip_member']}" if row["zip_member"] else "")
                    out(f"  [{i}/{total}] {outcome:9} {name}")
                now = time.monotonic()
                if now - last_write >= 1.0 or i == total:
                    last_write = now
                    jobs.write_progress(
                        conn, state="running", phase="import", started_at=started,
                        done=i, total=total, current=row["rel_path"],
                    )  # fmt: skip

            result = importer.run_queue(
                conn, root, progress=progress, limit=args.limit, uploads_dir=uploads_dir
            )

            def tile_progress(i, total):
                jobs.write_progress(
                    conn, state="running", phase="tiles", started_at=started, done=i, total=total
                )

            tiled = importer.backfill_tiles(conn, progress=tile_progress)

            def analysis_progress(i, total):
                jobs.write_progress(
                    conn, state="running", phase="analysis", started_at=started, done=i, total=total
                )

            def watch_progress(i, total):
                jobs.write_progress(
                    conn, state="running", phase="thresholds", started_at=started, done=i,
                    total=total,
                )  # fmt: skip

            importer.backfill_watch(conn, root, uploads_dir, progress=watch_progress)
            analysed = analysis.backfill(conn, progress=analysis_progress)

            def segment_progress(i, total):
                jobs.write_progress(
                    conn, state="running", phase="segments", started_at=started, done=i, total=total
                )

            matched = segments.backfill(conn, progress=segment_progress)

            def workout_progress(i, total):
                jobs.write_progress(
                    conn, state="running", phase="workouts", started_at=started, done=i, total=total
                )

            kinds = workout.backfill(conn, progress=workout_progress)
            records.refresh_and_publish(conn)  # new top-3 places -> Home Assistant
            if kinds:
                out(f"Workout kind detected for {kinds} activities.")
            if matched:
                out(f"Segments matched for {matched} segments / activities.")
            if analysed:
                out(f"Training load and best efforts computed for {analysed} activities.")
            if tiled:
                out(f"Explorer tiles computed for {tiled} activities.")
            out(
                f"Import finished in {time.monotonic() - t1:.1f} s: {result.imported} imported, "
                f"{result.skipped} skipped, {result.duplicates} duplicates, "
                f"{result.errors} errors."
            )
    except Exception as exc:
        log.exception("Import run failed")
        jobs.write_progress(
            conn, state="failed", error=f"{type(exc).__name__}: {exc}",
            started_at=started, finished_at=importer.now_iso(),
        )  # fmt: skip
        raise

    finished = importer.now_iso()
    counts = {
        "scanned": scan.scanned, "new": scan.new, "missing": scan.missing,
        "imported": result.imported, "skipped": result.skipped,
        "duplicates": result.duplicates, "errors": result.errors,
    }  # fmt: skip
    conn.execute(
        """INSERT INTO import_runs (started_at, finished_at, trigger, scanned, new, imported,
                                    skipped, duplicates, errors, missing)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            started, finished, args.trigger, scan.scanned, scan.new, result.imported,
            result.skipped, result.duplicates, result.errors, scan.missing,
        ),
    )  # fmt: skip
    jobs.write_progress(conn, state="finished", started_at=started, finished_at=finished, **counts)
    (log.warning if result.errors else log.info)(
        "Import run finished: %s new files, %s imported, %s skipped, %s duplicates, %s errors",
        scan.new, result.imported, result.skipped, result.duplicates, result.errors,
    )  # fmt: skip
    return 0


def _job(db_path, kind: str, fn, quiet: bool):
    """Run an export/restore step with progress in `<kind>-progress.json`."""
    started = backup.now_iso()

    def progress(**p):
        backup.write_progress(db_path, kind, state="running", started_at=started, **p)

    progress(phase="start")
    try:
        result = fn(progress)
    except Exception as exc:
        msg = str(exc) if isinstance(exc, backup.BackupError) else f"{type(exc).__name__}: {exc}"
        if isinstance(exc, backup.BackupError):
            log.error("%s failed: %s", kind.capitalize(), msg)
        else:
            log.exception("%s failed", kind.capitalize())
        backup.write_progress(
            db_path, kind, state="failed", error=msg, started_at=started,
            finished_at=backup.now_iso(),
        )  # fmt: skip
        if not quiet:
            print(f"{kind} failed: {msg}", file=sys.stderr)
        return None
    return started, result


def cmd_match_segments(conn, args) -> int:
    if args.low_priority:
        _set_low_priority()
    n = segments.backfill(conn)
    if not args.quiet:
        print(f"Segments matched for {n} segments / activities.")
    return 0


def cmd_export(conn, args) -> int:
    conn.close()
    if args.low_priority:
        _set_low_priority()
    done = _job(
        args.db, "export",
        lambda progress: backup.export(
            args.db, args.out, include_files=not args.no_files,
            include_secrets=args.include_secrets, progress=progress,
        ),
        args.quiet,
    )  # fmt: skip
    if done is None:
        return 1
    started, r = done
    backup.write_progress(
        args.db, "export", state="finished", started_at=started, finished_at=backup.now_iso(),
        name=r.path.name, files=r.files, bytes=r.bytes,
    )  # fmt: skip
    log.info("Export finished: %s (%s files)", r.path.name, r.files)
    if not args.quiet:
        print(f"Exported {r.files} files ({r.bytes / 1e6:.1f} MB of files) to {r.path}")
    return 0


def cmd_restore(conn, args) -> int:
    conn.close()
    if args.low_priority:
        _set_low_priority()
    done = _job(
        args.db, "restore",
        lambda progress: backup.restore(
            args.db, args.archive, replace=args.yes, progress=progress
        ),
        args.quiet,
    )  # fmt: skip
    if args.delete_archive:
        Path(args.archive).unlink(missing_ok=True)
    if done is None:
        return 1
    started, r = done
    if not args.quiet:
        print(f"Restored {r.activities} activities and {r.files} files")
    status = 0
    if not args.no_scan:
        backup.write_progress(args.db, "restore", state="running", started_at=started, phase="scan")
        # Match file rows to the restored disk; Garmin downloads wait for the next run.
        scan_args = argparse.Namespace(
            db=args.db, root=None, no_import=False, no_garmin=True, low_priority=False,
            limit=None, verbose=False, quiet=args.quiet, trigger="restore",
        )  # fmt: skip
        with closing(db.connect(args.db)) as c2:
            status = cmd_scan(c2, scan_args)
    backup.write_progress(
        args.db, "restore", state="finished", started_at=started, finished_at=backup.now_iso(),
        files=r.files, activities=r.activities,
    )  # fmt: skip
    return status


def cmd_status(conn, args) -> int:
    print(f"Root: {_setting(conn, 'root') or '-'}")
    print("Files by status:")
    for r in conn.execute("SELECT status, COUNT(*) n FROM files GROUP BY status ORDER BY status"):
        print(f"  {r['status']:10} {r['n']}")
    print("Skipped by reason:")
    for r in conn.execute(
        """SELECT skip_reason, COUNT(*) n FROM files WHERE status = 'skipped'
           GROUP BY skip_reason ORDER BY n DESC"""
    ):
        print(f"  {r['skip_reason'] or '-':18} {r['n']}")
    print("Activities by person, group and type:")
    for r in conn.execute(
        """SELECT p.label, a.category, a.activity_type, COUNT(*) n, SUM(a.distance_m) d,
                  SUM(a.time_s) t
           FROM activities a JOIN persons p ON p.id = a.person_id
           GROUP BY p.label, a.category, a.activity_type
           ORDER BY p.label, a.category, n DESC"""
    ):
        print(
            f"  {r['label']:16} {r['category']:10} {r['activity_type']:16} {r['n']:5}  "
            f"{_fmt_km(r['d']):>12}  {_fmt_duration(r['t']):>10}"
        )
    return 0


def cmd_files(conn, args) -> int:
    sql = "SELECT * FROM files"
    params: list = []
    if args.status:
        sql += " WHERE status = ?"
        params.append(args.status)
    sql += " ORDER BY rel_path, zip_member"
    for r in conn.execute(sql, params):
        detail = (
            r["skip_reason"]
            or r["error"]
            or (f"activity {r['activity_id']}" if r["activity_id"] else "")
        )
        name = r["rel_path"] + (f"!{r['zip_member']}" if r["zip_member"] else "")
        print(f"{r['id']:6} {r['status']:9} {name}  {detail}")
    return 0


def cmd_activities(conn, args) -> int:
    sql = "SELECT * FROM activities"
    params: list = []
    if args.person:
        sql += " WHERE person_id = ?"
        params.append(args.person)
    sql += " ORDER BY start_time_utc"
    for r in conn.execute(sql, params):
        indoor = "(in)" if r["indoor"] else "    "
        print(
            f"{r['id']:5} {r['start_time_utc']}  {r['activity_type']:14}{indoor} "
            f"{_fmt_km(r['distance_m']):>10} {_fmt_duration(r['time_s']):>9} "
            f"HR {r['avg_hr'] or '-':>3}  {r['name'] or ''}"
        )
    return 0


def cmd_activity(conn, args) -> int:
    a = conn.execute("SELECT * FROM activities WHERE id = ?", (args.id,)).fetchone()
    if a is None:
        print(f"No activity {args.id}")
        return 1
    for key in a.keys():
        if a[key] is not None:
            print(f"{key:20} {a[key]}")
    track = conn.execute(
        "SELECT point_count FROM tracks WHERE activity_id = ?", (args.id,)
    ).fetchone()
    print(f"{'track points':20} {track['point_count'] if track else '-'}")
    chans = conn.execute(
        "SELECT channel, length, LENGTH(data) bytes FROM streams WHERE activity_id = ?", (args.id,)
    ).fetchall()
    print("streams:", ", ".join(f"{c['channel']}({c['length']}, {c['bytes']} B)" for c in chans))
    laps = conn.execute("SELECT COUNT(*) FROM laps WHERE activity_id = ?", (args.id,)).fetchone()[0]
    print(f"{'laps':20} {laps}")
    return 0


def cmd_forget(conn, args) -> int:
    ok = importer.forget_file(conn, args.id)
    print("Removed from history; the next scan imports it again." if ok else f"No file {args.id}")
    return 0 if ok else 1


def cmd_delete_activity(conn, args) -> int:
    ok = importer.delete_activity(conn, args.id)
    print("Deleted." if ok else f"No activity {args.id}")
    return 0 if ok else 1


def cmd_reprocess(conn, args) -> int:
    queued = importer.requeue_outdated(conn, everything=args.all)
    print(f"Queued {queued} files for reprocessing.")
    if queued and not args.no_import:
        root = _setting(conn, "root")
        if not root:
            print("No root folder stored; run `trailbook scan <folder>` first.")
            return 2
        result = importer.run_queue(
            conn, root, uploads_dir=Path(args.db).resolve().parent / "uploads"
        )
        print(f"Reprocessed {result.imported}, errors {result.errors}.")
    return 0


def cmd_set_type(conn, args) -> int:
    if args.type not in sports.TYPES:
        print(f"Unknown type '{args.type}'. See `trailbook types`.")
        return 2
    importer.set_activity_type(conn, args.id, args.type)
    print(f"Activity {args.id} is now {args.type}.")
    return 0


def cmd_types(conn, args) -> int:
    for group, (en, pl) in sports.GROUPS.items():
        print(f"{group}  —  {en} / {pl}")
        for t in sports.TYPES.values():
            if t.group == group:
                print(f"    {t.key:18} {t.en} / {t.pl}{'  (indoor)' if t.indoor else ''}")
    return 0


def _setting(conn, key: str) -> str | None:
    return db.get_setting(conn, key)


def cmd_serve(conn, args) -> int:
    import uvicorn

    from .api import create_app

    if args.root:
        db.set_setting(conn, "root", str(Path(args.root).resolve()))
    conn.close()
    app = create_app(args.db)
    logging.getLogger("trailbook.server").info("Trailbook %s started", __version__)
    # log_config=None: uvicorn's own errors go through the app log (applog)
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        workers=1,
        log_level="warning",
        access_log=False,
        log_config=None,
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="trailbook", description="Trailbook importer CLI")
    parser.add_argument("--version", action="version", version=f"trailbook {__version__}")
    parser.add_argument(
        "--db",
        default=os.environ.get("TRAILBOOK_DB", "data/trailbook.db"),
        help="SQLite database path (default: data/trailbook.db or $TRAILBOOK_DB)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("scan", help="scan the root folder and import new files")
    p.add_argument("root", nargs="?", help="root folder with one subfolder per person")
    p.add_argument("--no-import", action="store_true", help="only update file statuses")
    p.add_argument("--no-garmin", action="store_true", help="skip Garmin Connect downloads")
    p.add_argument("--low-priority", action="store_true", help="run with the lowest CPU priority")
    p.add_argument("--limit", type=int, help="import at most N files")
    p.add_argument("-v", "--verbose", action="store_true", help="print every file")
    p.add_argument("-q", "--quiet", action="store_true", help="print nothing")
    p.add_argument("--trigger", default="cli", help=argparse.SUPPRESS)
    p.set_defaults(func=cmd_scan)

    sub.add_parser("status", help="summary of files and activities").set_defaults(func=cmd_status)

    p = sub.add_parser("files", help="list tracked files")
    p.add_argument("--status", choices=list(importer.STATUSES))
    p.set_defaults(func=cmd_files)

    p = sub.add_parser("activities", help="list activities")
    p.add_argument("--person")
    p.set_defaults(func=cmd_activities)

    p = sub.add_parser("activity", help="show one activity")
    p.add_argument("id", type=int)
    p.set_defaults(func=cmd_activity)

    p = sub.add_parser(
        "delete-activity", help="delete an activity (e.g. after its file went missing)"
    )
    p.add_argument("id", type=int)
    p.set_defaults(func=cmd_delete_activity)

    p = sub.add_parser("reprocess", help="rebuild activities made by an older importer")
    p.add_argument("--all", action="store_true", help="rebuild every activity")
    p.add_argument("--no-import", action="store_true", help="only queue the files")
    p.set_defaults(func=cmd_reprocess)

    p = sub.add_parser("set-type", help="change the type of an activity (kept on reimport)")
    p.add_argument("id", type=int)
    p.add_argument("type")
    p.set_defaults(func=cmd_set_type)

    sub.add_parser("types", help="list activity groups and types").set_defaults(func=cmd_types)

    p = sub.add_parser("forget", help="remove a file from the import history (re-import on scan)")
    p.add_argument("id", type=int, help="file id from `trailbook files`")
    p.set_defaults(func=cmd_forget)

    p = sub.add_parser("match-segments", help="match new segments and activities")
    p.add_argument("--low-priority", action="store_true", help="run with the lowest CPU priority")
    p.add_argument("-q", "--quiet", action="store_true", help="print nothing")
    p.set_defaults(func=cmd_match_segments)

    p = sub.add_parser("export", help="write a migration archive (database + files)")
    p.add_argument("--out", help="folder for the archive (default: exports next to the db)")
    p.add_argument("--no-files", action="store_true", help="database and settings only")
    p.add_argument("--include-secrets", action="store_true", help="include Garmin API keys")
    p.add_argument("--low-priority", action="store_true", help="run with the lowest CPU priority")
    p.add_argument("-q", "--quiet", action="store_true", help="print nothing")
    p.set_defaults(func=cmd_export)

    p = sub.add_parser("restore", help="restore a migration archive (replaces the database)")
    p.add_argument("archive", help="trailbook-export-*.zip")
    p.add_argument("--yes", action="store_true", help="replace an install that has data")
    p.add_argument("--no-scan", action="store_true", help="do not scan after restoring")
    p.add_argument("--low-priority", action="store_true", help="run with the lowest CPU priority")
    p.add_argument("-q", "--quiet", action="store_true", help="print nothing")
    p.add_argument("--delete-archive", action="store_true", help=argparse.SUPPRESS)
    p.set_defaults(func=cmd_restore)

    p = sub.add_parser("serve", help="run the web server (API + preview UI)")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8099)
    p.add_argument("--root", help="root folder with one subfolder per person")
    p.set_defaults(func=cmd_serve)

    args = parser.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    # the server and the background jobs (quiet) log to the console too: the add-on's log
    applog.setup(args.db, console=args.func is cmd_serve or getattr(args, "quiet", False))
    conn = db.connect(args.db)
    try:
        return args.func(conn, args)
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
