// Map › Explorer tiles › Regions: countries and regions to watch. Each chosen one adds a
// "visited of all tiles" item to the Summary. Boundaries: Natural Earth 1:10m (public domain),
// built by tools/build_regions.py into static/regions/ (one file per country, loaded only when
// a country or one of its regions is chosen). Everything is computed in the browser.
"use strict";

let REGION_INDEX = null; // [{c: code, n: name, r: [region names]}]
const REGION_FILES = new Map(); // code -> Promise<{c, n, g, r: [{n, g}]}>
const REGION_COUNTS = new WeakMap(); // tiles Map -> Map(`${id}|${z}` -> {visited, total})

// A selection id is a country code ("POL") or code/region name ("POL/Masovian Voivodeship").
const regionCode = (id) => id.split("/")[0];

async function loadRegionIndex() {
  if (!REGION_INDEX) {
    const res = await fetch("regions/index.json");
    REGION_INDEX = (await res.json()).map((c) => ({ ...c, r: [...c.r].sort((a, b) => a.localeCompare(b)) }));
  }
  return REGION_INDEX;
}

function loadRegionFile(code) {
  if (!REGION_FILES.has(code)) {
    REGION_FILES.set(code, fetch(`regions/${encodeURIComponent(code)}.json`).then((r) => r.json()));
  }
  return REGION_FILES.get(code);
}

function regionName(id) {
  const [code, region] = [regionCode(id), id.slice(id.indexOf("/") + 1)];
  if (id.includes("/")) return region;
  return REGION_INDEX?.find((c) => c.c === code)?.n || code;
}

// Rings are integer deltas of 1/1000 degree (see tools/build_regions.py).
function decodeRings(geom) {
  const rings = [];
  for (const poly of geom) {
    for (const ring of poly) {
      const pts = [];
      let x = 0, y = 0;
      for (let i = 0; i < ring.length; i += 2) {
        x += ring[i]; y += ring[i + 1];
        pts.push([x / 1000, y / 1000]);
      }
      rings.push(pts);
    }
  }
  return rings;
}

// Tiles whose centre lies inside the area (even-odd rule, so holes are left out), row by row:
// `total` of all of them, `visited` of those in `tiles`.
function countRegionTiles(geom, z, tiles) {
  const n = 2 ** z;
  const tx = (lon) => ((lon + 180) / 360) * n;
  const ty = (lat) => {
    const r = (Math.max(Math.min(lat, 85.0511), -85.0511) * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  };
  const edges = [];
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
  for (const ring of decodeRings(geom)) {
    let prev = null;
    for (const [lon, lat] of ring) {
      const p = [tx(lon), ty(lat)];
      if (prev && prev[1] !== p[1]) {
        const [a, b] = prev[1] < p[1] ? [prev, p] : [p, prev];
        edges.push({ y0: a[1], y1: b[1], x0: a[0], k: (b[0] - a[0]) / (b[1] - a[1]) });
      }
      minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      prev = p;
    }
  }
  // Visited tiles inside the bounding box, by row.
  const rows = new Map();
  for (const t of tiles.values()) {
    if (t.y + 0.5 < minY || t.y + 0.5 > maxY || t.x + 0.5 < minX || t.x + 0.5 > maxX) continue;
    if (!rows.has(t.y)) rows.set(t.y, []);
    rows.get(t.y).push(t.x);
  }
  edges.sort((a, b) => a.y0 - b.y0);
  let total = 0, visited = 0, next = 0, active = [];
  for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
    const yc = y + 0.5;
    while (next < edges.length && edges[next].y0 <= yc) active.push(edges[next++]);
    active = active.filter((e) => e.y1 > yc);
    if (!active.length) continue;
    const xs = active.filter((e) => e.y0 <= yc).map((e) => e.x0 + (yc - e.y0) * e.k).sort((a, b) => a - b);
    const inRow = rows.get(y);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      // tile x counts when its centre x + 0.5 lies in [a, b)
      const from = Math.ceil(xs[i] - 0.5), to = Math.ceil(xs[i + 1] - 0.5);
      total += Math.max(0, to - from);
      if (inRow) for (const x of inRow) if (x >= from && x < to) visited++;
    }
  }
  return { visited, total };
}

// Summary items for the chosen regions that are loaded; the rest load and call `redraw`.
function regionSummaryItems(ids, z, tiles, redraw) {
  if (!ids?.length) return [];
  let counts = REGION_COUNTS.get(tiles);
  if (!counts) REGION_COUNTS.set(tiles, (counts = new Map()));
  const items = [];
  let missing = false;
  for (const id of ids) {
    const key = `${id}|${z}`;
    if (!counts.has(key)) {
      const file = REGION_FILES.get(regionCode(id));
      if (!file?.done) { missing = true; continue; }
      const geom = id.includes("/") ? file.done.r.find((r) => r.n === id.slice(id.indexOf("/") + 1))?.g : file.done.g;
      if (!geom) continue; // a region no longer in the data
      counts.set(key, countRegionTiles(geom, z, tiles));
    }
    const { visited, total } = counts.get(key);
    const pct = total ? (100 * visited) / total : 0;
    const label = id.includes("/") ? regionName(id) : (REGION_FILES.get(regionCode(id))?.done?.n || regionName(id));
    const share = !visited ? "0 %" : pct < 0.01 ? `< ${num(0.01, 2)} %` : `${num(pct, pct < 10 ? 2 : 1)} %`;
    items.push([esc(label), share, `${num(visited)} of ${num(total)}`]);
  }
  if (missing) {
    Promise.all(ids.map(regionCode).map((c) => loadRegionFile(c).then((d) => { REGION_FILES.get(c).done = d; })))
      .then(redraw, () => {});
  }
  return items;
}

// ---- picker (Options › Explorer tiles › Regions coverage statistics) -----------------
// "Choose" opens a small window with the list; OK applies the ticks. The chosen ones are
// listed under the button, each with × to remove it.

function regionChips(ids) {
  if (!ids?.length) return "";
  return ids.map((id) => {
    const title = id.includes("/") ? `${regionName(id)} · ${regionName(regionCode(id))}` : regionName(id);
    const of = id.includes("/") ? `<span class="region-of">${esc(regionName(regionCode(id)))}</span>` : "";
    return `<div class="region-chip" title="${esc(title)}"><span>${esc(regionName(id))}</span>${of}<button type="button" data-region-remove="${esc(id)}" aria-label="Remove ${esc(regionName(id))}">×</button></div>`;
  }).join("");
}

function regionPickerHtml(ids) {
  return `<div class="region-row">
      <span class="opt-label">Regions coverage statistics</span>
      <button type="button" class="badge" data-region-open>Choose</button>
      <div class="region-chips" data-region-chips>${regionChips(ids)}</div>
    </div>`;
}

// `onChange(ids)` saves the selection.
function bindRegionPicker(el, getIds, onChange) {
  const root = el.querySelector(".region-row");
  if (!root) return;
  const chips = root.querySelector("[data-region-chips]");
  const drawChips = () => { chips.innerHTML = regionChips(getIds()); };
  if (getIds().length && !REGION_INDEX) loadRegionIndex().then(drawChips, () => {}); // country names
  chips.onclick = (e) => {
    const x = e.target.closest("[data-region-remove]");
    if (!x) return;
    onChange(getIds().filter((id) => id !== x.dataset.regionRemove));
    drawChips();
  };
  root.querySelector("[data-region-open]").onclick = () => openRegionDialog(getIds(), (ids) => { onChange(ids); drawChips(); });
}

function openRegionDialog(current, onOk) {
  const draft = [...current];
  const expanded = new Set(draft.filter((id) => id.includes("/")).map(regionCode)); // show chosen regions
  let query = "";
  const dlg = document.createElement("dialog");
  dlg.className = "region-dialog";
  dlg.innerHTML = `<div class="region-dialog-head">Regions coverage statistics</div>
    <p class="region-hint">Tick a whole country, or open its regions and tick single ones.</p>
    <input type="search" placeholder="Search country or region" data-region-search>
    <div class="region-list" data-region-list>${loaderHtml()}</div>
    <div class="region-dialog-foot"><span class="hint" data-region-count></span><span class="spacer"></span>
      <button type="button" class="badge" data-region-cancel>Cancel</button>
      <button type="button" class="badge on" data-region-ok>OK</button></div>`;
  document.body.append(dlg);
  dlg.addEventListener("click", (e) => e.stopPropagation()); // keep the Options panel open
  const list = dlg.querySelector("[data-region-list]"), search = dlg.querySelector("[data-region-search]");
  const count = () => { dlg.querySelector("[data-region-count]").textContent = draft.length ? `${num(draft.length)} chosen` : ""; };
  const check = (id, text) => `<label class="check"><input type="checkbox" data-region="${esc(id)}" ${draft.includes(id) ? "checked" : ""}> ${esc(text)}</label>`;
  const draw = async () => {
    const index = await loadRegionIndex();
    const q = query.trim().toLocaleLowerCase();
    // Countries with something chosen first, then all in order.
    const picked = new Set(current.map(regionCode));
    const html = [];
    for (const c of [...index.filter((c) => picked.has(c.c)), ...index.filter((c) => !picked.has(c.c))]) {
      const countryHit = !q || c.n.toLocaleLowerCase().includes(q);
      const regions = countryHit ? c.r : c.r.filter((r) => r.toLocaleLowerCase().includes(q));
      if (!countryHit && !regions.length) continue;
      const open = !countryHit || expanded.has(c.c);
      const more = c.r.length && countryHit
        ? `<button type="button" class="region-more" data-region-more="${c.c}">${open ? "Hide regions" : `Pick from ${c.r.length} ${c.r.length === 1 ? "region" : "regions"}`}</button>` : "";
      html.push(`<div class="region-country"><div class="region-head">${check(c.c, c.n)}${more}</div>
        ${open ? `<div class="region-sub">${regions.map((r) => check(`${c.c}/${r}`, r)).join("")}</div>` : ""}</div>`);
    }
    list.innerHTML = html.join("") || `<p class="hint">Nothing found.</p>`;
  };
  search.oninput = () => { query = search.value; draw(); };
  list.onclick = (e) => {
    const more = e.target.closest("[data-region-more]");
    if (!more) return;
    const code = more.dataset.regionMore;
    if (expanded.has(code)) expanded.delete(code); else expanded.add(code);
    draw();
  };
  list.onchange = (e) => {
    const id = e.target.dataset.region;
    if (!id) return;
    const at = draft.indexOf(id);
    if (e.target.checked && at < 0) draft.push(id);
    if (!e.target.checked && at >= 0) draft.splice(at, 1);
    count();
  };
  dlg.querySelector("[data-region-cancel]").onclick = () => dlg.close();
  dlg.querySelector("[data-region-ok]").onclick = () => { onOk(draft); dlg.close(); };
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  search.focus();
  count();
  draw();
}
