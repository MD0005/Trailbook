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
                                   activity_type, moving_s, timer_s, distance_m, avg_speed,
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
    assert kinds == {"hr", "pace", "power"}
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

        rec = client.get("/api/stats/records?person=anna&kind=pace&type=g:run").json()
        best5k = next(r for r in rec["records"] if r["key"] == 5000)
        assert best5k["value"] == pytest.approx(5000 / 3.5, abs=1)
        assert client.get("/api/stats/records?person=anna&kind=x").status_code == 400

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
