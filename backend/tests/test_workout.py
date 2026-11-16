"""Workout kind detection (Easy, Long, Tempo, Intervals, Hills, Race, Commute)."""

from __future__ import annotations

import json
import random

import pytest

from trailbook import analysis, db, streams, workout

FTP, LTHR = 260.0, 170.0


def _session(
    blocks, *, power=True, speed_of=None, grade_of=None, effort_of=None, hill_place=False, seed=1
):
    """1 Hz channels for `blocks` = [(seconds, level)]: level is a share of FTP (power) or a
    speed in m/s. The heart rate follows the level with a ~30 s lag."""
    rnd = random.Random(seed)
    ch = {k: [] for k in ("time", "power", "speed", "hr", "altitude", "distance", "lat", "lon")}
    h, d, z, t = 100.0, 0.0, 100.0, 0
    for sec, lvl in blocks:
        for _ in range(sec):
            v = (speed_of(lvl) if speed_of else lvl) * (1 + rnd.gauss(0, 0.03))
            effort = effort_of(lvl) if effort_of else lvl if power or speed_of else lvl / 4.2
            h += (LTHR * (0.62 + 0.38 * min(1.15, effort)) - h) / 30
            g = grade_of(lvl) if grade_of else 0.0
            d += v
            z += v * g
            ch["time"].append(t)
            ch["power"].append(lvl * FTP * (1 + rnd.gauss(0, 0.05)) if power else None)
            ch["speed"].append(v)
            ch["hr"].append(h + rnd.gauss(0, 1))
            ch["altitude"].append(z)
            ch["distance"].append(d)
            # hill repeats go up and down the same hill: position follows the altitude
            ch["lat"].append(50 + (z if hill_place else d) / 111000 * (12 if hill_place else 1))
            ch["lon"].append(20.0)
            t += 1
    if not power:
        ch["power"] = []
    alt = ch["altitude"]
    a = {
        "moving_s": t, "elapsed_s": t, "distance_m": d, "np_power": None, "indoor": 0,
        "ascent_m": sum(max(0.0, y - x) for x, y in zip(alt, alt[1:], strict=False)),
        "start_time_utc": "2026-03-01T08:00:00Z", "workout_stats": None,
    }  # fmt: skip
    return a, ch


def _kind(category, a, ch, hist=None, ftp=FTP):
    f = workout.features(category, ch)
    th = analysis.Thresholds(hr_max=LTHR / 0.9, lthr=LTHR, ftp=ftp)
    return workout.classify(a, f, th, hist or workout.History())


def _bike_speed(level):  # speed on the flat for a share of FTP (air + rolling resistance)
    p, v = level * FTP, 6.0
    for _ in range(30):
        v = (max(1.0, p - 85 * 9.81 * 0.005 * v) / (0.5 * 1.2 * 0.32)) ** (1 / 3)
    return v


RIDE_HIST = workout.History(moving=3600, power=170, speed=8, epower=150)
RUN_HIST = workout.History(moving=2800, speed=3.3)


@pytest.mark.parametrize(
    "blocks",
    [
        [(900, 0.6)] + [(240, 1.05), (180, 0.5)] * 5 + [(600, 0.55)],  # 5 x 4 min
        [(900, 0.6)] + [(60, 1.3), (60, 0.45)] * 10 + [(600, 0.55)],  # 10 x 1 min
        [(900, 0.6), (1200, 0.95), (300, 0.5), (1200, 0.95), (600, 0.55)],  # 2 x 20 min
    ],
)
def test_ride_intervals_on_power(blocks):
    a, ch = _session(blocks, speed_of=_bike_speed)
    assert _kind("ride", a, ch, RIDE_HIST).kind == "intervals"


def test_ride_intervals_without_power_meter():
    a, ch = _session(
        [(900, 0.6)] + [(240, 1.05), (180, 0.5)] * 5 + [(600, 0.55)], speed_of=_bike_speed
    )
    ch["power"] = []
    assert _kind("ride", a, ch, RIDE_HIST, ftp=None).kind == "intervals"


def test_steady_ride_and_stop_and_go_are_not_intervals():
    a, ch = _session([(3600, 0.7)], speed_of=_bike_speed)
    assert _kind("ride", a, ch, RIDE_HIST).kind != "intervals"
    # town: ride 2.5 min, stop at the lights 40 s
    a, ch = _session([(150, 0.75), (40, 0.0)] * 15, speed_of=lambda lv: 6 if lv else 0.2)
    assert _kind("ride", a, ch, RIDE_HIST).kind != "intervals"


def test_run_intervals_from_speed_alone():
    a, ch = _session([(900, 3.2)] + [(80, 5.0), (90, 2.4)] * 6 + [(600, 3.1)], power=False)
    r = _kind("run", a, ch, RUN_HIST)
    assert r.kind == "intervals" and len(r.bouts) == 6
    a, ch = _session([(2700, 3.3)], power=False)
    assert _kind("run", a, ch, RUN_HIST).kind != "intervals"


def test_run_with_stops_at_normal_pace_is_not_intervals():
    # running the usual pace, standing at the lights: the "work" is not above typical
    a, ch = _session([(900, 3.3)] + [(300, 3.3), (60, 0.0)] * 6, power=False)
    assert _kind("run", a, ch, RUN_HIST).kind != "intervals"


def test_hill_repeats_are_hills():
    a, ch = _session(
        [(900, 3.2)] + [(90, 3.0), (120, 2.6)] * 6 + [(600, 3.2)],
        power=False,
        grade_of=lambda lv: 0.08 if lv == 3.0 else (-0.06 if lv == 2.6 else 0.0),
        effort_of=lambda lv: {3.0: 1.05, 2.6: 0.5}.get(lv, 0.75),  # hard up, easy down
        hill_place=True,
    )
    assert _kind("run", a, ch, RUN_HIST).kind == "hills"


def test_walks_are_commute_and_other_sports_have_no_kind():
    a, ch = _session([(1800, 1.3)], power=False)
    assert _kind("walk", a, ch).kind == "commute"
    assert _kind("team", a, ch).kind is None


def test_long_run():
    a, ch = _session([(6000, 3.0)], power=False)
    assert _kind("run", a, ch, RUN_HIST).kind == "long"


# ---- with a database ---------------------------------------------------------------------


def _store(c, pid, day, category, atype, a, ch):
    cur = c.execute(
        """INSERT INTO activities (person_id, fit_uid, start_time_utc, utc_offset_s, category,
                                   activity_type, moving_s, elapsed_s, distance_m, ascent_m,
                                   watch_lthr, watch_ftp, importer_version)
           VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 1)""",
        (
            pid, f"{pid}-{day}", f"{day}T08:00:00Z", category, atype, a["moving_s"],
            a["elapsed_s"], a["distance_m"], a["ascent_m"], LTHR, FTP,
        ),
    )  # fmt: skip
    for name, values in ch.items():
        if not values:
            continue
        enc, blob = streams.encode(values, "f64" if name in ("time", "lat", "lon") else "f32")
        c.execute(
            "INSERT INTO streams (activity_id, channel, encoding, length, data) VALUES (?,?,?,?,?)",
            (cur.lastrowid, name, enc, len(values), blob),
        )
    return cur.lastrowid


def test_backfill_detects_and_keeps_the_persons_choice(tmp_path):
    c = db.connect(tmp_path / "w.db")
    c.execute("INSERT INTO persons (id, label) VALUES ('anna', 'Anna')")
    for i in range(4):  # history: easy rides
        _store(c, "anna", f"2026-02-0{i + 1}", "ride", "road_ride",
               *_session([(3600, 0.62)], speed_of=_bike_speed, seed=i))  # fmt: skip
    blocks = [(900, 0.6)] + [(240, 1.05), (180, 0.5)] * 5 + [(600, 0.55)]
    iv = _store(
        c, "anna", "2026-02-10", "ride", "road_ride", *_session(blocks, speed_of=_bike_speed)
    )
    walk = _store(c, "anna", "2026-02-11", "walk", "walk", *_session([(1800, 1.3)], power=False))
    assert workout.backfill(c) == 6
    kinds = dict(c.execute("SELECT id, workout FROM activities").fetchall())
    assert kinds[iv] == "intervals" and kinds[walk] == "commute"
    detail = json.loads(c.execute("SELECT workout_detail FROM activities WHERE id = ?", (iv,))
                        .fetchone()[0])  # fmt: skip
    assert len(detail["bouts"]) == 5
    assert workout.backfill(c) == 0  # up to date

    workout.set_override(c, iv, "race")
    c.execute("UPDATE activities SET workout_version = 0")  # e.g. thresholds changed
    workout.backfill(c)
    row = c.execute("SELECT workout, workout_override FROM activities WHERE id = ?", (iv,))
    assert tuple(row.fetchone()) == ("intervals", "race")
    workout.set_override(c, iv, None)
    with pytest.raises(ValueError):
        workout.set_override(c, iv, "jogging")
    c.close()


# ---- other sports ------------------------------------------------------------------------


def test_families_and_options():
    assert workout.family("kayak") == "paddle" and workout.family("indoor_row") == "row"
    assert workout.family("soccer") == "game" and workout.family("yoga") is None
    assert "hills" not in workout.options("pool_swim") and "commute" in workout.options("ride")
    assert workout.options("squash") == workout.GAME_KINDS
    # every kind a family offers has a label, every family's types exist
    from trailbook import sports

    for p in workout.PROFILES.values():
        assert set(p.kinds) <= set(workout.KINDS)
        assert set(p.types) <= set(sports.TYPES)


def test_rowing_and_paddling_intervals_from_speed():
    blocks = [(900, 2.0)] + [(120, 3.0), (120, 1.4)] * 6 + [(600, 1.9)]
    a, ch = _session(blocks, power=False, effort_of=lambda lv: lv / 2.8)
    hist = workout.History(moving=3000, speed=2.0)
    assert _kind("kayak", a, ch, hist).kind == "intervals"
    a, ch = _session([(3000, 2.0)], power=False, effort_of=lambda lv: 0.4)
    assert _kind("kayak", a, ch, hist).kind == "easy"


def test_pool_swim_intervals_from_laps():
    def lap(start, el, dist):
        return {"start_offset_s": start, "elapsed_s": el, "timer_s": el, "distance_m": dist}

    laps, t = [], 0
    for _ in range(8):  # 8 x 100 m in 95 s, 20 s rest
        laps += [lap(t, 95, 100), lap(t + 95, 20, 0)]
        t += 115
    ch = {"time": list(range(t)), "hr": [140.0] * t}
    a = {"moving_s": 8 * 95, "elapsed_s": t, "distance_m": 800, "ascent_m": 0, "np_power": None,
         "indoor": 1, "start_time_utc": "2026-03-01T08:00:00Z", "workout_stats": None}  # fmt: skip
    f = workout.features("pool_swim", ch, laps)
    assert f.spd[10] == pytest.approx(100 / 95) and f.spd[100] == 0
    th = analysis.Thresholds(hr_max=190, lthr=LTHR)
    hist = workout.History(moving=1800, speed=0.9)
    assert workout.classify(a, f, th, hist).kind == "intervals"
    # the same at the usual speed: rests at the wall, not intervals
    assert workout.classify(a, f, th, workout.History(moving=1800, speed=1.05)).kind != "intervals"


def test_games_from_the_heart_rate(tmp_path):
    c = db.connect(tmp_path / "g.db")
    c.execute("INSERT INTO persons (id, label) VALUES ('anna', 'Anna')")
    games = {}
    for day, effort in (("01", 1.0), ("02", 0.5), ("03", 0.1)):  # hard, moderate, light
        a, ch = _session([(3600, 1.0)], power=False, effort_of=lambda lv, e=effort: e)
        games[effort] = _store(c, "anna", f"2026-02-{day}", "team", "soccer", a, ch)
    workout.backfill(c)
    kinds = {e: c.execute("SELECT workout FROM activities WHERE id = ?", (i,)).fetchone()[0]
             for e, i in games.items()}  # fmt: skip
    assert kinds == {1.0: "match", 0.5: "training", 0.1: "recreation"}
    workout.set_override(c, games[1.0], "training")
    with pytest.raises(ValueError):
        workout.set_override(c, games[1.0], "intervals")
    c.close()


# ---- interval splits ---------------------------------------------------------------------


def _true_edges(blocks):
    """Starts and ends of the hard blocks (level > 1 for power, the work speed for runs)."""
    t, out = 0, []
    for sec, lvl in blocks:
        if lvl == max(level for _, level in blocks):
            out += [t, t + sec]
        t += sec
    return out


@pytest.mark.parametrize(
    "category, atype, blocks, kw",
    [
        ("ride", "road_ride", [(900, 0.6)] + [(240, 1.05), (180, 0.5)] * 5 + [(600, 0.55)],
         {"speed_of": _bike_speed}),
        ("run", "run", [(600, 2.8)] + [(90, 5.0), (120, 2.6)] * 6 + [(600, 2.8)],
         {"power": False}),
    ],
)  # fmt: skip
def test_interval_splits_sit_on_the_edges(tmp_path, category, atype, blocks, kw):
    c = db.connect(tmp_path / "s.db")
    c.execute("INSERT INTO persons (id, label) VALUES ('anna', 'Anna')")
    iv = _store(c, "anna", "2026-02-10", category, atype, *_session(blocks, **kw))
    workout.backfill(c)
    got = workout.interval_splits(c, iv)["splits"]
    want = _true_edges(blocks)
    assert len(got) == len(want)
    assert max(abs(g - w) for g, w in zip(got, want, strict=True)) <= 4
    c.close()


def test_interval_splits_for_a_chosen_kind(tmp_path):
    """The person chose Intervals for a session the detector called something else: the lines
    come from the detection without its hardness checks."""
    c = db.connect(tmp_path / "s.db")
    c.execute("INSERT INTO persons (id, label) VALUES ('anna', 'Anna')")
    blocks = [(600, 2.8)] + [(60, 3.4), (90, 2.7)] * 4 + [(600, 2.8)]  # gentle surges
    iv = _store(c, "anna", "2026-02-10", "run", "run", *_session(blocks, power=False))
    workout.backfill(c)
    assert c.execute("SELECT workout FROM activities").fetchone()[0] != "intervals"
    got = workout.interval_splits(c, iv)["splits"]
    assert len(got) == 8
    c.close()


def test_split_points_join_short_recoveries():
    assert workout.split_points([(10, 50), (52, 90), (120, 150)]) == [10, 90, 120, 150]


def test_intervals_api_only_while_the_kind_is_intervals(tmp_path):
    from starlette.testclient import TestClient

    from trailbook.api import create_app

    c = db.connect(tmp_path / "s.db")
    c.execute("INSERT INTO persons (id, label) VALUES ('anna', 'Anna')")
    blocks = [(600, 2.8)] + [(90, 5.0), (120, 2.6)] * 6 + [(600, 2.8)]
    iv = _store(c, "anna", "2026-02-10", "run", "run", *_session(blocks, power=False))
    workout.backfill(c)
    c.close()
    client = TestClient(create_app(tmp_path / "s.db"))
    assert len(client.get(f"/api/activities/{iv}/intervals").json()["splits"]) == 12
    client.patch(f"/api/activities/{iv}", json={"workout": "easy"})
    assert client.get(f"/api/activities/{iv}/intervals").json()["splits"] == []


def test_min_sections_keep_every_section_30_s_long():
    bouts = [(20, 80), (100, 160), (300, 320), (400, 470)]
    # warm-up under 30 s: from the start; 20 s recovery: joined; 20 s bout: dropped;
    # cool-down under 30 s: to the end
    assert workout.min_sections(bouts, 490) == [(0, 160), (400, 490)]
    assert workout.split_points([(0, 160), (400, 490)]) == [160, 400, 490]
