"""Command-line interface for running the importer without Home Assistant."""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

from . import __version__, db, importer, sports


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
    root = args.root or _setting(conn, "root")
    if not root:
        print("No root folder given and none stored yet. Usage: trailbook scan <folder>")
        return 2
    root = str(Path(root).resolve())
    conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('root', ?)", (root,))

    if args.low_priority:
        _set_low_priority()

    started = importer.now_iso()
    t0 = time.monotonic()
    scan = importer.scan(conn, root)
    print(
        f"Scanned {scan.scanned} files in {time.monotonic() - t0:.2f} s: "
        f"{scan.new} new, {scan.changed} changed, {scan.missing} missing, "
        f"{scan.returned} returned."
    )
    for person in scan.new_persons:
        print(f"  new person: {person}")
    for name in scan.ignored:
        print(f"  ignored (not in a person folder or unreadable): {name}")

    result = importer.ImportResult()
    if not args.no_import:
        t1 = time.monotonic()

        def progress(i, total, row, outcome):
            if args.verbose or outcome in ("imported", "error"):
                name = row["rel_path"] + (f"!{row['zip_member']}" if row["zip_member"] else "")
                print(f"  [{i}/{total}] {outcome:9} {name}")

        result = importer.run_queue(conn, root, progress=progress, limit=args.limit)
        print(
            f"Import finished in {time.monotonic() - t1:.1f} s: {result.imported} imported, "
            f"{result.skipped} skipped, {result.duplicates} duplicates, {result.errors} errors."
        )

    conn.execute(
        """INSERT INTO import_runs (started_at, finished_at, trigger, scanned, new, imported,
                                    skipped, duplicates, errors, missing)
           VALUES (?, ?, 'cli', ?, ?, ?, ?, ?, ?, ?)""",
        (
            started,
            importer.now_iso(),
            scan.scanned,
            scan.new,
            result.imported,
            result.skipped,
            result.duplicates,
            result.errors,
            scan.missing,
        ),
    )
    return 0


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
                  SUM(a.moving_s) t
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
            f"{_fmt_km(r['distance_m']):>10} {_fmt_duration(r['moving_s']):>9} "
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
        result = importer.run_queue(conn, root)
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
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


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
    p.add_argument("--low-priority", action="store_true", help="run with the lowest CPU priority")
    p.add_argument("--limit", type=int, help="import at most N files")
    p.add_argument("-v", "--verbose", action="store_true", help="print every file")
    p.set_defaults(func=cmd_scan)

    sub.add_parser("status", help="summary of files and activities").set_defaults(func=cmd_status)

    p = sub.add_parser("files", help="list tracked files")
    p.add_argument(
        "--status", choices=["new", "imported", "skipped", "duplicate", "error", "missing"]
    )
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

    args = parser.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    conn = db.connect(args.db)
    try:
        return args.func(conn, args)
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
