// Shared filters of every tab (SPEC §10, Filters): first Time, then Type. Each is a badge
// with its own panel; nothing changes until Apply. URL parameters: from / to (local days,
// inclusive, omitted at the ends of the data) and types (comma list of type keys).
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

function timeLabel(params) {
  if (!params.from && !params.to) return "All time";
  const { first, last } = timeBounds();
  const a = !params.from || params.from < first ? first : params.from;
  const b = !params.to || params.to > last ? last : params.to;
  const y = a.slice(0, 4);
  const yearFrom = `${y}-01-01` < first ? first : `${y}-01-01`, yearTo = `${y}-12-31` > last ? last : `${y}-12-31`;
  if (a === yearFrom && b === yearTo) return y;
  return a === first && b === last ? "All time" : `${a} – ${b}`;
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
  const { first, last, n } = timeBounds();
  const lo = params.from ? Math.max(0, Math.min(n, Math.round((toDay(params.from) - toDay(first)) / DAY))) : 0;
  const hi = params.to ? Math.max(lo, Math.min(n, Math.round((toDay(params.to) - toDay(first)) / DAY))) : n;
  const years = [...TIME_RANGE.years].sort();
  const panel = `<div class="tf" data-tf data-first="${first}" data-n="${n}">
      <div class="tf-slider" ${n ? "" : "hidden"}><div class="tf-track"><div class="tf-fill" data-tf-fill></div></div>
        <input type="range" class="tf-thumb" min="0" max="${n}" value="${lo}" data-tf-end="lo" aria-label="From">
        <input type="range" class="tf-thumb" min="0" max="${n}" value="${hi}" data-tf-end="hi" aria-label="To"></div>
      <div class="tf-values"><span data-tf-date="lo"></span><span data-tf-date="hi"></span></div>
      <div class="chips tf-years"><button class="chip" data-tf-year="">All time</button>${years.map((y) => `<button class="chip" data-tf-year="${y}">${y}</button>`).join("")}</div>
      ${filterActions("time", Boolean(params.from || params.to))}</div>`;
  return badgeHtml("time", "Time", timeLabel(params), { panel, on: Boolean(params.from || params.to) });
}

function bindTimePanel(root) {
  const tf = root.querySelector("[data-tf]");
  if (!tf) return null;
  const first = toDay(tf.dataset.first), n = +tf.dataset.n;
  const inputs = { lo: tf.querySelector('[data-tf-end="lo"]'), hi: tf.querySelector('[data-tf-end="hi"]') };
  const state = { lo: +inputs.lo.value, hi: +inputs.hi.value };
  const iso = (i) => fromDay(first + i * DAY);
  const index = (s) => Math.round((toDay(s) - first) / DAY);
  const parts = (end) => {
    const [y, m, d] = iso(state[end]).split("-");
    const part = (which, v) => `<span class="tf-part" role="button" tabindex="0" data-end="${end}" data-part="${which}" title="Click to type">${v}</span>`;
    return `${part("y", y)}-${part("m", m)}-${part("d", d)}`;
  };
  const paint = () => {
    inputs.lo.value = state.lo; inputs.hi.value = state.hi;
    const fill = tf.querySelector("[data-tf-fill]");
    fill.style.left = `${(state.lo / (n || 1)) * 100}%`;
    fill.style.width = `${((state.hi - state.lo) / (n || 1)) * 100}%`;
    tf.querySelector('[data-tf-date="lo"]').innerHTML = parts("lo");
    tf.querySelector('[data-tf-date="hi"]').innerHTML = parts("hi");
    tf.querySelectorAll("[data-tf-year]").forEach((c) => {
      const y = c.dataset.tfYear;
      const [a, b] = y ? yearSpan(y) : [0, n];
      c.classList.toggle("on", state.lo === a && state.hi === b);
    });
  };
  const yearSpan = (y) => [Math.max(0, index(`${y}-01-01`)), Math.min(n, index(`${y}-12-31`))];
  const set = (end, i) => {
    i = Math.max(0, Math.min(n, i));
    state[end] = i;
    if (state.lo > state.hi) { if (end === "lo") state.hi = i; else state.lo = i; }
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
  tf.querySelectorAll("[data-tf-year]").forEach((c) => c.onclick = () => {
    const y = c.dataset.tfYear;
    [state.lo, state.hi] = y ? yearSpan(y) : [0, n];
    paint();
  });
  // A click on a number (year, month or day) makes it editable in place: type, Enter keeps it.
  const edit = (part) => {
    const { end, part: which } = part.dataset;
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
      const [y, m, d] = iso(state[end]).split("-").map(Number);
      const v = parseInt(part.textContent.replace(/\D/g, ""), 10);
      if (save && Number.isFinite(v) && part.textContent.trim() !== before) {
        let ny = y, nm = m, nd = d;
        if (which === "y") ny = v; else if (which === "m") nm = Math.max(1, Math.min(12, v)); else nd = Math.max(1, v);
        nd = Math.min(nd, new Date(Date.UTC(ny, nm, 0)).getUTCDate());
        set(end, index(`${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`));
      } else paint();
    };
    part.onkeydown = (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); commit(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); commit(false); }
      else if (ev.key.length === 1 && !/\d/.test(ev.key)) ev.preventDefault(); // digits only
    };
    part.onblur = () => commit(true);
  };
  tf.addEventListener("click", (e) => { const p = e.target.closest(".tf-part"); if (p && !p.isContentEditable) edit(p); });
  tf.addEventListener("keydown", (e) => { const p = e.target.closest(".tf-part"); if (p && !p.isContentEditable && e.key === "Enter") { e.preventDefault(); edit(p); } });
  paint();
  return () => ({ from: state.lo > 0 ? iso(state.lo) : "", to: state.hi < n ? iso(state.hi) : "" });
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

// ---- wiring ------------------------------------------------------------------------------

// Apply / Clear of the Time and Type panels: navigate to `route` with the other parameters
// kept. `drop` lists older parameters the new ones replace (year, type, range, page, …).
function bindFilterBadges(root, route, params, { drop = [] } = {}) {
  const readers = { time: bindTimePanel(root), type: bindTypePanel(root) };
  const old = ["page", "year", "type", "range", ...drop];
  const go = (changes) => {
    const next = { ...params, ...changes };
    old.forEach((k) => delete next[k]);
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== "" && v != null));
    location.hash = route + (Object.keys(clean).length ? "?" + new URLSearchParams(clean) : "");
  };
  root.querySelectorAll("[data-fapply]").forEach((b) => b.onclick = () => {
    const read = readers[b.dataset.fapply];
    if (read) go(read());
  });
  root.querySelectorAll("[data-fclear]").forEach((b) => b.onclick = () => {
    go(b.dataset.fclear === "time" ? { from: "", to: "" } : { types: "" });
  });
}

// Query parameters for the API from the page parameters.
function filterQuery(params) {
  const q = {};
  for (const k of ["from", "to", "types"]) if (params[k]) q[k] = params[k];
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
