"""HTTP API and static preview UI (Starlette).

Starlette instead of FastAPI keeps the resident memory small; the API is plain JSON.
All URLs used by the frontend are relative, so the app works behind HA Ingress.
"""

from __future__ import annotations

import os
import re
import sqlite3
import zipfile
from contextlib import asynccontextmanager, closing
from datetime import UTC, datetime, timedelta
from pathlib import Path

from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException
from starlette.middleware import Middleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import (
    __version__,
    analysis,
    backup,
    basemap,
    db,
    explorer,
    fitfile,
    garmin,
    importer,
    jobs,
    scheduler,
    segments,
    sports,
    streams,
)

STATIC_DIR = Path(__file__).parent / "static"


class _RevalidatedStatic(StaticFiles):
    """Static files that the browser re-checks on every load (ETag), so an updated
    add-on never shows a stale UI."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


ACTIVITY_LIST_FIELDS = (
    "id person_id start_time_utc utc_offset_s category activity_type indoor name "
    "elapsed_s moving_s distance_m ascent_m avg_hr max_hr avg_speed avg_power calories "
    "has_gps"
).split()

# Column key -> SQL expression, for ?sort=<key>&dir=asc|desc
ACTIVITY_SORTS = {
    "date": "start_time_utc",
    "type": "activity_type",
    "name": "name",
    "distance": "distance_m",
    "moving": "moving_s",
    "pace": "avg_speed",
    "hr": "avg_hr",
    "ascent": "ascent_m",
    "person": "person_id",
}

FILE_SORTS = {
    "status": "f.status",
    "file": "f.rel_path || '/' || f.zip_member",
    "person": "f.person_id",
    "content": "COALESCE(a.name, f.skip_reason, f.fit_type, f.error)",
    "recorded": "COALESCE(a.start_time_utc, f.fit_created)",
    "fit": "f.fit_uid",
    "processed": "f.imported_at",
}

# Column key -> SQL expression matched with LIKE '%value%'
FILE_TEXT_FILTERS = {
    "file": "(f.rel_path || ' ' || f.zip_member)",
    "content": (
        "(COALESCE(a.name, '') || ' ' || COALESCE(a.activity_type, '') || ' ' || "
        "COALESCE(f.skip_reason, '') || ' ' || COALESCE(f.fit_type, '') || ' ' || "
        "COALESCE(f.error, ''))"
    ),
    "fit": "f.fit_uid",
    "recorded": "COALESCE(a.start_time_utc, f.fit_created)",
    "processed": "f.imported_at",
}


def _map_filters(q) -> tuple[str, list]:
    """person / type (or g:group) / year filters shared by the map endpoints."""
    where, params = ["a.has_gps = 1"], []
    if q.get("person"):
        values = q["person"].split(",")
        where.append(f"a.person_id IN ({','.join('?' for _ in values)})")
        params += values
    if q.get("type"):
        t = q["type"]
        if t.startswith("g:"):
            where.append("a.category = ?")
            params.append(t[2:])
        else:
            where.append("a.activity_type = ?")
            params.append(t)
    if q.get("year"):
        where.append("substr(a.start_time_utc, 1, 4) = ?")
        params.append(q["year"])
    return " AND ".join(where), params


def _speed_series(c: sqlite3.Connection, activity_id: int, points: int = 48) -> list:
    """Speed (m/s) averaged into `points` equal time buckets, for small tile charts."""
    row = c.execute(
        "SELECT encoding, data FROM streams WHERE activity_id = ? AND channel = 'speed'",
        (activity_id,),
    ).fetchone()
    if row is None:
        return []
    values = streams.decode(row["encoding"], row["data"])
    if not values:
        return []
    size = max(1, len(values) // points)
    out = []
    for i in range(0, len(values), size):
        chunk = [v for v in values[i : i + size] if v is not None]
        out.append(round(sum(chunk) / len(chunk), 3) if chunk else None)
    return out[:points]


def _order(q, sorts: dict[str, str], default: str, tiebreak: str) -> str:
    key = q.get("sort") if q.get("sort") in sorts else default
    direction = "ASC" if q.get("dir") == "asc" else "DESC"
    return f"{sorts[key]} {direction} NULLS LAST, {tiebreak} {direction}"


def _allowed_root(path: Path) -> bool:
    """In the add-on only mapped folders may be used (TRAILBOOK_ALLOWED_ROOTS)."""
    allowed = os.environ.get("TRAILBOOK_ALLOWED_ROOTS")
    if not allowed:
        return True
    return any(path == Path(a) or Path(a) in path.parents for a in allowed.split(os.pathsep))


STREAM_CHANNELS = (
    "time",
    "distance",
    "lat",
    "lon",
    "altitude",
    "hr",
    "speed",
    "power",
    "cadence",
    "temperature",
    "respiration",
)


def create_app(db_path: str | Path) -> Starlette:
    db_path = str(db_path)
    db.connect(db_path).close()  # apply migrations once
    job = jobs.ImportJob(db_path)
    sched = scheduler.Scheduler(db_path, job)
    tiles = basemap.TileCache(Path(db_path).parent / "tilecache")
    uploads_dir = Path(db_path).resolve().parent / "uploads"

    def conn() -> sqlite3.Connection:
        return db.connect(db_path, apply_migrations=False)

    # ---- helpers ---------------------------------------------------------------------

    def _int(request: Request, name: str, default: int, lo: int, hi: int) -> int:
        raw = request.query_params.get(name)
        if raw is None:
            return default
        try:
            return max(lo, min(hi, int(raw)))
        except ValueError as exc:
            raise HTTPException(400, f"invalid {name}") from exc

    def _activity_or_404(c: sqlite3.Connection, activity_id: int) -> sqlite3.Row:
        row = c.execute("SELECT * FROM activities WHERE id = ?", (activity_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "activity not found")
        return row

    # ---- meta ------------------------------------------------------------------------

    async def info(request: Request):
        with closing(conn()) as c:
            return JSONResponse(
                {
                    "version": __version__,
                    "schema": db.schema_version(c),
                    "root": db.get_setting(c, "root"),
                }
            )

    async def type_counts(request: Request):
        """Activities per type for one person (or everyone): filters list only used types."""
        pid = request.query_params.get("person")
        sql = "SELECT activity_type, COUNT(*) FROM activities"
        args: tuple = ()
        if pid:
            sql += " WHERE person_id = ?"
            args = (pid,)
        with closing(conn()) as c:
            counts = dict(c.execute(sql + " GROUP BY activity_type", args).fetchall())
        return JSONResponse(counts)

    async def types(request: Request):
        sources = sports.fit_sources()
        with closing(conn()) as c:
            counts = dict(
                c.execute(
                    "SELECT activity_type, COUNT(*) FROM activities GROUP BY activity_type"
                ).fetchall()
            )
        return JSONResponse(
            {
                "groups": [{"key": k, "en": en, "pl": pl} for k, (en, pl) in sports.GROUPS.items()],
                "types": [
                    {
                        "key": t.key,
                        "group": t.group,
                        "en": t.en,
                        "pl": t.pl,
                        "indoor": t.indoor,
                        "fit": sources[t.key],
                        "activities": counts.get(t.key, 0),
                    }
                    for t in sports.TYPES.values()
                ],
            }
        )

    # ---- persons ---------------------------------------------------------------------

    async def persons(request: Request):
        with closing(conn()) as c:
            rows = c.execute(
                """SELECT p.*, COUNT(a.id) activities FROM persons p
                   LEFT JOIN activities a ON a.person_id = p.id
                   GROUP BY p.id ORDER BY p.sort_order, p.label"""
            ).fetchall()
            return JSONResponse([dict(r) for r in rows])

    async def person_create(request: Request):
        body = await request.json()
        label = str(body.get("label", "")).strip()
        if not label:
            raise HTTPException(400, "label must not be empty")
        base = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-") or "person"
        with closing(conn()) as c:
            pid, n = base, 2
            while c.execute("SELECT 1 FROM persons WHERE id = ?", (pid,)).fetchone():
                pid, n = f"{base}-{n}", n + 1
            c.execute(
                """INSERT INTO persons (id, label, sort_order) VALUES
                   (?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM persons
                           WHERE id != '_unassigned'))""",
                (pid, label),
            )
            row = c.execute("SELECT * FROM persons WHERE id = ?", (pid,)).fetchone()
        return JSONResponse(dict(row), status_code=201)

    # ---- devices (watches) -----------------------------------------------------------

    async def devices(request: Request):
        with closing(conn()) as c:
            rows = c.execute(
                """SELECT d.*, p.label person_label,
                          (SELECT COUNT(*) FROM activities a WHERE a.device_serial = d.serial)
                              activities,
                          (SELECT COUNT(*) FROM files f WHERE f.device_serial = d.serial) files,
                          (SELECT GROUP_CONCAT(DISTINCT f.person_id) FROM files f
                           WHERE f.device_serial = d.serial AND f.person_id != '_unassigned')
                              folders
                   FROM devices d LEFT JOIN persons p ON p.id = d.person_id
                   ORDER BY d.last_seen DESC"""
            ).fetchall()
        items = []
        for r in rows:
            item = dict(r)
            item["product_name"] = fitfile.product_name(r["product"])
            items.append(item)
        return JSONResponse(items)

    async def device_update(request: Request):
        serial = request.path_params["serial"]
        body = await request.json()
        with closing(conn()) as c:
            if c.execute("SELECT 1 FROM devices WHERE serial = ?", (serial,)).fetchone() is None:
                raise HTTPException(404, "device not found")
            moved = None
            if "person_id" in body:
                pid = body["person_id"] or None
                if pid and not c.execute("SELECT 1 FROM persons WHERE id = ?", (pid,)).fetchone():
                    raise HTTPException(400, "unknown person")
                moved = importer.assign_device(c, serial, pid)
            if "label" in body:
                c.execute("UPDATE devices SET label = ? WHERE serial = ?", (body["label"], serial))
        return JSONResponse({"moved_activities": moved})

    # ---- settings --------------------------------------------------------------------

    def _settings(c: sqlite3.Connection) -> dict:
        due = scheduler.next_scan_at(c)
        return {
            "root": db.get_setting(c, "root"),
            "person_mode": importer.person_mode(c),
            "data_source": db.get_setting(c, "data_source") or "folder",
            "scan_interval_min": scheduler.interval_min(c),
            "scan_interval_choices": list(scheduler.INTERVAL_CHOICES_MIN),
            "next_scan_at": due.strftime("%Y-%m-%dT%H:%M:%SZ") if due else None,
            "allowed_roots": os.environ.get("TRAILBOOK_ALLOWED_ROOTS"),
        }

    async def settings_get(request: Request):
        with closing(conn()) as c:
            return JSONResponse(_settings(c))

    async def settings_update(request: Request):
        body = await request.json()
        with closing(conn()) as c:
            if "root" in body:
                root = Path(str(body["root"]).strip()).expanduser()
                if not root.is_absolute():
                    raise HTTPException(400, "folder must be an absolute path")
                if not root.is_dir():
                    raise HTTPException(400, f"folder does not exist: {root}")
                if not _allowed_root(root.resolve()):
                    raise HTTPException(400, "folder is outside the folders shared with Trailbook")
                db.set_setting(c, "root", str(root.resolve()))
            if "data_source" in body:
                if body["data_source"] not in importer.DATA_SOURCES:
                    raise HTTPException(400, "unknown data source")
                db.set_setting(c, "data_source", body["data_source"])
            if "person_mode" in body:
                if body["person_mode"] not in importer.PERSON_MODES:
                    raise HTTPException(400, "unknown person mode")
                db.set_setting(c, "person_mode", body["person_mode"])
            if "scan_interval_min" in body:
                try:
                    minutes = int(body["scan_interval_min"])
                except (TypeError, ValueError) as exc:
                    raise HTTPException(400, "invalid scan interval") from exc
                if minutes < 0:
                    raise HTTPException(400, "invalid scan interval")
                db.set_setting(c, "scan_interval_min", str(minutes))
            result = _settings(c)
        sched.settings_changed()
        return JSONResponse(result)

    async def persons_order(request: Request):
        body = await request.json()
        ids = body.get("ids")
        if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
            raise HTTPException(400, "ids must be a list of person ids")
        with closing(conn()) as c:
            known = {r["id"] for r in c.execute("SELECT id FROM persons")}
            if set(ids) - known:
                raise HTTPException(400, "unknown person in order")
            c.execute("BEGIN")
            for i, pid in enumerate(ids, start=1):
                c.execute("UPDATE persons SET sort_order = ? WHERE id = ?", (i, pid))
            c.execute("COMMIT")
        return Response(status_code=204)

    # ---- comparison ------------------------------------------------------------------

    async def compare(request: Request):
        q = request.query_params
        where, params = [], []
        if q.get("year"):
            where.append("substr(a.start_time_utc, 1, 4) = ?")
            params.append(q["year"])
        clause = f"AND {' AND '.join(where)}" if where else ""
        with closing(conn()) as c:
            people = c.execute(
                f"""SELECT p.id, p.label, p.color, p.icon, p.sort_order,
                           COUNT(a.id) activities, SUM(a.distance_m) distance_m,
                           SUM(a.moving_s) moving_s, SUM(a.ascent_m) ascent_m,
                           SUM(a.calories) calories, MAX(a.start_time_utc) last_activity
                    FROM persons p LEFT JOIN activities a ON a.person_id = p.id {clause}
                    WHERE p.id != '_unassigned'
                    GROUP BY p.id ORDER BY p.sort_order, p.label""",
                params,
            ).fetchall()
            groups = c.execute(
                f"""SELECT a.person_id, a.category, COUNT(*) activities,
                           SUM(a.distance_m) distance_m, SUM(a.moving_s) moving_s
                    FROM activities a WHERE 1 = 1 {clause}
                    GROUP BY a.person_id, a.category""",
                params,
            ).fetchall()
            years = [
                r[0]
                for r in c.execute(
                    "SELECT DISTINCT substr(start_time_utc, 1, 4) y FROM activities ORDER BY y DESC"
                )
            ]
        by_person: dict[str, list] = {}
        for g in groups:
            by_person.setdefault(g["person_id"], []).append(dict(g))
        items = []
        for p in people:
            item = dict(p)
            item["groups"] = sorted(by_person.get(p["id"], []), key=lambda g: -(g["moving_s"] or 0))
            items.append(item)
        return JSONResponse({"years": years, "people": items})

    async def person_update(request: Request):
        pid = request.path_params["id"]
        body = await request.json()
        fields = {k: body[k] for k in ("label", "color", "icon") if k in body}
        if "label" in fields and not str(fields["label"]).strip():
            raise HTTPException(400, "label must not be empty")
        with closing(conn()) as c:
            if c.execute("SELECT 1 FROM persons WHERE id = ?", (pid,)).fetchone() is None:
                raise HTTPException(404, "person not found")
            for key, value in fields.items():
                c.execute(f"UPDATE persons SET {key} = ? WHERE id = ?", (value, pid))
            return JSONResponse(
                dict(c.execute("SELECT * FROM persons WHERE id = ?", (pid,)).fetchone())
            )

    # ---- activities ------------------------------------------------------------------

    async def activities(request: Request):
        q = request.query_params
        where, params = [], []
        for name, column in (
            ("person", "person_id"),
            ("group", "category"),
            ("type", "activity_type"),
        ):
            if q.get(name):
                values = q[name].split(",")
                if name == "type" and len(values) == 1 and values[0].startswith("g:"):
                    column, values = "category", [values[0][2:]]  # whole group
                where.append(f"{column} IN ({','.join('?' for _ in values)})")
                params += values
        if q.get("date"):
            where.append("start_time_utc LIKE ?")
            params.append(f"{q['date']}%")
        if q.get("from"):
            where.append("start_time_utc >= ?")
            params.append(q["from"])
        if q.get("to"):
            where.append("start_time_utc < ?")
            params.append(q["to"])
        if q.get("gps") == "1":
            where.append("has_gps = 1")
        if q.get("q"):
            where.append("name LIKE ?")
            params.append(f"%{q['q']}%")
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        limit = _int(request, "limit", 50, 1, 1000)
        offset = _int(request, "offset", 0, 0, 10**9)
        order = _order(q, ACTIVITY_SORTS, "date", "id")
        with closing(conn()) as c:
            totals = c.execute(
                f"""SELECT COUNT(*) count, SUM(distance_m) distance_m, SUM(moving_s) moving_s,
                           SUM(ascent_m) ascent_m, SUM(calories) calories,
                           COUNT(DISTINCT substr(start_time_utc, 1, 10)) active_days,
                           MAX(distance_m) longest_m, MAX(moving_s) longest_s,
                           MIN(start_time_utc) first, MAX(start_time_utc) last
                    FROM activities {clause}""",
                params,
            ).fetchone()
            fields = ", ".join(ACTIVITY_LIST_FIELDS)
            with_track = q.get("track") == "1"
            if with_track:
                fields += ", (SELECT polyline FROM tracks t WHERE t.activity_id = id) polyline"
            rows = c.execute(
                f"""SELECT {fields} FROM activities {clause}
                    ORDER BY {order} LIMIT ? OFFSET ?""",
                [*params, limit, offset],
            ).fetchall()
            items = [dict(r) for r in rows]
            if q.get("chart") == "pace":
                for item in items:
                    item["speed_series"] = _speed_series(c, item["id"])
            return JSONResponse(
                {
                    "total": totals["count"],
                    "totals": dict(totals),
                    "items": items,
                }
            )

    async def activity(request: Request):
        aid = request.path_params["id"]
        with closing(conn()) as c:
            a = dict(_activity_or_404(c, aid))
            a["laps"] = [
                dict(r)
                for r in c.execute("SELECT * FROM laps WHERE activity_id = ? ORDER BY idx", (aid,))
            ]
            a["channels"] = [
                r["channel"]
                for r in c.execute("SELECT channel FROM streams WHERE activity_id = ?", (aid,))
            ]
            a["best_efforts"] = [
                dict(r)
                for r in c.execute(
                    "SELECT kind, key, value FROM best_efforts WHERE activity_id = ?"
                    " ORDER BY kind, key",
                    (aid,),
                )
            ]
            a["files"] = [
                dict(r)
                for r in c.execute(
                    "SELECT id, rel_path, zip_member, status FROM files WHERE activity_id = ?",
                    (aid,),
                )
            ]
            return JSONResponse(a)

    async def activity_update(request: Request):
        aid = request.path_params["id"]
        body = await request.json()
        with closing(conn()) as c:
            _activity_or_404(c, aid)
            if "type" in body:
                if body["type"] not in sports.TYPES:
                    raise HTTPException(400, "unknown activity type")
                importer.set_activity_type(c, aid, body["type"])
                analysis.analyse_one(c, aid)  # the group decides e.g. running best efforts
            if "name" in body:
                c.execute(
                    "UPDATE activities SET name = ?, name_overridden = 1 WHERE id = ?",
                    (body["name"], aid),
                )
            return JSONResponse(dict(_activity_or_404(c, aid)))

    async def activity_delete(request: Request):
        aid = request.path_params["id"]
        with closing(conn()) as c:
            if not importer.delete_activity(c, aid):
                raise HTTPException(404, "activity not found")
        return Response(status_code=204)

    async def activity_streams(request: Request):
        aid = request.path_params["id"]
        wanted = request.query_params.get("channels")
        channels = wanted.split(",") if wanted else list(STREAM_CHANNELS)
        if any(ch not in STREAM_CHANNELS for ch in channels):
            raise HTTPException(400, "unknown channel")
        max_points = _int(request, "max_points", 0, 0, 100_000)
        with closing(conn()) as c:
            _activity_or_404(c, aid)
            marks = ",".join("?" for _ in channels)
            rows = c.execute(
                f"""SELECT channel, encoding, data FROM streams
                    WHERE activity_id = ? AND channel IN ({marks})""",
                [aid, *channels],
            ).fetchall()
        data = {r["channel"]: streams.decode(r["encoding"], r["data"]) for r in rows}
        length = max((len(v) for v in data.values()), default=0)
        if max_points and length > max_points:
            # Even stride keeps all channels aligned; good enough for overview charts.
            step = length / max_points
            idx = [int(i * step) for i in range(max_points)]
            data = {k: [v[i] for i in idx] for k, v in data.items()}
            length = max_points
        return JSONResponse({"length": length, "streams": data})

    async def activity_track(request: Request):
        aid = request.path_params["id"]
        with closing(conn()) as c:
            _activity_or_404(c, aid)
            row = c.execute(
                "SELECT polyline, point_count FROM tracks WHERE activity_id = ?", (aid,)
            ).fetchone()
        if row is None:
            raise HTTPException(404, "activity has no track")
        return JSONResponse({"polyline": row["polyline"], "points": row["point_count"]})

    # ---- heatmap ---------------------------------------------------------------------

    async def heatmap_tracks(request: Request):
        where, params = _map_filters(request.query_params)
        with closing(conn()) as c:
            rows = c.execute(
                f"""SELECT a.id, a.person_id, a.activity_type, a.category,
                           substr(a.start_time_utc, 1, 10) day, a.distance_m, a.moving_s,
                           a.ascent_m, t.polyline
                    FROM activities a JOIN tracks t ON t.activity_id = a.id
                    WHERE {where} ORDER BY a.start_time_utc""",
                params,
            ).fetchall()
            years = [
                r[0]
                for r in c.execute(
                    "SELECT DISTINCT substr(start_time_utc, 1, 4) y FROM activities "
                    "WHERE has_gps = 1 ORDER BY y DESC"
                )
            ]
        return JSONResponse({"years": years, "items": [dict(r) for r in rows]})

    async def heatmap_tiles(request: Request):
        where, params = _map_filters(request.query_params)
        with closing(conn()) as c:
            rows = c.execute(
                f"""SELECT t.x, t.y, MIN(a.start_time_utc) first, COUNT(*) visits
                    FROM activity_tiles t JOIN activities a ON a.id = t.activity_id
                    WHERE {where} GROUP BY t.x, t.y""",
                params,
            ).fetchall()
            pending = c.execute(
                "SELECT COUNT(*) FROM activities WHERE has_gps = 1 AND tiles_version < ?",
                (importer.TILES_VERSION,),
            ).fetchone()[0]
        tiles = {(r["x"], r["y"]) for r in rows}
        size, sx, sy = explorer.max_square(tiles)
        clus = explorer.cluster(tiles)
        return JSONResponse(
            {
                "zoom": explorer.ZOOM,
                "count": len(tiles),
                "tiles": [[r["x"], r["y"], r["first"], r["visits"]] for r in rows],
                "max_square": {"size": size, "x": sx, "y": sy},
                "cluster": {"size": len(clus), "tiles": sorted(clus)},
                "pending_activities": pending,
            }
        )

    async def basemaps(request: Request):
        return JSONResponse(
            [
                {"key": k, "label": label, "max_zoom": mz, "attribution": attr}
                for k, (_, mz, attr, label) in basemap.SOURCES.items()
            ]
        )

    async def basemap_tile(request: Request):
        source = request.path_params["source"]
        z, x, y = (request.path_params[k] for k in ("z", "x", "y"))
        if source not in basemap.SOURCES:
            raise HTTPException(404, "unknown base map")
        template, max_zoom, _, _ = basemap.SOURCES[source]
        if not (0 <= z <= max_zoom and 0 <= x < 2**z and 0 <= y < 2**z):
            raise HTTPException(404, "tile out of range")
        try:
            data, media_type = await run_in_threadpool(tiles.get, template, z, x, y)
        except basemap.TileError as exc:
            raise HTTPException(502, str(exc)) from exc
        return Response(
            data, media_type=media_type, headers={"Cache-Control": "public, max-age=604800"}
        )

    # ---- import manager --------------------------------------------------------------

    async def import_status(request: Request):
        with closing(conn()) as c:
            counts = {
                r["status"]: r["n"]
                for r in c.execute("SELECT status, COUNT(*) n FROM files GROUP BY status")
            }
            undismissed_missing = c.execute(
                "SELECT COUNT(*) FROM files WHERE status = 'missing' AND dismissed = 0"
            ).fetchone()[0]
            last = c.execute("SELECT * FROM import_runs ORDER BY id DESC LIMIT 1").fetchone()
            progress = jobs.read_progress(c)
            root = db.get_setting(c, "root")
            source = db.get_setting(c, "data_source") or "folder"
            due = scheduler.next_scan_at(c)
            interval = scheduler.interval_min(c)
        running = job.running_kind() in ("scan", "restore")
        if not running and progress.get("state") == "running":
            # Started outside this server (CLI) or the process died; report what we know.
            progress["state"] = "running?"
        return JSONResponse(
            {
                "root": root,
                "data_source": source,
                "running": running,
                "progress": progress,
                "files": counts,
                "missing_to_review": undismissed_missing,
                "last_run": dict(last) if last else None,
                "scan_interval_min": interval,
                "next_scan_at": due.strftime("%Y-%m-%dT%H:%M:%SZ") if due else None,
            }
        )

    async def upload(request: Request):
        """Raw body upload of one .zip or .fit for a chosen person (one-time import)."""
        pid = request.query_params.get("person", "")
        name = Path(request.query_params.get("name", "")).name
        if not name.lower().endswith((".zip", ".fit")):
            raise HTTPException(400, "only .zip or .fit files can be uploaded")
        with closing(conn()) as c:
            if (
                pid == importer.UNASSIGNED
                or not c.execute("SELECT 1 FROM persons WHERE id = ?", (pid,)).fetchone()
            ):
                raise HTTPException(400, "choose a person")
        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", name)
        stamp = importer.now_iso().replace(":", "").replace("-", "")
        target = uploads_dir / re.sub(r"[^A-Za-z0-9._-]+", "_", pid) / f"{stamp}-{safe}"
        target.parent.mkdir(parents=True, exist_ok=True)
        size = 0
        with target.open("wb") as fh:
            async for chunk in request.stream():
                size += len(chunk)
                fh.write(chunk)
        if size == 0:
            target.unlink(missing_ok=True)
            raise HTTPException(400, "empty file")
        try:
            with closing(conn()) as c:
                queued = importer.register_upload(c, uploads_dir, pid, target)
        except zipfile.BadZipFile as exc:
            target.unlink(missing_ok=True)
            raise HTTPException(400, "not a valid ZIP file") from exc
        started = job.start(trigger="upload")
        return JSONResponse({"queued": queued, "started": started, "bytes": size}, status_code=202)

    # ---- training: thresholds, fitness, calendar, statistics ---------------------------

    def _single_person(c: sqlite3.Connection, request: Request) -> str:
        pid = request.query_params.get("person") or request.path_params.get("id") or ""
        if not c.execute("SELECT 1 FROM persons WHERE id = ?", (pid,)).fetchone():
            raise HTTPException(400, "choose a person")
        return pid

    def _thresholds_state(c: sqlite3.Connection, pid: str) -> dict:
        rows = analysis.threshold_rows(c, pid)
        auto_max = analysis.auto_hr_max(c, pid)
        th = analysis.thresholds_for(rows, importer.now_iso()[:10], auto_max)
        return {
            "rows": [dict(r) for r in rows],
            "effective": {
                "hr_max": th.hr_max, "hr_rest": th.hr_rest, "lthr": th.lthr, "ftp": th.ftp,
                "threshold_pace": th.threshold_pace, "sources": th.sources,
            },
            "auto_hr_max": auto_max,
            "pending": c.execute(
                "SELECT COUNT(*) FROM activities WHERE person_id = ? AND analysis_version < ?",
                (pid, analysis.ANALYSIS_VERSION),
            ).fetchone()[0],
        }  # fmt: skip

    async def thresholds_get(request: Request):
        with closing(conn()) as c:
            pid = _single_person(c, request)
            return JSONResponse(_thresholds_state(c, pid))

    THRESHOLD_LIMITS = {
        "hr_max": (100, 230), "hr_rest": (25, 120), "lthr": (80, 220), "ftp": (30, 700),
        "threshold_pace": (120, 900), "swim_css": (40, 400), "weight": (20, 300),
    }  # fmt: skip

    async def thresholds_put(request: Request):
        body = await request.json()
        valid_from = str(body.get("valid_from") or "1970-01-01")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", valid_from):
            raise HTTPException(400, "valid from must be a date (YYYY-MM-DD)")
        values = {}
        for f, (lo, hi) in THRESHOLD_LIMITS.items():
            v = body.get(f)
            if v in (None, ""):
                values[f] = None
                continue
            try:
                v = float(v)
            except (TypeError, ValueError) as exc:
                raise HTTPException(400, f"invalid {f}") from exc
            if not lo <= v <= hi:
                raise HTTPException(400, f"{f} must be between {lo} and {hi}")
            values[f] = v
        cols = ", ".join(values)
        marks = ", ".join("?" for _ in values)
        with closing(conn()) as c:
            pid = _single_person(c, request)
            c.execute(
                f"""INSERT OR REPLACE INTO person_thresholds (person_id, valid_from, {cols})
                    VALUES (?, ?, {marks})""",
                (pid, valid_from, *values.values()),
            )
            analysis.reset_person(c, pid)
            result = _thresholds_state(c, pid)
        job.start(trigger="analysis")
        return JSONResponse(result)

    async def thresholds_delete(request: Request):
        with closing(conn()) as c:
            pid = _single_person(c, request)
            c.execute(
                "DELETE FROM person_thresholds WHERE person_id = ? AND valid_from = ?",
                (pid, request.path_params["valid_from"]),
            )
            analysis.reset_person(c, pid)
            result = _thresholds_state(c, pid)
        job.start(trigger="analysis")
        return JSONResponse(result)

    async def fitness(request: Request):
        with closing(conn()) as c:
            pid = _single_person(c, request)
            series = analysis.fitness_series(analysis.daily_loads(c, pid))
            methods = {
                (r[0] or "none"): r[1]
                for r in c.execute(
                    "SELECT load_method, COUNT(*) FROM activities WHERE person_id = ?"
                    " GROUP BY load_method",
                    (pid,),
                )
            }
            th = _thresholds_state(c, pid)
        since = request.query_params.get("from")
        shown = [d for d in series if not since or d["date"] >= since]
        return JSONResponse(
            {
                "series": shown,
                "first": series[0]["date"] if series else None,
                "methods": methods,
                "thresholds": th["effective"],
                "pending": th["pending"],
            }
        )

    async def calendar(request: Request):
        q = request.query_params
        start, end = q.get("from", ""), q.get("to", "")
        for d in (start, end):
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", d):
                raise HTTPException(400, "from / to must be dates (YYYY-MM-DD)")
        day = analysis.LOCAL_DAY_SQL
        where, params = [f"{day} BETWEEN ? AND ?"], [start, end]
        if q.get("person") and q["person"] != "all":
            where.append("person_id = ?")
            params.append(q["person"])
        with closing(conn()) as c:
            rows = c.execute(
                f"""SELECT id, person_id, start_time_utc, utc_offset_s, activity_type, category,
                           name, distance_m, moving_s, ascent_m, load, {day} AS day
                    FROM activities WHERE {" AND ".join(where)} ORDER BY start_time_utc""",
                params,
            ).fetchall()
        return JSONResponse({"activities": [dict(r) for r in rows]})

    async def stats_totals(request: Request):
        q = request.query_params
        period = {
            "year": "substr(day, 1, 4)",
            "month": "substr(day, 1, 7)",
            "week": "strftime('%Y-W%W', day)",
        }.get(q.get("by", "year"))
        if period is None:
            raise HTTPException(400, "by must be year, month or week")
        day = analysis.LOCAL_DAY_SQL
        with closing(conn()) as c:
            pid = _single_person(c, request)
            where, params = ["person_id = ?"], [pid]
            t = q.get("type", "")
            if t.startswith("g:"):
                where.append("category = ?")
                params.append(t[2:])
            elif t:
                where.append("activity_type = ?")
                params.append(t)
            inner = f"SELECT *, {day} AS day FROM activities WHERE {' AND '.join(where)}"
            outer = ""
            if q.get("year"):
                outer = "WHERE substr(day, 1, 4) = ?"
                params.append(q["year"])
            rows = c.execute(
                f"""SELECT {period} AS period, COUNT(*) AS count, SUM(distance_m) AS distance_m,
                           SUM(moving_s) AS moving_s, SUM(ascent_m) AS ascent_m,
                           SUM(load) AS load, SUM(calories) AS calories,
                           COUNT(DISTINCT day) AS active_days
                    FROM ({inner}) {outer} GROUP BY period ORDER BY period""",
                params,
            ).fetchall()
            groups = c.execute(
                f"""SELECT category, COUNT(*) AS count, SUM(distance_m) AS distance_m,
                           SUM(moving_s) AS moving_s
                    FROM ({inner}) {outer} GROUP BY category ORDER BY moving_s DESC""",
                params,
            ).fetchall()
            years = [
                r[0]
                for r in c.execute(
                    f"""SELECT DISTINCT substr({day}, 1, 4) AS y FROM activities
                        WHERE person_id = ? ORDER BY y DESC""",
                    (pid,),
                )
            ]
        return JSONResponse(
            {"rows": [dict(r) for r in rows], "groups": [dict(r) for r in groups], "years": years}
        )

    async def stats_records(request: Request):
        q = request.query_params
        kind = q.get("kind", "pace")
        if kind not in ("pace", "power", "hr"):
            raise HTTPException(400, "kind must be pace, power or hr")
        rng = q.get("range", "all")
        with closing(conn()) as c:
            pid = _single_person(c, request)
            where, params = ["a.person_id = ?", "b.kind = ?"], [pid, kind]
            t = q.get("type", "")
            if t.startswith("g:"):
                where.append("a.category = ?")
                params.append(t[2:])
            elif t:
                where.append("a.activity_type = ?")
                params.append(t)
            if rng == "90d":
                since = datetime.now(UTC) - timedelta(days=90)
                where.append("a.start_time_utc >= ?")
                params.append(since.strftime("%Y-%m-%dT%H:%M:%SZ"))
            elif re.fullmatch(r"\d{4}", rng):
                where.append("substr(a.start_time_utc, 1, 4) = ?")
                params.append(rng)
            elif rng != "all":
                raise HTTPException(400, "range must be all, 90d or a year")
            order = "ASC" if kind == "pace" else "DESC"  # pace: lowest time wins
            rows = c.execute(
                f"""WITH e AS (
                        SELECT b.key, b.value, a.id, a.name, a.activity_type, a.start_time_utc,
                               a.utc_offset_s,
                               ROW_NUMBER() OVER (PARTITION BY b.key
                                   ORDER BY b.value {order}, a.start_time_utc) AS rk
                        FROM best_efforts b JOIN activities a ON a.id = b.activity_id
                        WHERE {" AND ".join(where)})
                    SELECT key, value, id, name, activity_type, start_time_utc, utc_offset_s
                    FROM e WHERE rk = 1 ORDER BY key""",
                params,
            ).fetchall()
            years = [
                r[0]
                for r in c.execute(
                    """SELECT DISTINCT substr(a.start_time_utc, 1, 4) AS y
                       FROM best_efforts b JOIN activities a ON a.id = b.activity_id
                       WHERE a.person_id = ? AND b.kind = ? ORDER BY y DESC""",
                    (pid, kind),
                )
            ]
        return JSONResponse({"kind": kind, "records": [dict(r) for r in rows], "years": years})

    # ---- segments ----------------------------------------------------------------------

    EFFORT_COLS = """e.id, e.segment_id, e.activity_id, e.start_time_utc, e.start_s, e.end_s,
        e.elapsed_s, e.moving_s, e.avg_speed, e.avg_hr, e.max_hr, e.avg_power, e.avg_cadence,
        a.person_id, a.utc_offset_s, a.name AS activity_name, a.activity_type"""

    def _segment_or_404(c: sqlite3.Connection, sid: int) -> sqlite3.Row:
        row = c.execute("SELECT * FROM segments WHERE id = ?", (sid,)).fetchone()
        if row is None:
            raise HTTPException(404, "segment not found")
        return row

    def _segment_dict(s: sqlite3.Row) -> dict:
        d = dict(s)
        d["pending"] = s["match_version"] < segments.MATCH_VERSION
        return d

    def _person_filter(request: Request) -> tuple[str, list]:
        pid = request.query_params.get("person")
        if pid and pid != "all":
            return " AND a.person_id = ?", [pid]
        return "", []

    def _kick_matching(c: sqlite3.Connection) -> None:
        """Pending segment work and no job running: start the matcher (self-healing when a
        segment was created while another job ran)."""
        if segments.pending(c) and not job.running():
            job.start_segments()

    async def segments_list(request: Request):
        pf, pp = _person_filter(request)
        with closing(conn()) as c:
            segs = c.execute("SELECT * FROM segments ORDER BY name COLLATE NOCASE").fetchall()
            rows = c.execute(
                f"""WITH e AS (
                        SELECT {EFFORT_COLS},
                          ROW_NUMBER() OVER (PARTITION BY e.segment_id
                                             ORDER BY e.elapsed_s, e.start_time_utc) AS rb,
                          ROW_NUMBER() OVER (PARTITION BY e.segment_id
                                             ORDER BY e.start_time_utc DESC) AS rl,
                          COUNT(*) OVER (PARTITION BY e.segment_id) AS n,
                          AVG(e.elapsed_s) OVER (PARTITION BY e.segment_id) AS avg_elapsed
                        FROM segment_efforts e JOIN activities a ON a.id = e.activity_id
                        WHERE 1 = 1 {pf})
                    SELECT * FROM e WHERE rb = 1 OR rl = 1""",
                pp,
            ).fetchall()
            people = dict(
                c.execute(
                    f"""SELECT e.segment_id, COUNT(DISTINCT a.person_id)
                        FROM segment_efforts e JOIN activities a ON a.id = e.activity_id
                        WHERE 1 = 1 {pf} GROUP BY e.segment_id""",
                    pp,
                ).fetchall()
            )
            _kick_matching(c)
            matching = segments.pending(c)
        by_seg: dict[int, dict] = {}
        for r in rows:
            d = by_seg.setdefault(r["segment_id"], {})
            effort = {k: r[k] for k in r.keys() if k not in ("rb", "rl", "n", "avg_elapsed")}
            d["efforts"], d["avg_elapsed_s"] = r["n"], r["avg_elapsed"]
            if r["rb"] == 1:
                d["best"] = effort
            if r["rl"] == 1:
                d["last"] = effort
        items = []
        for s in segs:
            item = _segment_dict(s)
            item.update({"efforts": 0, "best": None, "last": None, "avg_elapsed_s": None})
            item.update(by_seg.get(s["id"], {}))
            item["people"] = people.get(s["id"], 0)
            items.append(item)
        return JSONResponse({"items": items, "matching": matching})

    def _local_day(e: dict) -> str:
        t = datetime.strptime(e["start_time_utc"][:19], "%Y-%m-%dT%H:%M:%S")
        return (t + timedelta(seconds=e["utc_offset_s"] or 0)).date().isoformat()

    def _period_stats(efforts: list[dict]) -> dict:
        times = sorted(e["elapsed_s"] for e in efforts)
        if not times:
            return {"count": 0, "best_s": None, "avg_s": None, "median_s": None}
        mid = len(times) // 2
        median = times[mid] if len(times) % 2 else (times[mid - 1] + times[mid]) / 2
        return {
            "count": len(times),
            "best_s": times[0],
            "avg_s": round(sum(times) / len(times), 1),
            "median_s": round(median, 1),
        }

    def _trend(efforts: list[dict]) -> dict:
        today = datetime.now(UTC).date()
        monday = today - timedelta(days=today.weekday())
        weeks = [(monday - timedelta(weeks=k)).isoformat() for k in range(11, -1, -1)]
        months, y, m = [], today.year, today.month
        for _ in range(12):
            months.insert(0, f"{y:04d}-{m:02d}")
            y, m = (y, m - 1) if m > 1 else (y - 1, 12)
        by_week: dict[str, list] = {w: [] for w in weeks}
        by_month: dict[str, list] = {mo: [] for mo in months}
        for e in efforts:
            day = datetime.strptime(e["day"], "%Y-%m-%d").date()
            wk = (day - timedelta(days=day.weekday())).isoformat()
            if wk in by_week:
                by_week[wk].append(e)
            if e["day"][:7] in by_month:
                by_month[e["day"][:7]].append(e)
        return {
            "weeks": [{"period": w, **_period_stats(v)} for w, v in by_week.items()],
            "months": [{"period": mo, **_period_stats(v)} for mo, v in by_month.items()],
        }

    async def segment_detail(request: Request):
        sid = request.path_params["id"]
        pf, pp = _person_filter(request)
        with closing(conn()) as c:
            s = _segment_or_404(c, sid)
            rows = c.execute(
                f"""SELECT {EFFORT_COLS} FROM segment_efforts e
                    JOIN activities a ON a.id = e.activity_id
                    WHERE e.segment_id = ? {pf} ORDER BY e.elapsed_s, e.start_time_utc""",
                [sid, *pp],
            ).fetchall()
            source = None
            if s["source_activity_id"]:
                src = c.execute(
                    "SELECT id, name, activity_type, start_time_utc, utc_offset_s, person_id"
                    " FROM activities WHERE id = ?",
                    (s["source_activity_id"],),
                ).fetchone()
                source = dict(src) if src else None
            _kick_matching(c)
        efforts = [dict(r) for r in rows]
        for i, e in enumerate(efforts, 1):
            e["rank"] = i
            e["day"] = _local_day(e)
        last = max(efforts, key=lambda e: e["start_time_utc"]) if efforts else None
        per_person = {}
        for e in efforts:  # efforts are fastest first, so the first one is the best
            p = per_person.setdefault(e["person_id"], {"person_id": e["person_id"], "list": []})
            p["list"].append(e)
        people = []
        for p in per_person.values():
            lst = p.pop("list")
            p.update(_period_stats(lst))
            p["best"] = lst[0]
            p["last"] = max(lst, key=lambda e: e["start_time_utc"])
            people.append(p)
        people.sort(key=lambda p: p["best_s"])
        return JSONResponse(
            {
                "segment": _segment_dict(s),
                "source": source,
                "summary": _period_stats(efforts),
                "best": efforts[0] if efforts else None,
                "last": last,
                "top": efforts[:10],
                "trend": _trend(efforts),
                "people": people,
            }
        )

    async def segment_efforts(request: Request):
        sid = request.path_params["id"]
        pf, pp = _person_filter(request)
        order = (
            "e.start_time_utc DESC"
            if request.query_params.get("sort") == "date"
            else "e.elapsed_s, e.start_time_utc"
        )
        limit = _int(request, "limit", 50, 1, 500)
        offset = _int(request, "offset", 0, 0, 10**9)
        with closing(conn()) as c:
            _segment_or_404(c, sid)
            total = c.execute(
                f"""SELECT COUNT(*) FROM segment_efforts e JOIN activities a
                    ON a.id = e.activity_id WHERE e.segment_id = ? {pf}""",
                [sid, *pp],
            ).fetchone()[0]
            rows = c.execute(
                f"""SELECT {EFFORT_COLS},
                           (SELECT COUNT(*) + 1 FROM segment_efforts e2
                            JOIN activities a2 ON a2.id = e2.activity_id
                            WHERE e2.segment_id = e.segment_id {pf.replace("a.", "a2.")}
                              AND e2.elapsed_s < e.elapsed_s) AS rank
                    FROM segment_efforts e JOIN activities a ON a.id = e.activity_id
                    WHERE e.segment_id = ? {pf} ORDER BY {order} LIMIT ? OFFSET ?""",
                [*pp, sid, *pp, limit, offset],
            ).fetchall()
        return JSONResponse({"total": total, "items": [dict(r) for r in rows]})

    def _float(body: dict, key: str) -> float:
        try:
            return float(body[key])
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(400, f"invalid {key}") from exc

    async def segment_create(request: Request):
        body = await request.json()
        try:
            aid = int(body.get("activity_id"))
        except (TypeError, ValueError) as exc:
            raise HTTPException(400, "choose an activity") from exc
        source = "map" if body.get("source") == "map" else "activity"
        with closing(conn()) as c:
            try:
                sid = segments.create_from_activity(
                    c, aid, _float(body, "start_s"), _float(body, "end_s"),
                    str(body.get("name") or ""), any_type=bool(body.get("any_type")),
                    source=source,
                )  # fmt: skip
            except segments.SegmentError as exc:
                raise HTTPException(400, str(exc)) from exc
            row = _segment_or_404(c, sid)
        job.start_segments()
        return JSONResponse(_segment_dict(row), status_code=201)

    async def segment_snap(request: Request):
        body = await request.json()
        raw = body.get("pins")
        try:
            pins = [(float(p[0]), float(p[1])) for p in raw]
        except (TypeError, ValueError, IndexError) as exc:
            raise HTTPException(400, "pins must be [lat, lon] pairs") from exc
        if len(pins) > 50:
            raise HTTPException(400, "at most 50 pins")
        category = body.get("category") or None
        if category and category not in sports.GROUPS:
            raise HTTPException(400, "unknown activity group")

        def run():
            with closing(conn()) as c:
                return segments.snap(c, pins, category)

        try:
            result = await run_in_threadpool(run)
        except segments.SegmentError as exc:
            raise HTTPException(400, str(exc)) from exc
        if result is None:
            raise HTTPException(
                404, "none of your activities passes all pins in this order (within 50 m)"
            )
        return JSONResponse(result)

    async def segment_update(request: Request):
        sid = request.path_params["id"]
        body = await request.json()
        with closing(conn()) as c:
            s = _segment_or_404(c, sid)
            if "name" in body:
                name = str(body["name"] or "").strip()
                if not name:
                    raise HTTPException(400, "name must not be empty")
                c.execute("UPDATE segments SET name = ? WHERE id = ?", (name[:120], sid))
            if "any_type" in body:
                category = None
                if not body["any_type"]:
                    src = c.execute(
                        "SELECT category FROM activities WHERE id = ?", (s["source_activity_id"],)
                    ).fetchone()
                    category = src["category"] if src else s["category"]
                if category != s["category"]:
                    c.execute("UPDATE segments SET category = ? WHERE id = ?", (category, sid))
                    segments.reset_segment(c, sid)
                    job.start_segments()
            return JSONResponse(_segment_dict(_segment_or_404(c, sid)))

    async def segment_delete(request: Request):
        with closing(conn()) as c:
            _segment_or_404(c, request.path_params["id"])
            c.execute("DELETE FROM segments WHERE id = ?", (request.path_params["id"],))
        return Response(status_code=204)

    # ---- Garmin Connect ----------------------------------------------------------------

    def _person_or_400(c: sqlite3.Connection, pid: str) -> None:
        if (
            pid == importer.UNASSIGNED
            or not c.execute("SELECT 1 FROM persons WHERE id = ?", (pid,)).fetchone()
        ):
            raise HTTPException(400, "choose a person")

    async def garmin_accounts(request: Request):
        with closing(conn()) as c:
            return JSONResponse({"accounts": garmin.accounts(c)})

    async def garmin_account_set(request: Request):
        pid = request.path_params["id"]
        body = await request.json()
        key = str(body.get("api_key") or "").strip()
        history_from = body.get("history_from") or None
        if history_from is not None and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(history_from)):
            raise HTTPException(400, "history start must be a date (YYYY-MM-DD)")
        with closing(conn()) as c:
            _person_or_400(c, pid)
            if key:
                if len(key) < 16 or re.search(r"\s", key):
                    raise HTTPException(400, "this does not look like a Garmin personal API key")
                garmin.set_account(c, pid, key, history_from)
            elif c.execute("SELECT 1 FROM garmin_accounts WHERE person_id = ?", (pid,)).fetchone():
                c.execute(
                    """UPDATE garmin_accounts SET history_from = ?, backfill_offset = 0,
                              backfill_done = 0 WHERE person_id = ?""",
                    (history_from, pid),
                )
            else:
                raise HTTPException(400, "enter the API key")
        sched.settings_changed()
        return await garmin_account_test(request)

    async def garmin_account_test(request: Request):
        pid = request.path_params["id"]

        def run() -> dict:
            with closing(conn()) as c:
                try:
                    return garmin.test_account(c, pid)
                except garmin.GarminError as exc:
                    return {"ok": False, "error": str(exc)}

        result = await run_in_threadpool(run)
        with closing(conn()) as c:
            result["account"] = garmin.accounts(c).get(pid)
        return JSONResponse(result)

    async def garmin_account_delete(request: Request):
        pid = request.path_params["id"]
        with closing(conn()) as c:
            c.execute("DELETE FROM garmin_accounts WHERE person_id = ?", (pid,))
        sched.settings_changed()
        return JSONResponse({"deleted": True})

    # ---- export / restore --------------------------------------------------------------

    def _job_progress(kind: str) -> dict:
        p = backup.read_progress(db_path, kind)
        if p.get("state") == "running" and job.running_kind() != kind:
            p["state"] = "running?"  # started outside this server, or the process died
        return p

    async def backup_status(request: Request):
        def collect():
            return {
                "running": job.running_kind(),
                "export": _job_progress("export"),
                "restore": _job_progress("restore"),
                "exports": backup.list_exports(db_path),
                "exports_dir": str(backup.exports_dir(db_path)),
                "empty": backup.is_empty_install(db_path),
                "default_root": str(backup.default_restore_root(db_path)),
            }

        return JSONResponse(await run_in_threadpool(collect))

    async def export_start(request: Request):
        try:
            body = await request.json()
        except ValueError:
            body = {}
        if not isinstance(body, dict):
            body = {}
        files = bool(body.get("files", True))
        if not job.start_export(include_files=files, include_secrets=bool(body.get("secrets"))):
            return JSONResponse({"started": False, "reason": "another job is running"}, 409)
        backup.write_progress(db_path, "export", state="running", phase="start",
                              started_at=backup.now_iso())  # fmt: skip
        return JSONResponse({"started": True}, status_code=202)

    def _export_file(request: Request) -> Path:
        try:
            path = backup.export_path(db_path, request.path_params["name"])
        except backup.BackupError as exc:
            raise HTTPException(404, "export not found") from exc
        if not path.is_file():
            raise HTTPException(404, "export not found")
        return path

    async def export_download(request: Request):
        path = _export_file(request)
        return FileResponse(path, media_type="application/zip", filename=path.name)

    async def export_delete(request: Request):
        if job.running_kind() in ("export", "restore"):
            raise HTTPException(409, "wait until the running export or restore has finished")
        _export_file(request).unlink()
        return JSONResponse({"deleted": True})

    async def restore_start(request: Request):
        """Restore an archive from the exports folder (`name`) or from the request body."""
        q = request.query_params
        if job.running():
            raise HTTPException(409, "another job is running")
        root = (q.get("root") or "").strip() or None
        if root:
            rp = Path(root).expanduser()
            if not rp.is_absolute() or not _allowed_root(rp.resolve()):
                raise HTTPException(400, "the files folder must be an allowed absolute path")
            root = str(rp.resolve())
        if not q.get("confirm") and not await run_in_threadpool(backup.is_empty_install, db_path):
            raise HTTPException(409, "this install already has data: confirm replacing it")
        uploaded = False
        if q.get("name"):
            try:
                archive = backup.export_path(db_path, q["name"])
            except backup.BackupError as exc:
                raise HTTPException(400, str(exc)) from exc
            if not archive.is_file():
                raise HTTPException(404, "export not found")
        else:
            folder = backup.exports_dir(db_path)
            folder.mkdir(parents=True, exist_ok=True)
            stamp = backup.now_iso().replace(":", "").replace("-", "")
            archive = folder / f".restore-upload-{stamp}.zip"
            size = 0
            with archive.open("wb") as fh:
                async for chunk in request.stream():
                    size += len(chunk)
                    fh.write(chunk)
            if size == 0:
                archive.unlink(missing_ok=True)
                raise HTTPException(400, "empty file")
            uploaded = True
        try:
            manifest = await run_in_threadpool(backup.read_manifest, archive)
        except backup.BackupError as exc:
            if uploaded:
                archive.unlink(missing_ok=True)
            raise HTTPException(400, str(exc)) from exc
        if not job.start_restore(archive, root, delete_archive=uploaded):
            if uploaded:
                archive.unlink(missing_ok=True)
            raise HTTPException(409, "another job is running")
        backup.write_progress(db_path, "restore", state="running", phase="start",
                              started_at=backup.now_iso())  # fmt: skip
        return JSONResponse({"started": True, "manifest": backup.summary(manifest)}, 202)

    async def import_scan(request: Request):
        with closing(conn()) as c:
            source = db.get_setting(c, "data_source") or "folder"
            if source == "folder" and not db.get_setting(c, "root"):
                raise HTTPException(409, "root folder is not configured")
        if not job.start(trigger="manual"):
            reason = "already running" if job.running_kind() == "scan" else "another job is running"
            return JSONResponse({"started": False, "reason": reason}, status_code=409)
        return JSONResponse({"started": True}, status_code=202)

    async def import_files(request: Request):
        q = request.query_params
        where, params = [], []
        if q.get("status"):
            where.append("f.status = ?")
            params.append(q["status"])
        if q.get("person"):
            where.append("f.person_id = ?")
            params.append(q["person"])
        for key, expr in FILE_TEXT_FILTERS.items():
            if q.get(key):
                where.append(f"{expr} LIKE ?")
                params.append(f"%{q[key]}%")
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        limit = _int(request, "limit", 100, 1, 1000)
        offset = _int(request, "offset", 0, 0, 10**9)
        order = _order(q, FILE_SORTS, "processed", "f.id")
        with closing(conn()) as c:
            total = c.execute(
                f"""SELECT COUNT(*) FROM files f
                    LEFT JOIN activities a ON a.id = f.activity_id {clause}""",
                params,
            ).fetchone()[0]
            rows = c.execute(
                f"""SELECT f.id, f.person_id, f.rel_path, f.zip_member, f.size, f.status,
                           f.prev_status, f.skip_reason, f.error, f.activity_id, f.first_seen,
                           f.missing_since, f.dismissed, f.imported_at,
                           f.fit_uid, f.fit_type, f.fit_created, f.device_serial,
                           a.start_time_utc, a.utc_offset_s, a.activity_type, a.name
                    FROM files f LEFT JOIN activities a ON a.id = f.activity_id
                    {clause} ORDER BY {order} LIMIT ? OFFSET ?""",
                [*params, limit, offset],
            ).fetchall()
        return JSONResponse({"total": total, "items": [dict(r) for r in rows]})

    async def import_file_forget(request: Request):
        with closing(conn()) as c:
            if not importer.forget_file(c, request.path_params["id"]):
                raise HTTPException(404, "file not found")
        return Response(status_code=204)

    async def import_file_dismiss(request: Request):
        with closing(conn()) as c:
            importer.dismiss_missing(c, request.path_params["id"])
        return Response(status_code=204)

    async def import_file_retry(request: Request):
        with closing(conn()) as c:
            cur = c.execute(
                "UPDATE files SET status = 'new', error = NULL WHERE id = ? AND status = 'error'",
                (request.path_params["id"],),
            )
            if cur.rowcount == 0:
                raise HTTPException(409, "file is not in error state")
        job.start(trigger="retry")
        return Response(status_code=202)

    async def http_error(request: Request, exc: HTTPException):
        return JSONResponse({"error": exc.detail}, status_code=exc.status_code)

    routes = [
        Route("/api/info", info),
        Route("/api/types", types),
        Route("/api/types/counts", type_counts),
        Route("/api/persons", persons),
        Route("/api/persons", person_create, methods=["POST"]),
        Route("/api/persons/order", persons_order, methods=["PUT"]),
        Route("/api/compare", compare),
        Route("/api/devices", devices),
        Route("/api/devices/{serial:int}", device_update, methods=["PATCH"]),
        Route("/api/settings", settings_get),
        Route("/api/settings", settings_update, methods=["PUT"]),
        Route("/api/uploads", upload, methods=["POST"]),
        Route("/api/persons/{id}", person_update, methods=["PATCH"]),
        Route("/api/activities", activities),
        Route("/api/activities/{id:int}", activity),
        Route("/api/activities/{id:int}", activity_update, methods=["PATCH"]),
        Route("/api/activities/{id:int}", activity_delete, methods=["DELETE"]),
        Route("/api/activities/{id:int}/streams", activity_streams),
        Route("/api/activities/{id:int}/track", activity_track),
        Route("/api/heatmap/tracks", heatmap_tracks),
        Route("/api/heatmap/tiles", heatmap_tiles),
        Route("/api/basemaps", basemaps),
        Route("/api/basemap/{source}/{z:int}/{x:int}/{y:int}.png", basemap_tile),
        Route("/api/segments", segments_list),
        Route("/api/segments", segment_create, methods=["POST"]),
        Route("/api/segments/snap", segment_snap, methods=["POST"]),
        Route("/api/segments/{id:int}", segment_detail),
        Route("/api/segments/{id:int}", segment_update, methods=["PATCH"]),
        Route("/api/segments/{id:int}", segment_delete, methods=["DELETE"]),
        Route("/api/segments/{id:int}/efforts", segment_efforts),
        Route("/api/thresholds/{id}", thresholds_get),
        Route("/api/thresholds/{id}", thresholds_put, methods=["PUT"]),
        Route("/api/thresholds/{id}/{valid_from}", thresholds_delete, methods=["DELETE"]),
        Route("/api/fitness", fitness),
        Route("/api/calendar", calendar),
        Route("/api/stats/totals", stats_totals),
        Route("/api/stats/records", stats_records),
        Route("/api/garmin", garmin_accounts),
        Route("/api/garmin/{id}", garmin_account_set, methods=["PUT"]),
        Route("/api/garmin/{id}", garmin_account_delete, methods=["DELETE"]),
        Route("/api/garmin/{id}/test", garmin_account_test, methods=["POST"]),
        Route("/api/backup", backup_status),
        Route("/api/export", export_start, methods=["POST"]),
        Route("/api/export/{name}", export_download),
        Route("/api/export/{name}", export_delete, methods=["DELETE"]),
        Route("/api/restore", restore_start, methods=["POST"]),
        Route("/api/import/status", import_status),
        Route("/api/import/scan", import_scan, methods=["POST"]),
        Route("/api/import/files", import_files),
        Route("/api/import/files/{id:int}", import_file_forget, methods=["DELETE"]),
        Route("/api/import/files/{id:int}/dismiss", import_file_dismiss, methods=["POST"]),
        Route("/api/import/files/{id:int}/retry", import_file_retry, methods=["POST"]),
        Mount("/", _RevalidatedStatic(directory=STATIC_DIR, html=True), name="static"),
    ]

    @asynccontextmanager
    async def lifespan(app):
        sched.start()
        yield
        await sched.stop()

    app = Starlette(
        routes=routes,
        exception_handlers={HTTPException: http_error},
        lifespan=lifespan,
        middleware=[Middleware(GZipMiddleware, minimum_size=1024)],
    )
    app.state.import_job = job
    app.state.scheduler = sched
    return app
