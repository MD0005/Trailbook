"""Explorer tiles: visited tiles, max square and cluster.

A tile is a square of the web-mercator grid at zoom 14 (about 1-2 km wide, depending on
latitude). A tile is "visited" when any recorded GPS point of an activity lies in it.

- **Max square**: the largest N x N block of visited tiles.
- **Cluster**: tiles whose four neighbours (N, S, E, W) are all visited; the cluster is the
  largest 4-connected group of such tiles.
"""

from __future__ import annotations

import math
from collections import deque

ZOOM = 14

Tile = tuple[int, int]


def tile_of(lat: float, lon: float, zoom: int = ZOOM) -> Tile:
    n = 1 << zoom
    lat = max(min(lat, 85.0511), -85.0511)
    x = int((lon + 180.0) / 360.0 * n)
    rad = math.radians(lat)
    y = int((1.0 - math.log(math.tan(rad) + 1.0 / math.cos(rad)) / math.pi) / 2.0 * n)
    return min(max(x, 0), n - 1), min(max(y, 0), n - 1)


def tile_xy(lat: float, lon: float, zoom: int = ZOOM) -> tuple[float, float]:
    """The position in tile units (not rounded): whole numbers are tile edges."""
    n = 1 << zoom
    lat = max(min(lat, 85.0511), -85.0511)
    rad = math.radians(lat)
    return (lon + 180.0) / 360.0 * n, (
        1.0 - math.log(math.tan(rad) + 1.0 / math.cos(rad)) / math.pi
    ) / 2.0 * n


def walk_tiles(a: tuple[float, float], b: tuple[float, float]) -> list[Tile]:
    """Every tile a straight segment passes through after its first (a grid walk: crossing an x
    or a y edge, whichever comes first), so a line cutting a tile's corner counts it too."""
    (ax, ay), (bx, by) = a, b
    x, y, ex, ey = math.floor(ax), math.floor(ay), math.floor(bx), math.floor(by)
    dx, dy = bx - ax, by - ay
    sx, sy = (dx > 0) - (dx < 0), (dy > 0) - (dy < 0)
    tdx = abs(1 / dx) if dx else math.inf
    tdy = abs(1 / dy) if dy else math.inf
    tx = (x + 1 - ax) / dx if dx > 0 else (ax - x) / -dx if dx < 0 else math.inf
    ty = (y + 1 - ay) / dy if dy > 0 else (ay - y) / -dy if dy < 0 else math.inf
    out: list[Tile] = []
    while (x, y) != (ex, ey) and len(out) < 100_000:
        if tx < ty:
            x, tx = x + sx, tx + tdx
        else:
            y, ty = y + sy, ty + tdy
        out.append((x, y))
    return out


def tile_bounds(x: int, y: int, zoom: int = ZOOM) -> tuple[float, float, float, float]:
    """(west, south, east, north) in degrees."""
    n = 1 << zoom

    def lat(yy: int) -> float:
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yy / n))))

    return x / n * 360.0 - 180.0, lat(y + 1), (x + 1) / n * 360.0 - 180.0, lat(y)


def tiles_of_track(
    lats: list[float | None], lons: list[float | None], zoom: int = ZOOM
) -> set[Tile]:
    """All tiles a track passes through: each point's tile and every tile on the straight line
    to the next point (corners cut included)."""
    tiles: set[Tile] = set()
    prev: tuple[float, float] | None = None
    for lat, lon in zip(lats, lons, strict=True):
        if lat is None or lon is None:
            prev = None  # GPS gap: do not invent a line across it
            continue
        tiles.add(tile_of(lat, lon, zoom))
        p = tile_xy(lat, lon, zoom)
        if prev is not None:
            tiles.update(walk_tiles(prev, p))
        prev = p
    return tiles


def max_square(tiles: set[Tile]) -> tuple[int, int, int]:
    """Largest square of visited tiles: (size, x_min, y_min). Size 0 if no tiles."""
    best = (0, 0, 0)
    dp: dict[Tile, int] = {}
    for x, y in sorted(tiles, key=lambda t: (t[1], t[0])):
        size = 1 + min(dp.get((x - 1, y), 0), dp.get((x, y - 1), 0), dp.get((x - 1, y - 1), 0))
        dp[(x, y)] = size
        if size > best[0]:
            best = (size, x - size + 1, y - size + 1)
    return best


def cluster(tiles: set[Tile]) -> set[Tile]:
    """Largest 4-connected group of tiles whose four neighbours are all visited."""
    inner = {
        (x, y)
        for x, y in tiles
        if (x - 1, y) in tiles
        and (x + 1, y) in tiles
        and (x, y - 1) in tiles
        and (x, y + 1) in tiles
    }
    best: set[Tile] = set()
    seen: set[Tile] = set()
    for start in inner:
        if start in seen:
            continue
        group = {start}
        seen.add(start)
        queue = deque([start])
        while queue:
            x, y = queue.popleft()
            for nb in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if nb in inner and nb not in seen:
                    seen.add(nb)
                    group.add(nb)
                    queue.append(nb)
        if len(group) > len(best):
            best = group
    return best
