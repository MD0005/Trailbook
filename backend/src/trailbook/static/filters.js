// Shared filters of every tab (SPEC §10, Filters): first Time, then Type. Each is a badge
// with its own panel; nothing changes until Apply. URL parameters: from / to (local days,
// inclusive, omitted at the ends of the data), last (1m, 3m, 6m, ytd, 1y: up to today), years
// (comma list) and types (comma list of type keys).
"use strict";

let TIME_RANGE = { first: null, last: null, years: [] }; // of the selected person, see route()

const DAY = 86400000;
const toDay = (iso) => Date.parse(iso + "T00:00:00Z");
const fromDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const todayDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// The slider runs from the first activity to today.
function timeBounds() {
  const last = todayDay();
  const first = TIME_RANGE.first && TIME_RANGE.first < last ? TIME_RANGE.first : last;
  return { first, last, n: Math.round((toDay(last) - toDay(first)) / DAY) };
}

// Time filter, three kinds (only one at a time): `last` - a period up to today, kept relative
// (1m, 3m, 6m, ytd, 1y); `years` - any years, also with gaps (comma list); `from` / `to` - a
// range of your own (the slider or typed dates).
const LAST_PERIODS = [["1m", "1 month", "Last month"], ["3m", "3 months", "Last 3 months"], ["6m", "6 months", "Last 6 months"],
  ["ytd", "YTD", "Year to date"], ["1y", "1 year", "Last 12 months"], ["2y", "2 years", "Last 2 years"]];
const timeActive = (params) => Boolean(params.from || params.to || params.last || params.years);
const yearList = (params) => [...new Set((params.years || "").split(",").filter((y) => /^\d{4}$/.test(y)))].sort();
// First day of a `last` period (as the server counts it): months back from today, ytd from 1 January.
function lastSince(key, today = todayDay()) {
  if (key === "ytd") return `${today.slice(0, 4)}-01-01`;
  const n = { "1m": 1, "3m": 3, "6m": 6, "1y": 12, "2y": 24 }[key];
  if (!n) return null;
  const [y, m, d] = today.split("-").map(Number);
  const t = y * 12 + (m - 1) - n, ny = Math.floor(t / 12), nm = (t % 12) + 1;
  const nd = Math.min(d, new Date(Date.UTC(ny, nm, 0)).getUTCDate());
  return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}
// Years as a label: "2025", "2023–2025" (side by side), "2023, 2025", "4 years".
function yearsLabel(ys) {
  if (ys.length === 1) return ys[0];
  const together = ys.every((y, i) => !i || +y === +ys[i - 1] + 1);
  if (together) return `${ys[0]}–${ys[ys.length - 1]}`;
  return ys.length <= 3 ? ys.join(", ") : `${ys.length} years`;
}

function timeLabel(params) {
  const last = LAST_PERIODS.find(([k]) => k === params.last);
  if (last) return last[2];
  const ys = yearList(params);
  if (ys.length) return yearsLabel(ys);
  if (!params.from && !params.to) return "All time";
  const { first, last: end } = timeBounds();
  const a = !params.from || params.from < first ? first : params.from;
  const b = !params.to || params.to > end ? end : params.to;
  const y = a.slice(0, 4);
  const yearFrom = `${y}-01-01` < first ? first : `${y}-01-01`, yearTo = `${y}-12-31` > end ? end : `${y}-12-31`;
  if (a === yearFrom && b === yearTo) return y;
  return a === first && b === end ? "All time" : `${a} – ${b}`;
}

function typeSelection(params) {
  const raw = (params.types ?? params.type ?? "").split(",").filter(Boolean);
  const out = new Set();
  for (const v of raw) {
    if (v.startsWith("g:")) TYPES.types.filter((t) => t.group === v.slice(2)).forEach((t) => out.add(t.key));
    else out.add(v);
  }
  return out;
}

function typeLabelOf(params, counts = TYPE_COUNTS) {
  const sel = [...typeSelection(params)];
  if (!sel.length) return "All";
  const groups = [...new Set(sel.map((k) => typeOf(k)?.group))];
  if (groups.length === 1) {
    const avail = TYPES.types.filter((t) => t.group === groups[0] && (counts[t.key] || sel.includes(t.key)));
    if (avail.length > 1 && avail.every((t) => sel.includes(t.key))) return groupLabel(groups[0]);
  }
  return sel.length <= 2 ? sel.map(typeLabel).join(", ") : `${sel.length} types`;
}

const filterActions = (kind, active) => `<div class="panel-actions">
    ${active ? `<button class="ghost" data-fclear="${kind}">Clear filter</button>` : ""}
    <button class="primary" data-fapply="${kind}">Apply</button></div>`;

// ---- Time --------------------------------------------------------------------------------

function timeBadge(params) {
  const { first, n } = timeBounds();
  const lo = params.from ? Math.max(0, Math.min(n, Math.round((toDay(params.from) - toDay(first)) / DAY))) : 0;
  const hi = params.to ? Math.max(lo, Math.min(n, Math.round((toDay(params.to) - toDay(first)) / DAY))) : n;
  const years = [...TIME_RANGE.years].sort();
  const mode = LAST_PERIODS.some(([k]) => k === params.last) ? "last" : yearList(params).length ? "years" : params.from || params.to ? "custom" : "all";
  const panel = `<div class="tf" data-tf data-first="${first}" data-n="${n}" data-mode="${mode}" data-last="${esc(params.last || "")}" data-years="${esc(yearList(params).join(","))}">
      <div class="tf-slider" ${n ? "" : "hidden"}><div class="tf-track"><div class="tf-fill" data-tf-fill></div></div>
        <input type="range" class="tf-thumb" min="0" max="${n}" value="${lo}" data-tf-end="lo" aria-label="From">
        <input type="range" class="tf-thumb" min="0" max="${n}" value="${hi}" data-tf-end="hi" aria-label="To"></div>
      <div class="tf-values"><span data-tf-date="lo"></span><span data-tf-date="hi"></span></div>
      <div class="chips tf-last"><button class="chip" data-tf-last="">All time</button>${LAST_PERIODS.map(([k, l]) => `<button class="chip" data-tf-last="${k}">${l}</button>`).join("")}</div>
      <div class="chips tf-years">${years.map((y) => `<button class="chip" data-tf-year="${y}">${y}</button>`).join("")}</div>
      ${filterActions("time", timeActive(params))}</div>`;
  return badgeHtml("time", "Time", timeLabel(params), { panel, on: timeActive(params) });
}

// The panel: the first row is one choice (All time or a period up to today), the years can be
// several; the slider and typed dates make a range of your own. Choosing one kind clears the
// others. The slider shows the choice; years with a gap cannot be one range, so it shows their
// span greyed with the count.
function bindTimePanel(root) {
  const tf = root.querySelector("[data-tf]");
  if (!tf) return null;
  const first = toDay(tf.dataset.first), n = +tf.dataset.n;
  const inputs = { lo: tf.querySelector('[data-tf-end="lo"]'), hi: tf.querySelector('[data-tf-end="hi"]') };
  const state = { lo: +inputs.lo.value, hi: +inputs.hi.value, mode: tf.dataset.mode, last: tf.dataset.last,
    years: new Set(tf.dataset.years.split(",").filter(Boolean)) };
  const iso = (i) => fromDay(first + i * DAY);
  const index = (s) => Math.max(0, Math.min(n, Math.round((toDay(s) - first) / DAY)));
  const parts = (end) => datePartsHtml(iso(state[end]), end);
  const yearSpan = (y) => [index(`${y}-01-01`), index(`${y}-12-31`)];
  const sortedYears = () => [...state.years].sort();
  const gap = () => { const ys = sortedYears(); return ys.some((y, i) => i && +y !== +ys[i - 1] + 1); };
  // the slider follows a period or the years
  const follow = () => {
    if (state.mode === "last") [state.lo, state.hi] = [index(lastSince(state.last)), n];
    else if (state.mode === "years") { const ys = sortedYears(); [state.lo, state.hi] = [yearSpan(ys[0])[0], yearSpan(ys[ys.length - 1])[1]]; }
    else if (state.mode === "all") [state.lo, state.hi] = [0, n];
  };
  const paint = () => {
    inputs.lo.value = state.lo; inputs.hi.value = state.hi;
    const fill = tf.querySelector("[data-tf-fill]");
    fill.style.left = `${(state.lo / (n || 1)) * 100}%`;
    fill.style.width = `${((state.hi - state.lo) / (n || 1)) * 100}%`;
    const split = state.mode === "years" && gap();
    tf.querySelector(".tf-slider").classList.toggle("tf-split", split);
    tf.querySelector('[data-tf-date="lo"]').innerHTML = parts("lo");
    tf.querySelector('[data-tf-date="hi"]').innerHTML = split ? `${state.years.size} years selected` : parts("hi");
    tf.querySelectorAll("[data-tf-last]").forEach((c) => {
      const on = c.dataset.tfLast ? state.mode === "last" && state.last === c.dataset.tfLast : state.mode === "all";
      c.classList.toggle("on", on);
    });
    tf.querySelectorAll("[data-tf-year]").forEach((c) => c.classList.toggle("on", state.mode === "years" && state.years.has(c.dataset.tfYear)));
  };
  // a range of your own: the slider or a typed date
  const set = (end, i) => {
    i = Math.max(0, Math.min(n, i));
    state[end] = i;
    if (state.lo > state.hi) { if (end === "lo") state.hi = i; else state.lo = i; }
    state.mode = state.lo === 0 && state.hi === n ? "all" : "custom";
    state.years.clear(); state.last = "";
    paint();
  };
  inputs.lo.oninput = () => set("lo", +inputs.lo.value);
  inputs.hi.oninput = () => set("hi", +inputs.hi.value);
  // The thumb that is nearer the pointer takes the drag (both inputs overlap).
  tf.querySelector(".tf-slider").addEventListener("pointerdown", (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const at = ((e.clientX - r.left) / r.width) * n;
    const lower = Math.abs(at - state.lo) <= Math.abs(at - state.hi) && !(state.lo === state.hi && at > state.hi);
    inputs.lo.style.zIndex = lower ? 3 : 2;
    inputs.hi.style.zIndex = lower ? 2 : 3;
  });
  // first row: one choice; it clears the years and a range of your own
  tf.querySelectorAll("[data-tf-last]").forEach((c) => c.onclick = () => {
    state.last = c.dataset.tfLast; state.mode = state.last ? "last" : "all"; state.years.clear();
    follow(); paint();
  });
  // years: each on or off; they clear the first row and a range of your own
  tf.querySelectorAll("[data-tf-year]").forEach((c) => c.onclick = () => {
    const y = c.dataset.tfYear;
    if (state.mode !== "years") state.years.clear();
    if (state.years.has(y)) state.years.delete(y); else state.years.add(y);
    state.last = ""; state.mode = state.years.size ? "years" : "all";
    follow(); paint();
  });
  const edit = (part) => editDatePart(part, iso(state[part.dataset.end]), (s) => set(part.dataset.end, index(s)), paint);
  bindDateParts(tf, edit);
  if (state.mode === "years" || state.mode === "last") follow();
  paint();
  const none = { from: "", to: "", last: "", years: "" };
  return () => (state.mode === "last" ? { ...none, last: state.last }
    : state.mode === "years" ? { ...none, years: sortedYears().join(",") }
    : state.mode === "custom" ? { ...none, from: state.lo > 0 ? iso(state.lo) : "", to: state.hi < n ? iso(state.hi) : "" }
    : none);
}

// A date as three clickable numbers (year, month, day) of one end of a panel.
function datePartsHtml(iso, end) {
  const [y, m, d] = iso.split("-");
  const part = (which, v) => `<span class="tf-part" role="button" tabindex="0" data-end="${end}" data-part="${which}" title="Click to type">${v}</span>`;
  return `${part("y", y)}-${part("m", m)}-${part("d", d)}`;
}
function bindDateParts(root, edit) {
  root.addEventListener("click", (e) => { const p = e.target.closest(".tf-part"); if (p && !p.isContentEditable) edit(p); });
  root.addEventListener("keydown", (e) => { const p = e.target.closest(".tf-part"); if (p && !p.isContentEditable && e.key === "Enter") { e.preventDefault(); edit(p); } });
}
// A click on a number (year, month or day) makes it editable in place: type, Enter keeps it.
// `current` = the date now; `set(iso)` takes the new date, `repaint()` restores the old one.
function editDatePart(part, current, set, repaint) {
  const which = part.dataset.part;
  const before = part.textContent;
  part.contentEditable = "true";
  part.classList.add("editing");
  part.focus();
  const range = document.createRange();
  range.selectNodeContents(part);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    const [y, m, d] = current.split("-").map(Number);
    const v = parseInt(part.textContent.replace(/\D/g, ""), 10);
    if (save && Number.isFinite(v) && part.textContent.trim() !== before) {
      let ny = y, nm = m, nd = d;
      if (which === "y") ny = v; else if (which === "m") nm = Math.max(1, Math.min(12, v)); else nd = Math.max(1, v);
      nd = Math.min(nd, new Date(Date.UTC(ny, nm, 0)).getUTCDate());
      set(`${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`);
    } else repaint();
  };
  part.onkeydown = (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); commit(true); }
    else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); commit(false); }
    else if (ev.key.length === 1 && !/\d/.test(ev.key)) ev.preventDefault(); // digits only
  };
  part.onblur = () => commit(true);
}

// ---- Go to (Calendar) ------------------------------------------------------------------------

// One date from the first activity to today: slider, the date as editable numbers, Today and
// the years. Apply calls `go(iso)`.
function gotoBadge(current) {
  const { first, n } = timeBounds();
  const i = current ? Math.max(0, Math.min(n, Math.round((toDay(current) - toDay(first)) / DAY))) : n;
  const years = [...TIME_RANGE.years].sort().reverse();
  const panel = `<div class="tf" data-goto data-first="${first}" data-n="${n}">
      <div class="tf-slider" ${n ? "" : "hidden"}><div class="tf-track"><div class="tf-fill" data-tf-fill></div></div>
        <input type="range" class="tf-thumb" min="0" max="${n}" value="${i}" data-goto-range aria-label="Date"></div>
      <div class="tf-values"><span data-goto-date></span></div>
      <div class="chips tf-years"><button class="chip" data-goto-year="">Today</button>${years.map((y) => `<button class="chip" data-goto-year="${y}">${y}</button>`).join("")}</div>
      <div class="panel-actions"><button class="primary" data-goto-apply>Go</button></div></div>`;
  return badgeHtml("goto", "Go to", "", { panel });
}

function bindGotoPanel(root, go) {
  const box = root.querySelector("[data-goto]");
  if (!box) return;
  const first = toDay(box.dataset.first), n = +box.dataset.n;
  const input = box.querySelector("[data-goto-range]");
  let at = +input.value;
  const iso = () => fromDay(first + at * DAY);
  const paint = () => {
    input.value = at;
    box.querySelector("[data-tf-fill]").style.width = `${(at / (n || 1)) * 100}%`;
    box.querySelector("[data-goto-date]").innerHTML = datePartsHtml(iso(), "at");
    box.querySelectorAll("[data-goto-year]").forEach((c) => {
      const y = c.dataset.gotoYear;
      c.classList.toggle("on", y ? iso() === yearEnd(y) : at === n);
    });
  };
  // a year: its last day (the calendar shows the newest week on top), this year: today
  const yearEnd = (y) => { const e = `${y}-12-31`; return e > fromDay(first + n * DAY) ? fromDay(first + n * DAY) : e; };
  const set = (s) => { at = Math.max(0, Math.min(n, Math.round((toDay(s) - first) / DAY))); paint(); };
  input.oninput = () => { at = +input.value; paint(); };
  box.querySelectorAll("[data-goto-year]").forEach((c) => c.onclick = () => (c.dataset.gotoYear ? set(yearEnd(c.dataset.gotoYear)) : set(fromDay(first + n * DAY))));
  bindDateParts(box, (part) => editDatePart(part, iso(), set, paint));
  box.querySelector("[data-goto-apply]").onclick = () => go(iso());
  paint();
}

// ---- Type --------------------------------------------------------------------------------

// `counts` ({type: n}) limits the list to the types a page actually covers (default: all
// activities of the person).
function typeBadge(params, counts = TYPE_COUNTS) {
  const sel = typeSelection(params);
  const n = (k) => counts[k] || 0;
  const groups = TYPES.groups.map((g) => {
    const types = TYPES.types.filter((t) => t.group === g.key && (n(t.key) > 0 || sel.has(t.key)));
    if (!types.length) return "";
    const total = types.reduce((s, t) => s + n(t.key), 0);
    const item = (t) => `<label class="tyf-item"><input type="checkbox" data-tyf="${t.key}" ${sel.has(t.key) ? "checked" : ""}>${typeIcon(t.key)}<span>${esc(t.en)}</span><small>${num(n(t.key))}</small></label>`;
    const head = types.length > 1
      ? `<label class="tyf-head"><input type="checkbox" data-tyf-all="${g.key}"><span>${esc(g.en)}</span><small>${num(total)}</small></label>`
      : `<div class="tyf-head plain"><span>${esc(g.en)}</span></div>`;
    return `<div class="tyf-group" data-tyf-g="${g.key}">${head}${types.map(item).join("")}</div>`;
  }).join("");
  const panel = `<div class="tyf">${groups ? `<div class="tyf-list">${groups}</div>` : hint("No activities yet.")}
    ${filterActions("type", sel.size > 0)}</div>`;
  return badgeHtml("type", "Type", typeLabelOf(params, counts), { panel, on: sel.size > 0 });
}

function bindTypePanel(root) {
  const box = root.querySelector(".tyf");
  if (!box) return null;
  const sync = () => box.querySelectorAll("[data-tyf-all]").forEach((all) => {
    const items = [...box.querySelectorAll(`[data-tyf-g="${all.dataset.tyfAll}"] [data-tyf]`)];
    const on = items.filter((i) => i.checked).length;
    all.checked = on === items.length;
    all.indeterminate = on > 0 && on < items.length;
  });
  box.addEventListener("change", (e) => {
    if (e.target.dataset.tyfAll) {
      box.querySelectorAll(`[data-tyf-g="${e.target.dataset.tyfAll}"] [data-tyf]`).forEach((i) => { i.checked = e.target.checked; });
    }
    sync();
  });
  sync();
  return () => {
    const all = [...box.querySelectorAll("[data-tyf]")];
    const on = all.filter((i) => i.checked).map((i) => i.dataset.tyf);
    return { types: on.length === all.length ? "" : on.join(",") };
  };
}

// ---- Training type (activities page) -------------------------------------------------------

// URL parameter `workouts`: comma list of training type keys, "none" = no training type.
// `counts` ({key: n}) from the activities API, under the other filters.
const workoutSelection = (params) => new Set((params.workouts || "").split(",").filter(Boolean));
const workoutName = (k) => (k === "none" ? "Not set" : workoutLabel(k));

function workoutBadge(params, counts = {}) {
  const sel = workoutSelection(params);
  const keys = [...(TYPES.workouts || []).map((w) => w.key), "none"].filter((k) => counts[k] || sel.has(k));
  const item = (k) => `<label class="tyf-item"><input type="checkbox" data-wkf="${k}" ${sel.has(k) ? "checked" : ""}><span>${esc(workoutName(k))}</span><small>${num(counts[k] || 0)}</small></label>`;
  const panel = `<div class="tyf wkf">${keys.length ? `<div class="tyf-list"><div class="tyf-group">${keys.map(item).join("")}</div></div>` : hint("No activities yet.")}
    ${filterActions("workout", sel.size > 0)}</div>`;
  const label = !sel.size ? "All" : sel.size <= 2 ? [...sel].map(workoutName).join(", ") : `${sel.size} types`;
  return badgeHtml("workout", "Training type", esc(label), { panel, on: sel.size > 0 });
}

function bindWorkoutPanel(root) {
  const box = root.querySelector(".wkf");
  if (!box) return null;
  return () => {
    const all = [...box.querySelectorAll("[data-wkf]")];
    const on = all.filter((i) => i.checked).map((i) => i.dataset.wkf);
    return { workouts: on.length === all.length ? "" : on.join(",") };
  };
}

// ---- wiring ------------------------------------------------------------------------------

// Apply / Clear of the Time and Type panels: navigate to `route` with the other parameters
// kept. `drop` lists older parameters the new ones replace (year, type, range, page, …).
// `allTime`: the page has a default period, so All time is kept as `last=<allTime>`.
function bindFilterBadges(root, route, params, { drop = [], allTime = null } = {}) {
  const readers = { time: bindTimePanel(root), type: bindTypePanel(root), workout: bindWorkoutPanel(root) };
  const old = ["page", "year", "type", "range", ...drop];
  const go = (changes) => {
    const next = { ...params, ...changes };
    old.forEach((k) => delete next[k]);
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== "" && v != null));
    location.hash = route + (Object.keys(clean).length ? "?" + new URLSearchParams(clean) : "");
  };
  root.querySelectorAll("[data-fapply]").forEach((b) => b.onclick = () => {
    const read = readers[b.dataset.fapply];
    if (!read) return;
    const v = read();
    if (allTime && b.dataset.fapply === "time" && !v.from && !v.to && !v.last && !v.years) v.last = allTime;
    go(v);
  });
  root.querySelectorAll("[data-fclear]").forEach((b) => b.onclick = () => {
    go({ time: { from: "", to: "", last: allTime || "", years: "" }, type: { types: "" }, workout: { workouts: "" } }[b.dataset.fclear]);
  });
}

// Query parameters for the API from the page parameters.
function filterQuery(params) {
  const q = {};
  for (const k of ["from", "to", "last", "years", "types", "workouts"]) if (params[k]) q[k] = params[k];
  if (q.last === "all") delete q.last; // All time on a page with a default period
  if (!q.types && params.type) q.types = params.type; // older links
  return q;
}

// Older server without /api/time-range: the first activity from the activities totals.
async function timeRangeFallback() {
  const who = CURRENT && CURRENT !== "all" ? { person: CURRENT } : {};
  const t = (await api("activities?" + new URLSearchParams({ ...who, limit: 1 })).catch(() => null))?.totals || {};
  const first = t.first ? t.first.slice(0, 10) : null, last = t.last ? t.last.slice(0, 10) : null;
  const years = [];
  if (first) for (let y = +last.slice(0, 4); y >= +first.slice(0, 4); y--) years.push(String(y));
  return { first, last, years };
}
