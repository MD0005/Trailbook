"""Weather during an activity, from Open-Meteo (hourly model data, no key needed).

FIT files and the Garmin personal API carry no weather, so the hour(s) of the activity are
looked up by place and time: the start point and, for routes longer than LONG_M, also the
middle and the end. Coordinates are rounded to 0.01° (~1 km) before they are sent; the model
grid is 9-25 km anyway. Times are UTC. Recent days come from the forecast API (it keeps about
3 months back), older ones from the historical archive. The result is cached per activity:

    {"version": 1, "temp": °C, "temp_min": °C, "temp_max": °C, "wind_speed": km/h,
     "wind_dir": ° (where the wind comes from), "rain": mm, "precip": mm, "code": WMO code,
     "points": n}

Hourly and area values: an estimate for the hour and the area, not the exact street.
"""

from __future__ import annotations

import json
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime, timedelta

from . import __version__, streams

WEATHER_VERSION = 1
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
FORECAST_DAYS_BACK = 80  # newer than this: forecast API; older: archive
LONG_M = 30_000
USER_AGENT = f"Trailbook/{__version__} (self-hosted training log; weather)"
HOURLY = "temperature_2m,wind_speed_10m,wind_direction_10m,rain,precipitation,weather_code"
TIMEOUT_S = 30


def _points(conn: sqlite3.Connection, activity_id: int) -> list[tuple[float, float, float]]:
    """(lat, lon, seconds from the start) of the start, and middle and end on long routes."""
    ch = {
        r["channel"]: streams.decode(r["encoding"], r["data"])
        for r in conn.execute(
            """SELECT channel, encoding, data FROM streams
               WHERE activity_id = ? AND channel IN ('lat', 'lon', 'time')""",
            (activity_id,),
        )
    }
    lat, lon, t = ch.get("lat") or [], ch.get("lon") or [], ch.get("time") or []
    idx = [i for i in range(min(len(lat), len(lon))) if lat[i] is not None and lon[i] is not None]
    if not idx:
        return []
    dist = conn.execute("SELECT distance_m FROM activities WHERE id = ?", (activity_id,)).fetchone()
    picks = [idx[0]]
    if dist and (dist[0] or 0) >= LONG_M:
        picks += [idx[len(idx) // 2], idx[-1]]
    return [(lat[i], lon[i], (t[i] if i < len(t) and t[i] is not None else 0.0)) for i in picks]


def _fetch(lat: float, lon: float, day: str, url: str) -> dict:
    q = urllib.parse.urlencode({
        "latitude": f"{lat:.2f}", "longitude": f"{lon:.2f}", "start_date": day, "end_date": day,
        "hourly": HOURLY, "timezone": "UTC", "wind_speed_unit": "kmh",
    })  # fmt: skip
    req = urllib.request.Request(f"{url}?{q}", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return json.loads(resp.read())


def _hour(data: dict, when: datetime) -> dict | None:
    h = data.get("hourly") or {}
    times = h.get("time") or []
    key = when.replace(minute=0, second=0, microsecond=0)
    if when.minute >= 30:
        key += timedelta(hours=1)
    stamp = key.strftime("%Y-%m-%dT%H:%M")
    if stamp not in times:
        return None
    i = times.index(stamp)
    return {k: (h.get(k) or [None] * len(times))[i] for k in HOURLY.split(",")}


def compute(conn: sqlite3.Connection, activity_id: int) -> dict | None:
    """Weather of an activity (cached in activities.weather). None without a route.

    Raises OSError when Open-Meteo cannot be reached (nothing is cached then)."""
    row = conn.execute(
        "SELECT start_time_utc, weather FROM activities WHERE id = ?", (activity_id,)
    ).fetchone()
    if row is None:
        return None
    if row["weather"]:
        cached = json.loads(row["weather"])
        if cached.get("version") == WEATHER_VERSION:
            return cached if cached.get("points") else None
    start = datetime.strptime(row["start_time_utc"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    points = _points(conn, activity_id)
    result: dict = {"version": WEATHER_VERSION, "points": 0}
    if points:
        recent = datetime.now(UTC) - start < timedelta(days=FORECAST_DAYS_BACK)
        url = FORECAST_URL if recent else ARCHIVE_URL
        hours = []
        try:
            for lat, lon, off in points:
                when = start + timedelta(seconds=off)
                got = _hour(_fetch(lat, lon, when.strftime("%Y-%m-%d"), url), when)
                if got and got.get("temperature_2m") is not None:
                    hours.append(got)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise OSError(f"weather server: {exc}") from exc
        if hours:
            temps = [x["temperature_2m"] for x in hours]
            first = hours[0]
            result.update({
                "points": len(hours),
                "temp": round(sum(temps) / len(temps), 1),
                "temp_min": min(temps), "temp_max": max(temps),
                "wind_speed": round(max(x["wind_speed_10m"] or 0 for x in hours), 1),
                "wind_dir": first.get("wind_direction_10m"),
                "rain": round(sum(x["rain"] or 0 for x in hours), 1),
                "precip": round(sum(x["precipitation"] or 0 for x in hours), 1),
                "code": max((x["weather_code"] or 0) for x in hours),
            })  # fmt: skip
    conn.execute(
        "UPDATE activities SET weather = ? WHERE id = ?",
        (json.dumps(result, separators=(",", ":")), activity_id),
    )
    conn.commit()
    return result if result["points"] else None
