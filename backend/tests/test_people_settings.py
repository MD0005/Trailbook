from datetime import UTC, datetime, timedelta

import pytest
from conftest import make_fit
from starlette.testclient import TestClient

from trailbook import db, importer, scheduler
from trailbook.api import create_app

T0 = 1_100_000_000  # FIT time


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def test_device_mode_assigns_by_watch(conn, tmp_path):
    root = tmp_path / "root"
    write(root / "a.fit", make_fit(49, serial=111, created=T0))
    write(root / "export" / "b.fit", make_fit(49, serial=222, created=T0 + 60))
    db.set_setting(conn, "person_mode", "devices")
    conn.execute("INSERT INTO persons (id, label) VALUES ('alice', 'Alice')")
    conn.execute(
        "INSERT INTO devices (serial, person_id, first_seen, last_seen) "
        "VALUES (111, 'alice', '', '')"
    )

    result = importer.scan(conn, root)
    assert result.scanned == 2 and result.ignored == []  # root-level files count
    importer.run_queue(conn, root)

    owners = dict(conn.execute("SELECT device_serial, person_id FROM files").fetchall())
    assert owners == {111: "alice", 222: importer.UNASSIGNED}

    # Assigning the unknown watch moves its files to that person.
    conn.execute("INSERT INTO persons (id, label) VALUES ('bob', 'Bob')")
    importer.assign_device(conn, 222, "bob")
    owners = dict(conn.execute("SELECT device_serial, person_id FROM files").fetchall())
    assert owners[222] == "bob"


def test_folder_mode_learns_watch(conn, tmp_path):
    root = tmp_path / "root"
    write(root / "alice" / "a.fit", make_fit(49, serial=111, created=T0))
    importer.scan(conn, root)
    importer.run_queue(conn, root)
    row = conn.execute("SELECT person_id FROM devices WHERE serial = 111").fetchone()
    assert row["person_id"] == "alice"


def test_next_scan_time(conn, tmp_path):
    assert scheduler.next_scan_at(conn) is None  # no folder yet
    db.set_setting(conn, "root", str(tmp_path))
    assert scheduler.interval_min(conn) == scheduler.DEFAULT_INTERVAL_MIN
    assert scheduler.next_scan_at(conn) <= datetime.now(UTC)  # never scanned: due now

    finished = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
    conn.execute(
        "INSERT INTO import_runs (started_at, finished_at, trigger) VALUES (?, ?, 'manual')",
        ("2026-01-01T11:59:00Z", finished.strftime("%Y-%m-%dT%H:%M:%SZ")),
    )
    db.set_setting(conn, "scan_interval_min", "30")
    assert scheduler.next_scan_at(conn) == finished + timedelta(minutes=30)
    db.set_setting(conn, "scan_interval_min", "0")
    assert scheduler.next_scan_at(conn) is None


@pytest.fixture
def client(tmp_path):
    root = tmp_path / "root"
    write(root / "alice" / "s1.fit", make_fit(49, serial=111, created=T0))
    write(root / "alice" / "s2.fit", make_fit(44, serial=111, created=T0 + 3600))
    write(root / "bob" / "s3.fit", make_fit(32, serial=222, created=T0 + 7200))
    db_path = tmp_path / "t.db"
    c = db.connect(db_path)
    db.set_setting(c, "root", str(root))
    importer.scan(c, root)
    importer.run_queue(c, root)
    c.close()
    return TestClient(create_app(db_path)), root


def test_settings_api(client, tmp_path):
    cl, root = client
    s = cl.get("/api/settings").json()
    assert s["root"] == str(root.resolve()) and s["person_mode"] == "folders"

    other = tmp_path / "other"
    other.mkdir()
    r = cl.put(
        "/api/settings",
        json={"root": str(other), "person_mode": "devices", "scan_interval_min": 15},
    )
    assert r.status_code == 200
    assert r.json()["person_mode"] == "devices" and r.json()["scan_interval_min"] == 15
    assert cl.put("/api/settings", json={"root": str(tmp_path / "nope")}).status_code == 400
    assert cl.put("/api/settings", json={"root": "relative/path"}).status_code == 400
    assert cl.put("/api/settings", json={"person_mode": "x"}).status_code == 400
    assert cl.put("/api/settings", json={"scan_interval_min": -1}).status_code == 400


def test_allowed_roots(client, tmp_path, monkeypatch):
    cl, root = client
    monkeypatch.setenv("TRAILBOOK_ALLOWED_ROOTS", str(root))
    outside = tmp_path / "outside"
    outside.mkdir()
    assert cl.put("/api/settings", json={"root": str(outside)}).status_code == 400
    assert cl.put("/api/settings", json={"root": str(root / "alice")}).status_code == 200


def test_devices_and_persons_api(client):
    cl, _ = client
    devices = {d["serial"]: d for d in cl.get("/api/devices").json()}
    assert devices[111]["person_id"] == "alice" and devices[111]["files"] == 2
    created = cl.post("/api/persons", json={"label": "Ewa Nowak"}).json()
    assert created["id"] == "ewa-nowak"
    assert cl.post("/api/persons", json={"label": "Ewa Nowak"}).json()["id"] == "ewa-nowak-2"
    assert cl.post("/api/persons", json={"label": " "}).status_code == 400
    assert cl.patch("/api/devices/111", json={"person_id": "nobody"}).status_code == 400
    assert cl.patch("/api/devices/999", json={"person_id": None}).status_code == 404
    assert cl.patch("/api/devices/111", json={"person_id": "ewa-nowak"}).status_code == 200
    assert {d["serial"]: d["person_id"] for d in cl.get("/api/devices").json()}[111] == "ewa-nowak"


def test_files_sort_and_column_filters(client):
    cl, _ = client
    items = cl.get("/api/import/files?sort=recorded&dir=asc").json()["items"]
    assert [i["fit_type"] for i in items] == ["sleep", "hrv", "monitoring_b"]
    items = cl.get("/api/import/files?sort=recorded&dir=desc").json()["items"]
    assert [i["fit_type"] for i in items] == ["monitoring_b", "hrv", "sleep"]
    assert cl.get("/api/import/files?content=hrv").json()["total"] == 1
    assert cl.get("/api/import/files?file=bob").json()["total"] == 1
    assert cl.get("/api/import/files?person=alice&status=skipped").json()["total"] == 2
    assert cl.get("/api/import/files?fit=sn222").json()["total"] == 1
    assert cl.get("/api/import/files?recorded=2024-11-08").json()["total"] == 3
    assert cl.get("/api/import/files?sort=bogus").status_code == 200  # falls back to default


def test_static_files_are_revalidated(client):
    cl, _ = client
    assert cl.get("/preview.js").headers["cache-control"] == "no-cache"
