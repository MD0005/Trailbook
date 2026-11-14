import math

from conftest import make_fit

from trailbook import db, fitfile, geo, sports, streams


def test_polyline_roundtrip():
    points = [(61.65157, 9.95814), (61.65160, 9.95900), (61.70001, 10.01834)]
    decoded = geo.decode_polyline(geo.encode_polyline(points))
    assert decoded == [(round(a, 5), round(b, 5)) for a, b in points]


def test_polyline_known_value():
    # Example from the Google polyline documentation.
    pts = [(38.5, -120.2), (40.7, -120.95), (43.252, -126.453)]
    assert geo.encode_polyline(pts) == "_p~iF~ps|U_ulLnnqC_mqNvxq`@"


def test_simplify_drops_collinear_points_and_keeps_corners():
    line = [(0.0, i * 0.0001) for i in range(100)] + [(i * 0.0001, 0.0099) for i in range(1, 100)]
    simplified = geo.simplify(line, tolerance_m=1.0)
    assert simplified[0] == line[0]
    assert simplified[-1] == line[-1]
    assert (0.0, 0.0099) in simplified
    assert len(simplified) == 3


def test_streams_roundtrip_with_missing_values():
    values = [1.5, None, 3.25, 180.0]
    encoding, blob = streams.encode(values)
    assert encoding == "zlib-f32le"
    assert streams.decode(encoding, blob) == values

    coords = [61.123456789, None]
    encoding, blob = streams.encode(coords, "f64")
    decoded = streams.decode(encoding, blob)
    assert math.isclose(decoded[0], coords[0], abs_tol=1e-12)
    assert decoded[1] is None


def test_peek_file_type():
    assert fitfile.peek_file_type(make_fit(4)) == fitfile.FILE_TYPE_ACTIVITY
    assert fitfile.peek_file_type(make_fit(49)) == 49
    assert fitfile.file_type_name(49) == "sleep"
    assert fitfile.peek_file_type(b"not a fit file at all") is None


def test_categorize():
    assert sports.categorize("running", "treadmill") == ("run", True)
    assert sports.categorize("running", "generic") == ("run", False)
    assert sports.categorize("cycling", "virtual_activity") == ("ride", True)
    assert sports.categorize("training", "strength_training") == ("strength", False)
    assert sports.categorize("training", "yoga") == ("other", False)
    assert sports.categorize(None, None) == ("other", False)


def test_migrations_are_idempotent(tmp_path):
    path = tmp_path / "x.db"
    db.connect(path).close()
    conn = db.connect(path)
    assert db.schema_version(conn) == db.SCHEMA_VERSION
    conn.close()
