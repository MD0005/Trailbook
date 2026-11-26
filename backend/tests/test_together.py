"""Activities two people did together, on synthetic tracks, and the Together API."""

from __future__ import annotations

import pytest
from starlette.testclient import TestClient
from test_segments import M_LAT, pt
from test_segments import path as track

from trailbook import db, geo, streams, together
from trailbook.api import create_app

START = together.epoch("2026-10-01T08:00:00Z")


def route(*legs, start_s=0, **kw):
    time, lat, lon = track(*legs, **kw)
    return together.route(time, lat, lon, START + start_s)


def compare(a, b, radius=50):
    return together.compare(a, b, radius, a.first_t, b.first_t)


def test_route_is_sampled_evenly_with_times():
    r = route((0, 0), (1000, 0), speed=5)
    assert len(r) == 51  # 1 km every 20 m
    assert r.t[10] - r.t[0] == pytest.approx(40, abs=0.5)
    assert all(r.link[1:]) and not r.link[0]


def test_running_side_by_side_is_together_all_the_way():
    s = compare(route((0, 0), (2000, 0), speed=3), route((0, 30), (2000, 30), speed=3))
    assert s.share == pytest.approx(1, abs=0.01)
    assert s.together_m == pytest.approx(2000, abs=25)
    assert s.meet_t == START


def test_radius_decides():
    a, b = route((0, 0), (2000, 0)), route((0, 70), (2000, 70))
    assert compare(a, b, radius=50) is None
    assert compare(a, b, radius=100).share == pytest.approx(1, abs=0.01)


def test_up_to_five_minutes_apart_counts():
    a = route((0, 0), (2000, 0))
    assert compare(a, route((0, 0), (2000, 0), start_s=240)).share > 0.98
    assert compare(a, route((0, 0), (2000, 0), start_s=360)) is None


def test_passing_each_other_does_not_count():
    assert compare(route((0, 0), (3000, 0)), route((3000, 0), (0, 0))) is None


def test_part_of_the_route_gives_its_share_and_the_meeting_time():
    # b joins at 1 km: a long way east, then north with a
    a = route((0, 0), (4000, 0), speed=4)
    b = route((1000, 1000), (1000, 0), (3000, 0), (3000, 2000), speed=4)
    s = compare(a, b)
    # a is the shorter route (4 km against 5 km); 2 km of it were shared
    assert s.share == pytest.approx(0.5, abs=0.04)
    assert s.together_m == pytest.approx(2000, abs=150)
    assert s.meet_t - START == pytest.approx(240, abs=20)  # both are at 1 km after ~4 min
    assert len(s.runs_a) == 1 and len(s.runs_b) == 1
    # b's line follows a's line where they are together
    on_line = [p for p in geo.decode_polyline(s.line_b) if abs(p[1] - pt(0, 0)[1]) < 1e-5]
    assert max(p[0] for p in on_line) - min(p[0] for p in on_line) > 1800 * M_LAT


def test_short_gaps_are_filled_and_short_stretches_dropped():
    link = [False] + [True] * 29
    flags = [True] * 10 + [False] * 3 + [True] * 10 + [False] * 7
    assert together._smooth(flags, link) == [True] * 23 + [False] * 7
    assert together._smooth([True] * 3 + [False] * 27, link) == [False] * 30


def _store(c, pid, start, points, atype="run", name=None):
    """An activity with its streams, starting at `start` (UTC)."""
    time, lat, lon = points
    cur = c.execute(
        """INSERT INTO activities (person_id, fit_uid, start_time_utc, utc_offset_s, category,
               activity_type, name, elapsed_s, time_s, distance_m, avg_hr, ascent_m, has_gps,
               bbox_min_lat, bbox_min_lon, bbox_max_lat, bbox_max_lon, importer_version)
           VALUES (?, ?, ?, 3600, 'run', ?, ?, ?, ?, 2000, ?, 10, 1, ?, ?, ?, ?, 1)""",
        (pid, f"{pid}-{start}", start, atype, name, time[-1], time[-1],
         150 if pid == "anna" else 130, min(lat), min(lon), max(lat), max(lon)),
    )  # fmt: skip
    for channel, values in (("time", time), ("lat", lat), ("lon", lon)):
        enc, blob = streams.encode(values, "f64")
        c.execute(
            "INSERT INTO streams (activity_id, channel, encoding, length, data) VALUES (?,?,?,?,?)",
            (cur.lastrowid, channel, enc, len(values), blob),
        )
    return cur.lastrowid


@pytest.fixture
def tdb(tmp_path):
    path = tmp_path / "t.db"
    c = db.connect(path)
    c.execute("INSERT INTO persons (id, label) VALUES ('anna', 'Anna'), ('ben', 'Ben')")
    north = track((0, 0), (2000, 0), speed=3)
    ids = {
        # together on two days
        "a1": _store(c, "anna", "2026-10-01T08:00:00Z", north, name="Park"),
        "b1": _store(c, "ben", "2026-10-01T08:01:00Z", north),
        "a2": _store(c, "anna", "2026-10-05T08:00:00Z", north),
        "b2": _store(c, "ben", "2026-10-05T08:00:00Z", north, atype="trail_run"),
        # the same route, another time of day
        "a3": _store(c, "anna", "2026-10-07T08:00:00Z", north),
        "b3": _store(c, "ben", "2026-10-07T18:00:00Z", north),
    }
    yield path, c, ids
    c.close()


def test_find_caches_and_notices_changes(tdb, monkeypatch):
    _, c, ids = tdb
    found = together.find(c, "anna", "ben", 50)
    assert [(a, b) for a, b, _ in found] == [(ids["a1"], ids["b1"]), (ids["a2"], ids["b2"])]
    assert c.execute("SELECT COUNT(*) FROM together_cache").fetchone()[0] == 2
    # from the cache: nothing is compared again
    monkeypatch.setattr(together, "compare", lambda *a: pytest.fail("compared again"))
    again = together.find(c, "anna", "ben", 50)
    assert [r.share for *_, r in again] == [r.share for *_, r in found]
    monkeypatch.undo()
    # a changed activity is compared again
    c.execute("UPDATE activities SET fixes = '[\"speed\"]' WHERE id = ?", (ids["a1"],))
    seen = []
    real = together.compare
    monkeypatch.setattr(together, "compare", lambda *a: seen.append(1) or real(*a))
    together.find(c, "anna", "ben", 50)
    assert len(seen) == 1
    # deleted activities leave the cache
    c.execute("DELETE FROM activities WHERE id = ?", (ids["a1"],))
    assert c.execute("SELECT COUNT(*) FROM together_cache").fetchone()[0] == 1


def test_api(tdb):
    path, _, ids = tdb
    client = TestClient(create_app(path))
    d = client.get("/api/together?person=anna,ben&track=1").json()
    assert d["total"] == 2
    assert [i["a"]["id"] for i in d["items"]] == [ids["a2"], ids["a1"]]  # newest first
    assert d["items"][0]["b"]["person_id"] == "ben" and len(d["items"][0]["lines"]) == 2
    t = d["totals"]
    assert t["count"] == 2 and t["active_days"] == 2 and t["longest_day"] in (t["first"], t["last"])
    assert t["together_m"] == pytest.approx(4000, abs=300)
    assert [p["avg_hr"] for p in t["people"]] == [150, 130]
    assert [p["distance_m"] for p in t["people"]] == [4000, 4000]
    assert d["type_counts"] == {"run": 2, "trail_run": 1}
    first = "/api/together?person=anna,ben&sort=date&dir=asc"
    assert [i["a"]["id"] for i in client.get(first).json()["items"]] == [ids["a1"], ids["a2"]]
    named = client.get("/api/together?person=anna,ben&sort=name&dir=desc").json()["items"]
    assert [i["a"]["id"] for i in named] == [ids["a2"], ids["a1"]]  # "run" after "park"
    # a type filter passes when one of the two activities has it
    d = client.get("/api/together?person=anna,ben&types=trail_run").json()
    assert d["total"] == 1 and "lines" not in d["items"][0]
    assert client.get("/api/together?person=anna,ben&from=2026-10-02").json()["total"] == 1
    assert client.get("/api/together?person=anna").status_code == 400
    assert client.get("/api/together?person=anna,anna").status_code == 400

    p = client.get(f"/api/together/{ids['a1']}/{ids['b1']}").json()
    assert p["people"] == ["anna", "ben"]
    # b started a minute later: together from b's start, a minute after a's
    assert p["offsets"][0] == pytest.approx(-60, abs=10)
    assert p["offsets"][1] == pytest.approx(0, abs=10)
    assert p["span"][0] == p["offsets"][0] and p["span"][1] > 600
    # a was on the shared route from its start, b joined at 0
    assert p["runs"][0][0][0] == p["offsets"][0] and p["runs"][1][0][0] == 0
    assert p["next"] == {"a": ids["a2"], "b": ids["b2"]} and p["prev"] is None
    assert client.get(f"/api/together/{ids['a3']}/{ids['b3']}").status_code == 404
    assert client.get(f"/api/together/{ids['a1']}/{ids['a2']}").status_code == 404
    assert client.get(f"/api/together/{ids['a1']}/999").status_code == 404
    # types/counts takes both people
    counts = client.get("/api/types/counts?person=anna,ben").json()
    assert counts == {"run": 5, "trail_run": 1}


def test_least_share_option(tdb):
    path, c, _ = tdb
    # together for a fifth of the way, then apart
    _store(c, "anna", "2026-10-09T08:00:00Z", track((0, 0), (2000, 0), speed=3))
    _store(c, "ben", "2026-10-09T08:00:00Z", track((0, 0), (400, 0), (400, 1600), speed=3))
    client = TestClient(create_app(path))
    assert client.get("/api/together?person=anna,ben").json()["total"] == 3
    assert client.get("/api/together?person=anna,ben&share=50").json()["total"] == 2
