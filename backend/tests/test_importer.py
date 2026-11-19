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


def test_scan_discovers_persons_and_root_files(conn, tmp_path):
    root = tmp_path / "root"
    (root / "alice").mkdir(parents=True)
    (root / "bob" / "2024").mkdir(parents=True)
    (root / "alice" / "a.fit").write_bytes(make_fit(49))
    (root / "bob" / "2024" / "b.FIT").write_bytes(make_fit(32))
    (root / "bob" / "notes.txt").write_text("ignored")
    (root / "stray.fit").write_bytes(make_fit(49))

    result = importer.scan(conn, root)

    assert result.scanned == 3
    assert sorted(result.new_persons) == ["alice", "bob"]
    assert result.ignored == []
    assert statuses(conn) == {
        ("alice/a.fit", ""): "new",
        ("bob/2024/b.FIT", ""): "new",
        ("stray.fit", ""): "new",  # root-level file: person comes from the watch
    }
    owner = conn.execute("SELECT person_id FROM files WHERE rel_path = 'stray.fit'").fetchone()
    assert owner["person_id"] == importer.UNASSIGNED


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
# Real files — only with --samples and when sample-data/ (not in git) is present locally.
# --------------------------------------------------------------------------------------

needs_samples = pytest.mark.samples


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


def test_folder_files_are_archived_and_survive_deletion(conn, tmp_path):
    root = tmp_path / "root"
    uploads = tmp_path / "uploads"
    (root / "alice").mkdir(parents=True)
    src = root / "alice" / "sleep.fit"
    src.write_bytes(make_fit(49))
    os.utime(src, (1_700_000_000, 1_700_000_000))

    importer.scan(conn, root)
    assert importer.archive_folder(conn, root, uploads) == 1
    copy = uploads / importer.FOLDER_ARCHIVE / "alice" / "sleep.fit"
    assert copy.read_bytes() == src.read_bytes()
    assert copy.stat().st_mtime == src.stat().st_mtime  # mtime kept
    row = conn.execute("SELECT rel_path, source_rel FROM files").fetchone()
    assert (row["rel_path"], row["source_rel"]) == (
        "@uploads/_folder/alice/sleep.fit", "alice/sleep.fit",
    )  # fmt: skip
    # Skipped files (sleep, monitoring, …) are archived too, so they can be read later.
    importer.run_queue(conn, root, uploads_dir=uploads)
    assert conn.execute("SELECT status FROM files").fetchone()[0] == "skipped"

    # Nothing to copy again; deleting the file from the folder loses nothing.
    assert importer.archive_folder(conn, root, uploads) == 0
    src.unlink()
    result = importer.scan(conn, root)
    assert result.missing == 0
    assert conn.execute("SELECT status FROM files").fetchone()[0] == "skipped"
    assert importer.forget_file(conn, conn.execute("SELECT id FROM files").fetchone()[0])


def test_changed_folder_file_is_archived_again(conn, tmp_path):
    root = tmp_path / "root"
    uploads = tmp_path / "uploads"
    (root / "alice").mkdir(parents=True)
    src = root / "alice" / "x.fit"
    src.write_bytes(make_fit(49))
    importer.scan(conn, root)
    importer.archive_folder(conn, root, uploads)

    src.write_bytes(make_fit(32))  # now a monitoring file of another size
    os.utime(src, (1_700_000_500, 1_700_000_500))
    result = importer.scan(conn, root)
    assert result.changed == 1
    assert conn.execute("SELECT rel_path FROM files").fetchone()[0] == "alice/x.fit"
    assert importer.archive_folder(conn, root, uploads) == 1
    copy = uploads / importer.FOLDER_ARCHIVE / "alice" / "x.fit"
    assert copy.read_bytes() == make_fit(32)


def test_zip_in_folder_is_archived_once(conn, tmp_path):
    root = tmp_path / "root"
    uploads = tmp_path / "uploads"
    (root / "alice").mkdir(parents=True)
    with zipfile.ZipFile(root / "alice" / "export.zip", "w") as zf:
        zf.writestr("a.fit", make_fit(49))
        zf.writestr("b.fit", make_fit(32))
    importer.scan(conn, root)
    assert importer.archive_folder(conn, root, uploads) == 1
    paths = {r[0] for r in conn.execute("SELECT rel_path FROM files")}
    assert paths == {"@uploads/_folder/alice/export.zip"}
    importer.run_queue(conn, root, uploads_dir=uploads)
    assert {r[0] for r in conn.execute("SELECT status FROM files")} == {"skipped"}


def test_watch_thresholds_from_fit_messages():
    from trailbook import fitfile

    messages = {
        "zones_target_mesgs": [
            {"max_heart_rate": 190, "threshold_heart_rate": 0, "functional_threshold_power": 200}
        ],
        "user_profile_mesgs": [{"resting_heart_rate": 47, "weight": 63.0}],
    }
    assert fitfile.watch_thresholds(messages) == {
        "hr_max": 190, "hr_rest": 47, "lthr": None, "ftp": 200, "weight": 63.0,
    }  # fmt: skip
    # Older files: values only in the session's time_in_zone message.
    tiz = {"time_in_zone_mesgs": [{"reference_mesg": "session", "max_heart_rate": 188}]}
    assert fitfile.watch_thresholds(tiz)["hr_max"] == 188


def test_connect_title_names_the_activity(conn):
    conn.execute("INSERT INTO persons (id, label) VALUES ('anna', 'Anna')")

    def activity(uid, name=None, overridden=0):
        return conn.execute(
            """INSERT INTO activities (person_id, fit_uid, start_time_utc, category,
                   activity_type, name, name_overridden, importer_version)
               VALUES ('anna', ?, '2026-01-01T07:00:00Z', 'run', 'run', ?, ?, 1)""",
            (uid, name, overridden),
        ).lastrowid

    def file(rel, activity_id):
        return conn.execute(
            """INSERT INTO files (person_id, rel_path, size, mtime, status, activity_id,
                   first_seen, last_seen)
               VALUES ('anna', ?, 1, 0, 'imported', ?, 'x', 'x')""",
            (rel, activity_id),
        ).lastrowid

    def title(rel, name, aid):
        conn.execute(
            """INSERT INTO garmin_activities (person_id, activity_id, name, status, file_rel,
                   fetched_at) VALUES ('anna', ?, ?, 'downloaded', ?, 'x')""",
            (aid, name, rel),
        )

    plain = activity("u1")  # from a folder: no title, the UI shows the type
    importer.apply_connect_name(conn, file("anna/a.fit", plain))
    renamed = activity("u2")  # later delivered by Garmin: the title replaces the empty name
    title("@uploads/anna/garmin-2.zip", "Morning Run", 2)
    importer.apply_connect_name(conn, file("@uploads/anna/garmin-2.zip", renamed))
    kept = activity("u3", "My name", overridden=1)  # the user's own name stays
    title("@uploads/anna/garmin-3.zip", "Connect title", 3)
    importer.apply_connect_name(conn, file("@uploads/anna/garmin-3.zip", kept))

    names = dict(conn.execute("SELECT id, name FROM activities").fetchall())
    assert names == {plain: None, renamed: "Morning Run", kept: "My name"}


def test_workout_targets_are_read_per_step():
    from trailbook.fitfile import workout_targets

    steps = [
        {"message_index": 0, "target_type": "power_lap", "custom_target_value_low": 149,
         "custom_target_value_high": 202},
        {"message_index": 1, "target_type": "power", "custom_target_value_low": 1250,
         "custom_target_value_high": 1300},
        {"message_index": 2, "target_type": "heart_rate", "custom_target_value_low": 134,
         "custom_target_value_high": 152},
        {"message_index": 3, "target_type": "heart_rate", "custom_target_value_low": 70,
         "custom_target_value_high": 80},
        {"message_index": 4, "target_type": "speed", "custom_target_value_low": 2758,
         "custom_target_value_high": 2856, "custom_target_speed_low": 2.758,
         "custom_target_speed_high": 2.856},
        {"message_index": 5, "target_type": "cadence", "custom_target_value_low": 85,
         "custom_target_value_high": 90},
        {"message_index": 6, "target_type": "open"},
        {"message_index": 7, "target_type": "heart_rate", "target_value": 3},
    ]  # fmt: skip
    msgs = {"workout_step_mesgs": steps, "zones_target_mesgs": [{"max_heart_rate": 200}]}
    t = workout_targets(msgs, on_foot=True)
    assert t[0] == ("power", 149, 202)
    assert t[1] == ("power", 250, 300)
    assert t[2] == ("hr", 134, 152)
    assert t[3] == ("hr", 140, 160)
    assert t[4] == ("speed", 2.758, 2.856)
    assert t[5] == ("cadence", 170, 180)
    assert 6 not in t and 7 not in t


def test_time_in_zones_from_the_session():
    import json

    from trailbook.fitfile import time_in_zones

    msgs = {"time_in_zone_mesgs": [
        {"reference_mesg": "session", "time_in_hr_zone": [10.0, 20.0, 30.0, 0, 0, 0, 0],
         "hr_zone_high_boundary": [95, 112, 131, 151, 168, 187],
         "time_in_power_zone": [5.0, 6.0, 0, 0, 0, 0, 0],
         "power_zone_high_boundary": [200, 250, 300, 350, 400, 4000, None]},
        {"reference_mesg": "lap", "time_in_hr_zone": [99.0]},
    ]}  # fmt: skip
    z = json.loads(time_in_zones(msgs))
    assert z["hr"] == {"times": [10, 20, 30, 0, 0, 0, 0], "bounds": [95, 112, 131, 151, 168, 187]}
    assert z["power"]["bounds"] == [200, 250, 300, 350, 400, 4000]
    assert time_in_zones({}) is None


def test_device_names_are_readable():
    from trailbook.fitfile import device_name

    assert device_name("garmin", "fr965") == "Forerunner 965"
    assert device_name("garmin", "edge_850") == "Edge 850"
    assert device_name("garmin", "venu3s") == "Venu 3S"
    assert device_name("garmin", "hrm_dual") == "HRM-Dual"
    assert device_name("favero_electronics", "assioma_uno") == "Assioma Uno"
    assert device_name("garmin", 3592) is None
