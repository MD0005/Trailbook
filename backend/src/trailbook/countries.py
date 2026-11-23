"""The country of an activity, from the country outlines the app already ships.

Outlines: static/regions/<code>.json (Natural Earth 1:10m, built by tools/build_regions.py;
rings as integer deltas of 1/1000 degree), with `boxes.json` holding each outline polygon's
bounding box, so only the files whose box holds a point are read. Nothing is asked of any
server.

The country is that of the route: the start point, else the first of a few points along the
track that lies in a country (a start on a beach or a pier can fall just outside the
simplified outline). A virtual route counts as the place the app's route is in (a ride at home
on a route from New Zealand is New Zealand); an app's made-up world in the sea has none.
"""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path

REGIONS = Path(__file__).resolve().parent / "static" / "regions"
SCALE = 1000
TRACK_POINTS = 24  # points along the track tried after the start


@cache
def _boxes() -> dict[str, list[list[int]]]:
    return json.loads((REGIONS / "boxes.json").read_text(encoding="utf-8"))


@cache
def names() -> dict[str, str]:
    """Country code → English name."""
    index = json.loads((REGIONS / "index.json").read_text(encoding="utf-8"))
    return {c["c"]: c["n"] for c in index}


@cache
def _rings(code: str) -> tuple[tuple[tuple[int, int], ...], ...]:
    data = json.loads((REGIONS / f"{code}.json").read_text(encoding="utf-8"))
    out = []
    for poly in data["g"]:
        for ring in poly:
            x = y = 0
            pts = []
            for i in range(0, len(ring), 2):
                x += ring[i]
                y += ring[i + 1]
                pts.append((x, y))
            out.append(tuple(pts))
    return tuple(out)


def _inside(rings, x: float, y: float) -> bool:
    """Even-odd rule over all rings (holes are left out)."""
    hit = False
    for pts in rings:
        n = len(pts)
        j = n - 1
        for i in range(n):
            xi, yi = pts[i]
            xj, yj = pts[j]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                hit = not hit
            j = i
    return hit


def country_at(lat: float, lon: float) -> str | None:
    """Country code of a point, None at sea or outside every outline."""
    x, y = lon * SCALE, lat * SCALE
    for code, boxes in _boxes().items():
        if any(b[0] <= x <= b[2] and b[1] <= y <= b[3] for b in boxes):
            if _inside(_rings(code), x, y):
                return code
    return None


def of_route(start: tuple | None, lat: list | None, lon: list | None) -> str | None:
    """The country of a route: the start point, else the first point along it in a country."""
    points = []
    if start and start[0] is not None and start[1] is not None:
        points.append(start)
    pairs = [(a, b) for a, b in zip(lat or [], lon or [], strict=False)
             if a is not None and b is not None]  # fmt: skip
    if pairs:
        step = max(1, len(pairs) // TRACK_POINTS)
        points += pairs[::step]
    for la, lo in points:
        if la == 0 and lo == 0:  # no fix
            continue
        code = country_at(la, lo)
        if code:
            return code
    return None
