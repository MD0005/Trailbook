"""Derived analysis: training load per activity, best efforts and the fitness model.

Runs after import in the low-priority importer process (like the explorer tiles): every
activity with `analysis_version` older than ANALYSIS_VERSION is (re)analysed from its
stored streams. Changing a person's thresholds resets the version of that person's
activities, so the next run recomputes their load.

Training load, first method that has the data (SPEC §7.3):
  1. power       — power stream + FTP
  2. pace        — running types, speed + threshold pace
  3. heart rate  — heart rate + threshold HR (TRIMP-based, Banister)
  4. none
Thresholds, per field (SPEC §7.3): a value the person set in Settings (`person_thresholds`,
latest row valid on the activity day) replaces the one from the watch; the watch value
comes from the activity's own FIT file (`watch_*` columns), or from the person's nearest
activity that has one; what is still missing is estimated (HR max = highest max HR
recorded, HR rest = 60 bpm, threshold HR = 90 % of HR max). An activity whose load used an
estimated value is flagged `load_estimated`.

Fitness (CTL/ATL/TSB) is computed on request from the daily loads: a few thousand days
take a few milliseconds, and nothing can get stale.
"""

from __future__ import annotations

import json
import math
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

from . import countries, streams

# v2: watch thresholds, load_estimated; v3: effort positions, ride; v4: 30 km ride;
# v5: power over pauses, up to 5 h; v6: watch FTP per sport, FTP corrected per activity;
# v7: top speed (rides), distance within a time (Cooper 12 min, the hour), biggest climb and
# steepest 1 km (runs and rides); v8: time in heart rate / power zones from the streams when
# the file has none (virtual rides), with borrowed zone limits; the country of the route
ANALYSIS_VERSION = 8

# Best efforts (SPEC §7.5). Pace: metres → best time in s. Power / HR: seconds → best mean.
# Ride: kilometres → best time in s (kind "ride"). Efforts also keep where they happened
# (start_s, end_s: seconds from the start) so the activity page can highlight them.
PACE_DISTANCES_M = (400, 1000, 1609.344, 5000, 10000, 21097.5, 42195)
RIDE_DISTANCES_M = (5000, 10000, 20000, 30000, 40000, 50000, 100000)
POWER_DURATIONS_S = (
    5,
    15,
    30,
    60,
    120,
    300,
    600,
    1200,
    1800,
    3600,
    5400,
    7200,
    10800,
    14400,
    18000,
)
HR_DURATIONS_S = (10, 30, 60, 120, 300, 600, 1200, 1800, 3600)
# Top speed of rides (kind "speed", key = seconds, value = m/s): the best mean over 1 min from
# the distance, only over seconds the data can be trusted (see top_speed_at).
SPEED_DURATIONS_S = (60,)
# Distance within a time (kind "within", key = seconds, value = m): the longest distance covered
# in that time - runs 12 min (the Cooper test), rides 1 h (the hour).
WITHIN_S = {"run": (720,), "ride": (3600,)}
# Climbs of runs and rides, from the altitude stream after jumps are taken out (clean_altitude):
# the biggest single climb (kind "climb", key 0, value = m gained) - from a low point to its top,
# dips on the way allowed while each is at most CLIMB_DIP_SHARE as long as the rise before it and
# loses at most CLIMB_DIP_DROP of the height gained (as the climbs on the altitude chart) - and the
# steepest stretch of GRADE_DISTANCES_M (kind "grade", key = m, value = % average grade).
ALT_JUMP_MS = 4.0  # altitude changing faster than this (m/s): a jump (GPS, barometer reset)
CLIMB_PIVOT_M = 3.0  # wiggles under this are noise
CLIMB_DIP_SHARE, CLIMB_DIP_DROP = 0.25, 1 / 3
CLIMB_MIN_M = 20.0
GRADE_DISTANCES_M = (1000,)
GRADE_MAX_VS = 1.5  # m/s of height gained: faster is no climbing by bike or on foot
GRADE_MAX_PCT = 40.0
GRADE_PIECE_M, GRADE_PIECE_PCT = 50.0, 30.0  # a stretch with 50 m steeper than 30 %: altitude drift
SPEED_MAX_MS = 80 / 3.6  # 80 km/h: faster over a second is a jump of the position
SPEED_ACCEL_MS2 = 3.0  # speed changing faster than this per second: a jump, not riding
SPEED_AGREE_MS, SPEED_AGREE_SHARE = 1.5, 0.15  # distance and the device's speed agree within
SPEED_TRACK_SHARE = 0.10  # the window's distance and the track's length agree within
SPEED_PAD_S = 5  # seconds next to a doubtful one are not trusted either
SPEED_STEP_S = 5  # samples further apart: no speed for that stretch
MAX_GAP_S = 10  # longer gaps in a stream break a window (pause, lost signal)

DEFAULT_HR_REST = 60
LTHR_SHARE_OF_MAX = 0.9
CTL_DAYS = 42
ATL_DAYS = 7

RUN_GROUPS = {"run"}

ProgressFn = Callable[[int, int], None]


# ---- thresholds --------------------------------------------------------------------------

THRESHOLD_FIELDS = ("hr_max", "hr_rest", "lthr", "ftp", "threshold_pace", "swim_css", "weight")


@dataclass
class Thresholds:
    hr_max: float | None = None
    hr_rest: float | None = None
    lthr: float | None = None
    ftp: float | None = None
    threshold_pace: float | None = None  # s/km
    sources: dict | None = None  # field → "set" | "watch" | "auto" | "default"


def auto_hr_max(conn: sqlite3.Connection, person_id: str) -> int | None:
    """Highest plausible max HR the person has recorded (ignores sensor spikes > 230)."""
    row = conn.execute(
        "SELECT MAX(max_hr) FROM activities WHERE person_id = ? AND max_hr BETWEEN 100 AND 230",
        (person_id,),
    ).fetchone()
    return row[0] if row and row[0] else None


def threshold_rows(conn: sqlite3.Connection, person_id: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM person_thresholds WHERE person_id = ? ORDER BY valid_from",
        (person_id,),
    ).fetchall()


WATCH_FIELDS = ("hr_max", "hr_rest", "lthr", "ftp", "weight")


# FTP is per sport: a run file carries the running-power FTP (~1.6x the cycling one on a
# Garmin), so a ride without FTP in its file must not borrow it from a run, and the other way
# round. Other groups take no FTP from the watch.
FTP_GROUPS = ("run", "ride")


def ftp_group(category: str | None) -> str | None:
    """Group whose watch FTP applies to an activity of `category` (None = no watch FTP)."""
    return category if category in FTP_GROUPS else None


def watch_history(
    conn: sqlite3.Connection, person_id: str, group: str | None = "ride"
) -> list[tuple[str, dict]]:
    """(local day, watch thresholds) of the person's activities that have any, by day. The FTP
    comes only from activities of `group` (see FTP_GROUPS; default: cycling, the FTP shown in
    Settings)."""
    cols = ", ".join(f"watch_{k}" for k in WATCH_FIELDS)
    out = []
    for r in conn.execute(
        f"""SELECT {LOCAL_DAY_SQL} AS day, category, {cols} FROM activities
            WHERE person_id = ? AND ({" OR ".join(f"watch_{k} IS NOT NULL" for k in WATCH_FIELDS)})
            ORDER BY start_time_utc""",
        (person_id,),
    ):
        v = {k: r[i + 2] for i, k in enumerate(WATCH_FIELDS)}
        if group is None or r["category"] != group:
            v["ftp"] = None
        out.append((r[0], v))
    return out


def watch_days(history: list[tuple[str, dict]], day: str) -> tuple[dict, dict]:
    """Watch thresholds valid on `day`: per field the latest value on or before the day,
    else the earliest one after it. Returns (values, field → day the value comes from)."""
    values: dict = {}
    days: dict = {}
    for d, v in history:
        if d > day:
            break
        for k, x in v.items():
            if x is not None:
                values[k], days[k] = x, d
    for d, v in history:  # fields never set before the day: the first later value
        for k, x in v.items():
            if x is not None and k not in values:
                values[k], days[k] = x, d
    return values, days


def watch_on(history: list[tuple[str, dict]], day: str) -> tuple[dict, str | None]:
    """Watch thresholds valid on `day` and the day of the newest value used."""
    values, days = watch_days(history, day)
    before = [d for d in days.values() if d <= day]
    return values, max(before) if before else None


def thresholds_for(
    rows: list[sqlite3.Row], day: str, auto_max: int | None, watch: dict | None = None
) -> Thresholds:
    """Thresholds valid on `day` (YYYY-MM-DD): set in Settings > from the watch > estimated."""
    values: dict = {}
    sources: dict = {}
    for r in rows:
        if r["valid_from"] > day:
            break
        for f in THRESHOLD_FIELDS:
            if r[f] is not None:
                values[f] = r[f]
                sources[f] = "set"
    for f, v in (watch or {}).items():
        if v is not None and values.get(f) is None:
            values[f], sources[f] = v, "watch"
    if values.get("hr_max") is None and auto_max:
        values["hr_max"], sources["hr_max"] = auto_max, "auto"
    if values.get("hr_rest") is None:
        values["hr_rest"], sources["hr_rest"] = DEFAULT_HR_REST, "default"
    if values.get("lthr") is None and values.get("hr_max"):
        values["lthr"] = round(values["hr_max"] * LTHR_SHARE_OF_MAX)
        sources["lthr"] = "auto"
    return Thresholds(
        hr_max=values.get("hr_max"),
        hr_rest=values.get("hr_rest"),
        lthr=values.get("lthr"),
        ftp=values.get("ftp"),
        threshold_pace=values.get("threshold_pace"),
        sources=sources,
    )


# ---- stream helpers ----------------------------------------------------------------------


def resample_1hz(time: list, values: list, max_gap: float = MAX_GAP_S) -> list[float | None]:
    """Per-second series (index = second since start). Short gaps carry the last value,
    longer gaps stay None."""
    if not time:
        return []
    end = int(max((t for t in time if t is not None), default=0))
    out: list[float | None] = [None] * (end + 1)
    last_t = last_v = None
    for t, v in zip(time, values, strict=False):
        if t is None:
            continue
        ti = int(t)
        if last_t is not None and last_v is not None and ti - last_t <= max_gap:
            for k in range(last_t + 1, ti):
                out[k] = last_v
        if v is not None:
            out[ti] = v
        last_t, last_v = ti, v
    return out


def best_mean(series: list[float | None], window: int) -> float | None:
    """Highest mean over `window` consecutive seconds without missing samples."""
    r = best_mean_at(series, window)
    return r[0] if r else None


def best_mean_at(series: list[float | None], window: int) -> tuple[float, int] | None:
    """Like `best_mean`, with the second the best window starts: (mean, start)."""
    n = len(series)
    if n < window or window <= 0:
        return None
    best = None
    start = 0
    total = 0.0
    missing = 0
    for i, v in enumerate(series):
        if v is None:
            missing += 1
        else:
            total += v
        if i >= window:
            old = series[i - window]
            if old is None:
                missing -= 1
            else:
                total -= old
        if i >= window - 1 and missing == 0:
            mean = total / window
            if best is None or mean > best:
                best, start = mean, i - window + 1
    return (best, start) if best is not None else None


def best_time_for_distance(time: list, distance: list, metres: float) -> float | None:
    """Shortest time (s) to cover `metres` (two pointers over the distance stream)."""
    r = best_time_for_distance_at(time, distance, metres)
    return r[0] if r else None


def best_time_for_distance_at(
    time: list, distance: list, metres: float
) -> tuple[float, float] | None:
    """Like `best_time_for_distance`, with the time the best stretch starts: (s, start)."""
    pts = [(t, d) for t, d in zip(time, distance, strict=False) if t is not None and d is not None]
    if len(pts) < 2 or pts[-1][1] - pts[0][1] < metres:
        return None
    best = None
    start = 0.0
    j = 0
    for i in range(len(pts)):
        while j < len(pts) and pts[j][1] - pts[i][1] < metres:
            j += 1
        if j >= len(pts):
            break
        # interpolate the exact moment the distance is reached between j-1 and j
        t0, d0 = pts[j - 1]
        t1, d1 = pts[j]
        need = pts[i][1] + metres
        frac = 0.0 if d1 == d0 else (need - d0) / (d1 - d0)
        elapsed = (t0 + frac * (t1 - t0)) - pts[i][0]
        if elapsed > 0 and (best is None or elapsed < best):
            best, start = elapsed, pts[i][0]
    return (best, start) if best is not None else None


def _metres(lat0: float, lon0: float, lat1: float, lon1: float) -> float:
    """Distance of two near points (equirectangular, plenty for a few metres)."""
    k = math.pi / 180
    x = (lon1 - lon0) * k * math.cos((lat0 + lat1) / 2 * k)
    return 6371000.0 * math.hypot(x, (lat1 - lat0) * k)


def top_speed_at(
    time: list,
    distance: list,
    window: int,
    lat: list | None = None,
    lon: list | None = None,
    speed: list | None = None,
) -> tuple[float, int] | None:
    """Best mean speed (m/s) over `window` seconds without GPS glitches: (speed, start second).

    The speed of each second comes from the distance between two samples. A second is not
    trusted when the samples are more than SPEED_STEP_S apart, the speed is over SPEED_MAX_MS,
    it changes by more than SPEED_ACCEL_MS2 from the stretch before (a jump of the position),
    or it disagrees with the device's own speed (Doppler or a sensor) by more than
    SPEED_AGREE_MS / SPEED_AGREE_SHARE; SPEED_PAD_S seconds around such a second are dropped
    too (the signal settles). A window counts only when every second is trusted and, with a
    track, the track's length agrees with the distance within SPEED_TRACK_SHARE."""
    n = len(time)
    pts = [
        k for k in range(n) if time[k] is not None and k < len(distance) and distance[k] is not None
    ]
    if len(pts) < 2:
        return None
    end = int(time[pts[-1]]) + 1
    v1: list[float | None] = [None] * end  # speed of each second (m/s)
    g1: list[float | None] = [None] * end  # track length in each second (m), None without
    bad = [False] * end
    prev_v = prev_dt = None
    prev_secs: range | None = None
    for k0, k1 in zip(pts, pts[1:], strict=False):
        t0, t1 = time[k0], time[k1]
        dt = t1 - t0
        if dt <= 0:
            continue
        if dt > SPEED_STEP_S:
            prev_v = None
            continue
        v = (distance[k1] - distance[k0]) / dt
        secs = range(int(t0), min(int(t1), end))
        ok = 0 <= v <= SPEED_MAX_MS
        dev = speed[k1] if speed and k1 < len(speed) else None
        if ok and dev is not None:
            ok = abs(v - dev) <= max(SPEED_AGREE_MS, SPEED_AGREE_SHARE * max(v, dev))
        if prev_v is not None and abs(v - prev_v) / ((dt + prev_dt) / 2) > SPEED_ACCEL_MS2:
            ok = False
            for s in prev_secs or ():
                bad[s] = True
        g = None
        if lat and lon and k1 < len(lat) and k1 < len(lon):
            a0, o0, a1, o1 = lat[k0], lon[k0], lat[k1], lon[k1]
            if None not in (a0, o0, a1, o1):
                g = _metres(a0, o0, a1, o1) / dt
        for s in secs:
            v1[s], g1[s] = v, g
            if not ok:
                bad[s] = True
        prev_v, prev_dt, prev_secs = v, dt, secs
    clean = list(v1)
    for s in range(end):
        if bad[s]:
            for j in range(max(0, s - SPEED_PAD_S), min(end, s + SPEED_PAD_S + 1)):
                clean[j] = None
    if end < window:
        return None
    best = None
    start = 0
    tot = tot_g = 0.0
    missing = missing_g = 0
    for i in range(end):
        v, g = clean[i], g1[i]
        if v is None:
            missing += 1
        else:
            tot += v
        if g is None:
            missing_g += 1
        else:
            tot_g += g
        if i >= window:
            ov, og = clean[i - window], g1[i - window]
            if ov is None:
                missing -= 1
            else:
                tot -= ov
            if og is None:
                missing_g -= 1
            else:
                tot_g -= og
        if i < window - 1 or missing:
            continue
        if missing_g == 0 and abs(tot_g - tot) > SPEED_TRACK_SHARE * tot:
            continue  # the track says another distance: the positions or the distance jumped
        mean = tot / window
        if best is None or mean > best:
            best, start = mean, i - window + 1
    return (best, start) if best is not None and best > 0 else None


def best_distance_in_at(time: list, distance: list, seconds: float) -> tuple[float, float] | None:
    """Longest distance (m) covered within `seconds` (two pointers over the distance stream,
    the end interpolated): (metres, start time)."""
    pts = [(t, d) for t, d in zip(time, distance, strict=False) if t is not None and d is not None]
    if len(pts) < 2 or pts[-1][0] - pts[0][0] < seconds:
        return None
    best = None
    start = 0.0
    j = 0
    for i in range(len(pts)):
        end_t = pts[i][0] + seconds
        while j < len(pts) and pts[j][0] < end_t:
            j += 1
        if j >= len(pts):
            break
        t0, d0 = pts[j - 1]
        t1, d1 = pts[j]
        frac = 0.0 if t1 == t0 else (end_t - t0) / (t1 - t0)
        metres = d0 + frac * (d1 - d0) - pts[i][1]
        if best is None or metres > best:
            best, start = metres, pts[i][0]
    return (best, start) if best else None


def clean_altitude(time: list, altitude: list) -> list[float | None]:
    """The altitude with its jumps taken out: a change faster than ALT_JUMP_MS between two samples
    (a GPS jump, the barometer set again) shifts everything after it back by that step."""
    out: list[float | None] = []
    shift = 0.0
    last_t = last_a = None
    for t, a in zip(time, altitude, strict=False):
        if t is None or a is None:
            out.append(None)
            continue
        if last_a is not None:
            dt = max(t - last_t, 1.0)
            step = a + shift - last_a
            if abs(step) / dt > ALT_JUMP_MS:
                shift -= step
        v = a + shift
        out.append(v)
        last_t, last_a = t, v
    return out


def _pivots(v: list[float], th: float = CLIMB_PIVOT_M) -> list[int]:
    """Turning points of a series, ignoring wiggles under `th`."""
    if len(v) < 2:
        return []
    piv, trend, ext = [0], 0, 0
    for i in range(1, len(v)):
        if trend == 0:
            if abs(v[i] - v[ext]) >= th:
                trend, ext = (1 if v[i] > v[ext] else -1), i
        elif trend * (v[i] - v[ext]) >= 0:
            ext = i
        elif trend * (v[ext] - v[i]) >= th:
            piv.append(ext)
            trend, ext = -trend, i
    piv.append(ext)
    return piv


def biggest_climb(dist: list[float], alt: list[float]) -> tuple[float, int, int] | None:
    """The biggest single climb of a route (distance in m, cleaned altitude, same length):
    (metres gained, first index, last index); None under CLIMB_MIN_M."""
    piv = _pivots(alt)
    best = None
    cur = None  # [i0, i1, rise of the last rise]

    def close():
        nonlocal best, cur
        if cur:
            gain = alt[cur[1]] - alt[cur[0]]
            if gain >= CLIMB_MIN_M and (best is None or gain > best[0]):
                best = (gain, cur[0], cur[1])
        cur = None

    for a, b in zip(piv, piv[1:], strict=False):
        length = dist[b] - dist[a]
        if alt[b] > alt[a]:
            if cur is None:
                cur = [a, b, length]
            else:
                cur[2] = length
                if alt[b] > alt[cur[1]]:
                    cur[1] = b
        elif (
            cur is None
            or length > CLIMB_DIP_SHARE * cur[2]
            or alt[a] - alt[b] > CLIMB_DIP_DROP * (alt[cur[1]] - alt[cur[0]])
        ):
            close()
    close()
    return best


def steepest_at(
    time: list, dist: list, alt: list, metres: float
) -> tuple[float, float, float] | None:
    """Steepest average grade (%) over `metres` of distance: (grade, start time, end time).
    A stretch counts only when the height was gained at most GRADE_MAX_VS m/s, the grade is at
    most GRADE_MAX_PCT and no GRADE_PIECE_M of it is steeper than GRADE_PIECE_PCT (else the
    distance jumped or the altitude drifted while hardly moving, e.g. the barometer indoors)."""
    pts = [(t, d, a) for t, d, a in zip(time, dist, alt, strict=False)
           if t is not None and d is not None and a is not None]  # fmt: skip
    if len(pts) < 2 or pts[-1][1] - pts[0][1] < metres:
        return None
    # samples inside a too steep piece; bad_sum[k] = how many before sample k
    bad = [False] * len(pts)
    j = 0
    for i in range(len(pts)):
        while j < len(pts) and pts[j][1] - pts[i][1] < GRADE_PIECE_M:
            j += 1
        if j >= len(pts):
            break
        if (pts[j][2] - pts[i][2]) / (pts[j][1] - pts[i][1]) * 100 > GRADE_PIECE_PCT:
            for k in range(i, j + 1):
                bad[k] = True
    bad_sum = [0]
    for b in bad:
        bad_sum.append(bad_sum[-1] + b)
    best = None
    j = 0
    for i in range(len(pts)):
        need = pts[i][1] + metres
        while j < len(pts) and pts[j][1] < need:
            j += 1
        if j >= len(pts):
            break
        t0, d0, a0 = pts[j - 1]
        t1, d1, a1 = pts[j]
        f = 0.0 if d1 == d0 else (need - d0) / (d1 - d0)
        end_t, end_a = t0 + f * (t1 - t0), a0 + f * (a1 - a0)
        gain, span = end_a - pts[i][2], end_t - pts[i][0]
        if gain <= 0 or span <= 0 or gain / span > GRADE_MAX_VS or bad_sum[j + 1] - bad_sum[i]:
            continue
        grade = gain / metres * 100
        if grade <= GRADE_MAX_PCT and (best is None or grade > best[0]):
            best = (grade, pts[i][0], end_t)
    return best


def normalized_power(power_1hz: list[float | None]) -> float | None:
    """Weighted power: 4th-power mean of the 30 s rolling average (missing samples = 0 W)."""
    p = [v or 0.0 for v in power_1hz]
    if len(p) < 30:
        return None
    acc = sum(p[:30])
    fourth = [(acc / 30) ** 4]
    for i in range(30, len(p)):
        acc += p[i] - p[i - 30]
        fourth.append((acc / 30) ** 4)
    return (sum(fourth) / len(fourth)) ** 0.25


def _trimp_weight(hrr: float) -> float:
    return hrr * 0.64 * math.exp(1.92 * hrr)


def hr_tss(hr_1hz: list[float | None], th: Thresholds) -> float | None:
    """TRIMP normalised so one hour at threshold HR = 100."""
    if not th.hr_max or not th.lthr or th.hr_rest is None or th.hr_max <= th.hr_rest:
        return None
    span = th.hr_max - th.hr_rest
    trimp = 0.0
    samples = 0
    for v in hr_1hz:
        if v is None:
            continue
        hrr = min(1.0, max(0.0, (v - th.hr_rest) / span))
        trimp += _trimp_weight(hrr) / 60.0
        samples += 1
    if samples < 60:
        return None
    ref = 60.0 * _trimp_weight(min(1.0, (th.lthr - th.hr_rest) / span))
    return trimp / ref * 100.0 if ref > 0 else None


def hr_tss_from_average(avg_hr: float, seconds: float, th: Thresholds) -> float | None:
    if not avg_hr or not seconds or seconds < 60:
        return None
    return hr_tss([avg_hr] * int(seconds), th)


# ---- per activity ------------------------------------------------------------------------


@dataclass
class Analysis:
    load: float | None
    method: str | None
    np_power: float | None
    efforts: list[tuple]  # (kind, key, value, start_s, end_s)


def _local_day(row: sqlite3.Row) -> str:
    t = datetime.strptime(row["start_time_utc"][:19], "%Y-%m-%dT%H:%M:%S")
    return (t + timedelta(seconds=row["utc_offset_s"] or 0)).date().isoformat()


def analyse(activity: sqlite3.Row, ch: dict[str, list], th: Thresholds) -> Analysis:
    time = ch.get("time") or []
    duration = activity["time_s"] or activity["timer_s"] or 0
    group = activity["category"]
    efforts: list[tuple] = []

    power = resample_1hz(time, ch["power"]) if ch.get("power") and time else []
    hr = resample_1hz(time, ch["hr"]) if ch.get("hr") and time else []

    np_power = normalized_power(power) if power else None
    t0 = next((t for t in time if t is not None), 0) or 0
    # A stop (no samples) counts as 0 W, so long durations span pauses like the ride did.
    power0 = [0.0 if v is None else v for v in power]
    for s in POWER_DURATIONS_S:
        r = best_mean_at(power0, s) if power else None
        if r is not None and r[0] > 0:
            efforts.append(("power", s, round(r[0], 1), r[1] - int(t0), r[1] - int(t0) + s))
    for s in HR_DURATIONS_S:
        r = best_mean_at(hr, s) if hr else None
        if r is not None:
            efforts.append(("hr", s, round(r[0], 1), r[1] - int(t0), r[1] - int(t0) + s))
    distances = (
        ("pace", PACE_DISTANCES_M) if group in RUN_GROUPS
        else ("ride", RIDE_DISTANCES_M) if group == "ride" else None
    )  # fmt: skip
    if distances and ch.get("distance") and time:
        for m in distances[1]:
            r = best_time_for_distance_at(time, ch["distance"], m)
            if r is not None:
                efforts.append((distances[0], m, round(r[0], 1), r[1] - t0, r[1] - t0 + r[0]))
    if group in ("run", "ride") and ch.get("distance") and ch.get("altitude") and time:
        alt = clean_altitude(time, ch["altitude"])
        dist = ch["distance"]
        n = min(len(time), len(alt), len(dist))
        keep = [k for k in range(n) if None not in (time[k], alt[k], dist[k])]
        if len(keep) > 1:
            c = biggest_climb([dist[k] for k in keep], [alt[k] for k in keep])
            if c is not None:
                s0, s1 = time[keep[c[1]]] - t0, time[keep[c[2]]] - t0
                efforts.append(("climb", 0, round(c[0], 1), s0, s1))
        for m in GRADE_DISTANCES_M:
            r = steepest_at(time, ch["distance"], alt, m)
            if r is not None:
                efforts.append(("grade", m, round(r[0], 2), r[1] - t0, r[2] - t0))
    if ch.get("distance") and time:
        for s in WITHIN_S.get(group, ()):
            r = best_distance_in_at(time, ch["distance"], s)
            if r is not None:
                efforts.append(("within", s, round(r[0], 1), r[1] - t0, r[1] - t0 + s))
    if group == "ride" and ch.get("distance") and time:
        for s in SPEED_DURATIONS_S:
            r = top_speed_at(time, ch["distance"], s, ch.get("lat"), ch.get("lon"), ch.get("speed"))
            if r is not None:
                efforts.append(("speed", s, round(r[0], 2), r[1] - int(t0), r[1] - int(t0) + s))

    load = method = None
    if np_power and th.ftp and duration:
        intensity = np_power / th.ftp
        load, method = duration * np_power * intensity / (th.ftp * 3600) * 100, "power"
    elif (
        group in RUN_GROUPS
        and th.threshold_pace
        and activity["avg_speed"]
        and duration
        and not activity["indoor"]
    ):
        intensity = activity["avg_speed"] / (1000.0 / th.threshold_pace)
        load, method = duration / 3600 * intensity**2 * 100, "pace"
    if load is None:
        v = hr_tss(hr, th) if hr else None
        if v is None and activity["avg_hr"]:
            v = hr_tss_from_average(activity["avg_hr"], duration, th)
        if v is not None:
            load, method = v, "hr"
    return Analysis(
        load=round(load, 1) if load is not None else None,
        method=method,
        np_power=round(np_power) if np_power else None,
        efforts=efforts,
    )


def _channels(conn: sqlite3.Connection, activity_id: int) -> dict[str, list]:
    return {
        r["channel"]: streams.decode(r["encoding"], r["data"])
        for r in conn.execute(
            """SELECT channel, encoding, data FROM streams
               WHERE activity_id = ?
                 AND channel IN ('time', 'hr', 'power', 'distance', 'lat', 'lon', 'speed',
                                 'altitude')""",
            (activity_id,),
        )
    }


def time_in_stream_zones(time: list, values: list, bounds: list[float]) -> list[float]:
    """Seconds in each zone, in the shape of fitfile.time_in_zones (one more entry than
    bounds): times[k] counts samples under bounds[k] and at or over bounds[k - 1]; a value over
    the last bound counts in the top zone. For heart rate (and cycling power, bounds from 0)
    times[0] is below zone 1; for running power every bound is the top of a zone. A sample
    lasts until the next one; gaps over MAX_GAP_S (pauses) count 1 s."""
    times = [0.0] * (len(bounds) + 1)
    n = min(len(time), len(values))
    for i in range(n - 1):
        v, t0, t1 = values[i], time[i], time[i + 1]
        if v is None or t0 is None or t1 is None:
            continue
        dt = t1 - t0
        dt = 1.0 if dt > MAX_GAP_S else max(0.0, dt)
        k = next((j for j, b in enumerate(bounds) if v < b), len(bounds) - 1)
        times[k] += dt
    return [round(x) for x in times]


ZONE_CHANNEL = {"hr": "hr", "power": "power"}


def _borrowed_bounds(
    conn: sqlite3.Connection, row: sqlite3.Row, kind: str
) -> tuple[list, str] | None:
    """Garmin's zone limits of the person's activity of the same sport nearest in time (heart
    rate: else of any sport; power only of the same sport - running and cycling power differ).
    Only zones from a file count, never ones computed here."""
    for same in (True, False) if kind == "hr" else (True,):
        rows = conn.execute(
            f"""SELECT zones, start_time_utc FROM activities
               WHERE person_id = ? AND zones LIKE ? AND id != ?
                     {"AND category IS ?" if same else ""}
               ORDER BY ABS(julianday(start_time_utc) - julianday(?)) LIMIT 30""",
            (
                row["person_id"],
                f'%"{kind}"%',
                row["id"],
                *([row["category"]] if same else []),
                row["start_time_utc"],
            ),
        ).fetchall()
        for r in rows:
            z = (json.loads(r["zones"]) or {}).get(kind) or {}
            if z.get("bounds") and len(z["bounds"]) >= 2 and not z.get("computed"):
                return z["bounds"], r["start_time_utc"]
    return None


def stream_zones(conn: sqlite3.Connection, row: sqlite3.Row, ch: dict | None = None) -> dict:
    """Time in heart rate and power zones from the streams, for the kinds the file has none of
    (virtual rides: apps write no time in zones), with borrowed zone limits (_borrowed_bounds),
    marked {"computed": True, "from": <that activity's start>}. Empty when nothing to add."""
    have = json.loads(row["zones"]) if row["zones"] else {}
    out: dict[str, dict] = {}
    for kind in ("hr", "power"):
        if kind in have and not have[kind].get("computed"):
            continue
        if ch is None:
            ch = _channels(conn, row["id"])
        time, vals = ch.get("time") or [], ch.get(ZONE_CHANNEL[kind]) or []
        if not any(v for v in vals if v):
            continue
        found = _borrowed_bounds(conn, row, kind)
        if not found:
            continue
        times = time_in_stream_zones(time, vals, found[0])
        if any(times):
            out[kind] = {"times": times, "bounds": found[0], "computed": True, "from": found[1]}
    return out


# Apps whose routes are a made-up world placed somewhere at sea: no country.
MADE_UP_WORLDS = ("zwift",)


def route_country(a: sqlite3.Row, ch: dict[str, list]) -> str | None:
    """Country code of the route (countries.of_route); None without GPS or in a made-up world."""
    if not a["has_gps"] or str(a["device"] or "").split(" ")[0] in MADE_UP_WORLDS:
        return None
    return countries.of_route((a["start_lat"], a["start_lon"]), ch.get("lat"), ch.get("lon"))


def backfill(conn: sqlite3.Connection, progress: ProgressFn | None = None) -> int:
    """Analyse every activity whose analysis is missing or outdated. Returns the count."""
    todo = conn.execute(
        "SELECT id FROM activities WHERE analysis_version < ? ORDER BY start_time_utc",
        (ANALYSIS_VERSION,),
    ).fetchall()
    cache: dict[str, tuple] = {}
    for i, (activity_id,) in enumerate(todo, 1):
        analyse_one(conn, activity_id, cache)
        if progress and (i % 20 == 0 or i == len(todo)):
            progress(i, len(todo))
    return len(todo)


def activity_thresholds(
    conn: sqlite3.Connection, a: sqlite3.Row, cache: dict | None = None
) -> Thresholds:
    """Thresholds valid for the activity (its own watch values first). `cache` keeps the
    person's rows between calls."""
    pid, group = a["person_id"], ftp_group(a["category"])
    per = (cache if cache is not None else {}).setdefault("thresholds", {})
    if (pid, group) not in per:
        per[(pid, group)] = (
            threshold_rows(conn, pid), auto_hr_max(conn, pid), watch_history(conn, pid, group)
        )  # fmt: skip
    rows, auto_max, history = per[(pid, group)]
    day = _local_day(a)
    watch, _ = watch_on(history, day)
    own = {k: a[f"watch_{k}"] for k in WATCH_FIELDS if a[f"watch_{k}"] is not None}
    if group is None:
        own.pop("ftp", None)
    th = thresholds_for(rows, day, auto_max, {**watch, **own})
    if a["ftp_override"]:  # the person corrected the FTP of this activity
        th.ftp = a["ftp_override"]
        th.sources = {**(th.sources or {}), "ftp": "activity"}
    return th


def analyse_one(
    conn: sqlite3.Connection, activity_id: int, cache: dict | None = None
) -> Analysis | None:
    """(Re)analyse one activity and store its load and best efforts."""
    a = conn.execute("SELECT * FROM activities WHERE id = ?", (activity_id,)).fetchone()
    if a is None:
        return None
    cache = {} if cache is None else cache
    th = activity_thresholds(conn, a, cache)
    ch = _channels(conn, activity_id)
    result = analyse(a, ch, th)
    computed = stream_zones(conn, a, ch)
    zones = None
    if computed:
        zones = json.loads(a["zones"]) if a["zones"] else {}
        zones.update(computed)
        zones = json.dumps(zones, separators=(",", ":"))
    country = route_country(a, ch)
    used = METHOD_FIELDS.get(result.method or "", ())
    estimated = int(any((th.sources or {}).get(f) in ("auto", "default") for f in used))
    conn.execute("BEGIN")
    try:
        conn.execute("DELETE FROM best_efforts WHERE activity_id = ?", (activity_id,))
        conn.executemany(
            """INSERT INTO best_efforts (activity_id, kind, key, value, start_s, end_s)
               VALUES (?, ?, ?, ?, ?, ?)""",
            [(activity_id, *e) for e in result.efforts],
        )
        conn.execute(
            """UPDATE activities SET load = ?, load_method = ?, load_estimated = ?,
                      np_power = COALESCE(np_power, ?), zones = COALESCE(?, zones),
                      country = ?, analysis_version = ? WHERE id = ?""",
            (result.load, result.method, estimated, result.np_power, zones, country,
             ANALYSIS_VERSION, activity_id),
        )  # fmt: skip
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return result


# Thresholds each load method depends on (for `load_estimated`).
METHOD_FIELDS = {
    "power": ("ftp",),
    "pace": ("threshold_pace",),
    "hr": ("hr_max", "hr_rest", "lthr"),
}


# A watch value further away from the activity than this is flagged as borrowed.
STALE_DAYS = 365


def threshold_warnings(
    conn: sqlite3.Connection,
    person_id: str,
    since: str = "",
    until: str = "",
    accepted: set[str] | frozenset = frozenset(),
) -> list[dict]:
    """Problems that can really distort the load of the period's activities (SPEC §7.2):
    - `missing`: a value the load method needs has no basis in the person's data (resting
      HR default, HR max from the highest recorded HR) and was not accepted as estimate;
    - `stale`: a year whose activities borrow a watch value more than a year away.
    Threshold HR derived from a watch HR max is a normal estimate, not a warning."""
    rows = threshold_rows(conn, person_id)
    auto_max = auto_hr_max(conn, person_id)
    histories = {g: watch_history(conn, person_id, g) for g in (*FTP_GROUPS, None)}
    missing: dict[str, dict] = {}
    stale: dict[str, str] = {}  # year → farthest source day
    for day, method, category in conn.execute(
        f"""SELECT {LOCAL_DAY_SQL} AS d, load_method, category FROM activities
            WHERE person_id = ? AND load IS NOT NULL
              AND (? = '' OR {LOCAL_DAY_SQL} >= ?) AND (? = '' OR {LOCAL_DAY_SQL} <= ?)""",
        (person_id, since, since, until, until),
    ):
        watch, wdays = watch_days(histories[ftp_group(category)], day)
        th = thresholds_for(rows, day, auto_max, watch)
        src = th.sources or {}
        for f in METHOD_FIELDS.get(method or "", ()):
            weak = src.get(f) == "default" or (f == "hr_max" and src.get(f) == "auto")
            if weak and f not in accepted:
                missing.setdefault(f, {"kind": "missing", "field": f, "value": getattr(th, f),
                                       "source": src.get(f)})  # fmt: skip
            if src.get(f) == "watch":
                gap = abs((date.fromisoformat(day) - date.fromisoformat(wdays[f])).days)
                if gap > STALE_DAYS:
                    y = day[:4]
                    far = stale.get(y)
                    if far is None or abs(int(wdays[f][:4]) - int(y)) > abs(int(far[:4]) - int(y)):
                        stale[y] = wdays[f]
    return [
        *missing.values(),
        *({"kind": "stale", "year": y, "from": d} for y, d in sorted(stale.items())),
    ]


def reset_person(conn: sqlite3.Connection, person_id: str) -> int:
    """Thresholds changed: analyse this person's activities again on the next run."""
    return conn.execute(
        "UPDATE activities SET analysis_version = 0, workout_version = 0 WHERE person_id = ?",
        (person_id,),
    ).rowcount


# ---- fitness model -----------------------------------------------------------------------

LOCAL_DAY_SQL = "date(start_time_utc, printf('%+d seconds', COALESCE(utc_offset_s, 0)))"


def daily_loads(conn: sqlite3.Connection, person_id: str) -> dict[str, float]:
    return {
        r[0]: r[1]
        for r in conn.execute(
            f"""SELECT {LOCAL_DAY_SQL} AS day, SUM(load) FROM activities
                WHERE person_id = ? AND load IS NOT NULL GROUP BY day""",
            (person_id,),
        )
    }


def fitness_series(loads: dict[str, float], until: date | None = None) -> list[dict]:
    """CTL / ATL as exponentially weighted averages of the daily load; TSB = form, from
    yesterday's CTL − ATL (how fresh you are going into the day)."""
    if not loads:
        return []
    day = date.fromisoformat(min(loads))
    end = until or datetime.now(UTC).date()
    end = max(end, date.fromisoformat(max(loads)))
    kc, ka = 1 - math.exp(-1 / CTL_DAYS), 1 - math.exp(-1 / ATL_DAYS)
    ctl = atl = 0.0
    out = []
    while day <= end:
        key = day.isoformat()
        load = loads.get(key, 0.0)
        tsb = ctl - atl
        ctl += (load - ctl) * kc
        atl += (load - atl) * ka
        out.append(
            {"date": key, "load": round(load, 1), "ctl": round(ctl, 1),
             "atl": round(atl, 1), "tsb": round(tsb, 1)}
        )  # fmt: skip
        day += timedelta(days=1)
    return out


# ---- daily values from the watch (Calendar) ------------------------------------------------

FLOOR_M = 3.048  # one floor climbed = 10 ft of ascent, as the watch counts them


def daily_values(conn: sqlite3.Connection, person_id: str, start: str, end: str) -> dict:
    """Steps, floors, ascent and average stress per local day (monitoring files, see
    fitfile.parse_monitoring): {day: {"steps", "floors", "ascent_m", "stress"}}, a value is
    None when the day has none. Running totals take the largest value of the day's files."""
    rows = conn.execute(
        """WITH m AS (
               SELECT p.day, p.metric, MAX(p.value) v, SUM(p.value) s, SUM(p.n) n
               FROM daily_parts p JOIN files f ON f.id = p.file_id
               WHERE f.person_id = ? AND p.day BETWEEN ? AND ?
               GROUP BY p.day, p.metric)
           SELECT day,
                  SUM(CASE WHEN metric LIKE 'steps:%' THEN v END) steps,
                  MAX(CASE WHEN metric = 'ascent_mm' THEN v END) ascent_mm,
                  SUM(CASE WHEN metric = 'stress' THEN s END) stress_sum,
                  SUM(CASE WHEN metric = 'stress' THEN n END) stress_n
           FROM m GROUP BY day""",
        (person_id, start, end),
    ).fetchall()
    out = {}
    for r in rows:
        asc = r["ascent_mm"]
        out[r["day"]] = {
            "steps": int(r["steps"]) if r["steps"] is not None else None,
            "floors": int(asc / 1000 / FLOOR_M) if asc is not None else None,
            "ascent_m": round(asc / 1000, 1) if asc is not None else None,
            "stress": round(r["stress_sum"] / r["stress_n"]) if r["stress_n"] else None,
        }
    # Garmin Connect's daily summary (garmin.fetch_days) wins: Garmin's own result
    for day, text in conn.execute(
        "SELECT day, summary FROM garmin_days WHERE person_id = ? AND day BETWEEN ? AND ?",
        (person_id, start, end),
    ):
        api = garmin_day_values(json.loads(text))
        merged = out.get(day, dict.fromkeys(("steps", "floors", "ascent_m", "stress")))
        out[day] = {k: (api[k] if api[k] is not None else merged[k]) for k in merged}
    return out


def garmin_day_values(s: dict) -> dict:
    """Steps, floors, ascent and average stress from a Garmin Connect daily summary; None
    where Garmin has no value (a negative stress level = not measured)."""

    def pick(*path):
        v = s
        for k in path:
            v = v.get(k) if isinstance(v, dict) else None
        return v if isinstance(v, (int, float)) else None

    stress = pick("stress", "avgLevel")
    asc = pick("movement", "floorsAscended", "distanceInMeters")
    floors = pick("movement", "floorsAscended", "value")
    return {
        "steps": int(v) if (v := pick("movement", "steps", "value")) is not None else None,
        "floors": int(floors) if floors is not None else None,
        "ascent_m": round(asc, 1) if asc is not None else None,
        "stress": round(stress) if stress is not None and stress >= 0 else None,
    }
