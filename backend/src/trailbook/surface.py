"""Road surface along an activity route, from OpenStreetMap.

FIT files carry no road surface, so (like other services) the route is matched to map data:
the ways near the route are fetched once from an Overpass API server (OpenStreetMap data,
in small boxes along the route),
every track point takes the surface of the nearest way within MATCH_M metres, and the result
is stored with the activity as runs along the distance:

    {"version": 1, "runs": [[from_m, to_m, kind], ...], "shares": {kind: metres}}

kinds: paved, gravel, dirt, unknown. Only the route (simplified, ~every 100 m) is sent to the
server. Pure standard library (urllib, json, math).
"""

from __future__ import annotations

import json
import math
import sqlite3
import time
import urllib.error
import urllib.request

from . import __version__, db, streams

SURFACE_VERSION = 1
OVERPASS_URL = "https://overpass-api.de/api/interpreter"  # setting "overpass_url" overrides
USER_AGENT = f"Trailbook/{__version__} (self-hosted training log; route surface)"
MATCH_M = 25  # a way further away than this does not count
QUERY_STEP_M = 100  # route points sent to the server: one every this many metres
SAMPLE_STEP_M = 20  # track points matched: one every this many metres
BOX_POINTS = 10  # route points per box (about 1 km)
CHUNK = 150  # boxes per server request
TIMEOUT_S = 120

PAVED = {"asphalt", "paved", "concrete", "concrete:plates", "concrete:lanes", "paving_stones",
         "sett", "cobblestone", "unhewn_cobblestone", "metal", "wood", "chipseal", "bricks",
         "rubber", "tartan"}  # fmt: skip
GRAVEL = {"gravel", "fine_gravel", "compacted", "pebblestone", "rock", "shells"}
DIRT = {"unpaved", "dirt", "ground", "earth", "mud", "grass", "sand", "woodchips", "soil",
        "grass_paver"}  # fmt: skip
# Without a surface tag: roads are paved, tracks follow their grade, paths stay unknown.
PAVED_ROADS = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified",
               "residential", "living_street", "service", "pedestrian", "motorway_link",
               "trunk_link", "primary_link", "secondary_link", "tertiary_link",
               "busway"}  # fmt: skip
TRACK_GRADE = {"grade1": "paved", "grade2": "gravel", "grade3": "gravel", "grade4": "dirt",
               "grade5": "dirt"}  # fmt: skip


def classify(tags: dict) -> str:
    """paved | gravel | dirt | unknown from a way's OSM tags."""
    s = (tags.get("surface") or "").lower()
    if s in PAVED or s.startswith("concrete"):
        return "paved"
    if s in GRAVEL:
        return "gravel"
    if s in DIRT:
        return "dirt"
    hw = tags.get("highway") or ""
    if hw in PAVED_ROADS:
        return "paved"
    if hw == "track":
        return TRACK_GRADE.get(tags.get("tracktype") or "", "gravel")
    if hw == "cycleway":
        return "paved"
    return "unknown"


# ---- geometry (local metres around the route) ----------------------------------------------


class _Plane:
    def __init__(self, lat0: float):
        self.kx = 111_320.0 * math.cos(math.radians(lat0))
        self.ky = 110_540.0

    def xy(self, lat: float, lon: float) -> tuple[float, float]:
        return lon * self.kx, lat * self.ky


def _seg_dist(px, py, ax, ay, bx, by) -> float:
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def match(points: list[tuple[float, float, float]], ways: list[dict]) -> list[list]:
    """Runs [from_m, to_m, kind] for track points (lat, lon, distance_m) and ways
    ({"tags": {...}, "geometry": [{"lat", "lon"}, ...]})."""
    if not points:
        return []
    plane = _Plane(sum(p[0] for p in points) / len(points))
    cell = MATCH_M * 2
    grid: dict[tuple[int, int], list] = {}
    for w in ways:
        kind = classify(w.get("tags") or {})
        geom = [plane.xy(g["lat"], g["lon"]) for g in w.get("geometry") or [] if g]
        for (ax, ay), (bx, by) in zip(geom, geom[1:], strict=False):
            seg = (ax, ay, bx, by, kind)
            for cx in range(int(min(ax, bx) // cell), int(max(ax, bx) // cell) + 1):
                for cy in range(int(min(ay, by) // cell), int(max(ay, by) // cell) + 1):
                    grid.setdefault((cx, cy), []).append(seg)
    runs: list[list] = []
    for lat, lon, d in points:
        px, py = plane.xy(lat, lon)
        cx, cy = int(px // cell), int(py // cell)
        best, kind = MATCH_M, "unknown"
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for ax, ay, bx, by, k in grid.get((cx + dx, cy + dy), ()):
                    dist = _seg_dist(px, py, ax, ay, bx, by)
                    if dist < best:
                        best, kind = dist, k
        if runs and runs[-1][2] == kind:
            runs[-1][1] = d
        else:
            if runs:
                runs[-1][1] = d
            runs.append([d, d, kind])
    return [r for r in runs if r[1] > r[0]] or runs


MIN_RUN_M = 80  # the surface does not switch for less than this


def smooth(runs: list[list], min_m: float = MIN_RUN_M) -> list[list]:
    """Runs of at least `min_m`: a shorter run (a few points caught by a road beside a gravel
    path, GPS noise) joins its neighbours - both sides when they are the same kind, else the
    longer one. A real stretch shorter than `min_m` is lost too (the price of no flicker)."""
    out = [list(r) for r in runs]
    while len(out) > 1:
        k = min(range(len(out)), key=lambda i: out[i][1] - out[i][0])
        if out[k][1] - out[k][0] >= min_m:
            break
        prev = out[k - 1] if k > 0 else None
        nxt = out[k + 1] if k + 1 < len(out) else None
        if prev and nxt and prev[2] == nxt[2]:
            prev[1] = nxt[1]
            del out[k : k + 2]
        elif prev and (not nxt or prev[1] - prev[0] >= nxt[1] - nxt[0]):
            prev[1] = out[k][1]
            del out[k]
        else:
            nxt[0] = out[k][0]
            del out[k]
    return out


def shares(runs: list[list]) -> dict[str, float]:
    out: dict[str, float] = {}
    for a, b, k in runs:
        out[k] = out.get(k, 0.0) + (b - a)
    return {k: round(v) for k, v in out.items()}


# ---- data ----------------------------------------------------------------------------------


def _route(conn: sqlite3.Connection, activity_id: int) -> list[tuple[float, float, float]]:
    ch = {
        r["channel"]: streams.decode(r["encoding"], r["data"])
        for r in conn.execute(
            """SELECT channel, encoding, data FROM streams
               WHERE activity_id = ? AND channel IN ('lat', 'lon', 'distance')""",
            (activity_id,),
        )
    }
    lat, lon, dist = ch.get("lat") or [], ch.get("lon") or [], ch.get("distance") or []
    out: list[tuple[float, float, float]] = []
    last_d = -1e9
    for i in range(min(len(lat), len(lon))):
        if lat[i] is None or lon[i] is None:
            continue
        d = dist[i] if i < len(dist) and dist[i] is not None else (out[-1][2] if out else 0.0)
        if d - last_d >= SAMPLE_STEP_M or not out:
            out.append((lat[i], lon[i], d))
            last_d = d
    return out


def fetch_ways(points: list[tuple[float, float, float]], url: str) -> list[dict]:
    """Ways with a highway tag near the route, from an Overpass server.

    The route is cut into ~1 km pieces; each piece is a small box (padded by MATCH_M) and one
    request asks for the ways in all boxes of up to CHUNK pieces at once.
    """
    route, last = [], -1e9
    for lat, lon, d in points:
        if d - last >= QUERY_STEP_M:
            route.append((lat, lon))
            last = d
    if points and route[-1] != points[-1][:2]:
        route.append(points[-1][:2])
    pad_lat = MATCH_M / 110_540
    pad_lon = MATCH_M / (111_320 * max(0.2, math.cos(math.radians(route[0][0]))))
    boxes = []
    for k in range(0, max(1, len(route) - 1), BOX_POINTS):
        part = route[k : k + BOX_POINTS + 1]
        lats, lons = [p[0] for p in part], [p[1] for p in part]
        boxes.append(f"{min(lats) - pad_lat:.5f},{min(lons) - pad_lon:.5f},"
                     f"{max(lats) + pad_lat:.5f},{max(lons) + pad_lon:.5f}")  # fmt: skip
    ways: dict[int, dict] = {}
    for k in range(0, len(boxes), CHUNK):
        union = "".join(f"way[highway]({b});" for b in boxes[k : k + CHUNK])
        query = f"[out:json][timeout:90];({union});out tags geom;"
        req = urllib.request.Request(
            url, data=("data=" + urllib.request.quote(query)).encode(),
            headers={"User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded"},
        )  # fmt: skip
        for attempt in range(2):  # a busy server answers 502/504 now and then: one retry
            try:
                with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                    data = json.loads(resp.read())
                break
            except urllib.error.HTTPError as exc:
                if attempt or exc.code not in (429, 502, 503, 504):
                    raise
                time.sleep(3)
        for el in data.get("elements", []):
            if el.get("type") == "way":
                ways[el["id"]] = el
    return list(ways.values())


def compute(conn: sqlite3.Connection, activity_id: int) -> dict | None:
    """Surface of an activity (cached in activities.surface). None without a route.

    Raises OSError when the map server cannot be reached (nothing is cached then).
    """
    row = conn.execute("SELECT surface FROM activities WHERE id = ?", (activity_id,)).fetchone()
    if row and row["surface"]:
        cached = json.loads(row["surface"])
        if cached.get("version") == SURFACE_VERSION:
            return _shown(cached)
    points = _route(conn, activity_id)
    if len(points) < 2:  # no route: remember that, so the background run skips it
        conn.execute(
            "UPDATE activities SET surface = ? WHERE id = ?",
            (json.dumps({"version": SURFACE_VERSION, "runs": [], "shares": {}}), activity_id),
        )
        return None
    url = db.get_setting(conn, "overpass_url") or OVERPASS_URL
    try:
        ways = fetch_ways(points, url)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise OSError(f"map data server: {exc}") from exc
    runs = match(points, ways)
    result = {"version": SURFACE_VERSION, "runs": runs, "shares": shares(runs)}
    conn.execute(
        "UPDATE activities SET surface = ? WHERE id = ?",
        (json.dumps(result, separators=(",", ":")), activity_id),
    )
    conn.commit()
    return _shown(result)


def _shown(stored: dict) -> dict | None:
    """What the page gets: the stored point-by-point runs, smoothed (see `smooth`)."""
    if not stored.get("runs"):
        return None
    runs = smooth(stored["runs"])
    return {"version": stored["version"], "runs": runs, "shares": shares(runs)}


def next_missing(conn: sqlite3.Connection) -> int | None:
    """The newest activity with a route whose surface is not known yet."""
    row = conn.execute(
        """SELECT id FROM activities WHERE has_gps = 1 AND surface IS NULL
           ORDER BY start_time_utc DESC LIMIT 1"""
    ).fetchone()
    return row["id"] if row else None


def progress(conn: sqlite3.Connection) -> dict:
    total, done = conn.execute(
        "SELECT COUNT(*), COUNT(surface) FROM activities WHERE has_gps = 1"
    ).fetchone()
    return {"total": total, "done": done}
