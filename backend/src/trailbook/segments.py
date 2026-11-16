"""Segments: pieces of route matched against every activity (SPEC §11a).

A segment is a slice of one recorded activity (chosen in the UI directly, or found by
snapping map pins to the user's own tracks). Matching runs in the importer process after
analysis: a new or changed segment is matched against all activities, a new or reimported
activity against all segments. `segments.match_version` / `activities.segments_version`
below MATCH_VERSION mean "to do".

Matching an activity (pure Python, a few ms per candidate on the CM4):
  * checkpoints every CHECK_SPACING_M along the segment;
  * an effort starts where the track crosses the start (within START_RADIUS_M), measured
    along the segment direction, so waiting before the start is not counted;
  * it must pass every checkpoint in order within TRACK_RADIUS_M (distance to the track
    edge, so sparse GPS works), with at most MAX_GAP_TRAVEL_M of track between two
    checkpoints (detours and the opposite direction fail);
  * it ends at the first crossing of the end; the travelled distance must be close to the
    segment length. Several efforts per activity are possible (laps).
  * a flat segment (end at most TWO_WAY_MAX_CLIMB_M and TWO_WAY_MAX_GRADE of the length above
    or below the start) also counts in the opposite direction: it is matched a second time
    reversed and those efforts are marked `reverse`.
"""

from __future__ import annotations

import math
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta

from . import geo, streams

MATCH_VERSION = 2  # 2: max speed, both directions on flat segments

CHECK_SPACING_M = 25.0
START_RADIUS_M = 25.0
TRACK_RADIUS_M = 30.0
MAX_GAP_TRAVEL_M = 200.0
LENGTH_MIN_RATIO = 0.8
LENGTH_MAX_RATIO = 1.3
LENGTH_SLACK_M = 100.0
MIN_SEGMENT_M = 100.0
SIMPLIFY_M = 2.0
PIN_RADIUS_M = 50.0
BBOX_MARGIN_DEG = 0.0005  # ~50 m
MOVING_MIN_SPEED = 0.3  # m/s
MOVING_MAX_DT = 10.0  # s, longer gaps are pauses
TWO_WAY_MAX_CLIMB_M = 30.0  # end vs start altitude...
TWO_WAY_MAX_GRADE = 0.03  # ...and at most 3 % of the length (short steep ramps stay one way)

ProgressFn = Callable[[int, int], None]


class SegmentError(ValueError):
    """User-facing problem with a segment request."""


# ---- geometry ----------------------------------------------------------------------------


class Projection:
    """Local equirectangular projection in metres, accurate enough for one region."""

    def __init__(self, lat0: float, lon0: float):
        self.lat0, self.lon0 = lat0, lon0
        self.kx = math.cos(math.radians(lat0)) * math.pi / 180.0 * geo.EARTH_RADIUS_M
        self.ky = math.pi / 180.0 * geo.EARTH_RADIUS_M

    def xy(self, lat: float, lon: float) -> tuple[float, float]:
        return (lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky


def _edge_d2(px, py, ax, ay, bx, by) -> float:
    dx, dy = bx - ax, by - ay
    seg2 = dx * dx + dy * dy
    if seg2 == 0:
        return (px - ax) ** 2 + (py - ay) ** 2
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
    cx, cy = ax + t * dx, ay + t * dy
    return (px - cx) ** 2 + (py - cy) ** 2


def path_length(points: list[tuple[float, float]]) -> float:
    if len(points) < 2:
        return 0.0
    proj = Projection(*points[0])
    xy = [proj.xy(lat, lon) for lat, lon in points]
    return sum(math.dist(xy[i], xy[i + 1]) for i in range(len(xy) - 1))


def checkpoints(xy: list[tuple[float, float]], spacing: float = CHECK_SPACING_M) -> list:
    """Points every `spacing` metres along the line, including both ends."""
    out = [xy[0]]
    acc, next_at = 0.0, spacing
    for i in range(len(xy) - 1):
        (ax, ay), (bx, by) = xy[i], xy[i + 1]
        seg = math.hypot(bx - ax, by - ay)
        while seg > 0 and next_at < acc + seg:
            f = (next_at - acc) / seg
            out.append((ax + f * (bx - ax), ay + f * (by - ay)))
            next_at += spacing
        acc += seg
    if len(out) > 1 and math.dist(out[-1], xy[-1]) < spacing * 0.3:
        out[-1] = xy[-1]  # no tiny last step
    else:
        out.append(xy[-1])
    return out


def _unit(ax, ay, bx, by) -> tuple[float, float]:
    d = math.hypot(bx - ax, by - ay) or 1.0
    return (bx - ax) / d, (by - ay) / d


@dataclass
class Prepared:
    """A segment ready for matching (in its own projection)."""

    id: int
    proj: Projection
    cps: list[tuple[float, float]]
    length: float
    u_start: tuple[float, float]
    u_end: tuple[float, float]
    reverse: bool = False


def prepare(segment_id: int, points: list[tuple[float, float]], reverse: bool = False) -> Prepared:
    if reverse:
        points = list(reversed(points))
    proj = Projection(*points[0])
    xy = [proj.xy(lat, lon) for lat, lon in points]
    cps = checkpoints(xy)
    length = sum(math.dist(xy[i], xy[i + 1]) for i in range(len(xy) - 1))
    # Directions from the ends to the checkpoint next to them.
    u_start = _unit(*cps[0], *cps[1]) if len(cps) > 1 else (1.0, 0.0)
    u_end = _unit(*cps[-2], *cps[-1]) if len(cps) > 1 else (1.0, 0.0)
    return Prepared(segment_id, proj, cps, length, u_start, u_end, reverse)


def two_way(s) -> bool:
    """Flat enough to count in both directions (the end not much higher or lower)."""
    net = s["net_climb_m"]
    limit = min(TWO_WAY_MAX_CLIMB_M, TWO_WAY_MAX_GRADE * s["distance_m"])
    return net is not None and abs(net) <= limit


def prepared(s: sqlite3.Row) -> list[Prepared]:
    """The segment as matched: its own direction, and reversed when it is flat."""
    pts = _points(s)
    back = [prepare(s["id"], pts, reverse=True)] if two_way(s) else []
    return [prepare(s["id"], pts), *back]


# ---- matching ----------------------------------------------------------------------------


@dataclass
class Match:
    start_pos: float  # fractional index into the (filtered) track samples
    end_pos: float
    start_t: float
    end_t: float


class Track:
    """Activity samples with time and position, projected for one segment."""

    def __init__(self, time: list, lat: list, lon: list, proj: Projection):
        self.idx: list[int] = []  # index into the original streams
        self.t: list[float] = []
        self.x: list[float] = []
        self.y: list[float] = []
        for i, (t, la, lo) in enumerate(zip(time, lat, lon, strict=False)):
            if t is None or la is None or lo is None:
                continue
            x, y = proj.xy(la, lo)
            self.idx.append(i)
            self.t.append(t)
            self.x.append(x)
            self.y.append(y)
        n = len(self.t)
        self.step = [math.hypot(self.x[i + 1] - self.x[i], self.y[i + 1] - self.y[i])
                     for i in range(n - 1)]  # fmt: skip

    def __len__(self) -> int:
        return len(self.t)

    def time_at(self, pos: float) -> float:
        i = int(pos)
        f = pos - i
        if f <= 0 or i + 1 >= len(self.t):
            return self.t[min(i, len(self.t) - 1)]
        return self.t[i] + f * (self.t[i + 1] - self.t[i])

    def travelled(self, a: float, b: float) -> float:
        """Track length between two fractional positions."""
        ia, ib = int(a), int(b)
        if ia == ib:
            return self.step[ia] * (b - a) if ia < len(self.step) else 0.0
        total = self.step[ia] * (1 - (a - ia)) if ia < len(self.step) else 0.0
        total += sum(self.step[ia + 1 : ib])
        if ib < len(self.step):
            total += self.step[ib] * (b - ib)
        return total


def _crossing(tr: Track, lo: int, hi: int, p, u, radius: float, last: bool) -> float:
    """Fractional position where the track crosses the line through `p` perpendicular to
    `u`, within samples lo..hi (and the edges around them). Falls back to the closest
    sample when the track never crosses (e.g. the recording starts on the line)."""
    px, py = p
    r2 = radius * radius
    found = None
    for e in range(max(lo - 1, 0), min(hi + 1, len(tr) - 1)):
        pa = (tr.x[e] - px) * u[0] + (tr.y[e] - py) * u[1]
        pb = (tr.x[e + 1] - px) * u[0] + (tr.y[e + 1] - py) * u[1]
        if pa <= 0 < pb and _edge_d2(px, py, tr.x[e], tr.y[e], tr.x[e + 1], tr.y[e + 1]) <= r2:
            found = e + (-pa / (pb - pa))
            if not last:
                return found
    if found is not None:
        return found
    best, best_d = lo, math.inf
    for i in range(lo, hi + 1):
        d = (tr.x[i] - px) ** 2 + (tr.y[i] - py) ** 2
        if d < best_d:
            best, best_d = i, d
    return float(best)


def _near_run(tr: Track, start: int, p, radius: float, limit: float = math.inf):
    """First run of samples within `radius` of p from `start` on: (lo, hi) or None.
    Gives up after `limit` metres of track."""
    px, py = p
    r2 = radius * radius
    n = len(tr)
    i, travelled = start, 0.0
    while i < n and (tr.x[i] - px) ** 2 + (tr.y[i] - py) ** 2 > r2:
        if i < n - 1:
            travelled += tr.step[i]
        if travelled > limit:
            return None
        i += 1
    if i >= n:
        return None
    j = i
    while j + 1 < n and (tr.x[j + 1] - px) ** 2 + (tr.y[j + 1] - py) ** 2 <= r2:
        j += 1
    return i, j


def _follow(tr: Track, seg: Prepared, start_pos: float) -> float | None:
    """From an effort start, pass all checkpoints in order; returns the end position."""
    r2 = TRACK_RADIUS_M * TRACK_RADIUS_M
    n = len(tr)
    cur = int(start_pos)
    for cx, cy in seg.cps[1:-1]:
        j, travelled = cur, 0.0
        while True:
            if j >= n - 1:
                return None
            if _edge_d2(cx, cy, tr.x[j], tr.y[j], tr.x[j + 1], tr.y[j + 1]) <= r2:
                break
            travelled += tr.step[j]
            if travelled > MAX_GAP_TRAVEL_M:
                return None
            j += 1
        cur = j
    run = _near_run(tr, cur, seg.cps[-1], START_RADIUS_M, limit=MAX_GAP_TRAVEL_M)
    if run is None:
        return None
    end = _crossing(tr, run[0], run[1], seg.cps[-1], seg.u_end, START_RADIUS_M, last=False)
    return end if end > start_pos else None


def find_efforts(tr: Track, seg: Prepared) -> list[Match]:
    out: list[Match] = []
    if len(tr) < 2 or len(seg.cps) < 2:
        return out
    lo_len = seg.length * LENGTH_MIN_RATIO - 30
    hi_len = seg.length * LENGTH_MAX_RATIO + LENGTH_SLACK_M
    i = 0
    while i < len(tr) - 1:
        run = _near_run(tr, i, seg.cps[0], START_RADIUS_M)
        if run is None:
            break
        start = _crossing(tr, run[0], run[1], seg.cps[0], seg.u_start, START_RADIUS_M, last=True)
        end = _follow(tr, seg, start)
        if end is not None and lo_len <= tr.travelled(start, end) <= hi_len:
            out.append(Match(start, end, tr.time_at(start), tr.time_at(end)))
            i = int(end) + 1
        else:
            i = run[1] + 1
    return out


# ---- effort values -----------------------------------------------------------------------


def _mean(values: list) -> float | None:
    vals = [v for v in values if v is not None]
    return sum(vals) / len(vals) if vals else None


def effort_values(tr: Track, m: Match, seg_len: float, ch: dict[str, list]) -> dict:
    a, b = int(math.ceil(m.start_pos)), int(m.end_pos)
    lo, hi = tr.idx[a] if a < len(tr) else tr.idx[-1], tr.idx[min(b, len(tr) - 1)]
    elapsed = m.end_t - m.start_t
    moving = 0.0
    for k in range(int(m.start_pos), min(int(m.end_pos) + 1, len(tr) - 1)):
        dt = tr.t[k + 1] - tr.t[k]
        if 0 < dt <= MOVING_MAX_DT and tr.step[k] / dt >= MOVING_MIN_SPEED:
            moving += dt
    moving = min(moving, elapsed)

    def window(name: str) -> list:
        values = ch.get(name) or []
        return values[lo : hi + 1]

    hr = window("hr")
    hr_vals = [v for v in hr if v is not None]
    speed = [v for v in window("speed") if v is not None]
    return {
        "elapsed_s": round(elapsed, 1),
        "moving_s": round(moving, 1),
        "avg_speed": round(seg_len / elapsed, 3) if elapsed > 0 else None,
        "max_speed": round(max(speed), 3) if speed else None,
        "avg_hr": round(_mean(hr), 1) if hr_vals else None,
        "max_hr": max(hr_vals) if hr_vals else None,
        "avg_power": _round(_mean(window("power"))),
        "avg_cadence": _round(_mean(window("cadence"))),
    }


def _round(v: float | None) -> float | None:
    return round(v, 1) if v is not None else None


# ---- storage -----------------------------------------------------------------------------


def _points(row: sqlite3.Row) -> list[tuple[float, float]]:
    return geo.decode_polyline(row["polyline"])


def _channels(conn: sqlite3.Connection, activity_id: int, names: tuple[str, ...]) -> dict:
    marks = ",".join("?" for _ in names)
    return {
        r["channel"]: streams.decode(r["encoding"], r["data"])
        for r in conn.execute(
            f"""SELECT channel, encoding, data FROM streams
                WHERE activity_id = ? AND channel IN ({marks})""",
            (activity_id, *names),
        )
    }


def _start_iso(activity: sqlite3.Row, offset_s: float) -> str:
    t = datetime.strptime(activity["start_time_utc"][:19], "%Y-%m-%dT%H:%M:%S")
    return (t + timedelta(seconds=round(offset_s))).strftime("%Y-%m-%dT%H:%M:%SZ")


def _match_pair(conn, activity: sqlite3.Row, seg: Prepared, pos: dict) -> list[tuple]:
    """Efforts of one activity on one segment, as rows for segment_efforts."""
    tr = Track(pos.get("time") or [], pos.get("lat") or [], pos.get("lon") or [], seg.proj)
    matches = find_efforts(tr, seg)
    if not matches:
        return []
    extra = _channels(conn, activity["id"], ("hr", "power", "cadence", "speed"))
    rows = []
    for m in matches:
        v = effort_values(tr, m, seg.length, extra)
        rows.append((
            seg.id, activity["id"], _start_iso(activity, m.start_t), round(m.start_t, 1),
            round(m.end_t, 1), v["elapsed_s"], v["moving_s"], v["avg_speed"], v["avg_hr"],
            v["max_hr"], v["avg_power"], v["avg_cadence"], v["max_speed"], int(seg.reverse),
        ))  # fmt: skip
    return rows


_INSERT = """INSERT INTO segment_efforts (segment_id, activity_id, start_time_utc, start_s,
             end_s, elapsed_s, moving_s, avg_speed, avg_hr, max_hr, avg_power, avg_cadence,
             max_speed, reverse)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"""

_CANDIDATE_SQL = """
    a.has_gps = 1
    AND a.bbox_min_lat <= ? AND a.bbox_max_lat >= ? AND a.bbox_min_lon <= ? AND a.bbox_max_lon >= ?
    AND a.bbox_min_lat <= ? AND a.bbox_max_lat >= ? AND a.bbox_min_lon <= ? AND a.bbox_max_lon >= ?
"""


def _candidate_params(s: sqlite3.Row) -> list:
    m = BBOX_MARGIN_DEG
    return [
        s["start_lat"] + m, s["start_lat"] - m, s["start_lon"] + m, s["start_lon"] - m,
        s["end_lat"] + m, s["end_lat"] - m, s["end_lon"] + m, s["end_lon"] - m,
    ]  # fmt: skip


def _covers(a: sqlite3.Row, s: sqlite3.Row) -> bool:
    m = BBOX_MARGIN_DEG
    if a["bbox_min_lat"] is None:
        return False
    if s["category"] and s["category"] != a["category"]:
        return False
    return all(
        a["bbox_min_lat"] - m <= lat <= a["bbox_max_lat"] + m
        and a["bbox_min_lon"] - m <= lon <= a["bbox_max_lon"] + m
        for lat, lon in ((s["start_lat"], s["start_lon"]), (s["end_lat"], s["end_lon"]))
    )


def match_segment(conn: sqlite3.Connection, segment_id: int) -> int:
    """Match one segment against every activity already matched with the current version
    (the others are done by `match_activity`). Returns the number of efforts."""
    s = conn.execute("SELECT * FROM segments WHERE id = ?", (segment_id,)).fetchone()
    if s is None:
        return 0
    if s["net_climb_m"] is None and s["source_activity_id"]:  # segments made before v2
        net = source_net_climb(conn, s)
        if net is not None:
            conn.execute("UPDATE segments SET net_climb_m = ? WHERE id = ?", (net, segment_id))
            s = conn.execute("SELECT * FROM segments WHERE id = ?", (segment_id,)).fetchone()
    preps = prepared(s)
    where, params = _CANDIDATE_SQL, _candidate_params(s)
    if s["category"]:
        where += " AND a.category = ?"
        params.append(s["category"])
    acts = conn.execute(
        f"SELECT a.* FROM activities a WHERE {where} AND a.segments_version >= ?",
        [*params, MATCH_VERSION],
    ).fetchall()
    rows: list[tuple] = []
    for a in acts:
        pos = _channels(conn, a["id"], ("time", "lat", "lon"))
        for seg in preps:
            rows += _match_pair(conn, a, seg, pos)
    conn.execute("BEGIN")
    try:
        conn.execute("DELETE FROM segment_efforts WHERE segment_id = ?", (segment_id,))
        conn.executemany(_INSERT, rows)
        conn.execute(
            "UPDATE segments SET match_version = ? WHERE id = ?", (MATCH_VERSION, segment_id)
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return len(rows)


def match_activity(conn: sqlite3.Connection, activity_id: int, segs: list | None = None) -> int:
    """Match one activity against every segment. Returns the number of efforts."""
    a = conn.execute("SELECT * FROM activities WHERE id = ?", (activity_id,)).fetchone()
    if a is None:
        return 0
    if segs is None:
        segs = _all_segments(conn)
    rows: list[tuple] = []
    todo = [(s, p) for s, p in segs if _covers(a, s)] if a["has_gps"] else []
    if todo:
        pos = _channels(conn, activity_id, ("time", "lat", "lon"))
        for _, preps in todo:
            for seg in preps:
                rows += _match_pair(conn, a, seg, pos)
    conn.execute("BEGIN")
    try:
        conn.execute("DELETE FROM segment_efforts WHERE activity_id = ?", (activity_id,))
        conn.executemany(_INSERT, rows)
        conn.execute(
            "UPDATE activities SET segments_version = ? WHERE id = ?", (MATCH_VERSION, activity_id)
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return len(rows)


def _all_segments(conn: sqlite3.Connection) -> list[tuple[sqlite3.Row, list[Prepared]]]:
    return [(s, prepared(s)) for s in conn.execute("SELECT * FROM segments")]


def pending(conn: sqlite3.Connection) -> int:
    segs = conn.execute(
        "SELECT COUNT(*) FROM segments WHERE match_version < ?", (MATCH_VERSION,)
    ).fetchone()[0]
    acts = conn.execute(
        "SELECT COUNT(*) FROM activities WHERE segments_version < ?", (MATCH_VERSION,)
    ).fetchone()[0]
    return segs + acts


def backfill(conn: sqlite3.Connection, progress: ProgressFn | None = None) -> int:
    """Match new segments against all activities and new activities against all segments.
    Returns the number of segments + activities processed."""
    has_segments = conn.execute("SELECT 1 FROM segments LIMIT 1").fetchone() is not None
    if not has_segments:
        # Nothing to match yet; activities are done (a new segment matches all of them).
        conn.execute(
            "UPDATE activities SET segments_version = ? WHERE segments_version < ?",
            (MATCH_VERSION, MATCH_VERSION),
        )
        return 0
    conn.execute(
        "UPDATE activities SET segments_version = ? WHERE has_gps = 0 AND segments_version < ?",
        (MATCH_VERSION, MATCH_VERSION),
    )
    seg_ids = [r[0] for r in conn.execute(
        "SELECT id FROM segments WHERE match_version < ? ORDER BY id", (MATCH_VERSION,)
    )]  # fmt: skip
    act_ids = [r[0] for r in conn.execute(
        "SELECT id FROM activities WHERE segments_version < ? ORDER BY start_time_utc",
        (MATCH_VERSION,),
    )]  # fmt: skip
    total, done = len(seg_ids) + len(act_ids), 0
    for sid in seg_ids:
        match_segment(conn, sid)
        done += 1
        if progress:
            progress(done, total)
    segs = _all_segments(conn) if act_ids else []
    for aid in act_ids:
        match_activity(conn, aid, segs)
        done += 1
        if progress and (done % 20 == 0 or done == total):
            progress(done, total)
    return total


# ---- creating segments -------------------------------------------------------------------


def _ascent(alt: list) -> float | None:
    vals = [v for v in alt if v is not None]
    if len(vals) < 2:
        return None
    total, ref = 0.0, vals[0]
    for v in vals[1:]:  # 2 m hysteresis against barometric noise
        if v - ref >= 2:
            total += v - ref
            ref = v
        elif v < ref:
            ref = v
    return round(total, 1)


def _end_alt(alts: list) -> float | None:
    """Altitude at one end: the mean of the first few values (barometric noise)."""
    vals = [v for v in alts if v is not None][:5]
    return sum(vals) / len(vals) if vals else None


def net_climb(alts: list) -> float | None:
    """End altitude minus start altitude of a slice."""
    a, b = _end_alt(alts), _end_alt(list(reversed(alts)))
    return round(b - a, 1) if a is not None and b is not None else None


def source_net_climb(conn: sqlite3.Connection, s: sqlite3.Row) -> float | None:
    """Net climb of an older segment from its source activity: the altitude at the samples
    nearest to its start and its end."""
    ch = _channels(conn, s["source_activity_id"], ("lat", "lon", "altitude"))
    lat, lon, alt = ch.get("lat") or [], ch.get("lon") or [], ch.get("altitude") or []
    proj = Projection(s["start_lat"], s["start_lon"])

    def nearest(la0: float, lo0: float, after: int = 0) -> int | None:
        x0, y0 = proj.xy(la0, lo0)
        best, best_d = None, math.inf
        for i in range(after, min(len(lat), len(lon))):
            if lat[i] is None or lon[i] is None:
                continue
            x, y = proj.xy(lat[i], lon[i])
            d = (x - x0) ** 2 + (y - y0) ** 2
            if d < best_d:
                best, best_d = i, d
        return best

    i0 = nearest(s["start_lat"], s["start_lon"])
    i1 = nearest(s["end_lat"], s["end_lon"], i0) if i0 is not None else None
    if i0 is None or i1 is None or i1 >= len(alt):
        return None
    return net_climb(alt[i0 : i1 + 1])


def slice_activity(conn: sqlite3.Connection, activity_id: int, start_s: float, end_s: float):
    """Points (full resolution) and altitude of an activity between two time offsets."""
    ch = _channels(conn, activity_id, ("time", "lat", "lon", "altitude"))
    time, lat, lon = ch.get("time") or [], ch.get("lat") or [], ch.get("lon") or []
    alt = ch.get("altitude") or []
    pts, alts = [], []
    for i, t in enumerate(time):
        if t is None or t < start_s or t > end_s:
            continue
        if i < len(lat) and lat[i] is not None and lon[i] is not None:
            pts.append((lat[i], lon[i]))
            alts.append(alt[i] if i < len(alt) else None)
    return pts, alts


def create_from_activity(
    conn: sqlite3.Connection,
    activity_id: int,
    start_s: float,
    end_s: float,
    name: str,
    any_type: bool = False,
    source: str = "activity",
) -> int:
    a = conn.execute("SELECT * FROM activities WHERE id = ?", (activity_id,)).fetchone()
    if a is None:
        raise SegmentError("activity not found")
    if end_s <= start_s:
        raise SegmentError("the end must be after the start")
    pts, alts = slice_activity(conn, activity_id, start_s, end_s)
    if len(pts) < 2:
        raise SegmentError("this part of the activity has no GPS points")
    length = path_length(pts)
    if length < MIN_SEGMENT_M:
        raise SegmentError(f"a segment must be at least {MIN_SEGMENT_M:.0f} m long")
    simple = geo.simplify(pts, SIMPLIFY_M)
    lats = [p[0] for p in pts]
    lons = [p[1] for p in pts]
    name = name.strip() or f"Segment {length / 1000:.1f} km"
    cur = conn.execute(
        """INSERT INTO segments (name, category, polyline, point_count, distance_m, ascent_m,
               start_lat, start_lon, end_lat, end_lon, bbox_min_lat, bbox_min_lon,
               bbox_max_lat, bbox_max_lon, source, source_activity_id, net_climb_m)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            name[:120], None if any_type else a["category"], geo.encode_polyline(simple),
            len(simple), round(length, 1), _ascent(alts), pts[0][0], pts[0][1],
            pts[-1][0], pts[-1][1], min(lats), min(lons), max(lats), max(lons),
            source, activity_id, net_climb(alts),
        ),
    )  # fmt: skip
    return cur.lastrowid


def reset_segment(conn: sqlite3.Connection, segment_id: int) -> None:
    conn.execute("UPDATE segments SET match_version = 0 WHERE id = ?", (segment_id,))


# ---- snapping map pins to own tracks -----------------------------------------------------


def _closest_in(tr: Track, lo: int, hi: int, p) -> tuple[int, float]:
    best, best_d = lo, math.inf
    for i in range(lo, hi + 1):
        d = (tr.x[i] - p[0]) ** 2 + (tr.y[i] - p[1]) ** 2
        if d < best_d:
            best, best_d = i, d
    return best, math.sqrt(best_d)


def snap_track(tr: Track, pins_xy: list) -> tuple[int, int, float] | None:
    """Best pass of the track through all pins in order: (start index, end index, sum of
    pin distances), shortest slice first. None if the track misses a pin."""
    best = None
    i = 0
    while i < len(tr):
        run = _near_run(tr, i, pins_xy[0], PIN_RADIUS_M)
        if run is None:
            break
        start, score = _closest_in(tr, run[0], run[1], pins_xy[0])
        cur, ok = start, True
        for p in pins_xy[1:]:
            r = _near_run(tr, cur + 1, p, PIN_RADIUS_M)
            if r is None:
                ok = False
                break
            cur, d = _closest_in(tr, r[0], r[1], p)
            score += d
        if ok and cur > start:
            length = tr.travelled(start, cur)
            key = (score, length)
            if best is None or key < best[3]:
                best = (start, cur, score, key)
        i = run[1] + 1
    return (best[0], best[1], best[2]) if best else None


def snap(conn: sqlite3.Connection, pins: list[tuple[float, float]], category: str | None,
         limit: int = 400) -> dict | None:  # fmt: skip
    """Find the own activity that passes all pins in order; return the slice to save."""
    if len(pins) < 2:
        raise SegmentError("place at least two pins")
    m = BBOX_MARGIN_DEG
    lat_lo, lat_hi = min(p[0] for p in pins), max(p[0] for p in pins)
    lon_lo, lon_hi = min(p[1] for p in pins), max(p[1] for p in pins)
    where = ["has_gps = 1", "bbox_min_lat <= ?", "bbox_max_lat >= ?", "bbox_min_lon <= ?",
             "bbox_max_lon >= ?"]  # fmt: skip
    params: list = [lat_lo + m, lat_hi - m, lon_lo + m, lon_hi - m]
    if category:
        where.append("category = ?")
        params.append(category)
    acts = conn.execute(
        f"""SELECT * FROM activities WHERE {" AND ".join(where)}
            ORDER BY start_time_utc DESC LIMIT ?""",
        [*params, limit],
    ).fetchall()
    proj = Projection(*pins[0])
    pins_xy = [proj.xy(lat, lon) for lat, lon in pins]
    best = None
    for a in acts:
        ch = _channels(conn, a["id"], ("time", "lat", "lon"))
        tr = Track(ch.get("time") or [], ch.get("lat") or [], ch.get("lon") or [], proj)
        hit = snap_track(tr, pins_xy)
        if hit is None:
            continue
        start, end, score = hit
        if best is None or score < best[0] - 1e-6:  # newest first, so ties keep the newest
            best = (score, a, tr, start, end)
    if best is None:
        return None
    score, a, tr, start, end = best
    start_s, end_s = tr.t[start], tr.t[end]
    pts, _ = slice_activity(conn, a["id"], start_s, end_s)
    return {
        "activity_id": a["id"],
        "activity_name": a["name"],
        "activity_type": a["activity_type"],
        "category": a["category"],
        "start_time_utc": a["start_time_utc"],
        "utc_offset_s": a["utc_offset_s"],
        "start_s": start_s,
        "end_s": end_s,
        "distance_m": round(path_length(pts), 1),
        "polyline": geo.encode_polyline(geo.simplify(pts, SIMPLIFY_M)),
        "pin_distance_m": round(score / len(pins), 1),
        "candidates": len(acts),
    }
