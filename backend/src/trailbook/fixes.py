"""Corrections the person asks for on one activity (activity › Edit): altitude without its
unrealistic spikes, and speed and distance without GPS jumps. The streams are rewritten (the
values taken out are gone), the activity's totals and laps follow, and the kinds done are kept
in `activities.fixes` so a reimport of the file applies them again (docs/MANUAL.md ›
Corrections).
"""

from __future__ import annotations

import json
import sqlite3
from statistics import median

from . import analysis, geo, importer, streams

KINDS = ("altitude", "speed")

ALT_WINDOW = 31  # samples around a point: its median altitude
ALT_SPIKE_M = 8.0  # further than this from the median (and well out of the usual noise): a spike
ALT_SMOOTH = 5  # samples in the rolling mean after the spikes are out
ASCENT_STEP_M = 2.0  # a change under this is noise (total ascent and descent)

SPEED_WINDOW = 31  # samples around a point: its median speed
SPEED_SPIKE = 3.0  # this many times the median speed …
SPEED_SPIKE_MS = 4.0  # … and this much over it (m/s): a jump
RELOCATE_S = 60  # a position this long away from the last good one is taken as it is
# The fastest an activity of the group can go (m/s): faster between two samples is a jump.
MAX_SPEED_MS = {
    "run": 12.0, "walk": 6.0, "hike": 6.0, "swim": 4.0, "ride": 30.0, "water": 15.0,
    "winter": 40.0, "fitness": 12.0, "team": 12.0, "racket": 12.0, "combat": 12.0,
    "climbing": 6.0, "mind_body": 6.0,
}  # fmt: skip
MAX_SPEED_OTHER_MS = 50.0


# ---- altitude -------------------------------------------------------------------------------


def _rolling_median(v: list[float | None], w: int) -> list[float | None]:
    half = w // 2
    out: list[float | None] = []
    for i in range(len(v)):
        part = [x for x in v[max(0, i - half) : i + half + 1] if x is not None]
        out.append(median(part) if part else None)
    return out


def _rolling_mean(v: list[float | None], w: int) -> list[float | None]:
    half = w // 2
    out: list[float | None] = []
    for i, x in enumerate(v):
        if x is None:
            out.append(None)
            continue
        part = [y for y in v[max(0, i - half) : i + half + 1] if y is not None]
        out.append(sum(part) / len(part))
    return out


def smooth_altitude(time: list, altitude: list) -> list[float | None]:
    """The altitude without jumps (faster than analysis.ALT_JUMP_MS), without spikes (far from
    the median around them) and lightly smoothed."""
    n = len(altitude)
    t = list(time[:n]) + [None] * (n - len(time))
    # jumps: the steps out of it taken back (samples without a time keep their value)
    alt = analysis.clean_altitude([x if x is not None else i for i, x in enumerate(t)], altitude)
    med = _rolling_median(alt, ALT_WINDOW)
    dev = [abs(a - m) for a, m in zip(alt, med, strict=True) if a is not None and m is not None]
    noise = median(dev) * 1.4826 if dev else 0.0  # the usual spread around the median
    limit = max(ALT_SPIKE_M, 4 * noise)
    out = [
        m if a is not None and m is not None and abs(a - m) > limit else a
        for a, m in zip(alt, med, strict=True)
    ]
    return [None if v is None else round(v, 2) for v in _rolling_mean(out, ALT_SMOOTH)]


def ascent_descent(altitude: list[float | None]) -> tuple[float, float]:
    """Total ascent and descent: changes counted once they reach ASCENT_STEP_M."""
    up = down = 0.0
    ref = None
    for v in altitude:
        if v is None:
            continue
        if ref is None:
            ref = v
        elif v - ref >= ASCENT_STEP_M:
            up += v - ref
            ref = v
        elif ref - v >= ASCENT_STEP_M:
            down += ref - v
            ref = v
    return up, down


# ---- speed and distance --------------------------------------------------------------------


def _metres(p: tuple[float, float], q: tuple[float, float]) -> float:
    return analysis._metres(p[0], p[1], q[0], q[1])


def fix_positions(time: list, lat: list, lon: list, vmax: float) -> tuple[list, list]:
    """Positions reached faster than `vmax` from the last good one (and points that jump out and
    straight back) moved onto the line between their good neighbours. A position still far after
    RELOCATE_S is taken as it is (the signal came back somewhere else)."""
    n = min(len(time), len(lat), len(lon))
    pts = [
        (lat[i], lon[i]) if lat[i] is not None and lon[i] is not None and time[i] is not None
        else None
        for i in range(n)
    ]  # fmt: skip
    good = [p is not None for p in pts]
    # out and straight back: much further than the way from the point before to the one after
    idx = [i for i in range(n) if pts[i] is not None]
    for k in range(1, len(idx) - 1):
        a, b, c = idx[k - 1], idx[k], idx[k + 1]
        out, back, direct = (
            _metres(pts[a], pts[b]),
            _metres(pts[b], pts[c]),
            _metres(pts[a], pts[c]),
        )
        dt = max(time[c] - time[a], 1.0)
        if out + back > 3 * direct + 50 and (out + back) / dt > vmax:
            good[b] = False
    last = None
    for i in idx:
        if not good[i]:
            continue
        if last is not None:
            dt = time[i] - time[last]
            if _metres(pts[last], pts[i]) / max(dt, 1.0) > vmax and dt < RELOCATE_S:
                good[i] = False
                continue
        last = i
    # the bad ones: on the line between the good neighbours (by time)
    new_lat, new_lon = list(lat[:n]), list(lon[:n])
    goods = [i for i in idx if good[i]]
    j = 0
    for i in idx:
        if good[i]:
            continue
        while j < len(goods) and goods[j] < i:
            j += 1
        before = goods[j - 1] if j > 0 else None
        after = goods[j] if j < len(goods) else None
        if before is None and after is None:
            new_lat[i] = new_lon[i] = None
            continue
        if before is None or after is None:
            src = pts[after if before is None else before]
            new_lat[i], new_lon[i] = src
            continue
        span = time[after] - time[before]
        f = (time[i] - time[before]) / span if span > 0 else 0.0
        new_lat[i] = pts[before][0] + f * (pts[after][0] - pts[before][0])
        new_lon[i] = pts[before][1] + f * (pts[after][1] - pts[before][1])
    return new_lat, new_lon


def fix_distance(
    time: list, distance: list, lat: list | None, lon: list | None, vmax: float
) -> list[float | None]:
    """The running distance with its jumps taken out: a step faster than `vmax` (or a spike far
    over the median speed around it) is replaced by the way between the (corrected) positions,
    or by the speed before it."""
    n = min(len(time), len(distance))
    steps: list[float | None] = [None] * n
    speeds: list[float | None] = [None] * n
    prev = None
    for i in range(n):
        if distance[i] is None or time[i] is None:
            continue
        if prev is not None:
            dt = time[i] - time[prev]
            d = max(0.0, distance[i] - distance[prev])
            steps[i] = d
            speeds[i] = d / dt if dt > 0 else None
        prev = i
    med = _rolling_median(speeds, SPEED_WINDOW)
    out: list[float | None] = [None] * n
    total, prev, last_speed = None, None, 0.0
    for i in range(n):
        if distance[i] is None or time[i] is None:
            continue
        if total is None:
            total = distance[i]
        elif steps[i] is not None:
            dt = max(time[i] - time[prev], 0.0)
            s, m = speeds[i], med[i] or 0.0
            jump = s is not None and (s > vmax or (s > SPEED_SPIKE * m and s > m + SPEED_SPIKE_MS))
            d = steps[i]
            if jump:
                gps = None
                if lat and lon and None not in (lat[i], lon[i], lat[prev], lon[prev]):
                    gps = _metres((lat[prev], lon[prev]), (lat[i], lon[i]))
                ok = gps is not None and dt > 0 and gps / dt <= vmax
                d = gps if ok else min(last_speed, m or last_speed) * dt
            elif s is not None:
                last_speed = s
            total += d
        out[i] = round(total, 2)
        prev = i
    return out


def fix_speed(time: list, speed: list, distance: list | None, vmax: float) -> list[float | None]:
    """Speed samples over `vmax` or far over the median around them: the speed from the
    (corrected) distance there, or the median."""
    med = _rolling_median(speed, SPEED_WINDOW)
    out: list[float | None] = []
    for i, s in enumerate(speed):
        m = med[i] or 0.0
        if s is None or not (s > vmax or (s > SPEED_SPIKE * m and s > m + SPEED_SPIKE_MS)):
            out.append(s)
            continue
        v = m
        if distance and 0 < i < len(distance) and i < len(time):
            j = i - 1
            if None not in (distance[i], distance[j], time[i], time[j]) and time[i] > time[j]:
                v = (distance[i] - distance[j]) / (time[i] - time[j])
        out.append(round(min(v, vmax), 3))
    return out


# ---- the activity ---------------------------------------------------------------------------


def _load(conn: sqlite3.Connection, table: str, activity_id: int) -> dict[str, list]:
    return {
        r["channel"]: streams.decode(r["encoding"], r["data"])
        for r in conn.execute(
            f"SELECT channel, encoding, data FROM {table} WHERE activity_id = ?", (activity_id,)
        )
    }


def _store(conn: sqlite3.Connection, table: str, activity_id: int, channel: str, values: list):
    kind = "f64" if channel in ("lat", "lon", "time") else "f32"
    encoding, blob = streams.encode(values, kind)
    conn.execute(
        f"""UPDATE {table} SET encoding = ?, length = ?, data = ?
            WHERE activity_id = ? AND channel = ?""",
        (encoding, len(values), blob, activity_id, channel),
    )


def _window(time: list, t0: float, t1: float) -> tuple[int, int] | None:
    idx = [i for i, t in enumerate(time) if t is not None and t0 <= t <= t1]
    return (idx[0], idx[-1]) if idx else None


def fixes_of(row: sqlite3.Row) -> list[str]:
    try:
        kinds = json.loads(row["fixes"]) if row["fixes"] else []
    except ValueError:
        kinds = []
    return [k for k in KINDS if k in kinds]


def apply(conn: sqlite3.Connection, activity_id: int, kinds: list[str]) -> list[str]:
    """Correct the activity's streams and totals (`kinds`: altitude, speed) and keep the kinds
    in `fixes`. Load, best efforts, segments and the training type are not computed again
    here (the caller does that). Returns the kinds applied."""
    a = conn.execute("SELECT * FROM activities WHERE id = ?", (activity_id,)).fetchone()
    if a is None:
        return []
    kinds = [k for k in KINDS if k in kinds]
    ch = _load(conn, "streams", activity_id)
    time = ch.get("time") or []
    laps = conn.execute(
        "SELECT idx, start_offset_s, elapsed_s, timer_s FROM laps WHERE activity_id = ?",
        (activity_id,),
    ).fetchall()
    windows = {
        lap["idx"]: _window(time, lap["start_offset_s"], lap["start_offset_s"] + lap["elapsed_s"])
        for lap in laps
        if lap["start_offset_s"] is not None and lap["elapsed_s"]
    }

    if "altitude" in kinds and ch.get("altitude") and time:
        alt = smooth_altitude(time, ch["altitude"])
        _store(conn, "streams", activity_id, "altitude", alt)
        up, down = ascent_descent(alt)
        conn.execute(
            "UPDATE activities SET ascent_m = ?, descent_m = ? WHERE id = ?",
            (round(up), round(down), activity_id),
        )
        for k, w in windows.items():
            if w:
                lu, ld = ascent_descent(alt[w[0] : w[1] + 1])
                conn.execute(
                    "UPDATE laps SET ascent_m = ?, descent_m = ? WHERE activity_id = ? AND idx = ?",
                    (round(lu), round(ld), activity_id, k),
                )
        # Garmin Connect's corrected altitude (shown in its place when Garmin corrected it)
        gc = _load(conn, "connect_streams", activity_id).get("altitude_connect")
        if gc:
            _store(conn, "connect_streams", activity_id, "altitude_connect",
                   smooth_altitude(list(range(len(gc))), gc))  # fmt: skip

    if "speed" in kinds and time:
        vmax = MAX_SPEED_MS.get(a["category"], MAX_SPEED_OTHER_MS)
        lat, lon = ch.get("lat"), ch.get("lon")
        if lat and lon:
            lat, lon = fix_positions(time, lat, lon, vmax)
            _store(conn, "streams", activity_id, "lat", lat)
            _store(conn, "streams", activity_id, "lon", lon)
            track = [
                (p, q) for p, q in zip(lat, lon, strict=False) if p is not None and q is not None
            ]
            if len(track) >= 2:
                simple = geo.simplify(track, importer.TRACK_TOLERANCE_M)
                conn.execute(
                    "UPDATE tracks SET polyline = ?, point_count = ? WHERE activity_id = ?",
                    (geo.encode_polyline(simple), len(simple), activity_id),
                )
                lats, lons = [p[0] for p in track], [p[1] for p in track]
                conn.execute(
                    """UPDATE activities SET bbox_min_lat = ?, bbox_min_lon = ?, bbox_max_lat = ?,
                              bbox_max_lon = ? WHERE id = ?""",
                    (min(lats), min(lons), max(lats), max(lons), activity_id),
                )
            importer._store_tiles(conn, activity_id, lat, lon)
        dist = ch.get("distance")
        if dist:
            dist = fix_distance(time, dist, lat, lon, vmax)
            _store(conn, "streams", activity_id, "distance", dist)
        speed = ch.get("speed")
        if speed:
            speed = fix_speed(time, speed, dist, vmax)
            _store(conn, "streams", activity_id, "speed", speed)
        total = next((d for d in reversed(dist or []) if d is not None), None)
        secs = a["time_s"] or a["timer_s"] or a["elapsed_s"]
        top = max((s for s in speed or [] if s is not None), default=None)
        if total is not None:
            conn.execute(
                """UPDATE activities SET distance_m = ?, avg_speed = ?,
                          max_speed = COALESCE(?, max_speed) WHERE id = ?""",
                (total, total / secs if secs else a["avg_speed"], top, activity_id),
            )
        for k, w in windows.items():
            lap = next(x for x in laps if x["idx"] == k)
            if not w or not dist or dist[w[0]] is None or dist[w[1]] is None:
                continue
            before = next((dist[i] for i in range(w[0] - 1, -1, -1) if dist[i] is not None), 0.0)
            d = dist[w[1]] - (before if w[0] > 0 else dist[w[0]])
            ls = lap["timer_s"] or lap["elapsed_s"]
            lap_top = max(
                (s for s in (speed or [])[w[0] : w[1] + 1] if s is not None), default=None
            )
            conn.execute(
                """UPDATE laps SET distance_m = ?, avg_speed = ?, max_speed = COALESCE(?, max_speed)
                   WHERE activity_id = ? AND idx = ?""",
                (round(d, 2), d / ls if ls else None, lap_top, activity_id, k),
            )

    done = sorted(set(fixes_of(a)) | set(kinds), key=KINDS.index)
    conn.execute(
        """UPDATE activities SET fixes = ?, analysis_version = 0, segments_version = 0,
                  workout_version = 0 WHERE id = ?""",
        (json.dumps(done) if done else None, activity_id),
    )
    return kinds
