"""HTTP API and static preview UI (Starlette).

Starlette instead of FastAPI keeps the resident memory small; the API is plain JSON.
All URLs used by the frontend are relative, so the app works behind HA Ingress.
"""

from __future__ import annotations

import os
import re
import sqlite3
from contextlib import asynccontextmanager, closing
from pathlib import Path

from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException
from starlette.middleware import Middleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import (
    __version__,
    basemap,
    db,
    explorer,
    fitfile,
    importer,
    jobs,
    scheduler,
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
            due = scheduler.next_scan_at(c)
            interval = scheduler.interval_min(c)
        running = job.running()
        if not running and progress.get("state") == "running":
            # Started outside this server (CLI) or the process died; report what we know.
            progress["state"] = "running?"
        return JSONResponse(
            {
                "root": root,
                "running": running,
                "progress": progress,
                "files": counts,
                "missing_to_review": undismissed_missing,
                "last_run": dict(last) if last else None,
                "scan_interval_min": interval,
                "next_scan_at": due.strftime("%Y-%m-%dT%H:%M:%SZ") if due else None,
            }
        )

    async def import_scan(request: Request):
        with closing(conn()) as c:
            if not db.get_setting(c, "root"):
                raise HTTPException(409, "root folder is not configured")
        if not job.start(trigger="manual"):
            return JSONResponse({"started": False, "reason": "already running"}, status_code=409)
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
        Route("/api/persons", persons),
        Route("/api/persons", person_create, methods=["POST"]),
        Route("/api/persons/order", persons_order, methods=["PUT"]),
        Route("/api/compare", compare),
        Route("/api/devices", devices),
        Route("/api/devices/{serial:int}", device_update, methods=["PATCH"]),
        Route("/api/settings", settings_get),
        Route("/api/settings", settings_update, methods=["PUT"]),
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
