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
Thresholds come from `person_thresholds` (latest row valid on the activity day); missing
HR values are estimated from the person's own data (HR max = highest max HR recorded,
HR rest = 60 bpm, threshold HR = 90 % of HR max).

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

ANALYSIS_VERSION = 1

# Best efforts (SPEC §7.5). Pace: metres → best time in s. Power / HR: seconds → best mean.
PACE_DISTANCES_M = (400, 1000, 1609.344, 5000, 10000, 21097.5, 42195)
POWER_DURATIONS_S = (5, 15, 30, 60, 300, 600, 1200, 3600)
HR_DURATIONS_S = (60, 300, 1200, 3600)
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
    sources: dict | None = None  # field → "set" | "auto" | "default"


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


def thresholds_for(rows: list[sqlite3.Row], day: str, auto_max: int | None) -> Thresholds:
    """Thresholds valid on `day` (YYYY-MM-DD); each field from the latest row that sets it."""
    values: dict = {}
    sources: dict = {}
    for r in rows:
        if r["valid_from"] > day:
            break
        for f in THRESHOLD_FIELDS:
            if r[f] is not None:
                values[f] = r[f]
                sources[f] = "set"
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
    n = len(series)
    if n < window or window <= 0:
        return None
    best = None
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
                best = mean
    return best


def best_time_for_distance(time: list, distance: list, metres: float) -> float | None:
    """Shortest time (s) to cover `metres` (two pointers over the distance stream)."""
    pts = [(t, d) for t, d in zip(time, distance, strict=False) if t is not None and d is not None]
    if len(pts) < 2 or pts[-1][1] - pts[0][1] < metres:
        return None
    best = None
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
            best = elapsed
    return best


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
    efforts: list[tuple[str, float, float]]  # (kind, key, value)


def _local_day(row: sqlite3.Row) -> str:
    t = datetime.strptime(row["start_time_utc"][:19], "%Y-%m-%dT%H:%M:%S")
    return (t + timedelta(seconds=row["utc_offset_s"] or 0)).date().isoformat()


def analyse(activity: sqlite3.Row, ch: dict[str, list], th: Thresholds) -> Analysis:
    time = ch.get("time") or []
    duration = activity["moving_s"] or activity["timer_s"] or 0
    group = activity["category"]
    efforts: list[tuple[str, float, float]] = []

    power = resample_1hz(time, ch["power"]) if ch.get("power") and time else []
    hr = resample_1hz(time, ch["hr"]) if ch.get("hr") and time else []

    np_power = normalized_power(power) if power else None
    for s in POWER_DURATIONS_S:
        v = best_mean(power, s) if power else None
        if v is not None and v > 0:
            efforts.append(("power", s, round(v, 1)))
    for s in HR_DURATIONS_S:
        v = best_mean(hr, s) if hr else None
        if v is not None:
            efforts.append(("hr", s, round(v, 1)))
    if group in RUN_GROUPS and ch.get("distance") and time:
        for m in PACE_DISTANCES_M:
            v = best_time_for_distance(time, ch["distance"], m)
            if v is not None:
                efforts.append(("pace", m, round(v, 1)))

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
    cache: dict[str, tuple[list, int | None]] = {}
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
        cache[pid] = (threshold_rows(conn, pid), auto_hr_max(conn, pid))
    rows, auto_max = cache[pid]
    th = thresholds_for(rows, _local_day(a), auto_max)
    result = analyse(a, _channels(conn, activity_id), th)
    conn.execute("BEGIN")
    try:
        conn.execute("DELETE FROM best_efforts WHERE activity_id = ?", (activity_id,))
        conn.executemany(
            "INSERT INTO best_efforts (activity_id, kind, key, value) VALUES (?, ?, ?, ?)",
            [(activity_id, k, key, v) for k, key, v in result.efforts],
        )
        conn.execute(
            """UPDATE activities SET load = ?, load_method = ?,
                      np_power = COALESCE(np_power, ?), analysis_version = ? WHERE id = ?""",
            (result.load, result.method, result.np_power, ANALYSIS_VERSION, activity_id),
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return result


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
