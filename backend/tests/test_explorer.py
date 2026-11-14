import shutil

import pytest
from conftest import SAMPLE_DATA
from starlette.testclient import TestClient

from trailbook import basemap, db, explorer, importer
from trailbook.api import create_app


def test_tile_of_known_values():
    assert explorer.tile_of(0.0, 0.0) == (8192, 8192)
    assert explorer.tile_of(85.0, -180.0)[0] == 0
    w, s, e, n = explorer.tile_bounds(8192, 8192)
    assert w == 0.0 and n == pytest.approx(0.0, abs=1e-9) and e > 0 and s < 0


def test_tiles_of_track_fills_gaps_but_not_across_missing_gps():
    # Two points ~5 tiles apart in longitude, same latitude: the line in between counts.
    w0, _, e0, _ = explorer.tile_bounds(8192, 8000)
    lat = 30.0
    lon_a = (w0 + e0) / 2
    lon_b = lon_a + 5 * (e0 - w0)
    tiles = explorer.tiles_of_track([lat, lat], [lon_a, lon_b])
    xs = sorted(x for x, _ in tiles)
    assert xs == list(range(xs[0], xs[0] + 6))
    # With a GPS gap (None) in between, no line is invented.
    gap = explorer.tiles_of_track([lat, None, lat], [lon_a, None, lon_b])
    assert len(gap) == 2


def test_max_square_and_cluster():
    block = {(x, y) for x in range(10, 14) for y in range(20, 24)}  # 4 x 4
    extra = {(14, 20), (30, 30)}
    tiles = block | extra
    assert explorer.max_square(tiles) == (4, 10, 20)
    # Inner tiles of a 4x4 block: the 2x2 centre.
    assert explorer.cluster(tiles) == {(11, 21), (12, 21), (11, 22), (12, 22)}
    assert explorer.max_square(set()) == (0, 0, 0)
    assert explorer.cluster(set()) == set()


def test_tile_cache_fetches_once(tmp_path, monkeypatch):
    calls = []

    class FakeResponse:
        headers = type("H", (), {"get_content_type": staticmethod(lambda: "image/png")})()

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b"PNG"

    def fake_urlopen(request, timeout):
        calls.append(request.full_url)
        assert "Trailbook" in request.get_header("User-agent")
        return FakeResponse()

    monkeypatch.setattr(basemap.urllib.request, "urlopen", fake_urlopen)
    cache = basemap.TileCache(tmp_path)
    assert cache.get(basemap.DEFAULT_URL, 3, 1, 2) == (b"PNG", "image/png")
    assert cache.get(basemap.DEFAULT_URL, 3, 1, 2) == (b"PNG", "image/png")
    assert calls == ["https://tile.openstreetmap.org/3/1/2.png"]
    other = "https://example.invalid/{z}/{x}/{y}.png"
    assert cache.path(other, 1, 0, 0) == cache.path(other, 1, 0, 0)  # stable across calls
    assert cache.path(other, 1, 0, 0) != cache.path(basemap.DEFAULT_URL, 1, 0, 0)


def test_basemap_endpoint_validates_and_reports_errors(tmp_path, monkeypatch):
    client = TestClient(create_app(tmp_path / "t.db"))
    assert {b["key"] for b in client.get("/api/basemaps").json()} == {"osm", "topo", "cyclosm"}
    assert client.get("/api/basemap/osm/3/99/0.png").status_code == 404
    assert client.get("/api/basemap/topo/18/0/0.png").status_code == 404  # above max zoom
    assert client.get("/api/basemap/evil/3/1/1.png").status_code == 404  # no open proxy

    def boom(*a, **k):
        raise basemap.urllib.error.URLError("offline")

    monkeypatch.setattr(basemap.urllib.request, "urlopen", boom)
    assert client.get("/api/basemap/osm/3/1/1.png").status_code == 502


@pytest.mark.skipif(not SAMPLE_DATA.is_dir(), reason="no local sample-data")
def test_heatmap_endpoints_on_sample_data(tmp_path):
    root = tmp_path / "root"
    shutil.copytree(SAMPLE_DATA, root)
    db_path = tmp_path / "s.db"
    conn = db.connect(db_path)
    importer.scan(conn, root)
    importer.run_queue(conn, root)
    # Tiles are computed during import already.
    assert importer.backfill_tiles(conn) == 0
    # Simulate an older database without tiles: backfill rebuilds them from streams.
    conn.execute("DELETE FROM activity_tiles")
    conn.execute("UPDATE activities SET tiles_version = 0")
    assert importer.backfill_tiles(conn) > 0
    conn.close()

    client = TestClient(create_app(db_path))
    tracks = client.get("/api/heatmap/tracks").json()
    assert tracks["items"] and all(t["polyline"] for t in tracks["items"])
    tiles = client.get("/api/heatmap/tiles").json()
    assert tiles["count"] > 0 and tiles["pending_activities"] == 0
    assert tiles["max_square"]["size"] >= 1
    only_runs = client.get("/api/heatmap/tracks?type=g:run").json()["items"]
    assert all(t["category"] == "run" for t in only_runs)
    assert client.get("/api/heatmap/tracks?year=1999").json()["items"] == []
