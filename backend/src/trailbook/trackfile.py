"""GPX and TCX activities (Strava exports, older apps and watches) as `ParsedActivity`.

Only the standard library is used. The files carry less than FIT: no laps in GPX, no time
zone and often no sport, so the importer fills in what is missing (see `importer`).
"""

from __future__ import annotations

import gzip
import math
import zlib
from datetime import UTC, datetime
from xml.etree import ElementTree as ET

from . import fitfile
from .geo import EARTH_RADIUS_M
from .sports import ON_FOOT_GROUPS, classify

# Suffixes the importer reads in folders, ZIPs and uploads.
ACTIVITY_SUFFIXES = (".fit", ".fit.gz", ".gpx", ".gpx.gz", ".tcx", ".tcx.gz")

# Altitude must change by this much before it counts as a climb (GPS/barometer noise).
ASCENT_HYSTERESIS_M = 3.0
# Speed is taken over at least this many seconds of track (single GPS steps are noisy).
SPEED_WINDOW_S = 5.0

# Sport names in files and in Strava's activities.csv → FIT (sport, sub_sport).
_SPORTS: dict[str, tuple[str, str | None]] = {
    "run": ("running", None), "running": ("running", None),
    "trail run": ("running", "trail"), "trail_running": ("running", "trail"),
    "virtual run": ("running", "virtual_activity"), "treadmill": ("running", "treadmill"),
    "ride": ("cycling", None), "biking": ("cycling", None), "cycling": ("cycling", None),
    "mountain bike ride": ("cycling", "mountain"), "mountain_biking": ("cycling", "mountain"),
    "gravel ride": ("cycling", "gravel_cycling"), "road_biking": ("cycling", "road"),
    "virtual ride": ("cycling", "virtual_activity"),
    "e-bike ride": ("cycling", "e_bike_fitness"),
    "e-mountain bike ride": ("cycling", "e_bike_mountain"),
    "handcycle": ("cycling", "hand_cycling"), "velomobile": ("cycling", "recumbent"),
    "walk": ("walking", None), "walking": ("walking", None),
    "hike": ("hiking", None), "hiking": ("hiking", None),
    "swim": ("swimming", None), "swimming": ("swimming", None),
    "alpine ski": ("alpine_skiing", None), "backcountry ski": ("alpine_skiing", "backcountry"),
    "nordic ski": ("cross_country_skiing", None), "snowboard": ("snowboarding", None),
    "snowshoe": ("snowshoeing", None), "ice skate": ("ice_skating", None),
    "inline skate": ("inline_skating", None),
    "kayaking": ("kayaking", None), "canoeing": ("paddling", None), "rowing": ("rowing", None),
    "stand up paddling": ("stand_up_paddleboarding", None), "surfing": ("surfing", None),
    "kitesurf": ("kitesurfing", None), "windsurf": ("windsurfing", None),
    "sail": ("sailing", None), "rock climb": ("rock_climbing", None),
    "weight training": ("training", "strength_training"), "workout": ("training", None),
    "crossfit": ("training", "cardio_training"), "hiit": ("hiit", None),
    "yoga": ("training", "yoga"), "pilates": ("training", "pilates"),
    "elliptical": ("fitness_equipment", "elliptical"),
    "stair-stepper": ("fitness_equipment", "stair_climbing"),
    "golf": ("golf", None), "soccer": ("soccer", None), "tennis": ("tennis", None),
    # Older Strava GPX files give the type as a number.
    "1": ("cycling", None), "9": ("running", None),
}  # fmt: skip


class TrackFileError(Exception):
    pass


def gunzip(data: bytes) -> bytes:
    """Unpack gzip data (`.fit.gz`, `.gpx.gz`…); anything else is returned as it is."""
    if data[:2] != b"\x1f\x8b":
        return data
    try:
        return gzip.decompress(data)
    except (OSError, EOFError, zlib.error) as exc:
        raise TrackFileError(f"damaged .gz file: {exc}") from exc


def kind(data: bytes) -> str | None:
    """'fit', 'gpx', 'tcx' or None, from the content (names are not trusted)."""
    if len(data) >= 12 and data[8:12] == b".FIT":
        return "fit"
    head = data[:2048].lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    if not head.startswith(b"<"):
        return None
    if b"<gpx" in head:
        return "gpx"
    if b"<trainingcenterdatabase" in head:
        return "tcx"
    return None


def sport_of(name: str | None) -> tuple[str | None, str | None]:
    """FIT (sport, sub_sport) for a sport name from a file or from Strava; unknown → None."""
    if not name:
        return None, None
    key = name.strip().lower()
    return _SPORTS.get(key) or _SPORTS.get(key.replace("_", " ")) or (None, None)


def parse(data: bytes) -> fitfile.ParsedActivity:
    k = kind(data)
    if k == "gpx":
        return parse_gpx(data)
    if k == "tcx":
        return parse_tcx(data)
    raise TrackFileError("not a GPX or TCX file")


# ---- XML helpers -----------------------------------------------------------------------


def _root(data: bytes) -> ET.Element:
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise TrackFileError(f"damaged XML: {exc}") from exc
    for el in root.iter():  # drop namespaces: files use several versions of each schema
        if isinstance(el.tag, str) and "}" in el.tag:
            el.tag = el.tag.rsplit("}", 1)[1]
    return root


def _text(el: ET.Element | None, path: str) -> str | None:
    if el is None:
        return None
    found = el.find(path)
    if found is None or found.text is None:
        return None
    return found.text.strip() or None


def _num(text: str | None) -> float | None:
    if text is None:
        return None
    try:
        v = float(text)
    except ValueError:
        return None
    return v if math.isfinite(v) else None


def _time(text: str | None) -> datetime | None:
    if not text:
        return None
    try:
        t = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=UTC)


def _ext(el: ET.Element, *names: str) -> float | None:
    """First numeric value of a named element anywhere below `el` (Garmin/Strava extensions)."""
    for name in names:
        for found in el.iter(name):
            v = _num(found.text)
            if v is not None:
                return v
    return None


# ---- formats ---------------------------------------------------------------------------


class _Point:
    __slots__ = ("t", "lat", "lon", "alt", "dist", "hr", "cad", "power", "temp", "speed")

    def __init__(self, t: datetime):
        self.t = t
        self.lat = self.lon = self.alt = self.dist = None
        self.hr = self.cad = self.power = self.temp = self.speed = None


def parse_gpx(data: bytes) -> fitfile.ParsedActivity:
    root = _root(data)
    trk = root.find("trk")
    points: list[_Point] = []
    for el in root.iter("trkpt"):
        t = _time(_text(el, "time"))
        if t is None:
            continue
        p = _Point(t)
        p.lat, p.lon = _num(el.get("lat")), _num(el.get("lon"))
        p.alt = _num(_text(el, "ele"))
        p.hr = _ext(el, "hr", "heartrate")
        p.cad = _ext(el, "cad", "cadence")
        p.power = _ext(el, "power", "watts", "PowerInWatts")
        p.temp = _ext(el, "atemp", "temp")
        points.append(p)
    sport_name = _text(trk, "type")
    title = _text(trk, "name") or _text(root, "metadata/name")
    return _build("gpx", points, sport_name, title, laps=[], totals={})


def parse_tcx(data: bytes) -> fitfile.ParsedActivity:
    root = _root(data)
    activity = root.find("Activities/Activity")
    if activity is None:
        raise TrackFileError("TCX file without an activity")
    points: list[_Point] = []
    lap_rows: list[dict] = []
    totals = {"distance_m": 0.0, "timer_s": 0.0, "calories": 0.0}
    for lap in activity.iter("Lap"):
        start = _time(lap.get("StartTime"))
        row = {
            "start": start,
            "timer_s": _num(_text(lap, "TotalTimeSeconds")),
            "distance_m": _num(_text(lap, "DistanceMeters")),
            "max_speed": _num(_text(lap, "MaximumSpeed")),
            "avg_hr": _num(_text(lap, "AverageHeartRateBpm/Value")),
            "max_hr": _num(_text(lap, "MaximumHeartRateBpm/Value")),
            "calories": _num(_text(lap, "Calories")),
            "cadence": _num(_text(lap, "Cadence")),
            "intensity": _text(lap, "Intensity"),
        }
        lap_rows.append(row)
        for key in totals:
            totals[key] += row[key] or 0.0
        for el in lap.iter("Trackpoint"):
            t = _time(_text(el, "Time"))
            if t is None:
                continue
            p = _Point(t)
            p.lat = _num(_text(el, "Position/LatitudeDegrees"))
            p.lon = _num(_text(el, "Position/LongitudeDegrees"))
            p.alt = _num(_text(el, "AltitudeMeters"))
            p.dist = _num(_text(el, "DistanceMeters"))
            p.hr = _num(_text(el, "HeartRateBpm/Value"))
            p.cad = _num(_text(el, "Cadence")) or _ext(el, "RunCadence")
            p.power = _ext(el, "Watts")
            p.speed = _ext(el, "Speed")
            points.append(p)
    title = _text(activity, "Notes")
    return _build("tcx", points, activity.get("Sport"), title, laps=lap_rows, totals=totals)


# ---- shared ----------------------------------------------------------------------------


def _haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (*a, *b))
    h = (
        math.sin((la2 - la1) / 2) ** 2
        + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    )
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def _climb(alts: list[float | None]) -> tuple[float | None, float | None]:
    """Ascent and descent with a small dead band, so noise does not add up."""
    values = [a for a in alts if a is not None]
    if len(values) < 2:
        return None, None
    up = down = 0.0
    ref = values[0]
    for a in values[1:]:
        if a - ref >= ASCENT_HYSTERESIS_M:
            up += a - ref
            ref = a
        elif ref - a >= ASCENT_HYSTERESIS_M:
            down += ref - a
            ref = a
    return up, down


def _build(
    source: str,
    points: list[_Point],
    sport_name: str | None,
    title: str | None,
    laps: list[dict],
    totals: dict,
) -> fitfile.ParsedActivity:
    points.sort(key=lambda p: p.t)
    if len(points) < 2:
        raise TrackFileError("no track points with a time")
    start = points[0].t
    sport, sub_sport = sport_of(sport_name)
    category, activity_type, indoor = classify(sport, sub_sport)
    on_foot = category in ON_FOOT_GROUPS

    # Distance: from the file (TCX) or summed from the positions.
    have_dist = any(p.dist is not None for p in points)
    total, prev = 0.0, None
    for p in points:
        if p.lat is not None and p.lon is not None and (p.lat, p.lon) == (0.0, 0.0):
            p.lat = p.lon = None
        if not have_dist and p.lat is not None and p.lon is not None:
            if prev is not None:
                total += _haversine(prev, (p.lat, p.lon))
            prev = (p.lat, p.lon)
            p.dist = total

    times = [(p.t - start).total_seconds() for p in points]
    dists = [p.dist for p in points]
    # Speed over a short window when the file has none.
    speeds: list[float | None] = []
    j = 0
    for i, p in enumerate(points):
        if p.speed is not None or dists[i] is None:
            speeds.append(p.speed)
            continue
        while j < i and (times[i] - times[j] > SPEED_WINDOW_S or dists[j] is None):
            j += 1
        dt = times[i] - times[j]
        speeds.append(max(0.0, (dists[i] - dists[j]) / dt) if j < i and dt > 0 else None)

    channels: dict[str, list] = {
        "time": times,
        "distance": dists,
        "lat": [p.lat for p in points],
        "lon": [p.lon for p in points],
        "altitude": [p.alt for p in points],
        "hr": [p.hr for p in points],
        "speed": speeds,
        "power": [p.power for p in points],
        # Running cadence is stored per minute for both feet, like the FIT import.
        "cadence": [
            (p.cad * 2 if on_foot and p.cad is not None and p.cad < 120 else p.cad) for p in points
        ],
        "temperature": [p.temp for p in points],
    }
    streams = {k: v for k, v in channels.items() if any(x is not None for x in v)}

    track = [(p.lat, p.lon) for p in points if p.lat is not None and p.lon is not None]
    ascent, descent = _climb(channels["altitude"])
    distance = next((d for d in reversed(dists) if d is not None), None)
    if totals.get("distance_m"):
        distance = totals["distance_m"]
    elapsed = times[-1]
    time = totals.get("timer_s") or elapsed  # the timer time; a track has no pauses: elapsed
    hr = [x for x in channels["hr"] if x is not None]
    power = [x for x in channels["power"] if x is not None]
    summary: dict = {
        "elapsed_s": elapsed,
        "timer_s": totals.get("timer_s") or elapsed,
        "time_s": time,
        "distance_m": distance,
        "ascent_m": ascent,
        "descent_m": descent,
        "avg_hr": round(sum(hr) / len(hr)) if hr else None,
        "max_hr": round(max(hr)) if hr else None,
        "avg_speed": distance / time if distance and time else None,
        "max_speed": max((s for s in speeds if s is not None), default=None),
        "avg_power": round(sum(power) / len(power)) if power else None,
        "max_power": round(max(power)) if power else None,
        "np_power": None,
        "avg_cadence": None,
        "max_cadence": None,
        "calories": round(totals["calories"]) if totals.get("calories") else None,
        "metabolic_calories": None,
        "zones": None,
        "devices": None,
    }
    if len(track) >= 2:
        lats = [p[0] for p in track]
        lons = [p[1] for p in track]
        summary.update(
            has_gps=1, start_lat=track[0][0], start_lon=track[0][1],
            bbox_min_lat=min(lats), bbox_min_lon=min(lons),
            bbox_max_lat=max(lats), bbox_max_lon=max(lons),
        )  # fmt: skip
    else:
        track = []
        summary["has_gps"] = 0

    lap_list = []
    for i, row in enumerate(laps):
        lap_start = row["start"]
        lap_list.append(
            fitfile.Lap(
                idx=i,
                start_offset_s=(lap_start - start).total_seconds() if lap_start else None,
                elapsed_s=row["timer_s"],
                timer_s=row["timer_s"],
                distance_m=row["distance_m"],
                avg_hr=round(row["avg_hr"]) if row["avg_hr"] else None,
                max_hr=round(row["max_hr"]) if row["max_hr"] else None,
                avg_speed=row["distance_m"] / row["timer_s"]
                if row["distance_m"] and row["timer_s"]
                else None,
                max_speed=row["max_speed"],
                avg_power=None,
                avg_cadence=row["cadence"] * 2 if on_foot and row["cadence"] else row["cadence"],
                ascent_m=None,
                descent_m=None,
                intensity=(row["intensity"] or "").lower() or None,
            )  # fmt: skip
        )

    return fitfile.ParsedActivity(
        # Same activity → same id, so a second copy of the file is a duplicate.
        fit_uid=f"{source}:{int(start.timestamp())}:{len(points)}",
        start_time=start.astimezone(UTC),
        utc_offset_s=None,
        sport=sport,
        sub_sport=sub_sport,
        category=category,
        activity_type=activity_type,
        indoor=indoor,
        name=None,
        device=None,
        summary=summary,
        track=track,
        streams=streams,
        laps=lap_list,
        title=title,
    )
