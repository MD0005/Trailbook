"""Demo data for trying Trailbook without real data: a made-up athlete ("Alex") in Warsaw.

Writes gzipped GPX files (time, position, altitude, heart rate, cadence, power) into
`<out>/alex/`, about two years of runs, rides and walks. The routes follow real streets: they
come from the public OSM routing service (routing.openstreetmap.de, a few dozen requests, cached
in `<out>/routes.json`); everything else is invented. No personal data is involved.

    python tools/demo_data.py demo/root
    trailbook --db demo/trailbook.db scan demo/root     (one subfolder per person)
"""

from __future__ import annotations

import argparse
import gzip
import itertools
import json
import math
import random
import time
import urllib.request
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

CENTER = (52.2297, 21.0122)  # Warsaw
ROUTER = "https://routing.openstreetmap.de/routed-{profile}/route/v1/driving/{coords}"
ROUTER_UA = "Trailbook demo data generator"


def route(
    profile: str, points: list[tuple[float, float]]
) -> list[tuple[float, float]] | None:
    coords = ";".join(f"{lon:.5f},{lat:.5f}" for lat, lon in points)
    url = (
        ROUTER.format(profile=profile, coords=coords)
        + "?overview=full&geometries=geojson"
    )
    req = urllib.request.Request(url, headers={"User-Agent": ROUTER_UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.load(resp)
    except OSError:
        return None
    if data.get("code") != "Ok":
        return None
    return [(lat, lon) for lon, lat in data["routes"][0]["geometry"]["coordinates"]]


def offset(
    lat: float, lon: float, km_north: float, km_east: float
) -> tuple[float, float]:
    return lat + km_north / 111.0, lon + km_east / (111.0 * math.cos(math.radians(lat)))


def loop_points(rng: random.Random, radius_km: float, home: tuple[float, float]):
    """A loop from home through 3 points on a rough circle."""
    a0 = rng.uniform(0, 2 * math.pi)
    pts = [home]
    for k in range(3):
        a = a0 + k * 2 * math.pi / 3 + rng.uniform(-0.4, 0.4)
        r = radius_km * rng.uniform(0.7, 1.2)
        pts.append(offset(*home, r * math.sin(a) + r, r * math.cos(a)))
    pts.append(home)
    return pts


def dist_m(a, b) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (*a, *b))
    h = (
        math.sin((la2 - la1) / 2) ** 2
        + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    )
    return 2 * 6371000 * math.asin(math.sqrt(h))


def build_routes(out: Path, rng: random.Random) -> dict[str, list]:
    cache = out / "routes.json"
    if cache.exists():
        return json.loads(cache.read_text())
    routes: dict[str, list] = {"run": [], "long": [], "ride": [], "walk": []}
    homes = [offset(*CENTER, rng.uniform(-3, 3), rng.uniform(-3, 3)) for _ in range(4)]
    plan = [("run", "foot", 1.3, 18), ("long", "foot", 2.8, 6), ("ride", "bike", 7.0, 14),
            ("walk", "foot", 0.8, 6)]  # fmt: skip
    for kind, profile, radius, n in plan:
        while len(routes[kind]) < n:
            r = route(profile, loop_points(rng, radius, rng.choice(homes)))
            time.sleep(1.1)  # gentle on the public service
            if r and len(r) > 20:
                routes[kind].append(r)
                print(f"route {kind} {len(routes[kind])}/{n}")
    cache.write_text(json.dumps(routes))
    return routes


def resample(path: list, step_m: float) -> list[tuple[float, float]]:
    """Points every `step_m` along the path."""
    out = [tuple(path[0])]
    carry = 0.0
    for a, b in itertools.pairwise(path):
        d = dist_m(a, b)
        pos = step_m - carry
        while pos <= d:
            f = pos / d
            out.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
            pos += step_m
        carry = (carry + d) % step_m
    return out


def altitude(lat: float, lon: float) -> float:
    # gentle made-up terrain, the same for every route through a place
    return (
        95
        + 7 * math.sin(lat * 70)
        + 5 * math.cos(lon * 55)
        + 2 * math.sin((lat + lon) * 160)
    )


# workout -> list of (seconds, speed m/s, target heart rate, power) blocks; seconds None = rest
def blocks(kind: str, rng: random.Random, total_s: float):
    j = rng.uniform(0.96, 1.04)
    if kind == "intervals":
        warm = [(900, 3.0 * j, 138, 0)]
        reps = []
        for _ in range(6):
            reps += [(180, 4.15 * j, 176, 0), (120, 2.6 * j, 145, 0)]
        return warm + reps + [(None, 2.9 * j, 136, 0)]
    if kind == "tempo":
        return [
            (600, 3.0 * j, 140, 0),
            (1500, 3.55 * j, 163, 0),
            (None, 2.95 * j, 140, 0),
        ]
    if kind == "run":
        return [(None, 3.05 * j, 142, 0)]
    if kind == "long":
        return [(None, 3.0 * j, 147, 0)]
    if kind == "ride":
        return [(None, 7.4 * j, 138, 185)]
    return [(None, 1.45 * j, 102, 0)]  # walk


def gpx(
    name: str, sport: str, start: datetime, pts, kind: str, rng: random.Random
) -> bytes:
    plan = blocks(kind, rng, 0)
    dt = 2 if sport != "walking" else 4
    out, t, hr, i, k, left = [], start, 95.0, 0.0, 0, plan[0][0]
    n = len(pts) - 1
    while i < n:
        _, speed, target, power = plan[k]
        v = max(0.5, speed * (1 + rng.gauss(0, 0.03)))
        i += v * dt / 5.0  # points are 5 m apart
        hr += (target + rng.gauss(0, 1.5) - hr) * (1 - math.exp(-dt / 25))
        lat, lon = pts[min(int(i), n)]
        cad = (
            88 if sport == "running" else 86 if sport == "cycling" else 55
        ) + rng.randint(-2, 2)
        ext = f"<gpxtpx:hr>{round(hr)}</gpxtpx:hr><gpxtpx:cad>{cad}</gpxtpx:cad>"
        pw = (
            f"<power>{max(0, round(power * (v / speed) ** 2 + rng.gauss(0, 12)))}</power>"
            if power
            else ""
        )
        out.append(
            f'<trkpt lat="{lat:.6f}" lon="{lon:.6f}"><ele>{altitude(lat, lon):.1f}</ele>'
            f"<time>{t.strftime('%Y-%m-%dT%H:%M:%SZ')}</time><extensions>"
            f"<gpxtpx:TrackPointExtension>{ext}</gpxtpx:TrackPointExtension>{pw}</extensions></trkpt>"
        )
        t += timedelta(seconds=dt)
        if left is not None:
            left -= dt
            if left <= 0 and k + 1 < len(plan):
                k += 1
                left = plan[k][0]
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<gpx creator="Trailbook demo" version="1.1" xmlns="http://www.topografix.com/GPX/1/1" '
        'xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">'
        f"<metadata><time>{start.strftime('%Y-%m-%dT%H:%M:%SZ')}</time></metadata>"
        f"<trk><name>{name}</name><type>{sport}</type><trkseg>{''.join(out)}</trkseg></trk></gpx>"
    ).encode()


NAMES = {"run": "Easy run", "long": "Long run", "tempo": "Tempo run",
         "intervals": "Intervals 6 × 3 min", "ride": "Afternoon ride", "walk": "Walk"}  # fmt: skip
SPORT = {"run": "running", "long": "running", "tempo": "running", "intervals": "running",
         "ride": "cycling", "walk": "walking"}  # fmt: skip
# a week: day of the week -> kind (None = rest); rides more in summer
WEEK = {0: None, 1: "intervals", 2: "run", 3: "tempo", 4: None, 5: "ride", 6: "long"}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("out", type=Path)
    ap.add_argument("--from", dest="first", default="2025-01-06")
    ap.add_argument("--to", dest="last", default=date.today().isoformat())
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    a.out.mkdir(parents=True, exist_ok=True)
    routes = build_routes(a.out, rng)
    folder = a.out / "alex"
    folder.mkdir(exist_ok=True)
    day, last, n = date.fromisoformat(a.first), date.fromisoformat(a.last), 0
    while day <= last:
        kind = WEEK[day.weekday()]
        summer = 4 <= day.month <= 9
        if kind == "run" and summer and rng.random() < 0.5:
            kind = "ride"
        if day.weekday() == 4 and rng.random() < 0.5:
            kind = "walk"
        if kind and rng.random() < 0.88:  # some days missed
            pool = routes["long" if kind == "long" else "ride" if kind == "ride" else
                          "walk" if kind == "walk" else "run"]  # fmt: skip
            path = resample(rng.choice(pool), 5.0)
            hour = rng.choice([6, 7, 17, 18]) if kind != "long" else 8
            start = datetime(
                day.year, day.month, day.day, hour, rng.randint(0, 59), tzinfo=UTC
            )
            data = gpx(NAMES[kind], SPORT[kind], start, path, kind, rng)
            (folder / f"{day.isoformat()}-{kind}.gpx.gz").write_bytes(
                gzip.compress(data)
            )
            n += 1
        day += timedelta(days=1)
    print(f"{n} activities in {folder}")


if __name__ == "__main__":
    main()
