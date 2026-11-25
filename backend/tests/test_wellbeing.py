"""Wellbeing › Movement: daily values with Garmin's goals (/api/wellbeing/movement)."""

import json
from datetime import date, timedelta

import pytest
from starlette.testclient import TestClient

from trailbook import db, wellbeing
from trailbook.api import create_app


def _day(c, day, steps=None, goal=None, moderate=None, vigorous=None, active=None):
    s = {"movement": {}, "intensityMinutes": {}, "calories": {}}
    if steps is not None:
        s["movement"]["steps"] = {"value": steps, **({"goal": goal} if goal else {})}
    if moderate is not None:
        s["intensityMinutes"] = {"moderate": moderate, "vigorous": vigorous or 0, "goal": 200}
    if active is not None:
        s["calories"] = {"burnedActive": active, "burnedTotal": active + 1800}
    c.execute(
        "INSERT INTO garmin_days (person_id, day, summary, fetched_at) VALUES ('anna', ?, ?, '')",
        (day, json.dumps(s)),
    )


@pytest.fixture
def tdb(tmp_path):
    path = tmp_path / "t.db"
    c = db.connect(path)
    c.execute("INSERT INTO persons (id, label) VALUES ('anna', 'Anna')")
    yield c, path
    c.close()


def test_intensity_counts_vigorous_twice_and_its_goal_carries_over(tdb):
    c, _ = tdb
    _day(c, "2026-03-01", steps=8000, moderate=20, vigorous=10, active=400)
    _day(c, "2026-03-02", steps=3000)  # no intensity goal that day: the last one known
    _day(c, "2026-03-03")  # nothing measured: left out
    days = wellbeing.movement_days(c, "anna", "2026-03-01", "2026-03-31")
    assert [d["day"] for d in days] == ["2026-03-01", "2026-03-02"]
    assert days[0]["intensity"] == 40 and days[0]["calories_active"] == 400
    assert days[1]["intensity_goal"] == 200
    assert "steps_goal" not in days[0]  # the step goal is one for everyone (the page)


def test_api_last_two_years(tdb):
    c, path = tdb
    today = date.today()
    _day(c, (today - timedelta(days=800)).isoformat(), steps=1000)  # older than 2 years
    _day(c, (today - timedelta(days=10)).isoformat(), steps=9000, goal=7000)
    client = TestClient(create_app(path))
    r = client.get("/api/wellbeing/movement?person=anna&last=2y").json()
    assert [d["steps"] for d in r["days"]] == [9000]
    assert r["to"] == today.isoformat()
    r = client.get("/api/wellbeing/movement?person=anna").json()  # All time
    assert len(r["days"]) == 2


def test_body_rows_and_last_full(tdb):
    c, path = tdb
    c.execute(
        "INSERT INTO files (id, person_id, rel_path, size, mtime, status, first_seen, last_seen)"
        " VALUES (1, 'anna', 'w.fit', 1, 0, 'skipped', '', '')"
    )
    today = date.today()
    rows = [
        ((today - timedelta(days=20)).isoformat() + "T07:00:00Z", 70.0, 18.0, 35.0, 3.0),
        ((today - timedelta(days=5)).isoformat() + "T07:00:00Z", 69.5, None, None, None),
    ]
    for ts, w, fat, muscle, bone in rows:
        c.execute(
            "INSERT INTO body_parts (file_id, ts, weight, fat_pct, muscle_kg, bone_kg)"
            " VALUES (1, ?, ?, ?, ?, ?)",
            (ts, w, fat, muscle, bone),
        )
    client = TestClient(create_app(path))
    r = client.get("/api/wellbeing/body?person=anna&last=1y").json()
    assert [i["weight"] for i in r["items"]] == [70.0, 69.5]
    assert r["last"]["weight"] == 69.5
    assert r["last_full"]["fat_pct"] == 18.0  # the newest weigh-in with a composition


def test_parse_weight_reads_a_scale_file():
    from trailbook import export, fitfile

    w = export.FitWriter()
    w.write("file_id", {"type": "weight", "manufacturer": "development", "product": 0,
                        "time_created": 1_100_000_000})  # fmt: skip
    w.write("weight_scale", {"timestamp": 1_100_000_000, "weight": 78.3, "percent_fat": 16.6,
                             "percent_hydration": 60.9, "muscle_mass": 33.8, "bone_mass": 3.4,
                             "bmi": 21.0})  # fmt: skip
    w.write("weight_scale", {"timestamp": 1_100_086_400, "weight": 78.1, "percent_fat": 0.0})
    rows = fitfile.parse_weight(w.bytes())
    assert [r["weight"] for r in rows] == pytest.approx([78.3, 78.1])
    assert rows[0]["fat_pct"] == pytest.approx(16.6) and rows[0]["muscle_kg"] == pytest.approx(33.8)
    assert rows[1]["fat_pct"] is None  # 0: not measured
