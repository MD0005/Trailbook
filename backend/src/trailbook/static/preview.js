// Technical preview UI. Plain JS, no build step, no external requests.
// All API URLs are relative so the page works behind Home Assistant Ingress.
//
// Style rules (see preview.css): every section is a .card; descriptions use .hint;
// states (next scan, saved, running, errors) use .state (+ .ok/.warn/.bad).
"use strict";

const view = document.getElementById("view");
let TYPES = null;
let PERSONS = [];
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

// ---- icons & theme ------------------------------------------------------------------

const ICON = {
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`,
  sun: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  moon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`,
};

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
    try { localStorage.setItem("trailbook-theme", next); } catch (e) { /* ignore */ }
    paint();
  };
  paint();
}

// ---- formatting ---------------------------------------------------------------------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const km = (m) => (m == null ? "–" : (m / 1000).toFixed(2) + " km");
const dur = (s) => {
  if (s == null) return "–";
  s = Math.round(s);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
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
const typeLabel = (key) => TYPES?.types.find((t) => t.key === key)?.en ?? key;
const personLabel = (id) => PERSONS.find((p) => p.id === id)?.label ?? id;
const hint = (text) => `<div class="hint">${text}</div>`;
const state = (text, kind = "") => `<span class="state ${kind}">${text}</span>`;

// ---- generic table: sortable header + filter row ------------------------------------
// columns: [{ key, label, sort?: bool, num?: bool, wrap?: bool, cls?: string,
//             filter?: { type: "text"|"select", options?: [[value, label] | {group, options}],
//                        placeholder? },
//             render: (row) => html }]
// The table state (sort, dir, page, one value per filter key) lives in the URL hash.

function tableHtml(columns, rows, params, total, pageSize) {
  const sort = params.sort, dir = params.dir || "desc";
  const head = columns.map((c) => {
    if (!c.sort) return `<th class="${c.num ? "num" : ""}">${esc(c.label)}</th>`;
    const active = sort === c.key;
    const arrow = active ? (dir === "asc" ? "▲" : "▼") : "↕";
    return `<th class="${c.num ? "num" : ""}"><a href="#" class="sort ${active ? "active" : ""}" data-sort="${c.key}">${esc(c.label)} <span class="arrow">${arrow}</span></a></th>`;
  }).join("");
  const filters = columns.map((c) => {
    const f = c.filter;
    if (!f) return "<th></th>";
    const value = params[c.key] ?? "";
    if (f.type === "select") {
      const opt = ([v, l]) => `<option value="${esc(v)}" ${v === value ? "selected" : ""}>${esc(l)}</option>`;
      const opts = f.options.map((o) => (o.group
        ? `<optgroup label="${esc(o.group)}">${o.options.map(opt).join("")}</optgroup>` : opt(o))).join("");
      return `<th><select data-filter="${c.key}"><option value="">All</option>${opts}</select></th>`;
    }
    return `<th><input data-filter="${c.key}" value="${esc(value)}" placeholder="${esc(f.placeholder || "filter…")}"></th>`;
  }).join("");
  const body = rows.length
    ? rows.map((r) => `<tr>${columns.map((c) =>
        `<td class="${c.num ? "num" : ""} ${c.wrap ? "wrap" : ""} ${c.cls || ""}">${c.render(r)}</td>`).join("")}</tr>`).join("")
    : `<tr><td colspan="${columns.length}" class="hint">Nothing matches the filters.</td></tr>`;
  const page = Number(params.page || 0), pages = Math.max(1, Math.ceil(total / pageSize));
  const filtered = columns.some((c) => params[c.key]);
  return `
    <div class="tablebar">
      <span class="hint">${total} row(s)</span>
      ${filtered ? `<button class="small" data-clear>Clear filters</button>` : ""}
      <span class="spacer"></span>
      <span class="pager">
        <button class="small" data-page="${page - 1}" ${page > 0 ? "" : "disabled"} title="Previous page">‹ Prev</button>
        <span class="hint">Page ${page + 1} / ${pages}</span>
        <button class="small" data-page="${page + 1}" ${page + 1 < pages ? "" : "disabled"} title="Next page">Next ›</button>
      </span>
    </div>
    <div class="scroll"><table class="data">
      <thead><tr>${head}</tr><tr class="filters-row">${filters}</tr></thead>
      <tbody>${body}</tbody></table></div>`;
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

const personOptions = () => PERSONS.map((p) => [p.id, p.label]);
const typeOptions = () => TYPES.groups.map((g) => ({
  group: g.en,
  options: [[`g:${g.key}`, `All ${g.en.toLowerCase()}`],
    ...TYPES.types.filter((t) => t.group === g.key).map((t) => [t.key, t.en])],
}));

// ---- Activities list ---------------------------------------------------------------

const ACT_PAGE = 100;

async function renderActivities(params) {
  params = { sort: "date", dir: "desc", ...params };
  const q = { limit: ACT_PAGE, offset: Number(params.page || 0) * ACT_PAGE, sort: params.sort, dir: params.dir };
  for (const k of ["person", "type", "date"]) if (params[k]) q[k] = params[k];
  if (params.name) q.q = params.name;
  const data = await api("activities?" + new URLSearchParams(q));
  const columns = [
    { key: "date", label: "Date", sort: true, filter: { type: "text", placeholder: "2026-02" },
      render: (a) => `<a href="#/activity/${a.id}">${localTime(a)}</a>` },
    { key: "type", label: "Type", sort: true, filter: { type: "select", options: typeOptions() },
      render: (a) => esc(typeLabel(a.activity_type)) + (a.indoor ? ` <span class="hint">indoor</span>` : "") },
    { key: "name", label: "Name", sort: true, filter: { type: "text" }, render: (a) => esc(a.name) },
    { key: "distance", label: "Distance", sort: true, num: true, render: (a) => km(a.distance_m) },
    { key: "moving", label: "Moving", sort: true, num: true, render: (a) => dur(a.moving_s) },
    { key: "pace", label: "Pace", sort: true, num: true, render: (a) => (a.distance_m ? pace(a.avg_speed) : "–") },
    { key: "hr", label: "HR", sort: true, num: true, render: (a) => a.avg_hr ?? "–" },
    { key: "ascent", label: "Ascent", sort: true, num: true, render: (a) => a.ascent_m ?? "–" },
    { key: "person", label: "Person", sort: true, filter: { type: "select", options: personOptions() },
      render: (a) => esc(personLabel(a.person_id)) },
    { key: "actions", label: "", cls: "actions",
      render: (a) => `<button class="icon delete" data-delete="${a.id}" title="Delete activity" aria-label="Delete activity">${ICON.trash}</button>` },
  ];
  view.innerHTML = `<h2>Activities</h2><div class="card">${tableHtml(columns, data.items, params, data.total, ACT_PAGE)}</div>`;
  bindTable("#/activities", params);
  view.querySelectorAll("[data-delete]").forEach((b) => b.onclick = async () => {
    if (!confirm("Delete this activity from the database?\n\nThe FIT file is not touched. It will not be imported again unless you remove it from the import history.")) return;
    await api("activities/" + b.dataset.delete, { method: "DELETE" }).catch((e) => alert(e.message));
    renderActivities(params);
  });
}

// ---- Activity detail ---------------------------------------------------------------

function lineChart(values, times, label, color) {
  const pts = values.map((v, i) => [times[i], v]).filter(([t, v]) => v != null && t != null);
  if (pts.length < 2) return "";
  const W = 1000, H = 140, P = 4;
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  let lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
  if (hi === lo) hi = lo + 1;
  const d = pts.map(([t, v], i) => `${i ? "L" : "M"}${(P + ((t - t0) / (t1 - t0 || 1)) * (W - 2 * P)).toFixed(1)},${(H - P - ((v - lo) / (hi - lo)) * (H - 2 * P)).toFixed(1)}`).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    <text x="8" y="16" fill="currentColor" font-size="12" opacity="0.7">${esc(label)}: ${lo.toFixed(0)}–${hi.toFixed(0)}</text></svg>`;
}

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

function trackSvg(polyline) {
  const pts = decodePolyline(polyline);
  const lat0 = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const xs = pts.map((p) => p[1] * k), ys = pts.map((p) => -p[0]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const w = Math.max(...xs) - minX || 1e-6, h = Math.max(...ys) - minY || 1e-6;
  const d = xs.map((x, i) => `${i ? "L" : "M"}${(x - minX).toFixed(6)},${(ys[i] - minY).toFixed(6)}`).join("");
  return `<svg class="track" viewBox="${-w * 0.05} ${-h * 0.05} ${w * 1.1} ${h * 1.1}">
    <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}

async function renderActivity(id) {
  const a = await api("activities/" + id);
  const [s, track] = await Promise.all([
    api(`activities/${id}/streams?max_points=1500`),
    a.has_gps ? api(`activities/${id}/track`).catch(() => null) : null,
  ]);
  const st = s.streams;
  const stat = (label, value) => `<div class="stat"><span class="hint">${label}</span><b>${value}</b></div>`;
  const typeSelect = TYPES.groups.map((g) => `<optgroup label="${esc(g.en)}">${TYPES.types
    .filter((t) => t.group === g.key).map((t) =>
      `<option value="${t.key}" ${t.key === a.activity_type ? "selected" : ""}>${esc(t.en)}</option>`).join("")}</optgroup>`).join("");
  const charts = [
    st.hr && lineChart(st.hr, st.time, "Heart rate", "#ff5d5d"),
    st.speed && lineChart(st.speed.map((v) => (v == null ? null : v * 3.6)), st.time, "Speed km/h", "#4c8dff"),
    st.power && lineChart(st.power, st.time, "Power W", "#a678ff"),
    st.cadence && lineChart(st.cadence, st.time, "Cadence", "#3ecf8e"),
    st.altitude && lineChart(st.altitude, st.time, "Altitude m", "#f0b429"),
    st.respiration && lineChart(st.respiration, st.time, "Respiration /min", "#38bdf8"),
  ].filter(Boolean).join("");
  view.innerHTML = `
    <a class="back" href="#/activities">← Activities</a>
    <h2>${esc(a.name || typeLabel(a.activity_type))}</h2>
    <div class="card">
      <div class="card-row">
        <span class="hint">${localTime(a)} · ${esc(personLabel(a.person_id))} · ${esc(a.device ?? "")}</span>
        <span class="spacer" style="flex:1"></span>
        <select id="type">${typeSelect}</select>
        ${a.type_overridden ? state("type set manually") : ""}
        <button id="del" class="danger">${ICON.trash} Delete</button>
      </div>
    </div>
    <div class="card"><div class="grid">
      ${stat("Distance", km(a.distance_m))}${stat("Moving time", dur(a.moving_s))}
      ${stat("Elapsed", dur(a.elapsed_s))}${stat("Avg pace", a.distance_m ? pace(a.avg_speed) : "–")}
      ${stat("Avg / max HR", `${a.avg_hr ?? "–"} / ${a.max_hr ?? "–"}`)}
      ${stat("Power avg / NP", `${a.avg_power ?? "–"} / ${a.np_power ?? "–"}`)}
      ${stat("Cadence", a.avg_cadence ? Math.round(a.avg_cadence) : "–")}
      ${stat("Ascent / descent", `${a.ascent_m ?? "–"} / ${a.descent_m ?? "–"} m`)}
      ${stat("Calories", a.calories ?? "–")}
    </div></div>
    ${track ? `<div class="card"><h3>Route</h3>${hint(`${track.points} points, simplified. The map comes in the next stage.`)}<br>${trackSvg(track.polyline)}</div>` : ""}
    <div class="card"><h3>Streams</h3>${hint(a.channels.join(", ") || "No streams")}<br>${charts}</div>
    ${a.laps.length ? `<div class="card"><h3>Laps</h3>${hint(`${a.laps.length} laps`)}<div class="scroll"><table class="data">
      <thead><tr><th>#</th><th class="num">Distance</th><th class="num">Time</th><th class="num">Pace</th>
        <th class="num">HR</th><th class="num">Power</th><th class="num">Cadence</th><th>Intensity</th></tr></thead>
      <tbody>${a.laps.map((l) => `<tr><td>${l.idx + 1}</td><td class="num">${km(l.distance_m)}</td>
        <td class="num">${dur(l.timer_s)}</td><td class="num">${l.distance_m ? pace(l.avg_speed) : "–"}</td>
        <td class="num">${l.avg_hr ?? "–"}</td><td class="num">${l.avg_power ?? "–"}</td>
        <td class="num">${l.avg_cadence ? Math.round(l.avg_cadence) : "–"}</td><td>${esc(l.intensity ?? "")}</td></tr>`).join("")}
      </tbody></table></div></div>` : ""}
    <div class="card"><h3>Source files</h3>
      ${a.files.map((f) => `<div>${esc(f.rel_path)}${f.zip_member ? " › " + esc(f.zip_member) : ""} ${state(f.status)}</div>`).join("") || hint("None")}</div>`;
  document.getElementById("type").onchange = async (e) => {
    await api("activities/" + id, { method: "PATCH", body: JSON.stringify({ type: e.target.value }) });
    renderActivity(id);
  };
  document.getElementById("del").onclick = async () => {
    if (!confirm("Delete this activity from the database?\n\nThe FIT file is not touched. It will not be imported again unless you remove it from the import history.")) return;
    await api("activities/" + id, { method: "DELETE" });
    location.hash = "#/activities";
  };
}

// ---- Import manager ----------------------------------------------------------------

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
    ? state(`Scanning: ${esc(p.phase || "")} ${p.done ?? 0} / ${p.total ?? "?"}`, "warn")
    : p.state === "failed" ? state(`Last run failed: ${esc(p.error)}`, "bad")
    : p.state === "finished" ? state(`Last run ${browserTime(p.finished_at)} — ${p.scanned} checked, ${p.imported} imported, ${p.skipped} skipped, ${p.duplicates} duplicates, ${p.errors} errors, ${p.missing} missing`)
    : state("No scan yet");
  const next = st.scan_interval_min
    ? state(`Automatic scan every ${st.scan_interval_min} min${st.next_scan_at ? ` · next at ${browserTime(st.next_scan_at)}` : ""}`)
    : state("Automatic scan is off", "warn");
  return `<div class="card">
    <h3>Folder scan</h3>
    <div class="card-row"><code>${esc(st.root || "No folder configured")}</code><a href="#/settings">Change</a></div>
    <div class="card-row">${last}</div>
    <div class="card-row">
      <button id="scan" class="primary" ${st.running || !st.root ? "disabled" : ""}>Scan folder now</button>
      ${next}
      ${st.missing_to_review ? state(`${st.missing_to_review} missing file(s) to review`, "warn") : ""}
    </div>
  </div>`;
}

async function renderImport(params) {
  params = { sort: "processed", dir: "desc", ...params };
  const q = { limit: FILE_PAGE, offset: Number(params.page || 0) * FILE_PAGE, sort: params.sort, dir: params.dir };
  for (const k of ["status", "person", "file", "content", "recorded", "fit", "processed"]) if (params[k]) q[k] = params[k];
  const [st, files] = await Promise.all([api("import/status"), api("import/files?" + new URLSearchParams(q))]);
  const columns = [
    { key: "status", label: "Status", sort: true,
      filter: { type: "select", options: STATUSES.map((s) => [s, `${s} (${st.files[s] ?? 0})`]) },
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
  view.innerHTML = `<h2>Import</h2>${scanCard(st)}
    <div class="card"><h3>Files</h3>${tableHtml(columns, files.items, params, files.total, FILE_PAGE)}</div>`;
  bindTable("#/import", params);
  const reload = () => renderImport(params);
  document.getElementById("scan").onclick = async () => {
    await api("import/scan", { method: "POST" }).catch((e) => alert(e.message)); reload();
  };
  view.querySelectorAll("[data-retry]").forEach((b) => b.onclick = async () => {
    await api(`import/files/${b.dataset.retry}/retry`, { method: "POST" }); reload();
  });
  view.querySelectorAll("[data-keep]").forEach((b) => b.onclick = async () => {
    await api(`import/files/${b.dataset.keep}/dismiss`, { method: "POST" }); reload();
  });
  view.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
    if (!confirm("Delete this activity from the database? The file stays in the history as 'removed' and will not be imported again.")) return;
    await api(`activities/${b.dataset.del}`, { method: "DELETE" }); reload();
  });
  view.querySelectorAll("[data-forget]").forEach((b) => b.onclick = async () => {
    const msg = b.dataset.owner === "1"
      ? "Remove this file from the import history?\n\nIts activity is deleted too and will be rebuilt from the file on the next folder scan (manual type changes are lost)."
      : "Remove this file from the import history?\n\nThe next folder scan will process it again.";
    if (!confirm(msg)) return;
    await api(`import/files/${b.dataset.forget}`, { method: "DELETE" }); reload();
  });
  if (st.running) timer = setTimeout(reload, 2000);
}

// ---- People & watches --------------------------------------------------------------

async function renderPeople() {
  const [settings, devices] = await Promise.all([api("settings"), api("devices")]);
  PERSONS = await api("persons");
  const byFolder = settings.person_mode === "folders";
  const people = PERSONS.filter((p) => p.id !== "_unassigned");
  const unassigned = PERSONS.find((p) => p.id === "_unassigned");
  view.innerHTML = `<h2>People</h2>
    <div class="card">
      <h3>People</h3>
      ${hint(byFolder
        ? "Each subfolder of the watched folder is one person; the folder name is the id. The label is what the app shows."
        : "People are assigned by the watch that recorded each file. Add people here and link their watches below.")}
      <div class="scroll"><table class="data"><thead><tr><th>Id</th><th>Label</th><th class="num">Activities</th></tr></thead>
      <tbody>${people.map((p) => `<tr><td><code>${esc(p.id)}</code></td>
        <td><input data-id="${esc(p.id)}" value="${esc(p.label)}"></td>
        <td class="num">${p.activities}</td></tr>`).join("") || `<tr><td colspan="3" class="hint">No people yet.</td></tr>`}
      ${unassigned && unassigned.activities ? `<tr><td><code>—</code></td><td>${state("Unassigned", "warn")}</td><td class="num">${unassigned.activities}</td></tr>` : ""}
      </tbody></table></div>
      ${byFolder ? "" : `<div class="card-row" style="margin-top:12px"><input id="new-label" placeholder="New person's name"><button id="add" class="primary">Add person</button></div>`}
    </div>
    <div class="card">
      <h3>Watches</h3>
      ${hint("FIT files contain no Garmin account id, but every file carries the serial number of the watch that recorded it.")}
      ${hint(byFolder
        ? "Mode “one subfolder per person”: the folder decides who a file belongs to, so watches are only linked for information. Files lying directly in the watched folder (not in a person's subfolder) are assigned by their watch. Two people can share one watch in this mode."
        : "Mode “one shared folder”: the linked person decides. Changing a watch moves all of its files and activities to the new person.")}
      <div class="scroll"><table class="data"><thead><tr><th>Serial</th><th>Model</th><th>Person</th>
        <th>Found in folders</th><th class="num">Activities</th><th class="num">Files</th><th>Last seen</th></tr></thead>
      <tbody>${devices.map((d) => `<tr><td><code>${d.serial}</code></td><td>${esc(d.product_name || "–")}</td>
        <td><select data-serial="${d.serial}"><option value="">Unassigned</option>${people.map((p) =>
          `<option value="${esc(p.id)}" ${p.id === d.person_id ? "selected" : ""}>${esc(p.label)}</option>`).join("")}</select></td>
        <td>${esc((d.folders || "").split(",").filter(Boolean).map(personLabel).join(", ") || "–")}</td>
        <td class="num">${d.activities}</td><td class="num">${d.files}</td><td>${browserTime(d.last_seen)}</td></tr>`).join("")
        || `<tr><td colspan="7" class="hint">No watches seen yet.</td></tr>`}</tbody></table></div>
      <div class="card-row" style="margin-top:8px"><span id="people-msg"></span></div>
    </div>`;
  const msg = (text, kind = "ok") => { document.getElementById("people-msg").outerHTML = `<span id="people-msg">${state(text, kind)}</span>`; };
  view.querySelectorAll("input[data-id]").forEach((inp) => inp.onchange = () =>
    api("persons/" + encodeURIComponent(inp.dataset.id), {
      method: "PATCH", body: JSON.stringify({ label: inp.value }),
    }).then(() => api("persons")).then((p) => { PERSONS = p; msg("Label saved"); })
      .catch((e) => msg(e.message, "bad")));
  view.querySelectorAll("select[data-serial]").forEach((sel) => sel.onchange = async () => {
    try {
      const r = await api("devices/" + sel.dataset.serial, {
        method: "PATCH", body: JSON.stringify({ person_id: sel.value || null }),
      });
      await renderPeople();
      msg(`Watch linked · ${r.moved_activities} activit${r.moved_activities === 1 ? "y" : "ies"} moved`);
    } catch (e) { msg(e.message, "bad"); }
  });
  const add = document.getElementById("add");
  if (add) add.onclick = async () => {
    const label = document.getElementById("new-label").value;
    try {
      await api("persons", { method: "POST", body: JSON.stringify({ label }) });
      await renderPeople();
      msg("Person added");
    } catch (e) { msg(e.message, "bad"); }
  };
}

// ---- Settings ----------------------------------------------------------------------

async function renderSettings() {
  const s = await api("settings");
  const interval = (m) => (m === 0 ? "Off" : m < 60 ? `${m} min` : m === 60 ? "1 hour" : `${m / 60} hours`);
  view.innerHTML = `<h2>Settings</h2>
    <div class="card" data-section="root">
      <h3>Watched folder</h3>
      ${hint(`Absolute path to the folder with FIT files.${s.allowed_roots ? ` It must be inside: ${esc(s.allowed_roots)}.` : ""}`)}
      <input class="field-input" name="root" value="${esc(s.root || "")}" placeholder="/share/trailbook">
      ${hint("Changing the folder marks files of the old folder as missing; their activities stay.")}
      <div class="card-row" style="margin-top:12px"><button class="primary" data-save="root">Save</button><span data-msg></span></div>
    </div>
    <div class="card" data-section="person_mode">
      <h3>People</h3>
      ${hint("How files are assigned to people.")}
      <label class="choice"><input type="radio" name="person_mode" value="folders" ${s.person_mode === "folders" ? "checked" : ""}>
        <span><b>One subfolder per person</b><span class="hint">folder/alice/…, folder/bob/… — the folder decides. Works when two people share a watch.</span></span></label>
      <label class="choice"><input type="radio" name="person_mode" value="devices" ${s.person_mode === "devices" ? "checked" : ""}>
        <span><b>One shared folder, assign by watch</b><span class="hint">Any folder layout. Each watch is linked to a person on the People page.</span></span></label>
      ${hint("Switching keeps existing activities where they are; the new rule applies to files imported from now on.")}
      <div class="card-row" style="margin-top:12px"><button class="primary" data-save="person_mode">Save</button><span data-msg></span></div>
    </div>
    <div class="card" data-section="scan_interval_min">
      <h3>Automatic folder scan</h3>
      ${hint("A scan only compares file sizes and dates; new files are then imported at the lowest priority.")}
      <select class="field-input" name="scan_interval_min" style="max-width:200px">${s.scan_interval_choices.map((m) =>
        `<option value="${m}" ${m === s.scan_interval_min ? "selected" : ""}>${interval(m)}</option>`).join("")}</select>
      <div>${s.next_scan_at ? state(`Next scan at ${browserTime(s.next_scan_at)}`) : state("No automatic scan scheduled", "warn")}</div>
      <div class="card-row" style="margin-top:12px"><button class="primary" data-save="scan_interval_min">Save</button><span data-msg></span></div>
    </div>`;
  view.querySelectorAll("[data-save]").forEach((btn) => btn.onclick = async () => {
    const key = btn.dataset.save;
    const card = btn.closest(".card");
    const out = card.querySelector("[data-msg]");
    const field = key === "person_mode"
      ? card.querySelector("input[name=person_mode]:checked")
      : card.querySelector(`[name=${key}]`);
    const value = key === "scan_interval_min" ? Number(field.value) : field.value;
    try {
      await api("settings", { method: "PUT", body: JSON.stringify({ [key]: value }) });
      out.innerHTML = state("Saved", "ok");
      setTimeout(renderSettings, 900);
    } catch (e) { out.innerHTML = state(esc(e.message), "bad"); }
  });
}

function renderTypes() {
  view.innerHTML = `<h2>Activity groups and types</h2><div class="cards">` + TYPES.groups.map((g) => `
    <div class="card"><h3>${esc(g.en)}</h3>${hint(`${esc(g.pl)} · ${g.key}`)}
    <table class="data"><tbody>${TYPES.types.filter((t) => t.group === g.key).map((t) =>
      `<tr><td><code>${t.key}</code></td><td>${esc(t.en)}</td><td class="hint">${esc(t.pl)}</td><td>${t.indoor ? state("indoor") : ""}</td></tr>`).join("")}
    </tbody></table></div>`).join("") + `</div>`;
}

// ---- Router ------------------------------------------------------------------------

async function route() {
  clearTimeout(timer);
  const [path, query] = (location.hash.slice(1) || "/activities").split("?");
  const params = Object.fromEntries(new URLSearchParams(query || ""));
  const parts = path.split("/").filter(Boolean);
  const section = parts[0] === "activity" ? "activities" : parts[0] || "activities";
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === section));
  try {
    TYPES ??= await api("types");
    PERSONS = await api("persons");
    if (parts[0] === "activity") await renderActivity(parts[1]);
    else if (parts[0] === "import") await renderImport(params);
    else if (parts[0] === "people") await renderPeople();
    else if (parts[0] === "settings") await renderSettings();
    else if (parts[0] === "types") renderTypes();
    else await renderActivities(params);
  } catch (e) {
    view.innerHTML = `<div class="card">${state("Error: " + esc(e.message), "bad")}</div>`;
  }
}

setupTheme();
window.addEventListener("hashchange", route);
route();
