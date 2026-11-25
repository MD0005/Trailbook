"""Wellbeing: Movement - the daily values of one person (steps, floors, intensity minutes,
calories) - and Body (weigh-ins from scale files and Garmin Connect). Steps and floors come
from analysis.daily_values (monitoring files, the Garmin Connect daily summary wins);
intensity minutes, calories and the intensity goal only from the Garmin Connect daily summary.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import date, timedelta

from . import analysis

INTENSITY_GOAL = 150  # minutes a week (Garmin's default)


def _pick(s: dict, *path):
    v = s
    for k in path:
        v = v.get(k) if isinstance(v, dict) else None
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0 else None


def movement_days(conn: sqlite3.Connection, person_id: str, start: str, end: str) -> list[dict]:
    """One row per day with any value, oldest first: steps, floors, intensity (vigorous
    minutes counted twice, as Garmin), intensity_goal (a week; a day without one keeps the last
    goal known before), calories_active, calories_total."""
    base = analysis.daily_values(conn, person_id, start, end)
    api = {
        day: json.loads(text)
        for day, text in conn.execute(
            "SELECT day, summary FROM garmin_days WHERE person_id = ? AND day BETWEEN ? AND ?",
            (person_id, start, end),
        )
    }
    # the goal in force when the period starts (the latest one before it)
    prev = conn.execute(
        "SELECT summary FROM garmin_days WHERE person_id = ? AND day < ? ORDER BY day DESC LIMIT 1",
        (person_id, start),
    ).fetchone()
    first = json.loads(prev[0]) if prev else {}
    igoal = _pick(first, "intensityMinutes", "goal") or INTENSITY_GOAL
    out = []
    for day in sorted(set(base) | set(api)):
        s = api.get(day, {})
        igoal = _pick(s, "intensityMinutes", "goal") or igoal
        b = base.get(day, {})
        mod = _pick(s, "intensityMinutes", "moderate")
        vig = _pick(s, "intensityMinutes", "vigorous")
        row = {
            "day": day,
            "steps": b.get("steps"),
            "floors": b.get("floors"),
            "intensity": None if mod is None and vig is None else int((mod or 0) + 2 * (vig or 0)),
            "intensity_goal": int(igoal),
            "calories_active": _pick(s, "calories", "burnedActive"),
            "calories_total": _pick(s, "calories", "burnedTotal"),
        }
        if any(row[k] is not None for k in ("steps", "floors", "intensity", "calories_total")):
            out.append(row)
    return out


def body_rows(conn: sqlite3.Connection, person_id: str, start: str, end: str) -> list[dict]:
    """Weigh-ins of the days start … end (UTC days), oldest first: ts, day, weight, fat_pct,
    water_pct, muscle_kg, bone_kg, bmi; the same moment from two files once."""
    keys = ("weight", "fat_pct", "water_pct", "muscle_kg", "bone_kg", "bmi")
    files = conn.execute(
        """SELECT b.ts, b.weight, b.fat_pct, b.water_pct, b.muscle_kg, b.bone_kg, b.bmi
           FROM body_parts b JOIN files f ON f.id = b.file_id
           WHERE f.person_id = ? AND substr(b.ts, 1, 10) BETWEEN ? AND ?""",
        (person_id, start, end),
    ).fetchall()
    api = conn.execute(
        """SELECT ts, weight, fat_pct, water_pct, muscle_kg, bone_kg, bmi FROM garmin_weights
           WHERE person_id = ? AND substr(ts, 1, 10) BETWEEN ? AND ?""",
        (person_id, start, end),
    ).fetchall()
    # one weigh-in from a scale file and from Garmin Connect (the same minute) counts once:
    # the file's values, Garmin's where the file has none
    out: dict[str, dict] = {}
    for r in [*files, *api]:
        key = r["ts"][:16]
        row = out.setdefault(key, {"ts": r["ts"], "day": r["ts"][:10], **dict.fromkeys(keys)})
        for k in keys:
            if row[k] is None and r[k] is not None:
                row[k] = r[k]
    return [out[k] for k in sorted(out)]


def span(first: str | None, since: str | None, until: str | None, years: list[str]) -> tuple:
    """The days the time filter covers: (start, end), local days inclusive; from the first
    day with data when the filter has no start."""
    today = date.today().isoformat()
    if years:
        return f"{min(years)}-01-01", min(f"{max(years)}-12-31", today)
    start = since or first or (date.today() - timedelta(days=730)).isoformat()
    return start, min(until or today, today)
