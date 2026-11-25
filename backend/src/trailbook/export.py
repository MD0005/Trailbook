"""Activity › Export: the whole activity as a FIT file, or only the route as GPX (to send to
someone). FIT: the activity's own FIT file when it came as one and was not corrected;
otherwise a FIT file written from what is stored (records, laps, session).
"""

from __future__ import annotations

import sqlite3
import struct
from datetime import UTC, datetime, timedelta
from pathlib import Path
from xml.sax.saxutils import escape

from garmin_fit_sdk import Profile

from . import importer, streams

FIT_EPOCH = datetime(1989, 12, 31, tzinfo=UTC)
_BASE = {  # FIT base type: (code, struct format, invalid value)
    "enum": (0x00, "B", 0xFF), "sint8": (0x01, "b", 0x7F), "uint8": (0x02, "B", 0xFF),
    "sint16": (0x83, "h", 0x7FFF), "uint16": (0x84, "H", 0xFFFF),
    "sint32": (0x85, "i", 0x7FFFFFFF), "uint32": (0x86, "I", 0xFFFFFFFF),
}  # fmt: skip
_MESSAGES = {m["name"]: (num, m) for num, m in Profile["messages"].items()}
_CRC = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
        0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400]  # fmt: skip


def crc16(data: bytes, crc: int = 0) -> int:
    for byte in data:
        for nibble in (byte & 0xF, byte >> 4):
            tmp = _CRC[crc & 0xF]
            crc = (crc >> 4) & 0x0FFF
            crc = crc ^ tmp ^ _CRC[nibble]
    return crc


def _enum(type_name: str, value: str | None) -> int | None:
    if value is None:
        return None
    for k, v in Profile["types"][type_name].items():
        if v == value:
            return int(k)
    return None


class FitWriter:
    """FIT activity file: one definition per message kind (local types 0-15), then its data."""

    def __init__(self) -> None:
        self.body = bytearray()
        self.local: dict[tuple, int] = {}

    def write(self, message: str, values: dict) -> None:
        num, m = _MESSAGES[message]
        by_name = {f["name"]: (fn, f) for fn, f in m["fields"].items()}
        fields = []
        for name, value in values.items():
            fn, f = by_name[name]
            base = _BASE[f["base_type"]]
            raw = base[2]
            if isinstance(value, str):  # an enum value by its name
                raw = _enum(f["type"], value)
                raw = base[2] if raw is None else raw
            elif value is not None:
                scale = (f["scale"] or [1])[0]
                offset = (f["offset"] or [0])[0]
                raw = round((value + offset) * scale)
                lo, hi = {"b": (-127, 126), "B": (0, 254), "h": (-32767, 32766),
                          "H": (0, 65534), "i": (-(2**31) + 1, 2**31 - 2),
                          "I": (0, 2**32 - 2)}[base[1]]  # fmt: skip
                raw = raw if lo <= raw <= hi else base[2]
            fields.append((fn, base, raw))
        key = (num, tuple((fn, b[0]) for fn, b, _ in fields))
        if key not in self.local:
            local = len(self.local) % 16
            self.local = {k: v for k, v in self.local.items() if v != local}
            self.local[key] = local
            self.body += bytes([0x40 | local, 0, 0]) + struct.pack("<HB", num, len(fields))
            for fn, b, _ in fields:
                self.body += bytes([fn, struct.calcsize(b[1]), b[0]])
        self.body.append(self.local[key])
        for _, b, raw in fields:
            self.body += struct.pack("<" + b[1], raw)

    def bytes(self) -> bytes:
        header = struct.pack("<BBHI4s", 14, 0x20, 2100, len(self.body), b".FIT")
        header += struct.pack("<H", crc16(header))
        data = header + bytes(self.body)
        return data + struct.pack("<H", crc16(data))


def _fit_time(t: datetime) -> int:
    return int((t - FIT_EPOCH).total_seconds())


def _start(a: sqlite3.Row) -> datetime:
    return datetime.strptime(a["start_time_utc"][:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=UTC)


def _channels(conn: sqlite3.Connection, activity_id: int) -> dict[str, list]:
    return {
        r["channel"]: streams.decode(r["encoding"], r["data"])
        for r in conn.execute(
            "SELECT channel, encoding, data FROM streams WHERE activity_id = ?", (activity_id,)
        )
    }


def write_fit(conn: sqlite3.Connection, a: sqlite3.Row) -> bytes:
    """A FIT activity file from the stored activity: records, laps, one session."""
    start = _start(a)
    ch = _channels(conn, a["id"])
    time = ch.get("time") or []
    w = FitWriter()
    w.write("file_id", {"type": "activity", "manufacturer": "development", "product": 0,
                        "time_created": _fit_time(start)})  # fmt: skip
    w.write("event", {"timestamp": _fit_time(start), "event": "timer", "event_type": "start"})
    semi = 2**31 / 180

    def at(name: str, i: int):
        v = ch.get(name)
        return v[i] if v and i < len(v) else None

    last = start
    for i, t in enumerate(time):
        if t is None:
            continue
        lat, lon = at("lat", i), at("lon", i)
        last = start + timedelta(seconds=t)
        w.write("record", {
            "timestamp": _fit_time(last),
            "position_lat": round(lat * semi) if lat is not None and lon is not None else None,
            "position_long": round(lon * semi) if lat is not None and lon is not None else None,
            "enhanced_altitude": at("altitude", i), "heart_rate": at("hr", i),
            "cadence": at("cadence", i), "distance": at("distance", i),
            "enhanced_speed": at("speed", i), "power": at("power", i),
            "temperature": at("temperature", i),
        })  # fmt: skip
    end = max(last, start + timedelta(seconds=a["elapsed_s"] or 0))
    w.write("event", {"timestamp": _fit_time(end), "event": "timer", "event_type": "stop_all"})
    laps = conn.execute("SELECT * FROM laps WHERE activity_id = ? ORDER BY idx", (a["id"],))
    n = 0
    for lap in laps:
        ls = start + timedelta(seconds=lap["start_offset_s"] or 0)
        w.write("lap", {
            "timestamp": _fit_time(ls + timedelta(seconds=lap["elapsed_s"] or 0)),
            "start_time": _fit_time(ls), "event": "lap", "event_type": "stop",
            "total_elapsed_time": lap["elapsed_s"], "total_timer_time": lap["timer_s"],
            "total_distance": lap["distance_m"], "avg_heart_rate": lap["avg_hr"],
            "max_heart_rate": lap["max_hr"], "enhanced_avg_speed": lap["avg_speed"],
            "enhanced_max_speed": lap["max_speed"], "avg_power": lap["avg_power"],
            "total_ascent": lap["ascent_m"], "total_descent": lap["descent_m"],
        })  # fmt: skip
        n += 1
    if n == 0:  # one lap: the whole activity
        w.write("lap", {
            "timestamp": _fit_time(end), "start_time": _fit_time(start), "event": "lap",
            "event_type": "stop", "total_elapsed_time": a["elapsed_s"],
            "total_timer_time": a["timer_s"], "total_distance": a["distance_m"],
        })  # fmt: skip
        n = 1
    sport = _enum("sport", a["sport"])
    w.write("session", {
        "timestamp": _fit_time(end), "start_time": _fit_time(start), "event": "session",
        "event_type": "stop", "sport": sport if sport is not None else 0,
        "sub_sport": _enum("sub_sport", a["sub_sport"]) or 0,
        "total_elapsed_time": a["elapsed_s"], "total_timer_time": a["timer_s"],
        "total_distance": a["distance_m"], "total_calories": a["calories"],
        "avg_heart_rate": a["avg_hr"], "max_heart_rate": a["max_hr"],
        "enhanced_avg_speed": a["avg_speed"], "enhanced_max_speed": a["max_speed"],
        "avg_power": a["avg_power"], "max_power": a["max_power"],
        "total_ascent": a["ascent_m"], "total_descent": a["descent_m"],
        "first_lap_index": 0, "num_laps": n,
    })  # fmt: skip
    local = _fit_time(end) + (a["utc_offset_s"] or 0)
    w.write("activity", {
        "timestamp": _fit_time(end), "total_timer_time": a["timer_s"], "num_sessions": 1,
        "type": "manual", "event": "activity", "event_type": "stop", "local_timestamp": local,
    })  # fmt: skip
    return w.bytes()


def original_fit(
    conn: sqlite3.Connection, a: sqlite3.Row, root: Path | None, uploads_dir: Path | None
) -> bytes | None:
    """The activity's own FIT file, when it came as one (not a GPX/TCX/Strava copy)."""
    if a["fit_uid"].startswith(importer.COPY_UID_PREFIXES):
        return None
    for f in conn.execute(
        "SELECT rel_path, zip_member FROM files WHERE activity_id = ? AND status = 'imported'",
        (a["id"],),
    ):
        try:
            data = importer.read_file_bytes(root, f["rel_path"], f["zip_member"], uploads_dir)
        except (OSError, KeyError, ValueError):
            continue
        if len(data) > 12 and data[8:12] == b".FIT":
            return data
    return None


def fit_bytes(
    conn: sqlite3.Connection, a: sqlite3.Row, root: Path | None, uploads_dir: Path | None
) -> bytes:
    """Export › FIT: the own file unless the activity was corrected, else one written here."""
    own = None if a["fixes"] else original_fit(conn, a, root, uploads_dir)
    return own or write_fit(conn, a)


def gpx_text(conn: sqlite3.Connection, a: sqlite3.Row, name: str) -> str | None:
    """Export › GPX: the route only (positions and altitude, no times or heart rate)."""
    ch = _channels(conn, a["id"])
    lat, lon, alt = ch.get("lat") or [], ch.get("lon") or [], ch.get("altitude") or []
    pts = []
    for i in range(min(len(lat), len(lon))):
        if lat[i] is None or lon[i] is None:
            continue
        ele = alt[i] if i < len(alt) else None
        pts.append(
            f'<trkpt lat="{lat[i]:.6f}" lon="{lon[i]:.6f}">'
            + (f"<ele>{ele:.1f}</ele>" if ele is not None else "")
            + "</trkpt>"
        )
    if len(pts) < 2:
        return None
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<gpx version="1.1" creator="Trailbook" xmlns="http://www.topografix.com/GPX/1/1">\n'
        f"<trk><name>{escape(name)}</name><trkseg>\n"
        + "\n".join(pts)
        + "\n</trkseg></trk>\n</gpx>\n"
    )
