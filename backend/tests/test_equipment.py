"""Gear › Equipment (equipment.py, SPEC §12d): sensors, history and pairing."""

import json
from datetime import UTC, date, datetime, timedelta

import pytest
from starlette.testclient import TestClient

from trailbook import db, equipment, hacards, homeassistant
from trailbook.api import create_app


def _day(text):
    return date.fromisoformat(text)


def test_match_one_activity_several_and_a_late_update():
    acts = [
        (1, _day("2026-05-01"), 10.0),
        (2, _day("2026-05-03"), 6.0),
        (3, _day("2026-05-03"), 6.1),
        (4, _day("2026-05-10"), 8.0),
        (5, _day("2026-05-20"), 20.0),
    ]
    events = [
        (_day("2026-05-02"), 10.1),  # the day before, 1 % off
        (_day("2026-05-03"), 12.0),  # two rides together
        (_day("2026-05-19"), 8.0),  # the sensor updated nine days later
        (_day("2026-05-20"), 25.0),  # nothing adds up to it
    ]
    assert equipment.match(events, acts) == {0: [1], 1: [3, 2], 2: [4]}


def test_match_takes_each_activity_once_the_closest_first():
    acts = [(1, _day("2026-05-01"), 10.0), (2, _day("2026-05-02"), 10.2)]
    events = [(_day("2026-05-02"), 10.0), (_day("2026-05-02"), 10.2)]
    assert equipment.match(events, acts) == {0: [1], 1: [2]}


def _conn(tmp_path):
    c = db.connect(tmp_path / "t.db")
    c.execute("INSERT INTO persons (id, label) VALUES ('ann', 'Ann')")
    rows = [
        ("2026-05-01", "ride", "road_ride", 40),
        ("2026-05-02", "run", "run", 10),
        ("2026-06-01", "ride", "road_ride", 50),
        ("2026-06-02", "run", "run", 5),
    ]
    for day, category, kind, km in rows:
        c.execute(
            """INSERT INTO activities (person_id, fit_uid, start_time_utc, utc_offset_s,
                                       category, activity_type, importer_version, distance_m)
               VALUES ('ann', ?, ?, 3600, ?, ?, 1, ?)""",
            (f"{day}-{kind}", f"{day}T10:00:00Z", category, kind, km * 1000),
        )
    c.execute(
        "INSERT INTO ui_settings (person_id, key, value, updated_at) VALUES ('ann', ?, ?, '')",
        (
            equipment.SETTING,
            json.dumps(
                [
                    {"entity": "sensor.bike", "label": "My bike"},
                    {"entity": "sensor.shoes", "label": "Shoes"},
                    {"entity": "light.no", "label": "ignored"},
                ]
            ),
        ),
    )
    return c


STATES = {
    "sensor.bike": {
        "entity_id": "sensor.bike",
        "state": "9000.4",
        "attributes": {
            "unit_of_measurement": "km",
            "gear_uuid": "a",
            "total_activities": 222,
            "maximum_meters": 10_000_000,
            "total_duration_seconds": 3600,
            "gear_status_name": "active",
            "custom_make_model": "Bike 6.0",
        },
    },
    "sensor.shoes": {
        "entity_id": "sensor.shoes",
        "state": "878229",
        "attributes": {"unit_of_measurement": "m", "device_class": "distance"},
    },
    "sensor.trailbook_ann_distance_year": {
        "entity_id": "sensor.trailbook_ann_distance_year",
        "state": "5",
        "attributes": {"unit_of_measurement": "km", "device_class": "distance"},
    },
    "sensor.temperature": {
        "entity_id": "sensor.temperature",
        "state": "5",
        "attributes": {"unit_of_measurement": "°C"},
    },
}


@pytest.fixture
def ha(monkeypatch):
    """Home Assistant with the states above and daily statistics: growth on some days."""
    asked = []

    def stats(*grown):
        rows, day = [], date(2026, 4, 30)
        wanted = dict(grown)
        while day <= date(2026, 6, 5):
            start = datetime(day.year, day.month, day.day, tzinfo=UTC) - timedelta(hours=2)
            rows.append(
                {"start": start.timestamp() * 1000, "change": wanted.get(day.isoformat(), 0)}
            )
            day += timedelta(days=1)
        return rows

    class Ws:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return None

        def call(self, msg):
            asked.append(msg)
            return {
                "sensor.bike": stats(
                    ("2026-05-01", 40.2), ("2026-06-02", 50.0), ("2026-06-03", 0.1)
                ),
                "sensor.shoes": stats(("2026-05-02", 10.0), ("2026-06-02", 5.0)),
            }

    def get_json(path):
        if path == "states":
            return list(STATES.values())
        return STATES.get(path.removeprefix("states/"))

    monkeypatch.setattr(homeassistant, "available", lambda: True)
    monkeypatch.setattr(homeassistant, "get_json", get_json)
    monkeypatch.setattr(hacards, "Ws", Ws)
    equipment._cache.clear()
    return asked


def test_sensors_of_a_distance(ha):
    found = equipment.sensors()
    assert [(s["entity"], s["km"], s["gear"]) for s in found] == [
        ("sensor.bike", 9000.4, True),
        ("sensor.shoes", 878.2, False),
    ]
    assert found[0]["name"] == "Bike 6.0"


def test_summary(tmp_path, ha):
    c = _conn(tmp_path)
    data = equipment.summary(c, "ann")
    assert data["addon"] and data["history"] and data["first_day"] == "2026-04-30"
    bike, shoes = data["items"]
    assert (bike["label"], bike["km"], bike["limit_km"], bike["activities"]) == (
        "My bike", 9000.4, 10000, 222)  # fmt: skip
    assert (bike["kind"], bike["paired"], bike["uses"], bike["order"]) == ("bike", 2, 2, 0)
    assert bike["spans"] == [["2026-05-01", "2026-05-01"], ["2026-06-02", "2026-06-02"]]
    assert bike["types"] == [{"type": "road_ride", "activities": 2}]
    assert (shoes["kind"], shoes["km"], shoes["activities"]) == ("shoe", 878.2, None)
    assert ha[0]["type"] == "recorder/statistics_during_period" and ha[0]["period"] == "day"
    assert ha[0]["units"] == {"distance": "km"}


def test_outside_home_assistant(tmp_path, monkeypatch):
    monkeypatch.setattr(homeassistant, "available", lambda: False)
    c = _conn(tmp_path)
    assert equipment.summary(c, "ann") == {
        "addon": False, "history": False, "first_day": None, "items": []}  # fmt: skip
    c.commit()
    c.close()
    assert TestClient(create_app(tmp_path / "t.db")).get("/api/info").json()["ha"] is False


def test_api_and_activities_of_an_equipment(tmp_path, ha):
    c = _conn(tmp_path)
    c.commit()
    c.close()
    client = TestClient(create_app(tmp_path / "t.db"))
    assert client.get("/api/info").json()["ha"] is True
    assert client.get("/api/equipment").status_code == 400
    assert len(client.get("/api/equipment?person=ann").json()["items"]) == 2
    assert client.get("/api/equipment/sensors").json()["sensors"][0]["entity"] == "sensor.bike"
    data = client.get("/api/activities?person=ann&equipment=sensor.shoes").json()
    assert data["total"] == 2 and data["device"] == {"name": "Shoes"}
    assert {a["category"] for a in data["items"]} == {"run"}
    assert client.get("/api/activities?person=ann&equipment=sensor.x").json()["total"] == 0
    first = data["items"][-1]["id"]
    one = client.get(f"/api/activities/{first}?equipment=sensor.shoes").json()
    assert one["next_id"] == data["items"][0]["id"]


def test_equipment_of_an_activity(tmp_path, ha):
    c = _conn(tmp_path)
    c.execute(
        """INSERT INTO activities (person_id, fit_uid, start_time_utc, utc_offset_s, category,
                                   activity_type, importer_version, distance_m)
           VALUES ('ann', 'unused', '2026-05-20T10:00:00Z', 3600, 'ride', 'road_ride', 1, 33000)"""
    )
    ids = {r["fit_uid"]: r["id"] for r in c.execute("SELECT id, fit_uid FROM activities")}
    c.commit()
    c.close()
    client = TestClient(create_app(tmp_path / "t.db"))
    ride = client.get(f"/api/activities/{ids['2026-05-01-road_ride']}/equipment").json()
    assert ride == {"items": [{"key": "sensor.bike", "label": "My bike", "kind": "bike"}]}
    run = client.get(f"/api/activities/{ids['2026-06-02-run']}/equipment").json()
    assert [x["key"] for x in run["items"]] == ["sensor.shoes"]
    # the day before the sensor grew
    late = client.get(f"/api/activities/{ids['2026-06-01-road_ride']}/equipment").json()
    assert [x["key"] for x in late["items"]] == ["sensor.bike"]
    # no growth of a sensor adds up to it
    assert client.get(f"/api/activities/{ids['unused']}/equipment").json() == {"items": []}
    assert client.get("/api/activities/999/equipment").status_code == 404
