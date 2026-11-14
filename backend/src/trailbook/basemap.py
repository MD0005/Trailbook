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
