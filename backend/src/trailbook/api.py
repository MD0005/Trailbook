"""HTTP API and static preview UI (Starlette).

Starlette instead of FastAPI keeps the resident memory small; the API is plain JSON.
All URLs used by the frontend are relative, so the app works behind HA Ingress.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import sqlite3
import unicodedata
import zipfile
from calendar import monthrange
from contextlib import asynccontextmanager, closing
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from starlette.applications import Starlette
from starlette.background import BackgroundTask
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
    applog,
    auth,
    backup,
    basemap,
    countries,
    db,
    explorer,
    export,
    fitfile,
    fixes,
    garmin,
    hacards,
    homeassistant,
    icu,
    icufiles,
    importer,
    jobs,
    planner,
    records,
    scheduler,
    segments,
    sports,
    streams,
    suggest,
    surface,
    tilechart,
    together,
    update,
    weather,
    wellbeing,
    workout,
)

STATIC_DIR = Path(__file__).parent / "static"
log = logging.getLogger("trailbook.server")


class _RevalidatedStatic(StaticFiles):
    """Static files that the browser re-checks on every load (ETag), so an updated
    add-on never shows a stale UI."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


# index.html with every local script and stylesheet as `name?v=<hash of its content>`: a new
# version of a file is a new address, so no cache on the way (the browser, Home Assistant's
# Ingress, the companion app, a proxy) can keep showing an old UI after an update.
_ASSET_RE = re.compile(r'(<(?:script|link)[^>]*?\s(?:src|href)=")([^":?#]+\.(?:js|css))(")')


def _versioned_index() -> str:
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")

    def stamp(m: re.Match) -> str:
        try:
            digest = hashlib.sha1((STATIC_DIR / m[2]).read_bytes()).hexdigest()[:10]
        except OSError:
            return m[0]
        return f"{m[1]}{m[2]}?v={digest}{m[3]}"

    return _ASSET_RE.sub(stamp, html)


ACTIVITY_LIST_FIELDS = (
    "id person_id start_time_utc utc_offset_s category activity_type indoor name "
    "elapsed_s time_s distance_m ascent_m avg_hr max_hr avg_speed avg_power calories "
    "has_gps workout workout_override"
).split()

# Column key -> SQL expression, for ?sort=<key>&dir=asc|desc
ACTIVITY_SORTS = {
    "date": "start_time_utc",
    "type": "activity_type",
    "workout": "COALESCE(workout_override, workout)",
    "name": "name",
    "distance": "distance_m",
    "time": "time_s",
    "pace": "avg_speed",
    "hr": "avg_hr",
    "ascent": "ascent_m",
    "person": "person_id",
}

# ?sort= of the shared activities of two people, on (row A, row B, result): the type, training
# type and name are the first person's, distance, time and share the part done together
SHARED_SORTS = {
    "date": lambda i: i[2].meet_t,
    "type": lambda i: i[0]["activity_type"],
    "workout": lambda i: i[0]["workout_override"] or i[0]["workout"],
    "name": lambda i: (i[0]["name"] or i[1]["name"] or i[0]["activity_type"]).lower(),
    "distance": lambda i: i[2].together_m,
    "time": lambda i: i[2].together_s,
    "share": lambda i: i[2].share,
}


def _sort_shared(items: list, q) -> list:
    """Sorted by `sort` / `dir` (date, newest first, by default); without a value last."""
    value = SHARED_SORTS.get(q.get("sort"), SHARED_SORTS["date"])
    known = [i for i in items if value(i) is not None]
    known.sort(key=lambda i: (value(i), i[2].meet_t, i[0]["id"]), reverse=q.get("dir") != "asc")
    return known + [i for i in items if value(i) is None]


# Settings › Imported lists the files and, as one row per day, Garmin Connect's daily summaries
# (garmin_days). Both come from this union (`x`), so sorting, filters and paging cover both.
IMPORT_ITEMS_SQL = """
    SELECT 'file' AS kind, f.id, f.person_id, COALESCE(f.source_rel, f.rel_path) AS rel_path,
           f.rel_path LIKE '@uploads/%' AS archived, f.zip_member, f.size, f.status,
           f.prev_status, f.skip_reason, f.error, f.activity_id, f.first_seen, f.missing_since,
           f.dismissed, f.imported_at, f.fit_uid, f.fit_type, f.fit_created, f.device_serial,
           a.start_time_utc, a.utc_offset_s, a.activity_type, a.name,
           NULL AS day, NULL AS summary,
           COALESCE(f.source_rel, f.rel_path) || '/' || COALESCE(f.zip_member, '') AS file_key,
           COALESCE(a.name, f.skip_reason, f.fit_type, f.error) AS content_key,
           COALESCE(a.name, '') || ' ' || COALESCE(a.activity_type, '') || ' ' ||
               COALESCE(f.skip_reason, '') || ' ' || COALESCE(f.fit_type, '') || ' ' ||
               COALESCE(f.error, '') AS content_text,
           COALESCE(a.start_time_utc, f.fit_created) AS recorded_key
    FROM files f LEFT JOIN activities a ON a.id = f.activity_id
    UNION ALL
    SELECT 'day', NULL, g.person_id, 'Garmin Connect', 0, NULL, NULL, 'imported',
           NULL, NULL, NULL, NULL, g.fetched_at, NULL,
           0, g.fetched_at, NULL, NULL, NULL, NULL,
           NULL, NULL, NULL, NULL,
           g.day, g.summary,
           'Garmin Connect daily summary ' || g.day,
           'daily summary',
           'daily summary wellness steps floors heart rate stress body battery respiration '
               || 'pulse ox spo2 calories intensity',
           g.day
    FROM garmin_days g
"""
# Columns of IMPORT_ITEMS_SQL only used to sort and filter (not sent).
INTERNAL_ITEM_KEYS = {"summary", "file_key", "content_key", "content_text", "recorded_key"}

FILE_SORTS = {
    "status": "x.status",
    "file": "x.file_key",
    "person": "x.person_id",
    "content": "x.content_key",
    "recorded": "x.recorded_key",
    "fit": "x.fit_uid",
    "processed": "x.imported_at",
}

# Column key -> SQL expression matched with LIKE '%value%'
FILE_TEXT_FILTERS = {
    "file": "x.file_key",
    "content": "x.content_text",
    "fit": "x.fit_uid",
    "recorded": "x.recorded_key",
    "processed": "x.imported_at",
}

# Best efforts ranked per (kind, key): rk = 1 is the record (lowest time for pace/ride, highest
# value otherwise; the earliest wins a tie), with when it was set. {where} filters oa (activities).
# Best efforts plus the longest distance per run and ride (records.EFFORTS_SQL).
EFFORTS_SQL = records.EFFORTS_SQL

_RECORDS_SQL = f"""SELECT o.kind, o.key, o.v, o.value, oa.start_time_utc, oa.utc_offset_s,
           oa.id AS activity_id,
           ROW_NUMBER() OVER (PARTITION BY o.kind, o.key, o.v
               ORDER BY CASE WHEN o.kind IN ('pace', 'ride') THEN o.value ELSE -o.value END,
                        oa.start_time_utc) AS rk
    FROM {EFFORTS_SQL} o JOIN activities oa ON oa.id = o.activity_id WHERE {{where}}"""


def _prev_bests(c: sqlite3.Connection, a, where: list[str], params: list) -> dict:
    """The best of each (kind, key) set before activity `a` under the same filters: what a new
    record of `a` beat (how much and how long it stood)."""
    rows = c.execute(
        f"""WITH r AS ({_RECORDS_SQL.format(where=" AND ".join([*where, "oa.start_time_utc < ?"]))})
            SELECT kind, key, v, value, start_time_utc, utc_offset_s FROM r WHERE rk = 1""",
        [*params, a["start_time_utc"]],
    ).fetchall()
    return {(r["kind"], r["key"], r["v"]): r for r in rows}


HA_RECORDS_RETRY_S = 300  # how often record events Home Assistant missed are sent again


# Time filter `last`: a period ending today, kept relative (a saved link stays "the last 3
# months"): months back from today, or "ytd" from 1 January.
LAST_MONTHS = {"1m": 1, "3m": 3, "6m": 6, "1y": 12, "2y": 24}


def last_since(key: str | None, today: date | None = None) -> str | None:
    """First local day of the `last` period (inclusive), None for no or an unknown key."""
    today = today or date.today()
    if key == "ytd":
        return f"{today.year}-01-01"
    n = LAST_MONTHS.get(key or "")
    if not n:
        return None
    y, m = divmod(today.year * 12 + today.month - 1 - n, 12)
    m += 1
    return date(y, m, min(today.day, monthrange(y, m)[1])).isoformat()


def years_of(q) -> list[str]:
    """Time filter `years`: comma list of years (any, not only side by side)."""
    raw = [v for v in (q.get("years") or "").split(",") if v]
    if any(not re.fullmatch(r"\d{4}", v) for v in raw):
        raise HTTPException(400, "years must be a comma list of years (YYYY)")
    return raw


def activity_filters(q, alias: str = "a", person: bool = True) -> tuple[list[str], list]:
    """The filters every tab shares (SPEC §10, Filters), as SQL conditions on `activities`:
    person (comma list), time - from / to (local days, inclusive), last (1m, 3m, 6m, ytd, 1y
    up to today) and years (comma list, any years) - and types (comma list of type keys;
    `g:<group>` selects a whole group). `type` and `year` are older single-value forms."""
    p = f"{alias}." if alias else ""
    where: list[str] = []
    params: list = []
    if person and q.get("person") and q["person"] != "all":
        values = q["person"].split(",")
        where.append(f"{p}person_id IN ({','.join('?' for _ in values)})")
        params += values
    day = f"date({p}start_time_utc, printf('%+d seconds', COALESCE({p}utc_offset_s, 0)))"
    for key, op in (("from", ">="), ("to", "<=")):
        value = q.get(key)
        if value:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                raise HTTPException(400, f"{key} must be a date (YYYY-MM-DD)")
            where.append(f"{day} {op} ?")
            params.append(value)
    if q.get("year"):
        where.append(f"substr({day}, 1, 4) = ?")
        params.append(q["year"])
    since = last_since(q.get("last"))
    if since:
        where.append(f"{day} >= ?")
        params.append(since)
    years = years_of(q)
    if years:
        where.append(f"substr({day}, 1, 4) IN ({','.join('?' for _ in years)})")
        params += years
    raw = q.get("types") or q.get("type") or ""
    values = [v for v in raw.split(",") if v]
    if values:
        keys = [v for v in values if not v.startswith("g:")]
        groups = [v[2:] for v in values if v.startswith("g:")]
        parts = []
        if keys:
            parts.append(f"{p}activity_type IN ({','.join('?' for _ in keys)})")
        if groups:
            parts.append(f"{p}category IN ({','.join('?' for _ in groups)})")
        where.append("(" + " OR ".join(parts) + ")")
        params += keys + groups
    return where, params


_WORKOUT = "COALESCE(workout_override, workout)"  # training type in force


def _workout_filter(q) -> tuple[list[str], list]:
    """Activities page filter `workouts`: comma list of training type keys, "none" = not set."""
    chosen = [v for v in (q.get("workouts") or "").split(",") if v]
    if not chosen:
        return [], []
    keys = [v for v in chosen if v != "none"]
    parts = [f"{_WORKOUT} IN ({','.join('?' for _ in keys)})"] if keys else []
    if "none" in chosen:
        parts.append(f"{_WORKOUT} IS NULL")
    return ["(" + " OR ".join(parts) + ")"], keys


# New tiles: earlier routes are looked at when they reach this close to the activity's box
# (degrees; a square, zoom 13, is up to ~0.044° wide).
BOX_MARGIN = 0.05


def _map_filters(q) -> tuple[str, list]:
    """Shared filters plus 'has a route', for the map endpoints."""
    where, params = activity_filters(q)
    return " AND ".join(["a.has_gps = 1", *where]), params


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
    *fitfile.EXTRA_CHANNELS,
    *garmin.DETAIL_CHANNELS.values(),  # from Garmin Connect (connect_streams)
)


def create_app(db_path: str | Path) -> Starlette:
    db_path = str(db_path)
    db.connect(db_path).close()  # apply migrations once
    job = jobs.ImportJob(db_path)
    sched = scheduler.Scheduler(db_path, job)
    tiles = basemap.TileCache(Path(db_path).parent / "tilecache")
    uploads_dir = Path(db_path).resolve().parent / "uploads"
    # Big files come in parts (a proxy such as Home Assistant's Ingress refuses big requests):
    # each part is appended here, the last request (POST /api/uploads with `part`) takes the file.
    parts_dir = Path(db_path).resolve().parent / "upload-parts"
    PART_ID = re.compile(r"[0-9a-f]{16,64}")
    PART_MAX_AGE_S = 24 * 3600  # unfinished uploads are dropped after a day
    icu_files_dir = Path(db_path).resolve().parent / "icu-files"
    # Own device photos: <data>/device-images/<product>.png|jpg|webp (e.g. edge_850.png).
    device_images = Path(db_path).resolve().parent / "device-images"

    def _device_image(product: str | None) -> str | None:
        if not product or not re.fullmatch(r"[\w.-]+", product):
            return None
        for ext in ("png", "jpg", "webp"):
            if (device_images / f"{product}.{ext}").is_file():
                return f"/api/device-image/{product}.{ext}"
        return None

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
                    "desktop": update.enabled(),
                }
            )

    # ---- updates of the Windows app ----------------------------------------------------

    async def update_get(request: Request):
        force = request.query_params.get("check") == "1"
        return JSONResponse(await run_in_threadpool(update.status, force))

    async def update_install(request: Request):
        if not update.enabled():
            raise HTTPException(404, "updates come from Home Assistant or Docker")
        if job.running():
            raise HTTPException(409, "An import is running; update when it has finished.")
        data_dir = Path(db_path).resolve().parent
        try:
            installer = await run_in_threadpool(update.download, data_dir)
        except update.UpdateError as exc:
            raise HTTPException(502, str(exc)) from exc
        update.run_installer(installer)
        return Response(status_code=202)

    async def type_counts(request: Request):
        """Activities per type for one person, two (comma list) or everyone: filters list
        only used types."""
        where, params = activity_filters({"person": request.query_params.get("person")}, "")
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        sql = f"SELECT activity_type, COUNT(*) FROM activities {clause} GROUP BY activity_type"
        with closing(conn()) as c:
            counts = dict(c.execute(sql, params).fetchall())
        return JSONResponse(counts)

    async def time_range(request: Request):
        """First and last local day with an activity (and the years between) for the Time
        filter of one person or everyone."""
        where, params = activity_filters({"person": request.query_params.get("person")}, "")
        day = analysis.LOCAL_DAY_SQL
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        with closing(conn()) as c:
            row = c.execute(
                f"SELECT MIN({day}) AS first, MAX({day}) AS last FROM activities {clause}", params
            ).fetchone()
            years = [
                r[0]
                for r in c.execute(
                    f"""SELECT DISTINCT substr({day}, 1, 4) AS y FROM activities {clause}
                        ORDER BY y DESC""",
                    params,
                )
            ]
        return JSONResponse({"first": row["first"], "last": row["last"], "years": years})

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
                "workouts": [
                    {"key": k, "en": en, "pl": pl} for k, (en, pl) in workout.KINDS.items()
                ],
                # sport families and their parameters (the manual is written from these)
                "workout_families": [
                    {
                        "key": p.key,
                        "en": p.en,
                        "types": list(p.types),
                        "kinds": list(p.kinds),
                        "auto": p.auto,
                        "lthr_share": p.lthr_share,
                        "long_min": p.long_min,
                        "hills": list(p.hills) if p.hills else None,
                        "commute": p.commute,
                    }
                    for p in workout.PROFILES.values()
                ],
                "workout_rules": workout.RULES,
                "workout_channels": workout.CHANNEL_RULES,
                # training load and fitness model (Manual › Fitness is written from these)
                "fitness_rules": {
                    "ctl_days": analysis.CTL_DAYS,
                    "atl_days": analysis.ATL_DAYS,
                    "lthr_share_of_max": analysis.LTHR_SHARE_OF_MAX,
                    "default_hr_rest": analysis.DEFAULT_HR_REST,
                    "hr_max_range": [100, 230],
                    "stale_days": analysis.STALE_DAYS,
                    "ftp_groups": list(analysis.FTP_GROUPS),
                },
                # the small charts of Activities › Charts (Manual › Activity charts)
                "tile_chart_rules": tilechart.RULES,
                # Calendar › Next workout (Manual › Next workout)
                "next_rules": {
                    "models": {k: list(v[1]) for k, v in suggest.MODELS.items()},
                    "window_days": suggest.WINDOW_DAYS,
                    "plan_days": suggest.PLAN_DAYS,
                    "sport_days": suggest.SPORT_DAYS,
                    "hard_min_s": suggest.HARD_MIN_S,
                    "rest_form": suggest.REST_FORM,
                    "tired_form": suggest.TIRED_FORM,
                    "fresh_form": suggest.FRESH_FORM,
                    "long_s": suggest.LONG_S,
                    "plan_off": suggest.PLAN_OFF,
                    "gap_min": suggest.GAP_MIN,
                    "long_factor": suggest.LONG_FACTOR,
                    "lt1_share": suggest.LT1_SHARE,
                    "endurance": sorted(suggest.ENDURANCE),
                },
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
            "desktop": update.enabled(),
            # road surface: "open" (when an activity is opened) or "background" (all, slowly)
            "surface_mode": db.get_setting(c, "surface_mode") or "background",
            "surface_progress": surface.progress(c),
        }

    async def settings_get(request: Request):
        with closing(conn()) as c:
            return JSONResponse(_settings(c))

    # ---- UI settings per person (JSON values the browser keeps for a person) ----------

    async def ui_settings_get(request: Request):
        person = request.query_params.get("person") or "all"
        with closing(conn()) as c:
            rows = c.execute(
                "SELECT key, value FROM ui_settings WHERE person_id = ?", (person,)
            ).fetchall()
        return JSONResponse({r["key"]: json.loads(r["value"]) for r in rows})

    async def ui_settings_put(request: Request):
        person = request.query_params.get("person") or "all"
        key = request.path_params["key"]
        if not key.replace("-", "").replace("_", "").isalnum() or len(key) > 40:
            raise HTTPException(400, "invalid key")
        raw = await request.body()
        if len(raw) > 20_000:
            raise HTTPException(400, "value too large")
        try:
            value = json.loads(raw)
        except ValueError as exc:
            raise HTTPException(400, "value must be JSON") from exc
        with closing(conn()) as c:
            c.execute(
                """INSERT OR REPLACE INTO ui_settings (person_id, key, value, updated_at)
                   VALUES (?, ?, ?, ?)""",
                (person, key, json.dumps(value), importer.now_iso()),
            )
        return Response(status_code=204)

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
            if "surface_mode" in body:
                if body["surface_mode"] not in ("open", "background"):
                    raise HTTPException(400, "surface_mode must be open or background")
                db.set_setting(c, "surface_mode", body["surface_mode"])
                surface_wake.set()
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
        where, params = activity_filters(q, person=False)
        clause = f"AND {' AND '.join(where)}" if where else ""
        with closing(conn()) as c:
            people = c.execute(
                f"""SELECT p.id, p.label, p.color, p.icon, p.sort_order,
                           COUNT(a.id) activities, SUM(a.distance_m) distance_m,
                           SUM(a.time_s) time_s, SUM(a.ascent_m) ascent_m,
                           SUM(a.calories) calories, MAX(a.start_time_utc) last_activity
                    FROM persons p LEFT JOIN activities a ON a.person_id = p.id {clause}
                    WHERE p.id != '_unassigned'
                    GROUP BY p.id ORDER BY p.sort_order, p.label""",
                params,
            ).fetchall()
            groups = c.execute(
                f"""SELECT a.person_id, a.category, COUNT(*) activities,
                           SUM(a.distance_m) distance_m, SUM(a.time_s) time_s
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
            item["groups"] = sorted(by_person.get(p["id"], []), key=lambda g: -(g["time_s"] or 0))
            items.append(item)
        return JSONResponse({"years": years, "people": items})

    async def person_update(request: Request):
        pid = request.path_params["id"]
        body = await request.json()
        fields = {k: body[k] for k in ("label", "color", "icon", "sex") if k in body}
        if "label" in fields and not str(fields["label"]).strip():
            raise HTTPException(400, "label must not be empty")
        if fields.get("sex") not in (None, "male", "female"):
            raise HTTPException(400, "sex must be male, female or null")
        with closing(conn()) as c:
            if c.execute("SELECT 1 FROM persons WHERE id = ?", (pid,)).fetchone() is None:
                raise HTTPException(404, "person not found")
            for key, value in fields.items():
                c.execute(f"UPDATE persons SET {key} = ? WHERE id = ?", (value, pid))
            return JSONResponse(
                dict(c.execute("SELECT * FROM persons WHERE id = ?", (pid,)).fetchone())
            )

    # ---- together: activities two people did together (together.py) ------------------

    def _match_options(request: Request) -> tuple[int, int]:
        """The Together options: least share of the shorter route (%) and the radius (m)."""
        share = _int(
            request, "share", together.DEFAULT_SHARE, together.MIN_SHARE, together.MAX_SHARE
        )
        radius = _int(
            request,
            "radius",
            together.DEFAULT_RADIUS_M,
            together.MIN_RADIUS_M,
            together.MAX_RADIUS_M,
        )
        return share, radius

    def _together_list(c: sqlite3.Connection, q, people: list[str], share: int, radius: int):
        """Shared activities of two people, newest first, as (row A, row B, result). Returns
        every one reaching `share`, those of them passing the time and type filters, and of
        these the ones passing the training type filter too. One of the two activities
        passing is enough."""
        found = [
            f for f in together.find(c, people[0], people[1], radius) if f[2].share * 100 >= share
        ]
        ids = sorted({i for a, b, _ in found for i in (a, b)})
        among = f"id IN ({','.join('?' for _ in ids)})"
        fields = ", ".join(ACTIVITY_LIST_FIELDS)
        rows = {
            r["id"]: dict(r)
            for r in c.execute(f"SELECT {fields} FROM activities WHERE {among}", ids)
        }
        items = [(rows[a], rows[b], r) for a, b, r in found]
        items.sort(key=lambda i: (i[2].meet_t, i[0]["id"]), reverse=True)

        def passing(where: list[str], params: list) -> list:
            sql = f"SELECT id FROM activities WHERE {' AND '.join([among, *where])}"
            ok = {r["id"] for r in c.execute(sql, [*ids, *params])}
            return [i for i in items if i[0]["id"] in ok or i[1]["id"] in ok]

        where, params = activity_filters(q, "", person=False)
        w_where, w_params = _workout_filter(q)
        base = passing(where, params)
        chosen = passing([*where, *w_where], [*params, *w_params]) if w_where else base
        return items, base, chosen

    def _together_totals(chosen: list) -> dict:
        def local_day(a: dict) -> str:
            t = together.epoch(a["start_time_utc"]) + (a["utc_offset_s"] or 0)
            return datetime.fromtimestamp(t, UTC).strftime("%Y-%m-%d")

        longest = max(chosen, key=lambda i: i[2].together_m, default=None)
        people = []
        for side in (0, 1):
            # an activity shared twice (the other watch was restarted) counts once
            acts = list({i[side]["id"]: i[side] for i in chosen}.values())
            with_hr = [a for a in acts if a["avg_hr"] and a["time_s"]]
            hr_time = sum(a["time_s"] for a in with_hr)
            total = {
                k: sum(a[k] or 0 for a in acts)
                for k in ("distance_m", "time_s", "ascent_m", "calories")
            }
            avg_hr = sum(a["avg_hr"] * a["time_s"] for a in with_hr) / hr_time if hr_time else None
            people.append({**total, "avg_hr": round(avg_hr) if avg_hr else None})
        days = sorted(local_day(i[0]) for i in chosen)
        return {
            "count": len(chosen),
            "active_days": len(set(days)),
            "first": days[0] if days else None,
            "last": days[-1] if days else None,
            "together_m": sum(i[2].together_m for i in chosen),
            "together_s": sum(i[2].together_s for i in chosen),
            "share": sum(i[2].share for i in chosen) / len(chosen) if chosen else None,
            "longest_m": longest[2].together_m if longest else None,
            "longest_day": local_day(longest[0]) if longest else None,
            "people": people,
        }

    def _shared_values(r: together.Shared) -> dict:
        return {
            "share": round(r.share, 4),
            "together_m": round(r.together_m),
            "together_s": round(r.together_s),
            "meet_time_utc": datetime.fromtimestamp(r.meet_t, UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }

    async def together_activities(request: Request):
        """The activities two people (`person=a,b`) did together, with their totals; sorted
        like the activities list (SHARED_SORTS)."""
        q = request.query_params
        people = [p for p in (q.get("person") or "").split(",") if p]
        if len(people) != 2 or people[0] == people[1]:
            raise HTTPException(400, "person must name two different people")
        share, radius = _match_options(request)
        limit = _int(request, "limit", 50, 1, 1000)
        offset = _int(request, "offset", 0, 0, 10**9)

        def work():
            with closing(conn()) as c:
                every, base, chosen = _together_list(c, q, people, share, radius)
            type_counts: dict[str, int] = {}
            for a, b, _ in every:
                for key in {a["activity_type"], b["activity_type"]}:
                    type_counts[key] = type_counts.get(key, 0) + 1
            workout_counts: dict[str, int] = {}
            for a, b, _ in base:
                for key in {x["workout_override"] or x["workout"] or "none" for x in (a, b)}:
                    workout_counts[key] = workout_counts.get(key, 0) + 1
            items = []
            for a, b, r in _sort_shared(chosen, q)[offset : offset + limit]:
                item = {"a": a, "b": b, **_shared_values(r)}
                if q.get("track") == "1":
                    item["lines"] = [r.line_a, r.line_b]
                items.append(item)
            return {
                "total": len(chosen),
                "totals": _together_totals(chosen),
                "items": items,
                "type_counts": type_counts,
                "workout_counts": workout_counts,
            }

        return JSONResponse(await run_in_threadpool(work))

    async def together_pair(request: Request):
        """One shared activity: when and where the two were together, on one clock (seconds
        from the first moment together), and the shared activities before and after it."""
        ids = (request.path_params["a"], request.path_params["b"])
        share, radius = _match_options(request)

        def work():
            with closing(conn()) as c:
                people = [_activity_or_404(c, i)["person_id"] for i in ids]
                r = together.pair(c, ids[0], ids[1], radius)
                if r is None:
                    raise HTTPException(404, "these activities were not done together")
                chosen = _together_list(c, request.query_params, people, share, radius)[2]
            # newest first: the neighbours in time among the filtered ones
            key = (r.meet_t, ids[0])
            newer = [i for i in chosen if (i[2].meet_t, i[0]["id"]) > key]
            older = [i for i in chosen if (i[2].meet_t, i[0]["id"]) < key]

            def ref(i) -> dict:
                return {"a": i[0]["id"], "b": i[1]["id"]}

            def clock(runs) -> list:
                return [[round(t0 - r.meet_t, 1), round(t1 - r.meet_t, 1)] for t0, t1 in runs]

            return {
                **_shared_values(r),
                "people": people,
                "offsets": [round(r.offset_a - r.meet_t, 1), round(r.offset_b - r.meet_t, 1)],
                "span": [round(r.first_t - r.meet_t, 1), round(r.last_t - r.meet_t, 1)],
                "runs": [clock(r.runs_a), clock(r.runs_b)],
                "lines": [r.line_a, r.line_b],
                "next": ref(newer[-1]) if newer else None,
                "prev": ref(older[0]) if older else None,
            }

        return JSONResponse(await run_in_threadpool(work))

    # ---- activities ------------------------------------------------------------------

    async def activities(request: Request):
        q = request.query_params
        where, params = activity_filters(q, "")
        if q.get("group"):
            values = q["group"].split(",")
            where.append(f"category IN ({','.join('?' for _ in values)})")
            params += values
        if q.get("date"):
            where.append("start_time_utc LIKE ?")
            params.append(f"{q['date']}%")
        if q.get("gps") == "1":
            where.append("has_gps = 1")
        if q.get("q"):
            where.append("name LIKE ?")
            params.append(f"%{q['q']}%")
        # Training type counts under the other filters (the Training type badge lists them).
        base = f"WHERE {' AND '.join(where)}" if where else ""
        base_params = list(params)
        wk = _WORKOUT
        w_where, w_params = _workout_filter(q)
        where += w_where
        params = [*params, *w_params]
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        limit = _int(request, "limit", 50, 1, 1000)
        offset = _int(request, "offset", 0, 0, 10**9)
        order = _order(q, ACTIVITY_SORTS, "date", "id")
        with closing(conn()) as c:
            totals = c.execute(
                f"""SELECT COUNT(*) count, SUM(distance_m) distance_m, SUM(time_s) time_s,
                           SUM(ascent_m) ascent_m, SUM(calories) calories,
                           COUNT(DISTINCT substr(start_time_utc, 1, 10)) active_days,
                           MAX(distance_m) longest_m, MAX(time_s) longest_s,
                           MIN(start_time_utc) first, MAX(start_time_utc) last
                    FROM activities {clause}""",
                params,
            ).fetchone()
            fields = ", ".join(ACTIVITY_LIST_FIELDS)
            # segments ridden in the activity (a badge on the tile)
            fields += (
                ", (SELECT COUNT(*) FROM segment_efforts s"
                " WHERE s.activity_id = activities.id) segment_count"
                ", (SELECT g.name FROM segment_efforts s JOIN segments g ON g.id = s.segment_id"
                " WHERE s.activity_id = activities.id ORDER BY s.start_s LIMIT 1) segment_name"
            )
            with_track = q.get("track") == "1"
            if with_track:
                fields += ", (SELECT polyline FROM tracks t WHERE t.activity_id = id) polyline"
            rows = c.execute(
                f"""SELECT {fields} FROM activities {clause}
                    ORDER BY {order} LIMIT ? OFFSET ?""",
                [*params, limit, offset],
            ).fetchall()
            items = [dict(r) for r in rows]
            if q.get("chart") in ("pace", "chart"):  # small chart per tile (tilechart.py)
                for item in items:
                    item["tile_chart"] = tilechart.tile_chart(c, item["id"])
            workout_counts = {
                (r[0] or "none"): r[1]
                for r in c.execute(
                    f"SELECT {wk}, COUNT(*) FROM activities {base} GROUP BY 1", base_params
                )
            }
            return JSONResponse(
                {
                    "total": totals["count"],
                    "totals": dict(totals),
                    "items": items,
                    "workout_counts": workout_counts,
                }
            )

    async def activity(request: Request):
        aid = request.path_params["id"]
        with closing(conn()) as c:
            row = _activity_or_404(c, aid)
            a = dict(row)
            th = analysis.activity_thresholds(c, row)  # FTP used (the Edit panel shows it)
            a["ftp_used"] = th.ftp
            a["ftp_source"] = (th.sources or {}).get("ftp")
            # the tempo line of the training type detection (90 % of the sport's threshold HR):
            # Easy's "Above tempo" on the heart rate chart uses it
            prof = workout.profile(row["activity_type"])
            lt = (th.lthr or (th.hr_max or 190) * analysis.LTHR_SHARE_OF_MAX) * (
                prof.lthr_share if prof else 1.0
            )
            a["tempo_hr"] = round(lt * workout.RULES["tempo_hr"])
            a["workout_options"] = list(workout.options(row["activity_type"]))
            a["laps"] = [
                dict(r)
                for r in c.execute("SELECT * FROM laps WHERE activity_id = ? ORDER BY idx", (aid,))
            ]
            a["channels"] = [
                r["channel"]
                for r in c.execute("SELECT channel FROM streams WHERE activity_id = ?", (aid,))
            ]
            # Best efforts with where they happened and the person's record for each in the same
            # category (with when the record was set).
            same = _RECORDS_SQL.format(where="oa.person_id = ? AND oa.category IS ?")
            a["best_efforts"] = [
                dict(r)
                for r in c.execute(
                    f"""WITH r AS ({same})
                       SELECT b.kind, b.key, b.v, b.value, b.start_s, b.end_s,
                              r.value AS record, r.start_time_utc AS record_time,
                              r.utc_offset_s AS record_offset_s, r.activity_id AS record_activity
                       FROM {EFFORTS_SQL} b
                       LEFT JOIN r ON r.kind = b.kind AND r.key = b.key AND r.v = b.v
                            AND r.rk = 1
                       WHERE b.activity_id = ? ORDER BY b.kind, b.key""",
                    (a["person_id"], a["category"], aid),
                )
            ]
            # the all-time best before this activity (the tooltip of a new record)
            prev = _prev_bests(
                c, row, ["oa.person_id = ?", "oa.category IS ?"], [a["person_id"], a["category"]]
            )
            for b in a["best_efforts"]:
                p = prev.get((b["kind"], b["key"], b["v"]))
                b["prev"] = dict(p) if p else None
            # Own photos of devices: data/device-images/<product>.(png|jpg|webp)
            if a.get("devices"):
                devs = json.loads(a["devices"])
                for d in devs:
                    d["image"] = _device_image(d.get("product"))
                a["devices"] = devs
            a["country_name"] = countries.names().get(a.get("country") or "")
            a["segments"] = _activity_segments(c, a)
            # Garmin Connect list data (title, training effect, body battery, location…)
            g = c.execute(
                """SELECT summary FROM garmin_activities
                   WHERE summary IS NOT NULL AND (trailbook_id = ? OR file_rel IN (
                         SELECT rel_path FROM files WHERE activity_id = ?))
                   LIMIT 1""",
                (aid, aid),
            ).fetchone()
            a["connect"] = json.loads(g["summary"]) if g else None
            # Garmin's values from the FIT file (training effect, load, recovery): the fallback
            a["fit_metrics"] = json.loads(a["fit_metrics"]) if a.get("fit_metrics") else None
            # Previous / next activity in time, within the activities page filters (from, to,
            # types, workouts; person in the All view): same person, everyone with
            # ?neighbours=all.
            q = request.query_params
            every = q.get("neighbours") == "all"
            nw, npar = activity_filters(q, "", person=every)
            if not every:
                nw, npar = [*nw, "person_id = ?"], [*npar, row["person_id"]]
            w_where, w_params = _workout_filter(q)
            nf = " ".join(f"AND {w}" for w in [*nw, *w_where])
            key = (row["start_time_utc"], row["start_time_utc"], aid)
            for name, op, order in (("prev_id", "<", "DESC"), ("next_id", ">", "ASC")):
                n = c.execute(
                    f"""SELECT id FROM activities
                        WHERE (start_time_utc {op} ? OR (start_time_utc = ? AND id {op} ?)) {nf}
                        ORDER BY start_time_utc {order}, id {order} LIMIT 1""",
                    (*key, *npar, *w_params),
                ).fetchone()
                a[name] = n["id"] if n else None
            a["files"] = [
                dict(r)
                for r in c.execute(
                    """SELECT id, COALESCE(source_rel, rel_path) AS rel_path, zip_member, status,
                              imported_at
                       FROM files WHERE activity_id = ?""",
                    (aid,),
                )
            ]
            return JSONResponse(a)

    # The person's best value per effort (kind, key, v) in a time range, to compare an activity
    # with: all (all time), year (the whole calendar year of the activity: an older activity
    # is compared with its year, not with the year so far), 365d, 90d, 30d.
    async def activity_records(request: Request):
        aid = request.path_params["id"]
        rng = request.query_params.get("range", "all")
        days = {"365d": 365, "90d": 90, "30d": 30}
        with closing(conn()) as c:
            a = _activity_or_404(c, aid)
            # Same category only: running power or HR is no record for a ride.
            where = ["oa.person_id = ?", "oa.category IS ?"]
            params = [a["person_id"], a["category"]]
            if rng == "year":
                where.append("substr(oa.start_time_utc, 1, 4) = ?")
                params.append(a["start_time_utc"][:4])
            elif rng in days:
                since = datetime.now(UTC) - timedelta(days=days[rng])
                where.append("oa.start_time_utc >= ?")
                params.append(since.strftime("%Y-%m-%dT%H:%M:%SZ"))
            elif rng != "all":
                raise HTTPException(400, "range must be all, year, 365d, 90d or 30d")
            rows = c.execute(
                f"""WITH r AS ({_RECORDS_SQL.format(where=" AND ".join(where))})
                    SELECT kind, key, v, value, start_time_utc, utc_offset_s, activity_id
                    FROM r WHERE rk = 1""",
                params,
            ).fetchall()
            prev = _prev_bests(c, a, where, params)  # the range's best before this activity
            records = []
            for r in rows:
                p = prev.get((r["kind"], r["key"], r["v"]))
                records.append({**dict(r), "prev": dict(p) if p else None})
        return JSONResponse({"range": rng, "records": records})

    # Weather during the activity (Open-Meteo, cached per activity).
    async def activity_weather(request: Request):
        aid = request.path_params["id"]

        def work():
            with closing(conn()) as c:
                _activity_or_404(c, aid)
                return weather.compute(c, aid)

        try:
            result = await run_in_threadpool(work)
        except OSError as exc:
            return JSONResponse({"error": str(exc)}, status_code=503)
        return JSONResponse(result)

    index_html = _versioned_index()  # once per start: the files change only with an update

    async def app_index(request: Request):
        return Response(index_html, media_type="text/html", headers={"Cache-Control": "no-store"})

    # Settings › Log: the app log (applog), newest first.
    async def app_log(request: Request):
        try:
            limit = max(1, min(int(request.query_params.get("limit", 1000)), 5000))
        except ValueError as exc:
            raise HTTPException(400, "limit must be a number") from exc
        entries = await run_in_threadpool(applog.read, db_path, limit)
        return JSONResponse({"entries": entries})

    # Road surface along the route (OpenStreetMap via an Overpass server, cached per activity).
    async def activity_surface(request: Request):
        aid = request.path_params["id"]

        def work():
            with closing(conn()) as c:
                _activity_or_404(c, aid)
                return surface.compute(c, aid)

        try:
            result = await run_in_threadpool(work)
        except OSError as exc:
            return JSONResponse({"error": str(exc)}, status_code=503)
        return JSONResponse(result)

    # Section lines of an interval workout (seconds from the start) for the charts. Only while
    # the activity is Intervals (detected or chosen); nothing is stored, the lines the person
    # moves live in the page.
    async def activity_intervals(request: Request):
        aid = request.path_params["id"]

        def work():
            with closing(conn()) as c:
                row = _activity_or_404(c, aid)
                if (row["workout_override"] or row["workout"]) != "intervals":
                    return {"splits": [], "channel": None}
                return workout.interval_splits(c, aid)

        return JSONResponse(await run_in_threadpool(work))

    async def device_image(request: Request):
        name = request.path_params["name"]
        path = device_images / name
        if not re.fullmatch(r"[\w.-]+\.(png|jpg|webp)", name) or not path.is_file():
            raise HTTPException(404, "no image")
        return FileResponse(path, headers={"Cache-Control": "max-age=86400"})

    SECTION_KINDS = ("intervals", "hills")

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
                workout.detect_one(c, aid)
            if "workout" in body:  # the person's choice; null = back to the detected kind
                try:
                    workout.set_override(c, aid, body["workout"])
                except ValueError as exc:
                    raise HTTPException(400, str(exc)) from exc
            if "ftp" in body:  # FTP for this activity only; null = the file's / the person's
                ftp = body["ftp"]
                if ftp is not None and (not isinstance(ftp, int | float) or not 30 <= ftp <= 2000):
                    raise HTTPException(400, "FTP must be 30-2000 W")
                c.execute(
                    "UPDATE activities SET ftp_override = ? WHERE id = ?",
                    (round(ftp) if ftp is not None else None, aid),
                )
                analysis.analyse_one(c, aid)  # load, intensity
                workout.detect_one(c, aid)
            if "section_lines" in body:  # lines the person moved; null = back to the detected
                lines = body["section_lines"]
                ok = lines is None or (
                    isinstance(lines, dict)
                    and lines.get("kind") in SECTION_KINDS
                    and isinstance(lines.get("splits"), list)
                    and len(lines["splits"]) <= 1000
                    and all(isinstance(v, int | float) and v >= 0 for v in lines["splits"])
                )
                if not ok:
                    raise HTTPException(400, "invalid section lines")
                saved = (
                    {"kind": lines["kind"], "splits": sorted(round(v) for v in lines["splits"])}
                    if lines
                    else None
                )
                c.execute(
                    "UPDATE activities SET section_lines = ? WHERE id = ?",
                    (json.dumps(saved) if saved else None, aid),
                )
            # saved lines belong to one training type: another type (chosen or detected after a
            # change of sport or FTP) drops them
            row = _activity_or_404(c, aid)
            if row["section_lines"]:
                kind = json.loads(row["section_lines"]).get("kind")
                if kind != (row["workout_override"] or row["workout"]):
                    c.execute("UPDATE activities SET section_lines = NULL WHERE id = ?", (aid,))
            if "fix" in body:  # Edit › Correct altitude / Correct speed (fixes.py)
                if body["fix"] not in fixes.KINDS:
                    raise HTTPException(400, "fix must be altitude or speed")
                c.execute("BEGIN")
                try:
                    fixes.apply(c, aid, [body["fix"]])
                    c.execute("COMMIT")
                except Exception:
                    c.execute("ROLLBACK")
                    raise
                analysis.analyse_one(c, aid)
                segments.match_activity(c, aid)
                workout.detect_one(c, aid)
            if "excluded" in body:  # left out of the statistics, records and segment efforts
                c.execute(
                    "UPDATE activities SET excluded = ? WHERE id = ?",
                    (int(bool(body["excluded"])), aid),
                )
                segments.match_activity(c, aid)
            if "name" in body:
                name = (body["name"] or "").strip()
                if name:
                    c.execute(
                        "UPDATE activities SET name = ?, name_overridden = 1 WHERE id = ?",
                        (name, aid),
                    )
                else:  # cleared: back to the Garmin Connect title, or no name (UI shows type)
                    c.execute(
                        """UPDATE activities SET name = NULL, name_source = NULL,
                                  name_overridden = 0
                           WHERE id = ?""",
                        (aid,),
                    )
                    importer.apply_connect_title(c, aid)
            return JSONResponse(dict(_activity_or_404(c, aid)))

    # Activity › Export: ?format=fit (the whole activity) or gpx (the route only)
    async def activity_export(request: Request):
        aid = request.path_params["id"]
        kind = request.query_params.get("format", "fit")
        if kind not in ("fit", "gpx"):
            raise HTTPException(400, "format must be fit or gpx")
        with closing(conn()) as c:
            a = _activity_or_404(c, aid)
            root = db.get_setting(c, "root")
            local = datetime.strptime(a["start_time_utc"][:19], "%Y-%m-%dT%H:%M:%S") + timedelta(
                seconds=a["utc_offset_s"] or 0
            )
            t = sports.TYPES.get(a["activity_type"])
            label = a["name"] or (t.en if t else "Activity")
            plain = unicodedata.normalize("NFKD", label.replace("ł", "l").replace("Ł", "L"))
            plain = plain.encode("ascii", "ignore").decode()
            base = re.sub(r"[^A-Za-z0-9._-]+", "-", f"{local:%Y-%m-%d}-{plain}").strip("-")[:80]
            if kind == "gpx":
                text = export.gpx_text(c, a, label)
                if text is None:
                    raise HTTPException(404, "the activity has no route")
                body, media = text.encode(), "application/gpx+xml"
            else:
                body = export.fit_bytes(c, a, Path(root) if root else None, uploads_dir)
                media = "application/vnd.ant.fit"
        return Response(
            body, media_type=media,
            headers={"Content-Disposition": f'attachment; filename="{base}.{kind}"'},
        )  # fmt: skip

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
                    WHERE activity_id = ? AND channel IN ({marks})
                    UNION ALL
                    SELECT channel, encoding, data FROM connect_streams
                    WHERE activity_id = ? AND channel IN ({marks})""",
                [aid, *channels, aid, *channels],
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

    async def activity_earlier_tracks(request: Request):
        """Routes of the person's earlier activities that cross this one's box: the browser
        works out which tiles this activity visited for the first time (New tiles)."""
        aid = request.path_params["id"]
        with closing(conn()) as c:
            a = _activity_or_404(c, aid)
            if not a["has_gps"] or a["bbox_min_lat"] is None:
                return JSONResponse({"items": []})
            rows = c.execute(
                """SELECT t.polyline FROM activities a JOIN tracks t ON t.activity_id = a.id
                   WHERE a.person_id = ? AND a.has_gps = 1 AND a.id != ?
                     AND (a.start_time_utc < ? OR (a.start_time_utc = ? AND a.id < ?))
                     AND a.bbox_max_lat >= ? AND a.bbox_min_lat <= ?
                     AND a.bbox_max_lon >= ? AND a.bbox_min_lon <= ?""",
                (a["person_id"], aid, a["start_time_utc"], a["start_time_utc"], aid,
                 a["bbox_min_lat"] - BOX_MARGIN, a["bbox_max_lat"] + BOX_MARGIN,
                 a["bbox_min_lon"] - BOX_MARGIN, a["bbox_max_lon"] + BOX_MARGIN),
            ).fetchall()  # fmt: skip
        return JSONResponse({"items": [r["polyline"] for r in rows]})

    # ---- heatmap ---------------------------------------------------------------------

    async def heatmap_tracks(request: Request):
        where, params = _map_filters(request.query_params)
        with closing(conn()) as c:
            rows = c.execute(
                f"""SELECT a.id, a.person_id, a.activity_type, a.category,
                           substr(a.start_time_utc, 1, 10) day, a.distance_m, a.time_s,
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
        known = basemap.SOURCES.get(source) or basemap.OVERLAYS.get(source)
        if not known:
            raise HTTPException(404, "unknown base map")
        template, max_zoom, _, _ = known
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
            garmin_connected = c.execute(
                "SELECT COUNT(*) FROM garmin_accounts WHERE status != 'auth_error'"
            ).fetchone()[0]
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
                "garmin_connected": garmin_connected,
                "last_run": dict(last) if last else None,
                "scan_interval_min": interval,
                "next_scan_at": due.strftime("%Y-%m-%dT%H:%M:%SZ") if due else None,
            }
        )

    def _part_path(request: Request) -> Path:
        pid = request.query_params.get("part", "")
        if not PART_ID.fullmatch(pid):
            raise HTTPException(400, "bad upload part id")
        return parts_dir / f"{pid}.part"

    async def upload_part(request: Request):
        """One part of a big upload, appended at `offset` (must be the size received so far)."""
        path = _part_path(request)
        try:
            offset = int(request.query_params.get("offset", ""))
        except ValueError:
            raise HTTPException(400, "offset missing") from None
        parts_dir.mkdir(parents=True, exist_ok=True)
        if offset == 0:  # a new upload: drop old unfinished ones
            cutoff = datetime.now().timestamp() - PART_MAX_AGE_S
            for old in parts_dir.glob("*.part"):
                if old.stat().st_mtime < cutoff:
                    old.unlink(missing_ok=True)
        have = path.stat().st_size if path.exists() else 0
        if offset != have:
            raise HTTPException(409, f"expected offset {have}")
        with path.open("ab" if offset else "wb") as fh:
            async for chunk in request.stream():
                fh.write(chunk)
        return JSONResponse({"size": path.stat().st_size})

    async def upload(request: Request):
        """Raw body upload of one activity file or ZIP for a chosen person (one-time import).

        FIT, GPX and TCX (also .gz) and ZIPs of them: Garmin and Strava exports. With `part`:
        the file sent before in parts (POST /api/uploads/part), the body is empty."""
        pid = request.query_params.get("person", "")
        name = Path(request.query_params.get("name", "")).name
        # optional: of a Strava export only the activities of these days (both included)
        span = [request.query_params.get(k) or None for k in ("from", "to")]
        if any(d and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", d) for d in span):
            raise HTTPException(400, "dates as YYYY-MM-DD")
        if not name.lower().endswith((".zip", *importer.ACTIVITY_SUFFIXES)):
            raise HTTPException(
                400, "only .zip, .fit, .gpx or .tcx files (also .gz) can be uploaded"
            )
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
        n = 1
        while target.exists():  # several files with one name in the same second
            n += 1
            target = target.with_name(f"{stamp}-{n}-{safe}")
        size = 0
        if request.query_params.get("part"):
            part = _part_path(request)
            if not part.is_file():
                raise HTTPException(400, "upload parts missing")
            os.replace(part, target)
            size = target.stat().st_size
        else:
            with target.open("wb") as fh:
                async for chunk in request.stream():
                    size += len(chunk)
                    fh.write(chunk)
        if size == 0:
            target.unlink(missing_ok=True)
            raise HTTPException(400, "empty file")
        try:
            with closing(conn()) as c:
                queued = importer.register_upload(c, uploads_dir, pid, target, *span)
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

    # Estimates the person accepted (no warning for them), per person in settings.
    ACCEPTABLE = ("hr_max", "hr_rest")

    def _accepted(c: sqlite3.Connection, pid: str) -> set[str]:
        raw = db.get_setting(c, f"accepted_estimates:{pid}")
        return set(json.loads(raw)) if raw else set()

    async def thresholds_accept(request: Request):
        body = await request.json()
        field = body.get("field")
        if field not in ACCEPTABLE:
            raise HTTPException(400, "only HR max and resting HR estimates can be accepted")
        with closing(conn()) as c:
            pid = _single_person(c, request)
            acc = _accepted(c, pid)
            if body.get("accepted", True):
                acc.add(field)
            else:
                acc.discard(field)
            db.set_setting(c, f"accepted_estimates:{pid}", json.dumps(sorted(acc)))
            return JSONResponse(_thresholds_state(c, pid))

    def _thresholds_state(c: sqlite3.Connection, pid: str) -> dict:
        rows = analysis.threshold_rows(c, pid)
        auto_max = analysis.auto_hr_max(c, pid)
        today = importer.now_iso()[:10]
        watch, watch_day = analysis.watch_on(analysis.watch_history(c, pid), today)
        th = analysis.thresholds_for(rows, today, auto_max, watch)
        return {
            "rows": [dict(r) for r in rows],
            "watch": {**watch, "day": watch_day},
            "effective": {
                "hr_max": th.hr_max, "hr_rest": th.hr_rest, "lthr": th.lthr, "ftp": th.ftp,
                "threshold_pace": th.threshold_pace, "sources": th.sources,
            },
            "auto_hr_max": auto_max,
            "accepted": sorted(_accepted(c, pid)),
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
            qp = request.query_params
            # the time filter: from / to, last (a period up to today) and years
            since = max(filter(None, [qp.get("from"), last_since(qp.get("last"))]), default=None)
            until = qp.get("to")
            years = set(years_of(qp))
            if years:  # the warnings look at the whole span of the chosen years
                since, until = f"{min(years)}-01-01", f"{max(years)}-12-31"
            warnings = analysis.threshold_warnings(
                c, pid, since or "", until or "", _accepted(c, pid)
            )
            # VO2 max the watch estimated after each run and ride (FIT file, fit_metrics):
            # running and cycling have their own; the last one of a day counts
            day = analysis.LOCAL_DAY_SQL
            vo2 = {"run": {}, "ride": {}}
            for r in c.execute(
                f"""SELECT category, {day} AS day,
                           json_extract(fit_metrics, '$.vo2max') AS v
                    FROM activities
                    WHERE person_id = ? AND category IN ('run', 'ride')
                      AND json_extract(fit_metrics, '$.vo2max') IS NOT NULL
                    ORDER BY start_time_utc""",
                (pid,),
            ):
                vo2[r["category"]][r["day"]] = r["v"]
        # Ramp rate: fitness change over the last 7 days (from the whole series, so the
        # first days of a shown range have it too).
        for i, d in enumerate(series):
            d["ramp"] = round(d["ctl"] - series[max(0, i - 7)]["ctl"], 1)
        shown = [
            d
            for d in series
            if (not since or d["date"] >= since) and (not until or d["date"] <= until)
        ]
        # VO2 max on every shown day: the latest estimate up to that day (it stands until the
        # next activity), None before the first one
        for g, by_day in vo2.items():
            known = sorted(by_day.items())
            k, cur = 0, None
            for d in series:
                while k < len(known) and known[k][0] <= d["date"]:
                    cur = known[k][1]
                    k += 1
                d[f"vo2_{g}"] = round(cur, 1) if cur is not None else None
        return JSONResponse(
            {
                "series": shown,
                "first": series[0]["date"] if series else None,
                "methods": methods,
                "thresholds": th["effective"],
                "pending": th["pending"],
                "warnings": warnings,
            }
        )

    async def wellbeing_movement(request: Request):
        """Wellbeing › Movement: the days of the time filter (wellbeing.movement_days)."""
        qp = request.query_params
        with closing(conn()) as c:
            pid = _single_person(c, request)
            years = years_of(qp)
            first = c.execute(
                """SELECT MIN(d) FROM (
                       SELECT MIN(day) d FROM garmin_days WHERE person_id = ?
                       UNION ALL SELECT MIN(p.day) FROM daily_parts p
                       JOIN files f ON f.id = p.file_id WHERE f.person_id = ?)""",
                (pid, pid),
            ).fetchone()[0]
            since = max(filter(None, [qp.get("from"), last_since(qp.get("last"))]), default=None)
            start, end = wellbeing.span(first, since, qp.get("to"), years)
            days = wellbeing.movement_days(c, pid, start, end) if start <= end else []
        if years:
            days = [d for d in days if d["day"][:4] in years]
        return JSONResponse({"from": start, "to": end, "first": first, "days": days})

    async def wellbeing_body(request: Request):
        """Wellbeing › Body: the weigh-ins of the time filter (wellbeing.body_rows) and the
        last one with a full body composition (any time)."""
        qp = request.query_params
        with closing(conn()) as c:
            pid = _single_person(c, request)
            years = years_of(qp)
            first = c.execute(
                """SELECT MIN(d) FROM (
                       SELECT MIN(substr(b.ts, 1, 10)) d FROM body_parts b
                       JOIN files f ON f.id = b.file_id WHERE f.person_id = ?
                       UNION ALL SELECT MIN(substr(ts, 1, 10)) FROM garmin_weights
                       WHERE person_id = ?)""",
                (pid, pid),
            ).fetchone()[0]
            since = max(filter(None, [qp.get("from"), last_since(qp.get("last"))]), default=None)
            start, end = wellbeing.span(first, since, qp.get("to"), years)
            rows = wellbeing.body_rows(c, pid, start, end) if start <= end else []
            full = wellbeing.body_rows(c, pid, "0000-01-01", "9999-12-31")
        if years:
            rows = [r for r in rows if r["day"][:4] in years]
        last_full = next((r for r in reversed(full) if r["fat_pct"] is not None), None)
        return JSONResponse(
            {
                "from": start,
                "to": end,
                "items": rows,
                "last_full": last_full,
                "last": full[-1] if full else None,
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
        pid = q.get("person") if q.get("person") not in (None, "", "all") else None
        if pid:
            where.append("person_id = ?")
            params.append(pid)
        with closing(conn()) as c:
            rows = c.execute(
                f"""SELECT id, person_id, start_time_utc, utc_offset_s, activity_type, category,
                           name, distance_m, time_s, ascent_m, load, workout, avg_speed,
                           avg_power,
                           workout_override, indoor, {day} AS day
                    FROM activities WHERE {" AND ".join(where)} ORDER BY start_time_utc""",
                params,
            ).fetchall()
            items = [dict(r) for r in rows]
            if q.get("chart") == "1":  # the small chart of each activity (tilechart.py)
                for item in items:
                    item["tile_chart"] = tilechart.tile_chart(c, item["id"])
            # steps, floors, stress of each day (one person only: they do not add up)
            days = analysis.daily_values(c, pid, start, end) if pid else {}
            plans, last = [], None
            if q.get("planned") == "1":
                plans = icu.planned(c, pid, start, end)
                last = c.execute(
                    "SELECT MAX(day) FROM planned_workouts WHERE sync_state != 'delete'"
                    + (" AND person_id = ?" if pid else ""),
                    (pid,) if pid else (),
                ).fetchone()[0]
        return JSONResponse(
            {"activities": items, "days": days, "planned": plans, "last_planned": last}
        )

    async def forecast(request: Request):
        """Weather forecast and the latitude for the day length, at the start of the person's
        latest activity with a route."""
        q = request.query_params
        pid = q.get("person") if q.get("person") not in (None, "", "all") else None
        with closing(conn()) as c:
            row = c.execute(
                f"""SELECT start_lat, start_lon FROM activities
                    WHERE start_lat IS NOT NULL AND start_lon IS NOT NULL
                    {"AND person_id = ?" if pid else ""}
                    ORDER BY start_time_utc DESC LIMIT 1""",
                (pid,) if pid else (),
            ).fetchone()
        if row is None:
            return JSONResponse({"lat": None, "days": []})
        lat, lon = row["start_lat"], row["start_lon"]
        try:
            days = await run_in_threadpool(weather.forecast, lat, lon)
        except OSError:
            days = []
        return JSONResponse({"lat": round(lat, 2), "days": days})

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
            where, params = activity_filters(q, "", person=False)
            # activities the person excluded (activity › Edit) are left out
            where, params = ["person_id = ?", "NOT excluded", *where], [pid, *params]
            inner = f"SELECT *, {day} AS day FROM activities WHERE {' AND '.join(where)}"
            outer = ""
            rows = c.execute(
                f"""SELECT {period} AS period, COUNT(*) AS count, SUM(distance_m) AS distance_m,
                           SUM(time_s) AS time_s, SUM(ascent_m) AS ascent_m,
                           SUM(load) AS load, SUM(calories) AS calories,
                           COUNT(DISTINCT day) AS active_days
                    FROM ({inner}) {outer} GROUP BY period ORDER BY period""",
                params,
            ).fetchall()
            groups = c.execute(
                f"""SELECT category, COUNT(*) AS count, SUM(distance_m) AS distance_m,
                           SUM(time_s) AS time_s
                    FROM ({inner}) {outer} GROUP BY category ORDER BY time_s DESC""",
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
            out = {"rows": [dict(r) for r in rows], "groups": [dict(r) for r in groups],
                   "years": years}  # fmt: skip
            # ?parts=1: the same per period split into running, cycling and the rest
            if q.get("parts"):
                out["parts"] = [
                    dict(r)
                    for r in c.execute(
                        f"""SELECT {period} AS period,
                                   CASE category WHEN 'run' THEN 'run' WHEN 'ride' THEN 'ride'
                                        ELSE 'other' END AS part,
                                   COUNT(*) AS count, SUM(distance_m) AS distance_m,
                                   SUM(ascent_m) AS ascent_m, SUM(time_s) AS time_s
                            FROM ({inner}) GROUP BY period, part ORDER BY period""",
                        params,
                    )
                ]
            # ?steps=1: steps per period (daily monitoring data; the Type filter does not apply)
            if q.get("steps"):
                fmt = {"year": "%Y", "month": "%Y-%m", "week": "%Y-W%W"}[q.get("by", "year")]
                per: dict[str, int] = {}
                for d, v in analysis.daily_values(c, pid, "0000-01-01", "9999-12-31").items():
                    if v["steps"]:
                        key = date.fromisoformat(d).strftime(fmt)
                        per[key] = per.get(key, 0) + v["steps"]
                out["steps"] = [{"period": k, "steps": v} for k, v in sorted(per.items())]
        return JSONResponse(out)

    # Calendar › Next: the next session for the person (suggest.py); `today` = the browser's day
    async def suggest_next(request: Request):
        q = request.query_params
        try:
            today = date.fromisoformat(q.get("today") or "")
        except ValueError:
            today = date.today()
        with closing(conn()) as c:
            pid = _single_person(c, request)
            return JSONResponse(suggest.suggest(c, pid, today, q.get("model") or ""))

    # Statistics › Timeline: one short row per activity in the filters; the page works out the
    # time of day, weekdays, types, countries, distances and weather from them.
    async def stats_activities(request: Request):
        q = request.query_params
        with closing(conn()) as c:
            pid = _single_person(c, request)
            where, params = activity_filters(q, "", person=False)
            where, params = ["person_id = ?", "NOT excluded", *where], [pid, *params]
            rows = c.execute(
                f"""SELECT id, start_time_utc, utc_offset_s, elapsed_s, time_s, distance_m,
                           ascent_m, avg_speed, category, activity_type, indoor, has_gps,
                           country, weather
                    FROM activities WHERE {" AND ".join(where)} ORDER BY start_time_utc""",
                params,
            ).fetchall()
            # ?steps_from=&steps_to= (local days): the steps of those days (daily data)
            steps = None
            if q.get("steps_from") and q.get("steps_to"):
                days = analysis.daily_values(c, pid, q["steps_from"], q["steps_to"])
                steps = sum(v["steps"] or 0 for v in days.values())
        items = []
        for r in rows:
            w = json.loads(r["weather"]) if r["weather"] else None
            t = datetime.strptime(r["start_time_utc"][:19], "%Y-%m-%dT%H:%M:%S")
            local = t + timedelta(seconds=r["utc_offset_s"] or 0)
            items.append([
                r["id"], local.strftime("%Y-%m-%dT%H:%M:%S"), r["elapsed_s"] or r["time_s"] or 0,
                r["time_s"] or 0,
                r["distance_m"] or 0, r["ascent_m"] or 0, r["avg_speed"], r["category"],
                r["activity_type"], int(bool(r["indoor"])), int(bool(r["has_gps"])), r["country"],
                [w.get("temp"), w.get("code")] if w and w.get("temp") is not None else None,
            ])  # fmt: skip
        return JSONResponse({
            "fields": ["id", "start", "elapsed_s", "time_s", "distance_m", "ascent_m",
                       "avg_speed", "group", "type", "indoor", "gps", "country", "weather"],
            "items": items, "countries": countries.names(), "steps": steps,
        })  # fmt: skip

    # Statistics › Records: per sport (run, ride) and best effort (kind, key, v) the 3 best of
    # all time and, with a Time filter, the best in that time. Rides: outdoor and indoor (v = 1)
    # distances, times and top speed apart, power together. The Type filter does not apply.
    RECORD_KINDS = {
        "run": ("pace", "longest", "within", "ascent", "climb", "grade"),
        "ride": ("ride", "longest", "within", "speed", "ascent", "climb", "grade", "power"),
        "walk": ("longest", "steps", "ascent", "climb", "grade"),  # walks and hikes: no speed
    }
    # a records group and the activity groups in it
    RECORD_GROUPS = {"run": ("run",), "ride": ("ride",), "walk": ("walk", "hike")}
    RECORD_GROUP_SQL = "CASE WHEN a.category = 'hike' THEN 'walk' ELSE a.category END"

    async def stats_records(request: Request):
        q = request.query_params
        time_q = {k: q[k] for k in ("from", "to", "last", "years", "year") if q.get(k)}
        with closing(conn()) as c:
            pid = _single_person(c, request)
            shared, sp = activity_filters(time_q, person=False)
            kinds = " OR ".join(
                f"(a.category IN ({', '.join(repr(c) for c in RECORD_GROUPS[g])})"
                f" AND o.kind IN ({', '.join(repr(k) for k in ks)}))"
                for g, ks in RECORD_KINDS.items()
            )
            keep = lambda r: {k: r[k] for k in r.keys() if k not in ("grp", "kind", "key", "v")}  # noqa: E731

            def top(where: list[str], params: list, n: int) -> list[sqlite3.Row]:
                return c.execute(
                    f"""WITH e AS (
                            SELECT {RECORD_GROUP_SQL} AS grp, o.kind, o.key, o.v, o.value,
                                   a.id AS activity_id, a.name, a.activity_type,
                                   a.start_time_utc, a.utc_offset_s, a.distance_m, a.time_s,
                                   ROW_NUMBER() OVER (
                                       PARTITION BY {RECORD_GROUP_SQL}, o.kind, o.key, o.v
                                       ORDER BY {records._ORDER}, a.start_time_utc) AS rk
                            FROM {EFFORTS_SQL} o JOIN activities a ON a.id = o.activity_id
                            WHERE a.person_id = ? AND ({kinds})
                              {"".join(f" AND {w}" for w in where)})
                        SELECT * FROM e WHERE rk <= {n} ORDER BY grp, kind, v, key, rk""",
                    [pid, *params],
                ).fetchall()

            out: dict[str, dict] = {}
            for r in top([], [], 3):
                e = out.setdefault(
                    f"{r['grp']}:{r['kind']}:{r['key']}:{r['v']}",
                    {"group": r["grp"], "kind": r["kind"], "key": r["key"], "v": r["v"],
                     "ever": [], "range": None},
                )  # fmt: skip
                e["ever"].append(keep(r))
            if shared:
                for r in top(shared, sp, 1):
                    e = out.get(f"{r['grp']}:{r['kind']}:{r['key']}:{r['v']}")
                    if e:
                        e["range"] = keep(r)

            # segments: per segment the person rode, the 3 fastest of all time and the fastest
            # in the Time filter (the activity's group decides pace or speed)
            def seg_top(where: list[str], params: list, n: int) -> list[sqlite3.Row]:
                return c.execute(
                    f"""WITH e AS (
                            SELECT s.id AS segment_id, s.name AS segment_name, s.distance_m
                                       AS segment_m, se.elapsed_s AS value, a.category,
                                   a.id AS activity_id, a.name, a.activity_type,
                                   a.start_time_utc, a.utc_offset_s,
                                   ROW_NUMBER() OVER (PARTITION BY s.id
                                       ORDER BY se.elapsed_s, a.start_time_utc) AS rk
                            FROM segment_efforts se JOIN segments s ON s.id = se.segment_id
                            JOIN activities a ON a.id = se.activity_id
                            WHERE a.person_id = ? AND NOT a.excluded
                              {"".join(f" AND {w}" for w in where)})
                        SELECT * FROM e WHERE rk <= {n} ORDER BY segment_name, segment_id, rk""",
                    [pid, *params],
                ).fetchall()

            segs: dict[int, dict] = {}
            drop = ("segment_id", "segment_name", "segment_m", "rk")
            for r in seg_top([], [], 3):
                e = segs.setdefault(
                    r["segment_id"],
                    {"segment": {"id": r["segment_id"], "name": r["segment_name"],
                                 "distance_m": r["segment_m"]}, "ever": [], "range": None},
                )  # fmt: skip
                e["ever"].append({k: r[k] for k in r.keys() if k not in drop})
            if shared:
                for r in seg_top(shared, sp, 1):
                    if r["segment_id"] in segs:
                        segs[r["segment_id"]]["range"] = {
                            k: r[k] for k in r.keys() if k not in drop
                        }
        groups = {g: [e for e in out.values() if e["group"] == g] for g in RECORD_KINDS}
        return JSONResponse({"filtered": bool(shared), **groups, "segments": list(segs.values())})

    # The latest record event: what the add-on pushes to Home Assistant as
    # sensor.trailbook_records (records.py).
    async def ha_records(request: Request):
        with closing(conn()) as c:
            return JSONResponse(records.payload(records.latest(c)))

    # Dashboard cards (hacards.py): made here, shown by the Lovelace card `trailbook-card`.
    async def ha_setup(request: Request):
        return JSONResponse(
            {
                "addon": homeassistant.available(),
                "install": hacards.STATUS,
                "url": hacards.card_url(),
            }
        )

    async def ha_cards_list(request: Request):
        with closing(conn()) as c:
            return JSONResponse(hacards.list_cards(c))

    async def ha_cards_create(request: Request):
        body = await request.json()
        try:
            with closing(conn()) as c:
                card = hacards.create_card(
                    c, body.get("name") or "", body.get("kind") or "", body.get("config", {})
                )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return JSONResponse(card, status_code=201)

    async def ha_card_get(request: Request):
        with closing(conn()) as c:
            card = hacards.get_card(c, request.path_params["card"])
        if not card:
            raise HTTPException(404, "card not found")
        return JSONResponse(card)

    async def ha_card_put(request: Request):
        body = await request.json()
        try:
            with closing(conn()) as c:
                card = hacards.update_card(c, request.path_params["card"], body)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if not card:
            raise HTTPException(404, "card not found")
        return JSONResponse(card)

    async def ha_card_delete(request: Request):
        with closing(conn()) as c:
            if not hacards.delete_card(c, request.path_params["card"]):
                raise HTTPException(404, "card not found")
        return Response(status_code=204)

    # ---- segments ----------------------------------------------------------------------

    EFFORT_COLS = """e.id, e.segment_id, e.activity_id, e.start_time_utc, e.start_s, e.end_s,
        e.elapsed_s, e.avg_speed, e.max_speed, e.avg_hr, e.max_hr, e.avg_power,
        e.avg_cadence, e.reverse,
        a.person_id, a.utc_offset_s, a.name AS activity_name, a.activity_type, a.weather"""

    def _activity_segments(c: sqlite3.Connection, a: dict) -> list[dict]:
        """Segments ridden in an activity: the effort, the person's 3 best of all time and of
        the last 12 months, the 2 efforts before this one, and the bests of this year and of
        all time (for the best efforts tile)."""
        since = (datetime.now(UTC) - timedelta(days=365)).strftime("%Y-%m-%dT%H:%M:%SZ")
        year = a["start_time_utc"][:4]  # the activity's year (all of it, also for old ones)
        rank = """(SELECT COUNT(*) + 1 FROM segment_efforts e2
                    JOIN activities a2 ON a2.id = e2.activity_id
                    WHERE e2.segment_id = e.segment_id AND a2.person_id = a.person_id
                      AND e2.elapsed_s < e.elapsed_s) AS rank"""
        joined = "FROM segment_efforts e JOIN activities a ON a.id = e.activity_id"

        def efforts(sid: int, extra: str, order: str, limit: int, *params) -> list[dict]:
            rows = c.execute(
                f"""SELECT {EFFORT_COLS}, {rank} {joined}
                    WHERE e.segment_id = ? AND a.person_id = ? {extra}
                    ORDER BY {order} LIMIT {limit}""",
                (sid, a["person_id"], *params),
            ).fetchall()
            return [dict(r) for r in rows]

        out = []
        mine = c.execute(
            f"SELECT {EFFORT_COLS}, {rank} {joined} WHERE e.activity_id = ? ORDER BY e.start_s",
            (a["id"],),
        ).fetchall()
        for eff in mine:
            sid = eff["segment_id"]
            seg = c.execute(
                """SELECT id, name, polyline, distance_m, ascent_m, category
                   FROM segments WHERE id = ?""",
                (sid,),
            ).fetchone()
            best = efforts(sid, "", "e.elapsed_s", 3)
            year_best = efforts(
                sid, "AND substr(e.start_time_utc, 1, 4) = ?", "e.elapsed_s", 1, year
            )
            # the bests before this effort: what a new record beat (tooltip of the laurel)
            before = "AND e.start_time_utc < ?"
            all_prev = efforts(sid, before, "e.elapsed_s", 1, eff["start_time_utc"])
            year_prev = efforts(
                sid, f"{before} AND substr(e.start_time_utc, 1, 4) = ?", "e.elapsed_s", 1,
                eff["start_time_utc"], year,
            )  # fmt: skip
            out.append(
                {
                    "segment": dict(seg) if seg else {"id": sid},
                    "effort": dict(eff),
                    "best": best,
                    "best_12m": efforts(sid, "AND e.start_time_utc >= ?", "e.elapsed_s", 3, since),
                    "previous": efforts(
                        sid,
                        "AND e.start_time_utc < ?",
                        "e.start_time_utc DESC",
                        2,
                        eff["start_time_utc"],
                    ),  # fmt: skip
                    "year_best": year_best[0]["elapsed_s"] if year_best else None,
                    "all_best": best[0]["elapsed_s"] if best else None,
                    "year_best_effort": year_best[0] if year_best else None,
                    "all_best_effort": best[0] if best else None,
                    "year_prev": year_prev[0] if year_prev else None,
                    "all_prev": all_prev[0] if all_prev else None,
                }
            )
        return out

    def _segment_or_404(c: sqlite3.Connection, sid: int) -> sqlite3.Row:
        row = c.execute("SELECT * FROM segments WHERE id = ?", (sid,)).fetchone()
        if row is None:
            raise HTTPException(404, "segment not found")
        return row

    def _segment_dict(s: sqlite3.Row) -> dict:
        d = dict(s)
        d["pending"] = s["match_version"] < segments.MATCH_VERSION
        d["two_way"] = segments.two_way(s)
        d["two_way_auto"] = segments.two_way_auto(s)
        d["match_width_m"] = segments.match_width(s)
        d["match_detour_m"] = segments.match_detour(s)
        return d

    def _person_filter(request: Request) -> tuple[str, list]:
        """Shared filters (person, time, types) on the activity `a` of each effort."""
        where, params = activity_filters(request.query_params)
        return "".join(f" AND {w}" for w in where), params

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
            "reverse": sum(1 for e in efforts if e.get("reverse")),  # ridden the other way
            "best_s": times[0],
            "avg_s": round(sum(times) / len(times), 1),
            "median_s": round(median, 1),
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
                    "SELECT id, name, activity_type, category, start_time_utc, utc_offset_s,"
                    " person_id FROM activities WHERE id = ?",
                    (s["source_activity_id"],),
                ).fetchone()
                source = dict(src) if src else None
                if source:  # the place, as on the activity page (Garmin Connect list data)
                    g = c.execute(
                        """SELECT summary FROM garmin_activities WHERE summary IS NOT NULL
                           AND (trailbook_id = ? OR file_rel IN (
                                SELECT rel_path FROM files WHERE activity_id = ?)) LIMIT 1""",
                        (source["id"], source["id"]),
                    ).fetchone()
                    source["location"] = (
                        (json.loads(g["summary"]) or {}).get("locationName") if g else None
                    )
            # Types of the efforts under every filter but Type: the Type filter lists only these.
            tq = {k: v for k, v in request.query_params.items() if k not in ("types", "type")}
            tw, tp = activity_filters(tq)
            type_counts = dict(
                c.execute(
                    f"""SELECT a.activity_type, COUNT(*) FROM segment_efforts e
                        JOIN activities a ON a.id = e.activity_id
                        WHERE e.segment_id = ? {"".join(f" AND {w}" for w in tw)}
                        GROUP BY a.activity_type""",
                    [sid, *tp],
                ).fetchall()
            )
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
                "type_counts": type_counts,
                # every effort in time order, for the trend chart
                "series": sorted(
                    (
                        {
                            k: e[k]
                            for k in (
                                "start_time_utc",
                                "utc_offset_s",
                                "elapsed_s",
                                "activity_id",
                                "rank",
                            )
                        }
                        for e in efforts
                    ),
                    key=lambda e: e["start_time_utc"],
                ),
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
            if "two_way_mode" in body:
                mode = body["two_way_mode"]
                if mode not in segments.TWO_WAY_MODES:
                    raise HTTPException(400, "two_way_mode must be auto, on or off")
                if mode != s["two_way_mode"]:
                    c.execute("UPDATE segments SET two_way_mode = ? WHERE id = ?", (mode, sid))
                    segments.reset_segment(c, sid)
                    job.start_segments()
            # how loosely it matches: the corridor's half width and one detour (m)
            for key, lo, hi, default in (
                ("match_width_m", segments.WIDTH_MIN_M, segments.WIDTH_MAX_M,
                 segments.TRACK_RADIUS_M),
                ("match_detour_m", 0.0, segments.DETOUR_MAX_M, 0.0),
            ):  # fmt: skip
                if key not in body:
                    continue
                try:
                    v = float(body[key])
                except (TypeError, ValueError) as exc:
                    raise HTTPException(400, f"{key} must be a number") from exc
                if not lo <= v <= hi:
                    raise HTTPException(400, f"{key} must be {lo:g} to {hi:g}")
                v = None if v == default else round(v)
                if v != s[key]:
                    c.execute(f"UPDATE segments SET {key} = ? WHERE id = ?", (v, sid))
                    segments.reset_segment(c, sid)
                    job.start_segments()
            return JSONResponse(_segment_dict(_segment_or_404(c, sid)))

    async def segment_delete(request: Request):
        with closing(conn()) as c:
            _segment_or_404(c, request.path_params["id"])
            c.execute("DELETE FROM segments WHERE id = ?", (request.path_params["id"],))
        return Response(status_code=204)

    # ---- Garmin Connect ----------------------------------------------------------------

    # ---- planned workouts (planner.py) and intervals.icu (icu.py) -----------------------

    plan_wake = asyncio.Event()

    def _plan_error(exc: planner.PlanError):
        raise HTTPException(400, str(exc)) from exc

    def _day_or_400(body: dict) -> str:
        day = str(body.get("day") or "")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
            raise HTTPException(400, "day must be a date (YYYY-MM-DD)")
        return day

    async def workouts_list(request: Request):
        with closing(conn()) as c:
            pid = _single_person(c, request)
            ctx = planner.context(c, pid)
            items = planner.templates(c, pid, ctx)
            key = c.execute("SELECT 1 FROM icu_accounts WHERE person_id = ?", (pid,)).fetchone()
        return JSONResponse({"workouts": items, "context": ctx, "account": bool(key)})

    async def workout_create(request: Request):
        body = await request.json()
        with closing(conn()) as c:
            pid = _single_person(c, request)
            try:
                tid = planner.save(c, pid, body)
            except planner.PlanError as exc:
                _plan_error(exc)
        return JSONResponse({"id": tid})

    async def workout_update(request: Request):
        body = await request.json()
        with closing(conn()) as c:
            pid = _single_person(c, request)
            try:
                planner.save(c, pid, body, template_id=request.path_params["id"])
            except planner.PlanError as exc:
                _plan_error(exc)
        return JSONResponse({"id": request.path_params["id"]})

    async def workout_delete(request: Request):
        with closing(conn()) as c:
            c.execute("DELETE FROM workout_templates WHERE id = ?", (request.path_params["id"],))
        return JSONResponse({"deleted": True})

    async def workouts_order(request: Request):
        body = await request.json()
        with closing(conn()) as c:
            pid = _single_person(c, request)
            for k, tid in enumerate(body.get("ids") or []):
                c.execute(
                    "UPDATE workout_templates SET position = ? WHERE id = ? AND person_id = ?",
                    (k, int(tid), pid),
                )
        return JSONResponse({"ok": True})

    async def workout_estimate(request: Request):
        """Estimate of a workout being edited (the creator's chart and summary)."""
        body = await request.json()
        with closing(conn()) as c:
            pid = _single_person(c, request)
            ctx = planner.context(c, pid)
        if not body.get("steps"):
            return JSONResponse({"estimate": None})
        try:
            w = planner.clean({**body, "name": body.get("name") or "-"})
        except planner.PlanError as exc:
            return JSONResponse({"estimate": None, "error": str(exc)})
        return JSONResponse({"estimate": planner.estimate(w, ctx)})

    async def planned_create(request: Request):
        body = await request.json()
        day = _day_or_400(body)
        with closing(conn()) as c:
            pid = _single_person(c, request)
            try:
                plan_id = icu.place(c, pid, int(body.get("workout_id") or 0), day)
            except planner.PlanError as exc:
                _plan_error(exc)
        plan_wake.set()
        return JSONResponse({"id": plan_id})

    async def planned_move(request: Request):
        day = _day_or_400(await request.json())
        with closing(conn()) as c:
            try:
                icu.move(c, request.path_params["id"], day)
            except planner.PlanError as exc:
                _plan_error(exc)
        plan_wake.set()
        return JSONResponse({"ok": True})

    async def planned_update(request: Request):
        body = await request.json()
        with closing(conn()) as c:
            try:
                icu.update(c, request.path_params["id"], body)
            except planner.PlanError as exc:
                _plan_error(exc)
        plan_wake.set()
        return JSONResponse({"ok": True})

    async def planned_delete(request: Request):
        with closing(conn()) as c:
            icu.remove(c, request.path_params["id"])
        plan_wake.set()
        return JSONResponse({"deleted": True})

    async def icu_accounts(request: Request):
        with closing(conn()) as c:
            return JSONResponse({"accounts": icu.accounts(c)})

    async def icu_account_set(request: Request):
        pid = request.path_params["id"]
        body = await request.json()
        key = str(body.get("api_key") or "").strip()
        if len(key) < 10 or re.search(r"\s", key):
            raise HTTPException(400, "this does not look like an intervals.icu API key")
        with closing(conn()) as c:
            _person_or_400(c, pid)
            icu.set_account(c, pid, key)
        return await icu_account_test(request)

    async def icu_account_test(request: Request):
        pid = request.path_params["id"]

        def run() -> dict:
            with closing(conn()) as c:
                result = icu.test_account(c, pid)
                result["account"] = icu.accounts(c).get(pid)
                return result

        result = await run_in_threadpool(run)
        plan_wake.set()
        return JSONResponse(result)

    async def icu_account_delete(request: Request):
        with closing(conn()) as c:
            c.execute("DELETE FROM icu_accounts WHERE person_id = ?", (request.path_params["id"],))
        return JSONResponse({"deleted": True})

    # Files from intervals.icu prepared for download (icufiles.py).
    files_wake = asyncio.Event()

    async def icu_files(request: Request):
        with closing(conn()) as c:
            persons = icufiles.state(c)
        nxt = icufiles.next_check(datetime.now().astimezone())
        return JSONResponse({"persons": persons, "next_check": nxt.isoformat(timespec="minutes")})

    async def icu_files_set(request: Request):
        pid = request.path_params["id"]
        body = await request.json()
        with closing(conn()) as c:
            if not c.execute("SELECT 1 FROM icu_accounts WHERE person_id = ?", (pid,)).fetchone():
                raise HTTPException(
                    400, "add the intervals.icu API key first (Settings › Workouts)"
                )
            icufiles.set_on(c, pid, bool(body.get("on")))
        if body.get("on"):
            files_wake.set()  # a first look at once
        return JSONResponse({"on": bool(body.get("on"))})

    async def icu_file_download(request: Request):
        pid, aid = request.path_params["id"], request.path_params["aid"]
        with closing(conn()) as c:
            taken = icufiles.take(c, pid, aid)
        if not taken:
            raise HTTPException(404, "this file is no longer waiting")
        path, name = taken

        def done():
            with closing(conn()) as c:
                icufiles.after_download(c, pid, aid, path)

        return FileResponse(path, media_type="application/octet-stream", filename=name,
                            background=BackgroundTask(run_in_threadpool, done))  # fmt: skip

    def _person_or_400(c: sqlite3.Connection, pid: str) -> None:
        if (
            pid == importer.UNASSIGNED
            or not c.execute("SELECT 1 FROM persons WHERE id = ?", (pid,)).fetchone()
        ):
            raise HTTPException(400, "choose a person")

    async def garmin_accounts(request: Request):
        with closing(conn()) as c:
            return JSONResponse(
                {
                    "accounts": garmin.accounts(c),
                    "estimate": garmin.history_estimate(c, scheduler.interval_min(c)),
                }
            )

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
                finally:
                    garmin.update_ha_notifications(c)

        result = await run_in_threadpool(run)
        with closing(conn()) as c:
            result["account"] = garmin.accounts(c).get(pid)
        return JSONResponse(result)

    async def garmin_account_delete(request: Request):
        pid = request.path_params["id"]
        with closing(conn()) as c:
            c.execute("DELETE FROM garmin_accounts WHERE person_id = ?", (pid,))

        def notify() -> None:
            with closing(conn()) as c:
                garmin.update_ha_notifications(c)

        await run_in_threadpool(notify)
        sched.settings_changed()
        return JSONResponse({"deleted": True})

    async def garmin_alerts(request: Request):
        """Keys refused for a while: the banner on every page."""
        with closing(conn()) as c:
            return JSONResponse({"keys": garmin.key_alerts(c)})

    # ---- export / restore --------------------------------------------------------------

    def _job_progress(kind: str) -> dict:
        p = backup.read_progress(db_path, kind)
        if p.get("state") == "running" and job.running_kind() != kind:
            p["state"] = "running?"  # started outside this server, or the process died
        return p

    def _start_job(kind: str, start) -> bool:
        """Mark `kind` running, then start its process: a quick job may finish (and write
        'finished') before this request returns, so the mark must come first. The previous
        progress comes back when the job could not start."""
        before = backup.read_progress(db_path, kind)
        backup.write_progress(db_path, kind, state="running", phase="start",
                              started_at=backup.now_iso())  # fmt: skip
        if start():
            return True
        backup.write_progress(db_path, kind, **before)
        return False

    async def backup_status(request: Request):
        def collect():
            return {
                "running": job.running_kind(),
                "export": _job_progress("export"),
                "restore": _job_progress("restore"),
                "exports": backup.list_exports(db_path),
                "exports_dir": str(backup.exports_dir(db_path)),
                "empty": backup.is_empty_install(db_path),
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
        secrets = bool(body.get("secrets"))
        if not _start_job(
            "export", lambda: job.start_export(include_files=files, include_secrets=secrets)
        ):
            return JSONResponse({"started": False, "reason": "another job is running"}, 409)
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
        if not _start_job("restore", lambda: job.start_restore(archive, delete_archive=uploaded)):
            if uploaded:
                archive.unlink(missing_ok=True)
            raise HTTPException(409, "another job is running")
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
            where.append("x.status = ?")
            params.append(q["status"])
        if q.get("person"):
            where.append("x.person_id = ?")
            params.append(q["person"])
        for key, expr in FILE_TEXT_FILTERS.items():
            if q.get(key):
                where.append(f"{expr} LIKE ?")
                params.append(f"%{q[key]}%")
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        limit = _int(request, "limit", 100, 1, 1000)
        offset = _int(request, "offset", 0, 0, 10**9)
        order = _order(q, FILE_SORTS, "processed", "x.id")
        with closing(conn()) as c:
            total = c.execute(
                f"SELECT COUNT(*) FROM ({IMPORT_ITEMS_SQL}) x {clause}", params
            ).fetchone()[0]
            rows = c.execute(
                f"""SELECT * FROM ({IMPORT_ITEMS_SQL}) x
                    {clause} ORDER BY {order}, x.day DESC LIMIT ? OFFSET ?""",
                [*params, limit, offset],
            ).fetchall()
        items = []
        for r in rows:
            item = {k: r[k] for k in r.keys() if k not in INTERNAL_ITEM_KEYS}
            if r["kind"] == "day":
                item["day_contents"] = garmin.day_contents(json.loads(r["summary"] or "{}"))
            items.append(item)
        return JSONResponse({"total": total, "items": items})

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
        Route("/api/update", update_get),
        Route("/api/update", update_install, methods=["POST"]),
        Route("/api/types", types),
        Route("/api/types/counts", type_counts),
        Route("/api/time-range", time_range),
        Route("/api/persons", persons),
        Route("/api/persons", person_create, methods=["POST"]),
        Route("/api/persons/order", persons_order, methods=["PUT"]),
        Route("/api/compare", compare),
        Route("/api/together", together_activities),
        Route("/api/together/{a:int}/{b:int}", together_pair),
        Route("/api/devices", devices),
        Route("/api/devices/{serial:int}", device_update, methods=["PATCH"]),
        Route("/api/settings", settings_get),
        Route("/api/settings", settings_update, methods=["PUT"]),
        Route("/api/ui-settings", ui_settings_get),
        Route("/api/device-image/{name}", device_image),
        Route("/api/ui-settings/{key}", ui_settings_put, methods=["PUT"]),
        Route("/api/uploads", upload, methods=["POST"]),
        Route("/api/uploads/part", upload_part, methods=["POST"]),
        Route("/api/persons/{id}", person_update, methods=["PATCH"]),
        Route("/api/activities", activities),
        Route("/api/activities/{id:int}", activity),
        Route("/api/activities/{id:int}", activity_update, methods=["PATCH"]),
        Route("/api/activities/{id:int}", activity_delete, methods=["DELETE"]),
        Route("/api/activities/{id:int}/streams", activity_streams),
        Route("/api/activities/{id:int}/records", activity_records),
        Route("/api/activities/{id:int}/surface", activity_surface),
        Route("/api/activities/{id:int}/intervals", activity_intervals),
        Route("/api/activities/{id:int}/weather", activity_weather),
        Route("/api/activities/{id:int}/track", activity_track),
        Route("/api/activities/{id:int}/export", activity_export),
        Route("/api/activities/{id:int}/earlier-tracks", activity_earlier_tracks),
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
        Route("/api/thresholds/{id}/accept", thresholds_accept, methods=["PUT"]),
        Route("/api/thresholds/{id}/{valid_from}", thresholds_delete, methods=["DELETE"]),
        Route("/api/fitness", fitness),
        Route("/api/calendar", calendar),
        Route("/api/wellbeing/movement", wellbeing_movement),
        Route("/api/wellbeing/body", wellbeing_body),
        Route("/api/forecast", forecast),
        Route("/api/stats/totals", stats_totals),
        Route("/api/stats/activities", stats_activities),
        Route("/api/suggest", suggest_next),
        Route("/api/stats/records", stats_records),
        Route("/api/ha/records", ha_records),
        Route("/api/ha/setup", ha_setup),
        Route("/api/ha/cards", ha_cards_list),
        Route("/api/ha/cards", ha_cards_create, methods=["POST"]),
        Route("/api/ha/cards/{card}", ha_card_get),
        Route("/api/ha/cards/{card}", ha_card_put, methods=["PUT"]),
        Route("/api/ha/cards/{card}", ha_card_delete, methods=["DELETE"]),
        Route("/api/workouts", workouts_list),
        Route("/api/workouts", workout_create, methods=["POST"]),
        Route("/api/workouts/order", workouts_order, methods=["PUT"]),
        Route("/api/workouts/estimate", workout_estimate, methods=["POST"]),
        Route("/api/workouts/{id:int}", workout_update, methods=["PUT"]),
        Route("/api/workouts/{id:int}", workout_delete, methods=["DELETE"]),
        Route("/api/planned", planned_create, methods=["POST"]),
        Route("/api/planned/{id:int}", planned_move, methods=["PATCH"]),
        Route("/api/planned/{id:int}", planned_update, methods=["PUT"]),
        Route("/api/planned/{id:int}", planned_delete, methods=["DELETE"]),
        Route("/api/icu", icu_accounts),
        Route("/api/icu/{id}", icu_account_set, methods=["PUT"]),
        Route("/api/icu/{id}", icu_account_delete, methods=["DELETE"]),
        Route("/api/icu/{id}/test", icu_account_test, methods=["POST"]),
        Route("/api/icu-files", icu_files),
        Route("/api/icu-files/{id}", icu_files_set, methods=["PUT"]),
        Route("/api/icu-files/{id}/{aid}", icu_file_download),
        Route("/api/garmin", garmin_accounts),
        Route("/api/garmin/alerts", garmin_alerts),
        Route("/api/garmin/{id}", garmin_account_set, methods=["PUT"]),
        Route("/api/garmin/{id}", garmin_account_delete, methods=["DELETE"]),
        Route("/api/garmin/{id}/test", garmin_account_test, methods=["POST"]),
        Route("/api/backup", backup_status),
        Route("/api/export", export_start, methods=["POST"]),
        Route("/api/export/{name}", export_download),
        Route("/api/export/{name}", export_delete, methods=["DELETE"]),
        Route("/api/restore", restore_start, methods=["POST"]),
        Route("/api/import/status", import_status),
        Route("/api/log", app_log),
        Route("/api/import/scan", import_scan, methods=["POST"]),
        Route("/api/import/files", import_files),
        Route("/api/import/files/{id:int}", import_file_forget, methods=["DELETE"]),
        Route("/api/import/files/{id:int}/dismiss", import_file_dismiss, methods=["POST"]),
        Route("/api/import/files/{id:int}/retry", import_file_retry, methods=["POST"]),
        Route("/", app_index),
        Route("/index.html", app_index),
        Mount("/", _RevalidatedStatic(directory=STATIC_DIR, html=True), name="static"),
    ]

    # Road surface for all activities in the background (setting surface_mode = "background"),
    # newest first, in batches (surface.BATCH activities surface.STEP_S apart, then a pause);
    # the end of an import starts a batch at once, so new activities get theirs right away. A
    # refusing server is left alone for its cooldown (surface.cooldown_left).
    surface_wake = asyncio.Event()

    async def surface_loop():
        in_batch, importing = 0, False
        while True:
            wait = 3600.0
            left = surface.cooldown_left()
            if left:
                wait = left
            else:
                with closing(conn()) as c:
                    on = (db.get_setting(c, "surface_mode") or "background") == "background"
                    aid = surface.next_missing(c) if on else None
                if aid is None:
                    in_batch = 0
                else:

                    def work(aid=aid):
                        with closing(conn()) as c2:
                            surface.compute(c2, aid)

                    try:
                        await run_in_threadpool(work)
                        in_batch += 1
                    except OSError:  # logged by surface.compute, cooldown set
                        in_batch = 0
                    except Exception:  # noqa: BLE001 - keep the loop alive
                        log.exception("Road surface of activity %s failed", aid)
                        in_batch = 0
                    left = surface.cooldown_left()
                    if left:
                        wait = left
                    elif in_batch >= surface.BATCH:
                        in_batch, wait = 0, surface.BATCH_PAUSE_S
                    else:
                        wait = surface.STEP_S
            # an import running: look every 30 s, its end starts the next batch at once
            if job.running():
                importing, wait = True, min(wait, 30.0)
            elif importing:
                importing = False
                if not surface.cooldown_left():
                    in_batch, wait = 0, 0.0
            try:
                await asyncio.wait_for(surface_wake.wait(), wait)
                surface_wake.clear()
            except TimeoutError:
                pass

    # Weather for every activity outdoors in the background, newest first, in batches
    # (weather.BATCH activities weather.STEP_S apart, then a pause); a failing server is left
    # alone for its cooldown (weather.cooldown_left). Nothing left: one look an hour (an import
    # brings new ones).
    async def weather_loop():
        in_batch = 0
        while True:
            wait = 3600.0
            left = weather.cooldown_left()
            if left:
                wait = left
            else:
                with closing(conn()) as c:
                    aid = weather.next_missing(c)
                if aid is None:
                    in_batch = 0
                    if job.running():
                        wait = 60.0
                else:

                    def work(aid=aid):
                        with closing(conn()) as c2:
                            weather.compute(c2, aid)

                    try:
                        await run_in_threadpool(work)
                        in_batch += 1
                    except OSError:  # logged by weather.compute, cooldown set
                        in_batch = 0
                    except Exception:  # noqa: BLE001 - keep the loop alive
                        log.exception("Weather of activity %s failed", aid)
                        with closing(conn()) as c3:  # not this one again in a loop
                            none = {"version": weather.WEATHER_VERSION, "points": 0}
                            c3.execute(
                                "UPDATE activities SET weather = ? WHERE id = ?",
                                (json.dumps(none), aid),
                            )
                            c3.commit()
                        in_batch = 0
                    left = weather.cooldown_left()
                    if left:
                        wait = left
                    elif in_batch >= weather.BATCH:
                        in_batch, wait = 0, weather.BATCH_PAUSE_S
                    else:
                        wait = weather.STEP_S
            await asyncio.sleep(wait)

    # Planned workouts to intervals.icu: sleeps until the next send is due (or a change wakes
    # it); nothing to send = one look an hour.
    async def plan_loop():
        while True:
            with closing(conn()) as c:
                due = icu.next_due(c)
            wait = 3600.0
            if due:
                at = datetime.strptime(due, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
                wait = max(0.0, min(wait, (at - datetime.now(UTC)).total_seconds()))
                if wait == 0.0:

                    def work():
                        with closing(conn()) as c2:
                            icu.sync_due(c2)

                    try:
                        await run_in_threadpool(work)
                    except Exception:  # noqa: BLE001 - keep the loop alive, try again later
                        log.exception("Sending planned workouts to intervals.icu failed")
                        await asyncio.sleep(icu.RETRY_S)
                    continue
            try:
                await asyncio.wait_for(plan_wake.wait(), wait + 1)
                plan_wake.clear()
            except TimeoutError:
                pass

    # Files from intervals.icu: a look on the timetable (icufiles.CHECK_SLOTS, local time) or at
    # once when switched on.
    async def files_loop():
        while True:
            now = datetime.now().astimezone()
            wait = (icufiles.next_check(now) - now).total_seconds()
            try:
                await asyncio.wait_for(files_wake.wait(), wait)
                files_wake.clear()
            except TimeoutError:
                pass

            def work():
                with closing(conn()) as c:
                    icufiles.check_all(c, icu_files_dir)

            try:
                await run_in_threadpool(work)
            except Exception:  # noqa: BLE001 - keep the loop alive
                log.exception("Files from intervals.icu failed")

    # Record events Home Assistant did not get (it was restarting or away) are sent again, and
    # the sensor is put back (state 0) when HA lost it: a pushed state does not survive an HA
    # restart, and before the first record there would be no entity at all.
    async def ha_records_loop():
        while True:

            def work():
                with closing(conn()) as c:
                    if records.unpushed(c):
                        records.publish(c)
                    records.ensure_sensor()

            try:
                await run_in_threadpool(work)
            except Exception:  # noqa: BLE001 - keep the loop alive
                log.exception("Records for Home Assistant failed")
            await asyncio.sleep(HA_RECORDS_RETRY_S)

    @asynccontextmanager
    async def lifespan(app):
        sched.start()
        surface_task = asyncio.create_task(surface_loop(), name="trailbook-surface")
        weather_task = asyncio.create_task(weather_loop(), name="trailbook-weather")
        plan_task = asyncio.create_task(plan_loop(), name="trailbook-plans")
        files_task = asyncio.create_task(files_loop(), name="trailbook-icu-files")
        ha_task = (
            asyncio.create_task(ha_records_loop(), name="trailbook-ha-records")
            if homeassistant.available()
            else None
        )
        if homeassistant.available():  # the dashboard card: file and resource up to date
            asyncio.create_task(run_in_threadpool(hacards.install), name="trailbook-ha-card")
        yield
        surface_task.cancel()
        weather_task.cancel()
        plan_task.cancel()
        files_task.cancel()
        if ha_task:
            ha_task.cancel()
        await sched.stop()

    middleware = [Middleware(GZipMiddleware, minimum_size=1024)]
    # Own login only outside Home Assistant (TRAILBOOK_PASSWORD); in the add-on Ingress logs in.
    if pw := auth.password():
        data_dir = Path(db_path).resolve().parent
        middleware.insert(0, Middleware(auth.PasswordMiddleware, pw=pw, data_dir=data_dir))
    app = Starlette(
        routes=routes,
        exception_handlers={HTTPException: http_error},
        lifespan=lifespan,
        middleware=middleware,
    )
    app.state.import_job = job
    app.state.scheduler = sched
    return app
