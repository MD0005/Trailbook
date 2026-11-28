"""Home Assistant sensors per person (hasensors.py, SPEC §12c)."""

import json
from datetime import date

import pytest
from starlette.testclient import TestClient

from trailbook import db, hacards, hasensors, homeassistant
from trailbook.api import create_app

TODAY = date(2026, 3, 1)


def _person(c, pid, label, order=0):
    c.execute("INSERT INTO persons (id, label, sort_order) VALUES (?, ?, ?)", (pid, label, order))


def _activity(c, day, category, km, pid="ann", vo2=None, excluded=0):
    c.execute(
        """INSERT INTO activities (person_id, fit_uid, start_time_utc, utc_offset_s, category,
                                   activity_type, importer_version, distance_m, excluded,
                                   fit_metrics)
           VALUES (?, ?, ?, 3600, ?, ?, 1, ?, ?, ?)""",
        (pid, f"{pid}-{day}-{category}-{km}", f"{day}T10:00:00Z", category, category, km * 1000,
         excluded, json.dumps({"vo2max": vo2}) if vo2 else None),
    )  # fmt: skip


def _conn(tmp_path):
    c = db.connect(tmp_path / "t.db")
    _person(c, "ann", "Ann")
    _activity(c, "2025-12-30", "run", 10, vo2=48.04)
    _activity(c, "2026-02-01", "run", 5)  # 28 days before TODAY: just outside
    _activity(c, "2026-02-02", "ride", 40, vo2=60)  # a ride's VO2 max is not the run's
    _activity(c, "2026-02-20", "walk", 3)
    _activity(c, "2026-03-01", "run", 8.26, vo2=49.96)
    _activity(c, "2026-02-27", "run", 100, excluded=1)
    return c


def _by_key(items, pid="ann"):
    return {s["key"]: s for s in items if s["person"] == pid}


def test_values(tmp_path):
    c = _conn(tmp_path)
    found = _by_key(hasensors.sensors(c, TODAY))
    assert {k: s["value"] for k, s in found.items()} == {
        "vo2max_run": 50.0,
        "run_distance_28d": 8.3,
        "ride_distance_28d": 40.0,
        "run_ride_distance_year": 53.3,
        "distance_year": 56.3,
        "distance_all_time": 66.3,
    }
    year = found["run_ride_distance_year"]["attributes"]
    assert (year["run_km"], year["ride_km"]) == (13.3, 40.0)
    assert found["vo2max_run"]["attributes"]["date"] == "2026-03-01"
    assert "device_class" not in found["vo2max_run"]["attributes"]
    assert found["distance_year"]["entity_id"] == "sensor.trailbook_ann_distance_year"
    assert all(s["enabled"] for s in found.values())
    history = dict(found["run_ride_distance_year"]["history"])
    assert (history[date(2025, 12, 31)], history[date(2026, 1, 1)]) == (10.0, 0.0)
    ever = dict(found["distance_all_time"]["history"])  # a new year does not reset it
    assert (ever[date(2025, 12, 31)], ever[date(2026, 1, 1)]) == (10.0, 10.0)
    # the 28 days of a day: the run of 02-01 is in until 02-28
    window = dict(found["run_distance_28d"]["history"])
    assert (window[date(2026, 2, 28)], window[date(2026, 3, 1)]) == (5.0, 8.3)


def test_who_gets_sensors_and_their_names(tmp_path):
    c = _conn(tmp_path)
    _person(c, "Michał Nowak", "Michał", 1)
    _person(c, "empty", "Empty", 2)
    _person(c, "old", "Old", 3)
    _activity(c, "2026-02-01", "ride", 1, pid="Michał Nowak")
    _activity(c, "2026-02-01", "ride", 1, pid="old")
    c.execute("UPDATE persons SET archived = 1 WHERE id = 'old'")
    items = hasensors.sensors(c, TODAY)
    assert {s["person"] for s in items} == {"ann", "Michał Nowak"}
    other = _by_key(items, "Michał Nowak")
    assert "vo2max_run" not in other  # no estimate: no sensor
    assert other["run_distance_28d"]["value"] == 0.0
    assert other["distance_year"]["entity_id"] == "sensor.trailbook_michal_nowak_distance_year"


class FakeHa:
    """Home Assistant's states and the statistics sent to it."""

    def __init__(self, monkeypatch):
        self.states, self.statistics, self.sets = {}, [], 0
        ha = self

        class Ws:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return None

            def call(self, msg):
                ha.statistics.append(msg)

        def set_state(entity_id, state, attributes):
            ha.sets += 1
            ha.states[entity_id] = (state, attributes)
            return True

        def remove_state(entity_id):
            ha.states.pop(entity_id, None)
            return True

        monkeypatch.setattr(homeassistant, "available", lambda: True)
        monkeypatch.setattr(homeassistant, "set_state", set_state)
        monkeypatch.setattr(homeassistant, "remove_state", remove_state)
        monkeypatch.setattr(homeassistant, "has_state", lambda e: e in ha.states)
        monkeypatch.setattr(hacards, "Ws", Ws)


@pytest.fixture
def ha(monkeypatch):
    return FakeHa(monkeypatch)


def test_publish_sends_only_what_changed(tmp_path, ha):
    c = _conn(tmp_path)
    assert hasensors.publish(c, TODAY) == 6
    assert ha.states["sensor.trailbook_ann_run_distance_28d"][0] == "8.3"
    # a year of history per sensor and call, today left out
    assert len(ha.statistics) == 12
    first = ha.statistics[0]
    assert first["type"] == "recorder/import_statistics"
    assert first["metadata"]["source"] == "recorder" and first["metadata"]["mean_type"] == 1
    assert first["stats"][0]["start"] == "2025-12-30T12:00:00+00:00"
    assert max(s["start"] for m in ha.statistics for s in m["stats"]) < "2026-03-01"
    ha.statistics.clear()
    assert hasensors.publish(c, TODAY) == 0 and not ha.statistics
    ha.states.clear()  # Home Assistant restarted: the states again, not the history
    assert hasensors.publish(c, TODAY) == 6 and not ha.statistics
    _activity(c, "2026-02-25", "ride", 10)  # only this year's values change
    assert hasensors.publish(c, TODAY) == 4
    assert {m["stats"][0]["start"][:4] for m in ha.statistics} == {"2026"}


def test_switched_off_removed_and_on_again_when_it_comes_back(tmp_path, ha):
    c = _conn(tmp_path)
    hasensors.publish(c, TODAY)
    assert hasensors.set_enabled(c, "ann", "distance_year", False)
    assert not hasensors.set_enabled(c, "ann", "nothing", False)
    hasensors.publish(c, TODAY)
    assert "sensor.trailbook_ann_distance_year" not in ha.states and len(ha.states) == 5
    assert not _by_key(hasensors.sensors(c, TODAY))["distance_year"]["enabled"]
    c.execute("UPDATE persons SET archived = 1")
    hasensors.publish(c, TODAY)
    assert ha.states == {}
    c.execute("UPDATE persons SET archived = 0")
    ha.statistics.clear()
    assert hasensors.publish(c, TODAY) == 6 and ha.statistics  # all on, with their history
    assert _by_key(hasensors.sensors(c, TODAY))["distance_year"]["enabled"]


def test_api(tmp_path):
    c = _conn(tmp_path)
    c.commit()
    c.close()
    with TestClient(create_app(tmp_path / "t.db")) as client:
        data = client.get("/api/ha/sensors").json()
        assert data["addon"] is False
        one = data["sensors"][0]
        assert one["enabled"] and one["tip"] and "history" not in one
        body = {"person": "ann", "key": one["key"], "enabled": False}
        assert client.put("/api/ha/sensors", json=body).status_code == 204
        assert not client.get("/api/ha/sensors").json()["sensors"][0]["enabled"]
        assert client.put("/api/ha/sensors", json={**body, "key": "x"}).status_code == 404
        assert client.put("/api/ha/sensors", json={**body, "enabled": 1}).status_code == 400
