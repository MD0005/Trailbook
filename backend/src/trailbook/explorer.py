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


def tile_bounds(x: int, y: int, zoom: int = ZOOM) -> tuple[float, float, float, float]:
    """(west, south, east, north) in degrees."""
    n = 1 << zoom

    def lat(yy: int) -> float:
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yy / n))))

    return x / n * 360.0 - 180.0, lat(y + 1), (x + 1) / n * 360.0 - 180.0, lat(y)


def tiles_of_track(
    lats: list[float | None], lons: list[float | None], zoom: int = ZOOM
) -> set[Tile]:
    """All tiles touched by a track, filling gaps where consecutive points skip tiles."""
    tiles: set[Tile] = set()
    prev: tuple[float, float, Tile] | None = None
    for lat, lon in zip(lats, lons, strict=True):
        if lat is None or lon is None:
            prev = None  # GPS gap: do not invent a line across it
            continue
        t = tile_of(lat, lon, zoom)
        tiles.add(t)
        if prev is not None:
            plat, plon, pt = prev
            steps = max(abs(t[0] - pt[0]), abs(t[1] - pt[1]))
            if steps > 1:
                # Sample the segment densely enough not to jump over a tile.
                k = steps * 4
                for i in range(1, k):
                    f = i / k
                    tiles.add(tile_of(plat + (lat - plat) * f, plon + (lon - plon) * f, zoom))
        prev = (lat, lon, t)
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
