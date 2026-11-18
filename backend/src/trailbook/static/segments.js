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

let SEGMENT_CHART = null; // trend chart group of the page (destroyed on the next render)

// Trend: every effort's time over the Time filter (chart standard, docs/CHARTS.md). Faster is higher.
function segmentTrend(root, series) {
  SEGMENT_CHART?.destroy();
  SEGMENT_CHART = null;
  if (!root || series.length < 2) return;
  const x = series.map((e) => Date.parse(e.start_time_utc) / 1000 + (e.utc_offset_s || 0));
  const v = series.map((e) => e.elapsed_s);
  const avg = v.reduce((p, q) => p + q, 0) / v.length;
  SEGMENT_CHART = chartGroup(root, {
    x: { date: x }, kind: "date",
    series: [{
      key: "time", label: "Time", title: "Trend", icon: "elapsed_time", unit: "m:ss", values: v, fmt: mmss, points: true, fill: false,
      invert: true, color: cssAccent(), tip: "The time of every effort in the chosen period. Faster is higher.",
      stats: [["Best", mmss(Math.min(...v)), "min", "Fastest time in the period"],
        ["Avg", mmss(avg), avg, "Average time in the period"],
        ["Last", mmss(v[v.length - 1]), { ranges: [[v.length - 1, v.length - 1]] }, "The latest effort"]],
    }],
  });
}

// ---- weather of an effort: did it help? -------------------------------------------------
//
// The weather is the activity's (Open-Meteo, hourly, for the area: see weather.py). Wind
// counts most: its component along the segment in the riding direction, averaged over the
// length (each piece of the route weighted by its length), so a loop or an out-and-back
// cancels out by itself. Positive = tailwind. Model wind at 10 m, km/h.
function segWindAlong(polyline, reverse, w) {
  if (w?.wind_speed == null || w.wind_dir == null || !polyline) return null;
  let pts = decodePolyline(polyline);
  if (reverse) pts = pts.slice().reverse();
  const to = ((w.wind_dir + 180) * Math.PI) / 180; // where the wind blows to (bearing)
  const wx = Math.sin(to), wy = Math.cos(to);
  let along = 0, total = 0, both = 0;
  for (let i = 1; i < pts.length; i++) {
    const [la0, lo0] = pts[i - 1], [la1, lo1] = pts[i];
    const dx = (lo1 - lo0) * Math.cos((la0 * Math.PI) / 180), dy = la1 - la0;
    const len = Math.hypot(dx, dy);
    if (!len) continue;
    const a = dx * wx + dy * wy; // = len * cos(angle between the route and the wind)
    along += a;
    both += Math.abs(a);
    total += len;
  }
  if (!total) return null;
  // mixed: 0 when the whole segment runs one way to the wind, 1 when tail and head parts
  // cancel out (a loop, out and back)
  return { tail: (w.wind_speed * along) / total, mixed: both ? 1 - Math.abs(along) / both : 0 };
}
// Weights per sport (docs/MANUAL.md, "Weather help"). Rides: wind counts fully, comfortable
// 12–24 °C. Runs: about a third of the wind (lower speed, so less drag from it), cooler is
// better (8–18 °C), heat costs more, rain less. Other sports and indoor or virtual
// activities (trainer, Zwift, treadmill) get no verdict: the model weather is not theirs.
const HELP_PROFILES = {
  ride: { label: "riding", wind: 1, loop: 0.1, loopMax: 3, lo: 12, cold: 0.5, hi: 24, heat: 0.6, tempMax: 8,
          rain: -3, rainHeavy: -5, snow: -5, storm: -4 },
  run: { label: "running", wind: 0.35, loop: 0.035, loopMax: 1, lo: 8, cold: 0.3, hi: 18, heat: 0.8, tempMax: 10,
         rain: -1, rainHeavy: -2, snow: -3, storm: -2 },
};
function helpProfile(activityType) {
  const t = typeOf(activityType);
  return !t || t.indoor ? null : HELP_PROFILES[t.group] || null;
}
const isIndoor = (activityType) => Boolean(typeOf(activityType)?.indoor);
const isSnow = (code) => (code >= 71 && code <= 77) || code === 85 || code === 86;
// The verdict in points (1 point ≈ 1 km/h of tailwind on a bike): wind along the route first,
// a small cost for wind both ways (a loop is not quite neutral: headwind parts take longer
// than tailwind parts save), then temperature and rain or snow. Returns { score, level
// (-3..3), tip } with the breakdown of this case, or null without weather or a profile.
const HELP_WORDS = { 3: "Helped a lot", 2: "Helped", 1: "Helped a little", 0: "About neutral",
  "-1": "Held back a little", "-2": "Held back", "-3": "Held back a lot" };
const signed = (v) => `${v >= 0.5 ? "+" : v <= -0.5 ? "−" : "±"}${num(Math.abs(v))}`;
function weatherHelp(polyline, reverse, w, prof, what = "segment") {
  if (!w || w.temp == null || !prof) return null;
  const along = segWindAlong(polyline, reverse, w), tail = along?.tail ?? null;
  const windTerm = (tail ?? 0) * prof.wind;
  const loopTerm = along ? -Math.min(prof.loopMax, prof.loop * (w.wind_speed || 0) * along.mixed) : 0;
  const t = w.temp, code = w.code ?? 0, wet = w.precip ?? 0;
  const tempTerm = t < prof.lo ? -Math.min(prof.tempMax, (prof.lo - t) * prof.cold) : t > prof.hi ? -Math.min(prof.tempMax, (t - prof.hi) * prof.heat) : 0;
  const wetTerm = isSnow(code) ? prof.snow : code >= 95 ? prof.storm : wet >= 3 ? prof.rainHeavy : wet >= 0.5 ? prof.rain : 0;
  const score = windTerm + loopTerm + tempTerm + wetTerm;
  const level = score >= 10 ? 3 : score >= 4 ? 2 : score >= 1.5 ? 1 : score > -1.5 ? 0 : score > -4 ? -1 : score > -10 ? -2 : -3;
  const from = w.wind_dir != null ? COMPASS[Math.round(w.wind_dir / 45) % 8] : "";
  const weight = prof.wind !== 1 ? ` (× ${num(prof.wind, 2)} for ${prof.label})` : "";
  // The tooltip (HTML): the verdict in bold, then each part with its name in bold, a blank
  // line between them.
  const part = (name, text) => `<b>${name}</b> ${esc(text)}`;
  const parts = [
    part("Wind", tail == null ? "no data → ±0"
      : `${Math.abs(tail) < 3 ? "about neutral" : tail > 0 ? "tailwind" : "headwind"} ${num(Math.abs(tail))} km/h along the ${what} (${num(w.wind_speed)} km/h from the ${from})${weight} → ${signed(windTerm)}`),
    loopTerm <= -0.5 && part("Wind both ways", `${num(along.mixed * 100)} % of the ${what} cancels out: headwind costs more than tailwind gives → ${signed(loopTerm)}`),
    part("Temperature", `${num(t)} °C${tempTerm ? (t < prof.lo ? ", cold" : ", hot") : ", comfortable"} for ${prof.label} (${prof.lo}–${prof.hi} °C) → ${signed(tempTerm)}`),
    part(isSnow(code) ? "Snow" : code >= 95 ? "Thunderstorm" : "Rain", `${wet ? `${num(wet, 1)} mm` : "dry"} → ${signed(wetTerm)}`),
  ].filter(Boolean);
  const title = `${HELP_WORDS[level]} (${signed(score)})`;
  const tip = `<b>${title}</b>\n\n${parts.join("\n\n")}\n\n<span class="tip-note">Points: 1 ≈ 1 km/h of tailwind on a bike. Hourly model weather for the area.</span>`;
  return { score, level, tip, title };
}
const parseWx = (e) => {
  if (!e.weather) return undefined; // not looked up yet
  try { const w = typeof e.weather === "string" ? JSON.parse(e.weather) : e.weather; return w?.points ? w : null; } catch { return null; }
};
// Diverging meter: from the middle axis to the right when the weather helped, to the left when
// it held back (full half at 15 points); square at the axis, rounded at the end; the
// breakdown on hover.
function helpMeter(h) {
  const f = Math.max(-1, Math.min(1, h.score / 15)), w = Math.max(Math.abs(f) * 50, 3);
  // the bar covers the 1 px axis column, so it sits flush on the axis on either side
  const pos = f >= 0 ? `left:50%;width:${w}%` : `right:calc(50% - 1px);width:calc(${w}% + 1px)`;
  return `<span class="wx-meter l${h.level}" data-tip-html="${esc(h.tip)}" aria-label="${esc(h.title)}"><b></b><i class="${f >= 0 ? "pos" : "neg"}" style="${pos}"></i></span>`;
}
// Weather cell: sky icon, temperature, wind arrow (where it blows) and speed, then the meter
// (rides and runs outdoors only). Indoor and virtual activities: no weather at all.
function weatherCell(w, polyline, reverse, activityType) {
  if (isIndoor(activityType)) return ""; // indoor or virtual: outdoor weather does not apply
  if (!w) return `<span class="hint">–</span>`;
  const sky = WMO.find(([max]) => (w.code ?? 0) <= max) || WMO[WMO.length - 1];
  const help = weatherHelp(polyline, reverse, w, helpProfile(activityType));
  return `<span class="seg-wx"><svg class="seg-wx-sky" viewBox="0 0 24 24" fill="none" aria-label="${sky[1]}"><title>${sky[1]}</title>${SKY_SVG[sky[2]]}</svg>
    <span class="seg-wx-temp">${num(w.temp)} °C</span>${w.wind_speed != null ? `<span class="seg-wx-wind"><svg viewBox="0 0 24 24" style="transform:rotate(${(w.wind_dir ?? 0) + 180}deg)"><path d="M12 3v16M12 3l-4.5 5M12 3l4.5 5" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>${num(w.wind_speed)} km/h</span>` : `<span class="seg-wx-wind"></span>`}
    ${help ? helpMeter(help) : ""}</span>`;
}
// The meter for a whole activity (under the weather widget on its route map), or "".
function activityHelpHtml(a, polyline, w) {
  const h = weatherHelp(polyline, false, w, helpProfile(a.activity_type), "route");
  return h ? helpMeter(h) : "";
}
// Column widths of the effort tables, like the list tables: each column as wide as its content,
// the spare width as equal visible gaps between columns (gapPlan). Tables with the same columns
// get one set of widths, so tables one under another line up. Called after rendering, whenever
// rows or weather are added, and on resize.
function fitEffortCols(root) {
  const groups = new Map();
  root.querySelectorAll(".seg-table").forEach((t) => {
    if (!t.offsetParent) return; // not laid out (hidden)
    const key = [...t.tHead.rows[0].cells].map((th) => th.textContent.replace(/[▲▼↕]/g, "").trim()).join("|");
    groups.set(key, [...(groups.get(key) || []), t]);
  });
  for (const tables of groups.values()) {
    const cols = tables.map((t) => [...t.querySelectorAll("col")]);
    tables.forEach((t, k) => { cols[k].forEach((c) => { c.style.width = ""; }); clearGapPads(t); Object.assign(t.style, { tableLayout: "auto", width: "max-content", minWidth: "0" }); });
    const natural = [];
    tables.forEach((t) => [...t.tHead.rows[0].cells].forEach((th, i) => {
      natural[i] = Math.max(natural[i] || 0, Math.ceil(th.getBoundingClientRect().width));
    }));
    tables.forEach((t) => Object.assign(t.style, { tableLayout: "", width: "", minWidth: "" }));
    const n = natural.length, total = natural.reduce((s, w) => s + w, 0);
    const avail = Math.min(...tables.map((t) => t.parentElement.clientWidth));
    const right = [...tables[0].tHead.rows[0].cells].map((th) => th.classList.contains("num"));
    const { widths, pads } = gapPlan(natural, right, avail);
    tables.forEach((t, k) => {
      t.style.minWidth = `${total}px`; // narrow screen: scrolls instead of squeezing
      cols[k].forEach((c, i) => { c.style.width = `${widths[i]}px`; });
      setGapPads(t, pads);
    });
  }
}
let effortResize = 0;
window.addEventListener("resize", () => {
  cancelAnimationFrame(effortResize);
  effortResize = requestAnimationFrame(() => { const v = document.getElementById("view"); if (v?.querySelector(".seg-table")) fitEffortCols(v); });
});
// Rows whose activity has no weather yet: look it up (one activity at a time; cached on the
// server, so this happens once per activity).
async function fillWeather(root) {
  const cells = [...root.querySelectorAll("td[data-wx-pending]")];
  const ids = [...new Set(cells.map((c) => c.dataset.wxPending))];
  for (const id of ids) {
    const w = await api(`activities/${id}/weather`).catch(() => null);
    if (!root.isConnected) return;
    root.querySelectorAll(`td[data-wx-pending="${id}"]`).forEach((td) => {
      td.innerHTML = weatherCell(w && w.temp != null ? w : null, td.closest("table").dataset.polyline, td.dataset.rev === "1", td.dataset.type);
      td.removeAttribute("data-wx-pending");
    });
    fitEffortCols(root.closest("#view") || root);
  }
}

// Effort tables, the same everywhere (segment page, segment card on an activity): the header
// (icon + label) of the activity list. Options: `sort` - the Date and Time headers sort the
// table (All efforts); `power` - the Avg power column; `sections` - [[title, rows]] with a
// small title row each; `thisId` - the effort of the open activity, marked; `polyline` -
// the segment's line: adds the Weather column (with the help badge) as the last one.
function effortTable(rows, group, { sort = null, power = SEG_HAS_POWER, sections = null, thisId = null, polyline = null } = {}) {
  const head = (icon, label, key = null, isNum = true) => {
    const inner = `<span class="th-icon">${icon ? metricIcon(icon) : ""}${label}</span>`;
    if (!sort || !key) return `<th class="${isNum ? "num" : ""}">${inner}</th>`;
    const on = sort === key;
    return `<th class="${isNum ? "num" : ""}"><a href="#" class="sort ${on ? "active" : ""}" data-esort="${key}">${inner} <span class="arrow">${on ? (key === "date" ? "▼" : "▲") : "↕"}</span></a></th>`;
  };
  const onFoot = ON_FOOT.has(group), opts = { power, thisId, wx: Boolean(polyline), polyline };
  const cols = 8 + (CURRENT === "all" ? 1 : 0) + (power ? 1 : 0) + (polyline ? 1 : 0);
  const body = sections
    ? sections.filter(([, list]) => list.length).map(([title, list]) =>
      `${title ? `<tr class="seg-group"><td colspan="${cols}">${title}</td></tr>` : ""}${list.map((e) => effortRow(e, group, opts)).join("")}`).join("")
    : rows.map((e) => effortRow(e, group, opts)).join("");
  // Fixed column widths: several tables one under another line up.
  const colgroup = `<colgroup><col class="c-rank"><col class="c-date">${CURRENT === "all" ? `<col class="c-person">` : ""}<col class="c-num"><col class="c-num"><col class="c-num"><col class="c-num"><col class="c-num">${power ? `<col class="c-num">` : ""}<col class="c-act">${polyline ? `<col class="c-wx">` : ""}</colgroup>`;
  return `<div class="scroll"><table class="data seg-table${polyline ? " with-wx" : ""}${CURRENT === "all" ? " with-person" : ""}"${polyline ? ` data-polyline="${esc(polyline)}"` : ""}>${colgroup}<thead><tr><th>#</th>${head("date", "Date", "date", false)}
      ${CURRENT === "all" ? head("", "Person", null, false) : ""}${head("elapsed_time", "Time", "time")}
      ${head(onFoot ? "avg_pace" : "avg_speed", onFoot ? "Avg pace" : "Avg speed")}${head(onFoot ? "best_pace" : "max_speed", onFoot ? "Best pace" : "Max speed")}${head("avg_heart_rate", "Avg HR")}${head("max_heart_rate", "Max HR")}
      ${power ? head("avg_power", "Avg power") : ""}${head("name", "Activity", null, false).replace("<th class=\"\">", "<th class=\"c-act\">")}${polyline ? head("weather", "Weather", null, false).replace("<th class=\"\">", "<th class=\"c-wx\">") : ""}</tr></thead>
      <tbody data-rows>${body}</tbody></table></div>`;
}
let SEG_HAS_POWER = false; // the Avg power column only when some effort of the segment has power
function effortRow(e, group, { power = SEG_HAS_POWER, thisId = null, wx = false, polyline = null } = {}) {
  const mine = thisId != null && e.id === thisId;
  const w = wx ? parseWx(e) : null;
  const wxCell = !wx ? "" : w === undefined && !isIndoor(e.activity_type) ? `<td class="c-wx" data-wx-pending="${e.activity_id}" data-rev="${e.reverse ? 1 : 0}" data-type="${esc(e.activity_type || "")}"><span class="hint">…</span></td>`
    : `<td class="c-wx">${weatherCell(w, polyline, e.reverse, e.activity_type)}</td>`;
  return `<tr class="${mine ? "this" : ""}"><td>${e.rank ?? ""}</td><td>${localTime(e)}${e.reverse ? ` <span class="hint other-way" title="Ridden in the opposite direction">⇄</span>` : ""}</td>
    ${CURRENT === "all" ? `<td>${avatar(person(e.person_id), 18)} ${esc(personLabel(e.person_id))}</td>` : ""}
    <td class="num"><b>${mmss(e.elapsed_s)}</b></td><td class="num">${segSpeed(e.avg_speed, group)}</td><td class="num">${segSpeed(e.max_speed, group)}</td>
    <td class="num">${bpm(e.avg_hr)}</td><td class="num">${bpm(e.max_hr)}</td>${power ? `<td class="num">${watts(e.avg_power)}</td>` : ""}
    <td class="c-act">${mine ? `<span class="this-tag">This activity</span>` : `<a href="#/activity/${e.activity_id}">${typeName(e.activity_type, e.activity_name || typeLabel(e.activity_type))}</a>`}</td>${wxCell}</tr>`;
}

// Last / best effort: a card titled like the activity tiles, its values as small tiles.
function effortCard(title, icon, e, group) {
  const head = `<h3 class="tile-title">${icon}<span>${title}</span></h3>`;
  if (!e) return `<div class="card seg-eff">${head}${hint("–")}</div>`;
  const onFoot = ON_FOOT.has(group);
  const tile = (ic, label, value) => (value == null || value === "–" ? ""
    : `<div class="seg-eff-tile"><span class="tile-title">${metricIcon(ic, 18)}<span>${label}</span></span><b>${value}</b></div>`);
  return `<div class="card seg-eff">${head}
    <div class="hint seg-eff-sub">${localTime(e)}${personBit(e)} · <a href="#/activity/${e.activity_id}">${esc(e.activity_name || typeLabel(e.activity_type))}</a>${e.rank ? ` · rank ${e.rank}` : ""}</div>
    <div class="seg-eff-tiles">${tile("elapsed_time", "Time", mmss(e.elapsed_s))}${tile("moving_time", "Moving time", mmss(e.moving_s))}
      ${tile(onFoot ? "avg_pace" : "avg_speed", onFoot ? "Avg pace" : "Avg speed", segSpeed(e.avg_speed, group))}
      ${tile(onFoot ? "best_pace" : "max_speed", onFoot ? "Best pace" : "Max speed", e.max_speed ? segSpeed(e.max_speed, group) : null)}
      ${tile("avg_heart_rate", "Avg HR", e.avg_hr != null ? bpm(e.avg_hr) : null)}${tile("max_heart_rate", "Max HR", e.max_hr != null ? bpm(e.max_hr) : null)}
      ${tile("avg_power", "Avg power", e.avg_power != null ? watts(e.avg_power) : null)}${tile("avg_cadence", "Cadence", e.avg_cadence != null ? cadence(e.avg_cadence, group) : null)}</div></div>`;
}

async function renderSegment(id, params) {
  const pq = new URLSearchParams({ ...personParam(), ...filterQuery(params) });
  const d = await api(`segments/${id}?${pq}`);
  const s = d.segment, g = s.category, sum = d.summary;
  SEG_HAS_POWER = (d.top || []).some((e) => e.avg_power != null);
  const effortSort = params.sort === "date" ? "date" : "time";
  const allQ = { ...personParam(), ...filterQuery(params), sort: effortSort, limit: 50 };
  const first = await api(`segments/${id}/efforts?${new URLSearchParams(allQ)}`);
  const grade = s.ascent_m != null && s.distance_m ? `${num((s.ascent_m / s.distance_m) * 100, 1)} % avg climb` : "";
  const showSummary = UI.data["segment-summary"] ?? true; // remembered per person, on by default
  // Edit: name, which activities count, delete.
  const srcGroup = d.source?.category || typeOf(d.source?.activity_type)?.group || g;
  const groupTypes = srcGroup ? TYPES.types.filter((t) => t.group === srcGroup).slice(0, 4).map((t) => t.en.toLowerCase()) : [];
  const optLabel = (label, tip) => `${label}<small class="opt-hint">${tip}</small>`;
  const editPanel = `<div class="opt-panel">
      ${row("Name", `<input name="seg-name" value="${esc(s.name)}" maxlength="120">`)}
      ${srcGroup ? row(optLabel("Counts", `${esc(groupLabel(srcGroup))} only: all its types (${esc(groupTypes.slice(0, 3).join(", "))}…)`),
        pickList("seg-types", [["group", `${groupLabel(srcGroup)} only`], ["any", "Any activity type"]], g ? "group" : "any")) : ""}
      ${row("", `<button class="badge danger" data-del>Delete segment</button>`)}</div>`;
  const src = d.source ? `${localTime(d.source).slice(0, 10)}${d.source.location ? ` · ${esc(d.source.location)}` : ""}` : "";
  const fq = new URLSearchParams(filterQuery(params)).toString();
  view.innerHTML = `
    ${backLink(`#/segments${fq ? "?" + fq : ""}`, "Segments")}
    <div class="page-head"><h2 class="tb-activity-name">${g ? groupIcon(g, 24) : typeIcon("other", 24)}<span>${esc(s.name)}</span>${src ? `<a class="head-date" href="#/activity/${d.source.id}" title="Created from this activity">${src}</a>` : ""}</h2>
      <div class="badges">${timeBadge(params)}${typeBadge(params, d.type_counts || {})}
        ${badgeHtml("edit", "Edit", "", { panel: editPanel })}
        <button class="badge ${showSummary ? "on" : ""}" data-summary-toggle>Summary</button>
        ${s.pending ? state("matching…", "warn") : ""}</div><span class="spacer"></span></div>
    <div class="card route-card"><div class="card-head"><h3 class="tile-title">${metricIcon("route", 18)}<span>Route</span></h3></div>
      <div id="seg-map" class="map"></div></div>
    <div data-summary ${showSummary ? "" : "hidden"}>${statStrip([
      ["Distance", km(s.distance_m), ""],
      ["Elevation gain", meters(s.ascent_m), grade],
      ["Direction", s.two_way ? "Both ways" : "One way", s.net_climb_m != null ? `end ${s.net_climb_m >= 0 ? "+" : "−"}${num(Math.abs(s.net_climb_m))} m vs start` : ""],
      ["Efforts", num(sum.count), CURRENT === "all" && d.people.length ? `${num(d.people.length)} ${d.people.length === 1 ? "person" : "people"}` : ""],
      ["Best", mmss(sum.best_s), d.best ? effortDay(d.best) : ""],
      ["Average", mmss(sum.avg_s), sum.median_s != null ? `median ${mmss(sum.median_s)}` : ""],
      ["Last", d.last ? mmss(d.last.elapsed_s) : "–", d.last ? effortDay(d.last) : ""],
    ])}</div>
    ${sum.count ? `
    <div class="seg-eff-row">${effortCard("Last effort", metricIcon("date", 18), d.last, g)}${effortCard("Best effort", LAUREL_SVG, d.best, g)}</div>
    <div class="charts" data-trend></div>
    ${CURRENT === "all" && d.people.length ? `<div class="card"><h3>People</h3><div class="scroll"><table class="data"><thead><tr>${thIcon("", "Person", false)}
      ${thIcon("elapsed_time", "Best")}${thIcon("elapsed_time", "Average")}<th class="num">Efforts</th>${thIcon("date", "Last", false)}</tr></thead><tbody>
      ${d.people.map((p) => `<tr><td>${avatar(person(p.person_id), 18)} ${esc(personLabel(p.person_id))}</td><td class="num"><b>${mmss(p.best_s)}</b></td>
        <td class="num">${mmss(p.avg_s)}</td><td class="num">${num(p.count)}</td><td>${mmss(p.last.elapsed_s)} <span class="hint">${effortDay(p.last)}</span></td></tr>`).join("")}
      </tbody></table></div></div>` : ""}
    <div class="card" data-top10><h3>Top 10</h3>${effortTable(d.top, g, { polyline: s.polyline })}</div>
    <div class="card" data-all><div class="card-row"><h3 style="margin:0">All efforts</h3><span class="hint" data-count>${countText(first.items.length, first.total)}</span></div>
      ${effortTable(first.items, g, { sort: effortSort, polyline: s.polyline })}
      ${first.items.length < first.total ? `<div class="sentinel" data-sentinel>${loaderHtml()}</div>` : ""}</div>`
    : `<div class="card">${hint(s.pending ? "Looking for efforts in all activities…" : CURRENT === "all" ? "No activity covers this segment in this period." : `${esc(personLabel(CURRENT))} has no effort on this segment in this period.`)}</div>`}`;

  const headEl = view.querySelector(".page-head");
  bindBadges(headEl);
  bindFilterBadges(headEl, `#/segment/${id}`, params);
  segmentTrend(view.querySelector("[data-trend]"), d.series || []);
  fitEffortCols(view);
  fillWeather(view); // Top 10 first, then All efforts (one lookup per activity, cached)
  view.querySelectorAll("[data-esort]").forEach((a) => a.onclick = (e) => {
    e.preventDefault();
    location.hash = `#/segment/${id}?${new URLSearchParams({ ...filterQuery(params), ...(a.dataset.esort === "date" ? { sort: "date" } : {}) })}`;
  });
  const all = view.querySelector("[data-all]");
  if (all) infinite(all, first.items.length, first.total,
    async (offset) => (await api(`segments/${id}/efforts?${new URLSearchParams({ ...allQ, offset })}`)).items,
    (items) => { all.querySelector("[data-rows]").insertAdjacentHTML("beforeend", items.map((e) => effortRow(e, g, { wx: true, polyline: s.polyline })).join("")); fitEffortCols(view); fillWeather(all); });
  view.querySelector("[data-summary-toggle]").onclick = (e) => {
    const on = !e.currentTarget.classList.contains("on");
    e.currentTarget.classList.toggle("on", on);
    view.querySelector("[data-summary]").hidden = !on;
    saveUi("segment-summary", on);
  };
  const panel = view.querySelector('[data-panel="edit"]');
  const nameIn = panel.querySelector("[name=seg-name]");
  nameIn.onkeydown = (e) => { if (e.key === "Enter") nameIn.blur(); };
  nameIn.onchange = async () => {
    const name = nameIn.value.trim();
    if (!name || name === s.name) { nameIn.value = s.name; return; }
    await api(`segments/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }).catch((err) => alert(err.message));
    renderSegment(id, params);
  };
  panel.querySelectorAll('[data-pick="seg-types"]').forEach((b) => b.onclick = async () => {
    if (b.classList.contains("on")) return;
    await api(`segments/${id}`, { method: "PATCH", body: JSON.stringify({ any_type: b.dataset.value === "any" }) }).catch((err) => alert(err.message));
    renderSegment(id, params);
  });
  panel.querySelector("[data-del]").onclick = async () => {
    if (!confirm(`Delete the segment “${s.name}” and all its efforts?\n\nActivities are not touched.`)) return;
    await api(`segments/${id}`, { method: "DELETE" });
    location.hash = "#/segments";
  };
  const mapEl = document.getElementById("seg-map"); // grip on the card's bottom edge: map height
  cardResize(mapEl.closest(".card"), () => mapEl.offsetHeight, (h) => { mapEl.style.height = `${h}px`; activeMap?.resize(); }, 220, 1000);
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
      ${data.items.length < data.total ? `<div class="sentinel" data-sentinel>${loaderHtml()}</div>` : ""}</div>`;
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
