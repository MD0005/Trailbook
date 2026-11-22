"""Training load, best efforts, fitness model and the training API."""

from __future__ import annotations

import math

import pytest

from trailbook import analysis, db, streams


def test_resample_fills_short_gaps_only():
    out = analysis.resample_1hz([0, 2, 20], [100, 110, 120], max_gap=5)
    assert out[0] == 100 and out[1] == 100 and out[2] == 110
    assert out[3] is None and out[19] is None and out[20] == 120


def test_best_mean_skips_windows_with_gaps():
    series = [100.0] * 10 + [None] + [300.0] * 5
    assert analysis.best_mean(series, 5) == 300.0
    assert analysis.best_mean(series, 6) == 100.0
    assert analysis.best_mean(series, 20) is None


def test_best_time_for_distance_interpolates():
    time = list(range(0, 1001))
    distance = [t * 4.0 for t in time]  # 4 m/s
    assert analysis.best_time_for_distance(time, distance, 1000) == pytest.approx(250, abs=0.01)
    assert analysis.best_time_for_distance(time, distance, 5000) is None


def test_normalized_power_of_steady_effort_is_the_power():
    assert analysis.normalized_power([200.0] * 600) == pytest.approx(200)


def test_hr_tss_is_100_for_one_hour_at_threshold():
    th = analysis.Thresholds(hr_max=190, hr_rest=50, lthr=170)
    assert analysis.hr_tss([170.0] * 3600, th) == pytest.approx(100, abs=0.5)
    assert analysis.hr_tss([170.0] * 1800, th) == pytest.approx(50, abs=0.5)
    assert analysis.hr_tss([120.0] * 3600, th) < 50


def test_thresholds_history_and_estimates():
    rows = [
        {"valid_from": "2025-01-01", "hr_max": 190, "hr_rest": None, "lthr": None, "ftp": 250,
         "threshold_pace": None, "swim_css": None, "weight": None},
        {"valid_from": "2026-01-01", "hr_max": None, "hr_rest": 45, "lthr": 172, "ftp": None,
         "threshold_pace": 270, "swim_css": None, "weight": None},
    ]  # fmt: skip
    early = analysis.thresholds_for(rows, "2024-06-01", auto_max=180)
    assert early.hr_max == 180 and early.sources["hr_max"] == "auto"
    assert early.hr_rest == 60 and early.lthr == 162 and early.ftp is None
    mid = analysis.thresholds_for(rows, "2025-06-01", auto_max=180)
    assert (mid.hr_max, mid.ftp, mid.lthr) == (190, 250, 171)
    late = analysis.thresholds_for(rows, "2026-03-01", auto_max=180)
    assert (late.hr_max, late.hr_rest, late.lthr, late.ftp, late.threshold_pace) == (
        190, 45, 172, 250, 270,
    )  # fmt: skip


def test_fitness_series_constant_load_converges():
    loads = {f"2026-01-{d:02d}": 50.0 for d in range(1, 32)}
    s = analysis.fitness_series(loads, until=analysis.date(2026, 1, 31))
    assert len(s) == 31
    k = 1 - math.exp(-1 / 7)
    assert s[0]["atl"] == pytest.approx(50 * k, abs=0.1)
    assert s[-1]["atl"] > s[-1]["ctl"] > 0
    assert s[0]["tsb"] == 0  # form is from yesterday's values


# ---- with a database ---------------------------------------------------------------------


def _activity(c, pid, day, group="run", atype="run", hr=150.0, seconds=3600, speed=3.0, power=None):
    cur = c.execute(
        """INSERT INTO activities (person_id, fit_uid, start_time_utc, utc_offset_s, category,
                                   activity_type, time_s, timer_s, distance_m, avg_speed,
                                   avg_hr, max_hr, importer_version)
           VALUES (?, ?, ?, 3600, ?, ?, ?, ?, ?, ?, ?, ?, 1)""",
        (
            pid, f"{pid}-{day}-{atype}", f"{day}T08:00:00Z", group, atype, seconds, seconds,
            seconds * speed, speed, hr, hr + 20,
        ),
    )  # fmt: skip
    aid = cur.lastrowid
    time = list(range(0, seconds + 1))
    channels = {
        "time": (time, "f64"),
        "hr": ([hr] * len(time), "f32"),
        "distance": ([t * speed for t in time], "f32"),
    }
    if power:
        channels["power"] = ([power] * len(time), "f32")
    for name, (values, kind) in channels.items():
        enc, blob = streams.encode(values, kind)
        c.execute(
            "INSERT INTO streams (activity_id, channel, encoding, length, data) VALUES (?,?,?,?,?)",
            (aid, name, enc, len(values), blob),
        )
    return aid


@pytest.fixture
def tdb(tmp_path):
    path = tmp_path / "t.db"
    c = db.connect(path)
    c.execute("INSERT INTO persons (id, label) VALUES ('anna', 'Anna')")
    _activity(c, "anna", "2026-01-05")
    _activity(c, "anna", "2026-01-06", speed=3.5)
    _activity(c, "anna", "2026-02-01", group="ride", atype="road_ride", speed=8, power=200)
    yield path, c
    c.close()


def test_backfill_computes_load_and_efforts(tdb):
    _, c = tdb
    assert analysis.backfill(c) == 3
    rows = c.execute("SELECT activity_type, load, load_method FROM activities").fetchall()
    assert all(r["load_method"] == "hr" and r["load"] > 0 for r in rows)
    kinds = {r[0] for r in c.execute("SELECT DISTINCT kind FROM best_efforts")}
    assert kinds == {"hr", "pace", "power", "ride", "speed", "within"}
    # every effort knows where it happened
    assert c.execute("SELECT COUNT(*) FROM best_efforts WHERE end_s <= start_s").fetchone()[0] == 0
    five_k = c.execute(
        "SELECT MIN(value) FROM best_efforts WHERE kind = 'pace' AND key = 5000"
    ).fetchone()[0]
    assert five_k == pytest.approx(5000 / 3.5, abs=1)
    # nothing left to do; thresholds change → everything again, now with FTP for the ride
    assert analysis.backfill(c) == 0
    c.execute(
        "INSERT INTO person_thresholds (person_id, valid_from, ftp)"
        " VALUES ('anna', '2026-01-01', 250)"
    )
    assert analysis.reset_person(c, "anna") == 3
    analysis.backfill(c)
    ride = c.execute("SELECT load, load_method FROM activities WHERE category = 'ride'").fetchone()
    assert ride["load_method"] == "power"
    assert ride["load"] == pytest.approx(100 * (200 / 250) ** 2, abs=0.5)


def test_training_api(tdb):
    from starlette.testclient import TestClient

    from trailbook import api

    path, c = tdb
    analysis.backfill(c)
    with TestClient(api.create_app(path)) as client:
        f = client.get("/api/fitness?person=anna").json()
        assert f["series"][0]["date"] == "2026-01-05" and f["methods"]["hr"] == 3
        assert f["thresholds"]["hr_max"] == 170 and f["thresholds"]["sources"]["hr_max"] == "auto"
        assert client.get("/api/fitness?person=nobody").status_code == 400

        cal = client.get("/api/calendar?from=2026-01-01&to=2026-01-31&person=anna").json()
        assert [a["day"] for a in cal["activities"]] == ["2026-01-05", "2026-01-06"]

        tot = client.get("/api/stats/totals?person=anna&by=month").json()
        assert [(r["period"], r["count"]) for r in tot["rows"]] == [("2026-01", 2), ("2026-02", 1)]
        runs = client.get("/api/stats/totals?person=anna&type=g:run").json()
        assert sum(r["count"] for r in runs["rows"]) == 2

        rec = client.get("/api/stats/records?person=anna").json()
        assert rec["filtered"] is False
        best5k = next(r for r in rec["run"] if r["kind"] == "pace" and r["key"] == 5000)
        assert best5k["ever"][0]["value"] == pytest.approx(5000 / 3.5, abs=1)
        assert best5k["range"] is None
        assert {r["kind"] for r in rec["ride"]} >= {"ride", "power"}
        rec = client.get("/api/stats/records?person=anna&years=2025").json()
        assert rec["filtered"] is True and all(r["range"] is None for r in rec["run"])
        assert client.get("/api/stats/records?person=nobody").status_code == 400

        assert client.put("/api/thresholds/anna", json={"hr_max": 400}).status_code == 400
        r = client.put(
            "/api/thresholds/anna", json={"valid_from": "2026-01-01", "lthr": 160, "ftp": 250}
        ).json()
        assert r["rows"][0]["lthr"] == 160 and r["effective"]["sources"]["lthr"] == "set"
        assert r["pending"] == 3  # recomputed by the background job
        r = client.delete("/api/thresholds/anna/2026-01-01").json()
        assert r["rows"] == []

        detail = client.get("/api/activities/1").json()
        assert detail["best_efforts"] and "load" in detail
        assert all("record" in e and "start_s" in e for e in detail["best_efforts"])
        recs = client.get("/api/activities/1/records?range=all").json()["records"]
        assert any(r["kind"] == "pace" and r["key"] == 5000 for r in recs)
        assert client.get("/api/activities/1/records?range=30d").status_code == 200
        assert client.get("/api/activities/1/records?range=bad").status_code == 400


# ---- thresholds: set in Settings > watch > estimate ------------------------------------------


def test_thresholds_priority_set_watch_estimate():
    rows = [{"valid_from": "2026-01-01", **dict.fromkeys(analysis.THRESHOLD_FIELDS), "ftp": 250}]
    watch = {"hr_max": 190, "hr_rest": 47, "ftp": 200, "lthr": None}
    th = analysis.thresholds_for(rows, "2026-02-01", auto_max=200, watch=watch)
    assert (th.ftp, th.sources["ftp"]) == (250, "set")  # own value replaces the watch
    assert (th.hr_max, th.sources["hr_max"]) == (190, "watch")  # watch beats the estimate
    assert (th.hr_rest, th.sources["hr_rest"]) == (47, "watch")
    assert th.sources["lthr"] == "auto"  # not on the watch: estimated from HR max
    assert th.lthr == round(190 * analysis.LTHR_SHARE_OF_MAX)


def test_watch_on_takes_latest_value_before_the_day():
    history = [
        ("2026-01-10", {"hr_max": 185, "ftp": None}),
        ("2026-03-01", {"hr_max": 190, "ftp": 210}),
    ]
    assert analysis.watch_on(history, "2026-02-01") == ({"hr_max": 185, "ftp": 210}, "2026-01-10")
    assert analysis.watch_on(history, "2026-04-01")[0] == {"hr_max": 190, "ftp": 210}
    assert analysis.watch_on(history, "2025-12-01") == ({"hr_max": 185, "ftp": 210}, None)


def test_threshold_warnings_missing_accepted_and_stale(tdb):
    from starlette.testclient import TestClient

    from trailbook import api

    path, c = tdb
    analysis.backfill(c)
    # No watch values: HR max from recorded HR and resting HR default are warnings.
    w = analysis.threshold_warnings(c, "anna")
    assert {x["field"] for x in w if x["kind"] == "missing"} == {"hr_max", "hr_rest"}
    assert analysis.threshold_warnings(c, "anna", accepted={"hr_max", "hr_rest"}) == []
    # Watch values only from two years later: the 2026 activities borrow them.
    c.execute(
        "UPDATE activities SET watch_hr_max = 190, watch_hr_rest = 48"
        " WHERE start_time_utc > '2026-02'"
    )
    c.execute("UPDATE activities SET start_time_utc = '2028-02-01T08:00:00Z' WHERE watch_hr_max")
    w = analysis.threshold_warnings(c, "anna")
    assert w == [{"kind": "stale", "year": "2026", "from": "2028-02-01"}]

    with TestClient(api.create_app(path)) as client:
        assert client.put("/api/thresholds/anna/accept", json={"field": "ftp"}).status_code == 400
        r = client.put("/api/thresholds/anna/accept", json={"field": "hr_rest"}).json()
        assert r["accepted"] == ["hr_rest"]
        f = client.get("/api/fitness?person=anna&to=2026-12-31").json()
        assert [x["kind"] for x in f["warnings"]] == ["stale"]
        r = client.put(
            "/api/thresholds/anna/accept", json={"field": "hr_rest", "accepted": False}
        ).json()
        assert r["accepted"] == []


def test_ftp_is_taken_from_the_same_sport_and_can_be_corrected(tdb):
    _, c = tdb
    run = _activity(c, "anna", "2026-03-01", power=390)
    ride = _activity(c, "anna", "2026-03-02", group="ride", atype="virtual_ride", speed=8,
                     power=200)  # fmt: skip
    c.execute("UPDATE activities SET watch_ftp = 430 WHERE id = ?", (run,))  # running power FTP
    c.execute("UPDATE activities SET watch_ftp = 260 WHERE id = (SELECT MIN(id) FROM activities"
              " WHERE category = 'ride')")  # fmt: skip

    def ftp(aid):
        a = c.execute("SELECT * FROM activities WHERE id = ?", (aid,)).fetchone()
        return analysis.activity_thresholds(c, a).ftp

    # the ride has no FTP in its file: the nearest ride FTP, not the run's (one day away)
    assert ftp(ride) == 260
    assert ftp(run) == 430
    c.execute("UPDATE activities SET ftp_override = 240 WHERE id = ?", (ride,))
    assert ftp(ride) == 240
    a = c.execute("SELECT * FROM activities WHERE id = ?", (ride,)).fetchone()
    assert analysis.activity_thresholds(c, a).sources["ftp"] == "activity"


def test_time_in_hr_zones_from_the_stream():
    from trailbook.analysis import time_in_hr_zones

    bounds = [100, 120, 140, 160, 180, 200]  # below z1 | z1 … z5
    time = [0, 1, 2, 3, 4, 64, 65]  # a 60 s pause after the 5th sample counts 1 s
    hr = [90, 110, 130, 150, 210, 170, None]
    assert time_in_hr_zones(time, hr, bounds) == [1, 1, 1, 1, 1, 1]


def _ride(seconds: int, speed_at):
    """time, distance, lat, lon, device speed of a ride north at speed_at(t) m/s."""
    t = list(range(seconds))
    d, lat, lon, sp = [], [], [], []
    run = 0.0
    for s in t:
        v = speed_at(s)
        run += v if s else 0.0
        d.append(run)
        lat.append(50.0 + run / 111195.0)
        lon.append(20.0)
        sp.append(v)
    return t, d, lat, lon, sp


def test_top_speed_clean_ride():
    t, d, lat, lon, sp = _ride(600, lambda s: 12.0 if 200 <= s < 300 else 8.0)
    v, start = analysis.top_speed_at(t, d, 60, lat, lon, sp)
    assert v == pytest.approx(12.0, abs=0.05) and 200 <= start <= 240


def test_top_speed_ignores_gps_jumps():
    t, d, lat, lon, sp = _ride(600, lambda s: 8.0)
    # a jump of the position: 150 m in one second, then back on track
    for k in range(300, 600):
        d[k] += 150
        lat[k] += 150 / 111195.0
    v, _ = analysis.top_speed_at(t, d, 60, lat, lon, sp)
    assert v == pytest.approx(8.0, abs=0.05)
    # a slow drift: the distance says 11 m/s, the device's own speed 8 m/s
    t, d, lat, lon, sp = _ride(300, lambda s: 11.0)
    sp = [8.0] * len(sp)
    assert analysis.top_speed_at(t, d, 60, lat, lon, sp) is None
    # the distance runs on, the track does not (positions frozen)
    t, d, lat, lon, sp = _ride(300, lambda s: 10.0)
    lat = [50.0] * len(lat)
    assert analysis.top_speed_at(t, d, 60, lat, lon, None) is None


def test_virtual_rides_have_own_records(tdb):
    from starlette.testclient import TestClient

    from trailbook import api

    path, c = tdb
    analysis.backfill(c)
    ride = c.execute("SELECT * FROM activities WHERE category = 'ride'").fetchone()
    cols = [k for k in ride.keys() if k not in ("id", "fit_uid")]
    c.execute(
        f"INSERT INTO activities ({', '.join(cols)}, fit_uid) SELECT "
        f"{', '.join(cols)}, 'virtual' FROM activities WHERE id = ?",
        (ride["id"],),
    )
    vid = c.execute("SELECT MAX(id) FROM activities").fetchone()[0]
    c.execute(
        "UPDATE activities SET activity_type = 'virtual_ride', indoor = 1, distance_m = 99000,"
        " start_time_utc = '2026-03-01T08:00:00Z' WHERE id = ?",
        (vid,),
    )
    c.execute(
        """INSERT INTO best_efforts (activity_id, kind, key, value, start_s, end_s)
           SELECT ?, kind, key, value * 0.5, start_s, end_s FROM best_efforts
           WHERE activity_id = ?""",
        (vid, ride["id"]),
    )
    with TestClient(api.create_app(path)) as client:
        rec = client.get("/api/stats/records?person=anna").json()["ride"]
        longest = {r["v"]: r["ever"][0]["activity_id"] for r in rec if r["kind"] == "longest"}
        assert longest == {0: ride["id"], 1: vid}  # each pool its own record
        power = [r for r in rec if r["kind"] == "power"]
        assert power and all(r["v"] == 0 and len(r["ever"]) == 2 for r in power)  # together
        a = client.get(f"/api/activities/{ride['id']}").json()
        lon = next(e for e in a["best_efforts"] if e["kind"] == "longest")
        assert lon["v"] == 0 and lon["record_activity"] == ride["id"]  # not the 99 km virtual


def test_distance_within_12_minutes():
    t = list(range(0, 1800, 2))
    d = [s * (4.0 if 300 <= s < 1020 else 3.0) for s in t]  # 4 m/s for 12 min: 2 880 m
    run = 0.0
    dist = []
    for k, s in enumerate(t):
        run += (4.0 if 300 <= s < 1020 else 3.0) * (2 if k else 0)
        dist.append(run)
    m, start = analysis.best_distance_in_at(t, dist, 720)
    assert m == pytest.approx(2880, abs=10) and 290 <= start <= 310
    assert analysis.best_distance_in_at(t[:100], dist[:100], 720) is None  # shorter than 12 min
    del d


def test_altitude_jumps_are_taken_out():
    t = list(range(10))
    alt = [100, 101, 102, 152, 153, 154, 155, 156, 157, 158]  # 50 m in a second: a jump
    clean = analysis.clean_altitude(t, alt)
    assert clean[3] == pytest.approx(102) and clean[-1] == pytest.approx(108)


def test_biggest_climb_allows_short_dips():
    # 0-2 km up 100 m, a 200 m dip of 10 m, up 60 m more; later a separate 40 m climb
    dist, alt = [], []
    for m in range(0, 2001, 50):
        dist.append(m), alt.append(m / 20)
    for m in range(2050, 2201, 50):
        dist.append(m), alt.append(100 - (m - 2000) / 20)
    for m in range(2250, 3401, 50):
        dist.append(m), alt.append(90 + (m - 2200) / 20)
    for m in range(3450, 6001, 50):
        dist.append(m), alt.append(150 - (m - 3400) / 50)
    gain, i0, i1 = analysis.biggest_climb(dist, alt)
    assert gain == pytest.approx(150, abs=3) and dist[i0] == 0 and dist[i1] == 3400


def test_steepest_km_skips_jumps():
    t = list(range(0, 2000))
    dist = [s * 3.0 for s in t]  # 3 m/s
    alt = [d * 0.05 if d < 3000 else 150 + (d - 3000) * 0.10 for d in dist]  # 5 %, then 10 %
    grade, start, end = analysis.steepest_at(t, dist, alt, 1000)
    assert grade == pytest.approx(10, abs=0.2) and start >= 1000
    # a jump of the altitude (400 m for 20 s) is taken out before, as in analyse()
    alt2 = [a + (400 if 500 <= s < 520 else 0) for s, a in zip(t, alt, strict=True)]
    clean = analysis.clean_altitude(t, alt2)
    assert analysis.steepest_at(t, dist, clean, 1000)[0] == pytest.approx(10, abs=0.2)
    # a distance jump: 1 km in a few seconds would be a climb faster than anyone - not counted
    dist3 = [d + (1000 if s >= 400 else 0) for s, d in zip(t, dist, strict=True)]
    alt3 = [a + (100 if s >= 400 else 0) for s, a in zip(t, alt, strict=True)]
    assert analysis.steepest_at(t, dist3, alt3, 1000)[0] == pytest.approx(10, abs=0.2)
