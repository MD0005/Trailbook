"""Small charts for the activity tiles (Activities › Tiles: Chart), one kind per training type,
in the style of the activity charts but without numbers: only what the shape needs.

- Intervals: a block per section between the interval lines (the person's saved lines, else the
  detected ones): width = its time, height = its average heart rate on a scale from the resting
  to the maximum HR, colour = that heart rate's zone (Garmin's zones of the activity); a dashed
  line at the activity's average heart rate.
- Easy, Tempo, Race, team and racket sports: the same blocks over the phases of the session
  (stretches of one heart rate zone, at least 1/12 of the time); Long: at least 1/20.
- Hills: the altitude profile along the distance (the page marks the climbs).
- Commute and sports without a training type: the route alone, coloured by heart rate zone,
  on a plain background (no route: heart rate blocks, else speed, else the page's sport icon).
- Without the data a kind needs: speed over time.

Pure Python over the stored streams, computed when the tiles ask for it.
"""

from __future__ import annotations

import json
import math
import sqlite3

from . import analysis, streams, workout

POINTS = 80  # profile points across a tile


def _channels(conn: sqlite3.Connection, activity_id: int, names: tuple[str, ...]) -> dict:
    marks = ", ".join("?" for _ in names)
    return {
        r[0]: streams.decode(r[1], r[2])
        for r in conn.execute(
            f"SELECT channel, encoding, data FROM streams WHERE activity_id = ? "
            f"AND channel IN ({marks})",
            (activity_id, *names),
        )
    }


def _buckets(x: list, v: list, points: int = POINTS) -> list:
    """Mean of `v` in `points` equal steps of `x` (time or distance, never decreasing)."""
    pairs = [(a, b) for a, b in zip(x, v, strict=False) if a is not None and b is not None]
    if len(pairs) < 2:
        return []
    x0, x1 = pairs[0][0], pairs[-1][0]
    span = (x1 - x0) or 1
    sums, counts = [0.0] * points, [0] * points
    for a, b in pairs:
        k = min(points - 1, int((a - x0) / span * points))
        sums[k] += b
        counts[k] += 1
    out, last = [], None
    for s, n in zip(sums, counts, strict=True):
        last = round(s / n, 2) if n else last
        out.append(last)
    return out


def _avg(time: list, v: list, t0: float, t1: float) -> float | None:
    """Time-weighted mean of `v` between t0 and t1 (gaps over 30 s count 30 s)."""
    s = w = 0.0
    prev = None
    for t, x in zip(time, v, strict=False):
        if t is None:
            continue
        if prev is not None and t0 < t <= t1 and x is not None:
            dt = min(float(MAX_GAP_S), t - prev)
            s += x * dt
            w += dt
        prev = t
    return s / w if w else None


def _hr_zone(zones: dict | None, v: float | None) -> int | None:
    """Garmin's heart rate zone (1…) of a value, None below zone 1 or without zones."""
    b = (zones or {}).get("hr", {}).get("bounds")
    if not b or v is None or v < b[0]:
        return None
    for k, hi in enumerate(b[1:]):
        if v < hi:
            return k + 1
    return len(b) - 1


def _zone_count(zones: dict | None) -> int:
    return max(0, len((zones or {}).get("hr", {}).get("bounds") or []) - 1)


def _hr_max(zones: dict | None, a: sqlite3.Row, hr: list) -> float | None:
    """Top of the heart rate scale: Garmin's maximum HR (last zone limit), else the activity's."""
    b = (zones or {}).get("hr", {}).get("bounds")
    if b and b[-1] < 260:
        return float(b[-1])
    vals = [v for v in hr if v]
    return float(a["max_hr"] or (max(vals) if vals else 0)) or None


# Phases of a session on the tiles: share of the activity's time a block must last at least
# (at least a minute), per training type; the rest (team sports, no type) as Easy.
BLOCK_SHARE = {"easy": 1 / 12, "tempo": 1 / 12, "race": 1 / 12, "long": 1 / 20}
DEFAULT_SHARE = 1 / 12  # team and racket sports, sports without a type
HYSTERESIS_BPM = 3  # a new zone counts once the heart rate is this far past its limit
HYSTERESIS_POWER = 0.03  # the same from power: share of the top of the power zones
STEP_S = 15  # heart rate averaged over steps of this length before the zones are read
MIN_BLOCK_S = 60  # no block shorter than this
OPEN_ZONE = 1.1  # an open last power zone ends this much above its start
MAX_GAP_S = 30  # a recording gap counts at most this long in an average
TRACK_POINTS = 160  # route points on a Commute tile

# Manual › Activity charts is written from these (/api/types: tile_chart_rules).
RULES = {
    "block_share": BLOCK_SHARE, "default_share": DEFAULT_SHARE, "hysteresis_bpm": HYSTERESIS_BPM,
    "hysteresis_power": HYSTERESIS_POWER, "step_s": STEP_S, "min_block_s": MIN_BLOCK_S,
    "open_zone": OPEN_ZONE, "max_gap_s": MAX_GAP_S, "points": POINTS, "track_points": TRACK_POINTS,
}  # fmt: skip


def _zone_blocks(
    time: list, hr: list, zones: dict | None, step: int = STEP_S, min_s: int = MIN_BLOCK_S,
    hyst: float = HYSTERESIS_BPM,
) -> list:  # fmt: skip
    """Stretches of one heart rate zone: 15 s means; the zone changes only when the mean is
    `hyst` bpm past the limit (heart rate hovering at a limit stays in one block); neighbours in
    the same zone joined; a stretch under `min_s` merged into the neighbour closer in heart rate.
    [(t0, t1), ...]"""
    lims = (zones or {}).get("hr", {}).get("bounds") or []

    def zone_with_hysteresis(cur: int | None, m: float) -> int:
        z = _hr_zone(zones, m) or 0
        if cur is None or z == cur or not lims:
            return z
        if z > cur:  # up: past the upper limit of the current zone by hyst
            return z if m >= lims[cur] + hyst else cur
        return z if m <= lims[cur - 1] - hyst else cur  # down: past its lower limit

    pts = [(t, v) for t, v in zip(time, hr, strict=False) if t is not None and v]
    if len(pts) < 2:
        return []
    t0 = pts[0][0]
    buckets: dict[int, list] = {}
    for t, v in pts:
        buckets.setdefault(int((t - t0) // step), []).append(v)
    blocks: list = []  # [start, end, zone, mean]
    for k in sorted(buckets):
        m = sum(buckets[k]) / len(buckets[k])
        z = zone_with_hysteresis(blocks[-1][2] if blocks else None, m)
        a, b = t0 + k * step, t0 + (k + 1) * step
        if blocks and blocks[-1][2] == z and blocks[-1][1] >= a:
            blk = blocks[-1]
            n0, n1 = blk[1] - blk[0], b - a
            blk[3] = (blk[3] * n0 + m * n1) / (n0 + n1)
            blk[1] = b
        else:
            blocks.append([a, b, z, m])
    while len(blocks) > 1:
        k = min(range(len(blocks)), key=lambda i: blocks[i][1] - blocks[i][0])
        if blocks[k][1] - blocks[k][0] >= min_s:
            break
        near = [j for j in (k - 1, k + 1) if 0 <= j < len(blocks)]
        j = min(near, key=lambda i: abs(blocks[i][3] - blocks[k][3]))
        lo, hi = min(j, k), max(j, k)
        x, y = blocks[lo], blocks[hi]
        n0, n1 = x[1] - x[0], y[1] - y[0]
        merged = [x[0], y[1], blocks[j][2], (x[3] * n0 + y[3] * n1) / (n0 + n1)]
        blocks[lo : hi + 1] = [merged]
    return [(b[0], b[1]) for b in blocks]


def _power_as_hr(zones: dict | None) -> tuple[dict, float] | None:
    """Garmin's power zones in the shape of the heart rate ones (each limit the start of the next
    zone, zone 1 from 0 W) and the top of the scale: the last limit; an open last zone (a limit
    of 2000 W or more) ends 10 % above its start."""
    b = (zones or {}).get("power", {}).get("bounds")
    if not b:
        return None
    lims = list(b) if b[0] == 0 else [0, *b]
    if lims[-1] >= 2000:
        lims = [*lims[:-1], round(lims[-2] * OPEN_ZONE)]
    return ({"hr": {"bounds": lims}}, float(lims[-1])) if len(lims) > 2 else None


def hr_blocks(
    conn: sqlite3.Connection,
    a: sqlite3.Row,
    splits: list | None = None,
    share: float = DEFAULT_SHARE,
) -> dict | None:
    """Blocks over time: width = time, height = average heart rate on a scale
    from the resting to the maximum HR, colour = its heart rate zone. The sections between the
    interval lines (`splits`, seconds from the start), else the stretches of one zone
    (`_zone_blocks`, each at least `share` of the time).
    `avg` = the activity's average heart rate on the same scale (a dashed line).
    Without heart rate the same from power (e.g. a bike computer without an HR strap): height
    from 0 W to the top of Garmin's power zones, colour = the power zone in the power zone
    colours (grey, blue, green, yellow, red, violet, black; `power` true)."""
    ch = _channels(conn, a["id"], ("time", "hr", "power"))
    time, hr, pw = ch.get("time") or [], ch.get("hr") or [], ch.get("power") or []
    if len(time) < 2:
        return None
    zones = json.loads(a["zones"]) if a["zones"] else None
    hr_raw = any(hr)  # the blocks come from the heart rate (else from power, in its zone colours)
    if any(hr):
        vals, top, hyst = hr, _hr_max(zones, a, hr), HYSTERESIS_BPM
        # the scale starts at the resting heart rate (watch, else the person's, else a default)
        rest = analysis.activity_thresholds(conn, a).hr_rest or 0
    else:
        as_hr = _power_as_hr(zones) if any(pw) else None
        if as_hr is None:
            return None
        (zones, top), vals, rest = as_hr, pw, 0.0
        hyst = HYSTERESIS_POWER * top
    if not top or rest >= top:
        return None
    scale = lambda v: round(min(1.0, max(0.0, (v - rest) / (top - rest))), 3)  # noqa: E731
    hr = vals
    t_start = next(t for t in time if t is not None)
    t_end = next(t for t in reversed(time) if t is not None)
    if splits:
        edges = [t_start, *[t_start + s for s in splits], t_end]
        spans = [(x, y) for x, y in zip(edges, edges[1:], strict=False) if y > x]
    else:
        min_s = max(MIN_BLOCK_S, int((t_end - t_start) * share))
        spans = _zone_blocks(time, hr, zones, min_s=min_s, hyst=hyst)
    span = (t_end - t_start) or 1
    bars = []
    for t0, t1 in spans:
        m = _avg(time, hr, t0, t1)
        bars.append([
            round((t0 - t_start) / span, 4),
            round(min(1.0, (t1 - t_start) / span), 4),
            scale(m) if m else 0,
            _hr_zone(zones, m),
        ])  # fmt: skip
    mean = _avg(time, hr, t_start, t_end)
    return {"kind": "blocks", "bars": bars, "zones": _zone_count(zones),
            "avg": scale(mean) if mean else None,
            "power": not hr_raw}  # fmt: skip


def interval_blocks(conn: sqlite3.Connection, a: sqlite3.Row) -> dict | None:
    """`hr_blocks` over the interval sections: the person's saved lines, else the detected."""
    saved = json.loads(a["section_lines"]) if a["section_lines"] else None
    if saved and saved.get("kind") == "intervals":
        splits = saved["splits"]
    else:
        splits = workout.interval_splits(conn, a["id"])["splits"]
    return hr_blocks(conn, a, splits) if splits else None


def track(conn: sqlite3.Connection, a: sqlite3.Row, points: int = TRACK_POINTS) -> dict | None:
    """The route alone, drawn as a thick line on a plain background: [x, y, zone] with x, y in
    0..1 of the longer side (equirectangular, north up), zone = the heart rate zone there."""
    ch = _channels(conn, a["id"], ("lat", "lon", "hr"))
    lat, lon, hr = ch.get("lat") or [], ch.get("lon") or [], ch.get("hr") or []
    pts = [
        (la, lo, hr[i] if i < len(hr) else None)
        for i, (la, lo) in enumerate(zip(lat, lon, strict=False))
        if la is not None and lo is not None
    ]
    if len(pts) < 2:
        return None
    zones = json.loads(a["zones"]) if a["zones"] else None
    pts = pts[:: max(1, len(pts) // points)] + [pts[-1]]
    k = math.cos(math.radians(sum(p[0] for p in pts) / len(pts)))
    xs, ys = [p[1] * k for p in pts], [p[0] for p in pts]
    x0, y0 = min(xs), min(ys)
    size = max(max(xs) - x0, max(ys) - y0) or 1
    out = [
        [round((x - x0) / size, 4), round((y - y0) / size, 4), _hr_zone(zones, p[2])]
        for x, y, p in zip(xs, ys, pts, strict=True)
    ]
    return {"kind": "track", "pts": out, "w": round((max(xs) - x0) / size, 4),
            "h": round((max(ys) - y0) / size, 4), "zones": _zone_count(zones)}  # fmt: skip


def altitude_profile(conn: sqlite3.Connection, a: sqlite3.Row) -> dict | None:
    ch = _channels(conn, a["id"], ("time", "distance", "altitude"))
    alt = ch.get("altitude") or []
    x = ch.get("distance") if any(ch.get("distance") or []) else ch.get("time")
    prof = _buckets(x or [], alt)
    return {"kind": "altitude", "alt": prof} if prof else None


def speed_profile(conn: sqlite3.Connection, a: sqlite3.Row) -> dict | None:
    ch = _channels(conn, a["id"], ("time", "speed"))
    prof = _buckets(ch.get("time") or [], ch.get("speed") or [])
    return {"kind": "speed", "speed": prof} if prof else None


def tile_chart(conn: sqlite3.Connection, activity_id: int) -> dict | None:
    """The chart payload for one tile (see the module docstring), or None without data."""
    a = conn.execute(
        """SELECT *, COALESCE(workout_override, workout) AS kind
           FROM activities WHERE id = ?""",
        (activity_id,),
    ).fetchone()
    if a is None:
        return None
    if a["kind"] == "intervals":
        chart = interval_blocks(conn, a) or hr_blocks(conn, a)
    elif a["kind"] == "hills":
        chart = altitude_profile(conn, a)
    elif a["kind"] == "commute" or a["kind"] is None:
        # commutes, and sports without a training type (motor sports, other…): the route alone;
        # without a route the heart rate, else the speed, else nothing (the page shows the icon)
        chart = track(conn, a) or hr_blocks(conn, a)
    else:  # Easy, Long, Tempo, Race, team and racket sports: the phases of the session
        chart = hr_blocks(conn, a, share=BLOCK_SHARE.get(a["kind"], DEFAULT_SHARE))
    return chart or speed_profile(conn, a)
