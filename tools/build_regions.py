"""Build the country / region boundary files used by Map › Explorer tiles › Regions.

Source: Natural Earth 1:10m (public domain), admin-0 countries and admin-1 states/provinces:
https://github.com/nvkelso/natural-earth-vector/tree/master/geojson

    python tools/build_regions.py <ne_10m_admin_0_countries.geojson> \
        <ne_10m_admin_1_states_provinces.geojson>

Writes backend/src/trailbook/static/regions/: `index.json` (countries and their region names)
and one `<ADM0_A3>.json` per country (outline + regions), loaded by the browser only when a
country or region is chosen. Rings are simplified (Douglas-Peucker) and stored as integer
deltas of 1/1000 degree to keep the whole folder small.
"""

import json
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "backend/src/trailbook/static/regions"
TOL = 0.005  # degrees (~350-550 m): about the precision of the 1:10m source
SCALE = 1000  # stored coordinates: 1/1000 degree


def simplify(pts, tol):
    if len(pts) < 5:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    t2 = tol * tol
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        d2 = dx * dx + dy * dy
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            if d2 == 0:
                dist = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / d2))
                dist = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if dist > best:
                best, idx = dist, i
        if best > t2:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]


def encode_ring(ring):
    pts = simplify([(x, y) for x, y, *_ in ring], TOL)
    ints = []
    for x, y in pts:
        p = (round(x * SCALE), round(y * SCALE))
        if not ints or p != ints[-1]:
            ints.append(p)
    if len(ints) < 4:  # a closed ring needs 3 corners + the closing point
        return None
    out, px, py = [], 0, 0
    for x, y in ints:
        out += [x - px, y - py]
        px, py = x, y
    return out


def encode_geometry(geom):
    polys = (
        geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    )
    out = []
    for poly in polys:
        rings = [r for r in (encode_ring(r) for r in poly) if r]
        if rings:
            out.append(rings)
    return out


def main(countries_path, regions_path):
    countries = json.loads(Path(countries_path).read_text(encoding="utf-8"))["features"]
    regions = json.loads(Path(regions_path).read_text(encoding="utf-8"))["features"]
    by_code = {}
    for f in countries:
        p = f["properties"]
        if f["geometry"]:
            by_code[p["ADM0_A3"]] = {
                "name": p["NAME_EN"] or p["NAME"],
                "geom": f["geometry"],
                "regions": [],
            }
    for f in regions:
        p = f["properties"]
        if not f["geometry"]:
            continue
        c = by_code.setdefault(
            p["adm0_a3"], {"name": p["admin"], "geom": None, "regions": []}
        )
        c["regions"].append(
            {
                "name": p["name_en"] or p["name"] or p["iso_3166_2"],
                "geom": f["geometry"],
            }
        )
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.json"):
        old.unlink()
    index = []
    for code, c in sorted(by_code.items(), key=lambda kv: kv[1]["name"]):
        regs = sorted(c["regions"], key=lambda r: r["name"])
        rg = [{"n": r["name"], "g": encode_geometry(r["geom"])} for r in regs]
        rg = [r for r in rg if r["g"]]
        if c["geom"]:
            outline = encode_geometry(c["geom"])
        else:  # no admin-0 outline: the regions together
            outline = [poly for r in rg for poly in r["g"]]
        if not outline or code == "ATA":  # no tiles to collect in Antarctica
            continue
        (OUT / f"{code}.json").write_text(
            json.dumps(
                {"c": code, "n": c["name"], "g": outline, "r": rg},
                separators=(",", ":"),
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        index.append({"c": code, "n": c["name"], "r": [r["n"] for r in rg]})
    (OUT / "index.json").write_text(
        json.dumps(index, separators=(",", ":"), ensure_ascii=False), encoding="utf-8"
    )
    total = sum(f.stat().st_size for f in OUT.glob("*.json"))
    print(
        f"{len(index)} countries, {sum(len(c['r']) for c in index)} regions, {total / 1e6:.2f} MB"
    )


if __name__ == "__main__":
    main(*sys.argv[1:3])
