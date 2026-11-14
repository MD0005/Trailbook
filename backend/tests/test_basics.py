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
    assert fitfile.peek_file_type(make_fit(4)[:15]) is None  # truncated


def test_peek_file_id_fields():
    fid = fitfile.peek_file_id(make_fit(49, serial=123456, created=1_100_000_000))
    assert fid.type == 49
    assert fid.serial_number == 123456
    assert fid.time_created.isoformat() == "2024-11-08T11:33:20+00:00"
    assert fid.fit_uid == f"sn123456:{1_100_000_000 + fitfile.FIT_EPOCH_S}"
    assert fitfile.peek_file_id(make_fit(49)).fit_uid is None


def test_product_name():
    assert fitfile.product_name(4261) == "venu3s"
    assert fitfile.product_name("4261") == "venu3s"  # as stored in SQLite TEXT column
    assert fitfile.product_name(None) is None


def test_classify():
    assert sports.classify("running", "treadmill") == ("run", "treadmill_run", True)
    assert sports.classify("running", "generic") == ("run", "run", False)
    assert sports.classify("running", "trail") == ("run", "trail_run", False)
    assert sports.classify("cycling", "virtual_activity") == ("ride", "virtual_ride", True)
    assert sports.classify("cycling", "gravel_cycling") == ("ride", "gravel_ride", False)
    assert sports.classify("training", "strength_training") == ("fitness", "strength", False)
    assert sports.classify("training", "yoga") == ("mind_body", "yoga", False)
    assert sports.classify("fitness_equipment", "yoga") == ("mind_body", "yoga", False)
    assert sports.classify("racket", "padel") == ("racket", "padel", False)
    assert sports.classify("swimming", "lap_swimming") == ("swim", "pool_swim", True)
    assert sports.classify("walking", "generic") == ("walk", "walk", False)
    assert sports.classify("some_new_sport", None) == ("other", "other", False)
    assert sports.classify(None, None) == ("other", "other", False)


def test_every_fit_sport_has_a_type():
    from garmin_fit_sdk import Profile

    unmapped = [
        s
        for s in Profile["types"]["sport"].values()
        # Deliberately left as "other": too vague to be a useful type of their own.
        if s not in ("all", "generic", "tactical", "para_sport")
        and sports.resolve_type(s, None).key == "other"
    ]
    assert unmapped == [], unmapped


def test_types_reference_known_groups():
    for t in sports.TYPES.values():
        assert t.group in sports.GROUPS, t
        assert t.en and t.pl


def test_migrations_are_idempotent(tmp_path):
    path = tmp_path / "x.db"
    db.connect(path).close()
    conn = db.connect(path)
    assert db.schema_version(conn) == db.SCHEMA_VERSION
    conn.close()
