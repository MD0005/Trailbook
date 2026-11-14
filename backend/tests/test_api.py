import shutil

import pytest
from conftest import SAMPLE_DATA, make_fit
from starlette.testclient import TestClient

from trailbook import db, importer
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


@pytest.mark.skipif(not SAMPLE_DATA.is_dir(), reason="no local sample-data")
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
