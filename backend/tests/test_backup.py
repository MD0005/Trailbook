"""Export / restore of a whole install."""

from __future__ import annotations

import json
import sqlite3
import time
import zipfile
from contextlib import closing

import pytest
from conftest import make_fit

from trailbook import backup, cli, db, importer

T0 = 1_100_000_000


def _write(path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


@pytest.fixture
def source(tmp_path):
    """An install with a watched folder, an upload, activities and a Garmin key."""
    data = tmp_path / "a"
    root = tmp_path / "fit"
    _write(root / "alice" / "one.fit", make_fit(49, serial=1, created=T0))
    _write(root / "bob" / "sub" / "two.fit", make_fit(49, serial=2, created=T0 + 60))
    _write(root / "bob" / "notes.txt", b"not exported")
    path = data / "trailbook.db"
    c = db.connect(path)
    db.set_setting(c, "root", str(root))
    importer.scan(c, root)
    upload = data / "uploads" / "alice" / "up.fit"
    _write(upload, make_fit(49, serial=3, created=T0 + 120))
    importer.register_upload(c, data / "uploads", "alice", upload)
    importer.run_queue(c, root, uploads_dir=data / "uploads")
    c.execute(
        """INSERT INTO activities (person_id, fit_uid, start_time_utc, category, activity_type,
                                   importer_version) VALUES ('alice', 'x1', '2026-01-02T08:00:00Z',
                                   'run', 'run', 1)"""
    )
    c.execute(
        "INSERT INTO garmin_accounts (person_id, api_key, token, created_at)"
        " VALUES ('alice', 'secret-key', 'tok', '2026-01-01')"
    )
    db.set_setting(c, "import_progress", json.dumps({"state": "running"}))
    c.close()
    return path, root


def _counts(path):
    with closing(db.connect(path)) as c:
        return (
            c.execute("SELECT COUNT(*) FROM activities").fetchone()[0],
            c.execute("SELECT COUNT(*) FROM files").fetchone()[0],
        )


def test_export_contains_snapshot_files_and_manifest(source, tmp_path):
    path, _ = source
    r = backup.export(path, tmp_path / "out")
    assert r.path.name.startswith("trailbook-export-") and r.files == 3
    with zipfile.ZipFile(r.path) as zf:
        names = set(zf.namelist())
        manifest = json.loads(zf.read("manifest.json"))
        (tmp_path / "snap.db").write_bytes(zf.read("trailbook.db"))
    assert {
        "files/root/alice/one.fit",
        "files/root/bob/sub/two.fit",
        "files/uploads/alice/up.fit",
        "trailbook.db",
    } <= names
    assert not any(n.endswith(".txt") for n in names)
    assert manifest["schema_version"] == db.SCHEMA_VERSION
    assert manifest["counts"]["activities"] == 1 and set(manifest["persons"]) >= {"alice", "bob"}
    assert all("sha256" in e for e in manifest["entries"].values())
    with closing(sqlite3.connect(tmp_path / "snap.db")) as c:
        assert c.execute("SELECT api_key, token FROM garmin_accounts").fetchone() == ("", None)
        assert not c.execute("SELECT 1 FROM settings WHERE key = 'import_progress'").fetchone()
    # the live install keeps its key
    with closing(db.connect(path)) as c:
        assert c.execute("SELECT api_key FROM garmin_accounts").fetchone()[0] == "secret-key"
    # database only + secrets
    small = backup.export(path, tmp_path / "out2", include_files=False, include_secrets=True)
    with zipfile.ZipFile(small.path) as zf:
        assert zf.namelist() == ["trailbook.db", "manifest.json"]
        (tmp_path / "snap2.db").write_bytes(zf.read("trailbook.db"))
    with closing(sqlite3.connect(tmp_path / "snap2.db")) as c:
        assert c.execute("SELECT api_key, token FROM garmin_accounts").fetchone() == (
            "secret-key",
            None,
        )


def test_restore_on_a_fresh_install_matches_the_disk(source, tmp_path):
    path, _ = source
    archive = backup.export(path, tmp_path / "out").path
    new_db = tmp_path / "b" / "trailbook.db"
    db.connect(new_db).close()
    r = backup.restore(new_db, archive)
    assert r.files == 3 and r.activities == 1
    # Folder files of the old install land in the archive, not in a folder.
    uploads = new_db.parent / "uploads"
    assert (uploads / "_folder" / "bob" / "sub" / "two.fit").is_file()
    assert (uploads / "alice" / "up.fit").is_file()
    assert _counts(new_db) == _counts(path)
    with closing(db.connect(new_db)) as c:
        assert db.get_setting(c, "root") == str(source[1])  # the folder exists here: kept
        assert db.get_setting(c, "import_progress") is None
        rows = c.execute("SELECT rel_path FROM files WHERE source_rel IS NOT NULL").fetchall()
        assert {r[0] for r in rows} == {
            "@uploads/_folder/alice/one.fit", "@uploads/_folder/bob/sub/two.fit",
        }  # fmt: skip
        # An empty folder here loses nothing: every file is read from the archive.
        (tmp_path / "empty").mkdir()
        s = importer.scan(c, tmp_path / "empty")
        assert (s.new, s.changed, s.missing) == (0, 0, 0)
    # a second restore needs confirmation
    with pytest.raises(backup.BackupError, match="already has data"):
        backup.restore(new_db, archive)
    backup.restore(new_db, archive, replace=True)


def test_restore_forgets_a_folder_missing_on_this_device(source, tmp_path):
    path, root = source
    archive = backup.export(path, tmp_path / "out").path
    for f in root.rglob("*"):
        if f.is_file():
            f.unlink()
    root.rename(tmp_path / "gone")
    new_db = tmp_path / "b" / "trailbook.db"
    db.connect(new_db).close()
    backup.restore(new_db, archive)
    with closing(db.connect(new_db)) as c:
        assert db.get_setting(c, "root") is None


def test_restore_rejects_bad_archives_before_touching_the_db(source, tmp_path):
    path, _ = source
    archive = backup.export(path, tmp_path / "out").path
    target = tmp_path / "b" / "trailbook.db"
    db.connect(target).close()

    def rewrite(name, change):
        out = tmp_path / name
        with zipfile.ZipFile(archive) as src, zipfile.ZipFile(out, "w") as dst:
            manifest = json.loads(src.read("manifest.json"))
            for item in src.infolist():
                if item.filename != "manifest.json":
                    data = src.read(item.filename)
                    data = change(item.filename, data, manifest) or data
                    dst.writestr(item.filename, data)
            change("manifest.json", b"", manifest)
            dst.writestr("manifest.json", json.dumps(manifest))
        return out

    def newer(name, data, manifest):
        manifest["schema_version"] = db.SCHEMA_VERSION + 1

    def damaged(name, data, manifest):
        if name == "files/uploads/alice/up.fit":
            return b"x" + data[1:]

    def escape(name, data, manifest):
        if name == "manifest.json":
            manifest["entries"]["files/root/../../evil.fit"] = {"size": 1, "sha256": "0"}

    with pytest.raises(backup.BackupError, match="newer"):
        backup.restore(target, rewrite("n.zip", newer))
    with pytest.raises(backup.BackupError, match="checksum"):
        backup.restore(target, rewrite("d.zip", damaged))
    with pytest.raises(backup.BackupError):
        backup.restore(target, rewrite("e.zip", escape))
    assert not (tmp_path / "evil.fit").exists()
    not_export = tmp_path / "x.zip"
    with zipfile.ZipFile(not_export, "w") as zf:
        zf.writestr("a.fit", b"1")
    with pytest.raises(backup.BackupError, match="no manifest"):
        backup.read_manifest(not_export)
    assert _counts(target) == (0, 0)


def test_cli_export_and_restore_write_progress(source, tmp_path):
    path, _ = source
    assert cli.main(["--db", str(path), "export", "-q"]) == 0
    p = backup.read_progress(path, "export")
    assert p["state"] == "finished"
    archive = backup.exports_dir(path) / p["name"]
    new_db = tmp_path / "c" / "trailbook.db"
    args = ["--db", str(new_db), "restore", str(archive), "-q"]
    assert cli.main(args) == 0
    assert backup.read_progress(new_db, "restore")["state"] == "finished"
    assert _counts(new_db)[0] == 1
    assert cli.main(args) == 1  # not empty any more
    assert "already has data" in backup.read_progress(new_db, "restore")["error"]


def _wait_idle(client, timeout=60):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        s = client.get("/api/backup").json()
        if s["running"] is None:
            return s
        time.sleep(0.2)
    raise AssertionError("job did not finish")


def test_backup_api(source, tmp_path):
    from starlette.testclient import TestClient

    from trailbook import api

    path, _ = source
    with TestClient(api.create_app(path)) as client:
        s = _wait_idle(client)  # the scheduler may start a scan right away
        assert s["exports"] == [] and s["empty"] is False
        assert client.post("/api/export", json={"files": False}).status_code == 202
        s = _wait_idle(client)
        assert s["export"]["state"] == "finished"
        name = s["exports"][0]["name"]
        assert s["exports"][0]["manifest"]["include_files"] is False
        r = client.get(f"/api/export/{name}")
        assert r.status_code == 200 and r.content[:2] == b"PK"
        assert client.get("/api/export/..%2Ftrailbook.db").status_code == 404
        # restoring over data needs confirmation; bad uploads are refused up front
        assert client.post(f"/api/restore?name={name}").status_code == 409
        bad = client.post("/api/restore?confirm=1", content=b"not a zip")
        assert bad.status_code == 400
        assert not list(backup.exports_dir(path).glob(".restore-upload-*"))
        # upload the archive back: replaces the database, then scans
        r = client.post("/api/restore?confirm=1", content=r.content)
        assert r.status_code == 202 and r.json()["manifest"]["counts"]["activities"] == 1
        s = _wait_idle(client)
        assert s["restore"]["state"] == "finished", s["restore"]
        assert not list(backup.exports_dir(path).glob(".restore-upload-*"))
        assert client.get("/api/activities").json()["total"] == 1
        assert client.delete(f"/api/export/{name}").json() == {"deleted": True}
        assert client.get("/api/backup").json()["exports"] == []


def test_archived_folder_files_are_exported_once(source, tmp_path):
    path, root = source
    with closing(db.connect(path)) as c:
        assert importer.archive_folder(c, root, path.parent / "uploads") == 2
    r = backup.export(path, tmp_path / "out")
    with zipfile.ZipFile(r.path) as zf:
        names = set(zf.namelist())
    assert "files/uploads/_folder/alice/one.fit" in names
    assert not any(n.startswith("files/root/") for n in names)

    # Restored install: everything is read from the archive, the folder may stay empty.
    new_db = tmp_path / "b" / "trailbook.db"
    db.connect(new_db).close()
    backup.restore(new_db, r.path)
    with closing(db.connect(new_db)) as c:
        (tmp_path / "newroot").mkdir(exist_ok=True)
        s = importer.scan(c, tmp_path / "newroot")
        assert (s.new, s.changed, s.missing) == (0, 0, 0)
        data = importer.read_file_bytes(
            None, "@uploads/_folder/bob/sub/two.fit", "", new_db.parent / "uploads"
        )
        assert data == make_fit(49, serial=2, created=T0 + 60)
