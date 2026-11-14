import os
import shutil
import zipfile

import pytest
from conftest import SAMPLE_DATA, make_fit

from trailbook import importer


def statuses(conn):
    return {
        (r["rel_path"], r["zip_member"]): r["status"]
        for r in conn.execute("SELECT rel_path, zip_member, status FROM files")
    }


def test_scan_discovers_persons_and_ignores_root_files(conn, tmp_path):
    root = tmp_path / "root"
    (root / "alice").mkdir(parents=True)
    (root / "bob" / "2024").mkdir(parents=True)
    (root / "alice" / "a.fit").write_bytes(make_fit(49))
    (root / "bob" / "2024" / "b.FIT").write_bytes(make_fit(32))
    (root / "bob" / "notes.txt").write_text("ignored")
    (root / "stray.fit").write_bytes(make_fit(49))

    result = importer.scan(conn, root)

    assert result.scanned == 2
    assert sorted(result.new_persons) == ["alice", "bob"]
    assert result.ignored == ["stray.fit"]
    assert statuses(conn) == {("alice/a.fit", ""): "new", ("bob/2024/b.FIT", ""): "new"}


def test_non_activity_files_are_skipped_with_reason(conn, tmp_path):
    root = tmp_path / "root"
    (root / "alice").mkdir(parents=True)
    (root / "alice" / "sleep.fit").write_bytes(make_fit(49))
    (root / "alice" / "garbage.fit").write_bytes(b"hello")

    importer.scan(conn, root)
    result = importer.run_queue(conn, root)

    assert result.skipped == 2
    reasons = dict(conn.execute("SELECT rel_path, skip_reason FROM files").fetchall())
    assert reasons == {"alice/sleep.fit": "sleep", "alice/garbage.fit": "not a FIT file"}


def test_same_bytes_under_another_name_reuse_outcome(conn, tmp_path):
    root = tmp_path / "root"
    (root / "alice").mkdir(parents=True)
    (root / "alice" / "one.fit").write_bytes(make_fit(49))
    importer.scan(conn, root)
    importer.run_queue(conn, root)

    (root / "alice" / "copy.fit").write_bytes(make_fit(49))
    importer.scan(conn, root)
    importer.run_queue(conn, root)

    row = conn.execute(
        "SELECT status, skip_reason FROM files WHERE rel_path = ?", ("alice/copy.fit",)
    ).fetchone()
    assert (row["status"], row["skip_reason"]) == ("skipped", "sleep")


def test_missing_file_is_flagged_and_restored(conn, tmp_path):
    root = tmp_path / "root"
    (root / "alice").mkdir(parents=True)
    f = root / "alice" / "s.fit"
    f.write_bytes(make_fit(49))
    importer.scan(conn, root)
    importer.run_queue(conn, root)

    moved = tmp_path / "s.fit"
    shutil.move(f, moved)
    assert importer.scan(conn, root).missing == 1
    assert statuses(conn)[("alice/s.fit", "")] == "missing"
    # A second scan does not count it again.
    assert importer.scan(conn, root).missing == 0

    shutil.move(moved, f)
    result = importer.scan(conn, root)
    assert result.returned == 1
    assert statuses(conn)[("alice/s.fit", "")] == "skipped"


def test_changed_file_is_requeued(conn, tmp_path):
    root = tmp_path / "root"
    (root / "alice").mkdir(parents=True)
    f = root / "alice" / "s.fit"
    f.write_bytes(make_fit(49))
    importer.scan(conn, root)
    importer.run_queue(conn, root)

    f.write_bytes(make_fit(49, extra=b"\x00\x00"))
    os.utime(f, (1_800_000_000, 1_800_000_000))
    assert importer.scan(conn, root).changed == 1
    assert statuses(conn)[("alice/s.fit", "")] == "new"


def test_zip_members_are_tracked(conn, tmp_path):
    root = tmp_path / "root"
    (root / "alice").mkdir(parents=True)
    with zipfile.ZipFile(root / "alice" / "export.zip", "w") as zf:
        zf.writestr("DI_CONNECT/a.fit", make_fit(49))
        zf.writestr("DI_CONNECT/b.fit", make_fit(32))
        zf.writestr("readme.txt", "x")

    importer.scan(conn, root)
    result = importer.run_queue(conn, root)

    assert result.skipped == 2
    assert set(statuses(conn)) == {
        ("alice/export.zip", "DI_CONNECT/a.fit"),
        ("alice/export.zip", "DI_CONNECT/b.fit"),
    }


# --------------------------------------------------------------------------------------
# Real files — runs only when sample-data/ (not in git) is present locally.
# --------------------------------------------------------------------------------------

needs_samples = pytest.mark.skipif(
    not SAMPLE_DATA.is_dir() or not any(SAMPLE_DATA.rglob("*.fit")),
    reason="no local sample-data",
)


@needs_samples
def test_sample_data_end_to_end(conn, tmp_path):
    root = tmp_path / "root"
    shutil.copytree(SAMPLE_DATA, root)

    importer.scan(conn, root)
    result = importer.run_queue(conn, root)
    assert result.errors == 0
    assert result.imported > 0

    activities = conn.execute("SELECT * FROM activities").fetchall()
    assert len(activities) == result.imported
    for a in activities:
        assert a["start_time_utc"].endswith("Z")
        assert a["elapsed_s"] and a["elapsed_s"] > 0
        if a["has_gps"]:
            track = conn.execute(
                "SELECT point_count FROM tracks WHERE activity_id = ?", (a["id"],)
            ).fetchone()
            assert track["point_count"] >= 2

    # Re-importing the same folder changes nothing.
    assert importer.scan(conn, root).new == 0
    assert importer.run_queue(conn, root).imported == 0

    # A file that disappears keeps its activity until the user deletes it.
    row = conn.execute(
        "SELECT id, rel_path, activity_id FROM files WHERE status = 'imported' LIMIT 1"
    ).fetchone()
    (root / row["rel_path"]).unlink()
    importer.scan(conn, root)
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM activities WHERE id = ?", (row["activity_id"],)
        ).fetchone()[0]
        == 1
    )

    assert importer.delete_activity(conn, row["activity_id"])
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM streams WHERE activity_id = ?", (row["activity_id"],)
        ).fetchone()[0]
        == 0
    )


@needs_samples
def test_type_override_survives_reprocess(conn, tmp_path):
    root = tmp_path / "root"
    shutil.copytree(SAMPLE_DATA, root)
    importer.scan(conn, root)
    importer.run_queue(conn, root)

    a = conn.execute("SELECT id FROM activities ORDER BY id LIMIT 1").fetchone()
    importer.set_activity_type(conn, a["id"], "hike")
    queued = importer.requeue_outdated(conn, everything=True)
    assert queued > 0
    assert importer.run_queue(conn, root).imported == queued

    row = conn.execute(
        "SELECT category, activity_type FROM activities WHERE id = ?", (a["id"],)
    ).fetchone()
    assert (row["category"], row["activity_type"]) == ("hike", "hike")


def test_skipped_files_keep_fit_id(conn, tmp_path):
    root = tmp_path / "root"
    (root / "alice").mkdir(parents=True)
    (root / "alice" / "s.fit").write_bytes(make_fit(49, serial=42, created=1_100_000_000))
    importer.scan(conn, root)
    importer.run_queue(conn, root)
    row = conn.execute("SELECT fit_uid, fit_type, fit_created, imported_at FROM files").fetchone()
    assert row["fit_uid"].startswith("sn42:")
    assert row["fit_type"] == "sleep"
    assert row["fit_created"] == "2024-11-08T11:33:20Z"
    assert row["imported_at"]


def test_forget_skipped_file_reprocesses_it(conn, tmp_path):
    root = tmp_path / "root"
    (root / "alice").mkdir(parents=True)
    (root / "alice" / "s.fit").write_bytes(make_fit(49))
    importer.scan(conn, root)
    importer.run_queue(conn, root)
    file_id = conn.execute("SELECT id FROM files").fetchone()["id"]

    assert importer.forget_file(conn, file_id)
    assert conn.execute("SELECT COUNT(*) FROM files").fetchone()[0] == 0
    assert importer.scan(conn, root).new == 1
    assert importer.run_queue(conn, root).skipped == 1
    assert not importer.forget_file(conn, 9999)


def test_repeat_scan_writes_nothing(conn, tmp_path):
    root = tmp_path / "root"
    (root / "alice").mkdir(parents=True)
    (root / "alice" / "s.fit").write_bytes(make_fit(49))
    importer.scan(conn, root)
    importer.run_queue(conn, root)
    before = conn.total_changes
    importer.scan(conn, root)
    assert conn.total_changes == before


@needs_samples
def test_delete_activity_marks_removed_and_forget_reimports(conn, tmp_path):
    root = tmp_path / "root"
    shutil.copytree(SAMPLE_DATA, root)
    importer.scan(conn, root)
    importer.run_queue(conn, root)
    f = conn.execute(
        "SELECT id, activity_id, fit_uid FROM files WHERE status = 'imported' LIMIT 1"
    ).fetchone()
    assert f["fit_uid"]
    count = conn.execute("SELECT COUNT(*) FROM activities").fetchone()[0]

    # Deleting the activity: the file is 'removed' and is not imported again by a scan.
    importer.delete_activity(conn, f["activity_id"])
    assert conn.execute("SELECT status FROM files WHERE id = ?", (f["id"],)).fetchone()[0] == (
        "removed"
    )
    importer.scan(conn, root)
    assert importer.run_queue(conn, root).imported == 0

    # Removing the file from the history: the next scan imports it again.
    importer.forget_file(conn, f["id"])
    importer.scan(conn, root)
    assert importer.run_queue(conn, root).imported == 1
    assert conn.execute("SELECT COUNT(*) FROM activities").fetchone()[0] == count


@needs_samples
def test_forget_imported_file_rebuilds_activity(conn, tmp_path):
    root = tmp_path / "root"
    shutil.copytree(SAMPLE_DATA, root)
    importer.scan(conn, root)
    importer.run_queue(conn, root)
    f = conn.execute(
        "SELECT id, activity_id, fit_uid FROM files WHERE status = 'imported' LIMIT 1"
    ).fetchone()

    importer.forget_file(conn, f["id"])
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM activities WHERE id = ?", (f["activity_id"],)
        ).fetchone()[0]
        == 0
    )
    importer.scan(conn, root)
    assert importer.run_queue(conn, root).imported == 1
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM activities WHERE fit_uid = ?", (f["fit_uid"],)
        ).fetchone()[0]
        == 1
    )
