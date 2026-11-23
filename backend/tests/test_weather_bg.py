"""Weather in the background: which activity is next, and the cooldown of a failing server."""

from __future__ import annotations

import json

from trailbook import db
from trailbook import weather as wx


def _act(c, uid, start, gps=1, indoor=0, typ="ride", weather=None):
    c.execute(
        """INSERT INTO activities (person_id, fit_uid, start_time_utc, utc_offset_s, category,
                                   activity_type, has_gps, indoor, weather, importer_version)
           VALUES ('anna', ?, ?, 0, 'ride', ?, ?, ?, ?, 1)""",
        (uid, start, typ, gps, indoor, weather),
    )


def test_next_missing_is_the_newest_outdoors(tmp_path, monkeypatch):
    monkeypatch.undo()  # conftest turns next_missing off for the app; here it is the subject
    c = db.connect(tmp_path / "t.db")
    c.execute("INSERT INTO persons (id, label) VALUES ('anna', 'Anna')")
    _act(c, "a", "2026-01-01T08:00:00Z")
    _act(
        c,
        "b",
        "2026-02-01T08:00:00Z",
        weather=json.dumps({"version": wx.WEATHER_VERSION, "points": 1}),
    )
    _act(c, "c", "2026-03-01T08:00:00Z", indoor=1)
    _act(c, "d", "2026-04-01T08:00:00Z", typ="virtual_ride")
    _act(c, "e", "2026-05-01T08:00:00Z", gps=0)
    _act(c, "f", "2026-06-01T08:00:00Z", weather=json.dumps({"version": 0}))
    newest = c.execute("SELECT id FROM activities WHERE fit_uid = 'f'").fetchone()[0]
    assert wx.next_missing(c) == newest  # an older kind of weather counts as missing
    c.execute("UPDATE activities SET weather = NULL WHERE fit_uid = 'b'")
    c.execute("DELETE FROM activities WHERE fit_uid = 'f'")
    b = c.execute("SELECT id FROM activities WHERE fit_uid = 'b'").fetchone()[0]
    assert wx.next_missing(c) == b  # indoor, virtual and no route are skipped


def test_failing_server_cools_down():
    wx._cool.update(until=0.0, fails=0)
    assert wx._failed(now=0) == wx.COOLDOWN_S
    assert wx._failed(now=0) == 2 * wx.COOLDOWN_S
    assert wx.cooldown_left(now=0) == 2 * wx.COOLDOWN_S
    wx._answered()  # one step back
    assert wx.cooldown_left() == 0 and wx._cool["fails"] == 1
    wx._cool.update(until=0.0, fails=0)
