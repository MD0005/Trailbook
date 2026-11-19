"""Workout kind of an activity: Easy, Long, Tempo, Intervals, Hills, Race, Commute (endurance
sports, detected) or Match, Training, Recreation (team and racket sports, chosen by the person).

Detected from the streams after import (like the training load, SPEC §7.6); the person can
choose another kind (`workout_override`, kept on reimport). Which sports get which kinds and
with what parameters: PROFILES; the thresholds: RULES. Help > Workout kinds in the app is
written from both (via /api/types), so it always says what the code does.

Everything is relative to the person: heart rate as a share of the sport's threshold HR, power
as a share of FTP, and "typical" = the median of the person's own activities of the same
family (power and speed while in motion, estimated power, time). No fixed bpm or watts. Times
and shares of time are the timer time (every recorded sample); there is no motion time.

Order of the rules (the first that fits wins): Commute for walks and hikes, Intervals (or hill
repeats), Race, Hills, Long, Tempo, Commute for easy rides and skates, Easy.

Interval channel, the fastest-reacting one the activity has: power (running and rowing power
too), then speed (grade-adjusted on hilly runs; pool swims: from the laps), then power
estimated from speed and grade (rides without a power meter), heart rate alone last (it lags
30-60 s, so only long bouts).

Pure Python over the 1 Hz streams: about 15 ms per activity.
"""

from __future__ import annotations

import json
import math
import sqlite3
import statistics as stx
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date

from . import analysis, sports, streams

WORKOUT_VERSION = 8  # v2 FTP per sport, v3 all endurance sports, v4 tempo without block, v5 games,
# v6 race needs heart rate at threshold in every sport (rides: and IF), v7-8 tempo block stored
# for the charts and dropped again

KINDS: dict[str, tuple[str, str]] = {
    "easy": ("Easy", "Spokojny"),
    "long": ("Long", "Długi"),
    "tempo": ("Tempo", "Tempo"),
    "intervals": ("Intervals", "Interwały"),
    "hills": ("Hills", "Podbiegi"),
    "race": ("Race", "Zawody"),
    "commute": ("Commute", "Dojazd / spacer"),
    # team and racket sports: from the heart rate of the whole session
    "match": ("Match", "Mecz"),
    "training": ("Training", "Trening"),
    "recreation": ("Recreation", "Rekreacja"),
}
GAME_KINDS = ("match", "training", "recreation")


@dataclass(frozen=True)
class Profile:
    """How one family of sports is classified. `lthr_share`: threshold HR of the sport as a
    share of the running one (the watch keeps the running value). `hills`: (m/km, m) for a
    hilly activity, None where terrain does not apply. `long_min`: the shortest Long."""

    key: str
    en: str
    types: tuple[str, ...]
    kinds: tuple[str, ...]
    motion: float | None  # m/s; None = no speed (motion while there is heart rate or power)
    lthr_share: float = 1.0
    long_min: int = 90
    hills: tuple[int, int] | None = None
    commute: bool = False
    auto: bool = True  # False: the person chooses the kind, nothing is detected


def _group(g: str, *without: str) -> tuple[str, ...]:
    return tuple(t.key for t in sports.TYPES.values() if t.group == g and t.key not in without)


# The detector's thresholds, in one place: the code reads them from here and the manual
# (Help > Workout kinds, via /api/types) prints them, so the two cannot drift apart.
# Shares of threshold HR are of the sport's threshold HR (Profile.lthr_share).
RULES: dict[str, float] = {
    # tempo
    "tempo_hr": 0.90,  # "tempo or harder": at least this share of threshold HR
    "tempo_share": 0.40,  # of the time
    "tempo_block_min": 12,  # one stretch, dips under it of up to 60 s allowed
    "tempo_share_any": 0.50,  # or this share without the block
    "tempo_ftp": 0.80,  # rides with power: 30 s power at least this share of FTP ...
    "tempo_ftp_share": 0.50,  # ... for half of the time
    "tempo_ftp_block_min": 15,
    # race
    "race_hr": 0.95,
    "race_share": 0.60,
    "race_if": 0.90,  # rides with power: and an intensity factor (NP / FTP) of at least this
    "race_best": 0.95,  # of the person's best intensity for a similar duration
    "race_typical": 1.03,  # and at least this x their typical
    "race_peer_range": 0.25,  # "similar duration": +-25 %
    "race_days": 365,
    "race_stops": 1.25,  # elapsed time at most this x the timer time (few pauses)
    # long
    "long_median": 1.5,  # x the person's median time of the sport
    # commute
    "commute_hr_share": 0.10,  # under this share of the time at tempo HR or harder ...
    "commute_if": 0.70,  # ... and IF under this (rides with power)
    "commute_min": 45,  # and shorter than this
    "commute_ab_m": 1000,  # or ending this far from the start
    # intervals
    "iv_bouts": 3,
    "iv_long_bout_s": 300,  # 2 bouts are enough when both are this long (2 x 20 min)
    "iv_work_s": 180,  # total work at least (rides: iv_work_ride_s)
    "iv_work_ride_s": 300,
    "iv_typical": 1.08,  # work at least this x the person's typical power / speed
    "iv_typical_swim": 1.05,
    "iv_ftp_ride": 0.85,  # rides: work at least this share of FTP
    "iv_ftp_run": 0.95,  # running power: of the running FTP
    "iv_hr_peak": 0.90,  # no FTP: HR at the end of the bouts at least this share
    "iv_hr_peak_hr": 0.92,  # heart rate alone
    "iv_hr_drop": 0.10,  # HR falls in the recoveries by this share of threshold HR
    "iv_hr_drop_strict": 0.15,  # estimated power, heart rate alone
    "iv_alike_len": 3.0,  # bout lengths within x3 of their median
    "iv_alike_cv": 0.15,  # bout intensities: coefficient of variation at most
    "iv_short_bike_s": 60,  # bike bouts shorter than this ...
    "iv_short_bike_ftp": 1.20,  # ... must be at least this share of FTP
    "iv_bike_ftp": 0.88,  # longer bike bouts
    "iv_est_rise": 0.06,  # estimated power: HR rises through each bout by this share
    "iv_est_ridden": 0.80,  # and the recoveries are ridden for this share of their time
    "iv_est_typical": 1.15,
    "iv_hr_bout_s": 180,  # heart rate alone: bouts at least this long
    "iv_hr_activity_s": 1800,  # in an activity at least this long
    "iv_max_rest_x": 2.5,  # a recovery at most 2.5 x the longer bout + 3 min
    "iv_hill_ride": 0.02,  # a bout steeper than this (or than its recoveries by this) ...
    "iv_hill": 0.03,  # ... is a climb, not an interval (other sports)
    "iv_gap_hilly": 8,  # runs without power: grade-adjust speed from this many m/km
    "hill_repeats": 3,  # the same climb at least this many times
    "hill_same_m": 60,  # bouts start within this distance of each other
    # team and racket sports (heart rate over the whole session, pauses included)
    "game_hard_hr": 0.85,  # "hard": at least this share of threshold HR
    "game_match_share": 0.45,  # Match: at least this share of the time hard
    "game_easy_avg": 0.70,  # Recreation: average heart rate under this share
}


_ENDURANCE = ("easy", "long", "tempo", "intervals", "race")
PROFILES: dict[str, Profile] = {
    p.key: p
    for p in (
        Profile("run", "Running", _group("run"), (*_ENDURANCE, "hills"), 1.2, 1.0, 75, (25, 200)),
        Profile("ride", "Cycling", _group("ride", "downhill_ride", "bmx"),
                (*_ENDURANCE, "hills", "commute"), 2.0, 0.95, 150, (15, 500), commute=True),
        Profile("ski", "Cross-country skiing",
                ("ski_xc", "ski_skate", "ski_backcountry", "ski_indoor"),
                (*_ENDURANCE, "hills"), 1.5, 1.0, 120, (20, 300)),
        Profile("skate", "Skating", ("inline_skate", "ice_skate"), (*_ENDURANCE, "commute"),
                2.0, 0.95, 90, commute=True),
        Profile("row", "Rowing", ("row", "indoor_row"), _ENDURANCE, 1.0, 0.95, 75),
        Profile("paddle", "Paddling", ("kayak", "canoe", "paddle", "sup"), _ENDURANCE, 0.8,
                0.93, 120),
        Profile("swim", "Swimming", _group("swim"), _ENDURANCE, 0.3, 0.92, 60),
        Profile("cardio", "Cardio machines", ("elliptical", "stair_stepper"), _ENDURANCE, None,
                0.95, 75),
        Profile("foot", "Walking and hiking", (*_group("walk"), *_group("hike"), "snowshoe"),
                ("commute", "easy", "long", "hills", "race"), 0.4),
        Profile("game", "Team and racket sports", (*_group("team"), *_group("racket")),
                GAME_KINDS, None),
    )
}  # fmt: skip
_BY_TYPE = {t: p for p in PROFILES.values() for t in p.types}

ProgressFn = Callable[[int, int], None]


def profile(activity_type: str | None) -> Profile | None:
    """The family an activity type belongs to; None = no workout kind for this sport."""
    return _BY_TYPE.get(activity_type or "")


def family(activity_type: str | None) -> str | None:
    p = profile(activity_type)
    return p.key if p else None


def options(activity_type: str | None) -> tuple[str, ...]:
    """Kinds the person can choose for an activity of this type."""
    p = profile(activity_type)
    return p.kinds if p else ()


# ---- stream helpers ----------------------------------------------------------------------


def rolling_mean(x: list, w: int) -> list:
    """Centred rolling mean ignoring None; None where under half of the window has values."""
    n = len(x)
    cs = [0.0] * (n + 1)
    cc = [0] * (n + 1)
    for i, v in enumerate(x):
        cs[i + 1] = cs[i] + (v if v is not None else 0.0)
        cc[i + 1] = cc[i] + (v is not None)
    h = w // 2
    out: list = [None] * n
    for i in range(n):
        a, b = max(0, i - h), min(n, i + h + 1)
        k = cc[b] - cc[a]
        if k and k >= (b - a) / 2:
            out[i] = (cs[b] - cs[a]) / k
    return out


def grade_series(dist: list, alt: list, span: float = 40.0) -> list:
    """Grade at each second over the next ~`span` metres."""
    n = len(dist)
    g: list = [None] * n
    j = 0
    for i in range(n):
        if dist[i] is None or alt[i] is None:
            continue
        j = max(j, i)
        while j < n - 1 and (dist[j] is None or dist[j] < dist[i] + span):
            j += 1
        if dist[j] is not None and alt[j] is not None and dist[j] - dist[i] >= span * 0.5:
            g[i] = (alt[j] - alt[i]) / (dist[j] - dist[i])
    return g


def minetti(g: float) -> float:
    """Energy cost of running at grade g relative to the flat (Minetti 2002)."""
    g = max(-0.45, min(0.45, g))
    return (155.4 * g**5 - 30.4 * g**4 - 43.3 * g**3 + 46.3 * g**2 + 19.5 * g + 3.6) / 3.6


def est_power(spd: list, dist: list, alt: list, mass: float = 85.0) -> list:
    """Cycling power from speed, grade and acceleration (no wind, no drafting). Only its
    shape is used: bouts against recoveries and the person's typical estimate, never FTP."""
    v = rolling_mean(spd, 5)
    g = grade_series(dist, alt, span=100.0) if any(alt) and any(dist) else [None] * len(v)
    out: list = [None] * len(v)
    for i in range(1, len(v)):
        if v[i] is None or v[i] < 2.0:
            continue
        acc = v[i] - v[i - 1] if v[i - 1] is not None else 0.0
        gr = g[i] if g[i] is not None else 0.0
        p = v[i] * (mass * 9.81 * (0.005 + gr) + mass * acc) + 0.5 * 1.2 * 0.32 * v[i] ** 3
        out[i] = max(0.0, min(1500.0, p))
    return out


def mean_range(sig: list, a: int, b: int) -> float | None:
    xs = [v for v in sig[a:b] if v is not None]
    return sum(xs) / len(xs) if xs else None


def haversine(p: tuple, q: tuple) -> float:
    r = math.radians
    x = (
        math.sin(r(q[0] - p[0]) / 2) ** 2
        + math.cos(r(p[0])) * math.cos(r(q[0])) * math.sin(r(q[1] - p[1]) / 2) ** 2
    )
    return 12742000 * math.asin(math.sqrt(x))


def otsu(vals: list) -> tuple[float, float, float] | None:
    """Threshold splitting the values into two classes best: (threshold, low mean, high mean)."""
    vals = sorted(vals)
    n = len(vals)
    if n < 20:
        return None
    pre = [0.0]
    for v in vals:
        pre.append(pre[-1] + v)
    best, out = -1.0, None
    step = max(1, n // 400)
    for i in range(step, n - step, step):
        m0, m1 = pre[i] / i, (pre[n] - pre[i]) / (n - i)
        score = i / n * (n - i) / n * (m0 - m1) ** 2
        if score > best:
            best, out = score, (vals[i], m0, m1)
    return out


def zone_share(hr: list, motion: list, ref: float, lo: float) -> float | None:
    xs = [v / ref for v, m in zip(hr, motion, strict=False) if v and m]
    return sum(1 for x in xs if x >= lo) / len(xs) if xs else None


def longest_block(sig: list, motion: list, ref: float, lo: float, dip: int = 60) -> int:
    """Longest stretch (s) with sig/ref >= lo, dips below it of up to `dip` s allowed."""
    return longest_block_at(sig, motion, ref, lo, dip)[0]


def longest_block_at(
    sig: list, motion: list, ref: float, lo: float, dip: int = 60
) -> tuple[int, int, int]:
    """`longest_block` and where it is: (seconds, first index, index after the last)."""
    best = cur = below = 0
    out = (0, 0, 0)
    start = 0
    for i, (v, m) in enumerate(zip(sig, motion, strict=False)):
        if not m:
            continue
        if v and v / ref >= lo:
            if cur == 0:
                start = i
            cur += 1 + below
            below = 0
            if cur > best:
                best = cur
                out = (best, start, i + 1)
        else:
            below += 1
            if below > dip:
                cur = below = 0
    return out


# ---- features ----------------------------------------------------------------------------

CHANNELS = ("time", "hr", "power", "speed", "altitude", "distance", "lat", "lon")


@dataclass
class Features:
    fam: str | None
    n: int
    spd: list
    pw: list
    hr: list
    alt: list
    dist: list
    motion: list
    grade: list | None
    epw: list | None
    ll: list | None
    has_power: bool = False


def lap_speed(laps: list) -> list:
    """Per-second speed from the laps of a pool swim (the watch keeps no speed stream there):
    each swum lap at its average speed, rest laps (no distance) at 0."""
    out: list = []
    for lap in laps:
        start, el = lap["start_offset_s"], lap["elapsed_s"] or lap["timer_s"] or 0
        if start is None or el <= 0:
            continue
        a, b = int(start), int(start + el)
        out += [None] * max(0, b - len(out))
        v = (lap["distance_m"] or 0) / (lap["timer_s"] or el)
        for i in range(a, b):
            out[i] = v
    return out


def features(activity_type: str | None, ch: dict[str, list], laps: list | None = None) -> Features:
    prof = profile(activity_type)
    fam = prof.key if prof else None
    time = ch.get("time") or []
    s = {k: analysis.resample_1hz(time, v) for k, v in ch.items() if k != "time" and v}
    if fam == "swim" and not s.get("speed") and laps:
        s["speed"] = lap_speed(laps)
    n = max((len(v) for v in s.values()), default=0)

    def get(k: str) -> list:
        v = s.get(k) or []
        return v + [None] * (n - len(v))

    spd, pw, hr, alt, dist = get("speed"), get("power"), get("hr"), get("altitude"), get("distance")
    lat, lon = get("lat"), get("lon")
    ll = [
        (a, b) if a is not None and b is not None else None for a, b in zip(lat, lon, strict=True)
    ]
    thr = prof.motion if prof and prof.motion is not None else None
    if thr is None or not any(spd):  # no speed (machines): motion while there is HR or power
        motion = [h is not None or bool(p) for h, p in zip(hr, pw, strict=True)]
    else:
        motion = [
            (v is not None and v >= thr) or (fam != "run" and p is not None and p > 0)
            for v, p in zip(spd, pw, strict=True)
        ]
    grade = grade_series(dist, alt) if any(alt) and any(dist) else None
    epw = est_power(spd, dist, alt) if fam == "ride" and any(spd) else None
    has_power = sum(1 for v in pw if v) > 0.5 * max(1, sum(motion))
    return Features(fam, n, spd, pw, hr, alt, dist, motion, grade, epw, ll if any(ll) else None,
                    has_power)  # fmt: skip


def stats(f: Features) -> dict:
    """Per-activity medians kept for the person's history: motion power, speed, estimated
    power (None when there are under 5 minutes of it)."""

    def med(sig: list | None) -> float | None:
        xs = [v for v, m in zip(sig or [], f.motion, strict=False) if m and v]
        return round(stx.median(xs), 2) if len(xs) > 300 else None

    return {"p": med(f.pw) if f.has_power else None, "s": med(f.spd), "e": med(f.epw)}


@dataclass
class History:
    """The person's activities of the same group: medians and (id, day, time s, intensity)
    for "best for the duration"."""

    time: float | None = None
    power: float | None = None
    speed: float | None = None
    epower: float | None = None
    acts: list = field(default_factory=list)


def history(rows: list) -> History:
    """`rows`: (id, day, time_s, workout_stats JSON) of one person and group."""
    st = [(r[0], r[1], r[2], json.loads(r[3]) if r[3] else {}) for r in rows]

    def med(xs: list) -> float | None:
        xs = [x for x in xs if x]
        return stx.median(xs) if xs else None

    h = History(
        time=med([m for _, _, m, _ in st]),
        power=med([s.get("p") for *_, s in st]),
        speed=med([s.get("s") for *_, s in st]),
        epower=med([s.get("e") for *_, s in st]),
    )
    key = "p" if h.power else "s"
    h.acts = [(i, d, m, s.get(key)) for i, d, m, s in st if s.get(key) and m]
    return h


# ---- interval detection ------------------------------------------------------------------

# smoothing (s), min work/recovery ratio per cycle (HR: difference as a share of threshold
# HR), shortest work bout (s), gap merged into a bout (s), shortest recovery (s)
CHANNEL_RULES = {
    "power": {"smooth": 10, "ratio": 1.25, "min_work": 20, "merge": 6, "min_rec": 20},
    "rpower": {"smooth": 10, "ratio": 1.20, "min_work": 20, "merge": 6, "min_rec": 30},
    "epower": {"smooth": 15, "ratio": 1.50, "min_work": 60, "merge": 8, "min_rec": 30},
    "speed": {"smooth": 15, "ratio": 1.20, "min_work": 25, "merge": 8, "min_rec": 30},
    "hr": {"smooth": 5, "diff": 0.07, "min_work": 60, "merge": 10, "min_rec": 45},
    # pool: speed from the laps, rests at the wall are short (a rep may be 12x its rest)
    "swim": {"smooth": 3, "ratio": 1.20, "min_work": 20, "merge": 3, "min_rec": 8, "max_wr": 12},
}


@dataclass
class Bouts:
    kind: str
    bouts: list  # (start s, end s)
    work: list  # mean of the signal per bout
    rec: list  # mean between bouts
    grade: list  # mean grade per bout
    rec_grade: list  # mean grade of the recoveries next to each bout
    same_place: int  # bouts starting within 60 m of another bout's start

    @property
    def n(self) -> int:
        return len(self.bouts)

    @property
    def durs(self) -> list:
        return [e - s for s, e in self.bouts]


def _hysteresis(sig: list, motion: list, hi: float, lo: float, rules: dict) -> list:
    bouts, cur = [], None
    for i, v in enumerate(sig):
        if v is None:
            if cur is not None:
                bouts.append((cur, i))
                cur = None
            continue
        if cur is None and v >= hi and motion[i]:
            cur = i
        elif cur is not None and v < lo:
            bouts.append((cur, i))
            cur = None
    if cur is not None:
        bouts.append((cur, len(sig)))
    merged: list = []
    for b in bouts:
        if merged and b[0] - merged[-1][1] <= rules["merge"]:
            merged[-1] = (merged[-1][0], b[1])
        else:
            merged.append(b)
    return [b for b in merged if b[1] - b[0] >= rules["min_work"]]


def _cycle_ok(rules: dict, work: float | None, rec: float | None) -> bool:
    if work is None or rec is None:
        return False
    if "diff" in rules:
        return work - rec >= rules["diff"]
    return rec <= 0 or work / rec >= rules["ratio"]


def detect(raw: list, f: Features, kind: str, scale: float = 1.0) -> Bouts | None:
    """The longest chain of work bouts in which every cycle (bout, recovery, bout) is clearly
    above its recovery. `scale` normalises the signal (HR by the threshold HR)."""
    rules = CHANNEL_RULES[kind]
    sig = rolling_mean([None if v is None else v / scale for v in raw], rules["smooth"])
    vals = [v for v, m in zip(sig, f.motion, strict=False) if v is not None and m]
    if len(vals) < 300:
        return None
    o = otsu(vals)
    if not o:
        return None
    t, lo, hi = o
    d = hi - lo
    # enter a bout a little above the split, leave it a little below; never above the hard
    # level itself (very even bouts, e.g. pool laps, put the split right at their top)
    enter = min(t + 0.1 * d, hi - 0.1 * d)
    found = _hysteresis(sig, f.motion, enter, min(t - 0.1 * d, enter - 0.2 * d), rules)
    if len(found) < 2:
        return None
    sets, cur = [], [found[0]]
    for a, b in zip(found, found[1:], strict=False):
        rec = b[0] - a[1]
        w = max(a[1] - a[0], b[1] - b[0])
        r = mean_range(sig, a[1], b[0])
        if (
            rules["min_rec"] <= rec <= RULES["iv_max_rest_x"] * w + 180
            and w <= rules.get("max_wr", 6) * rec + 60  # 10 min on / 1 off: a steady run
            and _cycle_ok(rules, mean_range(sig, *a), r)
            and _cycle_ok(rules, mean_range(sig, *b), r)
        ):
            cur.append(b)
        else:
            sets.append(cur)
            cur = [b]
    sets.append(cur)
    best = max(sets, key=lambda s: (len(s), sum(e - a for a, e in s)))
    if len(best) < 2:
        return None
    g = f.grade or []
    gr = (lambda a, b: mean_range(g, a, b) or 0.0) if g else (lambda a, b: 0.0)
    rgs = [gr(best[i][1], best[i + 1][0]) for i in range(len(best) - 1)]
    rec_grade = [
        stx.mean([rgs[j] for j in (i - 1, i) if 0 <= j < len(rgs)] or [0.0])
        for i in range(len(best))
    ]
    same = 0
    if f.ll:
        pts = [f.ll[a] for a, _ in best if f.ll[a]]
        for i, p in enumerate(pts):
            if any(j != i and haversine(p, q) < RULES["hill_same_m"] for j, q in enumerate(pts)):
                same += 1
    return Bouts(
        kind=kind,
        bouts=best,
        work=[mean_range(sig, a, e) for a, e in best],
        rec=[mean_range(sig, best[i][1], best[i + 1][0]) for i in range(len(best) - 1)],
        grade=[gr(a, e) for a, e in best],
        rec_grade=rec_grade,
        same_place=same,
    )


# ---- classification ----------------------------------------------------------------------


@dataclass
class Result:
    kind: str | None
    why: str
    bouts: list = field(default_factory=list)  # (start s, end s) of interval / hill bouts


def classify(a: sqlite3.Row | dict, f: Features, th: analysis.Thresholds, h: History) -> Result:
    fam = f.fam
    prof = PROFILES.get(fam or "")
    if prof is None:
        return Result(None, "no kind for this sport")
    if not prof.auto:
        return Result(None, "chosen by the person")
    if fam == "foot":
        return Result("commute", "walk or hike")
    if fam == "game":
        return _game(f, th)
    mv = a["time_s"] or 0
    dist = a["distance_m"] or 0
    asc = a["ascent_m"] or 0
    lt = (th.lthr or (th.hr_max or 190) * analysis.LTHR_SHARE_OF_MAX) * prof.lthr_share
    ftp = th.ftp
    hr = f.hr
    every = [True] * len(hr)  # shares of the timer time: every recorded sample counts
    has_hr = any(v for v in hr)
    z3 = zone_share(hr, every, lt, RULES["tempo_hr"]) if has_hr else None
    z4 = zone_share(hr, every, lt, RULES["race_hr"]) if has_hr else None
    blk = longest_block(hr, every, lt, RULES["tempo_hr"]) if has_hr else 0
    np_ = a["np_power"]
    intensity_factor = np_ / ftp if np_ and ftp and fam == "ride" else None

    r = _intervals(f, a, lt, ftp, h, has_hr, mv)
    if isinstance(r, Result):
        return r

    # race: at threshold most of the time and close to the person's best for the duration
    el = a["elapsed_s"] or mv
    st = json.loads(a["workout_stats"]) if a["workout_stats"] else {}
    inten = st.get("p" if h.power else "s")
    if mv >= 600 and el <= RULES["race_stops"] * mv and inten:
        day = date.fromisoformat(a["start_time_utc"][:10])
        lo, hi = mv * (1 - RULES["race_peer_range"]), mv / (1 - RULES["race_peer_range"])
        peers = [
            v for (_, d, m, v) in h.acts
            if lo <= m <= hi and abs((date.fromisoformat(d) - day).days) <= RULES["race_days"]
        ]  # fmt: skip
        rel_best = inten / max(peers + [inten])
        rel_typ = inten / ((h.power if h.power else h.speed) or inten)
        # heart rate at threshold is required in every sport; rides with power must also have
        # an intensity factor of a race (a hard group ride has the power, not the heart rate)
        hot = (z4 or 0) >= RULES["race_share"] and (
            not (fam == "ride" and intensity_factor) or intensity_factor >= RULES["race_if"]
        )
        if hot and rel_best >= RULES["race_best"] and rel_typ >= RULES["race_typical"]:
            return Result("race", f"{z4 or 0:.0%} at threshold, {rel_best:.0%} of best")

    apk = asc / (dist / 1000) if dist > 500 else 0
    if prof.hills and apk >= prof.hills[0] and asc >= prof.hills[1]:
        return Result("hills", f"{apk:.0f} m/km")

    if mv >= max(prof.long_min * 60, RULES["long_median"] * (h.time or 0)):
        return Result("long", f"{mv / 60:.0f} min")

    # a block of tempo, or half the session at tempo even in shorter stretches (a steady ride
    # whose heart rate hovers at the line, broken by turns and junctions)
    if (
        has_hr
        and z3 is not None
        and (
            (z3 >= RULES["tempo_share"] and blk >= RULES["tempo_block_min"] * 60)
            or z3 >= RULES["tempo_share_any"]
        )
    ):
        return Result("tempo", f"{z3:.0%} at 90 %+ threshold HR, block {blk // 60} min")
    if fam == "ride" and ftp and f.has_power:
        p30 = rolling_mean(f.pw, 30)
        zs = [v / ftp for v in p30 if v is not None]
        share = sum(1 for v in zs if v >= RULES["tempo_ftp"]) / len(zs) if zs else 0
        pblk = longest_block(p30, [True] * len(p30), ftp, RULES["tempo_ftp"])
        if share >= RULES["tempo_ftp_share"] and pblk >= RULES["tempo_ftp_block_min"] * 60:
            return Result("tempo", f"{share:.0%} at 80 %+ FTP, block {pblk // 60} min")

    if prof.commute and not a["indoor"]:
        pts = [p for p in (f.ll or []) if p]
        ab = haversine(pts[0], pts[-1]) if len(pts) > 1 else 0
        easy = (z3 or 0) < RULES["commute_hr_share"] and (
            intensity_factor is None or intensity_factor < RULES["commute_if"]
        )
        if easy and (mv < RULES["commute_min"] * 60 or ab > RULES["commute_ab_m"]):
            return Result("commute", "easy, short or from A to B")
    return Result("easy", "")


def _game(f: Features, th: analysis.Thresholds) -> Result:
    """Team and racket sports: a game is all stop-and-go, so only the heart rate over the whole
    session (pauses included) tells a match from a practice or a casual game."""
    lt = th.lthr or (th.hr_max or 190) * analysis.LTHR_SHARE_OF_MAX
    hr = [v / lt for v in f.hr if v]
    if len(hr) < 600:
        return Result(None, "no heart rate")
    avg = sum(hr) / len(hr)
    hard = sum(1 for v in hr if v >= RULES["game_hard_hr"]) / len(hr)
    if hard >= RULES["game_match_share"]:
        return Result("match", f"{hard:.0%} of the time hard")
    if avg < RULES["game_easy_avg"]:
        return Result("recreation", f"average {avg:.0%} of threshold HR")
    return Result("training", f"{hard:.0%} of the time hard, average {avg:.0%}")


def _intervals(f, a, lt, ftp, h: History, has_hr: bool, mv: float) -> Result | None:
    """Intervals or hill repeats, else None."""
    fam, hr = f.fam, f.hr

    def hr_peak_ok(b: Bouts, need: float) -> bool:
        if not has_hr:
            return True
        peaks = [max([v for v in hr[s : e + 30] if v] or [0]) / lt for s, e in b.bouts]
        return stx.median(peaks) >= need

    def above_typical(b: Bouts, typical: float | None, share: float = RULES["iv_typical"]) -> bool:
        # harder than what the person usually does: otherwise "work" is their normal pace and
        # the "recoveries" are stops or walking
        return not typical or stx.median(b.work) >= share * typical

    ch = _channel(f, a, lt, has_hr)
    b = detect(ch[0], f, ch[1], ch[2]) if ch else None
    if not b:
        return None
    if b.kind in ("power", "rpower"):
        # FTP only where it means this sport (cycling, running power), see analysis
        share = {"ride": RULES["iv_ftp_ride"], "run": RULES["iv_ftp_run"]}.get(fam or "")
        hard = above_typical(b, h.power) and (
            stx.median(b.work) / ftp >= share
            if ftp and share
            else hr_peak_ok(b, RULES["iv_hr_peak"])
        )
    elif b.kind == "epower":
        hard = above_typical(b, h.epower) and hr_peak_ok(b, RULES["iv_hr_peak"])
    elif b.kind == "swim":
        # pool: speed from the laps; wrist HR under water is too unreliable to judge by
        hard = above_typical(b, h.speed, RULES["iv_typical_swim"])
    elif b.kind == "speed":
        hard = above_typical(b, h.speed) and hr_peak_ok(b, RULES["iv_hr_peak"])
    else:
        hard = hr_peak_ok(b, RULES["iv_hr_peak_hr"])
    if not hard:
        return None
    long_two = b.n >= 2 and min(b.durs) >= RULES["iv_long_bout_s"]
    if (b.n < RULES["iv_bouts"] and not long_two) or sum(b.durs) < RULES["iv_work_s"]:
        return None

    # the heart rate falls in real recoveries (in a race with surges it stays up)
    if has_hr and b.kind != "swim":
        drops = []
        for (s, e), (n0, _) in zip(b.bouts, b.bouts[1:], strict=False):
            pk = max([v for v in hr[s : e + 20] if v] or [0])
            low = min([v for v in hr[e : n0 + 20] if v] or [pk])
            drops.append(pk - low)
        need = RULES["iv_hr_drop_strict"] if b.kind in ("hr", "epower") else RULES["iv_hr_drop"]
        if not drops or stx.median(drops) / lt < need:
            return None

    keep = _alike(b, f, lt, ftp, h, mv)
    if keep is None:
        return None
    # a bout up a hill (or clearly steeper than the recoveries around it: push up, coast
    # down) may be the hill, not the athlete; the same climb repeated is a hill workout
    lim = RULES["iv_hill_ride"] if fam == "ride" else RULES["iv_hill"]
    flat = [i for i in keep if b.grade[i] < lim and b.grade[i] - b.rec_grade[i] < lim]
    up = len(keep) - len(flat)
    spans = [b.bouts[i] for i in keep]
    if up >= RULES["hill_repeats"] and b.same_place >= RULES["hill_repeats"]:
        return Result("hills", f"{up} hill repeats", spans)
    if len(flat) >= RULES["iv_bouts"] or (len(flat) == len(keep) and long_two):
        work = sum(b.durs[i] for i in keep)
        return Result("intervals", f"{len(keep)} bouts, {work // 60} min of work ({b.kind})", spans)
    return None


def _channel(f: Features, a, lt: float, has_hr: bool) -> tuple[list, str, float] | None:
    """The interval channel of the activity: (signal, CHANNEL_RULES key, scale), or None."""
    fam = f.fam
    if f.has_power:
        sig = (
            f.pw
            if fam == "run"
            else [p if m else None for p, m in zip(f.pw, f.motion, strict=True)]
        )
        return sig, "power" if fam == "ride" else "rpower", 1.0
    if fam == "run" and any(f.spd):
        sig = f.spd
        apk = (a["ascent_m"] or 0) / max(1, (a["distance_m"] or 1) / 1000)
        if apk >= RULES["iv_gap_hilly"] and f.grade:
            g100 = grade_series(f.dist, f.alt, span=100.0)
            sig = [
                None if v is None else v * (minetti(g) if g is not None else 1.0)
                for v, g in zip(f.spd, g100, strict=True)
            ]
        return sig, "speed", 1.0
    if fam == "ride" and f.epw and any(f.epw):
        return f.epw, "epower", 1.0
    if fam == "swim" and any(f.spd):
        return f.spd, "swim", 1.0
    if any(f.spd):
        return f.spd, "speed", 1.0
    if has_hr:
        return f.hr, "hr", lt
    return None


def _alike(b: Bouts, f: Features, lt: float, ftp, h: History, mv: float) -> list | None:
    """Bouts that are hard on their own and look alike (length within x3, intensity CV
    <= 15 %), or None when too few are left."""
    keep = list(range(b.n))
    if b.kind == "power" and ftp:
        # on a bike a short bout must be well above FTP, or it is a start after a stop
        def need(i: int) -> float:
            short = b.durs[i] < RULES["iv_short_bike_s"]
            return RULES["iv_short_bike_ftp"] if short else RULES["iv_bike_ftp"]

        keep = [i for i in keep if b.work[i] / ftp >= need(i)]
    if b.kind == "epower":
        # estimated power also swings with wind and drafting: the heart rate must climb
        # through each bout and the recoveries must be ridden (a stop is not a recovery)
        if h.epower:
            keep = [i for i in keep if b.work[i] / h.epower >= RULES["iv_est_typical"]]

        def rise(i: int) -> float:
            s, e = b.bouts[i]
            h0 = [v for v in f.hr[s : s + 15] if v]
            h1 = [v for v in f.hr[e - 15 : e + 15] if v]
            return (max(h1) - min(h0)) / lt if h0 and h1 else 0.0

        def ridden(i: int) -> float:
            j = min(i, b.n - 2)
            e, n0 = b.bouts[j][1], b.bouts[j + 1][0]
            return sum(f.motion[e:n0]) / max(1, n0 - e)

        keep = [
            i
            for i in keep
            if rise(i) >= RULES["iv_est_rise"] and ridden(i) >= RULES["iv_est_ridden"]
        ]
        if len(keep) < RULES["iv_bouts"]:
            return None
    if b.kind == "hr":
        if mv < RULES["iv_hr_activity_s"]:
            return None
        keep = [i for i in keep if b.durs[i] >= RULES["iv_hr_bout_s"]]
    if len(keep) >= 2:
        md = stx.median(b.durs[i] for i in keep)
        x = RULES["iv_alike_len"]
        keep = [i for i in keep if md / x <= b.durs[i] <= md * x]
    long_two = len(keep) >= 2 and min(b.durs[i] for i in keep) >= RULES["iv_long_bout_s"]
    if len(keep) < RULES["iv_bouts"] and not long_two:
        return None
    w = [b.work[i] for i in keep]
    if b.kind != "hr" and stx.pstdev(w) / stx.mean(w) > RULES["iv_alike_cv"]:
        return None
    if sum(b.durs[i] for i in keep) < RULES["iv_work_ride_s" if f.fam == "ride" else "iv_work_s"]:
        return None
    return keep


# ---- storage -----------------------------------------------------------------------------


def _channels(conn: sqlite3.Connection, activity_id: int) -> dict[str, list]:
    marks = ", ".join("?" for _ in CHANNELS)
    return {
        r["channel"]: streams.decode(r["encoding"], r["data"])
        for r in conn.execute(
            f"SELECT channel, encoding, data FROM streams WHERE activity_id = ? "
            f"AND channel IN ({marks})",
            (activity_id, *CHANNELS),
        )
    }


def _history_rows(conn: sqlite3.Connection, person_id: str, fam: str) -> list:
    types = PROFILES[fam].types
    marks = ", ".join("?" * len(types))
    return conn.execute(
        f"""SELECT id, substr(start_time_utc, 1, 10), time_s, workout_stats
            FROM activities WHERE person_id = ? AND activity_type IN ({marks})
              AND workout_stats IS NOT NULL""",
        (person_id, *types),
    ).fetchall()


def _measured(fam: str | None) -> bool:
    """Families whose kind is computed from the streams."""
    p = PROFILES.get(fam or "")
    return bool(p and p.auto and fam != "foot")


def _features_of(conn: sqlite3.Connection, a: sqlite3.Row) -> Features:
    laps = None
    if family(a["activity_type"]) == "swim":
        laps = conn.execute(
            """SELECT start_offset_s, elapsed_s, timer_s, distance_m FROM laps
               WHERE activity_id = ? ORDER BY idx""",
            (a["id"],),
        ).fetchall()
    return features(a["activity_type"], _channels(conn, a["id"]), laps)


def backfill(conn: sqlite3.Connection, progress: ProgressFn | None = None) -> int:
    """Detect the kind of every activity whose detection is missing or outdated. Two passes:
    first the per-activity medians (the person's history), then the kinds."""
    todo = [
        r[0]
        for r in conn.execute(
            "SELECT id FROM activities WHERE workout_version < ? ORDER BY start_time_utc",
            (WORKOUT_VERSION,),
        )
    ]
    for activity_id in todo:
        a = conn.execute(
            "SELECT id, activity_type, workout_stats FROM activities WHERE id = ?", (activity_id,)
        ).fetchone()
        if a["workout_stats"] is None and _measured(family(a["activity_type"])):
            f = _features_of(conn, a)
            conn.execute(
                "UPDATE activities SET workout_stats = ? WHERE id = ?",
                (json.dumps(stats(f)), activity_id),
            )
    cache: dict = {}
    for i, activity_id in enumerate(todo, 1):
        detect_one(conn, activity_id, cache)
        if progress and (i % 20 == 0 or i == len(todo)):
            progress(i, len(todo))
    return len(todo)


def detect_one(conn: sqlite3.Connection, activity_id: int, cache: dict | None = None) -> Result:
    """(Re)detect the kind of one activity and store it."""
    cache = {} if cache is None else cache
    a = conn.execute("SELECT * FROM activities WHERE id = ?", (activity_id,)).fetchone()
    fam = family(a["activity_type"])
    if not _measured(fam):
        result = classify(a, features(a["activity_type"], {}), analysis.Thresholds(), History())
    else:
        f = _features_of(conn, a)
        st = json.dumps(stats(f))
        if st != a["workout_stats"]:
            conn.execute("UPDATE activities SET workout_stats = ? WHERE id = ?", (st, activity_id))
            a = conn.execute("SELECT * FROM activities WHERE id = ?", (activity_id,)).fetchone()
        key = (a["person_id"], fam)
        if key not in cache:
            cache[key] = history(_history_rows(conn, *key))
        th = analysis.activity_thresholds(conn, a, cache)
        result = classify(a, f, th, cache[key])
    conn.execute(
        """UPDATE activities SET workout = ?, workout_detail = ?, workout_version = ?
           WHERE id = ?""",
        (
            result.kind,
            json.dumps({"why": result.why, "bouts": result.bouts}) if result.kind else None,
            WORKOUT_VERSION,
            activity_id,
        ),
    )
    return result


# ---- interval splits (lines on the activity charts) --------------------------------------


def _edge(x: list, i: int, rad: int, k: int, up: bool) -> int:
    """The second near `i` (within `rad`) where the signal steps up (or down) the most: the
    mean of the next `k` s against the mean of the previous `k` s."""
    best, at = None, i
    for j in range(max(k, i - rad), min(len(x) - k, i + rad) + 1):
        m0, m1 = mean_range(x, j - k, j), mean_range(x, j, j + k)
        if m0 is None or m1 is None:
            continue
        d = m1 - m0 if up else m0 - m1
        if best is None or d > best:
            best, at = d, j
    return at


def refine(sig: list, bouts: list, rad: int, scale: float = 1.0) -> list:
    """Bout edges moved to the sharpest step of the signal within `rad` s (the detection
    finds them only to its smoothing or bin size)."""
    x = rolling_mean([None if v is None else v / scale for v in sig], 3)
    out: list = []
    for s, e in bouts:
        k = max(3, min(15, (e - s) // 4))
        s2, e2 = _edge(x, s, rad, k, True), _edge(x, e, rad, k, False)
        if out:
            s2 = max(s2, out[-1][1])
        if e2 - s2 < 10:
            s2, e2 = s, e
        out.append((s2, e2))
    return out


def change_points(x: list, penalty: float, min_len: int) -> list:
    """Starts of the pieces of constant mean that fit `x` best: squared error plus `penalty`
    per piece, each piece at least `min_len` values long (optimal partitioning with PELT
    pruning, near-linear)."""
    n = len(x)
    if n < 2 * min_len:
        return [0]
    s1, s2 = [0.0], [0.0]
    for v in x:
        s1.append(s1[-1] + v)
        s2.append(s2[-1] + v * v)

    def cost(i: int, j: int) -> float:
        d = s1[j] - s1[i]
        return s2[j] - s2[i] - d * d / (j - i)

    inf = float("inf")
    best = [inf] * (n + 1)
    best[0] = -penalty
    prev = [0] * (n + 1)
    cand: list = []
    for j in range(min_len, n + 1):
        i_new = j - min_len
        if i_new == 0 or i_new >= min_len:
            cand.append(i_new)
        scores = [(best[i] + cost(i, j) + penalty, i) for i in cand]
        best[j], prev[j] = min(scores)
        cand = [i for sc, i in scores if sc - penalty <= best[j]]
    out, j = [], n
    while j > 0:
        j = prev[j]
        out.append(j)
    return out[::-1]


def sections(sig: list, kind: str, scale: float = 1.0) -> list:
    """Work bouts (start s, end s) for the section lines: the signal cut into pieces of steady
    level (change points on 3-11 s means), each piece called work or recovery by the split
    between the activity's two levels, neighbours of the same kind joined, work shorter than
    the channel's shortest bout dropped. Unlike `detect`, nothing is required of the bouts
    (alike, hard, a chain): the person asked for intervals, the lines show where they are."""
    rules = CHANNEL_RULES[kind]
    x, last = [], None
    first = next((v for v in sig if v is not None), None)
    if first is None:
        return []
    for v in sig:  # gaps carry the last value
        last = v / scale if v is not None else (last if last is not None else first / scale)
        x.append(last)
    step = max(1, min(rules["min_work"], rules["min_rec"]) // 4)
    bins = [sum(x[i : i + step]) / len(x[i : i + step]) for i in range(0, len(x), step)]
    o = otsu(bins)
    if not o:
        return []
    t, lo, hi = o
    contrast = hi - lo >= rules["diff"] if "diff" in rules else lo <= 0 or hi / lo >= 1.1
    if not contrast:
        return []
    min_len = 4
    starts = change_points(bins, min_len * (0.35 * (hi - lo)) ** 2 / 2, min_len)
    ends = starts[1:] + [len(bins)]
    pieces: list = []  # [start s, end s, work?]
    for a, b in zip(starts, ends, strict=True):
        work = sum(bins[a:b]) / (b - a) >= t
        if pieces and pieces[-1][2] == work:
            pieces[-1][1] = b * step
        else:
            pieces.append([a * step, b * step, work])
    bouts = [(a, min(b, len(x))) for a, b, w in pieces if w and b - a >= rules["min_work"]]
    joined: list = []
    for b in bouts:  # a dip shorter than the shortest recovery is part of the bout
        if joined and b[0] - joined[-1][1] < rules["min_rec"] / 2:
            joined[-1] = (joined[-1][0], b[1])
        else:
            joined.append(b)
    return joined if len(joined) >= 2 else []


MIN_SECTION_S = 30  # no detected section (bout, recovery, warm-up, cool-down) is shorter


def min_sections(bouts: list, end: int, min_s: int = MIN_SECTION_S) -> list:
    """Bouts such that every section between two lines lasts at least `min_s`: shorter bouts
    are dropped, shorter recoveries join the bouts around them, a bout starting (ending)
    within `min_s` of the start (end) of the activity starts (ends) there - no line."""
    out: list = []
    for s, e in bouts:
        if e - s < min_s:
            continue
        if out and s - out[-1][1] < min_s:
            out[-1] = (out[-1][0], e)
        else:
            out.append((s, e))
    if out and out[0][0] < min_s:
        out[0] = (0, out[0][1])
    if out and end - out[-1][1] < min_s:
        out[-1] = (out[-1][0], end)
    return out


def split_points(bouts: list, min_gap: int = 5) -> list:
    """Bout starts and ends as one sorted list of seconds; a recovery shorter than `min_gap`
    joins the bouts around it (one line instead of two)."""
    pts: list = []
    for s, e in bouts:
        if s == 0 and not pts:  # a bout from the very start: only its end is a line
            pts.append(e)
            continue
        if pts and s - pts[-1] < min_gap:
            pts[-1] = e
        else:
            pts += [s, e]
    return pts


def interval_splits(conn: sqlite3.Connection, activity_id: int) -> dict:
    """Section lines of an interval workout, in seconds from the start: every work bout's start
    and end (`sections`). Runs are cut by their speed (what the runner sees as pace; running
    power drops on a fast downhill), other sports by their interval channel (`_channel`).
    When nothing is found there, the bouts the detector stored."""
    empty = {"splits": [], "channel": None}
    a = conn.execute("SELECT * FROM activities WHERE id = ?", (activity_id,)).fetchone()
    fam = family(a["activity_type"])
    if not _measured(fam) or fam == "game":
        return empty
    f = _features_of(conn, a)
    th = analysis.activity_thresholds(conn, a)
    lt = (th.lthr or (th.hr_max or 190) * analysis.LTHR_SHARE_OF_MAX) * PROFILES[fam].lthr_share
    ch = _channel(f, a, lt, any(v for v in f.hr))
    if fam == "run" and any(f.spd):
        ch = (f.spd, "speed", 1.0)
    if not ch:
        return empty
    sig, kind, scale = ch
    bouts = sections(sig, kind, scale)
    rad = max(1, min(CHANNEL_RULES[kind]["min_work"], CHANNEL_RULES[kind]["min_rec"]) // 4) + 5
    if not bouts:
        detail = json.loads(a["workout_detail"]) if a["workout_detail"] else {}
        bouts = [tuple(b) for b in detail.get("bouts") or []]
        rad = CHANNEL_RULES[kind]["smooth"] + 10
    t0 = next((t for t in _channels(conn, activity_id).get("time") or [] if t is not None), 0)
    pts = split_points(min_sections(refine(sig, bouts, rad, scale), len(sig)))
    pts = [p for p in pts if 0 < p < len(sig)]
    return {"splits": [p - int(t0) for p in pts], "channel": kind}


def set_override(conn: sqlite3.Connection, activity_id: int, kind: str | None) -> None:
    """The person's choice of kind; None goes back to the detected one (or none)."""
    row = conn.execute("SELECT activity_type FROM activities WHERE id = ?", (activity_id,))
    allowed = options(row.fetchone()[0])
    if kind is not None and kind not in allowed:
        raise ValueError(f"workout kind {kind!r} does not apply to this sport")
    conn.execute("UPDATE activities SET workout_override = ? WHERE id = ?", (kind, activity_id))
