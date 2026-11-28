"""Activity corrections (fixes.py), Export (export.py) and Exclude from statistics."""

import pytest
from starlette.testclient import TestClient

from trailbook import analysis, db, export, fitfile, fixes, streams
from trailbook.api import create_app

SPEED = 3.0  # m/s
LAT0, LON0 = 52.0, 21.0
DEG_LAT_M = 111_195.0  # metres per degree of latitude


def _run(c, jump_at=600, seconds=1800):
    """A 30 min run north at 3 m/s with one GPS jump (500 m out and back at `jump_at`) and an
    altitude spike of 60 m."""
    time = list(range(seconds + 1))
    lat = [LAT0 + t * SPEED / DEG_LAT_M for t in time]
    lon = [LON0] * len(time)
    dist = [t * SPEED for t in time]
    alt = [100.0 + t * 0.01 for t in time]
    lat[jump_at] += 500 / DEG_LAT_M
    for t in range(jump_at, len(time)):
        dist[t] += 500 if t == jump_at else 1000  # out and back: the watch counts both ways
    alt[900] += 60
    speed = [SPEED] * len(time)
    speed[jump_at] = 500.0
    cur = c.execute(
        """INSERT INTO activities (person_id, fit_uid, start_time_utc, utc_offset_s, sport,
                                   sub_sport, category, activity_type, time_s, timer_s,
                                   elapsed_s, distance_m, avg_speed, max_speed, ascent_m,
                                   descent_m, has_gps, importer_version)
           VALUES ('anna', 'u1', '2026-05-01T08:00:00Z', 7200, 'running', 'generic', 'run',
                   'run', ?, ?, ?, ?, ?, 500, 140, 70, 1, 1)""",
        (seconds, seconds, seconds, dist[-1], dist[-1] / seconds),
    )
    aid = cur.lastrowid
    for name, values, kind in [("time", time, "f64"), ("lat", lat, "f64"), ("lon", lon, "f64"),
                               ("distance", dist, "f32"), ("altitude", alt, "f32"),
                               ("speed", speed, "f32")]:  # fmt: skip
        enc, blob = streams.encode(values, kind)
        c.execute(
            "INSERT INTO streams (activity_id, channel, encoding, length, data) VALUES (?,?,?,?,?)",
            (aid, name, enc, len(values), blob),
        )
    c.execute("INSERT INTO tracks (activity_id, polyline, point_count) VALUES (?, '', 0)", (aid,))
    return aid


@pytest.fixture
def tdb(tmp_path):
    path = tmp_path / "t.db"
    c = db.connect(path)
    c.execute("INSERT INTO persons (id, label) VALUES ('anna', 'Anna')")
    aid = _run(c)
    analysis.analyse_one(c, aid)
    yield c, aid, path
    c.close()


def _pace(c, aid, metres):
    row = c.execute(
        "SELECT value FROM best_efforts WHERE activity_id = ? AND kind = 'pace' AND key = ?",
        (aid, metres),
    ).fetchone()
    return row[0] if row else None


def test_speed_fix_takes_out_the_gps_jump(tdb):
    c, aid, _ = tdb
    assert _pace(c, aid, 1000) < 100  # the jump: 1 km in no time
    fixes.apply(c, aid, ["speed"])
    analysis.analyse_one(c, aid)
    a = c.execute("SELECT * FROM activities WHERE id = ?", (aid,)).fetchone()
    assert a["distance_m"] == pytest.approx(1800 * SPEED, rel=0.01)
    assert a["max_speed"] < 5
    assert _pace(c, aid, 1000) == pytest.approx(1000 / SPEED, rel=0.02)
    lat = analysis._channels(c, aid)["lat"]
    assert abs(lat[600] - (LAT0 + 600 * SPEED / DEG_LAT_M)) < 2 / DEG_LAT_M  # back on the line
    assert fixes.fixes_of(a) == ["speed"]


def test_altitude_fix_takes_out_the_spike(tdb):
    c, aid, _ = tdb
    fixes.apply(c, aid, ["altitude"])
    a = c.execute("SELECT * FROM activities WHERE id = ?", (aid,)).fetchone()
    alt = analysis._channels(c, aid)["altitude"]
    assert max(alt) < 120
    assert a["ascent_m"] == pytest.approx(18, abs=3)  # 0,01 m/s for 30 min
    assert a["descent_m"] < 3


def test_written_fit_reads_back(tdb):
    c, aid, _ = tdb
    a = c.execute("SELECT * FROM activities WHERE id = ?", (aid,)).fetchone()
    p = fitfile.parse_activity(export.write_fit(c, a))
    assert p.activity_type == "run"
    assert len(p.streams["time"]) == 1801
    assert p.summary["distance_m"] == pytest.approx(a["distance_m"], abs=0.1)
    assert p.start_time.strftime("%Y-%m-%dT%H:%M:%SZ") == "2026-05-01T08:00:00Z"
    gpx = export.gpx_text(c, a, "Morning <run>")
    assert gpx.count("<trkpt") == 1801 and "Morning &lt;run&gt;" in gpx and "<time>" not in gpx


def test_api_export_fix_and_exclude(tdb):
    c, aid, path = tdb
    client = TestClient(create_app(path))
    r = client.get(f"/api/activities/{aid}/export?format=gpx")
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
    r = client.get(f"/api/activities/{aid}/export?format=fit")
    assert r.content[8:12] == b".FIT"
    assert client.patch(f"/api/activities/{aid}", json={"fix": "nope"}).status_code == 400
    a = client.patch(f"/api/activities/{aid}", json={"fix": "speed"}).json()
    assert a["fixes"] == '["speed"]' and a["max_speed"] < 5
    records = client.get("/api/stats/records?person=anna").json()
    assert any(e["kind"] == "pace" for e in records["run"])
    totals = client.get("/api/stats/totals?person=anna").json()
    assert totals["rows"][0]["count"] == 1
    a = client.patch(f"/api/activities/{aid}", json={"excluded": True}).json()
    assert a["excluded"] == 1
    records = client.get("/api/stats/records?person=anna").json()
    assert not records["run"]
    assert client.get("/api/stats/totals?person=anna").json()["rows"] == []
    assert client.get(f"/api/activities/{aid}").status_code == 200  # still in the list
    client.patch(f"/api/activities/{aid}", json={"excluded": False})
    assert client.get("/api/stats/records?person=anna").json()["run"]


def test_calibrated_treadmill_distance_scales_the_samples(tdb):
    from trailbook import importer

    c, aid, _ = tdb
    # a treadmill run: 5 km in the samples, 3 km after Calibrate and save on the watch
    ch = {"distance": [0.0, 2500.0, 5000.0], "speed": [2.0, 3.0, None], "lat": [None] * 3}
    assert fitfile.calibrate(ch, 3000.0)
    assert ch["distance"] == [0.0, 1500.0, 3000.0]
    assert ch["speed"][:2] == pytest.approx([1.2, 1.8]) and ch["speed"][2] is None
    assert not fitfile.calibrate({"distance": [0.0, 5000.0]}, 5050.0)  # within 2 %
    assert not fitfile.calibrate({"distance": [0.0, 5000.0], "lat": [52.0, 52.1]}, 3000.0)
    # stored before: scaled once from the streams, analysed again
    c.execute("UPDATE activities SET has_gps = 0, distance_m = 2700, analysis_version = 9 "
              "WHERE id = ?", (aid,))  # fmt: skip
    c.execute("DELETE FROM streams WHERE activity_id = ? AND channel = 'lat'", (aid,))
    assert importer.backfill_calibration(c) == 1
    dist = streams.decode(*c.execute(
        "SELECT encoding, data FROM streams WHERE activity_id = ? AND channel = 'distance'", (aid,)
    ).fetchone())  # fmt: skip
    assert abs(dist[-1] - 2700) < 1
    row = c.execute("SELECT analysis_version FROM activities WHERE id = ?", (aid,)).fetchone()
    assert row[0] == 0
    assert importer.backfill_calibration(c) == 0  # once
