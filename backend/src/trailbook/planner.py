"""Planned workouts: the person's workout templates, their estimates and the text that goes to
intervals.icu (which sends it on to Garmin Connect and the watch).

A workout is JSON: ``{"sport": "run"|"ride", "target": "hr"|"power", "steps": [...]}``.
A step::

    {"type": "warmup"|"active"|"recovery"|"rest"|"cooldown",
     "length": {"kind": "time"|"distance", "value": seconds | metres},
     "target": {"zone": [lo, hi]} | {"bpm": [lo, hi]} | {"watts": [lo, hi]} | None,
     "cue": "text shown on the watch"}

and a repeat ``{"repeat": n, "steps": [step, ...]}`` (one level, as intervals.icu allows).

Only what reliably reaches a Garmin watch through intervals.icu is allowed: lengths in time or
distance; heart rate targets (zones or a bpm range) for runs and rides, power targets (zones or
a watt range) for rides; repeats one level deep. Zones are Garmin's zones of the person's latest
activity of the sport and are sent as numbers (% of threshold heart rate, watts), so the watch
shows the same limits whatever zones intervals.icu has.

Estimates (time, distance, load, kind) are rough on purpose: docs/MANUAL.md › Planned workouts.
"""

from __future__ import annotations

import json
import math
import re
import sqlite3

SPORTS = {"run": "Run", "ride": "Ride"}  # sport -> intervals.icu event type
TARGETS = {"run": ("hr", "pace"), "ride": ("hr", "power")}
STEP_TYPES = ("warmup", "active", "recovery", "rest", "cooldown")
MAX_REPEAT = 50
MAX_WATCH_STEPS = 50  # steps and repeats as the watch counts them
MAX_TIME_S = 6 * 3600
MAX_DIST_M = 200_000
HR_ZONES = 5
POWER_ZONES = 7

# Speed at each zone, as a share of the person's usual speed (median of recent activities).
SPEED_SHARE = {
    "hr": (0.85, 0.93, 1.0, 1.07, 1.13),
    "power": (0.8, 0.9, 0.97, 1.03, 1.08, 1.12, 1.15),
}
DEFAULT_SPEED = {"run": 2.8, "ride": 7.0}  # m/s without recent activities
# Intensity at each zone: load per hour = intensity² × 100 (as for an activity).
INTENSITY = {"hr": (0.55, 0.7, 0.82, 0.92, 1.02), "power": (0.5, 0.65, 0.82, 0.97, 1.12, 1.3, 1.5)}
REST_ZONE = 1.0  # a step without a target counts as zone 1
RECENT = 10  # activities for the usual speed
# Kind: intervals = a repeat with work in zone ≥ this; tempo = a steady step this long in
# zone ≥ TEMPO_ZONE; long = at least LONG_S; else easy.
INTERVAL_ZONE = 4
TEMPO_ZONE = 3
TEMPO_MIN_S = 10 * 60
LONG_S = 90 * 60

RULES = {
    "speed_share": SPEED_SHARE, "default_speed": DEFAULT_SPEED, "intensity": INTENSITY,
    "interval_zone": INTERVAL_ZONE, "tempo_zone": TEMPO_ZONE, "tempo_min_s": TEMPO_MIN_S,
    "long_s": LONG_S, "max_watch_steps": MAX_WATCH_STEPS, "recent": RECENT,
}  # fmt: skip


class PlanError(ValueError):
    """The workout is not valid (the message says why, for the person)."""


# ---- starter templates ---------------------------------------------------------------------


def _s(kind: str, length: tuple[str, float], target: dict | None, cue: str = "") -> dict:
    return {"type": kind, "length": {"kind": length[0], "value": length[1]}, "target": target,
            "cue": cue}  # fmt: skip


def _z(lo: int, hi: int | None = None) -> dict:
    return {"zone": [lo, hi or lo]}


STARTERS = [
    {"name": "5 × 1 km VO2max", "sport": "run", "target": "hr", "steps": [
        _s("warmup", ("time", 900), _z(1, 2)),
        {"repeat": 5, "steps": [_s("active", ("distance", 1000), _z(5)),
                                _s("recovery", ("time", 150), _z(1))]},
        _s("cooldown", ("time", 600), _z(1))]},
    {"name": "3 × 10 min threshold", "sport": "run", "target": "hr", "steps": [
        _s("warmup", ("time", 900), _z(1, 2)),
        {"repeat": 3, "steps": [_s("active", ("time", 600), _z(4)),
                                _s("recovery", ("time", 120), _z(1))]},
        _s("cooldown", ("time", 600), _z(1))]},
    {"name": "2 × 20 min FTP", "sport": "ride", "target": "power", "steps": [
        _s("warmup", ("time", 900), _z(1, 2)),
        {"repeat": 2, "steps": [_s("active", ("time", 1200), _z(4)),
                                _s("recovery", ("time", 300), _z(1))]},
        _s("cooldown", ("time", 600), _z(1))]},
    {"name": "5 × 3 min VO2max", "sport": "ride", "target": "power", "steps": [
        _s("warmup", ("time", 900), _z(1, 2)),
        {"repeat": 5, "steps": [_s("active", ("time", 180), _z(5)),
                                _s("recovery", ("time", 180), _z(1))]},
        _s("cooldown", ("time", 780), _z(1))]},
    {"name": "Tempo 25 min", "sport": "run", "target": "hr", "steps": [
        _s("warmup", ("time", 900), _z(1, 2)),
        _s("active", ("time", 1500), _z(3)),
        _s("cooldown", ("time", 600), _z(1))]},
    {"name": "Long run 90 min", "sport": "run", "target": "hr", "steps": [
        _s("active", ("time", 5400), _z(2))]},
    {"name": "Tempo 30 min", "sport": "ride", "target": "power", "steps": [
        _s("warmup", ("time", 900), _z(1, 2)),
        _s("active", ("time", 1800), _z(3)),
        _s("cooldown", ("time", 600), _z(1))]},
    {"name": "Endurance 2 h", "sport": "ride", "target": "power", "steps": [
        _s("active", ("time", 7200), _z(2))]},
]  # fmt: skip


# ---- validation ----------------------------------------------------------------------------


def _pair(v, lo: float, hi: float, what: str) -> list:
    if not isinstance(v, (list, tuple)) or len(v) != 2:
        raise PlanError(f"{what}: two values expected")
    try:
        a, b = sorted(float(x) for x in v)
    except (TypeError, ValueError) as exc:
        raise PlanError(f"{what}: numbers expected") from exc
    if a < lo or b > hi:
        raise PlanError(f"{what}: between {lo:g} and {hi:g}")
    return [int(a) if a.is_integer() else a, int(b) if b.is_integer() else b]


def _clean_step(s: dict, target_kind: str) -> dict:
    if not isinstance(s, dict) or s.get("type") not in STEP_TYPES:
        raise PlanError("unknown step type")
    ln = s.get("length") or {}
    kind, value = ln.get("kind"), ln.get("value")
    try:
        value = float(value)
    except (TypeError, ValueError) as exc:
        raise PlanError("step length must be a number") from exc
    if kind == "time" and not 5 <= value <= MAX_TIME_S:
        raise PlanError("step time must be between 5 s and 6 h")
    if kind == "distance" and not 10 <= value <= MAX_DIST_M:
        raise PlanError("step distance must be between 10 m and 200 km")
    if kind not in ("time", "distance"):
        raise PlanError("step length must be time or distance")
    t = s.get("target")
    target = None
    if t:
        if "zone" in t:
            target = {
                "zone": _pair(
                    t["zone"], 1, HR_ZONES if target_kind == "hr" else POWER_ZONES, "zone"
                )
            }
            target["zone"] = [int(x) for x in target["zone"]]
        elif "bpm" in t and target_kind == "hr":
            target = {"bpm": _pair(t["bpm"], 40, 230, "heart rate")}
        elif "watts" in t and target_kind == "power":
            target = {"watts": _pair(t["watts"], 0, 2500, "power")}
        elif "pace" in t and target_kind == "pace":
            target = {"pace": _pair(t["pace"], 120, 900, "pace (s/km)")}  # fast, slow
        else:
            raise PlanError("the step target does not match the workout target")
    cue = re.sub(r"\s+", " ", str(s.get("cue") or "")).strip()[:40]
    return {"type": s["type"], "length": {"kind": kind, "value": round(value)}, "target": target,
            "cue": cue}  # fmt: skip


def clean(w: dict) -> dict:
    """A workout from the browser → the stored form; raises PlanError."""
    if not isinstance(w, dict):
        raise PlanError("workout expected")
    sport = w.get("sport")
    if sport not in SPORTS:
        raise PlanError("sport must be run or ride")
    target = w.get("target") or "hr"
    if target not in TARGETS[sport]:
        raise PlanError("this target is not available for this sport")
    name = re.sub(r"\s+", " ", str(w.get("name") or "")).strip()[:60]
    if not name:
        raise PlanError("enter a name")
    steps = []
    for item in w.get("steps") or []:
        if isinstance(item, dict) and "repeat" in item:
            try:
                n = int(item["repeat"])
            except (TypeError, ValueError) as exc:
                raise PlanError("repeat count must be a number") from exc
            if not 1 <= n <= MAX_REPEAT:
                raise PlanError(f"repeat count must be between 1 and {MAX_REPEAT}")
            inner = [_clean_step(s, target) for s in item.get("steps") or []]
            if not inner:
                continue
            steps.append({"repeat": n, "steps": inner})
        else:
            steps.append(_clean_step(item, target))
    if not steps:
        raise PlanError("add at least one step")
    out = {"name": name, "sport": sport, "target": target, "steps": steps}
    if watch_steps(out) > MAX_WATCH_STEPS:
        raise PlanError(f"a watch takes at most {MAX_WATCH_STEPS} steps")
    return out


def watch_steps(w: dict) -> int:
    return sum(1 + len(i["steps"]) if "repeat" in i else 1 for i in w["steps"])


def flat(w: dict) -> list[dict]:
    """Every step in order, repeats unrolled."""
    out = []
    for item in w["steps"]:
        out.extend(item["steps"] * item["repeat"] if "repeat" in item else [item])
    return out


# ---- context: the person's zones and usual speed ------------------------------------------


def context(conn: sqlite3.Connection, person_id: str) -> dict:
    """Garmin's zones of the latest activity of each sport (heart rate, power) and the usual
    speed (median of the latest activities), for the creator and the estimates."""
    ctx: dict = {}
    for sport in SPORTS:
        row = conn.execute(
            """SELECT zones, start_time_utc FROM activities
               WHERE person_id = ? AND category = ? AND zones IS NOT NULL
               ORDER BY start_time_utc DESC LIMIT 1""",
            (person_id, sport),
        ).fetchone()
        zones = json.loads(row["zones"]) if row and row["zones"] else {}
        hr = (zones.get("hr") or {}).get("bounds")
        power = _power_bounds((zones.get("power") or {}).get("bounds"))
        speeds = sorted(
            r[0]
            for r in conn.execute(
                """SELECT COALESCE(distance_m / NULLIF(time_s, 0), avg_speed) FROM activities
                   WHERE person_id = ? AND category = ? AND time_s > 600 AND distance_m > 1000
                   ORDER BY start_time_utc DESC LIMIT ?""",
                (person_id, sport, RECENT),
            )
            if r[0]
        )
        ctx[sport] = {
            "hr": hr if hr and len(hr) == HR_ZONES + 1 else None,
            "power": power,
            "from": row["start_time_utc"][:10] if row else None,
            "speed": speeds[len(speeds) // 2] if speeds else DEFAULT_SPEED[sport],
        }
    return ctx


def _power_bounds(b: list | None) -> list | None:
    """Garmin's power zone limits (each the start of a zone) as POWER_ZONES + 1 values from
    0 W; an open last zone (≥ 2000 W) ends 10 % above its start."""
    if not b:
        return None
    lims = list(b) if b[0] == 0 else [0, *b]
    if lims[-1] >= 2000:
        lims = [*lims[:-1], round(lims[-2] * 1.1)]
    return lims if len(lims) == POWER_ZONES + 1 else None


def zone_of(target: dict | None, kind: str, bounds: list | None) -> tuple[float, float]:
    """The step's zone range (zones may be fractional for bpm / watt targets)."""
    if not target:
        return REST_ZONE, REST_ZONE
    if "zone" in target:
        return float(target["zone"][0]), float(target["zone"][1])
    vals = target.get("bpm") or target.get("watts")
    n = HR_ZONES if kind == "hr" else POWER_ZONES
    if not bounds:
        return 3.0, 3.0

    def z(v: float) -> float:
        for k in range(n):
            if v < bounds[k + 1]:
                return k + 1 + max(0.0, (v - bounds[k]) / max(1, bounds[k + 1] - bounds[k]))
        return float(n)

    return min(z(vals[0]), n), min(z(vals[1]), n)


def span_of(target: dict | None, kind: str, bounds: list | None) -> tuple[float, float] | None:
    """Where a step's target sits on the zone scale 0 … zones (zone z = z - 1 … z): a zone
    target spans its whole zone(s), a bpm / watt range its values; None = no target."""
    if not target:
        return None
    if "zone" in target:
        return float(target["zone"][0] - 1), float(target["zone"][1])
    zlo, zhi = zone_of(target, kind, bounds)
    return zlo - 1, zhi - 1


def pace_zone(speed: float, usual: float) -> float:
    """A pace target has no Garmin zones: its speed against the person's usual speed is read as
    a heart rate zone (SPEED_SHARE backwards), 1 … 5, for the chart, the load and the kind."""
    share, table = speed / usual, SPEED_SHARE["hr"]
    if share <= table[0]:
        return 1.0
    for k in range(1, len(table)):
        if share <= table[k]:
            return k + (share - table[k - 1]) / (table[k] - table[k - 1])
    return float(len(table))


def _interp(table: tuple, z: float) -> float:
    z = min(max(z, 1.0), float(len(table)))
    lo = int(math.floor(z))
    if lo >= len(table):
        return table[-1]
    return table[lo - 1] + (table[lo] - table[lo - 1]) * (z - lo)


# ---- estimates -----------------------------------------------------------------------------


def estimate(w: dict, ctx: dict) -> dict:
    """Time, distance, load, kind and the blocks of the small chart:
    ``blocks`` = [x0, x1, from, to, type]: x as a share of the time, from / to on the zone scale
    (span_of; both None without a target)."""
    kind = w["target"]
    c = ctx.get(w["sport"]) or {"speed": DEFAULT_SPEED[w["sport"]], "hr": None, "power": None}
    bounds = c.get(kind)
    rows = []  # (seconds, metres, zlo, zhi, type, in_repeat, span)
    for item in w["steps"]:
        inner = item["steps"] if "repeat" in item else [item]
        for _ in range(item.get("repeat", 1)):
            for s in inner:
                if kind == "pace":  # its own speed; zones read from it (pace_zone)
                    t = s["target"]
                    if t:
                        fast, slow = t["pace"]
                        speed = 2000 / (fast + slow)
                        zlo = pace_zone(1000 / slow, c["speed"])
                        zhi = pace_zone(1000 / fast, c["speed"])
                    else:
                        speed, zlo, zhi = c["speed"] * SPEED_SHARE["hr"][0], 1.0, 1.0
                else:
                    zlo, zhi = zone_of(s["target"], kind, bounds)
                    speed = c["speed"] * _interp(SPEED_SHARE[kind], (zlo + zhi) / 2)
                if s["type"] == "rest":
                    speed = 0.0
                v = s["length"]["value"]
                if s["length"]["kind"] == "time":
                    sec, dist = v, v * speed
                else:
                    sec, dist = v / max(speed, 0.5), v
                if kind == "pace":
                    span = (max(0.3, zlo - 1), max(0.6, zhi)) if s["target"] else None
                else:
                    span = span_of(s["target"], kind, bounds)
                rows.append((sec, dist, zlo, zhi, s["type"], "repeat" in item, span))
    total = sum(r[0] for r in rows) or 1.0
    table = INTENSITY["hr" if kind == "pace" else kind]
    load = sum(r[0] / 3600 * _interp(table, (r[2] + r[3]) / 2) ** 2 * 100 for r in rows)
    blocks, x = [], 0.0
    for sec, _, _, _, typ, _, span in rows:
        lo, hi = (round(span[0], 3), round(span[1], 3)) if span else (None, None)
        blocks.append([round(x / total, 4), round((x + sec) / total, 4), lo, hi, typ])
        x += sec
    # seconds easy / moderate / hard (suggest.py): heart rate and pace zones 1–2 / 3 / 4–5,
    # power zones 1–2 / 3 / 4–7; a step without a target and a rest count as easy
    split = [0.0, 0.0, 0.0]
    for sec, _, zlo, zhi, typ, _, _ in rows:
        z = 1 if typ == "rest" else int(min(max((zlo + zhi) / 2, 1.0), 7.0))
        split[0 if z <= 2 else 1 if z == 3 else 2] += sec
    return {
        "duration_s": round(total),
        "intensity": [round(x) for x in split],
        "distance_m": round(sum(r[1] for r in rows)),
        "load": round(load),
        "kind": _kind(rows),
        "steps": watch_steps(w),
        "zones": POWER_ZONES if kind == "power" else HR_ZONES,
        "blocks": blocks,
        "seconds": [round(r[0], 1) for r in rows],
    }


def _kind(rows: list) -> str:
    if any(r[5] and r[4] == "active" and r[3] >= INTERVAL_ZONE for r in rows):
        return "intervals"
    if any(r[4] == "active" and r[0] >= TEMPO_MIN_S and r[2] >= TEMPO_ZONE for r in rows):
        return "tempo"
    if sum(r[0] for r in rows) >= LONG_S:
        return "long"
    return "easy"


# ---- intervals.icu text --------------------------------------------------------------------


def _length(ln: dict) -> str:
    v = int(ln["value"])
    if ln["kind"] == "distance":
        return f"{v / 1000:g}km" if v % 100 == 0 and v >= 1000 else f"{v}mtr"
    h, rest = divmod(v, 3600)
    m, s = divmod(rest, 60)
    return "".join(f"{n}{u}" for n, u in ((h, "h"), (m, "m"), (s, "s")) if n) or "0s"


def _cue(text: str) -> str:
    # text before the length is the cue; digits and symbols would be read as the length
    return re.sub(r"[^\w\s'.,!?-]|\d|_", "", text).strip()


def resolve(target: dict | None, kind: str, bounds: list | None, icu: dict) -> str:
    """One step's target as intervals.icu text, in numbers (see the module doc)."""
    if not target:
        return ""
    if "pace" in target:
        # % of intervals.icu's threshold pace (as speed), its own way of storing pace targets;
        # a pace given in min/km is turned into the same, so this is the surest form
        thr = icu.get("threshold_pace")
        if not thr:
            raise PlanError("set the threshold pace for running in intervals.icu")
        fast, slow = target["pace"]
        lo, hi = round(1000 / slow / thr * 100), round(1000 / fast / thr * 100)
        return f"{lo}-{hi}% Pace" if lo != hi else f"{lo}% Pace"
    if "zone" in target:
        if not bounds:
            what = "heart rate" if kind == "hr" else "power"
            raise PlanError(f"no {what} zones yet: they come from the latest activity of the sport")
        lo, hi = target["zone"]
        vals = [bounds[lo - 1], bounds[hi]]
    else:
        vals = list(target.get("bpm") or target.get("watts"))
    if kind == "power":
        return f"{round(vals[0])}-{round(vals[1])}w"
    lthr, hr_max = icu.get("lthr"), icu.get("max_hr")
    ref, unit = (lthr, "% LTHR") if lthr else (hr_max, "% HR")
    if not ref:
        raise PlanError("set the threshold heart rate (LTHR) in intervals.icu")
    lo, hi = (round(v / ref * 100) for v in vals)
    return f"{lo}-{hi}{unit}" if lo != hi else f"{lo}{unit}"


def icu_text(w: dict, ctx: dict, icu: dict) -> str:
    """The workout in intervals.icu's description syntax. `icu` = the sport's settings in
    intervals.icu (lthr, max_hr). Warm-up and cool-down steps go under their own headings."""
    kind = w["target"]
    bounds = (ctx.get(w["sport"]) or {}).get(kind)
    labels = {"warmup": "Warm-up", "active": "", "recovery": "Recovery", "rest": "Rest",
              "cooldown": "Cool-down"}  # fmt: skip

    def line(s: dict) -> str:
        cue = _cue(s["cue"] or labels[s["type"]])
        parts = ["-", cue, _length(s["length"]), resolve(s["target"], kind, bounds, icu)]
        return " ".join(p for p in parts if p)

    out, section = [], None
    for item in w["steps"]:
        if "repeat" in item:
            out += ["", f"Main set {item['repeat']}x", *(line(s) for s in item["steps"]), ""]
            section = None
            continue
        head = {"warmup": "Warmup", "cooldown": "Cooldown"}.get(item["type"], "")
        if head != section:
            if head:
                out += ["", head]
            elif section:
                out.append("")
            section = head
        out.append(line(item))
    text = "\n".join(out).strip()
    return re.sub(r"\n{3,}", "\n\n", text)


# ---- templates -----------------------------------------------------------------------------


def _row_dict(r: sqlite3.Row, ctx: dict) -> dict:
    w = {"name": r["name"], "sport": r["sport"], "target": r["target"],
         "steps": json.loads(r["steps"])}  # fmt: skip
    return {"id": r["id"], **w, "estimate": estimate(w, ctx)}


def templates(conn: sqlite3.Connection, person_id: str, ctx: dict | None = None) -> list[dict]:
    """The person's templates in their order. Each starter is added once: the setting keeps how
    many were added (the first release added 4 and stored "1"), so new ones come later too."""
    key = f"workouts_seeded:{person_id}"
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    added = 0 if not row else 4 if row[0] == "1" else int(row[0])
    if added < len(STARTERS):
        for w in STARTERS[added:]:
            save(conn, person_id, w)
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            (key, str(len(STARTERS))),
        )
    ctx = ctx if ctx is not None else context(conn, person_id)
    rows = conn.execute(
        "SELECT * FROM workout_templates WHERE person_id = ? ORDER BY position, id", (person_id,)
    ).fetchall()
    return [_row_dict(r, ctx) for r in rows]


def save(
    conn: sqlite3.Connection,
    person_id: str,
    w: dict,
    template_id: int | None = None,
    position: int | None = None,
) -> int:
    w = clean(w)
    from .importer import now_iso

    now = now_iso()
    if template_id is not None:
        cur = conn.execute(
            """UPDATE workout_templates SET name = ?, sport = ?, target = ?, steps = ?,
                      updated_at = ? WHERE id = ? AND person_id = ?""",
            (w["name"], w["sport"], w["target"], json.dumps(w["steps"]), now, template_id,
             person_id),
        )  # fmt: skip
        if not cur.rowcount:
            raise PlanError("workout not found")
        return template_id
    if position is None:
        position = conn.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM workout_templates WHERE person_id = ?",
            (person_id,),
        ).fetchone()[0]
    cur = conn.execute(
        """INSERT INTO workout_templates (person_id, position, name, sport, target, steps,
                  created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (person_id, position, w["name"], w["sport"], w["target"], json.dumps(w["steps"]), now, now),
    )
    return cur.lastrowid
