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


def _hours_ago(h: float) -> str:
    return garmin._iso(garmin.datetime.now(garmin.UTC) - garmin.timedelta(hours=h))


def test_refused_key_is_retried_every_few_hours_and_recovers(conn, tmp_path):
    fake = FakeGarmin(2)
    uploads = _setup(conn, fake, tmp_path)
    good = fake.key
    fake.key = "z" * 32  # Garmin stops accepting the stored key
    garmin.sync_all(conn, uploads, transport=fake, gap_s=0)
    row = conn.execute("SELECT * FROM garmin_accounts").fetchone()
    assert row["status"] == "auth_error" and row["auth_error_since"] == row["auth_checked_at"]

    # a later refusal keeps the time of the first one
    first = _hours_ago(5)
    conn.execute(
        "UPDATE garmin_accounts SET auth_error_since = ?, auth_checked_at = ?",
        (first, _hours_ago(garmin.AUTH_RETRY_H + 0.1)),
    )
    calls = len(fake.calls)
    garmin.sync_all(conn, uploads, transport=fake, gap_s=0)
    assert fake.calls[calls:] == ["POST " + garmin.TOKEN_PATH]  # one token request only
    row = conn.execute("SELECT * FROM garmin_accounts").fetchone()
    assert row["status"] == "auth_error" and row["auth_error_since"] == first

    # accepted again (e.g. Garmin had a hiccup): downloads resume, the error is gone
    fake.key = good
    conn.execute("UPDATE garmin_accounts SET auth_checked_at = ?", (_hours_ago(4),))
    r = garmin.sync_all(conn, uploads, transport=fake, gap_s=0)
    assert r.downloaded == 2
    row = conn.execute("SELECT * FROM garmin_accounts").fetchone()
    assert row["status"] == "ok" and row["auth_error_since"] is None


def test_banner_after_12_hours(conn, tmp_path):
    fake = FakeGarmin(1)
    _setup(conn, fake, tmp_path)
    garmin._set_status(conn, "anna", "auth_error", "refused")
    assert garmin.key_alerts(conn) == []
    conn.execute("UPDATE garmin_accounts SET auth_error_since = ?", (_hours_ago(13),))
    assert [a["label"] for a in garmin.key_alerts(conn)] == ["Anna"]
    garmin.set_account(conn, "anna", "n" * 32, None)  # a new key clears it
    assert garmin.key_alerts(conn) == []


def test_home_assistant_notification_after_24_hours(conn, tmp_path, monkeypatch):
    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(garmin.homeassistant, "available", lambda: True)
    monkeypatch.setattr(
        garmin.homeassistant, "notify", lambda nid, t, m: sent.append(("notify", nid)) or True
    )
    monkeypatch.setattr(
        garmin.homeassistant, "dismiss", lambda nid: sent.append(("dismiss", nid)) or True
    )
    fake = FakeGarmin(1)
    _setup(conn, fake, tmp_path)
    garmin._set_status(conn, "anna", "auth_error", "refused")
    conn.execute("UPDATE garmin_accounts SET auth_error_since = ?", (_hours_ago(13),))
    garmin.update_ha_notifications(conn)
    assert sent == []
    due = garmin.next_ha_notification_at(conn)
    assert due is not None and abs((due - garmin.datetime.now(garmin.UTC)).total_seconds()
                                   - 11 * 3600) < 60  # fmt: skip

    conn.execute("UPDATE garmin_accounts SET auth_error_since = ?", (_hours_ago(25),))
    garmin.update_ha_notifications(conn)
    garmin.update_ha_notifications(conn)  # only once
    assert sent == [("notify", "trailbook_garmin_key_anna")]
    assert garmin.next_ha_notification_at(conn) is None

    garmin._set_status(conn, "anna", "ok", None)  # fixed: the notification goes away
    garmin.update_ha_notifications(conn)
    assert sent[-1] == ("dismiss", "trailbook_garmin_key_anna")
    assert garmin._notified(conn) == []


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


def test_history_estimate(conn):
    from datetime import UTC, datetime, timedelta

    # Nobody connected: only the typical estimate (5 years, an activity every 3 days).
    est = garmin.history_estimate(conn, 60)
    assert est["typical"]["remaining"] == 608
    assert est["typical"]["runs"] == 11  # 60 per run
    run_s = garmin.RUN_S
    assert est["typical"]["seconds"] == 11 * run_s + 10 * 3600
    assert est["remaining"] == 0 and est["persons"] == {}
    assert garmin.history_estimate(conn, 0)["typical"]["seconds"] is None  # automatic off

    conn.execute("INSERT INTO persons (id, label) VALUES ('anna', 'Anna')")
    garmin.set_account(conn, "anna", "k" * 32, None)
    assert garmin.history_estimate(conn, 60)["persons"]["anna"] == {
        "remaining": 608, "basis": "typical",
    }  # fmt: skip

    # Measured pace: 40 activities over the last 40 days -> one a day, 5 years minus 40 days.
    today = datetime.now(UTC).date()
    for i in range(40):
        day = (today - timedelta(days=40 - i)).isoformat()
        conn.execute(
            """INSERT INTO garmin_activities (person_id, activity_id, start_gmt, status,
                                              fetched_at) VALUES ('anna', ?, ?, 'downloaded', ?)""",
            (i, f"{day} 07:00:00", day),
        )
    p = garmin.history_estimate(conn, 60)["persons"]["anna"]
    assert p["basis"] == "measured" and p["remaining"] == 5 * 365 - 40

    # A Download-from date ends the history earlier; a finished history needs nothing.
    conn.execute(
        "UPDATE garmin_accounts SET history_from = ?",
        ((today - timedelta(days=100)).isoformat(),),
    )
    assert garmin.history_estimate(conn, 60)["persons"]["anna"]["remaining"] == 60
    conn.execute("UPDATE garmin_accounts SET backfill_done = 1")
    assert garmin.history_estimate(conn, 60)["remaining"] == 0


def test_activities_already_here_are_matched_not_downloaded(conn, tmp_path):
    fake = FakeGarmin(3)
    uploads = _setup(conn, fake, tmp_path)
    # one of them came from a folder: same start (40 s off), no title yet
    conn.execute(
        """INSERT INTO activities (person_id, fit_uid, start_time_utc, category, activity_type,
                                   name_overridden, importer_version)
           VALUES ('anna', 'x1', '2026-01-02T07:00:40Z', 'run', 'run', 0, 1)"""
    )
    local = conn.execute("SELECT id FROM activities WHERE fit_uid = 'x1'").fetchone()[0]
    r = garmin.sync_all(conn, uploads, transport=fake, gap_s=0)
    assert r.downloaded == 2 and r.matched == 1
    row = conn.execute(
        "SELECT status, trailbook_id, summary FROM garmin_activities WHERE activity_id = 1001"
    ).fetchone()
    assert row["status"] == "matched" and row["trailbook_id"] == local
    assert json.loads(row["summary"])["activityName"] == "Run 1"
    assert (
        conn.execute("SELECT name FROM activities WHERE id = ?", (local,)).fetchone()[0] == "Run 1"
    )
    assert not any("/download-service/files/activity/1001" in c for c in fake.calls)


def test_strava_copy_does_not_block_the_garmin_download(conn, tmp_path, monkeypatch):
    fake = FakeGarmin(1)
    fake.activities[0]["startTimeGMT"] = "2026-01-01 07:00:00"
    uploads = _setup(conn, fake, tmp_path)
    # a Strava GPX copy of the same run, imported first, with the Strava title
    conn.execute(
        """INSERT INTO activities (person_id, fit_uid, start_time_utc, category, activity_type,
                                   name, name_source, importer_version)
           VALUES ('anna', 'gpx:1767250810:60', '2026-01-01T07:00:10Z', 'run', 'run',
                   'Strava title', 'file', 1)"""
    )
    copy = conn.execute("SELECT id FROM activities").fetchone()[0]
    r = garmin.sync_all(conn, uploads, transport=fake, gap_s=0)
    assert r.downloaded == 1 and r.matched == 0

    parsed = importer.trackfile.parse_gpx(
        b'<gpx><trk><trkseg><trkpt lat="52" lon="21"><time>2026-01-01T07:00:00Z</time></trkpt>'
        b'<trkpt lat="52.001" lon="21"><time>2026-01-01T07:00:30Z</time></trkpt>'
        b"</trkseg></trk></gpx>"
    )
    parsed.fit_uid, parsed.title = "sn42:1", None
    monkeypatch.setattr(importer.fitfile, "parse_activity", lambda _data: parsed)
    importer.run_queue(conn, None, uploads_dir=uploads)
    rows = conn.execute("SELECT id, fit_uid, name, name_source FROM activities").fetchall()
    assert [tuple(r) for r in rows] == [(copy, "sn42:1", "Strava title", "file")]

    # the user clears the name: back to the Garmin Connect title
    conn.execute("UPDATE activities SET name = NULL, name_source = NULL")
    importer.apply_connect_title(conn, copy)
    assert conn.execute("SELECT name FROM activities").fetchone()[0] == "Run 0"
