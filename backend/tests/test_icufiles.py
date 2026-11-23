"""Files from intervals.icu prepared for download: the FIT device change, the timetable, the
check (fake transport), the download and the removal from intervals.icu."""

import gzip
import json
import struct
from datetime import datetime, timedelta, timezone

import pytest
from garmin_fit_sdk import Decoder, Stream

from trailbook import icu, icufiles


def _def(local, gnum, fields):
    return (
        bytes([0x40 | local, 0, 0])
        + struct.pack("<H", gnum)
        + bytes([len(fields)])
        + b"".join(bytes(f) for f in fields)
    )


def app_fit(maker=icufiles.MAKER_FROM) -> bytes:
    """file_id + creator device_info + a sensor device_info + one record, laid out like the
    app writes them (serial present but 0, product name as a string)."""
    created = 1_100_000_000
    body = _def(
        0, 0, [(3, 4, 0x8C), (0, 1, 0), (4, 4, 0x86), (1, 2, 0x84), (2, 2, 0x84), (8, 6, 7)]
    )
    body += b"\x00" + struct.pack("<IBIHH", 0, 4, created, maker, 1) + b"Rouvy\x00"
    body += _def(1, 23, [(253, 4, 0x86), (4, 2, 0x84), (27, 10, 7), (2, 2, 0x84), (3, 4, 0x8C),
                         (0, 1, 2)])  # fmt: skip
    body += b"\x01" + struct.pack("<IH", created, 1) + b"Rouvy".ljust(10, b"\x00")
    body += struct.pack("<HIB", maker, 0, 0)
    body += b"\x01" + struct.pack("<IH", created, 0xFFFF) + b"HRM".ljust(10, b"\x00")
    body += struct.pack("<HIB", 1, 837217, 1)
    body += _def(2, 20, [(253, 4, 0x86), (7, 2, 0x84), (3, 1, 2)])
    body += b"\x02" + struct.pack("<IHB", created, 215, 140)
    header = bytes([14, 0x20]) + struct.pack("<H", 2100) + struct.pack("<I", len(body)) + b".FIT"
    header += struct.pack("<H", icufiles.fit_crc(header))
    data = header + body
    return data + struct.pack("<H", icufiles.fit_crc(data))


def decode(data):
    messages, errors = Decoder(Stream.from_byte_array(bytearray(data))).read()
    assert errors == []
    return messages


def test_set_device_changes_only_the_device():
    src = app_fit()
    assert icufiles.is_app_file(src)
    out = icufiles.set_device(src)
    assert len(out) == len(src)
    assert Decoder(Stream.from_byte_array(bytearray(out))).check_integrity()
    a, b = decode(src), decode(out)
    fid = b["file_id_mesgs"][0]
    assert fid["manufacturer"] == "tacx"
    assert fid["garmin_product"] == "tacx_training_app_android"
    assert fid["serial_number"] == icufiles.SERIAL_TO
    assert "product_name" not in fid
    creator, sensor = b["device_info_mesgs"]
    assert creator["manufacturer"] == "tacx" and creator["serial_number"] == icufiles.SERIAL_TO
    assert "product_name" not in creator
    assert sensor == a["device_info_mesgs"][1]  # the sensors stay
    assert b["record_mesgs"] == a["record_mesgs"]
    assert not icufiles.is_app_file(out)


def test_other_files_are_not_app_files():
    assert not icufiles.is_app_file(app_fit(maker=1))  # garmin
    assert not icufiles.is_app_file(b"not a fit file at all")


def test_timetable():
    tz = timezone(timedelta(hours=1))
    at = lambda h, m: datetime(2026, 11, 22, h, m, tzinfo=tz)  # noqa: E731
    assert icufiles.next_check(at(9, 0)) == at(12, 0)
    assert icufiles.next_check(at(12, 0)) == at(12, 30)
    assert icufiles.next_check(at(17, 40)) == at(18, 0)
    assert icufiles.next_check(at(18, 5)) == at(18, 15)
    assert icufiles.next_check(at(22, 50)) == at(23, 0)
    assert icufiles.next_check(at(23, 0)) == datetime(2026, 11, 23, 12, 0, tzinfo=tz)


class FakeIcu:
    def __init__(self, items, files):
        self.items, self.files, self.calls = items, files, []

    def __call__(self, method, url, headers, body):
        path = url.removeprefix(icu.BASE_URL)
        self.calls.append((method, path))
        if path.startswith("/athlete/0/activities"):
            return 200, json.dumps(self.items).encode()
        if method == "GET" and path.endswith("/file"):
            return 200, self.files[path.split("/")[2]]
        if method == "DELETE":
            return 200, b""
        return 404, b""


@pytest.fixture
def person(conn):
    conn.execute("INSERT INTO persons (id, label) VALUES ('p', 'P')")
    icu.set_account(conn, "p", "abcdefghijkl")
    icufiles.set_on(conn, "p", True)
    return "p"


def test_check_download_and_remove(conn, person, tmp_path):
    day = "2026-11-22T"
    items = [
        {"id": "i1", "source": "GARMIN_CONNECT", "name": "Run", "start_date_local": day + "08:00"},
        {
            "id": "i2",
            "source": "OAUTH_CLIENT",
            "name": "Ride: Alps",
            "start_date_local": day + "20:55",
        },
        {"id": "i3", "source": "UPLOAD", "name": "Other", "start_date_local": day + "10:00"},
    ]
    fake = FakeIcu(items, {"i2": gzip.compress(app_fit()), "i3": app_fit(maker=1)})
    assert icufiles.check_all(conn, tmp_path, fake) == 1
    # Garmin Connect is never fetched
    assert ("GET", "/activity/i1/file") not in fake.calls
    files = icufiles.state(conn)["p"]["files"]
    assert [f["id"] for f in files] == ["i2"]
    assert files[0]["name"] == "2026-11-22 Ride_ Alps.fit"
    # a second look fetches nothing again
    fake.calls.clear()
    assert icufiles.check_all(conn, tmp_path, fake) == 0
    assert [c for c in fake.calls if c[1].endswith("/file")] == []

    path, name = icufiles.take(conn, "p", "i2")
    assert decode(path.read_bytes())["file_id_mesgs"][0]["manufacturer"] == "tacx"
    assert icufiles.take(conn, "p", "i2") is None  # a second click gets nothing
    icufiles.after_download(conn, "p", "i2", path, fake)
    assert not path.exists()
    assert ("DELETE", "/activity/i2") in fake.calls
    assert conn.execute("SELECT state FROM icu_files WHERE icu_id = 'i2'").fetchone()[0] == "done"
    assert icufiles.state(conn)["p"]["files"] == []


def test_removal_waits_when_unreachable(conn, person, tmp_path):
    fake = FakeIcu([{"id": "i2", "source": "OAUTH_CLIENT", "name": "R",
                     "start_date_local": "2026-11-22T20:00:00"}], {"i2": app_fit()})  # fmt: skip
    icufiles.check_all(conn, tmp_path, fake)
    path, _ = icufiles.take(conn, "p", "i2")

    def down(*a):
        raise icu.IcuError("intervals.icu is not reachable")

    icufiles.after_download(conn, "p", "i2", path, down)
    assert conn.execute("SELECT state FROM icu_files WHERE icu_id = 'i2'").fetchone()[0] == "delete"
    icufiles.check_all(conn, tmp_path, fake)  # the next look removes it
    assert ("DELETE", "/activity/i2") in fake.calls
    assert conn.execute("SELECT state FROM icu_files WHERE icu_id = 'i2'").fetchone()[0] == "done"


def test_off_checks_nothing(conn, person, tmp_path):
    icufiles.set_on(conn, "p", False)
    fake = FakeIcu([], {})
    assert icufiles.check_all(conn, tmp_path, fake) == 0
    assert fake.calls == []
