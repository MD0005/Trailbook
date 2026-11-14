import struct
from pathlib import Path

import pytest

from trailbook import db

REPO_ROOT = Path(__file__).resolve().parents[2]
SAMPLE_DATA = REPO_ROOT / "sample-data"


def make_fit(file_type: int, extra: bytes = b"") -> bytes:
    """Minimal FIT file containing only a file_id message of the given type."""
    definition = bytes([0x40, 0, 0]) + struct.pack("<H", 0) + bytes([1, 0, 1, 0x00])
    data = bytes([0x00, file_type]) + extra
    body = definition + data
    header = bytes([14, 0x20]) + struct.pack("<H", 2100) + struct.pack("<I", len(body)) + b".FIT"
    return header + b"\x00\x00" + body + b"\x00\x00"


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "test.db")
    yield c
    c.close()
