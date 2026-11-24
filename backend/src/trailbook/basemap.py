"""Base map tiles: fetched from the tile server once, then served from a disk cache.

The browser only talks to Trailbook (works behind HA Ingress, no third-party requests from
the browser). Tiles are kept on disk, so panning over known areas needs no network and the
tile server sees each tile only once.
"""

from __future__ import annotations

import hashlib
import os
import threading
import urllib.error
import urllib.request
from pathlib import Path

from . import __version__

# Raster tiles of the OpenStreetMap Foundation; usage policy:
# https://operations.osmfoundation.org/policies/tiles/ — a proper User-Agent and caching
# are required, both done here. The URL is configurable (setting `basemap_url`).
DEFAULT_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
USER_AGENT = f"Trailbook/{__version__} (self-hosted training log; tile cache)"
TIMEOUT_S = 10

# Base maps the user can choose from. Only these URLs are fetched (no open proxy).
# key: (url template, max zoom, attribution, label)
SOURCES: dict[str, tuple[str, int, str, str]] = {
    "osm": (DEFAULT_URL, 19, "© OpenStreetMap contributors", "OpenStreetMap"),
    "topo": (
        "https://tile.opentopomap.org/{z}/{x}/{y}.png",
        17,
        "© OpenStreetMap contributors, SRTM · style © OpenTopoMap (CC-BY-SA)",
        "OpenTopoMap (terrain)",
    ),
    "cyclosm": (
        "https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png",
        20,
        "© OpenStreetMap contributors · style © CyclOSM",
        "CyclOSM (cycling & trails)",
    ),
    "hot": (
        "https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
        19,
        "© OpenStreetMap contributors · style © Humanitarian OpenStreetMap Team, OSM France",
        "Humanitarian (HOT)",
    ),
}

# Elevation tiles for the Relief option (hills shaded over the base map, worked out in the
# browser): Terrain Tiles, open data on AWS, Terrarium encoding (height = R*256 + G + B/256 -
# 32768 m). Not a base map of their own, so not in SOURCES (the Base map list).
OVERLAYS: dict[str, tuple[str, int, str, str]] = {
    "terrain": (
        "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
        15,
        "Relief: Terrain Tiles (Mapzen, AWS Open Data; SRTM, GMTED, ETOPO1 and others)",
        "Relief",
    ),
    # Waymarked Trails: marked routes, transparent, drawn over the base map (Trails option)
    **{
        f"trails-{kind}": (
            f"https://tile.waymarkedtrails.org/{kind}/{{z}}/{{x}}/{{y}}.png",
            18,
            "Trails © waymarkedtrails.org, OpenStreetMap contributors (CC-BY-SA)",
            label,
        )
        for kind, label in (("hiking", "Hiking"), ("cycling", "Cycling"), ("mtb", "MTB"))
    },
}


class TileError(Exception):
    pass


class TileCache:
    def __init__(self, directory: str | Path):
        self.dir = Path(directory)
        self._lock = threading.Lock()

    def path(self, template: str, z: int, x: int, y: int) -> Path:
        # Separate cache per tile source, so changing the source never mixes tiles.
        if template == DEFAULT_URL:
            source = "osm"
        else:
            source = hashlib.sha1(template.encode()).hexdigest()[:12]
        return self.dir / source / str(z) / str(x) / f"{y}.png"

    def get(self, template: str, z: int, x: int, y: int) -> tuple[bytes, str]:
        path = self.path(template, z, x, y)
        if path.is_file():
            return path.read_bytes(), "image/png"
        url = template.format(z=z, x=x, y=y)
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_S) as resp:
                data = resp.read()
                media_type = resp.headers.get_content_type() or "image/png"
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise TileError(f"tile server unavailable: {exc}") from exc
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
        tmp.write_bytes(data)
        with self._lock:
            os.replace(tmp, path)
        return data, media_type
