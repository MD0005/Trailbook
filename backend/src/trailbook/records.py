"""Record events for Home Assistant: a new activity that took a top-3 place (all time or this
year) on a best effort or a segment.

An event needs an activity that is *new* (`activities.records_seen = 0`) and fully processed
(best efforts and segments computed), that started at most RECENT_DAYS ago and that beat a
result already on the list (rank <= the number of results the list had without it). So adding
or editing a segment, analysing again, deleting an activity or importing old history never
makes one. `refresh` runs after each import: it stores one event per record (who, what, the
result, the result it beat and when, by how much, and a ready notification: title, message,
icon, color) and marks the activities seen. `publish` pushes each new event once as the state
of `sensor.trailbook_records`; the automation in HA only shows it.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from datetime import UTC, datetime, timedelta

from . import analysis, homeassistant, segments, sports

log = logging.getLogger("trailbook.records")

ENTITY_ID = "sensor.trailbook_records"
TOP = 3
RECENT_DAYS = 14  # an older activity (history imported now) is no news
EVENTS_KEEP = 100  # stored
PUSH_DAYS = 2  # an event Home Assistant could not get for this long is not sent any more
STALE_DAYS = 3  # an activity still unprocessed after this is marked seen without events
SPORTS = ("run", "ride")  # activity groups with records (segments: the activity's group)
KINDS = ("pace", "ride", "longest", "within", "speed", "power")  # best efforts with records
YEAR_POWER_S = (1200, 3600)  # power: every duration of all time, these only for the year

# Best efforts ranked per (kind, key, v), with the activity's distance and elevation gain as more
# efforts (kinds "longest" and "ascent", key 0, value in m; higher is better) so they rank like
# the others.
# v = 1: an indoor ride's (virtual ride, trainer) distance, time over a distance and top speed -
# their own records (a trainer's speed is no road speed); their power counts with every ride.
VIRTUAL_KINDS = ("ride", "longest", "within", "speed", "ascent", "climb", "grade")
_VK = ", ".join(f"'{k}'" for k in VIRTUAL_KINDS)
EFFORTS_SQL = f"""(SELECT b.activity_id, b.kind, b.key, b.value, b.start_s, b.end_s,
        CASE WHEN b.kind IN ({_VK}) AND va.category = 'ride' AND va.indoor THEN 1 ELSE 0 END
            AS v
    FROM best_efforts b JOIN activities va ON va.id = b.activity_id
    UNION ALL
    SELECT id, 'longest', 0, distance_m, 0, elapsed_s,
        CASE WHEN category = 'ride' AND indoor THEN 1 ELSE 0 END
    FROM activities WHERE distance_m > 0 AND category IN ('run', 'ride')
    UNION ALL
    SELECT id, 'ascent', 0, ascent_m, 0, elapsed_s,
        CASE WHEN category = 'ride' AND indoor THEN 1 ELSE 0 END
    FROM activities WHERE ascent_m > 0 AND category IN ('run', 'ride'))"""

LOWER_IS_BETTER = ("pace", "ride", "segment")  # times; power and distance: higher
_ORDER = "CASE WHEN o.kind IN ('pace', 'ride') THEN o.value ELSE -o.value END"
_KIND_ORDER = ("pace", "ride", "longest", "within", "speed", "segment", "power")  # in a message


# ---- labels (decimal comma, space between thousands: the app's number format) ----------------


def num(v: float, digits: int = 0) -> str:
    s = f"{v:,.{digits}f}"
    return s.replace(",", " ").replace(".", ",")


def duration(s: float) -> str:
    """1:02:03, 4:05 or 0:42 (whole seconds)."""
    s = round(s)
    h, rest = divmod(s, 3600)
    m, sec = divmod(rest, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def _distance(m: float) -> str:
    if abs(m - 1609.344) < 1:
        return "1 mi"
    if m < 1000:
        return f"{num(m)} m"
    km = m / 1000
    return f"{num(km, 0 if km == int(km) else 1)} km"


def _span(s: float) -> str:
    if s < 60:
        return f"{num(s)} s"
    if s < 3600:
        return f"{num(s / 60)} min"
    h = s / 3600
    return f"{num(h, 0 if h == int(h) else 1)} h"


def key_label(kind: str, key: float) -> str:
    if kind in ("pace", "ride"):
        return _distance(key)
    if kind in ("power", "speed", "within"):
        return _span(key)
    return ""


def value_label(kind: str, v: float) -> str:
    if kind in LOWER_IS_BETTER:
        return duration(v)
    if kind == "power":
        return f"{num(v)} W"
    if kind == "speed":
        return f"{num(v * 3.6, 1)} km/h"
    return f"{num(v / 1000, 2)} km"


def delta_label(kind: str, d: float) -> str:
    """How much better: '12 s', '0,4 s', '1:05', '8 W', '1,25 km'."""
    if kind in LOWER_IS_BETTER:
        return f"{num(d, 1 if d < 10 else 0)} s" if d < 60 else duration(d)
    if kind == "power":
        return f"{num(d)} W"
    if kind == "speed":
        return f"{num(d * 3.6, 1)} km/h"
    return f"{num(d / 1000, 2)} km"


def speed_label(category: str | None, distance_m: float | None, s: float) -> str | None:
    """Pace for runs and walks (4:35 /km), speed for the rest (32,1 km/h)."""
    if not distance_m or not s:
        return None
    if category in sports.ON_FOOT_GROUPS:
        return f"{duration(s / distance_m * 1000)} /km"
    return f"{num(distance_m / s * 3.6, 1)} km/h"


# ---- ranking ----------------------------------------------------------------------------


def _local_date(start_utc: str, offset_s: int | None) -> str:
    t = datetime.strptime(start_utc, "%Y-%m-%dT%H:%M:%SZ") + timedelta(seconds=offset_s or 0)
    return t.strftime("%Y-%m-%d")


def _ranked(c: sqlite3.Connection, year: str | None) -> list[sqlite3.Row]:
    """Rows that are on a top-3 list now (rk) or were before the new activities (rk_old), for
    best efforts and segments of runs and rides (SPORTS, KINDS); `year` limits to that year
    (and power to YEAR_POWER_S)."""
    sports_in = ", ".join(f"'{g}'" for g in SPORTS)
    yf = f"a.category IN ({sports_in})"
    params: list = []
    if year:
        yf += " AND substr(a.start_time_utc, 1, 4) = ?"
        params = [year]
    kinds_in = ", ".join(f"'{k}'" for k in KINDS)
    kf = f"o.kind IN ({kinds_in})"
    if year:
        keys = ", ".join(str(k) for k in YEAR_POWER_S)
        kf += f" AND (o.kind != 'power' OR o.key IN ({keys}))"
    cols = """a.person_id, a.id AS activity_id, a.start_time_utc, a.utc_offset_s,
              a.records_seen AS seen"""
    rank = """ROW_NUMBER() OVER (PARTITION BY person_id, list_key ORDER BY ord, start_time_utc)
                  AS rk,
              CASE WHEN seen THEN ROW_NUMBER() OVER (
                  PARTITION BY person_id, list_key, seen ORDER BY ord, start_time_utc)
              END AS rk_old"""
    return c.execute(
        f"""WITH e AS (
                SELECT {cols}, a.category, o.kind, o.key, o.value, o.v, NULL AS segment_id,
                       'e:' || a.category || ':' || o.kind || ':' || o.key || ':' || o.v
                           AS list_key,
                       {_ORDER} AS ord
                FROM {EFFORTS_SQL} o JOIN activities a ON a.id = o.activity_id
                WHERE a.person_id IN (SELECT id FROM persons WHERE archived = 0) AND {yf}
                  AND {kf}
                UNION ALL
                SELECT {cols}, s.category, 'segment', 0, se.elapsed_s, 0, s.id,
                       's:' || s.id, se.elapsed_s
                FROM segment_efforts se JOIN activities a ON a.id = se.activity_id
                JOIN segments s ON s.id = se.segment_id
                WHERE a.person_id IN (SELECT id FROM persons WHERE archived = 0) AND {yf}),
            r AS (SELECT e.*, {rank} FROM e)
            SELECT * FROM r WHERE rk <= {TOP} OR rk_old <= {TOP}
            ORDER BY person_id, list_key, rk""",
        params * 2,
    ).fetchall()


def _lists(rows: list[sqlite3.Row]) -> dict[tuple[str, str], dict]:
    """(person, list) -> {'now': rows ranked now, 'old': rows ranked without new activities}."""
    out: dict[tuple[str, str], dict] = {}
    for r in rows:
        lst = out.setdefault((r["person_id"], r["list_key"]), {"now": [], "old": []})
        if r["rk"] <= TOP:
            lst["now"].append(r)
        if r["rk_old"] is not None and r["rk_old"] <= TOP:
            lst["old"].append(r)
    for lst in out.values():
        lst["old"].sort(key=lambda r: r["rk_old"])
    return out


def _entry(r: sqlite3.Row) -> dict:
    return {
        "value": round(r["value"], 1),
        "label": value_label(r["kind"], r["value"]),
        "activity_id": r["activity_id"],
        "date": _local_date(r["start_time_utc"], r["utc_offset_s"]),
    }


def _placing(lst: dict, aid: int) -> dict | None:
    """The activity's place on one list if it beat a result that was there (else None)."""
    mine = [r for r in lst["now"] if r["activity_id"] == aid]
    if not mine:
        return None
    best = mine[0]  # a segment ridden twice: the faster effort
    rank, old = best["rk"], lst["old"]
    if rank > len(old):  # the list had a free place: nothing beaten
        return None
    beaten = old[rank - 1]
    lower = best["kind"] in LOWER_IS_BETTER
    d = (beaten["value"] - best["value"]) if lower else (best["value"] - beaten["value"])
    return {
        "rank": rank,
        "beaten": _entry(beaten),
        "delta": round(d, 1),
        "delta_label": delta_label(best["kind"], d),
    }


# ---- events -----------------------------------------------------------------------------


def _processed(a: sqlite3.Row) -> bool:
    return (
        a["analysis_version"] >= analysis.ANALYSIS_VERSION
        and a["segments_version"] >= segments.MATCH_VERSION
    )


def refresh(c: sqlite3.Connection, now: datetime | None = None) -> list[dict]:
    """Find the records of new, processed activities and store one event per record (its best
    place: all time before this year), mark the activities seen. Returns the new events."""
    now = now or datetime.now(UTC)
    new = c.execute(
        """SELECT id, start_time_utc, created_at, analysis_version, segments_version
           FROM activities WHERE records_seen = 0"""
    ).fetchall()
    if not new:
        return []
    recent = (now - timedelta(days=RECENT_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    stale = (now - timedelta(days=STALE_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    candidates = {a["id"] for a in new if _processed(a) and a["start_time_utc"] >= recent}
    found: dict[tuple[int, str], dict] = {}  # (activity, list key) -> record
    if candidates:
        year = now.strftime("%Y")
        for scope, rows in (("all", _ranked(c, None)), ("year", _ranked(c, year))):
            for (_pid, list_key), lst in _lists(rows).items():
                for aid in {r["activity_id"] for r in lst["now"]} & candidates:
                    placing = _placing(lst, aid)
                    if placing is None:
                        continue
                    row = next(r for r in lst["now"] if r["activity_id"] == aid)
                    found.setdefault((aid, list_key), _record(c, row))[scope] = placing
    events = []
    created = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    for rec in sorted(found.values(), key=lambda r: (r["activity_id"], r.pop("sort"))):
        ev = _event(c, rec)
        cur = c.execute(
            """INSERT INTO record_events (created_at, person_id, activity_id, data)
               VALUES (?, ?, ?, ?)""",
            (created, ev["person"], ev["activity_id"], json.dumps(ev, ensure_ascii=False)),
        )
        events.append({"id": cur.lastrowid, "created_at": created, **ev})
    done = [a["id"] for a in new if _processed(a) or a["created_at"] < stale]
    c.executemany("UPDATE activities SET records_seen = 1 WHERE id = ?", [(i,) for i in done])
    c.execute(
        "DELETE FROM record_events WHERE id <= (SELECT MAX(id) FROM record_events) - ?",
        (EVENTS_KEEP,),
    )
    return events


def _record(c: sqlite3.Connection, r: sqlite3.Row) -> dict:
    """One list the activity placed on: what and the result; its places are filled later."""
    kind = r["kind"]
    rec = {
        "activity_id": r["activity_id"],
        "category": r["category"],
        "kind": kind,
        "key": r["key"],
        "key_label": key_label(kind, r["key"]),
        "value": round(r["value"], 1),
        "label": value_label(kind, r["value"]),
        "speed": None,
        "virtual": bool(r["v"]),
        "segment": None,
        "all": None,
        "year": None,
        "sort": (_KIND_ORDER.index(kind), r["category"] or "", r["key"], r["segment_id"] or 0),
    }
    if kind in ("pace", "ride"):
        rec["speed"] = speed_label(r["category"], r["key"], r["value"])
    if r["segment_id"] is not None:
        s = c.execute(
            "SELECT id, name, distance_m, category FROM segments WHERE id = ?",
            (r["segment_id"],),
        ).fetchone()
        rec["segment"] = {"id": s["id"], "name": s["name"], "distance_m": round(s["distance_m"])}
        cat = (
            s["category"]
            or c.execute(  # a segment for any sport: the activity's
                "SELECT category FROM activities WHERE id = ?", (r["activity_id"],)
            ).fetchone()[0]
        )
        rec["speed"] = speed_label(cat, s["distance_m"], r["value"])
    return rec


def _event(c: sqlite3.Connection, rec: dict) -> dict:
    """The event of one record: who, which activity, the record, its place (all time if it has
    one, else this year) and the notification text."""
    a = c.execute(
        """SELECT a.person_id, p.label, a.name, a.activity_type, a.start_time_utc,
                  a.utc_offset_s
           FROM activities a JOIN persons p ON p.id = a.person_id WHERE a.id = ?""",
        (rec["activity_id"],),
    ).fetchone()
    scope = "all" if rec["all"] else "year"
    ev = {
        "person": a["person_id"],
        "person_label": a["label"],
        "activity_name": a["name"],
        "activity_type": a["activity_type"],
        "start": _local_date(a["start_time_utc"], a["utc_offset_s"]),
        **rec,
        "scope": scope,
        "rank": rec[scope]["rank"],
    }
    ev.update(notification(ev))
    return ev


# ---- notification text (the style of the other notifications in Home Assistant) -----------

COLOR = "#E8B86D"
_WHAT = {
    "pace": "run {k}",
    "ride": "{v}ride {k}",
    "speed": "{v}top speed {k}",
    "power": "{c} power {k}",
    "longest": "longest {v}{c}",
    "within": "{v}{c} distance in {k}",
    "segment": "segment {s}",
}
_ICON = {
    ("all", 1): "mdi:trophy",
    ("all", 2): "mdi:trophy-variant-outline",
    ("all", 3): "mdi:trophy-variant-outline",
    ("year", 1): "mdi:medal",
    ("year", 2): "mdi:medal-outline",
    ("year", 3): "mdi:medal-outline",
}


def _nth(n: int) -> str:
    return f"{n}{ {1: 'st', 2: 'nd', 3: 'rd'}.get(n, 'th') }"


def notification(ev: dict) -> dict:
    """title, message, icon, color of a record event, e.g.
    ALL-TIME RECORD / 'Asia · run 5 km · 21:20 (4:16 /km)' /
    '20 s better than 21:40 on 2024-05-01'."""
    scope, rank, year = ev["scope"], ev["rank"], ev["start"][:4]
    if scope == "all":
        title = "ALL-TIME RECORD" if rank == 1 else f"ALL-TIME {_nth(rank).upper()} BEST"
    else:
        title = f"{year} RECORD" if rank == 1 else f"{year} {_nth(rank).upper()} BEST"
    group = sports.GROUPS.get(ev["category"] or "")
    cat = (group[0] if group else ev["category"] or "").lower()
    seg = ev["segment"]["name"] if ev["segment"] else ""
    virtual = "virtual " if ev.get("virtual") else ""
    what = _WHAT[ev["kind"]].format(k=ev["key_label"], c=cat, s=seg, v=virtual)
    speed = f" ({ev['speed']})" if ev["speed"] else ""
    p = ev[scope]
    beaten = p["beaten"]
    second = f"{p['delta_label']} better than {beaten['label']} on {beaten['date']}"
    if scope == "all" and ev["year"] and ev["year"]["rank"] < rank:
        second += f" · {year} record"  # e.g. 2nd of all time and the best this year
    return {
        "title": title,
        "message": f"{ev['person_label']} · {what} · {ev['label']}{speed}\n{second}",
        "icon": _ICON[(scope, rank)],
        "color": COLOR,
    }


# ---- the sensor ---------------------------------------------------------------------------


def _stored(r: sqlite3.Row) -> dict:
    return {"id": r["id"], "created_at": r["created_at"], **json.loads(r["data"])}


def latest(c: sqlite3.Connection) -> dict | None:
    r = c.execute(
        "SELECT id, created_at, data FROM record_events ORDER BY id DESC LIMIT 1"
    ).fetchone()
    return _stored(r) if r else None


def payload(ev: dict | None) -> dict:
    """The sensor for one event: state = its id (a new event = a new state), attributes =
    the event. No event: state 0."""
    attrs = {"friendly_name": "Trailbook records", "icon": "mdi:trophy"}  # the event's icon wins
    if ev is None:
        return {"state": "0", "attributes": attrs}
    return {"state": str(ev["id"]), "attributes": {**attrs, **ev}}


def unpushed(c: sqlite3.Connection) -> bool:
    row = c.execute("SELECT 1 FROM record_events WHERE pushed_at IS NULL LIMIT 1").fetchone()
    return row is not None


def publish(c: sqlite3.Connection, now: datetime | None = None) -> int:
    """Push every event Home Assistant has not had yet, oldest first: each one is a new state,
    so the automation runs for each. One older than PUSH_DAYS is dropped unsent (HA was away
    too long). Stops at the first failure; the next call tries again. Returns events pushed."""
    if not homeassistant.available():
        return 0
    now = now or datetime.now(UTC)
    stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    oldest = (now - timedelta(days=PUSH_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    c.execute(
        "UPDATE record_events SET pushed_at = ? WHERE pushed_at IS NULL AND created_at < ?",
        (stamp, oldest),
    )
    pushed = 0
    rows = c.execute(
        "SELECT id, created_at, data FROM record_events WHERE pushed_at IS NULL ORDER BY id"
    ).fetchall()
    if not rows:
        return 0
    # A record always arrives as a change from a number (0 or the previous record): after an
    # HA restart the sensor is first created with 0. The automation ignores a sensor that
    # appears, so an event sent again after a restart can never notify twice.
    present = homeassistant.has_state(ENTITY_ID)
    if present is None or (present is False and not ensure_sensor()):
        return 0
    for r in rows:
        p = payload(_stored(r))
        if not homeassistant.set_state(ENTITY_ID, p["state"], p["attributes"]):
            break
        c.execute("UPDATE record_events SET pushed_at = ? WHERE id = ?", (stamp, r["id"]))
        pushed += 1
    return pushed


def ensure_sensor() -> bool:
    """Create the sensor with state 0 (no new record) when Home Assistant does not have it:
    before the first record and after every HA restart. The automation ignores 0, so this
    never repeats a notification. True when it was created."""
    if not homeassistant.available() or homeassistant.has_state(ENTITY_ID) is not False:
        return False
    p = payload(None)
    return homeassistant.set_state(ENTITY_ID, p["state"], p["attributes"])


def refresh_and_publish(c: sqlite3.Connection) -> None:
    """After an import: never fails the run."""
    try:
        new = refresh(c)
        if new:
            log.info("%d record events", len(new))
        publish(c)
    except Exception:  # noqa: BLE001 - records are extra; the import itself succeeded
        log.exception("records refresh failed")
