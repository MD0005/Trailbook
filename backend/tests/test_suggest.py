"""Calendar › Next: the suggested session."""

from __future__ import annotations

import json
from datetime import date

from trailbook import db, suggest

BOUNDS = [100, 120, 140, 160, 180, 200]


def _act(c, day, cat, secs, zones=None, load=50):
    c.execute(
        """INSERT INTO activities (person_id, fit_uid, start_time_utc, utc_offset_s, category,
                                   activity_type, time_s, load, zones, importer_version)
           VALUES ('anna', ?, ?, 0, ?, ?, ?, ?, ?, 1)""",
        (f"{day}-{cat}-{secs}", f"{day}T08:00:00Z", cat, cat, secs, load,
         json.dumps({"hr": {"times": zones, "bounds": BOUNDS}}) if zones else None),
    )  # fmt: skip


def test_split_and_suggestions(tmp_path):
    c = db.connect(tmp_path / "t.db")
    c.execute("INSERT INTO persons (id, label) VALUES ('anna', 'Anna')")
    # the backup without a heart rate stream: zones 1-2 (and below) / 3-4 / 5
    assert suggest._split(json.dumps({"hr": {"times": [10, 20, 30, 40, 50, 60, 0]}})) == [
        60,
        90,
        60,
    ]
    # four easy runs in the week, one ride in the month: no long session yet
    for d in ("2026-11-17", "2026-11-19", "2026-11-21", "2026-11-22"):
        _act(c, d, "run", 2400, [0, 600, 1800, 0, 0, 0, 0])
    _act(c, "2026-11-02", "ride", 3600, [0, 3600, 0, 0, 0, 0, 0])
    _act(c, "2026-11-05", "ride", 3600, [0, 3600, 0, 0, 0, 0, 0])
    out = suggest.suggest(c, "anna", date(2026, 11, 23))
    assert out["done"] == {"easy": 9600, "moderate": 0, "hard": 0}
    assert out["next"]["kind"] == "long" and out["next"]["day"] == "2026-11-23"
    assert out["next"]["sport"] == "ride"  # rides fell from the usual mix
    assert out["next"]["minutes"] == 90
    # a long ride done: all easy, the polarized model wants hard time
    _act(c, "2026-11-20", "ride", 6000, [0, 6000, 0, 0, 0, 0, 0])
    out = suggest.suggest(c, "anna", date(2026, 11, 23))
    assert out["next"]["kind"] == "intervals"
    # a hard session today: the next is for tomorrow and easy
    _act(c, "2026-11-23", "run", 3000, [0, 600, 600, 600, 0, 1200, 0])
    out = suggest.suggest(c, "anna", date(2026, 11, 23), "pyramidal")
    assert out["next"]["day"] == "2026-11-24" and out["next"]["kind"] in ("easy", "rest")
    assert out["model"] == "pyramidal" and out["target"]["moderate"] == 0.2


def test_plan_counts_three_days_ahead(tmp_path):
    c = db.connect(tmp_path / "t.db")
    c.execute("INSERT INTO persons (id, label) VALUES ('anna', 'Anna')")
    step = {"type": "active", "length": {"kind": "time", "value": 2400}, "target": {"zone": [2, 2]}}
    for day in ("2026-11-26", "2026-11-28"):  # in 3 days: counts; in 5: too far ahead
        c.execute(
            """INSERT INTO planned_workouts (person_id, day, name, sport, target, steps,
                                             created_at, updated_at)
               VALUES ('anna', ?, ?, 'run', 'hr', ?, '', '')""",
            (day, f"Easy {day}", json.dumps([step])),
        )
    out = suggest.suggest(c, "anna", date(2026, 11, 23))
    assert [p["day"] for p in out["plans"]] == ["2026-11-26"]
    assert out["form_after"] is None  # no training done yet: no fitness model to run on
    _act(c, "2026-11-20", "run", 3600, [0, 3600, 0, 0, 0, 0, 0], load=80)
    out = suggest.suggest(c, "anna", date(2026, 11, 23))
    assert out["form_after_day"] == "2026-11-26" and out["form_after"] is not None
    assert out["form_after"] != out["form"]  # the plan's load moves it
    assert out["window"] == ["2026-11-17", "2026-11-26"]


def test_split_by_thresholds(tmp_path):
    from trailbook import planner, streams

    c = db.connect(tmp_path / "t.db")
    c.execute("INSERT INTO persons (id, label) VALUES ('anna', 'Anna')")
    _act(c, "2026-11-22", "ride", 1500, [0, 0, 0, 0, 0, 1500, 0])  # zones say: all hard
    aid = c.execute("SELECT id FROM activities").fetchone()[0]
    c.execute("UPDATE activities SET watch_lthr = 170 WHERE id = ?", (aid,))
    # 10 min at 140 (under LT1 = 0.89 x 170 = 151), 10 min at 160, 5 min at 175 (over LTHR)
    hr = [140.0] * 600 + [160.0] * 600 + [175.0] * 301
    for name, values in (("time", [float(i) for i in range(len(hr))]), ("hr", hr)):
        enc, blob = streams.encode(values)
        c.execute(
            "INSERT INTO streams (activity_id, channel, encoding, length, data) VALUES (?,?,?,?,?)",
            (aid, name, enc, len(values), blob),
        )
    out = suggest.suggest(c, "anna", date(2026, 11, 23))
    assert out["done"] == {"easy": 600, "moderate": 600, "hard": 300}  # the stream, not the zones
    assert out["limits"] == [151, 170] and out["by_limits"] == 1
    # a planned zone 4 step (Garmin's 153-168 here): between the thresholds, so moderate
    ctx = {"ride": {"hr": [95, 112, 131, 153, 168, 187], "power": None, "speed": 8.0,
                    "limits": (151.3, 170.0)}}  # fmt: skip
    step = {"type": "active", "length": {"kind": "time", "value": 600}, "target": {"zone": [4, 4]}}
    w = {"name": "t", "sport": "ride", "target": "hr", "steps": [step]}
    assert planner.estimate(w, ctx)["intensity"] == [0, 600, 0]
    del ctx["ride"]["limits"]  # no thresholds: the zones, 3-4 moderate
    assert planner.estimate(w, ctx)["intensity"] == [0, 600, 0]
    step["target"] = {"zone": [5, 5]}
    assert planner.estimate(w, ctx)["intensity"] == [0, 0, 600]
