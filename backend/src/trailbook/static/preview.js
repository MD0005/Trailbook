// Technical preview UI. Plain JS, no build step, no external requests.
// All API URLs are relative so the page works behind Home Assistant Ingress.
//
// Style rules (see preview.css): every section is a .card; descriptions use .hint;
// states (next scan, saved, running, errors) use .state (+ .ok/.warn/.bad/.muted).
// Numbers are always shown with their unit.
"use strict";

const view = document.getElementById("view");
let TYPES = null;
let PERSONS = [];
let CURRENT = null; // selected person id or "all"
let timer = null;

const api = async (path, opts = {}) => {
  const res = await fetch("api/" + path, {
    headers: { "Content-Type": "application/json" }, ...opts,
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
};

const store = {
  get: (k) => { try { return localStorage.getItem("trailbook-" + k); } catch (e) { return null; } },
  set: (k, v) => { try { localStorage.setItem("trailbook-" + k, v); } catch (e) { /* ignore */ } },
};

// ---- icons --------------------------------------------------------------------------

const svg = (body, extra = "") => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</svg>`;
const ICON = {
  trash: svg(`<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>`),
  sun: svg(`<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`),
  moon: svg(`<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>`),
  gear: svg(`<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>`),
  list: svg(`<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>`),
  tilesSmall: svg(`<rect x="3" y="3" width="5" height="5" rx="1"/><rect x="10" y="3" width="5" height="5" rx="1"/><rect x="17" y="3" width="4" height="5" rx="1"/><rect x="3" y="10" width="5" height="5" rx="1"/><rect x="10" y="10" width="5" height="5" rx="1"/><rect x="17" y="10" width="4" height="5" rx="1"/><rect x="3" y="17" width="5" height="4" rx="1"/><rect x="10" y="17" width="5" height="4" rx="1"/><rect x="17" y="17" width="4" height="4" rx="1"/>`),
  tilesLarge: svg(`<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>`),
  grip: svg(`<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>`),
  chevron: svg(`<path d="M6 9l6 6 6-6"/>`),
};

const PERSON_ICONS = ["", "🏃", "🚴", "🏊", "🥾", "⛷️", "🧘", "🧗", "🐺", "🦊", "🐻", "🐼", "🦁", "🐸", "🐧", "🦄", "⭐", "🔥"];
const PERSON_COLORS = ["#4c8dff", "#ff6b6b", "#3ecf8e", "#f0b429", "#a678ff", "#38bdf8", "#ff8fab", "#f97316"];

// ---- formatting (numbers always with a unit) ----------------------------------------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (v, digits = 0) => Number(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).replace(/,/g, " ");
const unit = (v, u, digits = 0) => (v == null ? "–" : `${num(v, digits)} ${u}`);
const km = (m) => (m == null ? "–" : `${num(m / 1000, m >= 100000 ? 0 : 2)} km`);
const bpm = (v) => unit(v, "bpm");
const meters = (v) => unit(v, "m");
const watts = (v) => unit(v, "W");
const kcal = (v) => unit(v, "kcal");
const cadence = (v, group) => unit(v, ["run", "walk", "hike"].includes(group) ? "spm" : "rpm");
const dur = (s) => {
  if (s == null) return "–";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min ${String(sec).padStart(2, "0")} s`;
};
const hours = (s) => (s == null ? "–" : `${num(s / 3600, s < 36000 ? 1 : 0)} h`);
const pace = (mps) => {
  if (!mps) return "–";
  const s = 1000 / mps;
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")} /km`;
};
// Activity start in the activity's own local time.
const localTime = (a) => {
  if (!a.start_time_utc) return "";
  const t = new Date(Date.parse(a.start_time_utc) + (a.utc_offset_s || 0) * 1000);
  return t.toISOString().slice(0, 16).replace("T", " ");
};
// UTC timestamp -> "YYYY-MM-DD HH:MM" in the browser's time zone.
const browserTime = (iso) => {
  if (!iso) return "";
  const d = new Date(iso), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const typeOf = (key) => TYPES?.types.find((t) => t.key === key);
const typeLabel = (key) => typeOf(key)?.en ?? key;
const groupLabel = (key) => TYPES?.groups.find((g) => g.key === key)?.en ?? key;
const person = (id) => PERSONS.find((p) => p.id === id);
const personLabel = (id) => person(id)?.label ?? id;
const personColor = (p, i = 0) => p?.color || PERSON_COLORS[i % PERSON_COLORS.length];
const hint = (text) => `<div class="hint">${text}</div>`;
const state = (text, kind = "") => `<span class="state ${kind}">${text}</span>`;

function avatar(p, size = 26) {
  if (!p) return `<span class="avatar all" style="width:${size}px;height:${size}px">∗</span>`;
  const i = Math.max(0, realPeople().findIndex((x) => x.id === p.id));
  const known = person(p.id) || p;
  const inner = known.icon || esc((known.label || known.id).trim().slice(0, 1).toUpperCase());
  return `<span class="avatar" style="width:${size}px;height:${size}px;background:${personColor(known, i)}">${inner}</span>`;
}

// ---- header: navigation, person picker, theme, settings -----------------------------

const NAV = [
  { key: "activities", label: "Activities" },
  { key: "calendar", label: "Calendar" },
  { key: "heatmap", label: "Heatmap" },
  { key: "fitness", label: "Fitness", single: true },
  { key: "stats", label: "Statistics", single: true },
  { key: "compare", label: "Compare", all: true },
];

const realPeople = () => PERSONS.filter((p) => p.id !== "_unassigned");

function pickDefaultPerson() {
  const saved = store.get("person");
  if (saved === "all" || (saved && person(saved))) return saved;
  return realPeople()[0]?.id ?? "all";
}

function renderHeader(section) {
  const isAll = CURRENT === "all";
  document.getElementById("nav").innerHTML = NAV
    .filter((n) => !(n.single && isAll) && !(n.all && !isAll))
    .map((n) => `<a href="#/${n.key}" class="${section === n.key ? "active" : ""}">${n.label}</a>`).join("");
  const cur = isAll ? null : person(CURRENT);
  const options = realPeople().map((p) => `<button class="menu-item ${p.id === CURRENT ? "active" : ""}" data-person="${esc(p.id)}">${avatar(p, 22)} ${esc(p.label)}</button>`).join("");
  document.getElementById("tools").innerHTML = `
    <div class="picker">
      <button id="person-btn" class="picker-btn" title="Choose person">${avatar(cur)} <span>${esc(cur ? cur.label : "Everyone")}</span> ${ICON.chevron}</button>
      <div id="person-menu" class="menu" hidden>
        ${options}
        <button class="menu-item ${isAll ? "active" : ""}" data-person="all">${avatar(null, 22)} Everyone</button>
      </div>
    </div>
    <button id="theme" class="icon" aria-label="Switch theme"></button>
    <a href="#/settings" class="icon-link ${section === "settings" ? "active" : ""}" title="Settings" aria-label="Settings">${ICON.gear}</a>`;
  const menu = document.getElementById("person-menu");
  document.getElementById("person-btn").onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener("click", () => { menu.hidden = true; }, { once: true });
  menu.querySelectorAll("[data-person]").forEach((b) => b.onclick = () => {
    CURRENT = b.dataset.person;
    store.set("person", CURRENT);
    route();
  });
  setupTheme();
}

function setupTheme() {
  const btn = document.getElementById("theme");
  const paint = () => {
    const dark = document.documentElement.dataset.theme !== "light";
    btn.innerHTML = dark ? ICON.sun : ICON.moon;
    btn.title = dark ? "Switch to light theme" : "Switch to dark theme";
  };
  btn.onclick = () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    store.set("theme", next);
    paint();
  };
  paint();
}

// ---- generic table: sortable header + filter row ------------------------------------

function tableHtml(columns, rows, params, total, pageSize) {
  const sort = params.sort, dir = params.dir || "desc";
  const head = columns.map((c) => {
    if (!c.sort) return `<th class="${c.num ? "num" : ""}">${esc(c.label)}</th>`;
    const active = sort === c.key;
    const arrow = active ? (dir === "asc" ? "▲" : "▼") : "↕";
    return `<th class="${c.num ? "num" : ""}"><a href="#" class="sort ${active ? "active" : ""}" data-sort="${c.key}">${esc(c.label)} <span class="arrow">${arrow}</span></a></th>`;
  }).join("");
  const filters = columns.map((c) => (c.filter ? `<th>${filterControl(c, params)}</th>` : "<th></th>")).join("");
  const body = rows.length
    ? rows.map((r) => `<tr>${columns.map((c) =>
        `<td class="${c.num ? "num" : ""} ${c.wrap ? "wrap" : ""} ${c.cls || ""}">${c.render(r)}</td>`).join("")}</tr>`).join("")
    : `<tr><td colspan="${columns.length}" class="hint">Nothing matches the filters.</td></tr>`;
  return pagerHtml(columns, params, total, pageSize) + `
    <div class="scroll"><table class="data">
      <thead><tr>${head}</tr><tr class="filters-row">${filters}</tr></thead>
      <tbody>${body}</tbody></table></div>`;
}

function filterControl(c, params) {
  const f = c.filter, value = params[c.key] ?? "";
  if (f.type === "select") {
    const opt = ([v, l]) => `<option value="${esc(v)}" ${v === value ? "selected" : ""}>${esc(l)}</option>`;
    const opts = f.options.map((o) => (o.group
      ? `<optgroup label="${esc(o.group)}">${o.options.map(opt).join("")}</optgroup>` : opt(o))).join("");
    return `<select data-filter="${c.key}" title="${esc(c.label)}"><option value="">${esc(f.all || "All")}</option>${opts}</select>`;
  }
  return `<input data-filter="${c.key}" value="${esc(value)}" placeholder="${esc(f.placeholder || "filter…")}" title="${esc(c.label)}">`;
}

function pagerHtml(columns, params, total, pageSize) {
  const page = Number(params.page || 0), pages = Math.max(1, Math.ceil(total / pageSize));
  const filtered = columns.some((c) => c.filter && params[c.key]);
  return `<div class="tablebar">
      <span class="hint">${num(total)} row(s)</span>
      ${filtered ? `<button class="small" data-clear>Clear filters</button>` : ""}
      <span class="spacer"></span>
      <span class="pager">
        <button class="small" data-page="${page - 1}" ${page > 0 ? "" : "disabled"}>‹ Prev</button>
        <span class="hint">Page ${page + 1} / ${pages}</span>
        <button class="small" data-page="${page + 1}" ${page + 1 < pages ? "" : "disabled"}>Next ›</button>
      </span>
    </div>`;
}

function bindTable(route, params) {
  const go = (changes) => {
    const next = { ...params, ...changes };
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== "" && v != null));
    location.hash = route + "?" + new URLSearchParams(clean);
  };
  view.querySelectorAll("[data-sort]").forEach((a) => a.onclick = (e) => {
    e.preventDefault();
    const key = a.dataset.sort;
    const dir = params.sort === key && (params.dir || "desc") === "desc" ? "asc" : "desc";
    go({ sort: key, dir, page: 0 });
  });
  view.querySelectorAll("[data-filter]").forEach((el) => {
    const key = el.dataset.filter;
    const apply = () => go({ [key]: el.value.trim(), page: 0 });
    if (el.tagName === "SELECT") {
      el.onchange = apply;
    } else {
      el.onkeydown = (e) => { if (e.key === "Enter") apply(); };
      el.onblur = () => { if (el.value.trim() !== (params[key] ?? "")) apply(); };
    }
  });
  view.querySelectorAll("[data-page]").forEach((b) => b.onclick = () => go({ page: b.dataset.page }));
  view.querySelectorAll("[data-clear]").forEach((b) => b.onclick = () => {
    const keep = Object.fromEntries(Object.entries({ sort: params.sort, dir: params.dir }).filter(([, v]) => v));
    location.hash = route + "?" + new URLSearchParams(keep);
  });
}

const personOptions = () => realPeople().map((p) => [p.id, p.label]);
const typeOptions = () => TYPES.groups.map((g) => ({
  group: g.en,
  options: [[`g:${g.key}`, `All ${g.en.toLowerCase()}`],
    ...TYPES.types.filter((t) => t.group === g.key).map((t) => [t.key, t.en])],
}));

// ---- small charts -------------------------------------------------------------------

function decodePolyline(str) {
  const pts = []; let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += delta; else lon += delta;
    }
    pts.push([lat / 1e5, lon / 1e5]);
  }
  return pts;
}

function trackSvg(polyline, cls = "track") {
  const pts = decodePolyline(polyline);
  if (pts.length < 2) return "";
  const lat0 = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const xs = pts.map((p) => p[1] * k), ys = pts.map((p) => -p[0]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const w = Math.max(...xs) - minX || 1e-6, h = Math.max(...ys) - minY || 1e-6;
  const d = xs.map((x, i) => `${i ? "L" : "M"}${(x - minX).toFixed(6)},${(ys[i] - minY).toFixed(6)}`).join("");
  return `<svg class="${cls}" viewBox="${-w * 0.08} ${-h * 0.08} ${w * 1.16} ${h * 1.16}" preserveAspectRatio="xMidYMid meet">
    <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}

function lineChart(values, times, label, u, color) {
  const pts = values.map((v, i) => [times[i], v]).filter(([t, v]) => v != null && t != null);
  if (pts.length < 2) return "";
  const W = 1000, H = 140, P = 4;
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  let lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
  if (hi === lo) hi = lo + 1;
  const d = pts.map(([t, v], i) => `${i ? "L" : "M"}${(P + ((t - t0) / (t1 - t0 || 1)) * (W - 2 * P)).toFixed(1)},${(H - P - ((v - lo) / (hi - lo)) * (H - 2 * P)).toFixed(1)}`).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    <text x="8" y="16" fill="currentColor" font-size="12" opacity="0.7">${esc(label)}: ${num(lo)}–${num(hi)} ${u}</text></svg>`;
}

const kpi = (label, value) => `<div class="kpi"><span class="hint">${label}</span><b>${value}</b></div>`;

// ---- Activities ---------------------------------------------------------------------

const ACT_PAGE = 60;
const VIEWS = [["list", "List", ICON.list], ["small", "Small tiles", ICON.tilesSmall], ["large", "Large tiles", ICON.tilesLarge]];

async function renderActivities(params) {
  params = { sort: "date", dir: "desc", ...params };
  const mode = VIEWS.some(([k]) => k === store.get("view")) ? store.get("view") : "list";
  const isAll = CURRENT === "all";
  const q = { limit: ACT_PAGE, offset: Number(params.page || 0) * ACT_PAGE, sort: params.sort, dir: params.dir };
  for (const k of ["type", "date"]) if (params[k]) q[k] = params[k];
  if (params.name) q.q = params.name;
  if (!isAll) q.person = CURRENT;
  else if (params.person) q.person = params.person;
  if (mode === "large") q.track = "1";
  const data = await api("activities?" + new URLSearchParams(q));
  const t = data.totals;

  const columns = [
    { key: "date", label: "Date", sort: true, filter: { type: "text", placeholder: "2026-02" },
      render: (a) => `<a href="#/activity/${a.id}">${localTime(a)}</a>` },
    { key: "type", label: "Type", sort: true, filter: { type: "select", options: typeOptions(), all: "All types" },
      render: (a) => esc(typeLabel(a.activity_type)) + (a.indoor ? ` <span class="hint">indoor</span>` : "") },
    { key: "name", label: "Name", sort: true, filter: { type: "text", placeholder: "name…" }, render: (a) => esc(a.name) },
    { key: "distance", label: "Distance", sort: true, num: true, render: (a) => km(a.distance_m) },
    { key: "moving", label: "Moving time", sort: true, num: true, render: (a) => dur(a.moving_s) },
    { key: "pace", label: "Pace", sort: true, num: true, render: (a) => (a.distance_m ? pace(a.avg_speed) : "–") },
    { key: "hr", label: "Avg HR", sort: true, num: true, render: (a) => bpm(a.avg_hr) },
    { key: "ascent", label: "Ascent", sort: true, num: true, render: (a) => meters(a.ascent_m) },
    ...(isAll ? [{ key: "person", label: "Person", sort: true, filter: { type: "select", options: personOptions(), all: "Everyone" },
      render: (a) => `${avatar(person(a.person_id), 18)} ${esc(personLabel(a.person_id))}` }] : []),
    { key: "actions", label: "", cls: "actions",
      render: (a) => `<button class="icon delete" data-delete="${a.id}" title="Delete activity" aria-label="Delete activity">${ICON.trash}</button>` },
  ];

  const tile = (a) => `
    <a class="tile ${mode}" href="#/activity/${a.id}">
      ${mode === "large" ? `<div class="tile-map">${a.polyline ? trackSvg(a.polyline, "tile-track") : `<span class="hint">${a.indoor ? "indoor" : "no route"}</span>`}</div>` : ""}
      <div class="tile-head">
        <b>${esc(a.name || typeLabel(a.activity_type))}</b>
        <span class="hint">${esc(typeLabel(a.activity_type))} · ${localTime(a)}${isAll ? ` · ${esc(personLabel(a.person_id))}` : ""}</span>
      </div>
      <div class="tile-stats">
        ${a.distance_m ? `<span><span class="hint">Distance</span>${km(a.distance_m)}</span>` : ""}
        <span><span class="hint">Time</span>${dur(a.moving_s)}</span>
        ${mode === "large" && a.distance_m ? `<span><span class="hint">Pace</span>${pace(a.avg_speed)}</span>` : ""}
        <span><span class="hint">Avg HR</span>${bpm(a.avg_hr)}</span>
        ${mode === "large" ? `<span><span class="hint">Ascent</span>${meters(a.ascent_m)}</span>` : ""}
      </div>
    </a>`;

  const filterCols = columns.filter((c) => c.filter);
  const body = mode === "list"
    ? tableHtml(columns, data.items, params, data.total, ACT_PAGE)
    : `<div class="tile-filters">${filterCols.map((c) => filterControl(c, params)).join("")}</div>
       ${pagerHtml(columns, params, data.total, ACT_PAGE)}
       <div class="tiles ${mode}">${data.items.map(tile).join("") || hint("Nothing matches the filters.")}</div>`;

  view.innerHTML = `
    <div class="page-head">
      <h2>Activities</h2>
      <div class="segmented" role="group" aria-label="View">
        ${VIEWS.map(([k, label, icon]) => `<button class="icon ${k === mode ? "active" : ""}" data-view="${k}" title="${label}" aria-label="${label}">${icon}</button>`).join("")}
      </div>
    </div>
    <div class="kpis">
      ${kpi("Activities", num(t.count))}
      ${kpi("Distance", km(t.distance_m))}
      ${kpi("Moving time", hours(t.moving_s))}
      ${kpi("Ascent", meters(t.ascent_m))}
      ${kpi("Calories", kcal(t.calories))}
    </div>
    <div class="card">${body}</div>`;
  bindTable("#/activities", params);
  view.querySelectorAll("[data-view]").forEach((b) => b.onclick = () => { store.set("view", b.dataset.view); renderActivities(params); });
  view.querySelectorAll("[data-delete]").forEach((b) => b.onclick = async () => {
    if (!confirm("Delete this activity from the database?\n\nThe FIT file is not touched. It will not be imported again unless you remove it from the import history.")) return;
    await api("activities/" + b.dataset.delete, { method: "DELETE" }).catch((e) => alert(e.message));
    renderActivities(params);
  });
}

// ---- Activity detail ---------------------------------------------------------------

async function renderActivity(id) {
  const a = await api("activities/" + id);
  const [s, track] = await Promise.all([
    api(`activities/${id}/streams?max_points=1500`),
    a.has_gps ? api(`activities/${id}/track`).catch(() => null) : null,
  ]);
  const st = s.streams;
  const stat = (label, value) => `<div class="stat"><span class="hint">${label}</span><b>${value}</b></div>`;
  const cadUnit = ["run", "walk", "hike"].includes(a.category) ? "spm" : "rpm";
  const typeSelect = TYPES.groups.map((g) => `<optgroup label="${esc(g.en)}">${TYPES.types
    .filter((t) => t.group === g.key).map((t) =>
      `<option value="${t.key}" ${t.key === a.activity_type ? "selected" : ""}>${esc(t.en)}</option>`).join("")}</optgroup>`).join("");
  const charts = [
    st.hr && lineChart(st.hr, st.time, "Heart rate", "bpm", "#ff5d5d"),
    st.speed && lineChart(st.speed.map((v) => (v == null ? null : v * 3.6)), st.time, "Speed", "km/h", "#4c8dff"),
    st.power && lineChart(st.power, st.time, "Power", "W", "#a678ff"),
    st.cadence && lineChart(st.cadence, st.time, "Cadence", cadUnit, "#3ecf8e"),
    st.altitude && lineChart(st.altitude, st.time, "Altitude", "m", "#f0b429"),
    st.respiration && lineChart(st.respiration, st.time, "Respiration", "br/min", "#38bdf8"),
  ].filter(Boolean).join("");
  view.innerHTML = `
    <a class="back" href="#/activities">← Activities</a>
    <div class="page-head"><h2>${esc(a.name || typeLabel(a.activity_type))}</h2></div>
    <div class="card">
      <div class="card-row">
        ${avatar(person(a.person_id), 22)}
        <span class="hint">${localTime(a)} · ${esc(personLabel(a.person_id))} · ${esc(a.device ?? "")}</span>
        <span class="spacer"></span>
        <select id="type">${typeSelect}</select>
        ${a.type_overridden ? state("type set manually") : ""}
        <button id="del" class="danger">${ICON.trash} Delete</button>
      </div>
    </div>
    <div class="card"><div class="grid">
      ${stat("Distance", km(a.distance_m))}${stat("Moving time", dur(a.moving_s))}
      ${stat("Elapsed time", dur(a.elapsed_s))}${stat("Avg pace", a.distance_m ? pace(a.avg_speed) : "–")}
      ${stat("Avg HR", bpm(a.avg_hr))}${stat("Max HR", bpm(a.max_hr))}
      ${stat("Avg power", watts(a.avg_power))}${stat("Normalized power", watts(a.np_power))}
      ${stat("Avg cadence", cadence(a.avg_cadence, a.category))}
      ${stat("Ascent", meters(a.ascent_m))}${stat("Descent", meters(a.descent_m))}
      ${stat("Calories", kcal(a.calories))}
    </div></div>
    ${track ? `<div class="card"><h3>Route</h3><div id="route-map" class="map"></div>${hint(`${num(track.points)} route points (simplified to 5 m). Green: start, red: finish.`)}</div>` : ""}
    <div class="card"><h3>Streams</h3>${hint(a.channels.join(", ") || "No streams")}<br>${charts}</div>
    ${a.laps.length ? `<div class="card"><h3>Laps</h3>${hint(`${a.laps.length} laps`)}<div class="scroll"><table class="data">
      <thead><tr><th>#</th><th class="num">Distance</th><th class="num">Time</th><th class="num">Pace</th>
        <th class="num">Avg HR</th><th class="num">Avg power</th><th class="num">Cadence</th><th>Intensity</th></tr></thead>
      <tbody>${a.laps.map((l) => `<tr><td>${l.idx + 1}</td><td class="num">${km(l.distance_m)}</td>
        <td class="num">${dur(l.timer_s)}</td><td class="num">${l.distance_m ? pace(l.avg_speed) : "–"}</td>
        <td class="num">${bpm(l.avg_hr)}</td><td class="num">${watts(l.avg_power)}</td>
        <td class="num">${cadence(l.avg_cadence, a.category)}</td><td>${esc(l.intensity ?? "")}</td></tr>`).join("")}
      </tbody></table></div></div>` : ""}
    <div class="card"><h3>Source files</h3>
      ${a.files.map((f) => `<div>${esc(f.rel_path)}${f.zip_member ? " › " + esc(f.zip_member) : ""} ${state(f.status)}</div>`).join("") || hint("None")}</div>`;
  document.getElementById("type").onchange = async (e) => {
    await api("activities/" + id, { method: "PATCH", body: JSON.stringify({ type: e.target.value }) });
    renderActivity(id);
  };
  if (track) showRouteMap("route-map", track.polyline).catch((e) => {
    document.getElementById("route-map").outerHTML = state("Map unavailable: " + esc(e.message), "bad") + trackSvg(track.polyline);
  });
  document.getElementById("del").onclick = async () => {
    if (!confirm("Delete this activity from the database?\n\nThe FIT file is not touched. It will not be imported again unless you remove it from the import history.")) return;
    await api("activities/" + id, { method: "DELETE" });
    location.hash = "#/activities";
  };
}


// ---- Maps (MapLibre GL, loaded on first use from the local vendor folder) -----------

let maplibreReady = null;
function loadMapLibre() {
  maplibreReady ??= new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = "vendor/maplibre-gl.css";
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = "vendor/maplibre-gl.js";
    js.onload = () => resolve(window.maplibregl);
    js.onerror = () => reject(new Error("Map library failed to load"));
    document.head.appendChild(js);
  });
  return maplibreReady;
}

let activeMap = null;
function disposeMap() {
  if (activeMap) { activeMap.remove(); activeMap = null; }
}

function baseStyle() {
  const dark = document.documentElement.dataset.theme !== "light";
  const tiles = new URL("api/basemap/", document.baseURI).href + "{z}/{x}/{y}.png";
  return {
    version: 8,
    sources: {
      base: { type: "raster", tiles: [tiles], tileSize: 256, maxzoom: 19,
              attribution: "© OpenStreetMap contributors" },
    },
    layers: [{
      id: "base", type: "raster", source: "base",
      paint: dark
        ? { "raster-saturation": -1, "raster-brightness-max": 0.32, "raster-contrast": 0.15 }
        : { "raster-saturation": -0.6, "raster-brightness-min": 0.05 },
    }],
  };
}

async function createMap(container, opts = {}) {
  const ml = await loadMapLibre();
  disposeMap();
  activeMap = new ml.Map({ container, style: baseStyle(), center: [10, 50], zoom: 3,
                           attributionControl: { compact: true }, ...opts });
  activeMap.addControl(new ml.NavigationControl({ showCompass: false }), "top-right");
  await new Promise((resolve) => activeMap.on("load", resolve));
  return activeMap;
}

function fitTo(map, coordsList, padding = 40) {
  let w = 180, s = 90, e = -180, n = -90;
  for (const coords of coordsList) for (const [lon, lat] of coords) {
    w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat);
  }
  if (w <= e) map.fitBounds([[w, s], [e, n]], { padding, duration: 0, maxZoom: 15 });
}

const lonLat = (polyline) => decodePolyline(polyline).map(([lat, lon]) => [lon, lat]);

function tileBounds(x, y, z) {
  const n = 2 ** z;
  const lon = (xx) => (xx / n) * 360 - 180;
  const lat = (yy) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}
const tilePolygon = (x, y, z, props = {}) => {
  const [w, s, e, n] = tileBounds(x, y, z);
  return { type: "Feature", properties: props,
           geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } };
};

// ---- Heatmap ------------------------------------------------------------------------

const LAYERS = [["routes", "Routes"], ["tiles", "Explorer tiles"], ["cluster", "Cluster"], ["square", "Max square"]];

async function renderHeatmap(params) {
  const isAll = CURRENT === "all";
  const q = {};
  if (!isAll) q.person = CURRENT;
  if (params.type) q.type = params.type;
  if (params.year) q.year = params.year;
  const qs = new URLSearchParams(q);
  const [tracks, tiles] = await Promise.all([api("heatmap/tracks?" + qs), api("heatmap/tiles?" + qs)]);
  let shown;
  try { shown = JSON.parse(store.get("map-layers") || "null"); } catch (e) { shown = null; }
  shown ??= { routes: true, tiles: true, cluster: true, square: true };
  const sq = tiles.max_square;
  const go = (changes) => {
    const p = Object.fromEntries(Object.entries({ ...params, ...changes }).filter(([, v]) => v));
    location.hash = "#/heatmap?" + new URLSearchParams(p);
  };
  view.innerHTML = `
    <div class="page-head"><h2>Heatmap</h2>
      <select id="h-type"><option value="">All types</option>${typeOptions().map((g) =>
        `<optgroup label="${esc(g.group)}">${g.options.map(([v, l]) => `<option value="${esc(v)}" ${v === params.type ? "selected" : ""}>${esc(l)}</option>`).join("")}</optgroup>`).join("")}</select>
      <select id="h-year"><option value="">All years</option>${tracks.years.map((y) => `<option ${y === params.year ? "selected" : ""}>${y}</option>`).join("")}</select>
    </div>
    <div class="kpis">
      ${kpi("Activities on the map", num(tracks.items.length))}
      ${kpi("Explorer tiles", `${num(tiles.count)} tiles`)}
      ${kpi("Max square", sq.size ? `${sq.size} × ${sq.size} tiles` : "–")}
      ${kpi("Cluster", `${num(tiles.cluster.size)} tiles`)}
    </div>
    <div class="card map-card">
      <div class="card-row map-tools">
        ${LAYERS.map(([k, l]) => `<label class="pill"><input type="checkbox" data-layer="${k}" ${shown[k] ? "checked" : ""}> ${l}</label>`).join("")}
        <span class="spacer"></span>
        ${tiles.pending_activities ? state(`Tiles not computed yet for ${num(tiles.pending_activities)} activities — they appear after the next folder scan`, "warn") : ""}
      </div>
      <div id="map" class="map big"></div>
      ${hint(`Explorer tiles are squares of the zoom-${tiles.zoom} map grid touched by a route. The cluster is the largest group of tiles surrounded on all four sides by visited tiles; the max square is the largest square of visited tiles. Routes are drawn semi-transparent, so often used ways look brighter.`)}
    </div>`;
  document.getElementById("h-type").onchange = (e) => go({ type: e.target.value });
  document.getElementById("h-year").onchange = (e) => go({ year: e.target.value });

  const map = await createMap("map");
  const z = tiles.zoom;
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  const routes = tracks.items.map((t) => ({
    type: "Feature",
    properties: { id: t.id, day: t.day, type: typeLabel(t.activity_type), person: personLabel(t.person_id),
                  color: isAll ? personColor(person(t.person_id), Math.max(0, realPeople().findIndex((p) => p.id === t.person_id))) : accent },
    geometry: { type: "LineString", coordinates: lonLat(t.polyline) },
  }));
  map.addSource("tiles", { type: "geojson", data: { type: "FeatureCollection",
    features: tiles.tiles.map(([x, y, first, visits]) => tilePolygon(x, y, z, { first, visits })) } });
  map.addSource("cluster", { type: "geojson", data: { type: "FeatureCollection",
    features: tiles.cluster.tiles.map(([x, y]) => tilePolygon(x, y, z)) } });
  map.addSource("square", { type: "geojson", data: sq.size
    ? { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [(() => {
        const [w, , , n] = tileBounds(sq.x, sq.y, z), [, s, e] = tileBounds(sq.x + sq.size - 1, sq.y + sq.size - 1, z);
        return [[w, s], [e, s], [e, n], [w, n], [w, s]]; })()] } }
    : { type: "FeatureCollection", features: [] } });
  map.addSource("routes", { type: "geojson", data: { type: "FeatureCollection", features: routes } });

  map.addLayer({ id: "tiles", type: "fill", source: "tiles", paint: { "fill-color": "#3ecf8e", "fill-opacity": 0.14 } });
  map.addLayer({ id: "tiles-line", type: "line", source: "tiles", paint: { "line-color": "#3ecf8e", "line-opacity": 0.35, "line-width": 0.6 } });
  map.addLayer({ id: "cluster", type: "fill", source: "cluster", paint: { "fill-color": "#a678ff", "fill-opacity": 0.3 } });
  map.addLayer({ id: "square", type: "line", source: "square", paint: { "line-color": "#f0b429", "line-width": 2.5 } });
  map.addLayer({ id: "routes", type: "line", source: "routes",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": ["get", "color"], "line-opacity": 0.45,
             "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 13, 2, 16, 4] } });

  const visibility = () => {
    const set = (id, on) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    set("routes", shown.routes); set("tiles", shown.tiles); set("tiles-line", shown.tiles);
    set("cluster", shown.cluster); set("square", shown.square);
  };
  visibility();
  view.querySelectorAll("[data-layer]").forEach((cb) => cb.onchange = () => {
    shown[cb.dataset.layer] = cb.checked;
    store.set("map-layers", JSON.stringify(shown));
    visibility();
  });

  map.on("click", "routes", (e) => {
    const items = [...new Map(e.features.map((f) => [f.properties.id, f.properties])).values()].slice(0, 6);
    new maplibregl.Popup({ closeButton: false, maxWidth: "260px" }).setLngLat(e.lngLat)
      .setHTML(items.map((p) => `<a href="#/activity/${p.id}">${esc(p.type)} · ${esc(p.day)}</a>${isAll ? ` <span class="hint">${esc(p.person)}</span>` : ""}`).join("<br>"))
      .addTo(map);
  });
  map.on("mouseenter", "routes", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "routes", () => { map.getCanvas().style.cursor = ""; });

  if (routes.length) fitTo(map, routes.map((r) => r.geometry.coordinates));
  else if (tiles.tiles.length) fitTo(map, tiles.tiles.map(([x, y]) => { const [w, s, e, n] = tileBounds(x, y, z); return [[w, s], [e, n]]; }));
}

async function showRouteMap(container, polyline) {
  const map = await createMap(container, { interactive: true });
  const coords = lonLat(polyline);
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  map.addSource("route", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } } });
  map.addLayer({ id: "route", type: "line", source: "route", layout: { "line-join": "round", "line-cap": "round" },
                 paint: { "line-color": accent, "line-width": 3.5 } });
  map.addSource("ends", { type: "geojson", data: { type: "FeatureCollection", features: [
    { type: "Feature", properties: { c: "#3ecf8e" }, geometry: { type: "Point", coordinates: coords[0] } },
    { type: "Feature", properties: { c: "#ff6b6b" }, geometry: { type: "Point", coordinates: coords[coords.length - 1] } }] } });
  map.addLayer({ id: "ends", type: "circle", source: "ends", paint: { "circle-radius": 5, "circle-color": ["get", "c"], "circle-stroke-width": 2, "circle-stroke-color": "#fff" } });
  fitTo(map, [coords]);
}

// ---- Coming-soon pages --------------------------------------------------------------

const PLANNED = {
  calendar: ["Calendar", "Stage 4", [
    "Month and year view with every activity on its day, coloured by type.",
    "Weekly totals (distance, time, load) at the end of each week.",
  ]],
  fitness: ["Fitness", "Stage 4", [
    "Training load per activity, fitness (CTL), fatigue (ATL) and form (TSB) over time.",
    "Uses the thresholds set for the person (HR max, threshold HR, FTP, threshold pace).",
  ]],
  stats: ["Statistics", "Stage 4", [
    "Totals per week, month and year by activity type; year-over-year comparison.",
    "Power, pace and heart-rate duration curves and personal records.",
  ]],
};

function renderPlanned(key) {
  const [title, stage, items] = PLANNED[key];
  view.innerHTML = `<div class="page-head"><h2>${title}</h2></div>
    <div class="card"><div class="card-row">${state(`Planned — ${stage}`, "warn")}</div>
      <ul class="plain">${items.map((i) => `<li>${i}</li>`).join("")}</ul></div>`;
}

// ---- Compare (everyone) -------------------------------------------------------------

async function renderCompare(params) {
  const data = await api("compare?" + new URLSearchParams(params.year ? { year: params.year } : {}));
  const people = data.people;
  const max = (k) => Math.max(1, ...people.map((p) => p[k] || 0));
  const bar = (p, k, i, fmt) => `<div class="bar-row"><span class="bar-label">${avatar(p, 18)} ${esc(p.label)}</span>
      <span class="bar"><span style="width:${((p[k] || 0) / max(k)) * 100}%;background:${personColor(p, i)}"></span></span>
      <span class="bar-value">${fmt(p[k])}</span></div>`;
  view.innerHTML = `
    <div class="page-head"><h2>Compare</h2>
      <select id="year"><option value="">All time</option>${data.years.map((y) => `<option ${y === params.year ? "selected" : ""}>${y}</option>`).join("")}</select>
    </div>
    ${hint("Everyone side by side, in the order set in Settings › People.")}<br>
    <div class="cards">
      ${[["Activities", "activities", (v) => num(v || 0)], ["Distance", "distance_m", km], ["Moving time", "moving_s", hours], ["Ascent", "ascent_m", meters]]
        .map(([label, k, fmt]) => `<div class="card"><h3>${label}</h3>${people.map((p, i) => bar(p, k, i, fmt)).join("")}</div>`).join("")}
    </div>
    <div class="cards">${people.map((p, i) => `<div class="card">
      <div class="card-row">${avatar(p, 28)} <h3 style="margin:0">${esc(p.label)}</h3></div>
      ${hint(p.last_activity ? `Last activity ${browserTime(p.last_activity)}` : "No activities")}
      <table class="data"><thead><tr><th>Group</th><th class="num">Activities</th><th class="num">Distance</th><th class="num">Time</th></tr></thead>
      <tbody>${p.groups.map((g) => `<tr><td>${esc(groupLabel(g.category))}</td><td class="num">${num(g.activities)}</td>
        <td class="num">${g.distance_m ? km(g.distance_m) : "–"}</td><td class="num">${hours(g.moving_s)}</td></tr>`).join("")
        || `<tr><td colspan="4" class="hint">No activities</td></tr>`}</tbody></table></div>`).join("")}</div>`;
  document.getElementById("year").onchange = (e) => {
    location.hash = "#/compare" + (e.target.value ? "?year=" + e.target.value : "");
  };
}

// ---- Settings: General / People / Import / Types ------------------------------------

const SETTINGS_TABS = [["general", "General"], ["people", "People"], ["import", "Import"], ["types", "Activity types"]];

async function renderSettings(tab, params) {
  tab = SETTINGS_TABS.some(([k]) => k === tab) ? tab : "general";
  view.innerHTML = `<div class="page-head"><h2>Settings</h2></div>
    <div class="tabs">${SETTINGS_TABS.map(([k, l]) => `<a href="#/settings/${k}" class="${k === tab ? "active" : ""}">${l}</a>`).join("")}</div>
    <div id="tab"></div>`;
  const el = document.getElementById("tab");
  if (tab === "people") await settingsPeople(el);
  else if (tab === "import") await settingsImport(el, params);
  else if (tab === "types") settingsTypes(el, params);
  else await settingsGeneral(el);
}

async function settingsGeneral(el) {
  const s = await api("settings");
  const interval = (m) => (m === 0 ? "Off" : m < 60 ? `${m} min` : m === 60 ? "1 hour" : `${m / 60} hours`);
  el.innerHTML = `
    <div class="card">
      <h3>Watched folder</h3>
      ${hint(`Absolute path to the folder with FIT files.${s.allowed_roots ? ` It must be inside: ${esc(s.allowed_roots)}.` : ""}`)}
      <input class="field-input" name="root" value="${esc(s.root || "")}" placeholder="/share/trailbook">
      ${hint("Changing the folder marks files of the old folder as missing; their activities stay.")}
      <div class="card-row" style="margin-top:12px"><button class="primary" data-save="root">Save</button><span data-msg></span></div>
    </div>
    <div class="card">
      <h3>Assigning files to people</h3>
      <label class="choice"><input type="radio" name="person_mode" value="folders" ${s.person_mode === "folders" ? "checked" : ""}>
        <span><b>One subfolder per person</b><span class="hint">folder/alice/…, folder/bob/… — the folder decides. Works when two people share a watch.</span></span></label>
      <label class="choice"><input type="radio" name="person_mode" value="devices" ${s.person_mode === "devices" ? "checked" : ""}>
        <span><b>One shared folder, assign by watch</b><span class="hint">Any folder layout. Each watch is linked to a person in Settings › People.</span></span></label>
      ${hint("Switching keeps existing activities where they are; the new rule applies to files imported from now on.")}
      <div class="card-row" style="margin-top:12px"><button class="primary" data-save="person_mode">Save</button><span data-msg></span></div>
    </div>
    <div class="card">
      <h3>Automatic folder scan</h3>
      ${hint("A scan only compares file sizes and dates; new files are then imported at the lowest priority.")}
      <select class="field-input" name="scan_interval_min" style="max-width:200px">${s.scan_interval_choices.map((m) =>
        `<option value="${m}" ${m === s.scan_interval_min ? "selected" : ""}>${interval(m)}</option>`).join("")}</select>
      <div>${s.next_scan_at ? state(`Next scan at ${browserTime(s.next_scan_at)}`) : state("No automatic scan scheduled", "warn")}</div>
      <div class="card-row" style="margin-top:12px"><button class="primary" data-save="scan_interval_min">Save</button><span data-msg></span></div>
    </div>`;
  el.querySelectorAll("[data-save]").forEach((btn) => btn.onclick = async () => {
    const key = btn.dataset.save, card = btn.closest(".card"), out = card.querySelector("[data-msg]");
    const field = key === "person_mode" ? card.querySelector("input[name=person_mode]:checked") : card.querySelector(`[name=${key}]`);
    const value = key === "scan_interval_min" ? Number(field.value) : field.value;
    try {
      await api("settings", { method: "PUT", body: JSON.stringify({ [key]: value }) });
      out.innerHTML = state("Saved", "ok");
      setTimeout(() => settingsGeneral(el), 900);
    } catch (e) { out.innerHTML = state(esc(e.message), "bad"); }
  });
}

async function settingsPeople(el) {
  const [settings, devices] = await Promise.all([api("settings"), api("devices")]);
  PERSONS = await api("persons");
  renderHeader("settings");
  const byFolder = settings.person_mode === "folders";
  const people = realPeople();
  const unassigned = person("_unassigned");
  el.innerHTML = `
    <div class="card">
      <h3>People</h3>
      ${hint(byFolder
        ? "Each subfolder of the watched folder is one person; the folder name is the id. Drag rows to set the order used everywhere (person picker, compare, statistics). The first person is selected by default."
        : "People are assigned by the watch that recorded each file. Drag rows to set the order used everywhere. The first person is selected by default.")}
      <div class="scroll"><table class="data people"><thead><tr><th></th><th>Icon</th><th>Color</th><th>Label</th><th>Id</th><th class="num">Activities</th></tr></thead>
      <tbody id="people-rows">${people.map((p, i) => `<tr draggable="true" data-row="${esc(p.id)}">
        <td class="grip" title="Drag to reorder">${ICON.grip}</td>
        <td><select data-icon="${esc(p.id)}" class="icon-select">${PERSON_ICONS.map((ic) =>
          `<option value="${ic}" ${ic === (p.icon || "") ? "selected" : ""}>${ic || "Aa"}</option>`).join("")}</select></td>
        <td><span class="swatches">${PERSON_COLORS.map((c) =>
          `<button class="swatch ${c === personColor(p, i) ? "active" : ""}" style="background:${c}" data-color="${c}" data-pid="${esc(p.id)}" aria-label="Color ${c}"></button>`).join("")}</span></td>
        <td><input data-label="${esc(p.id)}" value="${esc(p.label)}"></td>
        <td><code>${esc(p.id)}</code></td>
        <td class="num">${num(p.activities)}</td></tr>`).join("") || `<tr><td colspan="6" class="hint">No people yet.</td></tr>`}
      ${unassigned && unassigned.activities ? `<tr><td></td><td></td><td></td><td>${state("Unassigned", "warn")}</td><td><code>—</code></td><td class="num">${num(unassigned.activities)}</td></tr>` : ""}
      </tbody></table></div>
      ${byFolder ? "" : `<div class="card-row" style="margin-top:12px"><input id="new-label" placeholder="New person's name"><button id="add" class="primary">Add person</button></div>`}
      <div class="card-row" style="margin-top:8px"><span id="people-msg"></span></div>
    </div>
    <div class="card">
      <h3>Watches</h3>
      ${hint("FIT files contain no Garmin account id, but every file carries the serial number of the watch that recorded it.")}
      ${hint(byFolder
        ? "Mode “one subfolder per person”: the folder decides who a file belongs to. A watch's person only applies to files lying directly in the watched folder. Two people can share one watch in this mode."
        : "Mode “one shared folder”: the linked person decides. Changing a watch moves all of its files and activities to the new person.")}
      <div class="scroll"><table class="data"><thead><tr><th>Serial</th><th>Model</th><th>Person</th>
        <th>Found in folders</th><th class="num">Activities</th><th class="num">Files</th><th>Last seen</th></tr></thead>
      <tbody>${devices.map((d) => `<tr><td><code>${d.serial}</code></td><td>${esc(d.product_name || "–")}</td>
        <td><select data-serial="${d.serial}"><option value="">Unassigned</option>${people.map((p) =>
          `<option value="${esc(p.id)}" ${p.id === d.person_id ? "selected" : ""}>${esc(p.label)}</option>`).join("")}</select></td>
        <td>${esc((d.folders || "").split(",").filter(Boolean).map(personLabel).join(", ") || "–")}</td>
        <td class="num">${num(d.activities)}</td><td class="num">${num(d.files)}</td><td>${browserTime(d.last_seen)}</td></tr>`).join("")
        || `<tr><td colspan="7" class="hint">No watches seen yet.</td></tr>`}</tbody></table></div>
    </div>`;
  const msg = (text, kind = "ok") => { el.querySelector("#people-msg").innerHTML = state(text, kind); };
  const patch = async (pid, body, okText) => {
    try {
      await api("persons/" + encodeURIComponent(pid), { method: "PATCH", body: JSON.stringify(body) });
      PERSONS = await api("persons");
      renderHeader("settings");
      msg(okText);
    } catch (e) { msg(e.message, "bad"); }
  };
  el.querySelectorAll("[data-label]").forEach((inp) => inp.onchange = () => patch(inp.dataset.label, { label: inp.value }, "Label saved"));
  el.querySelectorAll("[data-icon]").forEach((sel) => sel.onchange = () => patch(sel.dataset.icon, { icon: sel.value || null }, "Icon saved"));
  el.querySelectorAll("[data-color]").forEach((b) => b.onclick = async () => {
    await patch(b.dataset.pid, { color: b.dataset.color }, "Color saved");
    settingsPeople(el);
  });
  // drag & drop order
  const tbody = el.querySelector("#people-rows");
  let dragged = null;
  tbody.querySelectorAll("tr[draggable]").forEach((row) => {
    row.ondragstart = (e) => { dragged = row; row.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; };
    row.ondragend = () => { row.classList.remove("dragging"); };
    row.ondragover = (e) => {
      e.preventDefault();
      if (!dragged || dragged === row) return;
      const after = e.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
      tbody.insertBefore(dragged, after ? row.nextSibling : row);
    };
    row.ondrop = async (e) => {
      e.preventDefault();
      const ids = [...tbody.querySelectorAll("tr[data-row]")].map((r) => r.dataset.row);
      try {
        await api("persons/order", { method: "PUT", body: JSON.stringify({ ids }) });
        PERSONS = await api("persons");
        renderHeader("settings");
        msg("Order saved");
      } catch (err) { msg(err.message, "bad"); }
    };
  });
  el.querySelectorAll("select[data-serial]").forEach((sel) => sel.onchange = async () => {
    try {
      const r = await api("devices/" + sel.dataset.serial, { method: "PATCH", body: JSON.stringify({ person_id: sel.value || null }) });
      await settingsPeople(el);
      msg(`Watch linked · ${r.moved_activities} activit${r.moved_activities === 1 ? "y" : "ies"} assigned`);
    } catch (e) { msg(e.message, "bad"); }
  });
  const add = el.querySelector("#add");
  if (add) add.onclick = async () => {
    try {
      await api("persons", { method: "POST", body: JSON.stringify({ label: el.querySelector("#new-label").value }) });
      await settingsPeople(el);
      msg("Person added");
    } catch (e) { msg(e.message, "bad"); }
  };
}

const FILE_PAGE = 100;
const STATUSES = ["new", "imported", "skipped", "duplicate", "error", "missing", "removed"];
const STATUS_KIND = { error: "bad", missing: "warn", imported: "ok", skipped: "muted", duplicate: "muted", removed: "muted" };

function fileContent(f) {
  if (f.activity_id && f.status !== "duplicate") {
    return `<a href="#/activity/${f.activity_id}">${esc(f.name || typeLabel(f.activity_type))}</a>
      <span class="hint">${esc(typeLabel(f.activity_type))}</span>`;
  }
  if (f.status === "duplicate" && f.activity_id) {
    return `duplicate of <a href="#/activity/${f.activity_id}">activity ${f.activity_id}</a>`;
  }
  return `${esc(f.skip_reason || f.fit_type || "")}${f.error ? " " + state(esc(f.error), "bad") : ""}`;
}

function fileActions(f) {
  const owner = f.status === "imported" || f.prev_status === "imported";
  return [
    f.status === "error" ? `<button class="small" data-retry="${f.id}">Retry</button>` : "",
    f.status === "missing" && !f.dismissed ? `<button class="small" data-keep="${f.id}">Keep data</button>` : "",
    f.status === "missing" && f.activity_id ? `<button class="small danger" data-del="${f.activity_id}">Delete activity</button>` : "",
    `<button class="small" data-forget="${f.id}" data-owner="${owner ? 1 : 0}" title="Remove from import history; the next scan processes the file again">Remove from history</button>`,
  ].join(" ");
}

function scanCard(st) {
  const p = st.progress;
  const last = st.running || p.state === "running"
    ? state(`Scanning: ${esc(p.phase || "")} ${num(p.done ?? 0)} / ${p.total != null ? num(p.total) : "?"} files`, "warn")
    : p.state === "failed" ? state(`Last run failed: ${esc(p.error)}`, "bad")
    : p.state === "finished" ? state(`Last run ${browserTime(p.finished_at)} — ${num(p.scanned)} files checked, ${num(p.imported)} imported, ${num(p.skipped)} skipped, ${num(p.duplicates)} duplicates, ${num(p.errors)} errors, ${num(p.missing)} missing`)
    : state("No scan yet");
  const next = st.scan_interval_min
    ? state(`Automatic scan every ${st.scan_interval_min} min${st.next_scan_at ? ` · next at ${browserTime(st.next_scan_at)}` : ""}`)
    : state("Automatic scan is off", "warn");
  return `<div class="card">
    <h3>Folder scan</h3>
    <div class="card-row"><code>${esc(st.root || "No folder configured")}</code><a href="#/settings/general">Change</a></div>
    <div class="card-row">${last}</div>
    <div class="card-row">
      <button id="scan" class="primary" ${st.running || !st.root ? "disabled" : ""}>Scan folder now</button>
      ${next}
      ${st.missing_to_review ? state(`${num(st.missing_to_review)} missing file(s) to review`, "warn") : ""}
    </div>
  </div>`;
}

async function settingsImport(el, params) {
  params = { sort: "processed", dir: "desc", ...params };
  const q = { limit: FILE_PAGE, offset: Number(params.page || 0) * FILE_PAGE, sort: params.sort, dir: params.dir };
  for (const k of ["status", "person", "file", "content", "recorded", "fit", "processed"]) if (params[k]) q[k] = params[k];
  const [st, files] = await Promise.all([api("import/status"), api("import/files?" + new URLSearchParams(q))]);
  const columns = [
    { key: "status", label: "Status", sort: true,
      filter: { type: "select", options: STATUSES.map((s) => [s, `${s} (${num(st.files[s] ?? 0)})`]) },
      render: (f) => state(f.status, STATUS_KIND[f.status] || "") +
        (f.status === "missing" && f.prev_status ? ` <span class="hint">was ${f.prev_status}</span>` : "") },
    { key: "file", label: "File", sort: true, wrap: true, filter: { type: "text" },
      render: (f) => esc(f.rel_path) + (f.zip_member ? " › " + esc(f.zip_member) : "") },
    { key: "person", label: "Person", sort: true, filter: { type: "select", options: personOptions() },
      render: (f) => esc(personLabel(f.person_id)) },
    { key: "content", label: "Activity / content", sort: true, wrap: true, filter: { type: "text", placeholder: "walk, sleep…" },
      render: (f) => fileContent(f) + (f.status === "missing"
        ? ` <span class="hint">missing since ${browserTime(f.missing_since)}${f.dismissed ? ", reviewed" : ""}</span>` : "") },
    { key: "recorded", label: "Recorded", sort: true, filter: { type: "text", placeholder: "2026-02" },
      render: (f) => (f.start_time_utc ? localTime(f) : browserTime(f.fit_created)) || "–" },
    { key: "fit", label: "FIT id", sort: true, filter: { type: "text" },
      render: (f) => `<code>${esc(f.fit_uid || "–")}</code>` },
    { key: "processed", label: "Processed", sort: true, filter: { type: "text", placeholder: "2026-11" },
      render: (f) => browserTime(f.imported_at) || "–" },
    { key: "actions", label: "", cls: "actions", render: fileActions },
  ];
  el.innerHTML = `${scanCard(st)}<div class="card"><h3>Files</h3>${tableHtml(columns, files.items, params, files.total, FILE_PAGE)}</div>`;
  bindTable("#/settings/import", params);
  const reload = () => settingsImport(el, params);
  el.querySelector("#scan").onclick = async () => { await api("import/scan", { method: "POST" }).catch((e) => alert(e.message)); reload(); };
  el.querySelectorAll("[data-retry]").forEach((b) => b.onclick = async () => { await api(`import/files/${b.dataset.retry}/retry`, { method: "POST" }); reload(); });
  el.querySelectorAll("[data-keep]").forEach((b) => b.onclick = async () => { await api(`import/files/${b.dataset.keep}/dismiss`, { method: "POST" }); reload(); });
  el.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
    if (!confirm("Delete this activity from the database? The file stays in the history as 'removed' and will not be imported again.")) return;
    await api(`activities/${b.dataset.del}`, { method: "DELETE" }); reload();
  });
  el.querySelectorAll("[data-forget]").forEach((b) => b.onclick = async () => {
    const msg = b.dataset.owner === "1"
      ? "Remove this file from the import history?\n\nIts activity is deleted too and will be rebuilt from the file on the next folder scan (manual type changes are lost)."
      : "Remove this file from the import history?\n\nThe next folder scan will process it again.";
    if (!confirm(msg)) return;
    await api(`import/files/${b.dataset.forget}`, { method: "DELETE" }); reload();
  });
  if (st.running) timer = setTimeout(reload, 2000);
}

function settingsTypes(el, params) {
  const group = params.group || "", text = (params.q || "").toLowerCase();
  const rows = TYPES.types.filter((t) => (!group || t.group === group) &&
    (!text || [t.key, t.en, t.pl, ...t.fit].join(" ").toLowerCase().includes(text)));
  el.innerHTML = `<div class="card">
    <h3>Activity types</h3>
    ${hint("Every activity gets a <b>type</b> (detailed, for analysis) inside a <b>group</b> (broad, for totals). The type is chosen from the sport and sub-sport written by the watch into the FIT file — the last column shows which combinations lead to each type (* = any). You can change the type of a single activity on its page.")}
    ${hint("Editing names and the mapping itself is planned; for now the list is read-only.")}
    <div class="tile-filters" style="margin-top:12px">
      <select id="tgroup"><option value="">All groups</option>${TYPES.groups.map((g) => `<option value="${g.key}" ${g.key === group ? "selected" : ""}>${esc(g.en)}</option>`).join("")}</select>
      <input id="tq" placeholder="Search type or FIT sport…" value="${esc(params.q || "")}">
    </div>
    <div class="scroll"><table class="data">
      <thead><tr><th>Group</th><th>Type</th><th>Polish name</th><th>Indoor</th><th>FIT sport / sub-sport</th><th class="num">Your activities</th></tr></thead>
      <tbody>${rows.map((t) => `<tr>
        <td>${esc(groupLabel(t.group))}</td><td><b>${esc(t.en)}</b> <code class="hint">${t.key}</code></td>
        <td>${esc(t.pl)}</td><td>${t.indoor ? state("indoor", "muted") : ""}</td>
        <td class="wrap"><span class="hint">${t.fit.map(esc).join(" · ") || "–"}</span></td>
        <td class="num">${t.activities ? num(t.activities) : `<span class="hint">0</span>`}</td></tr>`).join("")
        || `<tr><td colspan="6" class="hint">Nothing matches.</td></tr>`}</tbody></table></div></div>`;
  const go = (changes) => {
    const p = Object.fromEntries(Object.entries({ group, q: params.q || "", ...changes }).filter(([, v]) => v));
    location.hash = "#/settings/types?" + new URLSearchParams(p);
  };
  el.querySelector("#tgroup").onchange = (e) => go({ group: e.target.value });
  const tq = el.querySelector("#tq");
  tq.onkeydown = (e) => { if (e.key === "Enter") go({ q: tq.value.trim() }); };
  tq.onblur = () => { if (tq.value.trim() !== (params.q || "")) go({ q: tq.value.trim() }); };
}

// ---- Router ------------------------------------------------------------------------

async function route() {
  clearTimeout(timer);
  disposeMap();
  const [path, query] = (location.hash.slice(1) || "/activities").split("?");
  const params = Object.fromEntries(new URLSearchParams(query || ""));
  const parts = path.split("/").filter(Boolean);
  try {
    TYPES ??= await api("types");
    PERSONS = await api("persons");
    if (CURRENT === null || (CURRENT !== "all" && !person(CURRENT))) CURRENT = pickDefaultPerson();
    let section = parts[0] === "activity" ? "activities" : parts[0] || "activities";
    // Views that only make sense for one person / for everyone.
    if (CURRENT === "all" && (section === "fitness" || section === "stats")) { location.hash = "#/compare"; return; }
    if (CURRENT !== "all" && section === "compare") { location.hash = "#/activities"; return; }
    renderHeader(section);
    if (parts[0] === "activity") await renderActivity(parts[1]);
    else if (section === "settings") await renderSettings(parts[1], params);
    else if (section === "compare") await renderCompare(params);
    else if (section === "heatmap") await renderHeatmap(params);
    else if (PLANNED[section]) renderPlanned(section);
    else await renderActivities(params);
  } catch (e) {
    view.innerHTML = `<div class="card">${state("Error: " + esc(e.message), "bad")}</div>`;
  }
}

window.addEventListener("hashchange", route);
route();
