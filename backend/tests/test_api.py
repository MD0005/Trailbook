import shutil

import pytest
from conftest import SAMPLE_DATA, make_fit
from starlette.testclient import TestClient

from trailbook import analysis, db, importer
from trailbook.api import create_app


@pytest.fixture
def setup(tmp_path):
    root = tmp_path / "root"
    (root / "alice").mkdir(parents=True)
    (root / "alice" / "sleep.fit").write_bytes(make_fit(49))
    db_path = tmp_path / "t.db"
    conn = db.connect(db_path)
    db.set_setting(conn, "root", str(root))
    importer.scan(conn, root)
    importer.run_queue(conn, root)
    conn.close()
    app = create_app(db_path)
    return TestClient(app), root, db_path


def test_info_types_persons(setup):
    client, _, _ = setup
    assert client.get("/api/info").json()["schema"] == db.SCHEMA_VERSION
    types = client.get("/api/types").json()
    assert any(t["key"] == "yoga" and t["group"] == "mind_body" for t in types["types"])
    # Manual › Fitness is written from these, the same values the model uses
    rules = types["fitness_rules"]
    assert (rules["ctl_days"], rules["atl_days"]) == (analysis.CTL_DAYS, analysis.ATL_DAYS)
    assert rules["lthr_share_of_max"] == analysis.LTHR_SHARE_OF_MAX
    persons = client.get("/api/persons").json()
    assert persons[0]["id"] == "alice" and persons[0]["activities"] == 0


def test_person_label_update(setup):
    client, _, _ = setup
    r = client.patch("/api/persons/alice", json={"label": "Alice"})
    assert r.status_code == 200 and r.json()["label"] == "Alice"
    assert client.patch("/api/persons/alice", json={"label": "  "}).status_code == 400
    assert client.patch("/api/persons/nobody", json={"label": "x"}).status_code == 404


def test_import_status_and_files(setup):
    client, _, _ = setup
    st = client.get("/api/import/status").json()
    assert st["files"] == {"skipped": 1}
    files = client.get("/api/import/files?status=skipped").json()
    assert files["total"] == 1 and files["items"][0]["skip_reason"] == "sleep"


def test_scan_starts_background_importer(setup):
    client, root, _ = setup
    (root / "alice" / "hrv.fit").write_bytes(make_fit(44))
    r = client.post("/api/import/scan")
    assert r.status_code == 202
    job = client.app.state.import_job
    assert job.wait(timeout=60) == 0
    st = client.get("/api/import/status").json()
    assert st["files"] == {"skipped": 2}
    assert st["progress"]["state"] == "finished"
    assert st["last_run"]["trigger"] == "manual"


def test_static_preview_served(setup):
    client, _, _ = setup
    r = client.get("/")
    assert r.status_code == 200 and "Trailbook" in r.text


def test_unknown_activity(setup):
    client, _, _ = setup
    assert client.get("/api/activities/999").status_code == 404
    assert client.get("/api/activities/999/streams").status_code == 404


@pytest.mark.samples
def test_activity_endpoints_on_sample_data(tmp_path):
    root = tmp_path / "root"
    shutil.copytree(SAMPLE_DATA, root)
    db_path = tmp_path / "s.db"
    conn = db.connect(db_path)
    importer.scan(conn, root)
    importer.run_queue(conn, root)
    conn.close()
    client = TestClient(create_app(db_path))

    listing = client.get("/api/activities?limit=5").json()
    assert listing["total"] > 0 and len(listing["items"]) <= 5
    # Charts view: a small chart per tile (tilechart.py), its kind by the training type
    charted = client.get("/api/activities?limit=3&chart=chart").json()["items"]
    kinds = {"blocks", "altitude", "track", "speed"}
    assert all("tile_chart" in a for a in charted)
    assert all(a["tile_chart"] is None or a["tile_chart"]["kind"] in kinds for a in charted)
    totals = listing["totals"]
    assert 0 < totals["active_days"] <= totals["count"]
    assert totals["longest_m"] <= totals["distance_m"] and totals["first"] <= totals["last"]
    starts = [a["start_time_utc"] for a in listing["items"]]
    assert starts == sorted(starts, reverse=True)

    with_gps = client.get("/api/activities?limit=1000").json()["items"]
    a = next(x for x in with_gps if x["has_gps"])
    detail = client.get(f"/api/activities/{a['id']}").json()
    assert "time" in detail["channels"]

    s = client.get(f"/api/activities/{a['id']}/streams?channels=time,hr&max_points=50").json()
    assert set(s["streams"]) <= {"time", "hr"} and s["length"] <= 50
    assert client.get(f"/api/activities/{a['id']}/streams?channels=bogus").status_code == 400

    assert client.get(f"/api/activities/{a['id']}/track").json()["points"] >= 2

    r = client.patch(f"/api/activities/{a['id']}", json={"type": "hike"})
    assert r.json()["activity_type"] == "hike" and r.json()["category"] == "hike"
    assert client.patch(f"/api/activities/{a['id']}", json={"type": "nope"}).status_code == 400

    filtered = client.get("/api/activities?type=hike").json()
    assert [x["id"] for x in filtered["items"]] == [a["id"]]

    assert client.delete(f"/api/activities/{a['id']}").status_code == 204
    assert client.get(f"/api/activities/{a['id']}").status_code == 404


def test_files_listing_has_fit_fields_and_forget(setup):
    client, _, _ = setup
    item = client.get("/api/import/files").json()["items"][0]
    assert item["fit_type"] == "sleep" and item["imported_at"]
    assert client.delete(f"/api/import/files/{item['id']}").status_code == 204
    assert client.get("/api/import/files").json()["total"] == 0
    assert client.delete(f"/api/import/files/{item['id']}").status_code == 404


def test_ui_settings_are_kept_per_person(setup):
    client, _, _ = setup
    assert client.get("/api/ui-settings?person=alice").json() == {}
    value = {"map": {"tone": "muted"}, "heatmap": {"width": 3}}
    assert client.put("/api/ui-settings/map?person=alice", json=value).status_code == 204
    assert client.put("/api/ui-settings/map?person=all", json={"x": 1}).status_code == 204
    assert client.get("/api/ui-settings?person=alice").json() == {"map": value}
    assert client.get("/api/ui-settings").json() == {"map": {"x": 1}}
    assert client.put("/api/ui-settings/bad key?person=alice", json=1).status_code == 400


def test_activity_list_workout_filter_and_neighbours(setup):
    client, _, db_path = setup
    conn = db.connect(db_path)
    rows = [  # (id, start, workout, override)
        (1, "2026-01-01T08:00:00Z", "tempo", None),
        (2, "2026-01-02T08:00:00Z", "recovery", "tempo"),
        (3, "2026-01-03T08:00:00Z", None, None),
    ]
    for aid, start, wk, ov in rows:
        conn.execute(
            """INSERT INTO activities (id, person_id, fit_uid, start_time_utc, category,
                                       activity_type, workout, workout_override, importer_version)
               VALUES (?, 'alice', ?, ?, 'run', 'run', ?, ?, 1)""",
            (aid, f"uid{aid}", start, wk, ov),
        )
    conn.commit()
    conn.close()
    r = client.get("/api/activities?person=alice&workouts=tempo").json()
    assert sorted(a["id"] for a in r["items"]) == [1, 2]  # the override counts
    assert r["workout_counts"] == {"tempo": 2, "none": 1}  # under the other filters only
    r = client.get("/api/activities?person=alice&workouts=none").json()
    assert [a["id"] for a in r["items"]] == [3]
    a = client.get("/api/activities/2").json()
    assert (a["prev_id"], a["next_id"]) == (1, 3)
    a = client.get("/api/activities/3").json()
    assert (a["prev_id"], a["next_id"]) == (2, None)
    # previous / next stay within the list's filters
    a = client.get("/api/activities/1?workouts=tempo").json()
    assert (a["prev_id"], a["next_id"]) == (None, 2)
    a = client.get("/api/activities/3?from=2026-01-02&to=2026-01-03").json()
    assert (a["prev_id"], a["next_id"]) == (2, None)
    a = client.get("/api/activities/2?from=2026-01-02").json()
    assert (a["prev_id"], a["next_id"]) == (None, 3)


def test_time_filter_last_and_years(setup):
    from datetime import date

    from trailbook.api import last_since

    today = date(2026, 3, 31)
    assert last_since("1m", today) == "2026-02-28"  # day clamped to the shorter month
    assert last_since("3m", today) == "2025-12-31"
    assert last_since("ytd", today) == "2026-01-01"
    assert last_since("1y", today) == "2025-03-31"
    assert last_since("bogus", today) is None

    client, _, db_path = setup
    conn = db.connect(db_path)
    for aid, start in ((1, "2023-05-01T08:00:00Z"), (2, "2024-05-01T08:00:00Z"),
                       (3, "2025-05-01T08:00:00Z")):  # fmt: skip
        conn.execute(
            """INSERT INTO activities (id, person_id, fit_uid, start_time_utc, category,
                                       activity_type, importer_version)
               VALUES (?, 'alice', ?, ?, 'run', 'run', 1)""",
            (aid, f"uid{aid}", start),
        )
    conn.commit()
    conn.close()
    ids = lambda q: sorted(a["id"] for a in client.get("/api/activities?" + q).json()["items"])  # noqa: E731
    assert ids("years=2023,2025") == [1, 3]  # years with a gap
    assert ids("years=2024") == [2]
    assert client.get("/api/activities?years=24").status_code == 400
