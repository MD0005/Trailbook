"""Gear › Equipment (SPEC §12d): shoes, bikes and other equipment, each followed by a Home
Assistant distance sensor (in practice a gear sensor of a Garmin Connect integration), only
when running as an add-on.

A person picks the sensors and names them (ui setting `equipment`). The sensor's state is the
equipment's distance now, its attributes (when it has them) the number of activities, the time,
the limit and whether it is retired. When it was used comes from Home Assistant's long-term
statistics of the sensor: every day its distance grew. Each growth is paired with the
activities that made it (`match`). How: docs/MANUAL.md › Gear › Equipment.
"""

from __future__ import annotations

import itertools
import json
import logging
import sqlite3
import time
from bisect import bisect_left, bisect_right
from collections import Counter
from datetime import UTC, date, datetime, timedelta

from . import analysis, gear, hacards, homeassistant

log = logging.getLogger("trailbook.equipment")

SETTING = "equipment"  # ui setting of a person: [{"entity", "label"}]
TO_KM = {"km": 1.0, "m": 0.001, "mi": 1.609344}
MIN_USE_KM = 0.3  # a smaller growth in a day is no use of it (rounding, small corrections)
TOLERANCE, MIN_TOLERANCE_KM = 0.03, 0.2  # activities and growth may differ by this much
# (days back from the growth, several activities together): the closest pairing first, then
# sums of activities, then the same for a sensor that was updated late
PASSES = ((3, False), (3, True), (14, False), (14, True))
MAX_TOGETHER = 4  # activities that can make one growth
POOL = 16  # the newest activities of the window looked at
# what an equipment can be used for: activity groups; the one that explains most of the growth
SPORTS = {
    "foot": ("run", "walk", "hike"),
    "wheel": ("ride",),
    "winter": ("winter",),
    "water": ("water",),
    "swim": ("swim",),
}
HISTORY_TTL_S = 120  # the statistics are asked for again after this long
_cache: dict[tuple, tuple[float, dict]] = {}


def tracked(c: sqlite3.Connection, person_id: str) -> list[dict]:
    """The person's equipment as picked: [{entity, label}], each sensor once."""
    r = c.execute(
        "SELECT value FROM ui_settings WHERE person_id = ? AND key = ?", (person_id, SETTING)
    ).fetchone()
    value = json.loads(r[0]) if r else []
    out: dict[str, dict] = {}
    for x in value if isinstance(value, list) else []:
        entity = x.get("entity") if isinstance(x, dict) else None
        if isinstance(entity, str) and entity.startswith("sensor."):
            out.setdefault(entity, {"entity": entity, "label": str(x.get("label") or entity)})
    return list(out.values())


def _number(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def sensors() -> list[dict]:
    """The distance sensors Home Assistant has, those of a gear first:
    {entity, name, km, gear}."""
    out = []
    for s in homeassistant.get_json("states") or []:
        entity, attrs = str(s.get("entity_id") or ""), s.get("attributes") or {}
        unit, is_gear = attrs.get("unit_of_measurement"), bool(attrs.get("gear_uuid"))
        if not entity.startswith("sensor.") or unit not in TO_KM:
            continue
        if not is_gear and attrs.get("device_class") != "distance":
            continue
        # Trailbook's own distance sensors are no equipment
        if entity.startswith("sensor.trailbook_"):
            continue
        value = _number(s.get("state"))
        out.append({
            "entity": entity,
            "name": attrs.get("custom_make_model") or attrs.get("friendly_name") or entity,
            "km": None if value is None else round(value * TO_KM[unit], 1),
            "gear": is_gear,
        })  # fmt: skip
    return sorted(out, key=lambda x: (not x["gear"], str(x["name"]).lower(), x["entity"]))


def _history(entities: list[str]) -> dict[str, list[tuple[date, float]]]:
    """{entity: [(day, growth in km)]} for every day Home Assistant has statistics of,
    oldest first. Raises OSError / ValueError when Home Assistant does not answer."""
    key = tuple(sorted(entities))
    known = _cache.get(key)
    if known and time.monotonic() - known[0] < HISTORY_TTL_S:
        return known[1]
    with hacards.Ws() as ws:
        found = ws.call({
            "type": "recorder/statistics_during_period",
            "start_time": "2000-01-01T00:00:00+00:00",
            "statistic_ids": list(key),
            "period": "day",
            "types": ["change"],
            "units": {"distance": "km"},
        })  # fmt: skip
    out = {}
    for entity, rows in (found or {}).items():
        # a day starts at local midnight: noon of it is the same date in UTC
        out[entity] = [
            (
                datetime.fromtimestamp(r["start"] / 1000 + 43200, UTC).date(),
                r.get("change") or 0.0,
            )
            for r in rows
        ]
    _cache[key] = (time.monotonic(), out)
    return out


def _combos(km: float, pool: list, together: bool) -> list[tuple]:
    """(difference, activities) for the activities of `pool` that add up to `km`: single ones,
    or (`together`) the smallest number of several."""
    allowed = max(km * TOLERANCE, MIN_TOLERANCE_KM)
    for n in range(2, MAX_TOGETHER + 1) if together else (1,):
        found = []
        for combo in itertools.combinations(pool, n):
            off = abs(sum(a[2] for a in combo) - km)
            if off <= allowed:
                found.append((off, combo))
        if found:
            return found
    return []


def match(
    events: list[tuple[date, float]], activities: list[tuple[int, date, float]], passes=PASSES
) -> dict[int, list[int]]:
    """{index of an event: ids of its activities}. `events`: (day, km grown); `activities`:
    (id, local day, km), by day. A growth is made by activities of its day or of the days
    before it (a day after: another time zone); each activity once. In every pass the closest
    pairs are taken first."""
    days = [a[1] for a in activities]
    used: set[int] = set()
    out: dict[int, list[int]] = {}
    for back, together in passes:
        found = []
        for i, (day, km) in enumerate(events):
            if i in out:
                continue
            first = bisect_left(days, day - timedelta(days=back))
            last = bisect_right(days, day + timedelta(days=1))
            pool = [a for a in reversed(activities[first:last]) if a[0] not in used][:POOL]
            for off, combo in _combos(km, pool, together):
                age = (day - max(a[1] for a in combo)).days
                found.append((off / km, abs(age), i, [a[0] for a in combo]))
        for _, _, i, ids in sorted(found, key=lambda x: x[:3]):
            if i not in out and not used.intersection(ids):
                out[i] = ids
                used.update(ids)
    return out


def _sport(events: list, activities: dict[str, list]) -> tuple[str | None, dict]:
    """The sport whose activities explain the most kilometres, and that pairing."""
    best: tuple[float, str | None, dict] = (0.0, None, {})
    for sport, found in activities.items():
        if not found:
            continue
        single = match(events, found, passes=((14, False),))
        km = sum(events[i][1] for i in single)
        if km > best[0]:
            best = (km, sport, single)
    if best[1] is None:
        return None, {}
    return best[1], match(events, activities[best[1]])


def _activities(c: sqlite3.Connection, person_id: str) -> tuple[dict, dict]:
    """{sport: [(id, day, km)]} by day, and {id: (type, day)}. Excluded ones are left out."""
    rows = c.execute(
        f"""SELECT id, {analysis.LOCAL_DAY_SQL} AS day, category, activity_type, distance_m
            FROM activities WHERE person_id = ? AND NOT excluded AND distance_m > 0
            ORDER BY day, start_time_utc, id""",
        (person_id,),
    ).fetchall()
    by_sport: dict[str, list] = {s: [] for s in SPORTS}
    about = {}
    for r in rows:
        day = date.fromisoformat(r["day"])
        about[r["id"]] = (r["activity_type"], day)
        for sport, groups in SPORTS.items():
            if r["category"] in groups:
                by_sport[sport].append((r["id"], day, r["distance_m"] / 1000))
    return by_sport, about


def _picture(sport: str | None, types: Counter, defaults: list) -> str:
    """The drawing of an equipment: from what it was used for, else its Garmin default."""
    total = sum(types.values())
    if sport == "wheel":
        if sum(n for t, n in types.items() if "virtual" in t or "indoor" in t) * 2 > total:
            return "trainer"
        if sum(n for t, n in types.items() if t.startswith("ebike")) * 2 > total:
            return "ebike"
        return "bike"
    if sport == "foot" or (sport is None and "running" in defaults):
        return "shoe"
    return "bike" if sport is None and "cycling" in defaults else "equipment"


def _item(
    person_equipment: dict, state: dict | None, history: list, by_sport: dict, about: dict
) -> tuple[dict, set[int]]:
    attrs = (state or {}).get("attributes") or {}
    unit = TO_KM.get(attrs.get("unit_of_measurement"))
    value = _number((state or {}).get("state"))
    events = [(day, km) for day, km in history if km >= MIN_USE_KM]
    sport, pairs = _sport(events, by_sport)
    paired = {i for ids in pairs.values() for i in ids}
    types = Counter(about[i][0] for i in paired)

    def use(index: int) -> dict:
        ids = pairs.get(index)
        return {"day": events[index][0].isoformat(), "activity_id": ids[0] if ids else None}

    limit = _number(attrs.get("maximum_meters"))
    count = _number(attrs.get("total_activities"))
    item = {
        "key": person_equipment["entity"],
        "entity": person_equipment["entity"],
        "label": person_equipment["label"],
        "missing": state is None,
        "km": None if value is None or unit is None else round(value * unit, 1),
        "limit_km": round(limit / 1000) if limit else None,
        "activities": None if count is None else int(count),
        "time_s": _number(attrs.get("total_duration_seconds")),
        "retired": attrs.get("gear_status_name") == "retired",
        "data_from": history[0][0].isoformat() if history else None,
        "spans": gear.spans([day for day, _ in events]) if events else [],
        "first": use(0) if events else None,
        "last": use(len(events) - 1) if events else None,
        "uses": len(events),
        "paired": len(paired),
        "types": [
            {"type": t, "activities": n}
            for t, n in sorted(types.items(), key=lambda x: (-x[1], x[0]))
        ],
        "kind": _picture(sport, types, attrs.get("default_for_activity") or []),
    }
    return item, paired


def _try_history(chosen: list[dict]) -> tuple[dict, bool]:
    """The history of `chosen`, and whether it could be read."""
    if not chosen:
        return {}, True
    try:
        return _history([x["entity"] for x in chosen]), True
    except (OSError, ValueError) as exc:
        log.warning("Reading the equipment history from Home Assistant failed: %s", exc)
        return {}, False


def _read(c: sqlite3.Connection, person_id: str, chosen: list[dict], history: dict) -> list:
    """[(item, paired activity ids)] for `chosen`."""
    if not chosen:
        return []
    by_sport, about = _activities(c, person_id)
    return [
        _item(
            x,
            homeassistant.get_json(f"states/{x['entity']}"),
            history.get(x["entity"], []),
            by_sport,
            about,
        )
        for x in chosen
    ]


def summary(c: sqlite3.Connection, person_id: str) -> dict:
    """{addon, history, first_day, items}: the person's equipment, the most distance first."""
    if not homeassistant.available():
        return {"addon": False, "history": False, "first_day": None, "items": []}
    chosen = tracked(c, person_id)
    history, ok = _try_history(chosen)
    items = [item for item, _ in _read(c, person_id, chosen, history)]
    for order, item in enumerate(items):
        item["order"] = order  # its colour: the order the equipment was added in
    items.sort(key=lambda x: (-(x["km"] or 0), x["order"]))
    first = min((x["data_from"] for x in items if x["data_from"]), default=None)
    return {"addon": True, "history": ok, "first_day": first, "items": items}


def activity_ids(c: sqlite3.Connection, person_id: str, entity: str) -> tuple[dict, list[int]]:
    """An equipment ({name}) and the activities paired with it; ({}, []) for an unknown one."""
    chosen = [x for x in tracked(c, person_id) if x["entity"] == entity]
    if not chosen or not homeassistant.available():
        return {}, []
    found = _read(c, person_id, chosen, _try_history(chosen)[0])
    return {"name": chosen[0]["label"]}, sorted(found[0][1])


def of_activity(c: sqlite3.Connection, activity_id: int) -> list[dict]:
    """The equipment paired with an activity: [{key, label, kind}]."""
    if not homeassistant.available():
        return []
    r = c.execute(
        f"""SELECT person_id, category, {analysis.LOCAL_DAY_SQL} AS day FROM activities
            WHERE id = ? AND NOT excluded AND distance_m > 0""",
        (activity_id,),
    ).fetchone()
    if not r or not any(r["category"] in groups for groups in SPORTS.values()):
        return []
    chosen = tracked(c, r["person_id"])
    history = _try_history(chosen)[0]
    # only a growth near the activity's day can be made by it: the others are not worked out
    day = date.fromisoformat(r["day"])
    first, last = day - timedelta(days=1), day + timedelta(days=max(b for b, _ in PASSES))
    near = [
        x
        for x in chosen
        if any(first <= d <= last and km >= MIN_USE_KM for d, km in history.get(x["entity"], []))
    ]
    return [
        {k: item[k] for k in ("key", "label", "kind")}
        for item, paired in _read(c, r["person_id"], near, history)
        if activity_id in paired
    ]
