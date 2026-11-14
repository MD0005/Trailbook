"""Reading FIT files: a cheap file-type peek and a full activity parse."""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from datetime import datetime

from garmin_fit_sdk import Decoder, Stream

from . import geo
from .sports import ON_FOOT_GROUPS, classify

FIT_EPOCH_S = 631065600  # 1989-12-31T00:00:00Z
FILE_TYPE_ACTIVITY = 4
FILE_TYPE_NAMES = {
    1: "device",
    2: "settings",
    3: "sport",
    4: "activity",
    5: "workout",
    6: "course",
    7: "schedules",
    9: "weight",
    10: "totals",
    11: "goals",
    14: "blood_pressure",
    15: "monitoring_a",
    20: "activity_summary",
    28: "monitoring_daily",
    32: "monitoring_b",
    34: "segment",
    35: "segment_list",
    40: "exd_configuration",
    44: "hrv",  # Garmin-specific types observed in exports
    49: "sleep",
    68: "skin_temperature",
    73: "respiration",
    79: "health_snapshot",
}

# Gaps longer than this between two records are treated as pauses, not movement.
MAX_MOVING_GAP_S = 30.0
MIN_MOVING_SPEED = 0.3  # m/s


class FitError(Exception):
    pass


def peek_file_type(data: bytes) -> int | None:
    """Return the FIT `file_id.type` without decoding the whole file.

    `file_id` is required to be the first message, so only the first definition and
    data messages are read. Returns None if it cannot be determined.
    """
    if len(data) < 12:
        return None
    header_size = data[0]
    if header_size not in (12, 14) or data[8:12] != b".FIT":
        return None

    pos = header_size
    end = min(len(data), header_size + 65536)
    definitions: dict[int, tuple[int, str, list[tuple[int, int]], int]] = {}

    while pos < end:
        h = data[pos]
        pos += 1
        if h & 0x80:  # compressed timestamp header -> data message
            local = (h >> 5) & 0x03
            is_definition = False
        else:
            local = h & 0x0F
            is_definition = bool(h & 0x40)

        if is_definition:
            if pos + 5 > end:
                return None
            arch = data[pos + 1]
            order = ">" if arch == 1 else "<"
            global_num = struct.unpack_from(order + "H", data, pos + 2)[0]
            n_fields = data[pos + 4]
            pos += 5
            fields = []
            for _ in range(n_fields):
                fields.append((data[pos], data[pos + 1]))
                pos += 3
            dev_size = 0
            if h & 0x20:
                n_dev = data[pos]
                pos += 1
                for _ in range(n_dev):
                    dev_size += data[pos + 1]
                    pos += 3
            definitions[local] = (global_num, order, fields, dev_size)
        else:
            definition = definitions.get(local)
            if definition is None:
                return None
            global_num, _order, fields, dev_size = definition
            if global_num == 0:  # file_id
                offset = pos
                for num, size in fields:
                    if num == 0:
                        value = data[offset]
                        return None if value == 0xFF else value
                    offset += size
                return None
            pos += sum(size for _, size in fields) + dev_size
    return None


def file_type_name(file_type: int | None) -> str:
    if file_type is None:
        return "unknown"
    return FILE_TYPE_NAMES.get(file_type, f"type_{file_type}")


@dataclass
class Lap:
    idx: int
    start_offset_s: float | None
    elapsed_s: float | None
    timer_s: float | None
    distance_m: float | None
    avg_hr: int | None
    max_hr: int | None
    avg_speed: float | None
    max_speed: float | None
    avg_power: int | None
    avg_cadence: float | None
    ascent_m: float | None
    descent_m: float | None
    intensity: str | None


@dataclass
class ParsedActivity:
    fit_uid: str
    start_time: datetime
    utc_offset_s: int | None
    sport: str | None
    sub_sport: str | None
    category: str
    activity_type: str
    indoor: bool
    name: str | None
    device: str | None
    summary: dict[str, float | int | None]
    track: list[tuple[float, float]]  # full-resolution (lat, lon)
    streams: dict[str, list[float | None]]
    laps: list[Lap] = field(default_factory=list)


def _first(d: dict, *keys):
    for k in keys:
        v = d.get(k)
        if v is not None:
            return v
    return None


def _cadence(d: dict, on_foot: bool, base_keys: tuple[str, ...], frac_key: str) -> float | None:
    value = _first(d, *base_keys)
    if value is None:
        return None
    value = float(value) + float(d.get(frac_key) or 0.0)
    return value * 2 if on_foot else value


def parse_activity(data: bytes) -> ParsedActivity:
    stream = Stream.from_byte_array(bytearray(data))
    decoder = Decoder(stream)
    messages, errors = decoder.read(
        apply_scale_and_offset=True,
        convert_datetimes_to_dates=True,
        convert_types_to_strings=True,
        enable_crc_check=True,
        expand_sub_fields=True,
        expand_components=True,
        merge_heart_rates=True,
    )

    sessions = messages.get("session_mesgs") or []
    records = messages.get("record_mesgs") or []
    if not sessions and not records:
        raise FitError("; ".join(str(e) for e in errors) or "no session or record messages")

    file_id = (messages.get("file_id_mesgs") or [{}])[0]

    if len(sessions) > 1:
        sport, sub_sport = "multisport", None
    elif sessions:
        sport, sub_sport = sessions[0].get("sport"), sessions[0].get("sub_sport")
    else:
        sport, sub_sport = None, None
    sport = str(sport) if sport is not None else None
    sub_sport = str(sub_sport) if sub_sport is not None else None
    category, activity_type, indoor = classify(sport, sub_sport)
    on_foot = category in ON_FOOT_GROUPS

    start_time = None
    if sessions:
        start_time = sessions[0].get("start_time")
    if start_time is None and records:
        start_time = records[0].get("timestamp")
    if start_time is None:
        start_time = file_id.get("time_created")
    if start_time is None:
        raise FitError("activity has no start time")

    fit_uid = _fit_uid(file_id, start_time, sport)

    # --- streams --------------------------------------------------------------------
    channels: dict[str, list[float | None]] = {
        "time": [],
        "distance": [],
        "lat": [],
        "lon": [],
        "altitude": [],
        "hr": [],
        "speed": [],
        "power": [],
        "cadence": [],
        "temperature": [],
        "respiration": [],
    }
    track: list[tuple[float, float]] = []
    for r in records:
        ts = r.get("timestamp")
        if ts is None:
            continue
        lat = geo.semicircles_to_deg(r.get("position_lat"))
        lon = geo.semicircles_to_deg(r.get("position_long"))
        if lat is not None and lon is not None and (abs(lat) > 90 or (lat == 0 and lon == 0)):
            lat = lon = None
        channels["time"].append((ts - start_time).total_seconds())
        channels["distance"].append(r.get("distance"))
        channels["lat"].append(lat)
        channels["lon"].append(lon)
        channels["altitude"].append(_first(r, "enhanced_altitude", "altitude"))
        channels["hr"].append(r.get("heart_rate"))
        channels["speed"].append(_first(r, "enhanced_speed", "speed"))
        channels["power"].append(r.get("power"))
        channels["cadence"].append(_cadence(r, on_foot, ("cadence",), "fractional_cadence"))
        channels["temperature"].append(r.get("temperature"))
        channels["respiration"].append(_first(r, "enhanced_respiration_rate", "respiration_rate"))
        if lat is not None and lon is not None:
            track.append((lat, lon))

    streams = {k: v for k, v in channels.items() if any(x is not None for x in v)}
    if "time" not in streams:
        streams = {}

    # --- summary --------------------------------------------------------------------
    summary = _summary(sessions, channels, on_foot)

    if len(track) >= 2:
        lats = [p[0] for p in track]
        lons = [p[1] for p in track]
        summary.update(
            has_gps=1,
            start_lat=track[0][0],
            start_lon=track[0][1],
            bbox_min_lat=min(lats),
            bbox_min_lon=min(lons),
            bbox_max_lat=max(lats),
            bbox_max_lon=max(lons),
        )
    else:
        track = []
        summary["has_gps"] = 0

    # --- laps -----------------------------------------------------------------------
    laps = []
    for i, lap in enumerate(messages.get("lap_mesgs") or []):
        lap_start = lap.get("start_time")
        laps.append(
            Lap(
                idx=i,
                start_offset_s=(lap_start - start_time).total_seconds() if lap_start else None,
                elapsed_s=lap.get("total_elapsed_time"),
                timer_s=lap.get("total_timer_time"),
                distance_m=lap.get("total_distance"),
                avg_hr=lap.get("avg_heart_rate"),
                max_hr=lap.get("max_heart_rate"),
                avg_speed=_first(lap, "enhanced_avg_speed", "avg_speed"),
                max_speed=_first(lap, "enhanced_max_speed", "max_speed"),
                avg_power=lap.get("avg_power"),
                avg_cadence=_cadence(
                    lap, on_foot, ("avg_running_cadence", "avg_cadence"), "avg_fractional_cadence"
                ),
                ascent_m=lap.get("total_ascent"),
                descent_m=lap.get("total_descent"),
                intensity=str(lap["intensity"]) if lap.get("intensity") is not None else None,
            )
        )

    # --- metadata -------------------------------------------------------------------
    name = sessions[0].get("sport_profile_name") if sessions else None
    device = " ".join(
        str(x)
        for x in (file_id.get("manufacturer"), _first(file_id, "garmin_product", "product"))
        if x is not None
    )

    return ParsedActivity(
        fit_uid=fit_uid,
        start_time=start_time,
        utc_offset_s=_utc_offset(messages),
        sport=sport,
        sub_sport=sub_sport,
        category=category,
        activity_type=activity_type,
        indoor=indoor,
        name=name or None,
        device=device or None,
        summary=summary,
        track=track,
        streams=streams,
        laps=laps,
    )


def _fit_uid(file_id: dict, start_time: datetime, sport: str | None) -> str:
    created = file_id.get("time_created")
    serial = file_id.get("serial_number")
    if serial is not None and created is not None:
        return f"sn{serial}:{int(created.timestamp())}"
    maker = file_id.get("manufacturer")
    product = file_id.get("product")
    stamp = int((created or start_time).timestamp())
    return f"{maker}:{product}:{stamp}:{sport}"


def _utc_offset(messages: dict) -> int | None:
    for act in messages.get("activity_mesgs") or []:
        local = act.get("local_timestamp")
        ts = act.get("timestamp")
        if isinstance(local, int) and ts is not None:
            offset = local - (int(ts.timestamp()) - FIT_EPOCH_S)
            return int(round(offset / 900.0) * 900)  # time zones are multiples of 15 min
    return None


def _summary(sessions: list[dict], ch: dict[str, list], on_foot: bool) -> dict:
    def total(key: str) -> float | None:
        values = [s.get(key) for s in sessions if s.get(key) is not None]
        return sum(values) if values else None

    def max_of(key: str):
        values = [s.get(key) for s in sessions if s.get(key) is not None]
        return max(values) if values else None

    s0 = sessions[0] if len(sessions) == 1 else {}

    times = ch["time"]
    elapsed = total("total_elapsed_time")
    if elapsed is None and times:
        elapsed = times[-1] - times[0]
    timer = total("total_timer_time") or elapsed
    distance = total("total_distance")
    if distance is None:
        distance = next((d for d in reversed(ch["distance"]) if d is not None), None)

    summary: dict = {
        "elapsed_s": elapsed,
        "timer_s": timer,
        "moving_s": _moving_time(times, ch["distance"]) or timer,
        "distance_m": distance,
        "ascent_m": total("total_ascent"),
        "descent_m": total("total_descent"),
        "avg_hr": s0.get("avg_heart_rate") if s0 else _avg(ch["hr"]),
        "max_hr": max_of("max_heart_rate") or _max(ch["hr"]),
        "avg_speed": _first(s0, "enhanced_avg_speed", "avg_speed") if s0 else None,
        "max_speed": max_of("enhanced_max_speed") or max_of("max_speed") or _max(ch["speed"]),
        "avg_power": s0.get("avg_power") if s0 else _avg(ch["power"]),
        "max_power": max_of("max_power") or _max(ch["power"]),
        "np_power": s0.get("normalized_power") if s0 else None,
        "avg_cadence": _cadence(
            s0, on_foot, ("avg_running_cadence", "avg_cadence"), "avg_fractional_cadence"
        )
        if s0
        else None,
        "max_cadence": _cadence(
            s0, on_foot, ("max_running_cadence", "max_cadence"), "max_fractional_cadence"
        )
        if s0
        else None,
        "calories": total("total_calories"),
    }
    if summary["avg_speed"] is None and distance and summary["moving_s"]:
        summary["avg_speed"] = distance / summary["moving_s"]
    return summary


def _moving_time(times: list[float], distances: list[float | None]) -> float | None:
    """Sum of intervals in which the athlete actually moved."""
    moving = 0.0
    prev_t = prev_d = None
    seen_distance = False
    for t, d in zip(times, distances, strict=True):
        if d is None:
            continue
        seen_distance = True
        if prev_t is not None:
            dt = t - prev_t
            if 0 < dt <= MAX_MOVING_GAP_S and (d - prev_d) / dt >= MIN_MOVING_SPEED:
                moving += dt
        prev_t, prev_d = t, d
    return moving if seen_distance and moving > 0 else None


def _avg(values: list) -> float | None:
    v = [x for x in values if x is not None]
    return round(sum(v) / len(v)) if v else None


def _max(values: list):
    v = [x for x in values if x is not None]
    return max(v) if v else None
