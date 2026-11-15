"""Derived analysis: training load per activity, best efforts and the fitness model.

Runs after import in the low-priority importer process (like the explorer tiles): every
activity with `analysis_version` older than ANALYSIS_VERSION is (re)analysed from its
stored streams. Changing a person's thresholds resets the version of that person's
activities, so the next run recomputes their load.

Training load, first method that has the data (SPEC §7.3):
  1. power TSS   — power stream + FTP
  2. pace rTSS   — running types, speed + threshold pace
  3. hrTSS       — heart rate + threshold HR (TRIMP-based, Banister)
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

import math
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

from . import streams

# v2: watch thresholds, load_estimated; v3: effort positions, ride; v4: 30 km ride;
# v5: power over pauses, up to 5 h
ANALYSIS_VERSION = 5

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


def watch_history(conn: sqlite3.Connection, person_id: str) -> list[tuple[str, dict]]:
    """(local day, watch thresholds) of the person's activities that have any, by day."""
    cols = ", ".join(f"watch_{k}" for k in WATCH_FIELDS)
    out = []
    for r in conn.execute(
        f"""SELECT {LOCAL_DAY_SQL} AS day, {cols} FROM activities
            WHERE person_id = ? AND ({" OR ".join(f"watch_{k} IS NOT NULL" for k in WATCH_FIELDS)})
            ORDER BY start_time_utc""",
        (person_id,),
    ):
        out.append((r[0], {k: r[i + 1] for i, k in enumerate(WATCH_FIELDS)}))
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


def normalized_power(power_1hz: list[float | None]) -> float | None:
    """Coggan NP: 4th-power mean of the 30 s rolling average (missing samples = 0 W)."""
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
    duration = activity["moving_s"] or activity["timer_s"] or 0
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
               WHERE activity_id = ? AND channel IN ('time', 'hr', 'power', 'distance')""",
            (activity_id,),
        )
    }


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


def analyse_one(
    conn: sqlite3.Connection, activity_id: int, cache: dict | None = None
) -> Analysis | None:
    """(Re)analyse one activity and store its load and best efforts."""
    a = conn.execute("SELECT * FROM activities WHERE id = ?", (activity_id,)).fetchone()
    if a is None:
        return None
    pid = a["person_id"]
    cache = {} if cache is None else cache
    if pid not in cache:
        cache[pid] = (threshold_rows(conn, pid), auto_hr_max(conn, pid), watch_history(conn, pid))
    rows, auto_max, history = cache[pid]
    day = _local_day(a)
    watch, _ = watch_on(history, day)
    own = {k: a[f"watch_{k}"] for k in WATCH_FIELDS if a[f"watch_{k}"] is not None}
    th = thresholds_for(rows, day, auto_max, {**watch, **own})
    result = analyse(a, _channels(conn, activity_id), th)
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
                      np_power = COALESCE(np_power, ?), analysis_version = ? WHERE id = ?""",
            (result.load, result.method, estimated, result.np_power, ANALYSIS_VERSION, activity_id),
        )
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
    history = watch_history(conn, person_id)
    missing: dict[str, dict] = {}
    stale: dict[str, str] = {}  # year → farthest source day
    for day, method in conn.execute(
        f"""SELECT {LOCAL_DAY_SQL} AS d, load_method FROM activities
            WHERE person_id = ? AND load IS NOT NULL
              AND (? = '' OR {LOCAL_DAY_SQL} >= ?) AND (? = '' OR {LOCAL_DAY_SQL} <= ?)""",
        (person_id, since, since, until, until),
    ):
        watch, wdays = watch_days(history, day)
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
        "UPDATE activities SET analysis_version = 0 WHERE person_id = ?", (person_id,)
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
