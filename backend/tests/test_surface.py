"""Road surface: classification of OSM ways and matching the route to them (no network)."""

from trailbook import surface


def test_classify_surface_tags_and_road_types():
    assert surface.classify({"highway": "residential"}) == "paved"
    assert surface.classify({"highway": "track", "surface": "gravel"}) == "gravel"
    assert surface.classify({"highway": "track", "tracktype": "grade4"}) == "dirt"
    assert surface.classify({"highway": "path", "surface": "ground"}) == "dirt"
    assert surface.classify({"highway": "path"}) == "unknown"
    assert surface.classify({"highway": "track"}) == "gravel"


def test_route_points_take_the_nearest_way():
    # a road along latitude 50.0 from lon 19.000 to 19.010 (paved), then a gravel track on
    paved = {
        "tags": {"highway": "tertiary"},
        "geometry": [{"lat": 50.0, "lon": 19.0}, {"lat": 50.0, "lon": 19.01}],
    }
    gravel = {"tags": {"highway": "track", "surface": "gravel"},
              "geometry": [{"lat": 50.0, "lon": 19.01}, {"lat": 50.0, "lon": 19.02}]}  # fmt: skip
    pts = [(50.00005, 19.0 + i * 0.0005, i * 35.8) for i in range(41)]  # ~1,4 km, 5 m off the road
    runs = surface.match(pts, [paved, gravel])
    kinds = [r[2] for r in runs]
    assert kinds == ["paved", "gravel"]
    sh = surface.shares(runs)
    assert abs(sh["paved"] - sh["gravel"]) < 80
    # nothing near: unknown
    far = [(50.01, 19.0 + i * 0.0005, i * 35.8) for i in range(5)]
    assert {r[2] for r in surface.match(far, [paved])} == {"unknown"}


def test_short_switches_are_smoothed_away():
    runs = [[0, 500, "gravel"], [500, 540, "paved"], [540, 1200, "gravel"], [1200, 1800, "paved"]]
    assert surface.smooth(runs) == [[0, 1200, "gravel"], [1200, 1800, "paved"]]
    # a short run between two different kinds joins the longer neighbour
    runs = [[0, 300, "paved"], [300, 350, "unknown"], [350, 1000, "gravel"]]
    assert surface.smooth(runs) == [[0, 300, "paved"], [300, 1000, "gravel"]]


def test_virtual_activities_get_no_surface(conn):
    conn.execute("INSERT INTO persons (id, label) VALUES ('alice', 'Alice')")
    for aid, kind in ((1, "road_biking"), (2, "virtual_ride")):
        conn.execute(
            """INSERT INTO activities (id, person_id, fit_uid, start_time_utc, category,
                                       activity_type, has_gps, importer_version)
               VALUES (?, 'alice', ?, '2026-01-01T08:00:00Z', 'ride', ?, 1, 1)""",
            (aid, f"uid{aid}", kind),
        )
    conn.commit()
    assert surface.progress(conn) == {"total": 1, "done": 0}  # the virtual ride does not count
    assert surface.compute(conn, 2) is None  # an app's world: never sent to the map server


def test_refused_server_cools_down(monkeypatch):
    import pytest

    from trailbook import surface

    def reset():
        surface._cool.update(until=0.0, fails=0)
        surface._failed.clear()

    reset()
    assert surface.cooldown_left() == 0
    assert surface._refused(None, now=1000) == surface.COOLDOWN_S
    assert surface.cooldown_left(now=1000) == surface.COOLDOWN_S
    assert surface._refused(None, now=1000) == 2 * surface.COOLDOWN_S  # doubled
    surface._answered()  # one step back, not a reset: the next refusal waits 2x again
    assert surface.cooldown_left() == 0
    assert surface._refused(None, now=1000) == 2 * surface.COOLDOWN_S
    assert surface._refused(10**6, now=1000) == surface.COOLDOWN_MAX_S  # capped
    reset()
    assert surface._refused(5000, now=0) == 5000  # Retry-After wins when longer
    reset()

    calls = []

    def refuse(points, url, chunk):
        calls.append(chunk)
        raise surface.Refused("HTTP 502 Bad Gateway")

    monkeypatch.setattr(surface, "fetch_ways", refuse)
    monkeypatch.setattr(surface, "_route", lambda c, aid: [(50, 20, 0), (50.001, 20, 111)])

    class Conn:
        def execute(self, *a):
            class R:
                def fetchone(self):
                    return {"surface": None, "activity_type": "ride"}

            return R()

    monkeypatch.setattr(surface.db, "get_setting", lambda c, k: None)
    for _ in range(3):
        with pytest.raises(OSError):
            surface.compute(Conn(), 1)
    assert calls == [surface.CHUNK]  # asked once, then left alone
    # the failed activity waits (1 h) while others go on; its next try asks in half the size
    assert surface.waiting() == [1]
    surface._cool["until"] = 0.0
    with pytest.raises(OSError):
        surface.compute(Conn(), 1)
    assert calls == [surface.CHUNK, surface.CHUNK // 2]
    reset()
