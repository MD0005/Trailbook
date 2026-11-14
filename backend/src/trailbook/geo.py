"""Geometry helpers: coordinate conversion, track simplification, polyline encoding."""

from __future__ import annotations

import math

SEMICIRCLE_TO_DEG = 180.0 / 2**31
EARTH_RADIUS_M = 6_371_000.0


def semicircles_to_deg(value: int | None) -> float | None:
    if value is None:
        return None
    return value * SEMICIRCLE_TO_DEG


def simplify(
    points: list[tuple[float, float]], tolerance_m: float = 5.0
) -> list[tuple[float, float]]:
    """Douglas–Peucker simplification of (lat, lon) points with a tolerance in metres.

    Uses a local equirectangular projection, accurate enough for single activities.
    Iterative, so long tracks do not hit the recursion limit.
    """
    n = len(points)
    if n < 3:
        return list(points)

    lat0 = math.radians(sum(p[0] for p in points) / n)
    kx = math.cos(lat0) * math.pi / 180.0 * EARTH_RADIUS_M
    ky = math.pi / 180.0 * EARTH_RADIUS_M
    xy = [(lon * kx, lat * ky) for lat, lon in points]

    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    tol2 = tolerance_m * tolerance_m

    while stack:
        first, last = stack.pop()
        ax, ay = xy[first]
        bx, by = xy[last]
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        max_d2, index = -1.0, -1
        for i in range(first + 1, last):
            px, py = xy[i]
            if seg2 == 0:
                d2 = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
                cx, cy = ax + t * dx, ay + t * dy
                d2 = (px - cx) ** 2 + (py - cy) ** 2
            if d2 > max_d2:
                max_d2, index = d2, i
        if max_d2 > tol2:
            keep[index] = True
            stack.append((first, index))
            stack.append((index, last))

    return [p for p, k in zip(points, keep, strict=True) if k]


def encode_polyline(points: list[tuple[float, float]], precision: int = 5) -> str:
    """Encode (lat, lon) points with the Google polyline algorithm."""
    factor = 10**precision
    out: list[str] = []
    prev_lat = prev_lon = 0
    for lat, lon in points:
        ilat, ilon = round(lat * factor), round(lon * factor)
        for delta in (ilat - prev_lat, ilon - prev_lon):
            value = ~(delta << 1) if delta < 0 else delta << 1
            while value >= 0x20:
                out.append(chr((0x20 | (value & 0x1F)) + 63))
                value >>= 5
            out.append(chr(value + 63))
        prev_lat, prev_lon = ilat, ilon
    return "".join(out)


def decode_polyline(text: str, precision: int = 5) -> list[tuple[float, float]]:
    factor = 10**precision
    points: list[tuple[float, float]] = []
    index = lat = lon = 0
    while index < len(text):
        deltas = []
        for _ in range(2):
            shift = result = 0
            while True:
                b = ord(text[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            deltas.append(~(result >> 1) if result & 1 else result >> 1)
        lat += deltas[0]
        lon += deltas[1]
        points.append((lat / factor, lon / factor))
    return points
