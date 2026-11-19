import struct
from pathlib import Path

import pytest

from trailbook import db

REPO_ROOT = Path(__file__).resolve().parents[2]
SAMPLE_DATA = REPO_ROOT / "sample-data"


def make_fit(
    file_type: int, extra: bytes = b"", serial: int | None = None, created: int | None = None
) -> bytes:
    """Minimal FIT file with only a file_id message (type, optional serial and time_created).

    `created` is in FIT time (seconds since 1989-12-31T00:00:00Z).
    """
    fields = [(0, 1, 0x00)]
    payload = bytes([file_type])
    if serial is not None:
        fields.append((3, 4, 0x8C))
        payload += struct.pack("<I", serial)
    if created is not None:
        fields.append((4, 4, 0x86))
        payload += struct.pack("<I", created)
    definition = bytes([0x40, 0, 0]) + struct.pack("<H", 0) + bytes([len(fields)])
    definition += b"".join(bytes(f) for f in fields)
    data = bytes([0x00]) + payload + extra
    body = definition + data
    header = bytes([14, 0x20]) + struct.pack("<H", 2100) + struct.pack("<I", len(body)) + b".FIT"
    return header + b"\x00\x00" + body + b"\x00\x00"


def pytest_addoption(parser):
    parser.addoption(
        "--samples", action="store_true", help="also run the tests on the local sample-data/"
    )


def pytest_collection_modifyitems(config, items):
    """Tests marked `samples` import the whole sample-data/ folder and take minutes: they run
    only with --samples, and only when the folder (not in git) has FIT files."""
    if not config.getoption("--samples"):
        reason = "slow: run with --samples"
    elif not SAMPLE_DATA.is_dir() or not any(SAMPLE_DATA.rglob("*.fit")):
        reason = "no local sample-data"
    else:
        return
    skip = pytest.mark.skip(reason=reason)
    for item in items:
        if "samples" in item.keywords:
            item.add_marker(skip)


@pytest.fixture(autouse=True)
def _no_background_surface(monkeypatch):
    """Road surface in the background is on by default; tests never reach OpenStreetMap."""
    from trailbook import surface

    monkeypatch.setattr(surface, "next_missing", lambda conn: None)


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "test.db")
    yield c
    c.close()
