"""Calendar › Next: what the next session could be (docs/MANUAL.md › Next workout).

The last 7 days of training and the workouts planned for the next 7 days are split into three
intensities by heart rate zone — easy (zones 1–2 and below), moderate (zone 3), hard (zones
4–5); planned steps by their target (planner.estimate) — and compared with the share an
intensity model asks for. With the form (fitness model), the days since the last hard session
and the last long one, it picks a rest day or an easy, long, tempo or interval session and a
sport, and says what to change in the plan when the plan pulls the week away from the model.

Only activities with time in heart rate zones count for the split (strength without a strap,
for example, does not); the session is suggested in an endurance sport (ENDURANCE).
"""

from __future__ import annotations

import json
import sqlite3
from datetime import date, timedelta

from . import analysis, planner

# Share of easy / moderate / hard time each model asks for.
MODELS = {
    "polarized": ("Polarized", (0.80, 0.05, 0.15)),
    "pyramidal": ("Pyramidal", (0.75, 0.20, 0.05)),
    "threshold": ("Threshold", (0.55, 0.35, 0.10)),
}
DEFAULT_MODEL = "polarized"
LEVELS = ("easy", "moderate", "hard")
WINDOW_DAYS = 7  # days back (today included) and days ahead
SPORT_DAYS = 28  # the usual mix of sports
HARD_MIN_S = 10 * 60  # a day with this much hard time was a hard day
REST_FORM = -30  # form below this: rest
TIRED_FORM = -20  # form below this: nothing hard
FRESH_FORM = 5  # form above this: fresh enough for a key session even right after a hard day
LONG_S = planner.LONG_S  # a long session: at least this long
# Sports a session can be suggested in (the split counts every activity with heart rate).
ENDURANCE = frozenset({"run", "ride", "swim", "walk", "hike", "winter", "water"})
PLAN_OFF = 0.10  # the plan pulls an intensity this far past the model: say so


def _split(zones_json: str | None) -> list[float] | None:
    """Seconds easy / moderate / hard from Garmin's time in heart rate zones (below zone 1 and
    zones 1–2 / zone 3 / zones 4 and up)."""
    z = (json.loads(zones_json) if zones_json else {}).get("hr") or {}
    t = [float(x or 0) for x in z.get("times") or []]
    if not any(t):
        return None
    return [sum(t[:3]), sum(t[3:4]), sum(t[4:])]


def _median(xs: list[float]) -> float | None:
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else None


def suggest(
    conn: sqlite3.Connection, person_id: str, today: date, model: str = DEFAULT_MODEL
) -> dict:
    model = model if model in MODELS else DEFAULT_MODEL
    name, target = MODELS[model]
    first, last = today - timedelta(days=WINDOW_DAYS - 1), today + timedelta(days=WINDOW_DAYS)
    day = analysis.LOCAL_DAY_SQL
    acts = conn.execute(
        f"""SELECT {day} AS day, category, time_s, zones FROM activities
            WHERE person_id = ? AND {day} BETWEEN ? AND ? ORDER BY start_time_utc""",
        (person_id, (today - timedelta(days=SPORT_DAYS - 1)).isoformat(), today.isoformat()),
    ).fetchall()
    week = [a for a in acts if a["day"] >= first.isoformat()]
    done = [0.0, 0.0, 0.0]
    hard_days = set()
    for a in week:
        sp = _split(a["zones"])
        if sp:
            done = [x + y for x, y in zip(done, sp, strict=True)]
            if sp[2] >= HARD_MIN_S:
                hard_days.add(a["day"])
    long_done = any((a["time_s"] or 0) >= LONG_S for a in week)
    sports_today = {a["category"] for a in week if a["day"] == today.isoformat()}

    # planned: from today (today's only while no activity of its sport is done) to a week ahead
    ctx = planner.context(conn, person_id)
    plans = []
    for r in conn.execute(
        """SELECT id, day, name, sport, target, steps FROM planned_workouts
           WHERE person_id = ? AND day BETWEEN ? AND ? AND sync_state != 'delete'
           ORDER BY day, id""",
        (person_id, today.isoformat(), last.isoformat()),
    ):
        if r["day"] == today.isoformat() and r["sport"] in sports_today:
            continue
        w = {"name": r["name"], "sport": r["sport"], "target": r["target"],
             "steps": json.loads(r["steps"])}  # fmt: skip
        est = planner.estimate(w, ctx)
        plans.append({"id": r["id"], "day": r["day"], "name": r["name"], "sport": r["sport"],
                      "kind": est["kind"], "split": est["intensity"],
                      "duration_s": est["duration_s"]})  # fmt: skip
    planned = [sum(p["split"][k] for p in plans) for k in range(3)]
    long_planned = any(p["duration_s"] >= LONG_S for p in plans)

    loads = analysis.daily_loads(conn, person_id)
    series = analysis.fitness_series(loads, until=today) if loads else []
    point = next((d for d in reversed(series) if d["date"] <= today.isoformat()), None)
    form = point["tsb"] if point else None

    # the day it is for: today, or tomorrow when something is done today
    for_day = today + timedelta(days=1) if sports_today else today
    yesterday = (for_day - timedelta(days=1)).isoformat()
    hard_recent = yesterday in hard_days or for_day.isoformat() in hard_days

    total = sum(done) + sum(planned)
    share = [(done[k] + planned[k]) / total if total else 0.0 for k in range(3)]
    gap = [target[k] - share[k] for k in range(3)]  # > 0: missing

    # sport: the one whose share of the time fell most against the last 4 weeks
    t28: dict[str, float] = {}
    t7: dict[str, float] = {}
    for a in acts:
        t28[a["category"]] = t28.get(a["category"], 0) + (a["time_s"] or 0)
        if a["day"] >= first.isoformat():
            t7[a["category"]] = t7.get(a["category"], 0) + (a["time_s"] or 0)
    for p in plans:
        t7[p["sport"]] = t7.get(p["sport"], 0) + p["duration_s"]
    s28, s7 = sum(t28.values()) or 1, sum(t7.values()) or 1
    counts = {g: sum(1 for a in acts if a["category"] == g) for g in t28}
    usual = [g for g in t28 if counts[g] >= 2 and g in ENDURANCE]
    sport = max(usual, key=lambda g: t28[g] / s28 - t7.get(g, 0) / s7) if usual else None
    usual_s = _median([a["time_s"] for a in acts if a["category"] == sport and a["time_s"]])

    reasons: list[str] = []
    if form is not None and form < REST_FORM:
        kind = "rest"
        reasons.append(f"Form {form:+.0f}: below {REST_FORM}, rest first.")
    elif hard_recent and (form is None or form < FRESH_FORM):
        kind = "rest" if form is not None and form < TIRED_FORM else "easy"
        reasons.append("A hard day just before: keep 48 h between hard sessions.")
    elif not long_done and not long_planned and (form is None or form >= TIRED_FORM):
        kind = "long"
        reasons.append("No long session in the last 7 days or in the plan.")
    elif gap[2] >= max(gap[1], 0.03) and (form is None or form >= TIRED_FORM):
        kind = "intervals"
        reasons.append(
            f"Hard time {share[2]:.0%} of the week, the {name.lower()} model asks {target[2]:.0%}."
        )
    elif gap[1] >= 0.03 and (form is None or form >= TIRED_FORM):
        kind = "tempo"
        reasons.append(
            f"Moderate time {share[1]:.0%} of the week, "
            f"the {name.lower()} model asks {target[1]:.0%}."
        )
    else:
        kind = "easy"
        if total:
            reasons.append(
                f"Easy time {share[0]:.0%} of the week, "
                f"the {name.lower()} model asks {target[0]:.0%}."
            )
    if (
        form is not None
        and kind not in ("rest",)
        and not any(r.startswith("Form") for r in reasons)
    ):
        reasons.append(f"Form {form:+.0f}.")
    # length: the sport's usual session (median of 4 weeks), a long one 1,5 × that and at least
    # LONG_S; to 5 minutes
    minutes = None
    if kind != "rest":
        base = (usual_s or 3600) / 60
        minutes = 5 * round((max(LONG_S / 60, base * 1.5) if kind == "long" else base) / 5)

    # the plan pulls the week away from the model: which planned workout to change
    notes = []
    if plans and total:
        for k, word in ((1, "moderate"), (2, "hard"), (0, "easy")):
            if share[k] - target[k] > PLAN_OFF and planned[k] > 0:
                p = max(plans, key=lambda x: x["split"][k])
                change = "easier" if k in (1, 2) else "with some hard work"
                notes.append(
                    f"Too much {word} time with the plan ({share[k]:.0%}, model "
                    f"{target[k]:.0%}): make {p['name']} on {p['day']} {change}."
                )

    return {
        "model": model, "models": {k: v[0] for k, v in MODELS.items()},
        "target": dict(zip(LEVELS, target, strict=True)),
        "done": dict(zip(LEVELS, [round(x) for x in done], strict=True)),
        "planned": dict(zip(LEVELS, [round(x) for x in planned], strict=True)),
        "form": round(form, 1) if form is not None else None,
        "window": [first.isoformat(), last.isoformat()],
        "plans": [{k: p[k] for k in ("id", "day", "name", "sport", "kind")} for p in plans],
        "next": {"day": for_day.isoformat(), "kind": kind,
                 "sport": sport if kind != "rest" else None, "minutes": minutes,
                 "reasons": reasons},
        "notes": notes,
    }  # fmt: skip
