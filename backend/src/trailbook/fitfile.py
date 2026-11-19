"""Reading FIT files: a cheap file-type peek and a full activity parse."""

from __future__ import annotations

import json
import re
import struct
from dataclasses import dataclass, field
from datetime import UTC, datetime

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

# Further per-second record fields kept as streams when the file has them (watch dependent).
# Numeric keys are undocumented Garmin fields, named after their observed meaning.
EXTRA_CHANNELS = {
    "stance_time": "stance_time",  # ms
    "step_length": "step_length",  # mm
    "vertical_oscillation": "vertical_oscillation",  # mm
    "vertical_ratio": "vertical_ratio",  # %
    "left_pco": "left_pco",  # mm, platform centre offset
    "right_pco": "right_pco",
    "left_smoothness": "left_pedal_smoothness",  # %
    "right_smoothness": "right_pedal_smoothness",
    "left_torque": "left_torque_effectiveness",  # %
    "right_torque": "right_torque_effectiveness",
    "performance_condition": 90,
    # 138 drops fast in a hard effort and recovers (current stamina); 137 falls slowly (the
    # potential: the most the current one can recover to).
    "stamina": 138,  # %
    "stamina_potential": 137,  # %
}

# Gaps longer than this between two records are treated as pauses, not movement.


class FitError(Exception):
    pass


@dataclass
class FileId:
    """Fields of the FIT `file_id` message (the first message of every FIT file)."""

    type: int | None = None
    manufacturer: int | None = None
    product: int | None = None
    serial_number: int | None = None
    time_created: datetime | None = None

    @property
    def fit_uid(self) -> str | None:
        """Stable id of the recording; same format as `ParsedActivity.fit_uid`."""
        if self.serial_number is None or self.time_created is None:
            return None
        return f"sn{self.serial_number}:{int(self.time_created.timestamp())}"


# file_id field number -> (struct code, invalid value)
_FILE_ID_FIELDS = {
    0: ("type", "B", 0xFF),
    1: ("manufacturer", "H", 0xFFFF),
    2: ("product", "H", 0xFFFF),
    3: ("serial_number", "I", 0),  # uint32z: 0 is invalid
    4: ("time_created", "I", 0xFFFFFFFF),
}


def peek_file_id(data: bytes) -> FileId | None:
    """Read the FIT `file_id` message without decoding the whole file.

    `file_id` is required to be the first message, so only the first definition and
    data messages are read. Returns None if the data is not a readable FIT file.
    """
    try:
        return _peek_file_id(data)
    except (IndexError, struct.error):
        return None


def _peek_file_id(data: bytes) -> FileId | None:
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
            continue

        definition = definitions.get(local)
        if definition is None:
            return None
        global_num, order, fields, dev_size = definition
        if global_num != 0:  # not file_id
            pos += sum(size for _, size in fields) + dev_size
            continue

        result = FileId()
        offset = pos
        for num, size in fields:
            spec = _FILE_ID_FIELDS.get(num)
            if spec is not None and struct.calcsize(spec[1]) == size:
                name, code, invalid = spec
                value = struct.unpack_from(order + code, data, offset)[0]
                if value != invalid:
                    if name == "time_created":
                        value = datetime.fromtimestamp(value + FIT_EPOCH_S, UTC)
                    setattr(result, name, value)
            offset += size
        return result
    return None


def product_name(product: int | str | None) -> str | None:
    """Garmin product number -> model name (e.g. 4261 -> 'venu3s'), if known."""
    if product is None:
        return None
    from garmin_fit_sdk import Profile

    try:
        number = int(product)
    except (TypeError, ValueError):
        return str(product)
    return Profile["types"]["garmin_product"].get(number, str(product))


def peek_file_type(data: bytes) -> int | None:
    """Return the FIT `file_id.type`, or None if it cannot be determined."""
    fid = peek_file_id(data)
    return fid.type if fid else None


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
    # Target of the workout step the lap belongs to (structured workouts): the stream it
    # refers to (hr|power|speed|cadence) and the range in stream units (bpm, W, m/s, rpm/spm).
    target: str | None = None
    target_low: float | None = None
    target_high: float | None = None


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
    # Thresholds the watch used for this activity (see `watch_thresholds`).
    profile: dict[str, float | None] = field(default_factory=dict)
    # A title the user gave the activity (GPX/TCX, Strava); FIT files have none.
    title: str | None = None
    description: str | None = None


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


# Workout step target types → stream channel.
_TARGET_CHANNEL = {
    "heart_rate": "hr", "heart_rate_lap": "hr",
    "power": "power", "power_lap": "power", "power_3s": "power", "power_10s": "power",
    "power_30s": "power",
    "speed": "speed", "speed_lap": "speed",
    "cadence": "cadence",
}  # fmt: skip


def workout_targets(messages: dict, on_foot: bool) -> dict[int, tuple[str, float, float]]:
    """Custom targets of the workout steps: {step index: (channel, low, high)}.

    Only custom ranges are used (a target given as a zone number needs the zones of that
    time, which the file does not always carry). Units as in the FIT profile, with what
    Garmin writes in practice: heart rate in bpm (values up to 100 = % of max HR), power in
    watts (1000 + watts in the profile), speed in m/s, cadence per foot on foot (doubled
    here like the cadence stream).
    """
    hr_max = watch_thresholds(messages).get("hr_max")
    out = {}
    for i, s in enumerate(messages.get("workout_step_mesgs") or []):
        ch = _TARGET_CHANNEL.get(str(s.get("target_type")))
        lo, hi = s.get("custom_target_value_low"), s.get("custom_target_value_high")
        if ch is None or not lo or not hi:
            continue
        if ch == "speed":
            lo = _first(s, "custom_target_speed_low") or lo / 1000
            hi = _first(s, "custom_target_speed_high") or hi / 1000
        elif ch == "hr" and hi <= 100:
            if not hr_max:
                continue
            lo, hi = lo * hr_max / 100, hi * hr_max / 100
        elif ch == "power" and lo >= 1000:
            lo, hi = lo - 1000, hi - 1000
        elif ch == "cadence" and on_foot:
            lo, hi = lo * 2, hi * 2
        idx = s.get("message_index", i)
        out[int(idx)] = (ch, float(lo), float(hi))
    return out


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
    if sub_sport in (None, "generic") and sport in ("cycling", "running"):
        if is_virtual_app(file_id, messages.get("device_info_mesgs") or []):
            sub_sport = "virtual_activity"  # files edited by tools often lose the sub-sport
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
        **{k: [] for k in EXTRA_CHANNELS},
    }
    track: list[tuple[float, float]] = []
    # Recordings joined by file tools restart the distance at 0: keep it running on.
    dist_offset, last_dist = 0.0, None
    for r in records:
        ts = r.get("timestamp")
        if ts is None:
            continue
        lat = geo.semicircles_to_deg(r.get("position_lat"))
        lon = geo.semicircles_to_deg(r.get("position_long"))
        if lat is not None and lon is not None and (abs(lat) > 90 or (lat == 0 and lon == 0)):
            lat = lon = None
        channels["time"].append((ts - start_time).total_seconds())
        dist = r.get("distance")
        if dist is not None:
            if last_dist is not None and dist < last_dist - 100:
                dist_offset += last_dist
            last_dist = dist
            dist += dist_offset
        channels["distance"].append(dist)
        channels["lat"].append(lat)
        channels["lon"].append(lon)
        channels["altitude"].append(_first(r, "enhanced_altitude", "altitude"))
        channels["hr"].append(r.get("heart_rate"))
        channels["speed"].append(_first(r, "enhanced_speed", "speed"))
        channels["power"].append(r.get("power"))
        channels["cadence"].append(_cadence(r, on_foot, ("cadence",), "fractional_cadence"))
        channels["temperature"].append(r.get("temperature"))
        channels["respiration"].append(_first(r, "enhanced_respiration_rate", "respiration_rate"))
        for key, name in EXTRA_CHANNELS.items():
            v = r.get(name)
            ok = isinstance(v, (int, float)) and not isinstance(v, bool)
            channels[key].append(v if ok else None)
        if lat is not None and lon is not None:
            track.append((lat, lon))

    streams = {k: v for k, v in channels.items() if any(x is not None for x in v)}
    if "time" not in streams:
        streams = {}

    # --- summary --------------------------------------------------------------------
    summary = _summary(sessions, channels, on_foot)
    summary["zones"] = time_in_zones(messages)
    summary["devices"] = devices_json(messages)

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
    targets = workout_targets(messages, on_foot)
    for i, lap in enumerate(messages.get("lap_mesgs") or []):
        lap_start = lap.get("start_time")
        step = lap.get("wkt_step_index")
        target = targets.get(int(step)) if isinstance(step, int) else None
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
                target=target[0] if target else None,
                target_low=target[1] if target else None,
                target_high=target[2] if target else None,
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
        profile=watch_thresholds(messages),
    )


# Plausible ranges; anything else (0 = not set, 255 = invalid) is ignored.
_PROFILE_LIMITS = {
    "hr_max": (100, 230), "hr_rest": (25, 120), "lthr": (80, 220), "ftp": (30, 700),
    "weight": (20, 300),
}  # fmt: skip


def watch_thresholds(messages: dict) -> dict[str, float | None]:
    """Thresholds the watch had set when the activity was recorded: HR max, threshold HR
    and FTP from `zones_target`, resting HR and weight from `user_profile`, with the
    session's `time_in_zone` as a fallback (newer watches write the values there)."""
    zones = (messages.get("zones_target_mesgs") or [{}])[0]
    user = (messages.get("user_profile_mesgs") or [{}])[0]
    tiz = (
        [
            t
            for t in messages.get("time_in_zone_mesgs") or []
            if str(t.get("reference_mesg")) == "session"
        ]
        or messages.get("time_in_zone_mesgs")
        or [{}]
    )
    t0 = tiz[0]
    raw = {
        "hr_max": _first(zones, "max_heart_rate") or t0.get("max_heart_rate"),
        "hr_rest": _first(user, "resting_heart_rate") or t0.get("resting_heart_rate"),
        "lthr": _first(zones, "threshold_heart_rate") or t0.get("threshold_heart_rate"),
        "ftp": _first(zones, "functional_threshold_power") or t0.get("functional_threshold_power"),
        "weight": user.get("weight"),
    }
    out: dict[str, float | None] = {}
    for k, v in raw.items():
        lo, hi = _PROFILE_LIMITS[k]
        out[k] = v if isinstance(v, (int, float)) and lo <= v <= hi else None
    return out


def parse_watch_thresholds(data: bytes) -> dict[str, float | None]:
    """Only the watch thresholds of a FIT file (for activities imported before they were
    stored)."""
    messages, _errors = Decoder(Stream.from_byte_array(bytearray(data))).read(
        apply_scale_and_offset=True, convert_types_to_strings=True, expand_components=False,
        merge_heart_rates=False,
    )  # fmt: skip
    return watch_thresholds(messages)


# ---- daily monitoring (steps, floors, stress) ---------------------------------------------

# Undocumented fields of the `monitoring` message (Forerunner 965 and similar): the ascent and
# descent of the day so far, in mm, reset at local midnight.
MONITORING_ASCENT_MM = 35
MONITORING_DESCENT_MM = 36
FILE_TYPES_MONITORING = (15, 32)  # monitoring_a, monitoring_b


def parse_monitoring(data: bytes) -> dict[tuple[str, str], tuple[float, int]]:
    """Daily values of a monitoring FIT file: {(local day, metric): (value, n)}.

    Metrics: `steps:<activity type>` and `ascent_mm` / `descent_mm` are running totals of the
    day (the file's largest value counts; a later file of the same day has a larger one);
    `stress` is the sum of the valid stress readings (0-100, one a minute) with their count n,
    so files add up to the day's average. Days are local (the file's monitoring_info offset).
    A total written exactly at midnight belongs to the day that just ended.
    """
    messages, _errors = Decoder(Stream.from_byte_array(bytearray(data))).read(
        convert_datetimes_to_dates=False, expand_components=False, merge_heart_rates=False
    )
    infos = messages.get("monitoring_info_mesgs") or []
    info = infos[0] if infos else {}
    if not isinstance(info.get("local_timestamp"), int) or not isinstance(
        info.get("timestamp"), int
    ):
        return {}
    offset = info["local_timestamp"] - info["timestamp"]

    def day(fit_ts: int) -> str:
        return datetime.fromtimestamp(fit_ts + FIT_EPOCH_S + offset, UTC).strftime("%Y-%m-%d")

    out: dict[tuple[str, str], tuple[float, int]] = {}

    def keep_max(key: tuple[str, str], value) -> None:
        if isinstance(value, (int, float)) and value >= 0:
            old = out.get(key)
            if old is None or value > old[0]:
                out[key] = (float(value), 1)

    last: int | None = None
    for m in messages.get("monitoring_mesgs") or []:
        if isinstance(m.get("timestamp"), int):
            last = m["timestamp"]
        elif isinstance(m.get("timestamp_16"), int) and last is not None:
            last += (m["timestamp_16"] - last) & 0xFFFF
        if last is None:
            continue
        d = day(last - 1)  # running totals: midnight closes the previous day
        if "steps" in m and m.get("activity_type") is not None:
            keep_max((d, f"steps:{m['activity_type']}"), m["steps"])
        keep_max((d, "ascent_mm"), m.get(MONITORING_ASCENT_MM))
        keep_max((d, "descent_mm"), m.get(MONITORING_DESCENT_MM))
    for s in messages.get("stress_level_mesgs") or []:
        t, v = s.get("stress_level_time"), s.get("stress_level_value")
        if isinstance(t, int) and isinstance(v, (int, float)) and 0 <= v <= 100:
            total, n = out.get((day(t), "stress"), (0.0, 0))
            out[(day(t), "stress")] = (total + v, n + 1)
    return out


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


# ANT+ / BLE device types → kind of device (for the picture on the activity page).
_DEVICE_KIND = {
    11: "power_meter", 17: "trainer", 34: "shifting", 35: "light", 36: "light", 40: "radar",
    120: "hr_strap", 121: "speed_cadence", 122: "speed_cadence", 123: "speed_cadence",
    124: "foot_pod",
    "bike_power": "power_meter", "fitness_equipment": "trainer", "shifting": "shifting",
    "bike_light_main": "light", "bike_light_shared": "light", "bike_radar": "radar",
    "heart_rate": "hr_strap", "bike_speed_cadence": "speed_cadence",
    "bike_cadence": "speed_cadence", "bike_speed": "speed_cadence",
    "stride_speed_distance": "foot_pod",
}  # fmt: skip
_KIND_ORDER = ("watch", "bike_computer", "app", "power_meter", "hr_strap", "trainer", "radar",
               "light", "speed_cadence", "foot_pod", "shifting", "sensor")  # fmt: skip
_NAME_PREFIX = {
    "fr": "Forerunner", "edge": "Edge", "fenix": "fēnix", "epix": "epix", "venu": "Venu",
    "vivoactive": "vívoactive", "instinct": "Instinct", "enduro": "Enduro", "marq": "MARQ",
    "hrm": "HRM", "approach": "Approach", "descent": "Descent", "tacx": "Tacx",
}  # fmt: skip
# Products the FIT SDK does not name yet (Garmin product number → model).
_PRODUCT_NAMES = {"tacx_training_app_android": "Tacx Training app",
                  "tacx_training_app_ios": "Tacx Training app"}  # fmt: skip
_MAKER = {"favero_electronics": "Favero", "garmin": "Garmin", "wahoo_fitness": "Wahoo",
          "tacx": "Tacx", "sram": "SRAM", "shimano": "Shimano", "polar": "Polar",
          "stages_cycling": "Stages", "4iiiis": "4iiii", "zwift": "Zwift"}  # fmt: skip


def device_name(maker: str | None, product) -> str | None:
    """Readable model name from the FIT product name (fr965 → Forerunner 965)."""
    if not isinstance(product, str) or not product or product.isdigit():
        return None
    if product.lower().startswith("hrm_"):
        return "HRM-" + " ".join(w.capitalize() for w in product[4:].split("_"))
    m = re.fullmatch(r"([a-z]+?)_?(\d.*)?", product.lower())
    head, rest = (m.group(1), m.group(2) or "") if m else (product, "")
    if head in _NAME_PREFIX:
        tail = " ".join(
            w.upper() if len(w) <= 2 and not w.isdigit() else w
            for w in re.split(r"[_ ]", rest)
            if w
        )
        tail = re.sub(r"(\d)([a-z]+)$", lambda x: x.group(1) + x.group(2).upper(), tail)
        return f"{_NAME_PREFIX[head]} {tail}".strip()
    return " ".join(w.capitalize() for w in product.split("_"))


# Makers of virtual training apps (FIT manufacturer of the file creator): a ride or run they
# recorded is virtual even when the file has no sub-sport.
VIRTUAL_APP_MAKERS = frozenset(
    {"zwift", "tacx", "bkool", "trainerroad", "the_sufferfest", "virtualtraining", "rouvy",
     "mywhoosh", "fulgaz", "kinomap", "onelap", "rgt_cycling"}
)  # fmt: skip


def is_virtual_app(file_id: dict, device_infos: list[dict]) -> bool:
    """True when the file was recorded by a virtual training app (Zwift, Tacx app, Rouvy…)."""
    makers = {str(file_id.get("manufacturer") or "")}
    for d in device_infos:
        if str(d.get("device_index")) == "creator" or d.get("device_index") == 0:
            makers.add(str(d.get("manufacturer") or ""))
    return bool(makers & VIRTUAL_APP_MAKERS)


def devices(messages: dict) -> list[dict]:
    """Devices that recorded the activity: the watch / bike computer and connected sensors.

    From `device_info`: the creator plus external sensors (ANT+ / Bluetooth); built-in
    sensors (barometer, GPS, wrist heart rate) are left out. One entry per physical device
    (same maker, product and serial) with {kind, maker, product, name, serial, battery}.
    """
    file_id = (messages.get("file_id_mesgs") or [{}])[0]
    out: dict[tuple, dict] = {}
    for d in messages.get("device_info_mesgs") or []:
        idx, src = d.get("device_index"), str(d.get("source_type") or "")
        creator = str(idx) == "creator" or idx == 0
        if not creator and src not in ("antplus", "bluetooth", "bluetooth_low_energy"):
            continue
        maker = d.get("manufacturer")
        product = d.get("garmin_product") or d.get("favero_product") or d.get("product")
        dtype = d.get("device_type") or d.get("antplus_device_type") or d.get("ble_device_type")
        if creator:
            maker = maker or file_id.get("manufacturer")
            product = product or file_id.get("garmin_product") or file_id.get("product")
            p = str(product or "").lower()
            kind = ("bike_computer" if p.startswith("edge") else
                    "app" if "app" in p or "zwift" in str(maker) else "watch")  # fmt: skip
        elif str(product) == "OHR":  # a watch sending its wrist heart rate
            kind, product = "watch", None
        else:
            kind = _DEVICE_KIND.get(dtype, "sensor")
        serial = d.get("serial_number")
        key = (str(maker), str(product), serial if serial else kind)
        e = out.get(key)
        if e is None:
            name = (
                _PRODUCT_NAMES.get(str(product))
                or device_name(str(maker), product)
                or {
                    "radar": "Varia radar",
                    "light": "Bike light",
                    "power_meter": "Power meter",
                    "hr_strap": "Heart rate monitor",
                    "speed_cadence": "Speed / cadence sensor",
                    "foot_pod": "Foot pod",
                    "trainer": "Smart trainer",
                    "watch": "Watch",
                    "app": "App",
                }.get(kind, "Sensor")
            )
            e = out[key] = {
                "kind": kind, "maker": _MAKER.get(str(maker), str(maker or "").title() or None),
                "product": str(product) if product is not None else None, "name": name,
                "serial": serial, "battery": None,
            }  # fmt: skip
        elif _KIND_ORDER.index(kind) < _KIND_ORDER.index(e["kind"]):
            e["kind"] = kind  # e.g. a radar with a light: the radar
            if e["product"] is None or str(e["product"]).isdigit():
                e["name"] = {"radar": "Varia radar"}.get(kind, e["name"])
        if d.get("battery_status") is not None:
            e["battery"] = str(d["battery_status"])
    return sorted(out.values(), key=lambda e: _KIND_ORDER.index(e["kind"]))


def devices_json(messages: dict) -> str | None:
    found = devices(messages)
    return json.dumps(found, separators=(",", ":")) if found else None


def time_in_zones(messages: dict) -> str | None:
    """Garmin's time in heart rate and power zones for the whole activity, as JSON.

    From the `time_in_zone` message of the session (the watch's own zone limits):
    {"hr": {"times": [s...], "bounds": [bpm...]}, "power": {...}}. `bounds` are the zone
    limits as written: for heart rate the first one is the low limit of zone 1 (times[0] is
    the time below zone 1), and so for cycling power (bounds start at 0); for running power
    each one is the high limit of a zone (times[0] is zone 1). Sessions are summed when
    there are several. None when the file has none.
    """
    out: dict[str, dict] = {}
    for t in messages.get("time_in_zone_mesgs") or []:
        if str(t.get("reference_mesg")) != "session":
            continue
        for key, times_f, bounds_f in (
            ("hr", "time_in_hr_zone", "hr_zone_high_boundary"),
            ("power", "time_in_power_zone", "power_zone_high_boundary"),
        ):
            times, bounds = t.get(times_f), t.get(bounds_f)
            if not isinstance(times, list) or not isinstance(bounds, list) or not any(times):
                continue
            bounds = [b for b in bounds if b is not None]
            times = [float(x or 0) for x in times]
            if key in out and len(out[key]["times"]) == len(times):
                out[key]["times"] = [a + b for a, b in zip(out[key]["times"], times, strict=True)]
            else:
                out[key] = {"times": times, "bounds": bounds}
    return json.dumps(out, separators=(",", ":")) if out else None


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
        "time_s": timer,  # the activity's time: the timer time (pauses left out)
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
        # resting (BMR) share of the calories; active = total - metabolic
        "metabolic_calories": total("metabolic_calories"),
    }
    if summary["avg_speed"] is None and distance and summary["time_s"]:
        summary["avg_speed"] = distance / summary["time_s"]
    return summary


def _avg(values: list) -> float | None:
    v = [x for x in values if x is not None]
    return round(sum(v) / len(v)) if v else None


def _max(values: list):
    v = [x for x in values if x is not None]
    return max(v) if v else None
