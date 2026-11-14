"""Garmin Connect personal API sync, against a fake Garmin server (no network)."""

from __future__ import annotations

import io
import json
import urllib.parse
import zipfile

from conftest import make_fit

from trailbook import garmin, importer


class FakeGarmin:
    def __init__(self, n: int, key: str = "k" * 32):
        # newest first, like Garmin's default sort
        self.activities = [
            {
                "activityId": 1000 + i,
                "activityName": f"Run {i}",
                "startTimeGMT": f"2026-01-{1 + i % 28:02d} 07:00:00",
                "activityType": {"typeKey": "running"},
            }
            for i in reversed(range(n))
        ]
        self.key = key
        self.calls: list[str] = []
        self.tokens = 0
        self.fail_download: dict[int, int] = {}

    def zip_for(self, activity_id: int) -> bytes:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            fit = make_fit(4, serial=42, created=1_100_000_000 + activity_id)
            zf.writestr(f"{activity_id}_ACTIVITY.fit", fit)
        return buf.getvalue()

    def __call__(self, method, url, headers, timeout):
        parsed = urllib.parse.urlparse(url)
        self.calls.append(f"{method} {parsed.path}")
        if parsed.path == garmin.TOKEN_PATH:
            if headers.get("Authorization") != f"ApiKey {self.key}":
                return 401, {}, b"unauthorized"
            self.tokens += 1
            body = {"access_token": f"tok{self.tokens}", "expires_in": 86400}
            return 200, {}, json.dumps(body).encode()
        if not headers.get("Authorization", "").startswith("Bearer tok"):
            return 401, {}, b""
        if parsed.path == garmin.SEARCH_PATH:
            q = urllib.parse.parse_qs(parsed.query)
            start, limit = int(q["start"][0]), int(q["limit"][0])
            return 200, {}, json.dumps(self.activities[start : start + limit]).encode()
        if parsed.path.startswith("/download-service/files/activity/"):
            aid = int(parsed.path.rsplit("/", 1)[1])
            if aid in self.fail_download:
                return self.fail_download[aid], {}, b"nope"
            return 200, {}, self.zip_for(aid)
        return 404, {}, b""


def _setup(conn, fake, tmp_path, person="anna"):
    conn.execute("INSERT INTO persons (id, label) VALUES (?, ?)", (person, person.title()))
    garmin.set_account(conn, person, fake.key, None)
    return tmp_path / "uploads"


def _downloads(conn, person="anna"):
    return conn.execute(
        "SELECT COUNT(*) FROM garmin_activities WHERE person_id = ? AND status = 'downloaded'",
        (person,),
    ).fetchone()[0]


def test_history_is_filled_over_several_runs_without_duplicates(conn, tmp_path):
    fake = FakeGarmin(120)
    uploads = _setup(conn, fake, tmp_path)

    r1 = garmin.sync_all(conn, uploads, max_downloads=50, transport=fake, gap_s=0)
    assert r1.downloaded == 50 and r1.stopped is None
    r2 = garmin.sync_all(conn, uploads, max_downloads=50, transport=fake, gap_s=0)
    r3 = garmin.sync_all(conn, uploads, max_downloads=50, transport=fake, gap_s=0)
    assert (r2.downloaded, r3.downloaded) == (50, 20)
    assert _downloads(conn) == 120
    acc = garmin.accounts(conn)["anna"]
    assert acc["backfill_done"] and acc["status"] == "ok" and acc["downloaded"] == 120
    assert "api_key" not in acc and "token" not in acc

    # one token for all runs (stored and reused while valid)
    assert fake.tokens == 1

    # files are queued for the normal importer, stored as uploads of that person
    rows = conn.execute("SELECT person_id, rel_path, zip_member FROM files").fetchall()
    assert len(rows) == 120
    assert all(r["person_id"] == "anna" for r in rows)
    assert all(r["rel_path"].startswith("@uploads/anna/garmin-") for r in rows)

    # a new activity on Garmin: the next run fetches only that one
    fake.activities.insert(0, {"activityId": 5000, "activityName": "New", "startTimeGMT": None})
    downloads_before = sum(c.startswith("GET /download") for c in fake.calls)
    r4 = garmin.sync_all(conn, uploads, transport=fake, gap_s=0)
    assert r4.downloaded == 1
    assert sum(c.startswith("GET /download") for c in fake.calls) == downloads_before + 1


def test_downloaded_files_import_and_dedupe_by_fit_id(conn, tmp_path):
    fake = FakeGarmin(3)
    uploads = _setup(conn, fake, tmp_path)
    garmin.sync_all(conn, uploads, transport=fake, gap_s=0)
    importer.run_queue(conn, None, uploads_dir=uploads)
    first = conn.execute("SELECT status, COUNT(*) n FROM files GROUP BY status").fetchall()
    assert sum(r["n"] for r in first) == 3
    assert all(r["status"] != "new" for r in first)

    # the same activity arriving again (e.g. a re-connected key) is not imported twice
    garmin.set_account(conn, "anna", fake.key, None)
    conn.execute("DELETE FROM garmin_activities")
    garmin.sync_all(conn, uploads, transport=fake, gap_s=0)
    importer.run_queue(conn, None, uploads_dir=uploads)
    imported = conn.execute("SELECT COUNT(*) FROM activities").fetchone()[0]
    assert imported <= 3


def test_wrong_key_marks_account_and_is_skipped(conn, tmp_path):
    fake = FakeGarmin(5)
    uploads = _setup(conn, fake, tmp_path)
    garmin.set_account(conn, "anna", "x" * 32, None)
    r = garmin.sync_all(conn, uploads, transport=fake, gap_s=0)
    assert r.downloaded == 0
    acc = garmin.accounts(conn)["anna"]
    assert acc["status"] == "auth_error" and "refused" in acc["last_error"]
    # next run does not hammer Garmin with the refused key
    calls = len(fake.calls)
    garmin.sync_all(conn, uploads, transport=fake, gap_s=0)
    assert len(fake.calls) == calls


def test_rate_limit_stops_the_whole_run(conn, tmp_path):
    fake = FakeGarmin(10)
    uploads = _setup(conn, fake, tmp_path)
    conn.execute("INSERT INTO persons (id, label) VALUES ('ben', 'Ben')")
    garmin.set_account(conn, "ben", fake.key, None)
    fake.fail_download[1007] = 429  # third download for the first person
    r = garmin.sync_all(conn, uploads, transport=fake, gap_s=0)
    assert r.stopped and "slow down" in r.stopped
    assert r.downloaded == 2
    assert r.persons == ["anna"]  # ben is not tried in this run
    # next run continues where it stopped
    del fake.fail_download[1007]
    r2 = garmin.sync_all(conn, uploads, transport=fake, gap_s=0)
    assert _downloads(conn, "anna") == 10 and _downloads(conn, "ben") == 10
    assert r2.stopped is None


def test_single_bad_activity_does_not_block_others(conn, tmp_path):
    fake = FakeGarmin(4)
    uploads = _setup(conn, fake, tmp_path)
    fake.fail_download[1002] = 404
    r = garmin.sync_all(conn, uploads, transport=fake, gap_s=0)
    assert r.downloaded == 3 and r.errors == 1
    assert garmin.accounts(conn)["anna"]["failed"] == 1


def test_token_response_formats():
    assert garmin._parse_token(b'{"access_token": "a", "expires_in": 3600}') == ("a", 3300)
    assert garmin._parse_token(b'{"accessToken": "b"}')[0] == "b"
    assert garmin._parse_token(b"plain-token")[0] == "plain-token"


def test_api_garmin_accounts(tmp_path, monkeypatch):
    from starlette.testclient import TestClient

    from trailbook import api, db

    fake = FakeGarmin(2)
    monkeypatch.setattr(garmin, "urllib_transport", fake)
    monkeypatch.setattr(garmin, "REQUEST_GAP_S", 0)
    path = tmp_path / "t.db"
    with db.connect(path) as c:
        c.execute("INSERT INTO persons (id, label) VALUES ('anna', 'Anna')")
    with TestClient(api.create_app(path)) as client:
        assert client.put("/api/garmin/anna", json={"api_key": "short"}).status_code == 400
        r = client.put("/api/garmin/anna", json={"api_key": fake.key, "history_from": "2025-01-01"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] and body["latest"]["name"] == "Run 1"
        assert body["account"]["key_hint"] == "…kkkk"
        listed = client.get("/api/garmin").json()["accounts"]["anna"]
        assert listed["history_from"] == "2025-01-01" and "api_key" not in listed
        bad = client.put("/api/garmin/anna", json={"api_key": "y" * 32}).json()
        assert not bad["ok"] and bad["account"]["status"] == "auth_error"
        assert client.delete("/api/garmin/anna").status_code == 200
        assert client.get("/api/garmin").json()["accounts"] == {}


def test_type_counts_per_person(tmp_path):
    from starlette.testclient import TestClient

    from trailbook import api, db

    path = tmp_path / "t.db"
    with db.connect(path) as c:
        c.execute("INSERT INTO persons (id, label) VALUES ('anna', 'Anna'), ('ben', 'Ben')")
        rows = [("anna", "run"), ("anna", "run"), ("anna", "yoga"), ("ben", "walk")]
        for i, (pid, t) in enumerate(rows):
            c.execute(
                "INSERT INTO activities (person_id, fit_uid, start_time_utc, category,"
                " activity_type, importer_version)"
                " VALUES (?, ?, '2026-01-01T00:00:00Z', 'x', ?, 1)",
                (pid, f"uid{i}", t),
            )
    with TestClient(api.create_app(path)) as client:
        assert client.get("/api/types/counts?person=anna").json() == {"run": 2, "yoga": 1}
        assert client.get("/api/types/counts").json() == {"run": 2, "yoga": 1, "walk": 1}
