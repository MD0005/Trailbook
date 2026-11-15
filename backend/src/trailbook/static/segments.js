// Segments tab (SPEC §11a): list of segment cards, segment detail and the two creators
// (from an activity slice, from map pins snapped to own tracks). Uses helpers from
// preview.js and training.js.
"use strict";

const ICON_PIN = svg(`<path d="M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>`);
const ICON_SLICE = svg(`<path d="M3 17c3-1 4-6 7-6s3 4 6 4 3-6 5-8"/><path d="M8 4v16M16 4v16" opacity=".55"/>`);
const ON_FOOT = new Set(["run", "walk", "hike"]);

// Pace for on-foot groups, speed otherwise.
const segSpeed = (mps, group) => (!mps ? "–" : ON_FOOT.has(group) ? pace(mps) : `${num(mps * 3.6, 1)} km/h`);
const mmss = (s) => {
  if (s == null) return "–";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};
const effortDay = (e) => localTime(e).slice(0, 10);
const personBit = (e) => (CURRENT === "all" ? ` · ${avatar(person(e.person_id), 16)} ${esc(personLabel(e.person_id))}` : "");
const effortDetails = (e, group) => [
  segSpeed(e.avg_speed, group),
  e.avg_hr != null ? `HR ${num(e.avg_hr)} / ${bpm(e.max_hr)}` : "",
  e.avg_power != null ? watts(e.avg_power) : "",
].filter(Boolean).join(" · ");

// ---- static mini map: OSM tiles as <image> + the line in SVG (no WebGL per card) ------

const TILE_PX = 256;
function worldPx(lat, lon, z) {
  const s = TILE_PX * 2 ** z, r = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * s, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * s];
}

function staticMap(polyline, { W = 560, H = 230, cls = "seg-map", tiles: tileCls = "seg-tiles" } = {}) {
  const pts = decodePolyline(polyline);
  if (pts.length < 2) return "";
  const source = loadMapSettings().map.source;
  const src = (BASEMAPS || []).find((b) => b.key === source);
  const maxZ = Math.min(16, src?.max_zoom ?? 16);
  let z = maxZ, px;
  for (; z > 2; z--) {
    px = pts.map(([la, lo]) => worldPx(la, lo, z));
    const xs = px.map((p) => p[0]), ys = px.map((p) => p[1]);
    if (Math.max(...xs) - Math.min(...xs) <= W * 0.8 && Math.max(...ys) - Math.min(...ys) <= H * 0.75) break;
  }
  px = pts.map(([la, lo]) => worldPx(la, lo, z));
  const xs = px.map((p) => p[0]), ys = px.map((p) => p[1]);
  const x0 = (Math.min(...xs) + Math.max(...xs)) / 2 - W / 2, y0 = (Math.min(...ys) + Math.max(...ys)) / 2 - H / 2;
  const n = 2 ** z;
  let tiles = "";
  if (src) {
    for (let tx = Math.floor(x0 / TILE_PX); tx <= Math.floor((x0 + W) / TILE_PX); tx++) {
      for (let ty = Math.floor(y0 / TILE_PX); ty <= Math.floor((y0 + H) / TILE_PX); ty++) {
        if (ty < 0 || ty >= n) continue;
        const wx = ((tx % n) + n) % n;
        tiles += `<image href="api/basemap/${src.key}/${z}/${wx}/${ty}.png" x="${tx * TILE_PX - x0}" y="${ty * TILE_PX - y0}" width="${TILE_PX}" height="${TILE_PX}"/>`;
      }
    }
  }
  const d = px.map(([x, y], i) => `${i ? "L" : "M"}${(x - x0).toFixed(1)},${(y - y0).toFixed(1)}`).join("");
  const [sx, sy] = px[0], [ex, ey] = px[px.length - 1];
  return `<svg class="${cls}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <g class="${tileCls}">${tiles}</g>
    <path d="${d}" fill="none" stroke="#fff" stroke-width="7" stroke-linejoin="round" stroke-linecap="round" opacity=".8"/>
    <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${sx - x0}" cy="${sy - y0}" r="5" fill="#3ecf8e" stroke="#fff" stroke-width="2"/>
    <circle cx="${ex - x0}" cy="${ey - y0}" r="5" fill="#ff6b6b" stroke="#fff" stroke-width="2"/></svg>`;
}

// ---- list ---------------------------------------------------------------------------------

function newSegmentPanel() {
  return `<div class="seg-new">
    <a class="seg-new-item" href="#/segments/new/map">${ICON_PIN}<span><b>From the map</b><span class="hint">Place pins along your route; they snap to your own tracks.</span></span></a>
    <a class="seg-new-item" href="#/segments/new/activity">${ICON_SLICE}<span><b>From an activity</b><span class="hint">Choose an activity and cut a part of it.</span></span></a></div>`;
}

function segmentCard(s, fqs = "") {
  const head = `<div class="seg-card-head"><span class="tile-icon">${s.category ? groupIcon(s.category, 28) : typeIcon("other", 28)}</span>
    <span class="tile-title"><b>${esc(s.name)}</b><span class="hint">${km(s.distance_m)} · ${meters(s.ascent_m)} up · ${s.category ? esc(groupLabel(s.category)) : "any type"}${s.efforts ? ` · ${num(s.efforts)} effort${s.efforts === 1 ? "" : "s"}${CURRENT === "all" && s.people > 1 ? ` · ${num(s.people)} people` : ""}` : ""}</span></span>
    ${s.pending ? state("matching…", "warn") : ""}</div>`;
  const block = (label, e) => (e ? `<div class="seg-effort"><span class="hint">${label}</span><b>${mmss(e.elapsed_s)}</b>
      <span class="hint">${effortDay(e)}${personBit(e)}</span><span class="hint">${effortDetails(e, s.category)}</span></div>` : "");
  return `<a class="card seg-card" href="#/segment/${s.id}${fqs ? "?" + fqs : ""}">
    ${staticMap(s.polyline)}${head}
    ${s.efforts ? `<div class="seg-efforts">${block("Best", s.best)}${block("Last", s.last)}</div>` : hint(s.pending ? "Looking for efforts in all activities…" : "No efforts yet.")}</a>`;
}

async function renderSegments(params) {
  const [data] = await Promise.all([api("segments?" + new URLSearchParams({ ...personParam(), ...filterQuery(params) })), (async () => { BASEMAPS ??= await api("basemaps"); })()]);
  const showEmpty = store.get("segments-empty") === "1";
  const shown = data.items.filter((s) => s.efforts || s.pending || showEmpty);
  const hidden = data.items.length - shown.length;
  const who = CURRENT === "all" ? "anyone" : esc(personLabel(CURRENT));
  view.innerHTML = `
    ${pageHead("Segments", `
      ${timeBadge(params)}${typeBadge(params)}
      ${badgeHtml("new", "New segment", "", { panel: newSegmentPanel() })}
      ${badgeHtml("options", "Options", "", { panel: `<div class="opt-panel">${checkCtl("segments-empty", showEmpty, "Show segments without efforts")}</div>` })}`)}
    ${hidden ? hint(`${num(hidden)} segment(s) without efforts by ${who} are hidden (Options).`) : ""}
    ${shown.length ? `<div class="seg-grid">${shown.map((s) => segmentCard(s, new URLSearchParams(filterQuery(params)).toString())).join("")}</div>`
      : `<div class="card">${hint(data.items.length ? `No segment has an effort by ${who} yet.` : "No segments yet. A segment is a piece of route — a climb, a sprint, a lap — and every activity that covers it gets a time. Create one with <b>New segment</b>.")}</div>`}`;
  bindBadges(view.querySelector(".page-head"));
  bindFilterBadges(view.querySelector(".page-head"), "#/segments", params);
  view.querySelector("input[name=segments-empty]").onchange = (e) => { store.set("segments-empty", e.target.checked ? "1" : "0"); renderSegments(params); };
  if (data.matching) {
    // Matching runs in the background; refresh once it is done.
    const poll = async () => {
      const d = await api("segments?" + new URLSearchParams({ ...personParam(), ...filterQuery(params) })).catch(() => null);
      if (!location.hash.startsWith("#/segments") || location.hash.includes("/new")) return;
      if (d && !d.matching) renderSegments(params); else timer = setTimeout(poll, 4000);
    };
    timer = setTimeout(poll, 3000);
  }
}

// ---- detail -------------------------------------------------------------------------------

function trendChart(rows, kind) {
  const vals = rows.flatMap((r) => [r.best_s, r.avg_s]).filter((v) => v != null);
  if (!vals.length) return hint(kind === "weeks" ? "No efforts in the last 12 weeks." : "No efforts in the last 12 months.");
  const W = 1000, H = 230, P = { l: 56, r: 12, t: 14, b: 28 };
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max(5, (hi - lo) * 0.12);
  lo -= pad; hi += pad;
  const y = (v) => P.t + ((v - lo) / (hi - lo)) * (H - P.t - P.b); // faster = higher
  const step = (W - P.l - P.r) / rows.length;
  const x = (i) => P.l + (i + 0.5) * step;
  const maxCount = Math.max(1, ...rows.map((r) => r.count));
  const bars = rows.map((r, i) => (r.count ? `<rect x="${(x(i) - step * 0.3).toFixed(1)}" width="${(step * 0.6).toFixed(1)}" y="${(H - P.b - (r.count / maxCount) * 30).toFixed(1)}" height="${((r.count / maxCount) * 30).toFixed(1)}" class="seg-count"><title>${r.count} effort(s)</title></rect>` : "")).join("");
  let line = "", prev = false;
  rows.forEach((r, i) => {
    if (r.avg_s == null) { prev = false; return; }
    line += `${prev ? "L" : "M"}${x(i).toFixed(1)},${y(r.avg_s).toFixed(1)}`;
    prev = true;
  });
  const dots = rows.map((r, i) => (r.best_s == null ? "" : `<circle cx="${x(i).toFixed(1)}" cy="${y(r.best_s).toFixed(1)}" r="5" class="seg-best"><title>${r.period}: best ${mmss(r.best_s)}, average ${mmss(r.avg_s)}, ${r.count} effort(s)</title></circle>`)).join("");
  const ticks = [lo + pad, (lo + hi) / 2, hi - pad].map((v) => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/><text x="${P.l - 8}" y="${(y(v) + 4).toFixed(1)}" class="ax" text-anchor="end">${mmss(v)}</text>`).join("");
  const label = (r) => (kind === "weeks" ? `${MONTHS[+r.period.slice(5, 7) - 1].slice(0, 3)} ${+r.period.slice(8)}` : `${MONTHS[+r.period.slice(5, 7) - 1].slice(0, 3)}${r.period.slice(5, 7) === "01" ? " " + r.period.slice(2, 4) : ""}`);
  const labels = rows.map((r, i) => `<text x="${x(i).toFixed(1)}" y="${H - 8}" class="ax" text-anchor="middle">${label(r)}</text>`).join("");
  return `<svg class="fit-chart seg-trend" viewBox="0 0 ${W} ${H}">${ticks}${bars}<path d="${line}" class="seg-avg"/>${dots}${labels}</svg>
    <div class="legend"><span><i class="seg-best-dot"></i>Best</span><span><i class="seg-avg-line"></i>Average</span><span><i class="seg-count-box"></i>Efforts</span><span class="hint">Faster is higher.</span></div>`;
}

function effortTable(rows, group, { rank = true } = {}) {
  const isAll = CURRENT === "all";
  return `<div class="scroll"><table class="data"><thead><tr>${rank ? "<th>#</th>" : ""}<th>Date</th>${isAll ? "<th>Person</th>" : ""}
      <th class="num">Time</th><th class="num">${ON_FOOT.has(group) ? "Pace" : "Speed"}</th><th class="num">Avg HR</th><th class="num">Max HR</th>
      <th class="num">Power</th><th>Activity</th></tr></thead><tbody data-rows>${rows.map((e) => effortRow(e, group, rank)).join("")}</tbody></table></div>`;
}
function effortRow(e, group, rank = true) {
  return `<tr>${rank ? `<td>${e.rank ?? ""}</td>` : ""}<td>${localTime(e)}</td>
    ${CURRENT === "all" ? `<td>${avatar(person(e.person_id), 18)} ${esc(personLabel(e.person_id))}</td>` : ""}
    <td class="num"><b>${mmss(e.elapsed_s)}</b></td><td class="num">${segSpeed(e.avg_speed, group)}</td>
    <td class="num">${bpm(e.avg_hr)}</td><td class="num">${bpm(e.max_hr)}</td><td class="num">${watts(e.avg_power)}</td>
    <td><a href="#/activity/${e.activity_id}">${typeName(e.activity_type, e.activity_name || typeLabel(e.activity_type))}</a></td></tr>`;
}

function effortCard(title, e, group) {
  if (!e) return `<div class="card"><h3>${title}</h3>${hint("–")}</div>`;
  const stat = (label, value) => `<div class="stat"><span class="hint">${label}</span><b>${value}</b></div>`;
  return `<div class="card"><h3>${title}</h3>
    <div class="card-row"><span class="hint">${localTime(e)}${personBit(e)} · <a href="#/activity/${e.activity_id}">${esc(e.activity_name || typeLabel(e.activity_type))}</a>${e.rank ? ` · rank ${e.rank}` : ""}</span></div>
    <div class="grid">${stat("Time", mmss(e.elapsed_s))}${stat("Moving time", mmss(e.moving_s))}
      ${stat(ON_FOOT.has(group) ? "Pace" : "Speed", segSpeed(e.avg_speed, group))}${stat("Avg HR", bpm(e.avg_hr))}
      ${stat("Max HR", bpm(e.max_hr))}${stat("Avg power", watts(e.avg_power))}${stat("Cadence", cadence(e.avg_cadence, group))}</div></div>`;
}

async function renderSegment(id, params) {
  const pq = new URLSearchParams({ ...personParam(), ...filterQuery(params) });
  const d = await api(`segments/${id}?${pq}`);
  const s = d.segment, g = s.category, sum = d.summary;
  const trendKind = store.get("segment-trend") === "months" ? "months" : "weeks";
  const effortSort = params.sort === "date" ? "date" : "time";
  const allQ = { ...personParam(), ...filterQuery(params), sort: effortSort, limit: 50 };
  const first = await api(`segments/${id}/efforts?${new URLSearchParams(allQ)}`);
  const grade = s.ascent_m != null && s.distance_m ? ` · ${num((s.ascent_m / s.distance_m) * 100, 1)} % avg climb` : "";
  view.innerHTML = `
    ${backLink(`#/segments${new URLSearchParams(filterQuery(params)).toString() ? "?" + new URLSearchParams(filterQuery(params)) : ""}`, "Segments")}
    <div class="page-head"><h2 class="tb-activity-name">${s.category ? groupIcon(s.category, 24) : typeIcon("other", 24)}<span>${esc(s.name)}</span></h2>
      <div class="badges">${timeBadge(params)}${typeBadge(params)}${s.pending ? state("matching…", "warn") : ""}</div><span class="spacer"></span>
      <button data-rename>Rename</button><button class="danger" data-del>${ICON.trash} Delete</button></div>
    <div class="card"><div id="seg-map" class="map"></div>
      ${hint(`${s.category ? `Matches ${esc(groupLabel(s.category).toLowerCase())} activities` : "Matches activities of any type"} · created ${s.source === "map" ? "from map pins" : "from an activity"}${d.source ? ` (<a href="#/activity/${d.source.id}">${esc(d.source.name || typeLabel(d.source.activity_type))}</a>, ${localTime(d.source).slice(0, 10)})` : ""}.`)}
      ${checkCtl("any-type", !s.category, "Match activities of any type")}</div>
    ${statStrip([
      ["Distance", km(s.distance_m), ""],
      ["Elevation gain", meters(s.ascent_m), grade.slice(3)],
      ["Efforts", num(sum.count), CURRENT === "all" && d.people.length ? `${num(d.people.length)} ${d.people.length === 1 ? "person" : "people"}` : ""],
      ["Best", mmss(sum.best_s), d.best ? effortDay(d.best) : ""],
      ["Average", mmss(sum.avg_s), sum.median_s != null ? `median ${mmss(sum.median_s)}` : ""],
      ["Last", d.last ? mmss(d.last.elapsed_s) : "–", d.last ? effortDay(d.last) : ""],
    ])}
    ${sum.count ? `
    <div class="cards">${effortCard("Last effort", d.last, g)}${effortCard("Best effort", d.best, g)}</div><br>
    <div class="card"><div class="card-row"><h3 style="margin:0">Trend</h3><span class="spacer"></span>
      ${switchHtml("trend", [["weeks", "Last 12 weeks"], ["months", "Last 12 months"]], trendKind)}</div>
      ${trendChart(d.trend[trendKind], trendKind)}</div>
    ${CURRENT === "all" && d.people.length ? `<div class="card"><h3>People</h3><div class="scroll"><table class="data"><thead><tr><th>Person</th>
      <th class="num">Best</th><th class="num">Average</th><th class="num">Efforts</th><th>Last</th></tr></thead><tbody>
      ${d.people.map((p) => `<tr><td>${avatar(person(p.person_id), 18)} ${esc(personLabel(p.person_id))}</td><td class="num"><b>${mmss(p.best_s)}</b></td>
        <td class="num">${mmss(p.avg_s)}</td><td class="num">${num(p.count)}</td><td>${mmss(p.last.elapsed_s)} <span class="hint">${effortDay(p.last)}</span></td></tr>`).join("")}
      </tbody></table></div></div>` : ""}
    <div class="card"><h3>Top 10</h3>${effortTable(d.top, g)}</div>
    <div class="card" data-all><div class="card-row"><h3 style="margin:0">All efforts</h3><span class="hint" data-count>${countText(first.items.length, first.total)}</span><span class="spacer"></span>
      ${switchHtml("esort", [["time", "Fastest"], ["date", "Newest"]], effortSort)}</div>
      ${effortTable(first.items, g)}
      ${first.items.length < first.total ? `<div class="sentinel" data-sentinel><span class="hint">Loading…</span></div>` : ""}</div>`
    : `<div class="card">${hint(s.pending ? "Looking for efforts in all activities…" : CURRENT === "all" ? "No activity covers this segment yet." : `${esc(personLabel(CURRENT))} has no effort on this segment yet.`)}</div>`}`;

  bindBadges(view.querySelector(".page-head"));
  bindFilterBadges(view.querySelector(".page-head"), `#/segment/${id}`, params);
  view.querySelectorAll("[data-switch=trend]").forEach((b) => b.onclick = () => { store.set("segment-trend", b.dataset.value); renderSegment(id, params); });
  view.querySelectorAll("[data-switch=esort]").forEach((b) => b.onclick = () => { location.hash = `#/segment/${id}?${new URLSearchParams({ ...filterQuery(params), ...(b.dataset.value === "date" ? { sort: "date" } : {}) })}`; });
  const all = view.querySelector("[data-all]");
  if (all) infinite(all, first.items.length, first.total,
    async (offset) => (await api(`segments/${id}/efforts?${new URLSearchParams({ ...allQ, offset })}`)).items,
    (items) => all.querySelector("[data-rows]").insertAdjacentHTML("beforeend", items.map((e) => effortRow(e, g)).join("")));
  view.querySelector("[data-rename]").onclick = async () => {
    const name = prompt("Segment name", s.name);
    if (!name || name.trim() === s.name) return;
    await api(`segments/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }).catch((e) => alert(e.message));
    renderSegment(id, params);
  };
  view.querySelector("input[name=any-type]").onchange = async (e) => {
    await api(`segments/${id}`, { method: "PATCH", body: JSON.stringify({ any_type: e.target.checked }) }).catch((err) => alert(err.message));
    renderSegment(id, params);
  };
  view.querySelector("[data-del]").onclick = async () => {
    if (!confirm(`Delete the segment “${s.name}” and all its efforts?\n\nActivities are not touched.`)) return;
    await api(`segments/${id}`, { method: "DELETE" });
    location.hash = "#/segments";
  };
  showRouteMap("seg-map", s.polyline).catch((e) => {
    document.getElementById("seg-map").outerHTML = state("Map unavailable: " + esc(e.message), "bad") + staticMap(s.polyline);
  });
  if (s.pending) timer = setTimeout(() => renderSegment(id, params), 4000);
}

// ---- creator: from an activity ------------------------------------------------------------

const cssAccent = () => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#0284c7";
const lineFeature = (coords) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } });

function haversine(a, b) {
  const r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

async function renderSegmentFromActivity(params) {
  if (params.id) return segmentSlicer(params.id, params);
  const q = { gps: 1, limit: PAGE_SIZE, sort: "date", dir: "desc", ...personParam() };
  if (params.q) q.q = params.q;
  const fetchPage = (offset) => api("activities?" + new URLSearchParams({ ...q, offset }));
  const data = await fetchPage(0);
  const row = (a) => `<tr><td><a href="#/segments/new/activity?id=${a.id}">${localTime(a)}</a></td><td>${typeName(a.activity_type)}</td>
    <td><a href="#/segments/new/activity?id=${a.id}">${esc(a.name || typeLabel(a.activity_type))}</a></td><td class="num">${km(a.distance_m)}</td>
    <td class="num">${dur(a.moving_s)}</td>${CURRENT === "all" ? `<td>${avatar(person(a.person_id), 18)} ${esc(personLabel(a.person_id))}</td>` : ""}</tr>`;
  view.innerHTML = `
    ${backLink(`#/segments`, "Segments")}
    ${pageHead("New segment from an activity")}
    <div class="card">${hint("Step 1 of 2 — choose an activity with GPS. Next you cut the part that becomes the segment.")}
      <form class="card-row" data-search><input name="q" placeholder="Search by name…" value="${esc(params.q || "")}" style="min-width:240px"><button class="primary">Search</button></form>
      <div class="scroll"><table class="data"><thead><tr><th>Date</th><th>Type</th><th>Name</th><th class="num">Distance</th><th class="num">Moving time</th>${CURRENT === "all" ? "<th>Person</th>" : ""}</tr></thead>
      <tbody data-rows>${data.items.map(row).join("") || `<tr><td colspan="6" class="hint">No activities with GPS.</td></tr>`}</tbody></table></div>
      ${data.items.length < data.total ? `<div class="sentinel" data-sentinel><span class="hint">Loading…</span></div>` : ""}</div>`;
  view.querySelector("[data-search]").onsubmit = (e) => {
    e.preventDefault();
    const v = e.target.q.value.trim();
    location.hash = "#/segments/new/activity" + (v ? "?" + new URLSearchParams({ q: v }) : "");
  };
  infinite(view, data.items.length, data.total, async (offset) => (await fetchPage(offset)).items,
    (items) => view.querySelector("[data-rows]").insertAdjacentHTML("beforeend", items.map(row).join("")));
}

async function segmentSlicer(id, params = {}) {
  const [a, s] = await Promise.all([api("activities/" + id), api(`activities/${id}/streams?channels=time,lat,lon,altitude&max_points=3000`)]);
  const st = s.streams;
  const idx = [];
  for (let i = 0; i < (st.time || []).length; i++) if (st.lat?.[i] != null && st.lon?.[i] != null && st.time[i] != null) idx.push(i);
  if (idx.length < 2) { view.innerHTML = `<div class="card">${state("This activity has no GPS track.", "bad")}</div>`; return; }
  const P = idx.map((i) => [st.lat[i], st.lon[i]]), T = idx.map((i) => st.time[i]), A = idx.map((i) => st.altitude?.[i] ?? null);
  const D = [0];
  for (let i = 1; i < P.length; i++) D.push(D[i - 1] + haversine(P[i - 1], P[i]));
  const n = P.length - 1;
  let lo = Math.round(n * 0.25), hi = Math.round(n * 0.75);
  const coords = P.map(([la, lo2]) => [lo2, la]);

  // Elevation (or distance) profile with the chosen window highlighted.
  const W = 1000, H = 120;
  const alts = A.filter((v) => v != null);
  const aLo = alts.length ? Math.min(...alts) : 0, aHi = alts.length ? Math.max(...alts) : 1;
  const px = (i) => (D[i] / (D[n] || 1)) * W;
  const py = (v) => H - 6 - ((v - aLo) / (aHi - aLo || 1)) * (H - 16);
  const prof = alts.length ? A.map((v, i) => (v == null ? "" : `${i ? "L" : "M"}${px(i).toFixed(1)},${py(v).toFixed(1)}`)).join("") : "";

  view.innerHTML = `
    ${params.from === "activity" ? backLink(`#/activity/${params.id}`, "Activity") : backLink(`#/segments/new/activity`, "Choose another activity")}
    ${pageHead("New segment from an activity")}
    <div class="card">
      <div id="slice-map" class="map seg-big-map"></div>
      <svg class="seg-profile" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <rect data-win y="0" height="${H}" class="seg-window"/>
        ${prof ? `<path d="${prof}" class="seg-profile-line" vector-effect="non-scaling-stroke"/>` : ""}</svg>
      <div class="tf-slider seg-slider"><div class="tf-track"><div class="tf-fill" data-fill></div></div>
        <input type="range" class="tf-thumb" min="0" max="${Math.round(D[n])}" data-end="lo" aria-label="Start">
        <input type="range" class="tf-thumb" min="0" max="${Math.round(D[n])}" data-end="hi" aria-label="End"></div>
      <div class="tf-values"><span data-at="lo"></span><span data-at="hi"></span></div>
      <div class="stat-strip seg-slice-stats">
        <div class="stat-item"><span class="stat-label">Length</span><span class="stat-value" data-len></span><span class="stat-note" data-len-note></span></div>
        <div class="stat-item"><span class="stat-label">Time</span><span class="stat-value" data-time></span></div>
        ${alts.length ? `<div class="stat-item"><span class="stat-label">Climb</span><span class="stat-value" data-up></span></div>` : ""}</div>
      <div class="seg-slice-form">
        <input name="seg-name" placeholder="Segment name" maxlength="120">
        ${checkCtl("any-type", false, `Any activity type, not only ${esc(groupLabel(a.category).toLowerCase())}`)}</div>
      <div class="panel-actions"><span data-msg></span><button class="primary" data-save>Create segment</button></div></div>`;
  const inputs = { lo: view.querySelector('[data-end="lo"]'), hi: view.querySelector('[data-end="hi"]') };
  const win = view.querySelector("[data-win]"), fill = view.querySelector("[data-fill]");
  const at = (m) => { // index of the point nearest to a distance along the track
    let a0 = 0, b0 = n;
    while (b0 - a0 > 1) { const mid = (a0 + b0) >> 1; if (D[mid] < m) a0 = mid; else b0 = mid; }
    return m - D[a0] <= D[b0] - m ? a0 : b0;
  };
  let map = null, raf = 0;
  const update = () => {
    raf = 0;
    if (lo > hi) [lo, hi] = [hi, lo];
    inputs.lo.value = Math.round(D[lo]); inputs.hi.value = Math.round(D[hi]);
    win.setAttribute("x", px(lo).toFixed(1));
    win.setAttribute("width", Math.max(1, px(hi) - px(lo)).toFixed(1));
    fill.style.left = `${(px(lo) / W) * 100}%`;
    fill.style.width = `${((px(hi) - px(lo)) / W) * 100}%`;
    view.querySelector('[data-at="lo"]').textContent = `Start ${km(D[lo])}`;
    view.querySelector('[data-at="hi"]').textContent = `End ${km(D[hi])}`;
    const len = D[hi] - D[lo];
    let up = 0;
    for (let i = lo + 1; i <= hi; i++) if (A[i] != null && A[i - 1] != null && A[i] > A[i - 1]) up += A[i] - A[i - 1];
    view.querySelector("[data-len]").textContent = km(len);
    view.querySelector("[data-len-note]").innerHTML = len < 100 ? state("at least 100 m", "bad") : "";
    view.querySelector("[data-time]").textContent = dur(T[hi] - T[lo]);
    if (alts.length) view.querySelector("[data-up]").textContent = `${meters(up)}`;
    if (map?.getSource("slice")) {
      map.getSource("slice").setData(lineFeature(coords.slice(lo, hi + 1)));
      map.getSource("ends").setData({ type: "FeatureCollection", features: [
        { type: "Feature", properties: { c: "#3ecf8e" }, geometry: { type: "Point", coordinates: coords[lo] } },
        { type: "Feature", properties: { c: "#ff6b6b" }, geometry: { type: "Point", coordinates: coords[hi] } }] });
    }
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
  // One slider, two thumbs: a thumb pushes the other one along instead of crossing it.
  inputs.lo.oninput = () => { lo = at(+inputs.lo.value); if (lo > hi) hi = lo; schedule(); };
  inputs.hi.oninput = () => { hi = at(+inputs.hi.value); if (hi < lo) lo = hi; schedule(); };
  view.querySelector(".seg-slider").addEventListener("pointerdown", (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const m = ((e.clientX - r.left) / r.width) * D[n];
    const lower = Math.abs(m - D[lo]) <= Math.abs(m - D[hi]) && !(lo === hi && m > D[hi]);
    inputs.lo.style.zIndex = lower ? 3 : 2;
    inputs.hi.style.zIndex = lower ? 2 : 3;
  });
  update();
  view.querySelector("[data-save]").onclick = async (e) => {
    const msg = view.querySelector("[data-msg]");
    e.currentTarget.disabled = true;
    try {
      const seg = await api("segments", { method: "POST", body: JSON.stringify({
        activity_id: a.id, start_s: T[lo], end_s: T[hi], name: view.querySelector("input[name=seg-name]").value,
        any_type: view.querySelector("input[name=any-type]").checked }) });
      location.hash = `#/segment/${seg.id}`;
    } catch (err) {
      msg.innerHTML = state(esc(err.message), "bad");
      e.currentTarget.disabled = false;
    }
  };
  try {
    map = await createMap("slice-map", loadMapSettings().map, { bounds: boundsOf([coords]) });
    map.addSource("full", { type: "geojson", data: lineFeature(coords) });
    map.addLayer({ id: "full", type: "line", source: "full", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#8b92a3", "line-width": 3, "line-opacity": 0.8 } });
    map.addSource("slice", { type: "geojson", data: lineFeature(coords.slice(lo, hi + 1)) });
    map.addLayer({ id: "slice", type: "line", source: "slice", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": cssAccent(), "line-width": 5 } });
    map.addSource("ends", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "ends", type: "circle", source: "ends", paint: { "circle-radius": 6, "circle-color": ["get", "c"], "circle-stroke-width": 2, "circle-stroke-color": "#fff" } });
    update();
    map.on("click", (ev) => {
      let best = 0, bd = Infinity;
      coords.forEach(([x, y], i) => { const dd = (x - ev.lngLat.lng) ** 2 + (y - ev.lngLat.lat) ** 2; if (dd < bd) { bd = dd; best = i; } });
      if (Math.abs(best - lo) <= Math.abs(best - hi)) lo = best; else hi = best;
      schedule();
    });
  } catch (err) {
    document.getElementById("slice-map").outerHTML = state("Map unavailable: " + esc(err.message), "bad");
  }
}

// ---- creator: from map pins snapped to own tracks -----------------------------------------

async function renderSegmentFromMap(params) {
  const q = personParam();
  const [tracks] = await Promise.all([api("heatmap/tracks?" + new URLSearchParams(q)), (async () => { BASEMAPS ??= await api("basemaps"); })()]);
  const groups = [...new Set(tracks.items.map((t) => t.category))];
  view.innerHTML = `
    ${backLink(`#/segments`, "Segments")}
    ${pageHead("New segment from the map")}
    <div class="card">${hint("Click the map to place pins along the route, in riding order (drag a pin to move it). Grey lines are your routes; the segment follows the activity that passes every pin (within 50 m), cut between the first and the last pin.")}
      <div class="card-row">${row("Group", selectCtl("snap-group", [["", "Any group"], ...groups.map((g) => [g, groupLabel(g)])], ""))}
        <span data-pins class="hint">No pins yet.</span><span class="spacer"></span>
        <button data-undo>Undo pin</button><button data-clear>Clear</button><button class="primary" data-snap>Snap to my tracks</button></div>
      <div id="pin-map" class="map seg-big-map"></div>
      <div data-result></div></div>`;
  const pins = [];
  const markers = [];
  let result = null;
  const map = await createMap("pin-map", loadMapSettings().map, (() => { const b = boundsOf(tracks.items.map((t) => lonLat(t.polyline))); return b ? { bounds: b } : {}; })());
  map.addSource("routes", { type: "geojson", data: { type: "FeatureCollection", features: tracks.items.map((t) => lineFeature(lonLat(t.polyline))) } });
  map.addLayer({ id: "routes", type: "line", source: "routes", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#6b7280", "line-width": 2, "line-opacity": 0.45 } });
  map.addSource("snapped", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "snapped", type: "line", source: "snapped", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": cssAccent(), "line-width": 5 } });
  map.getCanvas().style.cursor = "crosshair";
  const ml = window.maplibregl;
  const resultEl = view.querySelector("[data-result]");
  const clearResult = () => { result = null; resultEl.innerHTML = ""; map.getSource("snapped").setData({ type: "FeatureCollection", features: [] }); };
  const refresh = () => {
    markers.forEach((m, i) => { m.getElement().textContent = String(i + 1); });
    view.querySelector("[data-pins]").textContent = pins.length ? `${pins.length} pin(s)` : "No pins yet.";
  };
  const addPin = (lngLat) => {
    const el = document.createElement("div");
    el.className = "seg-pin";
    const m = new ml.Marker({ element: el, draggable: true }).setLngLat(lngLat).addTo(map);
    m.on("dragend", () => { const p = m.getLngLat(); pins[markers.indexOf(m)] = [p.lat, p.lng]; clearResult(); });
    pins.push([lngLat.lat, lngLat.lng]); markers.push(m);
    clearResult(); refresh();
  };
  map.on("click", (e) => addPin(e.lngLat));
  view.querySelector("[data-undo]").onclick = () => { pins.pop(); markers.pop()?.remove(); clearResult(); refresh(); };
  view.querySelector("[data-clear]").onclick = () => { pins.length = 0; markers.splice(0).forEach((m) => m.remove()); clearResult(); refresh(); };
  view.querySelector("[data-snap]").onclick = async (e) => {
    const btn = e.currentTarget;
    if (pins.length < 2) { resultEl.innerHTML = state("Place at least two pins.", "bad"); return; }
    btn.disabled = true;
    resultEl.innerHTML = state("Searching your activities…", "warn");
    try {
      result = await api("segments/snap", { method: "POST", body: JSON.stringify({ pins, category: view.querySelector("select[name=snap-group]").value || null }) });
      map.getSource("snapped").setData(lineFeature(lonLat(result.polyline)));
      resultEl.innerHTML = `<div class="card-row"><b>${km(result.distance_m)}</b><span class="hint">following
          <a href="#/activity/${result.activity_id}">${esc(result.activity_name || typeLabel(result.activity_type))}</a> (${localTime(result).slice(0, 10)}),
          pins on average ${meters(result.pin_distance_m)} from the track · ${num(result.candidates)} activities checked</span></div>
        <div class="card-row"><input name="seg-name" placeholder="Segment name" style="min-width:260px" maxlength="120">
          ${checkCtl("any-type", false, `Match any activity type (otherwise ${esc(groupLabel(result.category).toLowerCase())} only)`)}
          <span class="spacer"></span><span data-msg></span><button class="primary" data-save>Create segment</button></div>`;
      resultEl.querySelector("[data-save]").onclick = async (ev) => {
        ev.currentTarget.disabled = true;
        try {
          const seg = await api("segments", { method: "POST", body: JSON.stringify({
            activity_id: result.activity_id, start_s: result.start_s, end_s: result.end_s, source: "map",
            name: resultEl.querySelector("input[name=seg-name]").value, any_type: resultEl.querySelector("input[name=any-type]").checked }) });
          location.hash = `#/segment/${seg.id}`;
        } catch (err) {
          resultEl.querySelector("[data-msg]").innerHTML = state(esc(err.message), "bad");
          ev.currentTarget.disabled = false;
        }
      };
    } catch (err) {
      resultEl.innerHTML = state(esc(err.message), "bad");
    } finally { btn.disabled = false; }
  };
}
