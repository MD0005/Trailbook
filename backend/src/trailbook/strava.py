"""Strava bulk export: `activities.csv` (titles, types, descriptions, manual activities).

The export ZIP holds `activities.csv` and `activities/` with the recorded files: the original
`.fit` (often `.fit.gz`) of watch recordings, `.gpx` / `.tcx` (also gzipped) of app
recordings and older uploads. Activities entered by hand have only a CSV row; they are
imported from it as activities without a route (file rows `activities.csv#<id>`).
"""

from __future__ import annotations

import csv
import io
import re
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from . import fitfile, trackfile
from .sports import classify

CSV_NAME = "activities.csv"
MANUAL_MARK = "#"  # zip member "activities.csv#123" = manual activity 123


@dataclass
class Row:
    activity_id: str
    filename: str | None
    title: str | None
    kind: str | None  # Strava activity type, e.g. "Run"
    description: str | None
    start: datetime | None
    values: dict[str, float]  # numeric columns, see _NUMERIC


# Numeric columns (lower-case header) → summary key. The export repeats some headers (first
# a rounded copy in the athlete's units, later the exact SI value); the last one is used.
_NUMERIC = {
    "elapsed time": "elapsed_s",
    "moving time": "moving_s",
    "distance": "distance_m",
    "max speed": "max_speed",
    "average speed": "avg_speed",
    "elevation gain": "ascent_m",
    "elevation loss": "descent_m",
    "max heart rate": "max_hr",
    "average heart rate": "avg_hr",
    "max watts": "max_power",
    "average watts": "avg_power",
    "weighted average power": "np_power",
    "max cadence": "max_cadence",
    "average cadence": "avg_cadence",
    "calories": "calories",
}

_DATE_FORMATS = (
    "%b %d, %Y, %I:%M:%S %p",
    "%b %d, %Y %I:%M:%S %p",
    "%d %b %Y, %H:%M:%S",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M:%SZ",
)


def parse_date(text: str) -> datetime | None:
    """`Activity Date` (UTC) as Strava writes it, e.g. "Mar 14, 2021, 8:05:21 AM"."""
    text = re.sub(r"\s+", " ", text.replace(" ", " ").replace("\xa0", " ")).strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=UTC)
        except ValueError:
            continue
    return None


def _number(text: str) -> float | None:
    text = text.strip().replace(",", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_csv(text: str, base: str = "") -> dict[str, Row]:
    """Rows of activities.csv by key: the file path inside the ZIP (`base` + Filename) for
    recorded activities, `activities.csv#<Activity ID>` for manual ones."""
    reader = csv.reader(io.StringIO(text))
    header = [h.strip().lower() for h in next(reader, [])]
    first: dict[str, int] = {}
    last: dict[str, int] = {}
    for i, h in enumerate(header):
        first.setdefault(h, i)
        last[h] = i
    if "activity id" not in first:
        return {}

    def text_of(r: list[str], name: str) -> str | None:
        i = first.get(name)
        return (r[i].strip() or None) if i is not None and i < len(r) else None

    out: dict[str, Row] = {}
    for r in reader:
        aid = text_of(r, "activity id")
        if not aid:
            continue
        values = {}
        for col, key in _NUMERIC.items():
            i = last.get(col)
            v = _number(r[i]) if i is not None and i < len(r) else None
            if v is not None:
                values[key] = v
        if "distance_m" in values and first.get("distance") == last.get("distance"):
            values["distance_m"] *= 1000  # older exports: only the km column
        date = text_of(r, "activity date")
        row = Row(
            activity_id=aid,
            filename=text_of(r, "filename"),
            title=text_of(r, "activity name"),
            kind=text_of(r, "activity type"),
            description=text_of(r, "activity description"),
            start=parse_date(date) if date else None,
            values=values,
        )
        key = base + row.filename if row.filename else f"{base}{CSV_NAME}{MANUAL_MARK}{aid}"
        out[key] = row
    return out


def find_csv(names: list[str]) -> str | None:
    """The export's activities.csv (the one closest to the ZIP root)."""
    found = [n for n in names if n.rsplit("/", 1)[-1].lower() == CSV_NAME]
    return min(found, key=len) if found else None


def read_zip(zf: zipfile.ZipFile) -> dict[str, Row]:
    name = find_csv(zf.namelist())
    if name is None:
        return {}
    text = zf.read(name).decode("utf-8-sig", errors="replace")
    return parse_csv(text, name[: -len(CSV_NAME)])


_cache: dict[tuple[str, float, int], dict[str, Row]] = {}


def rows_of(zip_path: Path) -> dict[str, Row]:
    """activities.csv of a ZIP, cached while the ZIP is unchanged (one ZIP at a time)."""
    try:
        st = zip_path.stat()
    except OSError:
        return {}
    key = (str(zip_path), st.st_mtime, st.st_size)
    if key not in _cache:
        try:
            with zipfile.ZipFile(zip_path) as zf:
                rows = read_zip(zf)
        except (OSError, zipfile.BadZipFile, KeyError):
            rows = {}
        _cache.clear()
        _cache[key] = rows
    return _cache[key]


def manual_members(rows: dict[str, Row]) -> list[str]:
    return sorted(k for k in rows if MANUAL_MARK in k.rsplit("/", 1)[-1])


def is_manual(member: str) -> bool:
    return MANUAL_MARK in member.rsplit("/", 1)[-1]


def apply(parsed: fitfile.ParsedActivity, row: Row, *, from_file_only: bool) -> None:
    """Fill a parsed activity with what the CSV knows: title and description always; the
    sport when the file has none (GPX/TCX); totals only where the file has no value."""
    parsed.title = row.title or parsed.title
    parsed.description = row.description
    if from_file_only and row.kind:
        sport, sub_sport = trackfile.sport_of(row.kind)
        if sport and (parsed.sport is None or parsed.activity_type == "other"):
            parsed.sport, parsed.sub_sport = sport, sub_sport
            parsed.category, parsed.activity_type, parsed.indoor = classify(sport, sub_sport)
    for key in ("calories", "avg_power", "max_power", "np_power"):
        if parsed.summary.get(key) is None and row.values.get(key) is not None:
            parsed.summary[key] = round(row.values[key])


def manual_activity(row: Row) -> fitfile.ParsedActivity:
    """An activity entered by hand on Strava: totals only, no route or streams."""
    if row.start is None:
        raise trackfile.TrackFileError("manual activity without a date")
    sport, sub_sport = trackfile.sport_of(row.kind)
    category, activity_type, indoor = classify(sport, sub_sport)
    v = row.values
    elapsed = v.get("elapsed_s")
    moving = v.get("moving_s") or elapsed
    distance = v.get("distance_m")
    summary = {
        "elapsed_s": elapsed,
        "timer_s": elapsed,
        "moving_s": moving,
        "distance_m": distance,
        "ascent_m": v.get("ascent_m"),
        "descent_m": v.get("descent_m"),
        "avg_hr": round(v["avg_hr"]) if v.get("avg_hr") else None,
        "max_hr": round(v["max_hr"]) if v.get("max_hr") else None,
        "avg_speed": v.get("avg_speed") or (distance / moving if distance and moving else None),
        "max_speed": v.get("max_speed"),
        "avg_power": round(v["avg_power"]) if v.get("avg_power") else None,
        "max_power": round(v["max_power"]) if v.get("max_power") else None,
        "np_power": round(v["np_power"]) if v.get("np_power") else None,
        "avg_cadence": v.get("avg_cadence"),
        "max_cadence": v.get("max_cadence"),
        "calories": round(v["calories"]) if v.get("calories") else None,
        "metabolic_calories": None,
        "zones": None,
        "devices": None,
        "has_gps": 0,
    }
    return fitfile.ParsedActivity(
        fit_uid=f"strava:{row.activity_id}",
        start_time=row.start,
        utc_offset_s=None,
        sport=sport,
        sub_sport=sub_sport,
        category=category,
        activity_type=activity_type,
        indoor=indoor,
        name=None,
        device=None,
        summary=summary,
        track=[],
        streams={},
        title=row.title,
        description=row.description,
    )
