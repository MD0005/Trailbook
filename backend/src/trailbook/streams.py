"""Compact storage of per-second activity streams.

Each channel is one array: little-endian float32 (or float64 for coordinates),
zlib-compressed. Missing samples are NaN.
"""

from __future__ import annotations

import math
import sys
import zlib
from array import array

_CODES = {"f32": "f", "f64": "d"}


def encode(values: list[float | None], kind: str = "f32") -> tuple[str, bytes]:
    arr = array(_CODES[kind], (math.nan if v is None else v for v in values))
    if sys.byteorder != "little":
        arr.byteswap()
    return f"zlib-{kind}le", zlib.compress(arr.tobytes(), 6)


def decode(encoding: str, data: bytes) -> list[float | None]:
    kind = encoding.removeprefix("zlib-").removesuffix("le")
    arr = array(_CODES[kind])
    arr.frombytes(zlib.decompress(data))
    if sys.byteorder != "little":
        arr.byteswap()
    return [None if math.isnan(v) else v for v in arr]
