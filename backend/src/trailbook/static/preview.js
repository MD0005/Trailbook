// Technical preview UI. Plain JS, no build step, no external requests.
// All API URLs are relative so the page works behind Home Assistant Ingress.
"use strict";

const view = document.getElementById("view");
let TYPES = null;

const api = async (path, opts = {}) => {
  const res = await fetch("api/" + path, {
    headers: { "Content-Type": "application/json" }, ...opts,
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
};

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
const localTime = (a) => {
  const t = new Date(Date.parse(a.start_time_utc) + (a.utc_offset_s || 0) * 1000);
  return t.toISOString().slice(0, 16).replace("T", " ");
};
const typeLabel = (key) => TYPES?.types.find((t) => t.key === key)?.en ?? key;
const groupLabel = (key) => TYPES?.groups.find((g) => g.key === key)?.en ?? key;

// ---- Activities list ---------------------------------------------------------------

async function renderActivities(params) {
  const [persons, data] = await Promise.all([
    api("persons"), api("activities?" + new URLSearchParams({ limit: 200, ...params })),
  ]);
  const opt = (list, cur, all) => `<option value="">${all}</option>` + list.map(
    ([v, l]) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`).join("");
  view.innerHTML = `
    <h2>Activities <span class="muted">(${data.total})</span></h2>
    <div class="filters">
      <select id="f-person">${opt(persons.map((p) => [p.id, p.label]), params.person, "All people")}</select>
      <select id="f-group">${opt(TYPES.groups.map((g) => [g.key, g.en]), params.group, "All groups")}</select>
      <select id="f-type">${opt(TYPES.types.filter((t) => !params.group || t.group === params.group)
        .map((t) => [t.key, t.en]), params.type, "All types")}</select>
    </div>
    <div class="scroll"><table>
      <thead><tr><th>Date</th><th>Type</th><th>Name</th><th class="num">Distance</th>
        <th class="num">Moving</th><th class="num">Pace</th><th class="num">HR</th>
        <th class="num">Ascent</th><th>Person</th></tr></thead>
      <tbody>${data.items.map((a) => `<tr>
        <td><a href="#/activity/${a.id}">${localTime(a)}</a></td>
        <td>${esc(typeLabel(a.activity_type))}${a.indoor ? " <span class='muted'>(indoor)</span>" : ""}</td>
        <td>${esc(a.name)}</td><td class="num">${km(a.distance_m)}</td>
        <td class="num">${dur(a.moving_s)}</td><td class="num">${a.distance_m ? pace(a.avg_speed) : "–"}</td>
        <td class="num">${a.avg_hr ?? "–"}</td><td class="num">${a.ascent_m ?? "–"}</td>
        <td>${esc(a.person_id)}</td></tr>`).join("")}</tbody>
    </table></div>`;
  const go = () => {
    const p = {};
    for (const k of ["person", "group", "type"]) {
      const v = document.getElementById("f-" + k).value;
      if (v) p[k] = v;
    }
    if (params.group !== p.group) delete p.type;
    location.hash = "#/activities?" + new URLSearchParams(p);
  };
  for (const k of ["person", "group", "type"]) document.getElementById("f-" + k).onchange = go;
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
    <text x="8" y="16" fill="currentColor" font-size="13">${esc(label)}: ${lo.toFixed(0)}–${hi.toFixed(0)}</text></svg>`;
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
  const stat = (label, value) => `<div class="stat"><span class="muted">${label}</span><b>${value}</b></div>`;
  const typeOptions = TYPES.types.map((t) =>
    `<option value="${t.key}" ${t.key === a.activity_type ? "selected" : ""}>${esc(groupLabel(t.group))} › ${esc(t.en)}</option>`).join("");
  view.innerHTML = `
    <p><a href="#/activities">← Activities</a></p>
    <h2>${esc(a.name || typeLabel(a.activity_type))} <span class="muted">${localTime(a)} · ${esc(a.person_id)}</span></h2>
    <div class="filters">
      <select id="type">${typeOptions}</select>
      ${a.type_overridden ? "<span class='muted'>type set manually</span>" : ""}
      <button id="del" class="bad">Delete activity</button>
    </div>
    <div class="grid">
      ${stat("Distance", km(a.distance_m))}${stat("Moving time", dur(a.moving_s))}
      ${stat("Elapsed", dur(a.elapsed_s))}${stat("Avg pace", a.distance_m ? pace(a.avg_speed) : "–")}
      ${stat("Avg / max HR", `${a.avg_hr ?? "–"} / ${a.max_hr ?? "–"}`)}
      ${stat("Power avg / NP", `${a.avg_power ?? "–"} / ${a.np_power ?? "–"}`)}
      ${stat("Cadence", a.avg_cadence ? Math.round(a.avg_cadence) : "–")}
      ${stat("Ascent / descent", `${a.ascent_m ?? "–"} / ${a.descent_m ?? "–"} m`)}
      ${stat("Calories", a.calories ?? "–")}${stat("Device", esc(a.device ?? "–"))}
    </div>
    ${track ? `<h3>Route <span class="muted">(${track.points} points, simplified)</span></h3>${trackSvg(track.polyline)}` : ""}
    <h3>Streams <span class="muted">(${a.channels.join(", ") || "none"})</span></h3>
    ${st.hr ? lineChart(st.hr, st.time, "Heart rate", "#d93f3f") : ""}
    ${st.speed ? lineChart(st.speed.map((v) => (v == null ? null : v * 3.6)), st.time, "Speed km/h", "#0a66c2") : ""}
    ${st.power ? lineChart(st.power, st.time, "Power W", "#8a4fd8") : ""}
    ${st.cadence ? lineChart(st.cadence, st.time, "Cadence", "#2e9e5b") : ""}
    ${st.altitude ? lineChart(st.altitude, st.time, "Altitude m", "#9a6700") : ""}
    ${st.respiration ? lineChart(st.respiration, st.time, "Respiration /min", "#2b8ca3") : ""}
    ${a.laps.length ? `<h3>Laps (${a.laps.length})</h3><div class="scroll"><table>
      <thead><tr><th>#</th><th class="num">Distance</th><th class="num">Time</th><th class="num">Pace</th>
        <th class="num">HR</th><th class="num">Power</th><th class="num">Cadence</th><th>Intensity</th></tr></thead>
      <tbody>${a.laps.map((l) => `<tr><td>${l.idx + 1}</td><td class="num">${km(l.distance_m)}</td>
        <td class="num">${dur(l.timer_s)}</td><td class="num">${l.distance_m ? pace(l.avg_speed) : "–"}</td>
        <td class="num">${l.avg_hr ?? "–"}</td><td class="num">${l.avg_power ?? "–"}</td>
        <td class="num">${l.avg_cadence ? Math.round(l.avg_cadence) : "–"}</td><td>${esc(l.intensity ?? "")}</td></tr>`).join("")}
      </tbody></table></div>` : ""}
    <h3>Source files</h3>
    <ul>${a.files.map((f) => `<li>${esc(f.rel_path)}${f.zip_member ? " › " + esc(f.zip_member) : ""} — ${f.status}</li>`).join("")}</ul>`;
  document.getElementById("type").onchange = async (e) => {
    await api("activities/" + id, { method: "PATCH", body: JSON.stringify({ type: e.target.value }) });
    renderActivity(id);
  };
  document.getElementById("del").onclick = async () => {
    if (!confirm("Delete this activity from the database? The FIT file is not touched and will not be imported again unless you remove it from the import history.")) return;
    await api("activities/" + id, { method: "DELETE" });
    location.hash = "#/activities";
  };
}

// ---- Import manager ----------------------------------------------------------------

let importTimer = null;
const PAGE = 100;

// UTC timestamp -> "YYYY-MM-DD HH:MM" in the browser's time zone.
const fitDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function fileContent(f) {
  if (f.activity_id && f.status !== "duplicate") {
    const a = { start_time_utc: f.start_time_utc, utc_offset_s: f.utc_offset_s };
    return `<a href="#/activity/${f.activity_id}">${esc(f.name || typeLabel(f.activity_type))}</a>
      <span class="muted">${esc(typeLabel(f.activity_type))} · ${localTime(a)}</span>`;
  }
  if (f.status === "duplicate" && f.activity_id) {
    return `duplicate of <a href="#/activity/${f.activity_id}">activity ${f.activity_id}</a>`;
  }
  const what = f.skip_reason || f.fit_type || "";
  const err = f.error ? ` <span class="bad">${esc(f.error)}</span>` : "";
  return `${esc(what)} <span class="muted">${fitDate(f.fit_created)}</span>${err}`;
}

async function renderImport(params) {
  clearTimeout(importTimer);
  const status = params.status || "";
  const sort = params.sort || "processed";
  const page = Math.max(0, parseInt(params.page || "0", 10));
  const query = { limit: PAGE, offset: page * PAGE, sort };
  if (status) query.status = status;
  if (params.q) query.q = params.q;
  const [st, files] = await Promise.all([
    api("import/status"), api("import/files?" + new URLSearchParams(query)),
  ]);
  const p = st.progress;
  const progress = st.running || p.state === "running"
    ? `<span class="warn">Running: ${esc(p.phase || "")} ${p.done ?? 0}/${p.total ?? "?"}</span>`
    : p.state === "failed" ? `<span class="bad">Last run failed: ${esc(p.error)}</span>`
    : p.state === "finished" ? `Last run ${esc(p.finished_at)}: ${p.scanned} files checked, ${p.imported} imported, ${p.skipped} skipped, ${p.duplicates} duplicates, ${p.errors} errors, ${p.missing} missing`
    : "No import yet";
  const statuses = ["", "new", "imported", "skipped", "duplicate", "error", "missing", "removed"];
  const pages = Math.max(1, Math.ceil(files.total / PAGE));
  const link = (changes) => "#/import?" + new URLSearchParams(
    Object.fromEntries(Object.entries({ ...params, ...changes }).filter(([, v]) => v !== "" && v != null)));
  view.innerHTML = `
    <h2>Import</h2>
    <p>Root folder: <code>${esc(st.root || "not set — start the server with --root")}</code></p>
    <p>${progress} <button id="scan" ${st.running ? "disabled" : ""}>Check folder for new files</button></p>
    <p>${Object.entries(st.files).map(([k, v]) => `<a href="${link({ status: k, page: 0 })}">${k}: ${v}</a>`).join(" · ")}
      ${st.missing_to_review ? ` · <span class="warn">${st.missing_to_review} missing file(s) to review</span>` : ""}</p>
    <div class="filters">
      <select id="f-status">${statuses.map((s) =>
        `<option value="${s}" ${s === status ? "selected" : ""}>${s || "All statuses"}</option>`).join("")}</select>
      <select id="f-sort">
        <option value="processed" ${sort === "processed" ? "selected" : ""}>Newest processed first</option>
        <option value="recorded" ${sort === "recorded" ? "selected" : ""}>Newest recorded first</option>
        <option value="path" ${sort === "path" ? "selected" : ""}>File name</option>
      </select>
      <input id="f-q" placeholder="Search file name or FIT id" value="${esc(params.q || "")}">
      <span class="muted">${files.total} file(s) · page ${page + 1}/${pages}</span>
      ${page > 0 ? `<a href="${link({ page: page - 1 })}">← prev</a>` : ""}
      ${page + 1 < pages ? `<a href="${link({ page: page + 1 })}">next →</a>` : ""}
    </div>
    <div class="scroll"><table>
      <thead><tr><th>Status</th><th>File</th><th>Person</th><th>Activity / content</th>
        <th>FIT id</th><th>Processed</th><th></th></tr></thead>
      <tbody>${files.items.map((f) => `<tr>
        <td class="${f.status === "error" ? "bad" : f.status === "missing" ? "warn" : ""}">${f.status}${
          f.status === "missing" && f.prev_status ? ` <span class="muted">(was ${f.prev_status})</span>` : ""}</td>
        <td class="wrap">${esc(f.rel_path)}${f.zip_member ? " › " + esc(f.zip_member) : ""}</td>
        <td>${esc(f.person_id)}</td>
        <td class="wrap">${fileContent(f)}${f.status === "missing" ? ` <span class="muted">missing since ${fitDate(f.missing_since)}${f.dismissed ? ", reviewed" : ""}</span>` : ""}</td>
        <td><code>${esc(f.fit_uid || "–")}</code></td>
        <td>${f.imported_at ? fitDate(f.imported_at) : "–"}</td>
        <td>${f.status === "error" ? `<button data-retry="${f.id}">Retry</button>` : ""}
          ${f.status === "missing" && !f.dismissed ? `<button data-keep="${f.id}">Keep data</button>` : ""}
          ${f.status === "missing" && f.activity_id ? `<button data-del="${f.activity_id}" class="bad">Delete activity</button>` : ""}
          <button data-forget="${f.id}" data-owner="${f.status === "imported" || f.prev_status === "imported" ? 1 : 0}"
            title="Remove from import history; the next scan imports the file again">Remove from history</button></td>
      </tr>`).join("")}</tbody></table></div>`;
  const reload = () => renderImport(params);
  document.getElementById("scan").onclick = async () => { await api("import/scan", { method: "POST" }).catch((e) => alert(e.message)); reload(); };
  document.getElementById("f-status").onchange = (e) => { location.hash = link({ status: e.target.value, page: 0 }); };
  document.getElementById("f-sort").onchange = (e) => { location.hash = link({ sort: e.target.value, page: 0 }); };
  document.getElementById("f-q").onchange = (e) => { location.hash = link({ q: e.target.value, page: 0 }); };
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
  if (st.running) importTimer = setTimeout(reload, 2000);
}

// ---- People & types ----------------------------------------------------------------

async function renderPeople() {
  const persons = await api("persons");
  view.innerHTML = `<h2>People</h2><p class="muted">Each subfolder of the root folder is one person.
    The folder name is the id; the label is what the app shows.</p>
    <table><thead><tr><th>Folder (id)</th><th>Label</th><th class="num">Activities</th></tr></thead>
    <tbody>${persons.map((p) => `<tr><td>${esc(p.id)}</td>
      <td><input data-id="${esc(p.id)}" value="${esc(p.label)}"></td>
      <td class="num">${p.activities}</td></tr>`).join("")}</tbody></table>`;
  view.querySelectorAll("input[data-id]").forEach((inp) => inp.onchange = () =>
    api("persons/" + encodeURIComponent(inp.dataset.id), {
      method: "PATCH", body: JSON.stringify({ label: inp.value }),
    }).catch(alert));
}

function renderTypes() {
  view.innerHTML = `<h2>Activity groups and types</h2>` + TYPES.groups.map((g) => `
    <h3>${esc(g.en)} <span class="muted">/ ${esc(g.pl)} · ${g.key}</span></h3>
    <table><tbody>${TYPES.types.filter((t) => t.group === g.key).map((t) =>
      `<tr><td>${t.key}</td><td>${esc(t.en)}</td><td>${esc(t.pl)}</td><td class="muted">${t.indoor ? "indoor" : ""}</td></tr>`).join("")}
    </tbody></table>`).join("");
}

// ---- Router ------------------------------------------------------------------------

async function route() {
  clearTimeout(importTimer);
  TYPES ??= await api("types");
  const [path, query] = (location.hash.slice(1) || "/activities").split("?");
  const params = Object.fromEntries(new URLSearchParams(query || ""));
  const parts = path.split("/").filter(Boolean);
  try {
    if (parts[0] === "activity") await renderActivity(parts[1]);
    else if (parts[0] === "import") await renderImport(params);
    else if (parts[0] === "people") await renderPeople();
    else if (parts[0] === "types") renderTypes();
    else await renderActivities(params);
  } catch (e) {
    view.innerHTML = `<p class="bad">Error: ${esc(e.message)}</p>`;
  }
}

window.addEventListener("hashchange", route);
route();
