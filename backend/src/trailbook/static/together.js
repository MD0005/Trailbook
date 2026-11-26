// Compare two people (SPEC §10a): Activities together (tiles and list of what both did
// together) and the page of one of them - a column per person, one route for both, charts coupled on the
// clock. Uses helpers from preview.js, charts.js and segments.js.
"use strict";

// What counts as together (Activities › Options), remembered on the server for all pairs
// (`ui_settings` key `together-match`); the same defaults as together.py.
const TOGETHER_DEFAULTS = { share: 10, radius: 50 };
const TOGETHER_SHARES = [5, 10, 20, 30, 50, 75];
const TOGETHER_RADII = [20, 30, 50, 75, 100];
const togetherMatch = () => ({ ...TOGETHER_DEFAULTS, ...(UI.data["together-match"] || {}) });
const pairColor = (id) => personColor(person(id), Math.max(0, realPeople().findIndex((p) => p.id === id)));
const personTag = (id, size = 18) => `${avatar(person(id), size)} ${esc(personLabel(id))}`;
const sharedName = (a, b) => a.name || b.name || typeLabel(a.activity_type);

// ---- Activities together ---------------------------------------------------------------

// Screen points moved `off` px to the right of the direction of travel, so two lines on the
// same road (and the way there and back) lie side by side instead of on top of each other.
function offsetRight(points, off) {
  const thin = points.filter((p, i) => !i || i === points.length - 1 || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 0.5)
    .reduce((out, p) => {
      const last = out[out.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= 2.5) out.push(p);
      return out;
    }, []);
  if (thin.length < 2) return points;
  if (!off) return thin;
  let normal = [0, 0];
  return thin.map((p, i) => {
    const a = thin[Math.max(0, i - 1)], b = thin[Math.min(thin.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy);
    if (d > 0.5) normal = [-dy / d, dx / d]; // a turn back on itself keeps the last side
    return [p[0] + normal[0] * off, p[1] + normal[1] * off];
  });
}

// The two routes of a shared activity on one static map, in the people's colours, the second
// beside the first, each with the start (green) and end (red) dots of an activity map.
const PAIR_START = "#3ecf8e", PAIR_END = "#ff6b6b";
function staticPairMap(lines, colors, { W = 400, H = 160 } = {}) {
  const tracks = lines.map(decodePolyline);
  if (tracks.some((t) => t.length < 2)) return "";
  const base = staticBase(tracks.flat(), { W, H, tiles: "faded-tiles" });
  const px = tracks.map((t, k) => offsetRight(t.map(base.at), k ? 3.6 : 0));
  const d = (p) => p.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const halo = px.map((p) => `<path d="${d(p)}" fill="none" style="stroke:var(--map-halo)" stroke-width="6" stroke-linejoin="round" stroke-linecap="round" opacity=".8"/>`).join("");
  const routes = px.map((p, k) => `<path d="${d(p)}" fill="none" stroke="${colors[k]}" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"/>`).join("");
  const dot = ([x, y], color) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${color}" style="stroke:var(--map-halo)" stroke-width="2"/>`;
  const dots = px.map((p) => dot(p[0], PAIR_START) + dot(p[p.length - 1], PAIR_END)).join("");
  return `<svg class="tile-track" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${base.svg}${halo}${routes}${dots}</svg>`;
}

const onFoot = (x) => ["run", "walk", "hike"].includes(x.category);
// pace on foot, else speed
const ownSpeed = (x) => (!x.distance_m || !x.avg_speed ? "–" : onFoot(x) ? pace(x.avg_speed) : kmh(x.avg_speed));
const sharedLink = (it) => `#/together/${it.a.id}/${it.b.id}`;

// List: one row a shared activity; each person's own values one under the other.
function togetherColumns() {
  const lines = (values) => `<div class="pair-cell">${values.map((v) => `<span>${v}</span>`).join("")}</div>`;
  const own = (f) => (it) => lines([f(it.a), f(it.b)]);
  // one line when both have the same
  const once = (f) => (it) => (f(it.a) === f(it.b) ? f(it.a) : lines([f(it.a), f(it.b)]));
  return [
    { key: "date", label: "Date", icon: "date", sort: true, render: (it) => `<a class="plain-link" href="${sharedLink(it)}">${localTime(it.a)}</a>` },
    { key: "type", label: "Type", icon: "type", sort: true, render: once((x) => typeName(x.activity_type)) },
    { key: "workout", label: "Training type", icon: "interval_time", sort: true,
      render: once((x) => (workoutOf(x) ? esc(workoutLabel(workoutOf(x))) : `<span class="hint">–</span>`)) },
    { key: "name", label: "Name", icon: "name", sort: true, render: (it) => `<a href="${sharedLink(it)}">${esc(sharedName(it.a, it.b))}</a>` },
    { key: "distance", label: "Together", icon: "distance_total", sort: true, num: true, render: (it) => km(it.together_m) },
    { key: "time", label: "Time together", icon: "timer_time", sort: true, num: true, render: (it) => durMin(it.together_s) },
    { key: "share", label: "Share", sort: true, num: true, render: (it) => `${num(it.share * 100)} %` },
    { key: "who", label: "", render: own((x) => `<span title="${esc(personLabel(x.person_id))}">${avatar(person(x.person_id), 18)}</span>`) },
    { key: "own-distance", label: "Distance", num: true, render: own((x) => km(x.distance_m)) },
    { key: "own-time", label: "Time", num: true, render: own((x) => dur(x.time_s)) },
    { key: "pace", label: "Pace", icon: "avg_pace", num: true, render: own(ownSpeed) },
    { key: "hr", label: "Avg HR", icon: "avg_heart_rate", num: true, render: own((x) => bpm(x.avg_hr)) },
    { key: "ascent", label: "Ascent", icon: "total_ascent", num: true, render: own((x) => meters(x.ascent_m)) },
  ];
}

function togetherTile(it) {
  const { a, b } = it, ids = [a.person_id, b.person_id];
  const speedLabel = onFoot(a) && onFoot(b) ? "Pace" : !onFoot(a) && !onFoot(b) ? "Speed" : "Pace / speed";
  const cols = [["Distance", (x) => km(x.distance_m)], ["Time", (x) => dur(x.time_s)], [speedLabel, ownSpeed],
    ["Avg HR", (x) => bpm(x.avg_hr)], ...(a.ascent_m || b.ascent_m ? [["Ascent", (x) => meters(x.ascent_m)]] : [])];
  const kind = workoutOf(a) || workoutOf(b);
  return `<a class="tile large pair" href="${sharedLink(it)}">
    <div class="tile-map">${it.lines ? staticPairMap(it.lines, ids.map(pairColor)) : ""}</div>
    <div class="tile-head"><span class="tile-icon">${typeIcon(a.activity_type)}</span>
      <span class="tile-title"><b>${esc(sharedName(a, b))}</b><span class="hint">${localTime(a)}${kind ? ` · ${esc(workoutLabel(kind))}` : ""}</span></span>
      <span class="tile-dist" data-tip="Together: ${km(it.together_m)}, ${num(it.share * 100)} % of the shorter route, ${durMin(it.together_s)}"><b>${km(it.together_m)}</b><small>${num(it.share * 100)} % together</small></span></div>
    <table class="pair-stats"><thead><tr><th></th>${cols.map(([l]) => `<th>${l}</th>`).join("")}</tr></thead>
      <tbody>${[a, b].map((x) => `<tr><td title="${esc(personLabel(x.person_id))}">${avatar(person(x.person_id), 18)}</td>${cols.map(([, f]) => `<td>${f(x)}</td>`).join("")}</tr>`).join("")}</tbody></table>
  </a>`;
}

function togetherSummary(t, ids) {
  const weeks = t.first && t.last ? Math.max(1, (Date.parse(t.last) - Date.parse(t.first)) / (7 * 864e5)) : 1;
  return statStrip([
    ["Together", num(t.count), `${num(t.active_days)} active days`],
    ["Distance together", km(t.together_m), t.count ? `${km(t.together_m / t.count)} avg` : ""],
    ["Time together", hours(t.together_s), t.count ? `${hours(t.together_s / weeks)} per week` : ""],
    ["Longest together", km(t.longest_m), t.longest_day || ""],
    ["Shared route", t.share == null ? "–" : `${num(t.share * 100)} %`, "average of the shorter route"],
    // each person's whole activities (together and apart)
    ...ids.map((id, k) => {
      const p = t.people[k];
      return [personTag(id, 16), km(p.distance_m), [hours(p.time_s), p.ascent_m ? `+${meters(p.ascent_m)}` : "", p.avg_hr ? bpm(p.avg_hr) : ""].filter(Boolean).join(" · ")];
    }),
  ]);
}

function togetherOptions(match) {
  const label = (name, text) => `${name}<small class="opt-hint">${text}</small>`;
  const withCurrent = (list, v) => [...new Set([...list, v])].sort((p, q) => p - q);
  return `<div class="opt-panel">
    ${row(label("Shared route", "Least part of the shorter route done together"), pickList("together-share", withCurrent(TOGETHER_SHARES, match.share).map((v) => [v, `${num(v)} %`]), match.share))}
    ${row(label("Accuracy", "How far apart still counts as together"), pickList("together-radius", withCurrent(TOGETHER_RADII, match.radius).map((v) => [v, `${num(v)} m`]), match.radius))}
  </div>`;
}

async function renderTogetherActivities(params) {
  const ids = [...PAIR];
  const mode = TAB.view === "list" ? "list" : "large";
  params = { sort: "date", dir: "desc", ...params };
  const fetchPage = (offset) => api("together?" + new URLSearchParams({ person: ids.join(","), limit: PAGE_SIZE, offset,
    sort: params.sort, dir: params.dir, ...(mode === "large" ? { track: 1 } : {}), ...togetherMatch(), ...filterQuery(params) }));
  const [data] = await Promise.all([fetchPage(0), (async () => { BASEMAPS ??= await api("basemaps"); })()]);
  TYPE_COUNTS = data.type_counts; // the Type filter lists the types of the shared activities
  const showSummary = TAB.kpis ?? false;
  view.innerHTML = `
    ${pageHead("Activities together", `
      ${timeBadge(params)}${typeBadge(params)}${workoutBadge(params, data.workout_counts)}
      ${badgeHtml("together-options", "Options", "", { panel: togetherOptions(togetherMatch()) })}
      <button class="badge ${showSummary ? "on" : ""}" data-kpis>Summary</button>`,
      switchHtml("view", PAIR_VIEWS.map(([k, label, icon]) => [k, `${icon}<span>${label}</span>`]), mode))}
    <div data-summary ${showSummary ? "" : "hidden"}></div>
    <div class="card" data-list></div>`;
  const list = view.querySelector("[data-list]"), summary = view.querySelector("[data-summary]");
  const columns = togetherColumns();
  const fill = (d) => {
    stopObservers();
    summary.innerHTML = togetherSummary(d.totals, ids);
    if (!d.items.length) {
      list.innerHTML = hint(`No activities done together${Object.keys(filterQuery(params)).length ? " match the filters" : " found. Options sets how much of the route and how close counts"}.`);
      return;
    }
    list.innerHTML = mode === "list" ? tableHtml(columns, d.items, params, d.total)
      : `<div class="tiles large" data-rows>${d.items.map(togetherTile).join("")}</div>
        ${d.items.length < d.total ? `<div class="sentinel" data-sentinel>${loaderHtml()}</div>` : ""}`;
    if (mode === "list") bindTable("#/activities", params);
    infinite(view, d.items.length, d.total, async (offset) => (await fetchPage(offset)).items, (items) => {
      list.querySelector("[data-rows]").insertAdjacentHTML("beforeend", items.map((it) => (mode === "list" ? rowHtml(columns, it) : togetherTile(it))).join(""));
    });
  };
  fill(data);
  bindBadges(view.querySelector(".page-head"));
  bindFilterBadges(view.querySelector(".page-head"), "#/activities", params, { drop: ["date"] });
  // a changed option loads the list again under the open panel
  let asked = 0;
  ["share", "radius"].forEach((key) => view.querySelectorAll(`[data-pick="together-${key}"]`).forEach((b) => b.onclick = async () => {
    view.querySelectorAll(`[data-pick="together-${key}"]`).forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); });
    saveUi("together-match", { ...togetherMatch(), [key]: Number(b.dataset.value) });
    const mine = ++asked;
    stopObservers();
    list.innerHTML = loaderHtml();
    const d = await fetchPage(0).catch((e) => { list.innerHTML = state("Error: " + esc(e.message), "bad"); return null; });
    if (d && mine === asked && list.isConnected) { TYPE_COUNTS = d.type_counts; fill(d); }
  }));
  view.querySelector("[data-kpis]").onclick = (e) => {
    const on = !e.currentTarget.classList.contains("on");
    TAB.kpis = on;
    e.currentTarget.classList.toggle("on", on);
    summary.hidden = !on;
    if (on) window.scrollTo({ top: 0, behavior: "smooth" });
  };
  view.querySelectorAll("[data-switch=view]").forEach((b) => b.onclick = () => { TAB.view = b.dataset.value; renderTogetherActivities(params); });
}

// ---- one shared activity ---------------------------------------------------------------

// The one route of the page: both lines in the people's colours (the second beside the first),
// the start and end dots of each, the moment under the pointer and highlighted stretches.
async function pairMap(el, lines, colors, columns) {
  const coords = lines.map(lonLat), side = [0, 5];
  const map = await createMap(el, loadMapSettings().map, { bounds: boundsOf(coords), reset: true });
  const layout = { "line-join": "round", "line-cap": "round" };
  const empty = { type: "FeatureCollection", features: [] };
  coords.forEach((c, k) => map.addSource(`pair-line-${k}`, { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: c } } }));
  coords.forEach((c, k) => map.addLayer({ id: `pair-casing-${k}`, type: "line", source: `pair-line-${k}`, layout, paint: { "line-color": mapHalo(), "line-width": 6.5, "line-offset": side[k] } }));
  coords.forEach((c, k) => map.addLayer({ id: `pair-line-${k}`, type: "line", source: `pair-line-${k}`, layout, paint: { "line-color": colors[k], "line-width": 3.5, "line-offset": side[k] } }));
  coords.forEach((c, k) => {
    map.addSource(`pair-hl-${k}`, { type: "geojson", data: empty });
    map.addLayer({ id: `pair-hl-${k}`, type: "line", source: `pair-hl-${k}`, layout, paint: { "line-color": colors[k], "line-width": 7.5, "line-offset": side[k] } });
  });
  const ends = coords.flatMap((c) => [[PAIR_START, c[0]], [PAIR_END, c[c.length - 1]]])
    .map(([color, at]) => ({ type: "Feature", properties: { c: color }, geometry: { type: "Point", coordinates: at } }));
  map.addSource("pair-ends", { type: "geojson", data: { type: "FeatureCollection", features: ends } });
  map.addLayer({ id: "pair-ends", type: "circle", source: "pair-ends", paint: { "circle-radius": 5, "circle-color": ["get", "c"], "circle-stroke-width": 2, "circle-stroke-color": mapHalo() } });
  coords.forEach((c, k) => {
    map.addSource(`pair-pt-${k}`, { type: "geojson", data: empty });
    map.addLayer({ id: `pair-pt-${k}`, type: "circle", source: `pair-pt-${k}`, paint: { "circle-radius": 6.5, "circle-color": colors[k], "circle-stroke-width": 2.5, "circle-stroke-color": mapHalo() } });
  });
  const at = (k, i) => {
    const st = columns[k]?.st;
    return st?.lat?.[i] != null && st.lon?.[i] != null ? [st.lon[i], st.lat[i]] : null;
  };
  const api = {
    marker(k, i) {
      const p = i == null ? null : at(k, i);
      map.getSource(`pair-pt-${k}`)?.setData(p ? { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: p } } : empty);
    },
    highlight(k, ranges) {
      const parts = (ranges || []).map(([i0, i1]) => {
        const out = [];
        for (let i = i0; i <= i1; i++) { const p = at(k, i); if (p) out.push(p); }
        return out;
      }).filter((p) => p.length > 1);
      map.getSource(`pair-hl-${k}`)?.setData(parts.length ? { type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: parts } } : empty);
    },
  };
  // hovering a route moves both people's charts to that moment
  const moveTo = (x) => columns.forEach((c, k) => {
    c?.charts()?.hoverX(x);
    if (x == null) api.marker(k, null);
  });
  map.on("mousemove", (e) => {
    let best = null, bd = 400; // within 20 px
    columns.forEach((c, k) => {
      for (let i = 0; c && i < (c.st.lat?.length || 0); i += 1) {
        const p = at(k, i);
        if (!p) continue;
        const q = map.project(p), d = (q.x - e.point.x) ** 2 + (q.y - e.point.y) ** 2;
        if (d < bd) { bd = d; best = c.chartX.together[i]; }
      }
    });
    moveTo(best);
  });
  map.getCanvas().addEventListener("mouseleave", () => moveTo(null));
  return api;
}

async function renderTogether(aId, bId) {
  const ids = [Number(aId), Number(bId)];
  let shared;
  try {
    shared = await api(`together/${ids[0]}/${ids[1]}?` + new URLSearchParams({ ...togetherMatch(), ...filterQuery(TAB.filter || {}) }));
  } catch (e) {
    view.innerHTML = `${backLink("#/activities", "Activities")}<div class="card">${state(esc(e.message), "bad")}</div>`;
    return;
  }
  // opened by its address with someone else chosen: choose these two
  if (!PAIR || !shared.people.every((p) => PAIR.includes(p))) {
    const key = pairKey(shared.people);
    selectPeople(key);
    if (PAIR) { store.set("person", key); await route(); return; }
  }
  const [a, b] = await Promise.all(ids.map((id) => api(`activities/${id}`)));
  const colors = shared.people.map(pairColor);
  view.innerHTML = `
    ${backLink("#/activities", "Activities")}
    <div class="page-head"><h2 class="tb-activity-name">${typeIcon(a.activity_type, 24)}<span>${esc(sharedName(a, b))}</span><span class="head-date">${localTime(a)} · ${km(shared.together_m)} together · ${durMin(shared.together_s)} · ${num(shared.share * 100)} %</span></h2>
      <div class="badges" data-pair-badges></div><span class="spacer"></span>
      ${prevNextHtml(shared.prev && `#/together/${shared.prev.a}/${shared.prev.b}`, shared.next && `#/together/${shared.next.a}/${shared.next.b}`)}</div>
    <div class="pair-grid">
      <div class="pair-col"></div><div class="pair-col"></div>
      <div class="card route-card pair-route"><div class="card-head"><h3 class="tile-title">${metricIcon("route", 18)}<span>Route</span></h3><span class="spacer"></span>
          <span class="pair-people">${shared.people.map((id) => `<span title="${esc(personLabel(id))}">${avatar(person(id), 26)}</span>`).join("")}</span></div>
        <div class="route-wrap"><div id="route-map" class="map"></div><div class="route-overlays"><div class="route-weather" data-pair-weather hidden></div></div></div></div>
    </div>`;
  view.querySelectorAll(".page-head [data-go]").forEach((el) => el.addEventListener("click", () => { location.hash = el.dataset.go; }));
  const roots = [...view.querySelectorAll(".pair-col")];
  const columns = [null, null];
  let map = null;
  const other = (side) => columns[1 - side]?.charts();
  const columns_ = await Promise.all([0, 1].map((side) => renderActivity(ids[side], {
    root: roots[side],
    offset: shared.offsets[side],
    // the charts: the same clock on both sides; what is done on one is done on the other
    pair: { range: shared.span, runs: shared.runs[side], cursor: (x) => other(side)?.hoverX(x),
      zoom: (r) => other(side)?.zoom(r), pin: (x, on) => other(side)?.pin(x, on), reset: () => other(side)?.reset() },
    // the page's one map, and the same stretch of time on the other charts
    route: {
      hover: (i) => map?.marker(side, i),
      highlight: (ranges) => {
        map?.highlight(side, ranges);
        const x = columns[side]?.chartX?.together;
        other(side)?.highlightX(ranges && x ? ranges.map(([i0, i1]) => [x[i0], x[i1]]) : null);
      },
    },
    onOrder: () => columns[1 - side]?.refreshCharts(),
  })));
  if (!roots[0].isConnected) return; // another page was opened meanwhile
  columns_.forEach((c, k) => { columns[k] = c; });
  // charts both have come first, so the two columns line up
  const both = new Set(columns[0].series().map((s) => s.key).filter((k) => columns[1].series().some((s) => s.key === k)));
  columns.forEach((c) => c.mount(both));
  bindPairBadges(columns);
  pairMap("route-map", shared.lines, colors, columns).then((m) => { map = m; }).catch((e) => {
    const el = document.getElementById("route-map");
    if (el) el.outerHTML = state("Map unavailable: " + esc(e.message), "bad");
  });
  const mapEl = document.getElementById("route-map");
  cardResize(mapEl.closest(".card"), () => mapEl.offsetHeight, (h) => { mapEl.style.height = `${h}px`; activeMap?.resize(); }, 220, 1000);
  const outdoors = [a, b].find((x) => x.has_gps && !x.indoor);
  if (outdoors) {
    api(`activities/${outdoors.id}/weather`).then((w) => {
      const box = view.querySelector("[data-pair-weather]");
      if (box && w && w.temp != null) { box.innerHTML = weatherHtml(w); box.hidden = false; }
    }).catch(() => {});
  }
}

// Page header of a shared activity: Charts and Options act on both columns.
function bindPairBadges(columns) {
  const box = view.querySelector("[data-pair-badges]");
  const all = new Map();
  columns.forEach((c) => c.series().forEach((s) => all.set(s.key, s)));
  const shown = () => [...all.keys()].filter((k) => columns.some((c) => c.series().some((s) => s.key === k) && c.isShown(k))).length;
  const opt = columns[0].options;
  const label = (name, text) => `${name}<small class="opt-hint">${text}</small>`;
  const power = columns.some((c) => c.options.hasPower);
  const charts = `<div class="opt-panel"><div class="checks checks-col">${[...all.values()].map((x) =>
    `<label class="check"><input type="checkbox" data-pair-chart="${x.key}" ${columns.some((c) => c.series().some((s) => s.key === x.key) && c.isShown(x.key)) ? "checked" : ""}> ${metricIcon(x.icon, 16)} ${esc(x.label)}</label>`).join("")}</div></div>`;
  const options = `<div class="opt-panel">${row(label("Smoothing", "Power and cadence lines: rolling average"), pickList("pair-power-avg", opt.powerAvgs, opt.powerAvg))}</div>`;
  box.innerHTML = `${all.size ? badgeHtml("charts", "Charts", `${shown()} of ${all.size}`, { panel: charts }) : ""}${power ? badgeHtml("chart-options", "Options", "", { panel: options }) : ""}`;
  bindBadges(view);
  box.querySelectorAll("[data-pair-chart]").forEach((el) => el.onchange = () => {
    saveUi("activity-charts", { ...(UI.data["activity-charts"] || {}), [el.dataset.pairChart]: el.checked });
    columns.forEach((c) => c.refreshCharts());
    box.querySelector('[data-badge-value="charts"]').textContent = `${shown()} of ${all.size}`;
  });
  box.querySelectorAll('[data-pick="pair-power-avg"]').forEach((b) => b.onclick = () => {
    box.querySelectorAll('[data-pick="pair-power-avg"]').forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); });
    saveUi("activity-power-avg", Number(b.dataset.value));
    columns.forEach((c) => c.setPowerAvg(Number(b.dataset.value)));
  });
}
