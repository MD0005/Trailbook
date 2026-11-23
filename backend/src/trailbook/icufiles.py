"""Files from intervals.icu prepared for download (Settings › Data › Other sources).

For a person with an intervals.icu key and this switched on, the activity list of the last days
is looked at (one small request, no files) on a timetable (CHECK_SLOTS, local time). Activities
that came from Garmin Connect or Strava are never touched. Any other one is fetched once and
kept only if the file itself was recorded by the virtual-training app (FIT manufacturer
`virtualtraining`); its recording device is set to the Tacx training app (FIT `file_id` and the
creator's `device_info`, same size, CRC recomputed, nothing else changes) and the file waits in
`icu-files/<person>/` until it is downloaded. The file is not imported here: it comes back the
normal way once the person has put it into Garmin Connect. After the download the file is
deleted and the activity is removed from intervals.icu, so the copy that later arrives there
from Garmin is the only one.

Every activity looked at gets a row in `icu_files`, so nothing is fetched twice.
"""

from __future__ import annotations

import gzip
import io
import logging
import re
import sqlite3
import struct
import zipfile
from datetime import date, datetime, time, timedelta
from pathlib import Path

from . import icu
from .importer import now_iso

log = logging.getLogger("trailbook.intervals")

# Local times of the checks: every 30 min from 12:00 to 17:30, every 15 min from 18:00 to 23:00.
CHECK_SLOTS = tuple(time(12 + m // 60, m % 60) for m in range(0, 360, 30)) + tuple(
    time(18 + m // 60, m % 60) for m in range(0, 301, 15)
)
LOOK_BACK_DAYS = 2  # the list is asked for today and this many days before
SKIP_SOURCES = frozenset({"GARMIN_CONNECT", "STRAVA"})

MAKER_FROM = 284  # virtualtraining
MAKER_TO = 89  # tacx
PRODUCT_TO = 30045  # tacx_training_app_android
SERIAL_TO = 1234567890


# ---- timetable -----------------------------------------------------------------------------


def next_check(now: datetime) -> datetime:
    """The first slot after `now` (an aware local time)."""
    for days in (0, 1):
        day = now.date() + timedelta(days=days)
        for slot in CHECK_SLOTS:
            at = datetime.combine(day, slot, now.tzinfo)
            if at > now:
                return at
    raise AssertionError("unreachable")


# ---- FIT ------------------------------------------------------------------------------------

_CRC_TABLE = (0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
              0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400)  # fmt: skip


def fit_crc(data: bytes) -> int:
    crc = 0
    for byte in data:
        for nibble in (byte & 0x0F, byte >> 4):
            tmp = _CRC_TABLE[crc & 0x0F]
            crc = ((crc >> 4) & 0x0FFF) ^ tmp ^ _CRC_TABLE[nibble]
    return crc


def _messages(data: bytes):
    """(global number, field list [(num, offset, size)], byte order, data offset) of every data
    message; a FIT file this cannot walk raises ValueError."""
    if len(data) < 14 or data[0] not in (12, 14) or data[8:12] != b".FIT":
        raise ValueError("not a FIT file")
    end = data[0] + struct.unpack_from("<I", data, 4)[0]
    if end + 2 > len(data):
        raise ValueError("truncated FIT file")
    pos, defs = data[0], {}
    try:
        while pos < end:
            h = data[pos]
            pos += 1
            if h & 0x80:
                local, is_def = (h >> 5) & 0x03, False
            else:
                local, is_def = h & 0x0F, bool(h & 0x40)
            if is_def:
                order = ">" if data[pos + 1] == 1 else "<"
                gnum = struct.unpack_from(order + "H", data, pos + 2)[0]
                n = data[pos + 4]
                pos += 5
                fields, off = [], 0
                for _ in range(n):
                    fields.append((data[pos], off, data[pos + 1]))
                    off += data[pos + 1]
                    pos += 3
                if h & 0x20:
                    nd = data[pos]
                    pos += 1
                    for _ in range(nd):
                        off += data[pos + 1]
                        pos += 3
                defs[local] = (gnum, fields, order, off)
                continue
            gnum, fields, order, size = defs[local]
            yield gnum, fields, order, pos
            pos += size
    except (KeyError, IndexError) as exc:
        raise ValueError("unreadable FIT file") from exc


def _read(data, fields, order, pos, num, code):
    for n, off, size in fields:
        if n == num and size == struct.calcsize(code):
            return struct.unpack_from(order + code, data, pos + off)[0]
    return None


def _write(buf, fields, order, pos, num, code, value) -> None:
    for n, off, size in fields:
        if n == num and size == struct.calcsize(code):
            struct.pack_into(order + code, buf, pos + off, value)


def _blank(buf, fields, pos, num) -> None:
    for n, off, size in fields:
        if n == num:
            buf[pos + off : pos + off + size] = bytes(size)


def is_app_file(data: bytes) -> bool:
    """True when the file was recorded by the virtual-training app (its file_id says so)."""
    try:
        for gnum, fields, order, pos in _messages(data):
            if gnum == 0:
                return _read(data, fields, order, pos, 1, "H") == MAKER_FROM
    except ValueError:
        return False
    return False


def set_device(data: bytes) -> bytes:
    """The same file with the recording device set to the Tacx training app: manufacturer,
    product and serial number in `file_id` and in the creator's `device_info`, the product name
    there emptied. Sizes do not change; the file CRC is recomputed."""
    buf = bytearray(data)
    for gnum, fields, order, pos in _messages(data):
        creator = gnum == 0 or (gnum == 23 and _read(data, fields, order, pos, 0, "B") == 0)
        if not creator:
            continue
        manufacturer, product, serial, name = (1, 2, 3, 8) if gnum == 0 else (2, 4, 3, 27)
        _write(buf, fields, order, pos, manufacturer, "H", MAKER_TO)
        _write(buf, fields, order, pos, product, "H", PRODUCT_TO)
        _write(buf, fields, order, pos, serial, "I", SERIAL_TO)
        _blank(buf, fields, pos, name)
    end = data[0] + struct.unpack_from("<I", data, 4)[0]
    struct.pack_into("<H", buf, end, fit_crc(bytes(buf[:end])))
    return bytes(buf)


def _unpack(raw: bytes) -> bytes:
    """intervals.icu gives the original file, maybe gzipped or zipped."""
    if raw[:2] == b"\x1f\x8b":
        return gzip.decompress(raw)
    if raw[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            names = [n for n in zf.namelist() if n.lower().endswith(".fit")]
            return zf.read(names[0]) if names else b""
    return raw


# ---- the check ------------------------------------------------------------------------------


def set_on(conn: sqlite3.Connection, person_id: str, on: bool) -> None:
    """Switching on starts with the last days (a ride just finished counts), never older."""
    start = (date.today() - timedelta(days=LOOK_BACK_DAYS)).isoformat()
    conn.execute(
        "UPDATE icu_accounts SET files_on = ?, files_from = CASE WHEN ? THEN ? ELSE files_from "
        "END WHERE person_id = ?",
        (int(on), int(on), start, person_id),
    )


def _candidate(item: dict) -> bool:
    """Worth fetching: not from Garmin Connect or Strava (those are never touched)."""
    return str(item.get("source") or "").upper() not in SKIP_SOURCES and bool(item.get("id"))


def _filename(item: dict) -> str:
    name = re.sub(r"[^\w .,()-]+", "_", str(item.get("name") or "activity")).strip(" ._")[:80]
    return f"{str(item.get('start_date_local') or '')[:10]} {name or 'activity'}.fit".strip()


def check_person(conn: sqlite3.Connection, row: sqlite3.Row, files_dir: Path,
                 transport=None) -> int:  # fmt: skip
    """One look at a person's list; returns the number of new files ready."""
    pid = row["person_id"]
    client = icu.Client(row["api_key"], transport)
    _remove_downloaded(conn, client, pid)
    today = date.today()
    oldest = max(row["files_from"] or today.isoformat(),
                 (today - timedelta(days=LOOK_BACK_DAYS)).isoformat())  # fmt: skip
    items = (
        client.call("GET", f"/athlete/0/activities?oldest={oldest}&newest={today.isoformat()}")
        or []
    )
    known = {r[0] for r in conn.execute("SELECT icu_id FROM icu_files WHERE person_id = ?", (pid,))}
    ready = 0
    for item in items:
        aid = str(item.get("id") or "")
        if not aid or aid in known:
            continue
        name, start = item.get("name"), item.get("start_date_local")
        if not _candidate(item):
            conn.execute(
                "INSERT INTO icu_files (person_id, icu_id, name, start_local, state, created_at) "
                "VALUES (?, ?, ?, ?, 'skipped', ?)",
                (pid, aid, name, start, now_iso()),
            )
            continue
        data = _unpack(client.call_raw("GET", f"/activity/{aid}/file"))
        if not is_app_file(data):
            conn.execute(
                "INSERT INTO icu_files (person_id, icu_id, name, start_local, state, created_at) "
                "VALUES (?, ?, ?, ?, 'skipped', ?)",
                (pid, aid, name, start, now_iso()),
            )
            continue
        folder = files_dir / re.sub(r"[^A-Za-z0-9._-]+", "_", pid)
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / f"{re.sub(r'[^A-Za-z0-9]+', '', aid)}.fit"
        target.write_bytes(set_device(data))
        conn.execute(
            "INSERT INTO icu_files (person_id, icu_id, name, start_local, state, path, created_at) "
            "VALUES (?, ?, ?, ?, 'ready', ?, ?)",
            (pid, aid, _filename(item), start, str(target), now_iso()),
        )
        log.info("intervals.icu activity %s of %s ready to download", aid, pid)
        ready += 1
    return ready


def _remove_downloaded(conn: sqlite3.Connection, client: icu.Client, pid: str) -> None:
    for r in conn.execute(
        "SELECT icu_id FROM icu_files WHERE person_id = ? AND state = 'delete'", (pid,)
    ).fetchall():
        remove_from_icu(conn, client, pid, r["icu_id"])


def remove_from_icu(conn: sqlite3.Connection, client: icu.Client, pid: str, aid: str) -> bool:
    try:
        client.call("DELETE", f"/activity/{aid}")
    except icu.IcuError as exc:
        conn.execute(
            "UPDATE icu_files SET error = ? WHERE person_id = ? AND icu_id = ?",
            (str(exc), pid, aid),
        )
        log.warning("intervals.icu activity %s of %s not removed: %s", aid, pid, exc)
        return False
    conn.execute(
        "UPDATE icu_files SET state = 'done', error = NULL WHERE person_id = ? AND icu_id = ?",
        (pid, aid),
    )
    return True


def check_all(conn: sqlite3.Connection, files_dir: Path, transport=None) -> int:
    ready = 0
    for row in conn.execute(
        "SELECT * FROM icu_accounts WHERE files_on = 1 AND status != 'auth_error'"
    ).fetchall():
        try:
            ready += check_person(conn, row, files_dir, transport)
        except (icu.IcuError, ValueError, OSError, zipfile.BadZipFile) as exc:
            log.warning("intervals.icu files of %s not checked: %s", row["person_id"], exc)
            if isinstance(exc, icu.IcuError) and exc.auth:
                conn.execute(
                    "UPDATE icu_accounts SET status = 'auth_error', last_error = ? "
                    "WHERE person_id = ?",
                    (str(exc), row["person_id"]),
                )
    return ready


# ---- the list and the download --------------------------------------------------------------


def state(conn: sqlite3.Connection) -> dict[str, dict]:
    """Per person with a key: on/off and the files waiting."""
    out = {}
    for a in conn.execute("SELECT person_id, files_on, status FROM icu_accounts"):
        files = [
            {"id": r["icu_id"], "name": r["name"], "start": r["start_local"]}
            for r in conn.execute(
                "SELECT * FROM icu_files WHERE person_id = ? AND state = 'ready' "
                "ORDER BY start_local",
                (a["person_id"],),
            )
            if r["path"] and Path(r["path"]).is_file()  # e.g. not after a restore elsewhere
        ]
        out[a["person_id"]] = {"on": bool(a["files_on"]), "status": a["status"], "files": files}
    return out


def take(conn: sqlite3.Connection, pid: str, aid: str) -> tuple[Path, str] | None:
    """A waiting file for its download: (path, file name), marked as taken at once so a second
    click gets nothing; None = not waiting (any more)."""
    r = conn.execute(
        "SELECT * FROM icu_files WHERE person_id = ? AND icu_id = ? AND state = 'ready'",
        (pid, aid),
    ).fetchone()
    if not r or not r["path"] or not Path(r["path"]).is_file():
        return None
    conn.execute(
        "UPDATE icu_files SET state = 'delete' WHERE person_id = ? AND icu_id = ?", (pid, aid)
    )
    return Path(r["path"]), r["name"] or f"{aid}.fit"


def after_download(conn: sqlite3.Connection, pid: str, aid: str, path: Path,
                   transport=None) -> None:  # fmt: skip
    """The file is gone from the server, the activity from intervals.icu (or at the next check
    when intervals.icu is not reachable now)."""
    path.unlink(missing_ok=True)
    conn.execute("UPDATE icu_files SET path = NULL WHERE person_id = ? AND icu_id = ?", (pid, aid))
    row = conn.execute("SELECT api_key FROM icu_accounts WHERE person_id = ?", (pid,)).fetchone()
    if row:
        remove_from_icu(conn, icu.Client(row["api_key"], transport), pid, aid)
