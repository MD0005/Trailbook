"""Home Assistant sensors per person (SPEC §12c), only when running as an add-on.

Every person with activities gets the sensors of `KINDS` (VO2 max only when a watch estimated
it), switched on until the person switches one off (Home Assistant › Sensors). `publish` sends
the states that changed or that Home Assistant lost (a pushed state does not survive a restart
of Home Assistant), removes the sensors that are off or whose person is gone, and imports each
sensor's history into Home Assistant's long-term statistics: one value a day since the
person's first activity, a calendar year again only when its values change. How the values are
computed: docs/MANUAL.md › Sensors (Home Assistant).
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import sqlite3
import threading
import unicodedata
from datetime import date, timedelta

from . import analysis, db, hacards, homeassistant

log = logging.getLogger("trailbook.hasensors")

OFF_SETTING = "ha_sensors_off"  # ["<person id>/<key>"]: switched off by the person
SENT_SETTING = "ha_sensors_sent"  # {entity id: {"state": hash, "years": {year: hash}}}
WINDOW_DAYS = 28
VO2_UNIT = "mL/(kg·min)"
STAT_HOUR = "T12:00:00+00:00"  # the hour a day's value is filed under (that day almost anywhere)
MEAN_ARITHMETIC = 1  # Home Assistant's StatisticMeanType
_LOCK = threading.Lock()  # one publish at a time in this process

# key -> (name, unit, icon, what it shows)
KINDS = {
    "vo2max_run": (
        "VO2 max running",
        VO2_UNIT,
        "mdi:heart-pulse",
        "The watch's estimate after the latest run that has one.",
    ),
    "run_distance_28d": (
        "Running, 4 weeks",
        "km",
        "mdi:run",
        "Running distance of the last 28 days, today included.",
    ),
    "ride_distance_28d": (
        "Cycling, 4 weeks",
        "km",
        "mdi:bike",
        "Cycling distance of the last 28 days, today included; virtual and e-bike rides too.",
    ),
    "run_ride_distance_year": (
        "Running and cycling, this year",
        "km",
        "mdi:map-marker-distance",
        "Running and cycling distance since 1 January.",
    ),
    "distance_year": (
        "All activities, this year",
        "km",
        "mdi:sigma",
        "Distance of every activity since 1 January, whatever its type.",
    ),
    "distance_all_time": (
        "All activities, all time",
        "km",
        "mdi:map-marker-path",
        "Distance of every activity ever recorded, whatever its type.",
    ),
}


def slug(person_id: str) -> str:
    """A person's part of an entity id: ASCII letters, digits and underscores."""
    text = unicodedata.normalize("NFKD", person_id.replace("ł", "l").replace("Ł", "L"))
    text = text.encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "_", text).strip("_") or "person"


def _persons(c: sqlite3.Connection) -> list[tuple[str, str, str]]:
    """(id, label, slug) of everyone who can have sensors, in the order shown. Two ids with
    one slug: the person created later gets a number."""
    rows = c.execute(
        """SELECT id, label, sort_order FROM persons p
           WHERE archived = 0 AND id != '_unassigned' AND EXISTS (
                 SELECT 1 FROM activities a WHERE a.person_id = p.id AND NOT a.excluded)
           ORDER BY created_at, id"""
    ).fetchall()
    taken: set[str] = set()
    out = []
    for r in rows:
        base = slug(r["id"])
        name, n = base, 2
        while name in taken:
            name, n = f"{base}_{n}", n + 1
        taken.add(name)
        out.append((r["sort_order"], r["id"], r["label"], name))
    return [x[1:] for x in sorted(out, key=lambda x: (x[0] or 0, x[1]))]


def series(c: sqlite3.Connection, person_id: str, today: date) -> dict[str, list[tuple]]:
    """{key: [(day, value, attributes)]}: each sensor's value at the end of every day from the
    person's first activity to `today`. Activities excluded from the statistics add no
    distance (their VO2 max estimate counts, as on Fitness)."""
    rows = c.execute(
        f"""SELECT {analysis.LOCAL_DAY_SQL} AS day, category, distance_m, excluded,
                   json_extract(fit_metrics, '$.vo2max') AS vo2
            FROM activities WHERE person_id = ? ORDER BY start_time_utc, id""",
        (person_id,),
    ).fetchall()
    days: dict[date, list[float]] = {}  # day -> [run, ride, all] in m
    vo2: dict[date, float] = {}
    for r in rows:
        day = date.fromisoformat(r["day"])
        if r["category"] == "run" and r["vo2"] is not None:
            vo2[day] = r["vo2"]
        if r["excluded"]:
            continue
        sums = days.setdefault(day, [0.0, 0.0, 0.0])
        m = r["distance_m"] or 0.0
        if r["category"] in ("run", "ride"):
            sums[0 if r["category"] == "run" else 1] += m
        sums[2] += m

    out: dict[str, list[tuple]] = {k: [] for k in KINDS}
    if not rows:
        return out
    day = date.fromisoformat(rows[0]["day"])
    window = [0.0, 0.0]
    year = [0.0, 0.0, 0.0]
    total = 0.0
    estimate: tuple[float, date] | None = None
    none = (0.0, 0.0, 0.0)
    km = lambda m: round(m / 1000, 1) + 0.0  # noqa: E731 (+ 0.0: never "-0.0")
    while day <= today:
        new = days.get(day, none)
        gone = days.get(day - timedelta(days=WINDOW_DAYS), none)
        if day.month == day.day == 1:
            year = [0.0, 0.0, 0.0]
        window = [window[i] + new[i] - gone[i] for i in (0, 1)]
        year = [year[i] + new[i] for i in range(3)]
        total += new[2]
        if day in vo2:
            estimate = (round(vo2[day], 1), day)
        if estimate:
            out["vo2max_run"].append((day, estimate[0], {"date": estimate[1].isoformat()}))
        out["run_distance_28d"].append((day, km(window[0]), {}))
        out["ride_distance_28d"].append((day, km(window[1]), {}))
        parts = {"run_km": km(year[0]), "ride_km": km(year[1])}
        out["run_ride_distance_year"].append((day, km(year[0] + year[1]), parts))
        out["distance_year"].append((day, km(year[2]), {}))
        out["distance_all_time"].append((day, km(total), {}))
        day += timedelta(days=1)
    return out


def _list(c: sqlite3.Connection, key: str) -> list:
    return json.loads(db.get_setting(c, key) or "[]")


def sensors(c: sqlite3.Connection, today: date | None = None) -> list[dict]:
    """Every sensor there is, on or off: what it shows, its value now and its history."""
    today = today or date.today()
    off = set(_list(c, OFF_SETTING))
    out = []
    for pid, label, name_part in _persons(c):
        values = series(c, pid, today)
        for key, (name, unit, icon, tip) in KINDS.items():
            history = values[key]
            if not history:
                continue
            _, value, extra = history[-1]
            attributes = {
                "friendly_name": f"Trailbook {label} {name}",
                "unit_of_measurement": unit,
                "state_class": "measurement",
                **({"device_class": "distance"} if unit == "km" else {}),
                "icon": icon,
                **extra,
            }
            out.append({
                "person": pid, "person_label": label, "key": key,
                "entity_id": f"sensor.trailbook_{name_part}_{key}",
                "name": name, "tip": tip, "unit": unit, "value": value,
                "enabled": f"{pid}/{key}" not in off,
                "attributes": attributes, "history": [(d, v) for d, v, _ in history],
            })  # fmt: skip
    return out


def set_enabled(c: sqlite3.Connection, person_id: str, key: str, enabled: bool) -> bool:
    """Switch a sensor on or off. False when there is no such sensor."""
    if not any(s["person"] == person_id and s["key"] == key for s in sensors(c)):
        return False
    off = set(_list(c, OFF_SETTING)) - {f"{person_id}/{key}"}
    if not enabled:
        off.add(f"{person_id}/{key}")
    db.set_setting(c, OFF_SETTING, json.dumps(sorted(off)))
    return True


def _hash(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()[:16]


def _changed_years(item: dict, today: date, sent: dict) -> dict[str, tuple[str, list]]:
    """{year: (hash, statistics rows)} for the years whose past days Home Assistant does not
    have as they are now. Today is left to Home Assistant's own recording."""
    years: dict[str, list] = {}
    for day, value in item["history"]:
        if day < today:
            years.setdefault(str(day.year), []).append((day.isoformat(), value))
    out = {}
    for year, rows in years.items():
        digest = _hash(rows)
        if sent.get(year) != digest:
            out[year] = (digest, [
                {"start": day + STAT_HOUR, "mean": v, "min": v, "max": v} for day, v in rows
            ])  # fmt: skip
    return out


def _import_history(items: list[dict], today: date, sent: dict) -> None:
    """Send the changed years of every sensor over one websocket; `sent` notes what arrived."""
    todo = [(x, _changed_years(x, today, sent[x["entity_id"]]["years"])) for x in items]
    todo = [(x, years) for x, years in todo if years]
    if not todo:
        return
    with hacards.Ws() as ws:
        for item, years in todo:
            metadata = {
                "statistic_id": item["entity_id"], "source": "recorder", "name": None,
                "unit_of_measurement": item["unit"], "mean_type": MEAN_ARITHMETIC,
                "unit_class": "distance" if item["unit"] == "km" else None, "has_sum": False,
            }  # fmt: skip
            for year, (digest, stats) in sorted(years.items()):
                ws.call({"type": "recorder/import_statistics", "metadata": metadata,
                         "stats": stats})  # fmt: skip
                sent[item["entity_id"]]["years"][year] = digest


def publish(c: sqlite3.Connection, today: date | None = None) -> int:
    """Bring Home Assistant up to date. Returns the number of states sent; stops when Home
    Assistant does not answer (the next call tries again)."""
    if not homeassistant.available():
        return 0
    with _LOCK:
        return _publish(c, today or date.today())


def _publish(c: sqlite3.Connection, today: date) -> int:
    items = sensors(c, today)
    # a sensor that is gone and comes back is on again
    known = {f"{x['person']}/{x['key']}" for x in items}
    off = _list(c, OFF_SETTING)
    if set(off) - known:
        db.set_setting(c, OFF_SETTING, json.dumps([x for x in off if x in known]))
    sent: dict = json.loads(db.get_setting(c, SENT_SETTING) or "{}")
    wanted = {x["entity_id"]: x for x in items if x["enabled"]}
    pushed = 0
    try:
        for entity_id in [e for e in sent if e not in wanted]:
            if not homeassistant.remove_state(entity_id):
                return pushed
            del sent[entity_id]
        for entity_id, item in wanted.items():
            present = homeassistant.has_state(entity_id)
            if present is None:
                return pushed
            entry = sent.setdefault(entity_id, {"state": None, "years": {}})
            digest = _hash([item["value"], item["attributes"]])
            if present and entry["state"] == digest:
                continue
            if not homeassistant.set_state(entity_id, str(item["value"]), item["attributes"]):
                return pushed
            entry["state"] = digest
            pushed += 1
        try:
            _import_history(list(wanted.values()), today, sent)
        except (OSError, ValueError) as exc:
            log.warning("Sending the sensor history to Home Assistant failed: %s", exc)
    finally:
        db.set_setting(c, SENT_SETTING, json.dumps(sent))
    return pushed


def refresh_and_publish(c: sqlite3.Connection) -> None:
    """After an import: never fails the run."""
    try:
        publish(c)
    except Exception:  # noqa: BLE001 - sensors are extra; the import itself succeeded
        log.exception("Sensors for Home Assistant failed")
