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
