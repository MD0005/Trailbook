"""The shared Time / Type filters of every tab (from, to, types)."""

from __future__ import annotations

import pytest
from starlette.testclient import TestClient
from test_analysis import _activity

from trailbook import db
from trailbook.api import create_app


@pytest.fixture
def client(tmp_path):
    path = tmp_path / "t.db"
    c = db.connect(path)
    c.execute("INSERT INTO persons (id, label) VALUES ('anna', 'Anna'), ('ben', 'Ben')")
    _activity(c, "anna", "2025-12-31")  # run
    _activity(c, "anna", "2026-01-05", group="walk", atype="walk")
    _activity(c, "anna", "2026-03-01", group="ride", atype="road_ride", speed=8)
    _activity(c, "ben", "2026-02-01")
    c.close()
    return TestClient(create_app(path))


def ids(client, query):
    return len(client.get("/api/activities?" + query).json()["items"])


def test_time_and_types_on_activities(client):
    assert ids(client, "") == 4
    assert ids(client, "from=2026-01-01") == 3
    assert ids(client, "from=2026-01-01&to=2026-02-01") == 2  # 'to' is inclusive
    assert ids(client, "types=run,walk") == 3
    assert ids(client, "types=g:ride") == 1
    assert ids(client, "types=run&person=anna") == 1
    assert client.get("/api/activities?from=2026-1-1").status_code == 400


def test_time_range_and_other_tabs(client):
    r = client.get("/api/time-range?person=anna").json()
    assert (r["first"], r["last"], r["years"]) == ("2025-12-31", "2026-03-01", ["2026", "2025"])
    assert client.get("/api/time-range").json()["last"] == "2026-03-01"
    totals = client.get("/api/stats/totals?person=anna&by=year&from=2026-01-01&types=walk,run")
    assert [(r["period"], r["count"]) for r in totals.json()["rows"]] == [("2026", 1)]
    people = client.get("/api/compare?from=2026-01-15").json()["people"]
    assert {p["id"]: p["activities"] for p in people} == {"anna": 1, "ben": 1}
