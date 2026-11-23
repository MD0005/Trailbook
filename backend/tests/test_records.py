from datetime import UTC, datetime, timedelta

from starlette.testclient import TestClient

from trailbook import analysis, records, segments
from trailbook.api import create_app

NOW = datetime(2026, 11, 20, 12, 0, tzinfo=UTC)


def _person(c, pid="ann", label="Ann"):
    c.execute("INSERT INTO persons (id, label) VALUES (?, ?)", (pid, label))


def _activity(c, days_ago: float, pid="ann", seen=0, processed=True, category="run"):
    start = (NOW - timedelta(days=days_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")
    cur = c.execute(
        """INSERT INTO activities (person_id, fit_uid, start_time_utc, utc_offset_s, category,
                                   activity_type, importer_version, analysis_version,
                                   segments_version, records_seen, name)
           VALUES (?, ?, ?, 3600, ?, ?, 1, ?, ?, ?, ?)""",
        (
            pid, f"{pid}-{start}", start, category, category,
            analysis.ANALYSIS_VERSION if processed else 0,
            segments.MATCH_VERSION if processed else 0, seen, f"Act {days_ago}",
        ),
    )  # fmt: skip
    return cur.lastrowid


def _effort(c, aid, value, kind="pace", key=5000):
    c.execute(
        """INSERT INTO best_efforts (activity_id, kind, key, value, start_s, end_s)
           VALUES (?, ?, ?, ?, 0, ?)""",
        (aid, kind, key, value, value),
    )


def _segment(c, name="Hill"):
    cur = c.execute(
        """INSERT INTO segments (name, polyline, point_count, distance_m, start_lat, start_lon,
                                 end_lat, end_lon, bbox_min_lat, bbox_min_lon, bbox_max_lat,
                                 bbox_max_lon, source, match_version)
           VALUES (?, '', 2, 1000, 0, 0, 0, 0, 0, 0, 0, 0, 'map', ?)""",
        (name, segments.MATCH_VERSION),
    )
    return cur.lastrowid


def _seg_effort(c, sid, aid, elapsed):
    start = c.execute("SELECT start_time_utc FROM activities WHERE id = ?", (aid,)).fetchone()[0]
    c.execute(
        """INSERT INTO segment_efforts (segment_id, activity_id, start_time_utc, start_s, end_s,
                                        elapsed_s) VALUES (?, ?, ?, 0, ?, ?)""",
        (sid, aid, start, elapsed, elapsed),
    )


def _history(c, values, kind="pace", key=5000, days_ago=100):
    """Seen activities, one per value."""
    for i, v in enumerate(values):
        _effort(c, _activity(c, days_ago + i, seen=1), v, kind, key)


def test_new_record_beats_the_old_one(conn):
    _person(conn)
    _history(conn, [1300, 1350, 1400])
    aid = _activity(conn, 1)
    _effort(conn, aid, 1280)
    events = records.refresh(conn, NOW)
    assert len(events) == 1
    ev = events[0]
    assert ev["activity_id"] == aid and ev["kind"] == "pace" and ev["key_label"] == "5 km"
    assert ev["label"] == "21:20" and ev["person_label"] == "Ann"
    assert ev["all"]["rank"] == 1 and ev["all"]["delta"] == 20
    assert ev["all"]["delta_label"] == "20 s"
    # the history is 100+ days back but in 2026: this year's list counts too
    assert ev["year"]["rank"] == 1 and ev["scope"] == "all" and ev["rank"] == 1
    assert ev["speed"] == "4:16 /km"
    assert ev["title"] == "ALL-TIME RECORD" and ev["icon"] == "mdi:trophy"
    assert ev["message"] == (
        "Ann · run 5 km · 21:20 (4:16 /km)\n20 s better than 21:40 on "
        + ev["all"]["beaten"]["date"]
    )
    # checked once: no event again
    assert conn.execute("SELECT records_seen FROM activities WHERE id = ?", (aid,)).fetchone()[0]
    assert records.refresh(conn, NOW) == []
    payload = records.payload(records.latest(conn))
    assert payload["state"] == str(ev["id"])
    assert payload["attributes"]["title"] == "ALL-TIME RECORD"


def test_each_record_is_an_event_pushed_once(conn, monkeypatch):
    from trailbook import homeassistant

    _person(conn)
    _history(conn, [1300, 1350, 1400])
    _history(conn, [300, 280, 250], kind="power", key=1200, days_ago=200)
    aid = _activity(conn, 1)
    _effort(conn, aid, 1280)
    _effort(conn, aid, 290, kind="power", key=1200)
    events = records.refresh(conn, NOW)
    assert [e["kind"] for e in events] == ["pace", "power"]
    assert events[1]["title"] == "ALL-TIME 2ND BEST"
    assert events[1]["icon"] == "mdi:trophy-variant-outline"
    # a fake Home Assistant: the states it has, and whether it answers
    ha = {"up": False, "states": {}}
    sent = []

    def set_state(entity, state, attrs):
        if ha["up"]:
            ha["states"][entity] = state
            sent.append(state)
        return ha["up"]

    monkeypatch.setattr(homeassistant, "available", lambda: True)
    monkeypatch.setattr(homeassistant, "set_state", set_state)
    monkeypatch.setattr(
        homeassistant, "has_state", lambda e: (e in ha["states"]) if ha["up"] else None
    )
    assert records.publish(conn, NOW) == 0 and records.unpushed(conn)  # HA away: nothing sent
    ha["up"] = True  # back after a restart: no sensor yet, so 0 comes first
    assert records.publish(conn, NOW) == 2
    assert sent == ["0", *(str(e["id"]) for e in events)]
    assert records.publish(conn, NOW) == 0 and not records.unpushed(conn)


def test_events_home_assistant_missed_for_days_are_dropped(conn, monkeypatch):
    from trailbook import homeassistant

    _person(conn)
    _history(conn, [1300, 1350, 1400])
    _effort(conn, _activity(conn, 1), 1280)
    records.refresh(conn, NOW)
    monkeypatch.setattr(homeassistant, "available", lambda: True)
    monkeypatch.setattr(homeassistant, "set_state", lambda e, s, a: True)
    assert records.publish(conn, NOW + timedelta(days=3)) == 0
    assert not records.unpushed(conn)


def test_third_place_beats_the_old_third(conn):
    _person(conn)
    _history(conn, [1300, 1350, 1400])
    aid = _activity(conn, 1)
    _effort(conn, aid, 1390)
    (ev,) = records.refresh(conn, NOW)
    assert ev["all"]["rank"] == 3 and ev["all"]["beaten"]["value"] == 1400
    assert ev["all"]["delta"] == 10 and ev["title"] == "ALL-TIME 3RD BEST"


def test_higher_is_better_for_power(conn):
    _person(conn)
    _history(conn, [300, 280, 250], kind="power", key=1200)
    aid = _activity(conn, 0.5)
    _effort(conn, aid, 310, kind="power", key=1200)
    (ev,) = records.refresh(conn, NOW)
    assert ev["all"]["rank"] == 1 and ev["all"]["delta_label"] == "10 W"
    assert ev["key_label"] == "20 min" and ev["label"] == "310 W"


def test_no_event_without_a_beaten_result(conn):
    _person(conn)
    _history(conn, [1300, 1350])
    aid = _activity(conn, 1)
    _effort(conn, aid, 1500)  # third, but the list had a free place
    assert records.refresh(conn, NOW) == []
    # outside the top 3 either
    _history(conn, [1310], days_ago=200)
    aid = _activity(conn, 2)
    _effort(conn, aid, 1600)
    assert records.refresh(conn, NOW) == []


def test_old_history_and_unprocessed_activities(conn):
    _person(conn)
    _history(conn, [1300, 1350, 1400])
    old = _activity(conn, 40)  # imported now, but run long ago
    _effort(conn, old, 1200)
    pending = _activity(conn, 1, processed=False)
    _effort(conn, pending, 1100)
    assert records.refresh(conn, NOW) == []
    seen = dict(conn.execute("SELECT id, records_seen FROM activities WHERE id IN (?, ?)",
                             (old, pending)).fetchall())  # fmt: skip
    assert seen == {old: 1, pending: 0}  # the pending one waits for its analysis
    conn.execute(
        "UPDATE activities SET analysis_version = ?, segments_version = ? WHERE id = ?",
        (analysis.ANALYSIS_VERSION, segments.MATCH_VERSION, pending),
    )
    (ev,) = records.refresh(conn, NOW)
    assert ev["activity_id"] == pending and ev["all"]["beaten"]["value"] == 1200


def test_new_segment_is_no_record_but_a_new_effort_is(conn):
    _person(conn)
    acts = [_activity(conn, 100 + i, seen=1) for i in range(3)]
    sid = _segment(conn)
    for aid, t in zip(acts, (200, 210, 220), strict=True):
        _seg_effort(conn, sid, aid, t)  # a segment added now: efforts of seen activities
    assert records.refresh(conn, NOW) == []
    aid = _activity(conn, 1)
    _seg_effort(conn, sid, aid, 199.6)
    _seg_effort(conn, sid, aid, 230)  # the same activity rode it twice: the faster counts
    (ev,) = records.refresh(conn, NOW)
    assert ev["kind"] == "segment" and ev["segment"]["name"] == "Hill"
    assert ev["all"]["rank"] == 1 and ev["all"]["delta_label"] == "0,4 s"
    assert ev["speed"] == "3:20 /km"
    assert ev["message"].startswith("Ann · segment Hill · 3:20 (3:20 /km)")


def test_deleting_the_record_is_no_event(conn):
    _person(conn)
    _history(conn, [1300, 1350, 1400, 1450])
    best = conn.execute("SELECT activity_id FROM best_efforts WHERE value = 1300").fetchone()[0]
    conn.execute("DELETE FROM activities WHERE id = ?", (best,))
    assert records.refresh(conn, NOW) == []


def test_year_only_record(conn):
    _person(conn)
    _history(conn, [1200, 1210, 1220], days_ago=400)  # 2025
    _history(conn, [1300, 1350, 1400], days_ago=100)  # 2026
    aid = _activity(conn, 1)
    _effort(conn, aid, 1290)
    (ev,) = records.refresh(conn, NOW)
    assert ev["all"] is None and ev["year"]["rank"] == 1
    assert ev["title"] == "2026 RECORD" and ev["icon"] == "mdi:medal"


def test_labels():
    assert records.duration(3723) == "1:02:03" and records.duration(42) == "0:42"
    assert records.key_label("pace", 21097.5) == "21,1 km"
    assert records.key_label("pace", 1609.344) == "1 mi"
    assert records.key_label("power", 5400) == "1,5 h"
    assert records.value_label("longest", 12345) == "12,35 km"
    assert records.delta_label("pace", 65) == "1:05"


def test_endpoint(tmp_path):
    from trailbook import db

    c = db.connect(tmp_path / "t.db")
    _person(c)
    _history(c, [1300])
    c.close()
    with TestClient(create_app(tmp_path / "t.db")) as client:
        body = client.get("/api/ha/records").json()
    assert body["state"] == "0"


def test_only_runs_and_rides_no_heart_rate(conn):
    _person(conn)
    for i, v in enumerate([300, 280, 250]):
        _effort(conn, _activity(conn, 100 + i, seen=1, category="walk"), v, "power", 1200)
    _effort(conn, _activity(conn, 1, category="walk"), 310, kind="power", key=1200)
    _history(conn, [170, 165, 160], kind="hr", key=300, days_ago=200)
    _effort(conn, _activity(conn, 2), 175, kind="hr", key=300)
    assert records.refresh(conn, NOW) == []  # a walk's power, a run's heart rate: no records


def test_year_power_only_20_min_and_1_h(conn):
    _person(conn)
    for n, key in enumerate((5, 1200)):
        _history(conn, [700, 690, 680], kind="power", key=key, days_ago=400 + 10 * n)  # 2025
        _history(conn, [400, 390, 380], kind="power", key=key, days_ago=100 + 10 * n)  # 2026
    aid = _activity(conn, 1)
    _effort(conn, aid, 395, kind="power", key=5)  # 2nd this year: not a record for 5 s
    _effort(conn, aid, 395, kind="power", key=1200)
    (ev,) = records.refresh(conn, NOW)
    assert ev["key"] == 1200 and ev["title"] == "2026 2ND BEST"
    # all time: every duration
    aid = _activity(conn, 2)
    _effort(conn, aid, 710, kind="power", key=5)
    (ev,) = records.refresh(conn, NOW)
    assert ev["key"] == 5 and ev["title"] == "ALL-TIME RECORD"


def test_sensor_is_put_back_with_state_0(monkeypatch):
    from trailbook import homeassistant

    sent = []
    monkeypatch.setattr(homeassistant, "available", lambda: True)
    monkeypatch.setattr(homeassistant, "set_state", lambda e, s, a: not sent.append((e, s)))
    monkeypatch.setattr(homeassistant, "has_state", lambda e: True)
    assert not records.ensure_sensor() and sent == []
    monkeypatch.setattr(homeassistant, "has_state", lambda e: None)  # HA not answering
    assert not records.ensure_sensor() and sent == []
    monkeypatch.setattr(homeassistant, "has_state", lambda e: False)  # restarted: gone
    assert records.ensure_sensor() and sent == [(records.ENTITY_ID, "0")]


def test_changing_the_type_moves_a_ride_between_outdoor_and_indoor_records(conn):
    from trailbook import importer

    _person(conn)
    aid = _activity(conn, 100, seen=1, category="ride")
    _effort(conn, aid, 600, kind="ride", key=10000)

    def v():
        return conn.execute(
            f"SELECT v FROM {records.EFFORTS_SQL} WHERE activity_id = ? AND kind = 'ride'",
            (aid,),
        ).fetchone()["v"]

    assert v() == 0
    importer.set_activity_type(conn, aid, "virtual_ride")
    assert v() == 1
    importer.set_activity_type(conn, aid, "road_ride")
    assert v() == 0
