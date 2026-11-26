"""Activities two people did together (SPEC §10a, Manual › Together).

Two activities are compared when their recordings overlap in time (give or take TIME_SLACK_S)
and their boxes meet. Each route is sampled every STEP_M metres with the clock time of every
point. A point of one route is "together" when the other person was within the radius of it,
at most TIME_SLACK_S earlier or later, going the same way (so two people who pass each other
are not together). Short gaps and short stretches (under MIN_RUN_M) are evened out. The pair
counts as shared when the stretches together cover the chosen share of the shorter route.

Pure Python. Results are cached in the database (`together_cache`) and worked out again when
one of the two recordings, or the way of comparing (VERSION), changes.
"""

from __future__ import annotations

import json
import logging
import math
import sqlite3
from bisect import bisect_left
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import UTC, datetime

from . import geo, segments, streams

log = logging.getLogger(__name__)

VERSION = 1  # raise it when the comparison changes: cached results are worked out again
TIME_SLACK_S = 300  # how far apart in time two people may pass a point and still be together
STEP_M = 20.0  # the routes are compared point by point at this spacing
MIN_RUN_M = 100.0  # shorter stretches together, and shorter gaps in one, are evened out
BREAK_M = 500.0  # a jump this long between two samples is no route (lost signal, a lift)
HEADING_POINTS = 2  # the direction at a point: from this many points before to as many after
LINE_SIMPLIFY_M = 4.0
BOX_MARGIN_DEG = 0.002  # ~200 m: routes whose boxes are further apart cannot meet

# Options of the Together view (share of the shorter route in %, radius in metres).
DEFAULT_SHARE = 10
DEFAULT_RADIUS_M = 50
MIN_SHARE, MAX_SHARE = 1, 100
MIN_RADIUS_M, MAX_RADIUS_M = 10, 200

# What changes when an activity's route or recording changes.
_SIGNATURE = ("start_time_utc", "elapsed_s", "distance_m", "importer_version", "fixes")
_COLUMNS = (
    "id",
    "person_id",
    "time_s",
    "bbox_min_lat",
    "bbox_max_lat",
    "bbox_min_lon",
    "bbox_max_lon",
    *_SIGNATURE,
)


@dataclass
class Route:
    """An activity's route sampled every STEP_M. `link[i]`: point i continues point i - 1."""

    lat: list[float]
    lon: list[float]
    t: list[float]  # clock time, seconds since 1970
    link: list[bool]
    first_t: float  # the recording's first and last sample (clock time)
    last_t: float

    def __len__(self) -> int:
        return len(self.t)


@dataclass
class Shared:
    """Two activities compared. Times are clock times (seconds since 1970)."""

    share: float  # 0..1 of the shorter route
    together_m: float
    together_s: float
    meet_t: float  # the first moment both are on a shared stretch
    first_t: float  # the first and last sample of either recording
    last_t: float
    offset_a: float  # start of each activity
    offset_b: float
    runs_a: list[tuple[float, float]]  # the stretches together as (from, to) times
    runs_b: list[tuple[float, float]]
    line_a: str  # encoded polylines; B follows A's line where they are together
    line_b: str


def epoch(iso: str) -> float:
    return datetime.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=UTC).timestamp()


def route(time: list, lat: list, lon: list, start: float, step: float = STEP_M) -> Route | None:
    """Sample the track every `step` metres; `time` in seconds from `start`."""
    known = [t for t in time if t is not None]
    samples = [
        (start + t, la, lo)
        for t, la, lo in zip(time, lat, lon, strict=False)
        if t is not None and la is not None and lo is not None
    ]
    if len(samples) < 2 or not known:
        return None
    proj = segments.Projection(samples[0][1], samples[0][2])
    out = Route([], [], [], [], start + min(known), start + max(known))

    def add(sample, linked: bool) -> None:
        out.t.append(sample[0])
        out.lat.append(sample[1])
        out.lon.append(sample[2])
        out.link.append(linked)

    add(samples[0], False)
    travelled = 0.0  # since the last point
    prev, prev_xy = samples[0], proj.xy(*samples[0][1:])
    for cur in samples[1:]:
        xy = proj.xy(cur[1], cur[2])
        d = math.dist(prev_xy, xy)
        if d > BREAK_M:
            add(cur, False)
            travelled = 0.0
        else:
            done = 0.0  # metres of this edge already walked
            while travelled + d - done >= step:
                done += step - travelled
                f = done / d
                add(tuple(a + f * (b - a) for a, b in zip(prev, cur, strict=True)), True)
                travelled = 0.0
            travelled += d - done
        prev, prev_xy = cur, xy
    if travelled > step * 0.5:
        add(prev, True)
    return out if len(out) > 1 else None


def _headings(r: Route, xy: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out = []
    n = len(r)
    for i in range(n):
        lo = i
        while lo > 0 and i - lo < HEADING_POINTS and r.link[lo]:
            lo -= 1
        hi = i
        while hi + 1 < n and hi - i < HEADING_POINTS and r.link[hi + 1]:
            hi += 1
        out.append((xy[hi][0] - xy[lo][0], xy[hi][1] - xy[lo][1]))
    return out


def _matches(a, b, radius: float) -> list[int | None]:
    """For every point of `a` the nearest point of `b` it was together with, or None.
    `a` and `b` are (times, xy, headings)."""
    ta, pa, ha = a
    tb, pb, hb = b
    grid: dict[tuple[int, int], list[int]] = defaultdict(list)
    for j, (x, y) in enumerate(pb):
        grid[(int(x // radius), int(y // radius))].append(j)
    r2 = radius * radius
    out: list[int | None] = []
    for t, (x, y), (hx, hy) in zip(ta, pa, ha, strict=True):
        cx, cy = int(x // radius), int(y // radius)
        best, best_d2 = None, r2
        for gx in (cx - 1, cx, cx + 1):
            for gy in (cy - 1, cy, cy + 1):
                for j in grid.get((gx, gy), ()):
                    if abs(tb[j] - t) > TIME_SLACK_S:
                        continue
                    d2 = (pb[j][0] - x) ** 2 + (pb[j][1] - y) ** 2
                    if d2 <= best_d2 and hx * hb[j][0] + hy * hb[j][1] > 0:
                        best, best_d2 = j, d2
        out.append(best)
    return out


def _runs(flags: list[bool], link: list[bool]) -> list[tuple[int, int, bool]]:
    """(first, last, flag) of the stretches of equal flags; a break in the route ends one."""
    out = []
    start = 0
    for i in range(1, len(flags) + 1):
        if i == len(flags) or flags[i] != flags[start] or not link[i]:
            out.append((start, i - 1, flags[start]))
            start = i
    return out


def _smooth(flags: list[bool], link: list[bool], step: float = STEP_M) -> list[bool]:
    """Fill short gaps between stretches together, then drop short stretches."""
    short = max(1, round(MIN_RUN_M / step))
    out = list(flags)
    for i0, i1, flag in _runs(out, link):
        inner = i0 > 0 and i1 + 1 < len(out) and link[i0] and link[i1 + 1]
        if not flag and inner and i1 - i0 + 1 < short:
            out[i0 : i1 + 1] = [True] * (i1 - i0 + 1)
    for i0, i1, flag in _runs(out, link):
        if flag and i1 - i0 < short:
            out[i0 : i1 + 1] = [False] * (i1 - i0 + 1)
    return out


def _length(xy, link: list[bool], flags: list[bool] | None = None) -> float:
    return sum(
        math.dist(xy[i - 1], xy[i])
        for i in range(1, len(xy))
        if link[i] and (flags is None or (flags[i - 1] and flags[i]))
    )


def _line(points: list[tuple[float, float]]) -> str:
    unique = [p for i, p in enumerate(points) if not i or p != points[i - 1]]
    return geo.encode_polyline(geo.simplify(unique, LINE_SIMPLIFY_M))


def compare(a: Route, b: Route, radius: float, start_a: float, start_b: float) -> Shared | None:
    """The stretches two routes were travelled together; None when there are none."""
    proj = segments.Projection(a.lat[0], a.lon[0])
    pa = [proj.xy(la, lo) for la, lo in zip(a.lat, a.lon, strict=True)]
    pb = [proj.xy(la, lo) for la, lo in zip(b.lat, b.lon, strict=True)]
    side_a = (a.t, pa, _headings(a, pa))
    side_b = (b.t, pb, _headings(b, pb))
    match_b = _matches(side_b, side_a, radius)
    if not any(j is not None for j in match_b):
        return None
    flags_a = _smooth([j is not None for j in _matches(side_a, side_b, radius)], a.link)
    flags_b = _smooth([j is not None for j in match_b], b.link)
    if not any(flags_a) or not any(flags_b):
        return None

    # the share and the distance are measured on the shorter route
    len_a, len_b = _length(pa, a.link), _length(pb, b.link)
    r, xy, flags, total = (a, pa, flags_a, len_a) if len_a <= len_b else (b, pb, flags_b, len_b)
    together = _length(xy, r.link, flags)
    if total <= 0 or together <= 0:
        return None

    def times(route_: Route, fl: list[bool]) -> list[tuple[float, float]]:
        return [(route_.t[i0], route_.t[i1]) for i0, i1, f in _runs(fl, route_.link) if f]

    runs_a, runs_b = times(a, flags_a), times(b, flags_b)
    # B's line takes A's points where they are together, so the two can be drawn side by side
    snapped: list[tuple[float, float]] = []
    last = None
    for i, (flag, j) in enumerate(zip(flags_b, match_b, strict=True)):
        if flag and j is not None:
            if last is not None and 0 < last - j <= 3:
                j = last  # no tiny steps back along A's line
            snapped.append((a.lat[j], a.lon[j]))
            last = j
        else:
            snapped.append((b.lat[i], b.lon[i]))
            if not flag:
                last = None

    return Shared(
        share=min(1.0, together / total),
        together_m=together,
        together_s=sum(t1 - t0 for t0, t1 in (runs_a if r is a else runs_b)),
        meet_t=max(runs_a[0][0], runs_b[0][0]),  # both are on a shared stretch
        first_t=min(a.first_t, b.first_t),
        last_t=max(a.last_t, b.last_t),
        offset_a=start_a,
        offset_b=start_b,
        runs_a=runs_a,
        runs_b=runs_b,
        line_a=_line(list(zip(a.lat, a.lon, strict=True))),
        line_b=_line(snapped),
    )


# ---- activities --------------------------------------------------------------------------


def _signature(row: sqlite3.Row) -> tuple:
    return tuple(row[k] for k in _SIGNATURE)


def _activities(conn: sqlite3.Connection, where: str, params: list) -> list[sqlite3.Row]:
    return conn.execute(
        f"""SELECT {", ".join(_COLUMNS)} FROM activities
            WHERE has_gps = 1 AND {where} ORDER BY start_time_utc, id""",
        params,
    ).fetchall()


def _load(conn: sqlite3.Connection, row: sqlite3.Row) -> Route | None:
    ch = {
        r["channel"]: streams.decode(r["encoding"], r["data"])
        for r in conn.execute(
            """SELECT channel, encoding, data FROM streams
               WHERE activity_id = ? AND channel IN ('time', 'lat', 'lon')""",
            (row["id"],),
        )
    }
    return route(
        ch.get("time") or [], ch.get("lat") or [], ch.get("lon") or [], epoch(row["start_time_utc"])
    )


def _boxes_meet(a: sqlite3.Row, b: sqlite3.Row) -> bool:
    if a["bbox_min_lat"] is None or b["bbox_min_lat"] is None:
        return False
    m = BOX_MARGIN_DEG
    # degrees of longitude are shorter than of latitude: twice the margin is enough up to 60°
    return (
        a["bbox_min_lat"] - m <= b["bbox_max_lat"]
        and b["bbox_min_lat"] - m <= a["bbox_max_lat"]
        and a["bbox_min_lon"] - 2 * m <= b["bbox_max_lon"]
        and b["bbox_min_lon"] - 2 * m <= a["bbox_max_lon"]
    )


def _end(row: sqlite3.Row, start: float) -> float:
    return start + (row["elapsed_s"] or row["time_s"] or 0)


def candidates(rows_a: list, rows_b: list) -> list[tuple[sqlite3.Row, sqlite3.Row]]:
    """Pairs recorded at the same time near each other; both lists sorted by start."""
    starts = [epoch(r["start_time_utc"]) for r in rows_b]
    longest = max((_end(r, s) - s for r, s in zip(rows_b, starts, strict=True)), default=0)
    out = []
    for a in rows_a:
        sa = epoch(a["start_time_utc"])
        ea = _end(a, sa)
        k = bisect_left(starts, sa - longest - TIME_SLACK_S)
        while k < len(rows_b) and starts[k] <= ea + TIME_SLACK_S:
            b = rows_b[k]
            if _end(b, starts[k]) + TIME_SLACK_S >= sa and _boxes_meet(a, b):
                out.append((a, b))
            k += 1
    return out


def _signature_text(a: sqlite3.Row, b: sqlite3.Row) -> str:
    return json.dumps([VERSION, _signature(a), _signature(b)], separators=(",", ":"))


def _compare_rows(conn, pairs: list, radius: int) -> list[tuple[int, int, Shared]]:
    """Compare the candidate pairs, from the cache where both recordings are unchanged."""
    out = []
    fresh = []  # rows to store
    routes: dict[int, Route | None] = {}
    left: dict[int, int] = defaultdict(int)  # a route is dropped after its last pair
    for a, b in pairs:
        left[a["id"]] += 1
        left[b["id"]] += 1
    for a, b in pairs:
        sig = _signature_text(a, b)
        hit = conn.execute(
            """SELECT signature, result FROM together_cache
               WHERE a_id = ? AND b_id = ? AND radius_m = ?""",
            (a["id"], b["id"], radius),
        ).fetchone()
        if hit and hit["signature"] == sig:
            result = Shared(**json.loads(hit["result"])) if hit["result"] else None
        else:
            for row in (a, b):
                if row["id"] not in routes:
                    routes[row["id"]] = _load(conn, row)
            ra, rb = routes[a["id"]], routes[b["id"]]
            result = None
            if ra and rb:
                result = compare(
                    ra, rb, radius, epoch(a["start_time_utc"]), epoch(b["start_time_utc"])
                )
            text = json.dumps(asdict(result), separators=(",", ":")) if result else None
            fresh.append((a["id"], b["id"], radius, sig, text))
        if result:
            out.append((a["id"], b["id"], result))
        for row in (a, b):
            left[row["id"]] -= 1
            if not left[row["id"]]:
                routes.pop(row["id"], None)
    _store(conn, fresh)
    return out


def _store(conn: sqlite3.Connection, rows: list[tuple]) -> None:
    """Keep the results; a busy or changed database only costs working them out again."""
    if not rows:
        return
    try:
        conn.execute("BEGIN")
        conn.executemany(
            """INSERT OR REPLACE INTO together_cache (a_id, b_id, radius_m, signature, result)
               VALUES (?, ?, ?, ?, ?)""",
            rows,
        )
        conn.execute("COMMIT")
    except sqlite3.Error:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        log.warning("could not store %d compared activities", len(rows), exc_info=True)


def find(
    conn: sqlite3.Connection, person_a: str, person_b: str, radius: int
) -> list[tuple[int, int, Shared]]:
    """(activity of A, activity of B, result) of every pair that met, oldest first."""
    pairs = candidates(
        _activities(conn, "person_id = ?", [person_a]),
        _activities(conn, "person_id = ?", [person_b]),
    )
    return _compare_rows(conn, pairs, radius)


def pair(conn: sqlite3.Connection, activity_a: int, activity_b: int, radius: int) -> Shared | None:
    """Two activities of different people compared; None when they never met."""
    rows = {r["id"]: r for r in _activities(conn, "id IN (?, ?)", [activity_a, activity_b])}
    a, b = rows.get(activity_a), rows.get(activity_b)
    if not a or not b or a["person_id"] == b["person_id"] or not candidates([a], [b]):
        return None
    found = _compare_rows(conn, [(a, b)], radius)
    return found[0][2] if found else None
