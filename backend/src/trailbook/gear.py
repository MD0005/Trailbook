"""Gear › Electronics: the devices that recorded a person's activities (watch, bike computer,
app, sensors; `activities.devices`, see `fitfile.devices`) and the scale (weigh-ins), and how
much each was used. How devices are told apart and what is counted: docs/MANUAL.md › Gear.
"""

import json
import sqlite3
from bisect import bisect_left
from collections import Counter
from datetime import date, datetime, timedelta

from . import fitfile

BREAK_DAYS = 30  # this long without a device ends a stretch of its use
BATTERY_STATUSES = ("new", "good", "ok", "low", "critical")  # FIT battery_status worth showing
# A device used fewer than RARE_USES times and not in the last RECENT_DAYS days is taken for a
# test or a mistake in a file and not shown anywhere.
RARE_USES = 5
RECENT_DAYS = 61  # two months
WATCH_NAMES = ("forerunner", "fēnix", "fenix", "epix", "venu", "vívoactive", "vivoactive",
               "instinct", "enduro", "marq", "descent", "approach")  # fmt: skip


def _today() -> date:
    return date.today()


def _watch_model(label: tuple) -> bool:
    return label[3].lower().startswith(WATCH_NAMES)


def _named(label: tuple) -> bool:
    """The file names the model (a bare product number or nothing does not). A watch model on a
    sensor or a trainer is no name either: another maker's product number read as Garmin's."""
    kind, _, product, _ = label
    if not product or product.isdigit():
        return False
    return not (kind in ("sensor", "trainer") and _watch_model(label))


class _Device:
    def __init__(self, key: str, serial: int | None):
        self.key, self.serial = key, serial
        self.labels: Counter = Counter()  # (kind, maker, product, name) as the files wrote it
        self.activities: dict[int, sqlite3.Row] = {}  # one entry per activity
        self.batteries: dict[int, dict] = {}  # activity id -> {level, status} the file gave

    def add(self, activity: sqlite3.Row, label: tuple | None, entry: dict) -> None:
        """`label`: None for an entry that joins the device and does not name it."""
        if label:
            self.labels[label] += 1
        self.activities[activity["id"]] = activity
        level, status = entry.get("level"), entry.get("battery")
        status = status if status in BATTERY_STATUSES else None
        if level is not None or status:
            seen = self.batteries.setdefault(activity["id"], {"level": None, "status": None})
            seen["level"] = seen["level"] if level is None else level
            seen["status"] = status or seen["status"]

    def latest_battery(self) -> dict | None:
        """{level (% or None), status (or None), day} from the last activity that tells."""
        if not self.batteries:
            return None
        last = max((self.activities[i] for i in self.batteries), key=_age)
        return {**self.batteries[last["id"]], "day": _moment(last)["day"]}

    def ranked(self) -> list[tuple]:
        """The labels, the one that says most about the device first: with a model name, then a
        known kind, then the most common (a training app lists sensors under its own maker, or
        with no name)."""
        return sorted(
            self.labels,
            key=lambda x: (not _named(x), x[0] == "sensor", -self.labels[x], str(x)),
        )


def _candidates(label: tuple, known: list[_Device]) -> list[_Device]:
    """The devices with a serial number an entry without one can belong to. A watch sending
    its heart rate (listed by its model, or as a "Watch") is one of the watches of that model;
    else the devices of the same product; for an entry that names no model, of the same kind
    (not for unknown sensors)."""
    kind, maker, product, name = label
    sending = kind == "watch" and product is None and maker in (None, "Garmin")
    if sending or (kind in ("watch", "hr_strap") and _watch_model(label)):
        watches = [d for d in known if d.ranked()[0][0] == "watch"]
        if name == "Watch":
            return watches
        start = f"{name} ".lower()
        return [d for d in watches if f"{d.ranked()[0][3]} ".lower().startswith(start)]
    if _named(label):
        return [
            d for d in known
            if any(str(p).lower() == product.lower() for _, _, p, _ in d.labels if p)
        ]  # fmt: skip
    if kind == "sensor":
        return []
    same = [d for d in known if d.ranked()[0][0] == kind]
    if kind in ("watch", "bike_computer", "app"):  # what recorded: of the same maker
        same = [d for d in same if d.ranked()[0][1] == maker]
    return same


def _nearest(found: list[_Device], days: dict[str, list[int]], day: int) -> _Device:
    """The device used closest in time to `day` (`days`: each one's own days, in order);
    equally close: the most used."""

    def distance(d: _Device) -> tuple:
        own = days[d.key]
        i = bisect_left(own, day)
        return min(abs(x - day) for x in own[max(i - 1, 0) : i + 1]), -len(own), d.key

    return min(found, key=distance)


def _kept(uses: int, last_start: str) -> bool:
    """Used often enough, or lately."""
    since = _today() - timedelta(days=RECENT_DAYS)
    return uses >= RARE_USES or last_start[:10] >= since.isoformat()


def _shown(d: _Device) -> bool:
    """Not an unknown sensor, and not a rare device of long ago."""
    label = d.ranked()[0]
    if label[0] == "sensor" and not _named(label):
        return False
    return _kept(len(d.activities), max(map(_age, d.activities.values()))[0])


def _moment(a: sqlite3.Row) -> dict:
    start = datetime.strptime(a["start_time_utc"][:19], "%Y-%m-%dT%H:%M:%S")
    local = start + timedelta(seconds=a["utc_offset_s"] or 0)
    return {"day": local.date().isoformat(), "activity_id": a["id"]}


def _ordinal(a: sqlite3.Row) -> int:
    return date.fromisoformat(_moment(a)["day"]).toordinal()


def _devices(conn: sqlite3.Connection, person_id: str) -> tuple[list, list[_Device]]:
    """The person's activities, oldest first, and the devices to show, from the whole history.
    Activities left out of the statistics are not counted.
    Only devices with a serial number: an entry without one joins the nearest in time that it
    fits, else it is left out."""
    rows = conn.execute(
        """SELECT id, start_time_utc, utc_offset_s, devices, activity_type, time_s,
                  distance_m, ascent_m
           FROM activities WHERE person_id = ? AND NOT excluded ORDER BY start_time_utc, id""",
        (person_id,),
    ).fetchall()
    with_serial: dict[int, _Device] = {}
    entries: list[tuple[sqlite3.Row, tuple, dict]] = []  # entries with a serial number
    loose: list[tuple[sqlite3.Row, tuple, dict]] = []  # and without one
    for a in rows:
        for e in json.loads(a["devices"]) if a["devices"] else []:
            label = (e.get("kind") or "sensor", e.get("maker"), e.get("product"),
                     e.get("name") or "Sensor")  # fmt: skip
            serial = e.get("serial")
            if not serial:
                loose.append((a, label, e))
                continue
            if serial not in with_serial:
                with_serial[serial] = _Device(f"sn{serial}", serial)
            with_serial[serial].add(a, label, e)
            entries.append((a, label, e))
    # A watch sending its heart rate may do so under a number of its own: those entries join
    # the watch too.
    straps = {
        d.serial: d for d in with_serial.values()
        if all(x[0] == "hr_strap" and _watch_model(x) for x in d.labels)
    }  # fmt: skip
    known = [d for d in with_serial.values() if d.serial not in straps]
    moved = {s for s, d in straps.items() if _candidates(d.ranked()[0], known)}
    loose += [x for x in entries if x[2]["serial"] in moved]
    found = [d for d in with_serial.values() if d.serial not in moved]
    # matched against the devices as their own entries with a serial number describe them
    candidates = {x: _candidates(x, known) for x in dict.fromkeys(x for _, x, _ in loose)}
    days = {d.key: sorted(map(_ordinal, d.activities.values())) for d in known}
    joins = [
        (_nearest(candidates[label], days, _ordinal(a)), a, e)
        for a, label, e in loose
        if candidates[label]
    ]
    for device, a, e in joins:
        device.add(a, None, e)  # counted for it; its name stays its own
    return rows, [d for d in found if _shown(d)]


def activity_ids(conn: sqlite3.Connection, person_id: str, key: str) -> tuple[dict, list[int]]:
    """The device `key` of a person ({name, serial}) and the activities it was in; ({}, [])
    for an unknown key."""
    for d in _devices(conn, person_id)[1]:
        if d.key == key:
            return {"name": d.ranked()[0][3], "serial": d.serial}, list(d.activities)
    return {}, []


def _age(a: sqlite3.Row) -> tuple[str, int]:
    return a["start_time_utc"], a["id"]


def spans(days: list[date]) -> list[list[str]]:
    """[first day, last day] of each stretch of use, from the days in order: a break of
    BREAK_DAYS days or more without the device ends one."""
    out = [[days[0], days[0]]]
    for day in days[1:]:
        if (day - out[-1][1]).days > BREAK_DAYS:
            out.append([day, day])
        else:
            out[-1][1] = max(out[-1][1], day)
    return [[a.isoformat(), b.isoformat()] for a, b in out]


def _weigh_ins(conn: sqlite3.Connection, person_id: str) -> list[dict]:
    """The weigh-ins of the person's scale, one per minute: from the scale's FIT files (with its
    serial number) and from Garmin Connect (`serial` None), {start_time_utc, serial, product}."""
    rows = conn.execute(
        """SELECT b.ts, f.device_serial AS serial, d.product
           FROM body_parts b JOIN files f ON f.id = b.file_id
           LEFT JOIN devices d ON d.serial = f.device_serial
           WHERE f.person_id = ?
           UNION ALL
           SELECT ts, NULL, NULL FROM garmin_weights
           WHERE person_id = ? AND source = 'INDEX_SCALE'""",
        (person_id, person_id),
    ).fetchall()
    out: dict[str, dict] = {}
    for r in sorted(rows, key=lambda r: (r["ts"][:16], r["serial"] is None)):
        out.setdefault(r["ts"][:16], {
            "id": None, "start_time_utc": r["ts"], "utc_offset_s": 0, "serial": r["serial"],
            "product": r["product"],
        })  # fmt: skip
    return list(out.values())


def _scales(conn, person_id: str, keep) -> list[dict]:
    """An entry per scale; Garmin Connect names no serial number: its weigh-ins belong to the
    only scale the files name, else to a scale of its own. `keep`: the weigh-ins (their times)
    in the Time filter."""
    weighed = _weigh_ins(conn, person_id)
    serials = {w["serial"]: w["product"] for w in weighed if w["serial"]}
    only = next(iter(serials)) if len(serials) == 1 else None
    groups: dict = {}
    for w in weighed:
        groups.setdefault(w["serial"] or only, []).append(w)
    out = []
    for serial, all_of in groups.items():
        counted = [w for w in all_of if w["start_time_utc"] in keep]
        if not counted or not _kept(len(all_of), all_of[-1]["start_time_utc"]):
            continue
        product = serials.get(serial)
        name = fitfile.device_name("garmin", fitfile.product_name(product)) or "Index scale"
        out.append({
            "key": f"sn{serial}" if serial else "scale:index", "kind": "scale",
            "maker": "Garmin", "product": product, "name": name, "serial": serial,
            "battery": None, "products": [product] if product else [],
            "weighins": len(counted), "activities": None, "time_s": None, "distance_m": None,
            "ascent_m": None, "types": [], "first": _moment(counted[0]),
            "last": _moment(counted[-1]), "last_start": counted[-1]["start_time_utc"],
            "first_start": all_of[0]["start_time_utc"],
            "spans": spans([date.fromisoformat(_moment(w)["day"]) for w in counted]),
        })  # fmt: skip
    return sorted(out, key=lambda s: (s["first_start"], s["key"]))


def summary(conn: sqlite3.Connection, person_id: str, where=(), params=()) -> dict:
    """{first_day, without, devices}: the first day a device was used, the number of
    activities with no device information and one entry per device, the last used first.
    `where` / `params` (a Time filter on start_time_utc, utc_offset_s) limit what is counted;
    which entries are one device, their names, `order` and the battery come from the whole
    history. A scale has only its weigh-ins."""
    rows, found = _devices(conn, person_id)
    only = None
    weighed = "SELECT ts AS start_time_utc, 0 AS utc_offset_s FROM"
    # every person's: _weigh_ins picks this one's
    times = f"{weighed} body_parts UNION {weighed} garmin_weights"
    if where:
        clause = " AND ".join(where)
        sql = f"SELECT id FROM activities WHERE person_id = ? AND {clause}"
        only = {r[0] for r in conn.execute(sql, [person_id, *params])}
        times = f"SELECT start_time_utc FROM ({times}) WHERE {clause}"
    keep = {r[0] for r in conn.execute(times, list(params) if where else [])}
    counted = [a for a in rows if only is None or a["id"] in only]
    without = sum(not (a["devices"] and json.loads(a["devices"])) for a in counted)
    # colours go by first use: the recording devices, then the scale
    found.sort(key=lambda d: (min(map(_age, d.activities.values())), d.key))
    scales = _scales(conn, person_id, keep)
    order_of = {d.key: i for i, d in enumerate(found)}
    for i, s in enumerate(scales):
        order_of[s["key"]] = len(found) + i
    names = Counter([d.ranked()[0][3] for d in found] + [s["name"] for s in scales])

    out = []
    for d in found:
        acts = [a for i, a in d.activities.items() if only is None or i in only]
        if not acts:
            continue
        acts.sort(key=_age)
        labels = d.ranked()
        kind, maker, product, name = labels[0]
        types: dict[str, int] = Counter(a["activity_type"] for a in acts)
        out.append({
            "key": d.key, "kind": kind, "maker": maker, "product": product, "name": name,
            "serial": d.serial,
            "weighins": None,
            "battery": d.latest_battery(),
            # every product it was listed as, the best first (the owner's photo is found by one)
            "products": list(dict.fromkeys(p for _, _, p, _ in labels if p)),
            "activities": len(acts),
            "time_s": sum(a["time_s"] or 0 for a in acts),
            "distance_m": sum(a["distance_m"] or 0 for a in acts),
            "ascent_m": sum(a["ascent_m"] or 0 for a in acts),
            "first": _moment(acts[0]),
            "last": _moment(acts[-1]),
            "spans": spans([date.fromisoformat(_moment(a)["day"]) for a in acts]),
            "last_start": acts[-1]["start_time_utc"],
            "types": [
                {"type": t, "activities": n}
                for t, n in sorted(types.items(), key=lambda x: (-x[1], x[0]))
            ],
        })  # fmt: skip
    for s in scales:
        del s["first_start"]
        out.append(s)
    for d in out:
        d["order"] = order_of[d["key"]]
        d["twin"] = names[d["name"]] > 1  # another device has the same name
    # the last used first; devices of the same last activity: the most used first
    out.sort(key=lambda d: (d["last_start"], d["time_s"] or 0, d["key"]), reverse=True)
    for d in out:
        del d["last_start"]
    first = min((d["first"]["day"] for d in out), default=None)
    return {"first_day": first, "without": without, "devices": out}
