"""Planned workouts: templates, estimates, intervals.icu text and the sync (fake transport)."""

import json
from datetime import date, timedelta

import pytest

from trailbook import db, icu, planner

HR = [100, 120, 140, 155, 168, 185]


@pytest.fixture
def conn():
    c = db.connect(":memory:")
    c.execute("INSERT INTO persons (id, label) VALUES ('p', 'P')")
    return c


def ctx():
    return {
        "run": {"hr": HR, "power": None, "from": "2026-11-01", "speed": 3.0},
        "ride": {"hr": HR, "power": [0, 140, 190, 230, 270, 320, 400, 500], "from": None,
                 "speed": 8.0},
    }  # fmt: skip


def test_starters_are_added_once(conn):
    first = planner.templates(conn, "p")
    assert [w["name"] for w in first][:2] == ["5 × 1 km VO2max", "3 × 10 min threshold"]
    conn.execute("DELETE FROM workout_templates WHERE id = ?", (first[0]["id"],))
    assert len(planner.templates(conn, "p")) == len(planner.STARTERS) - 1


def test_clean_rejects_what_garmin_would_not_get():
    base = {"name": "x", "sport": "run", "target": "hr"}
    with pytest.raises(planner.PlanError):
        planner.clean({**base, "target": "power", "steps": [planner.STARTERS[0]["steps"][0]]})
    step = {"type": "active", "length": {"kind": "lap", "value": 1}, "target": None}
    with pytest.raises(planner.PlanError):
        planner.clean({**base, "steps": [step]})
    with pytest.raises(planner.PlanError):
        planner.clean({**base, "steps": []})


def test_estimate_and_kind():
    w = planner.clean(planner.STARTERS[0])
    e = planner.estimate(w, ctx())
    assert e["kind"] == "intervals"
    assert e["steps"] == 5  # warm-up, repeat + 2, cool-down
    assert len(e["blocks"]) == 1 + 5 * 2 + 1
    assert e["blocks"][-1][1] == pytest.approx(1.0)
    step = {"type": "active", "length": {"kind": "time", "value": 2400}, "target": {"zone": [2, 2]}}
    easy = planner.clean({"name": "e", "sport": "run", "target": "hr", "steps": [step]})
    assert planner.estimate(easy, ctx())["kind"] == "easy"


def test_icu_text_uses_numbers():
    w = planner.clean(planner.STARTERS[0])
    text = planner.icu_text(w, ctx(), {"lthr": 170})
    assert "Main set 5x" in text
    assert "- 1km 99-109% LTHR" in text  # zone 5 = 168-185 bpm
    assert text.startswith("Warmup\n- Warm-up 15m")
    ride = planner.clean(planner.STARTERS[2])
    assert "- 20m 230-270w" in planner.icu_text(ride, ctx(), {})
    with pytest.raises(planner.PlanError):
        planner.icu_text(w, ctx(), {})  # no LTHR nor max HR in intervals.icu


class FakeIcu:
    def __init__(self):
        self.calls = []

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, json.loads(body) if body else None))
        if url.endswith("/athlete/0"):
            return 200, json.dumps({"id": "i1", "name": "P", "sportSettings": [
                {"types": ["Run"], "lthr": 170, "max_hr": 190}]}).encode()  # fmt: skip
        if method == "POST":
            return 200, b'{"id": 77}'
        return 200, b"{}"


def test_place_send_move_remove(conn, monkeypatch):
    monkeypatch.setattr(planner, "context", lambda c, pid: ctx())
    t = planner.templates(conn, "p")[0]
    day = (date.today() + timedelta(days=2)).isoformat()
    pid = icu.place(conn, "p", t["id"], day)
    # no key: nothing to send, and the calendar says why
    assert icu.next_due(conn) is None
    assert "API key" in icu.planned(conn, "p", day, day)[0]["sync"]
    fake = FakeIcu()
    icu.set_account(conn, "p", "abcdefghijkl")
    assert icu.sync_due(conn, fake) == 1
    post = next(c for c in fake.calls if c[0] == "POST")
    assert post[2]["start_date_local"] == f"{day}T00:00:00"
    assert post[2]["type"] == "Run" and "Main set 5x" in post[2]["description"]
    assert icu.planned(conn, "p", day, day)[0]["sync"] is None
    # moved: waits its minute, then updates the same event
    later = (date.today() + timedelta(days=3)).isoformat()
    icu.move(conn, pid, later)
    assert icu.sync_due(conn, fake) == 0
    conn.execute("UPDATE planned_workouts SET send_after = '2000-01-01T00:00:00Z'")
    assert icu.sync_due(conn, fake) == 1
    assert fake.calls[-1][0] == "PUT" and fake.calls[-1][1].endswith("/events/77")
    icu.remove(conn, pid)
    assert icu.planned(conn, "p", later, later) == []
    assert icu.sync_due(conn, fake) == 1
    assert fake.calls[-1][0] == "DELETE"
    assert not conn.execute("SELECT 1 FROM planned_workouts").fetchone()


def test_no_planning_in_the_past(conn):
    t = planner.templates(conn, "p")[0]
    with pytest.raises(planner.PlanError):
        icu.place(conn, "p", t["id"], (date.today() - timedelta(days=1)).isoformat())


def test_new_starters_reach_people_seeded_before(conn):
    conn.execute("INSERT INTO settings (key, value) VALUES ('workouts_seeded:p', '1')")
    names = [w["name"] for w in planner.templates(conn, "p")]
    assert names == [w["name"] for w in planner.STARTERS[4:]]
    assert len(planner.templates(conn, "p")) == len(planner.STARTERS) - 4


def test_pace_target_goes_as_share_of_threshold_pace():
    step = {"type": "active", "length": {"kind": "distance", "value": 1000},
            "target": {"pace": [265, 255]}}  # fmt: skip
    w = planner.clean({"name": "p", "sport": "run", "target": "pace", "steps": [step]})
    assert w["steps"][0]["target"] == {"pace": [255, 265]}  # fast first
    assert "- 1km 94-98% Pace" in planner.icu_text(w, ctx(), {"threshold_pace": 4.0})
    with pytest.raises(planner.PlanError):
        planner.icu_text(w, ctx(), {"lthr": 170})  # no threshold pace in intervals.icu
    e = planner.estimate(w, ctx())
    assert e["duration_s"] == 260  # 1 km at its own pace
    with pytest.raises(planner.PlanError):
        planner.clean({"name": "p", "sport": "ride", "target": "pace", "steps": [step]})


def test_editing_a_planned_workout_leaves_its_template(conn, monkeypatch):
    monkeypatch.setattr(planner, "context", lambda c, pid: ctx())
    t = planner.templates(conn, "p")[0]
    day = (date.today() + timedelta(days=1)).isoformat()
    pid = icu.place(conn, "p", t["id"], day)
    conn.execute("UPDATE planned_workouts SET sync_state = 'sent', icu_event_id = '9'")
    icu.update(conn, pid, {**planner.STARTERS[1], "name": "Changed"})
    row = conn.execute("SELECT * FROM planned_workouts").fetchone()
    assert row["name"] == "Changed" and row["sync_state"] == "pending"
    assert planner.templates(conn, "p")[0]["name"] == t["name"]
