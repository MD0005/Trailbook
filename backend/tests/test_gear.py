import json

from starlette.testclient import TestClient

from trailbook import db, fitfile, gear
from trailbook.api import create_app

# made-up devices and serial numbers
WATCH = ("watch", "Garmin", "fr965", "Forerunner 965")
STRAP = ("hr_strap", "Garmin", "hrm_dual", "HRM-Dual")
METER = ("power_meter", "Favero", "assioma_uno", "Assioma Uno")


def _d(label, serial=None, battery=None, level=None):
    kind, maker, product, name = label
    return {"kind": kind, "maker": maker, "product": product, "name": name, "serial": serial,
            "battery": battery, "level": level}  # fmt: skip


def _person(c, pid="ann"):
    c.execute("INSERT INTO persons (id, label) VALUES (?, ?)", (pid, pid.title()))


def _activity(c, day, devices, pid="ann", kind="run", time_s=3600, dist=10000, excluded=0):
    start = f"{day}T10:00:00Z"
    cur = c.execute(
        """INSERT INTO activities (person_id, fit_uid, start_time_utc, utc_offset_s, category,
                                   activity_type, importer_version, devices, time_s,
                                   distance_m, ascent_m, excluded)
           VALUES (?, ?, ?, 3600, ?, ?, 1, ?, ?, ?, 100, ?)""",
        (pid, f"{pid}-{day}-{kind}", start, kind, kind,
         json.dumps(devices) if devices else None, time_s, dist, excluded),
    )  # fmt: skip
    return cur.lastrowid


def _conn(tmp_path):
    c = db.connect(tmp_path / "t.db")
    _person(c)
    return c


def _since(day):
    return ["date(start_time_utc) >= ?"], [day]


def _by_key(data):
    return {d["key"]: d for d in data["devices"]}


def test_use_per_device_last_used_first(tmp_path):
    c = _conn(tmp_path)
    first = _activity(c, "2026-01-01", [_d(WATCH, 111), _d(STRAP, 222)])
    last = _activity(c, "2026-03-01", [_d(WATCH, 111)], kind="ride", time_s=7200, dist=50000)
    data = gear.summary(c, "ann")
    assert data["first_day"] == "2026-01-01" and data["without"] == 0
    watch, strap = data["devices"]
    assert (watch["key"], strap["key"]) == ("sn111", "sn222")
    assert (watch["activities"], watch["time_s"], watch["distance_m"], watch["ascent_m"]) == (
        2, 10800, 60000, 200)  # fmt: skip
    assert watch["first"] == {"day": "2026-01-01", "activity_id": first}
    assert watch["last"] == {"day": "2026-03-01", "activity_id": last}
    assert watch["types"] == [{"type": "ride", "activities": 1}, {"type": "run", "activities": 1}]


def test_same_model_told_apart_by_serial(tmp_path):
    c = _conn(tmp_path)
    _activity(c, "2026-01-01", [_d(STRAP, 222)])
    _activity(c, "2026-02-01", [_d(STRAP, 333)])
    _activity(c, "2026-03-01", [_d(STRAP)])  # which of the two? not known: on its own
    found = _by_key(gear.summary(c, "ann"))
    assert set(found) == {"sn222", "sn333", "hr_strap:hrm_dual"}
    assert found["hr_strap:hrm_dual"]["serial"] is None
    assert found["sn222"]["activities"] == 1


def test_one_serial_under_several_labels(tmp_path):
    c = _conn(tmp_path)
    # a training app lists the power meter under its own maker, as a trainer without a model
    app_label = ("trainer", "Tacx", None, "Smart trainer")
    for day in ("2026-01-01", "2026-01-02"):
        _activity(c, day, [_d(METER, 444)])
    for day in ("2026-01-03", "2026-01-04", "2026-01-05"):
        _activity(c, day, [_d(app_label, 444)])
    (meter,) = gear.summary(c, "ann")["devices"]
    assert (meter["kind"], meter["name"], meter["activities"]) == ("power_meter", "Assioma Uno", 5)
    assert meter["products"] == ["assioma_uno"]


def test_entries_without_serial_join_the_only_candidate(tmp_path):
    c = _conn(tmp_path)
    _activity(c, "2026-01-01", [_d(WATCH, 111), _d(METER, 444), _d(STRAP, 222)])
    _activity(c, "2026-01-02", [_d(STRAP)])  # same product
    _activity(c, "2026-01-03", [_d(("hr_strap", "Tacx", "forerunner", "Forerunner"))])  # name
    _activity(c, "2026-01-04", [_d(("watch", "Garmin", None, "Watch"))])  # kind, no model
    _activity(c, "2026-01-05", [_d(("power_meter", None, "10", "Power meter"))])  # number
    _activity(c, "2026-01-06", [_d(("foot_pod", "Garmin", None, "Foot pod"))])  # no candidate
    found = _by_key(gear.summary(c, "ann"))
    assert set(found) == {"sn111", "sn222", "sn444", "foot_pod:foot pod"}
    assert found["sn111"]["activities"] == 3
    assert found["sn222"]["activities"] == 2
    assert found["sn444"]["activities"] == 2


def test_activity_counted_once_and_excluded_left_out(tmp_path):
    c = _conn(tmp_path)
    _person(c, "bob")
    # the watch recording and sending its wrist heart rate is one device
    _activity(c, "2026-01-01", [_d(WATCH, 111), _d(("watch", "Garmin", None, "Watch"))])
    _activity(c, "2026-01-02", [_d(WATCH, 111)], excluded=1)
    _activity(c, "2026-01-03", [_d(WATCH, 111)], pid="bob")
    _activity(c, "2026-01-04", None)
    data = gear.summary(c, "ann")
    assert data["without"] == 1
    (watch,) = data["devices"]
    assert (watch["activities"], watch["time_s"]) == (1, 3600)


def test_a_break_of_30_days_splits_the_use(tmp_path):
    c = _conn(tmp_path)
    # 29 days without it between 01-01 and 01-31, 30 between 02-01 and 03-04
    for day in ("2026-01-01", "2026-01-31", "2026-02-01", "2026-03-04", "2026-03-05"):
        _activity(c, day, [_d(WATCH, 111)])
    (watch,) = gear.summary(c, "ann")["devices"]
    assert watch["spans"] == [["2026-01-01", "2026-02-01"], ["2026-03-04", "2026-03-05"]]


def test_time_filter_counts_only_its_activities(tmp_path):
    c = _conn(tmp_path)
    _activity(c, "2025-05-01", [_d(WATCH, 111), _d(STRAP, 222)])
    _activity(c, "2025-06-01", [_d(STRAP, 333)])
    _activity(c, "2026-02-01", [_d(WATCH, 111), _d(STRAP, 333, battery="low")])
    _activity(c, "2026-02-02", None)
    data = gear.summary(c, "ann", *_since("2026-01-01"))
    assert (data["first_day"], data["without"]) == ("2026-02-01", 1)
    found = _by_key(data)
    assert set(found) == {"sn111", "sn333"}
    assert found["sn111"]["activities"] == 1
    # the order of first use and the twin straps come from the whole history
    assert [found[k]["order"] for k in ("sn111", "sn333")] == [0, 2]
    assert found["sn333"]["twin"] and not found["sn111"]["twin"]


def _weigh_file(c, ts, serial=900):
    c.execute(
        """INSERT OR IGNORE INTO devices (serial, product, first_seen, last_seen)
           VALUES (?, '3461', ?, ?)""",
        (serial, ts, ts),
    )
    cur = c.execute(
        """INSERT INTO files (person_id, rel_path, size, mtime, status, first_seen, last_seen,
                              device_serial)
           VALUES ('ann', ?, 1, 0, 'skipped', ?, ?, ?)""",
        (f"{ts}.fit", ts, ts, serial),
    )
    c.execute("INSERT INTO body_parts (file_id, ts, weight) VALUES (?, ?, 70)", (cur.lastrowid, ts))


def _weigh_connect(c, ts, source="INDEX_SCALE"):
    c.execute(
        """INSERT INTO garmin_weights (person_id, ts, weight, source, fetched_at)
           VALUES ('ann', ?, 70, ?, ?)""",
        (ts, source, ts),
    )


def test_scale_counts_weigh_ins_once(tmp_path):
    c = _conn(tmp_path)
    _activity(c, "2026-03-01", [_d(WATCH, 111)])
    _weigh_file(c, "2026-01-05T07:00:10Z")
    _weigh_connect(c, "2026-01-05T07:00:40Z")  # the same weigh-in
    _weigh_connect(c, "2026-04-01T07:00:00Z")
    _weigh_connect(c, "2026-04-02T07:00:00Z", source="MANUAL")  # typed in: no scale
    data = gear.summary(c, "ann")
    scale = _by_key(data)["sn900"]
    assert (scale["name"], scale["weighins"], scale["time_s"], scale["activities"]) == (
        "Index Smart Scale 2", 2, None, None)  # fmt: skip
    assert data["first_day"] == "2026-01-05"
    assert [d["key"] for d in data["devices"]] == ["sn900", "sn111"]  # last used first
    assert _by_key(gear.summary(c, "ann", *_since("2026-02-01")))["sn900"]["weighins"] == 1


def test_battery_from_the_last_activity_that_tells(tmp_path):
    c = _conn(tmp_path)
    _activity(c, "2026-01-01", [_d(WATCH, 111, level=80), _d(STRAP, 222, battery="good")])
    _activity(c, "2026-01-02", [_d(WATCH, 111, level=55), _d(STRAP, 222, battery="low")])
    _activity(c, "2026-01-03", [_d(WATCH, 111), _d(STRAP, 222, battery="unknown")])
    found = _by_key(gear.summary(c, "ann", *_since("2027-01-01")))
    assert found == {}  # nothing in the filter
    found = _by_key(gear.summary(c, "ann"))
    assert found["sn111"]["battery"] == {"level": 55, "status": None, "day": "2026-01-02"}
    assert found["sn222"]["battery"] == {"level": None, "status": "low", "day": "2026-01-02"}


def test_battery_in_the_devices_of_a_file():
    def sensor(index, product, **more):
        return {"device_index": index, "source_type": "antplus", "manufacturer": "garmin",
                "garmin_product": product, **more}  # fmt: skip

    found = fitfile.devices({
        "file_id_mesgs": [{"manufacturer": "garmin", "garmin_product": "edge_850"}],
        "device_info_mesgs": [
            {"device_index": "creator", "manufacturer": "garmin", "garmin_product": "edge_850",
             "serial_number": 111},
            sensor(1, "hrm_dual", device_type="heart_rate", serial_number=222,
                   battery_status="ok"),
            sensor(2, "OHR", serial_number=333, battery_status="good", battery_level=73),
        ],
        "battery_mesgs": [{"capacity": 64}, {"capacity": 62}, {"capacity": 255}],
    })  # fmt: skip
    got = {d["serial"]: (d["battery"], d["level"]) for d in found}
    assert got == {111: (None, 62), 222: ("ok", None), 333: ("good", 73)}


def test_activities_of_one_device(tmp_path):
    c = _conn(tmp_path)
    first = _activity(c, "2026-01-01", [_d(WATCH, 111), _d(STRAP, 222)])
    _activity(c, "2026-01-02", [_d(WATCH, 111)])
    third = _activity(c, "2026-01-03", [_d(STRAP)])  # no serial: the only strap
    c.commit()
    c.close()
    client = TestClient(create_app(tmp_path / "t.db"))
    data = client.get("/api/activities?person=ann&device=sn222").json()
    assert [a["id"] for a in data["items"]] == [third, first]
    assert data["device"] == {"name": "HRM-Dual", "serial": 222} and data["total"] == 2
    assert client.get("/api/activities?person=ann&device=sn999").json()["total"] == 0
    assert client.get("/api/activities?device=sn222").status_code == 400
    # previous / next stay within the device
    one = client.get(f"/api/activities/{first}?device=sn222").json()
    assert one["next_id"] == third


def test_api(tmp_path):
    c = _conn(tmp_path)
    _activity(c, "2026-01-01", [_d(WATCH, 111)])
    c.commit()
    c.close()
    (tmp_path / "device-images").mkdir()
    (tmp_path / "device-images" / "fr965.png").write_bytes(b"png")
    with TestClient(create_app(tmp_path / "t.db")) as client:
        assert client.get("/api/stats/gear").status_code == 400
        data = client.get("/api/stats/gear?person=ann").json()
        (watch,) = data["devices"]
        assert watch["image"] == "/api/device-image/fr965.png"
        assert "products" not in watch
        assert client.get("/api/stats/gear?person=ann&years=2025").json()["devices"] == []
