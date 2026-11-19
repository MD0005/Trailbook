"""Segment matching on synthetic tracks, creation, snapping and the segments API."""

from __future__ import annotations

import math

import pytest
from starlette.testclient import TestClient

from trailbook import db, segments, streams
from trailbook.api import create_app

LAT0, LON0 = 50.0, 20.0
M_LAT = 1 / 111_195.0  # degrees per metre north
M_LON = M_LAT / math.cos(math.radians(LAT0))  # degrees per metre east


def pt(north_m: float, east_m: float = 0.0) -> tuple[float, float]:
    return LAT0 + north_m * M_LAT, LON0 + east_m * M_LON


def path(*legs, speed=5.0, dt=1.0, wait_s=0):
    """Track along straight legs between (north, east) metre points at `speed` m/s.
    Returns (time, lat, lon). `wait_s` = standing at the first point first."""
    time, lat, lon = [], [], []
    t = 0.0
    for _ in range(int(wait_s / dt)):
        la, lo = pt(*legs[0])
        time.append(t), lat.append(la), lon.append(lo)
        t += dt
    for (n0, e0), (n1, e1) in zip(legs, legs[1:], strict=False):
        d = math.hypot(n1 - n0, e1 - e0)
        steps = max(1, int(d / (speed * dt)))
        for k in range(steps):
            f = k / steps
            la, lo = pt(n0 + f * (n1 - n0), e0 + f * (e1 - e0))
            time.append(t), lat.append(la), lon.append(lo)
            t += dt
    la, lo = pt(*legs[-1])
    time.append(t), lat.append(la), lon.append(lo)
    return time, lat, lon


SEGMENT = [pt(n) for n in range(200, 1201, 50)]  # 1 km due north, from 200 m to 1200 m


def efforts(time, lat, lon, seg_points=SEGMENT):
    seg = segments.prepare(1, seg_points)
    return segments.find_efforts(segments.Track(time, lat, lon, seg.proj), seg)


def test_checkpoints_are_evenly_spaced():
    proj = segments.Projection(*SEGMENT[0])
    cps = segments.checkpoints([proj.xy(*p) for p in SEGMENT])
    assert len(cps) == 41  # 1000 m / 25 m + start
    gaps = [math.dist(cps[i], cps[i + 1]) for i in range(len(cps) - 1)]
    assert max(gaps) == pytest.approx(25, abs=0.01) and min(gaps) > 20


def test_straight_pass_is_one_effort_with_interpolated_time():
    m = efforts(*path((0, 0), (1500, 0), speed=5))
    assert len(m) == 1
    assert m[0].end_t - m[0].start_t == pytest.approx(200, abs=1)  # 1000 m at 5 m/s
    assert m[0].start_t == pytest.approx(40, abs=1)


def test_opposite_direction_does_not_count():
    assert efforts(*path((1500, 0), (0, 0))) == []


def test_out_and_back_counts_once_and_laps_count_twice():
    assert len(efforts(*path((1500, 0), (0, 0), (1500, 0)))) == 1
    laps = efforts(*path((0, 0), (1500, 0), (1500, 50), (0, 50), (0, 0), (1500, 0)))
    assert len(laps) == 2


def test_detour_and_parallel_road_fail():
    detour = path((0, 0), (600, 0), (600, 400), (650, 400), (650, 0), (1500, 0))
    assert efforts(*detour) == []
    assert efforts(*path((0, 100), (1500, 100))) == []  # 100 m to the east
    assert len(efforts(*path((0, 15), (1500, 15)))) == 1  # GPS 15 m off is fine


def test_waiting_before_the_start_is_not_counted():
    m = efforts(*path((150, 0), (1500, 0), wait_s=120, speed=5))
    assert len(m) == 1
    assert m[0].end_t - m[0].start_t == pytest.approx(200, abs=1)


def test_sparse_gps_and_partial_coverage():
    assert len(efforts(*path((0, 0), (1500, 0), speed=6, dt=5))) == 1  # 30 m between points
    assert efforts(*path((0, 0), (900, 0))) == []  # stops before the end
    assert efforts(*path((500, 0), (1500, 0))) == []  # starts in the middle


def test_loop_segment_start_equals_end():
    loop = [pt(0, 0), pt(300, 0), pt(300, 300), pt(0, 300), pt(0, 5)]
    m = efforts(*path((-100, 0), (300, 0), (300, 300), (0, 300), (0, 0), (-100, 0)), loop)
    assert len(m) == 1


# ---- database, creation, snapping, API -----------------------------------------------------


def _store(c, pid, day, track, category="ride", hr=140.0, grade=0.05):
    """An activity with streams; altitude rises `grade` metres per metre north."""
    time, lat, lon = track
    cur = c.execute(
        """INSERT INTO activities (person_id, fit_uid, start_time_utc, utc_offset_s, category,
               activity_type, time_s, has_gps, bbox_min_lat, bbox_min_lon, bbox_max_lat,
               bbox_max_lon, importer_version)
           VALUES (?, ?, ?, 3600, ?, ?, ?, 1, ?, ?, ?, ?, 1)""",
        (pid, f"{pid}-{day}", f"{day}T08:00:00Z", category,
         "road_ride" if category == "ride" else "run", time[-1],
         min(lat), min(lon), max(lat), max(lon)),
    )  # fmt: skip
    aid = cur.lastrowid
    alt = [200 + (la - LAT0) / M_LAT * grade for la in lat]
    speed = [5.0] * len(time)
    for name, values, kind in (
        ("time", time, "f64"), ("lat", lat, "f64"), ("lon", lon, "f64"),
        ("hr", [hr] * len(time), "f32"), ("altitude", alt, "f32"), ("speed", speed, "f32"),
    ):  # fmt: skip
        enc, blob = streams.encode(values, kind)
        c.execute(
            "INSERT INTO streams (activity_id, channel, encoding, length, data) VALUES (?,?,?,?,?)",
            (aid, name, enc, len(values), blob),
        )
    return aid


@pytest.fixture
def sdb(tmp_path):
    path_ = tmp_path / "t.db"
    c = db.connect(path_)
    c.execute("INSERT INTO persons (id, label) VALUES ('anna', 'Anna'), ('ben', 'Ben')")
    a1 = _store(c, "anna", "2026-10-01", path((0, 0), (1500, 0), speed=5))
    _store(c, "anna", "2026-10-08", path((0, 0), (1500, 0), speed=8), hr=160)
    _store(c, "ben", "2026-10-09", path((0, 0), (1500, 0), speed=4))
    _store(c, "ben", "2026-10-10", path((1500, 0), (0, 0)))  # wrong way
    _store(c, "anna", "2026-10-11", path((0, 0), (1500, 0)), category="run")  # other group
    yield path_, c, a1
    c.close()


def test_create_match_and_reimport(sdb):
    _, c, a1 = sdb
    sid = segments.create_from_activity(c, a1, 40, 240, "North straight")
    s = c.execute("SELECT * FROM segments WHERE id = ?", (sid,)).fetchone()
    assert s["distance_m"] == pytest.approx(1000, abs=10)
    assert s["category"] == "ride" and s["ascent_m"] > 0
    assert segments.pending(c) == 6  # the segment + 5 activities
    segments.backfill(c)
    assert segments.pending(c) == 0
    rows = c.execute(
        """SELECT a.person_id, e.elapsed_s, e.avg_hr FROM segment_efforts e
           JOIN activities a ON a.id = e.activity_id ORDER BY e.elapsed_s"""
    ).fetchall()
    assert [r["person_id"] for r in rows] == ["anna", "anna", "ben"]
    assert rows[0]["elapsed_s"] == pytest.approx(1000 / 8, abs=2)
    assert rows[0]["avg_hr"] == 160
    # a new activity is matched against the existing segment
    _store(c, "ben", "2026-11-01", path((0, 0), (1500, 0), speed=10))
    assert segments.backfill(c) == 1
    assert c.execute("SELECT COUNT(*) FROM segment_efforts").fetchone()[0] == 4
    # any type: the run counts too
    c.execute("UPDATE segments SET category = NULL")
    segments.reset_segment(c, sid)
    segments.backfill(c)
    assert c.execute("SELECT COUNT(*) FROM segment_efforts").fetchone()[0] == 5


def test_flat_segment_counts_both_ways(tmp_path):
    c = db.connect(tmp_path / "t.db")
    c.execute("INSERT INTO persons (id, label) VALUES ('anna', 'Anna')")
    flat = _store(c, "anna", "2026-10-01", path((0, 0), (1500, 0)), grade=0.01)  # +10 m / km
    _store(c, "anna", "2026-10-02", path((1500, 0), (0, 0)), grade=0.01)  # the other way
    steep = _store(c, "anna", "2026-10-03", path((0, 0), (1500, 0), (1500, 50)), grade=0.05)
    _store(c, "anna", "2026-10-04", path((1500, 50), (0, 50)), grade=0.05)
    sid = segments.create_from_activity(c, flat, 40, 240, "Flat")
    s = c.execute("SELECT * FROM segments WHERE id = ?", (sid,)).fetchone()
    assert s["net_climb_m"] == pytest.approx(10, abs=1) and segments.two_way(s)
    segments.backfill(c)
    rows = c.execute(
        "SELECT reverse, max_speed FROM segment_efforts WHERE segment_id = ? ORDER BY reverse",
        (sid,),
    ).fetchall()
    # north: the flat ride and the steep-day ride; south: the flat return (the other
    # southbound ride runs 50 m to the east, off the segment)
    assert [r["reverse"] for r in rows] == [0, 0, 1]
    assert rows[0]["max_speed"] == 5.0
    # 50 m up over 1 km: one way only
    sid2 = segments.create_from_activity(c, steep, 40, 240, "Climb")
    s2 = c.execute("SELECT * FROM segments WHERE id = ?", (sid2,)).fetchone()
    assert not segments.two_way(s2)
    segments.backfill(c)
    n = c.execute("SELECT COUNT(*) FROM segment_efforts WHERE segment_id = ?", (sid2,))
    assert n.fetchone()[0] == 2  # the two northbound rides
    # an older segment without the value gets it from its source activity
    c.execute("UPDATE segments SET net_climb_m = NULL, match_version = 0 WHERE id = ?", (sid,))
    segments.backfill(c)
    again = c.execute("SELECT net_climb_m FROM segments WHERE id = ?", (sid,)).fetchone()[0]
    assert again == pytest.approx(10, abs=1)
    c.close()


def test_create_rejects_short_or_empty_slices(sdb):
    _, c, a1 = sdb
    with pytest.raises(segments.SegmentError):
        segments.create_from_activity(c, a1, 40, 50, "too short")
    with pytest.raises(segments.SegmentError):
        segments.create_from_activity(c, a1, 5000, 6000, "no points")


def test_snap_pins_to_own_tracks(sdb):
    _, c, _ = sdb
    pins = [pt(300, 20), pt(800, -15), pt(1300, 10)]
    r = segments.snap(c, pins, "ride")
    assert r is not None
    assert r["distance_m"] == pytest.approx(1000, abs=30)
    # the reversed order only matches the wrong-way ride
    back = segments.snap(c, list(reversed(pins)), "ride")
    assert back["start_time_utc"].startswith("2026-10-10")
    assert segments.snap(c, [pt(300, 400), pt(800, 400)], None) is None


def test_segments_api(sdb, monkeypatch):
    db_path, c, a1 = sdb
    app = create_app(db_path)
    job = app.state.import_job
    monkeypatch.setattr(job, "start_segments", lambda: True)  # matched inline below
    client = TestClient(app)
    r = client.post("/api/segments", json={"activity_id": a1, "start_s": 40, "end_s": 240,
                                           "name": "North"})  # fmt: skip
    assert r.status_code == 201 and r.json()["pending"]
    sid = r.json()["id"]
    assert client.post("/api/segments", json={"activity_id": a1, "start_s": 1, "end_s": 2}
                       ).status_code == 400  # fmt: skip
    segments.backfill(c)

    items = client.get("/api/segments?person=anna").json()["items"]
    assert items[0]["efforts"] == 2 and items[0]["best"]["elapsed_s"] == pytest.approx(125, abs=2)
    assert items[0]["last"]["start_time_utc"].startswith("2026-10-08")
    everyone = client.get("/api/segments").json()["items"][0]
    assert everyone["efforts"] == 3 and everyone["people"] == 2

    d = client.get(f"/api/segments/{sid}").json()
    assert d["summary"]["count"] == 3 and len(d["top"]) == 3
    assert [p["person_id"] for p in d["people"]] == ["anna", "ben"]
    assert [e["elapsed_s"] for e in d["series"]] and sum(d["type_counts"].values()) == len(
        d["series"]
    )
    eff = client.get(f"/api/segments/{sid}/efforts?person=ben").json()
    assert eff["total"] == 1 and eff["items"][0]["rank"] == 1
    by_date = client.get(f"/api/segments/{sid}/efforts?sort=date").json()["items"]
    assert by_date[0]["start_time_utc"] > by_date[-1]["start_time_utc"]

    snap = client.post("/api/segments/snap", json={"pins": [pt(300), pt(1300)]})
    assert snap.status_code == 200 and snap.json()["distance_m"] > 900
    far = client.post("/api/segments/snap", json={"pins": [pt(300, 500), pt(1300, 500)]})
    assert far.status_code == 404

    off = client.patch(f"/api/segments/{sid}", json={"two_way_mode": "off"}).json()
    assert off["two_way_mode"] == "off" and not off["two_way"] and off["pending"]
    bad = client.patch(f"/api/segments/{sid}", json={"two_way_mode": "sometimes"})
    assert bad.status_code == 400
    renamed = client.patch(f"/api/segments/{sid}", json={"name": "Renamed"}).json()
    assert renamed["name"] == "Renamed"
    assert client.patch(f"/api/segments/{sid}", json={"any_type": True}).json()["pending"]
    assert client.delete(f"/api/segments/{sid}").status_code == 204
    assert c.execute("SELECT COUNT(*) FROM segment_efforts").fetchone()[0] == 0
    assert client.get(f"/api/segments/{sid}").status_code == 404


def test_two_way_mode_overrides_automatic(tmp_path):
    c = db.connect(tmp_path / "t.db")
    c.execute("INSERT INTO persons (id, label) VALUES ('anna', 'Anna')")
    flat = _store(c, "anna", "2026-10-01", path((0, 0), (1500, 0)), grade=0.01)
    _store(c, "anna", "2026-10-02", path((1500, 0), (0, 0)), grade=0.01)
    sid = segments.create_from_activity(c, flat, 40, 240, "Flat")
    segments.backfill(c)

    def reverse_count():
        q = "SELECT COUNT(*) FROM segment_efforts WHERE segment_id = ? AND reverse = 1"
        return c.execute(q, (sid,)).fetchone()[0]

    assert reverse_count() == 1  # automatic: flat, so both ways
    c.execute("UPDATE segments SET two_way_mode = 'off' WHERE id = ?", (sid,))
    segments.reset_segment(c, sid)
    segments.backfill(c)
    assert reverse_count() == 0
    c.execute("UPDATE segments SET two_way_mode = 'on', net_climb_m = 80 WHERE id = ?", (sid,))
    segments.reset_segment(c, sid)
    segments.backfill(c)
    assert reverse_count() == 1  # on: both ways even when steep
    c.close()
