// Technical preview UI. Plain JS, no build step, no external requests.
// All API URLs are relative so the page works behind Home Assistant Ingress.
//
// Style rules (see preview.css): every section is a .card; descriptions use .hint;
// states (next scan, saved, running, errors) use .state (+ .ok/.warn/.bad/.muted).
// Numbers are always shown with their unit.
"use strict";

const view = document.getElementById("view");
let TYPES = null;
let TYPE_COUNTS = {}; // activity type → number of activities of the selected person
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

// Accent colours (light theme, dark theme). Chosen in Settings › General.
const ACCENTS = [
  ["sky", "Sky", "#0284c7", "#38bdf8"], ["teal", "Teal", "#0f766e", "#3fb5a0"],
  ["indigo", "Indigo", "#4f46e5", "#8b93ff"], ["violet", "Violet", "#7c3aed", "#a78bfa"],
  ["rose", "Rose", "#e11d48", "#fb7185"], ["amber", "Amber", "#b45309", "#fbbf24"],
  ["green", "Green", "#15803d", "#4ade80"], ["graphite", "Graphite", "#334155", "#cbd5e1"],
];
// Width of the vertical scrollbar, so full-screen pages (no gutter) line up with others.
(function measureScrollbar() {
  const d = document.createElement("div");
  d.style.cssText = "position:absolute;top:-999px;width:100px;height:100px;overflow:scroll";
  document.documentElement.appendChild(d);
  document.documentElement.style.setProperty("--sbw", `${d.offsetWidth - d.clientWidth}px`);
  d.remove();
})();

function applyAccent() {
  const a = ACCENTS.find(([k]) => k === store.get("accent")) || ACCENTS[0];
  const dark = document.documentElement.dataset.theme === "dark";
  const st = document.documentElement.style;
  st.setProperty("--accent", dark ? a[3] : a[2]);
  st.setProperty("--state", dark ? a[3] : a[2]);
  st.setProperty("--accent-fg", dark ? "#0f1115" : "#ffffff");
}

const PERSON_ICONS = ["", "🏃", "🚴", "🏊", "🥾", "⛷️", "🧘", "🧗", "🐺", "🦊", "🐻", "🐼", "🦁", "🐸", "🐧", "🦄", "⭐", "🔥"];
const PERSON_COLORS = ["#0f766e", "#e8590c", "#7048e8", "#d6336c", "#2b8a3e", "#f59f00", "#1c7ed6", "#495057"];

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
// Activity type icons (assets/icons, “Trailbook B”): small next to names in lists and
// filters, larger only in Activities › tiles. Unknown types fall back to “other”.
const typeIcon = (key, size = 18) => (window.TrailbookIcons ? TrailbookIcons.render(key, { size }) : "");
const typeName = (key, text = typeLabel(key), size = 18) =>
  `<span class="tb-activity-name">${typeIcon(key, size)}<span>${esc(text)}</span></span>`;
// Group rows use the icon of the group's main type (run, ride, swim, …) when there is one.
const groupIcon = (g, size = 18) => typeIcon(window.TrailbookIcons?.keys?.includes(g) ? g : (TYPES.types.find((t) => t.group === g)?.key || "other"), size);
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
  { key: "heatmap", label: "Map" },
  { key: "fitness", label: "Fitness", single: true },
  { key: "wellbeing", label: "Wellbeing", single: true },
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
    const dark = document.documentElement.dataset.theme === "dark";
    btn.innerHTML = dark ? ICON.sun : ICON.moon;
    btn.title = dark ? "Switch to light theme" : "Switch to dark theme";
  };
  btn.onclick = () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("theme", next);
    applyAccent();
    paint();
  };
  paint();
}

// ---- generic table: sortable header + filter row ------------------------------------

const PAGE_SIZE = 50;
let observers = [];
function stopObservers() { observers.forEach((o) => o.disconnect()); observers = []; }
const countText = (shown, total) => (shown < total ? `${num(shown)} of ${num(total)}` : `${num(total)} row(s)`);

function rowHtml(columns, r) {
  return `<tr>${columns.map((c) => `<td class="${c.num ? "num" : ""} ${c.wrap ? "wrap" : ""} ${c.cls || ""}">${c.render(r)}</td>`).join("")}</tr>`;
}

function listBar(columns, params, shown, total) {
  const filtered = columns.some((c) => c.filter && params[c.key]);
  return "";
}

function tableHtml(columns, rows, params, total) {
  const sort = params.sort, dir = params.dir || "desc";
  const head = columns.map((c) => {
    if (!c.sort) return `<th class="${c.num ? "num" : ""}">${esc(c.label)}</th>`;
    const active = sort === c.key;
    const arrow = active ? (dir === "asc" ? "▲" : "▼") : "↕";
    return `<th class="${c.num ? "num" : ""}"><a href="#" class="sort ${active ? "active" : ""}" data-sort="${c.key}">${esc(c.label)} <span class="arrow">${arrow}</span></a></th>`;
  }).join("");
  const filters = columns.map((c) => (c.filter ? `<th>${filterControl(c, params)}</th>` : "<th></th>")).join("");
  const body = rows.length ? rows.map((r) => rowHtml(columns, r)).join("")
    : `<tr><td colspan="${columns.length}" class="hint">Nothing matches the filters.</td></tr>`;
  return listBar(columns, params, rows.length, total) + `
    <div class="scroll"><table class="data">
      <thead><tr>${head}</tr><tr class="filters-row">${filters}</tr></thead>
      <tbody data-rows>${body}</tbody></table></div>
    ${rows.length < total ? `<div class="sentinel" data-sentinel><span class="hint">Loading…</span></div>` : ""}`;
}

// Rows are loaded 50 at a time when the end of the list scrolls into view.
function infinite(root, loaded, total, fetchPage, append) {
  const sentinel = root.querySelector("[data-sentinel]");
  if (!sentinel) return;
  const counter = root.querySelector("[data-count]");
  let count = loaded, busy = false;
  const obs = new IntersectionObserver(async (entries) => {
    if (busy || !entries.some((e) => e.isIntersecting)) return;
    busy = true;
    try {
      const items = await fetchPage(count);
      append(items);
      count = items.length ? count + items.length : total;
      if (counter) counter.textContent = countText(Math.min(count, total), total);
    } finally { busy = false; }
    if (count >= total) { obs.disconnect(); sentinel.remove(); return; }
    obs.unobserve(sentinel); obs.observe(sentinel); // still visible? load the next page too
  }, { rootMargin: "600px" });
  obs.observe(sentinel);
  observers.push(obs);
}

// Dropdown of activity types with icons. Carries its value in a hidden input with the
// same data-filter / data-pfilter attribute as other filters, and fires "change".
function typePicker(attr, key, value, all = "All types") {
  const label = (v) => (!v ? all : v.startsWith("g:") ? `All ${groupLabel(v.slice(2)).toLowerCase()}` : typeLabel(v));
  const icon = (v) => (!v ? "" : v.startsWith("g:") ? groupIcon(v.slice(2)) : typeIcon(v));
  // Only types that have activities (plus the current choice), each with its count.
  const n = (k) => TYPE_COUNTS[k] || 0;
  const item = (v, text, ic, cls = "", count = null) =>
    `<button type="button" class="tpick-item ${cls} ${v === value ? "on" : ""}" data-v="${esc(v)}" data-search="${esc(text.toLowerCase())}">${ic}<span>${esc(text)}</span>${count != null ? `<small class="tpick-n">${num(count)}</small>` : ""}</button>`;
  const groups = TYPES.groups.map((g) => {
    const types = TYPES.types.filter((t) => t.group === g.key && (n(t.key) > 0 || t.key === value));
    if (!types.length && value !== `g:${g.key}`) return "";
    const total = types.reduce((sum, t) => sum + n(t.key), 0);
    return `<div class="tpick-group" data-group>${item(`g:${g.key}`, `All ${g.en.toLowerCase()}`, groupIcon(g.key), "grp", total)}
      ${types.map((t) => item(t.key, t.en, typeIcon(t.key), "sub", n(t.key))).join("")}</div>`;
  }).join("") || `<div class="hint tpick-empty">No activities yet.</div>`;
  return `<div class="tpick">
    <input type="hidden" ${attr}="${key}" value="${esc(value)}">
    <button type="button" class="tpick-btn" data-tpick-btn>${icon(value)}<span class="tpick-label">${esc(label(value))}</span>${ICON.chevron}</button>
    <div class="tpick-menu" hidden>
      <input class="tpick-search" placeholder="Search…" autocomplete="off">
      <div class="tpick-list">${item("", all, "", "all")}${groups}</div>
    </div>
  </div>`;
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-tpick-btn]");
  const pick = e.target.closest(".tpick");
  document.querySelectorAll(".tpick-menu:not([hidden])").forEach((m) => {
    if (!pick || m.parentElement !== pick) m.hidden = true;
  });
  if (btn) {
    const menu = pick.querySelector(".tpick-menu");
    menu.hidden = !menu.hidden;
    if (!menu.hidden) {
      const r = btn.getBoundingClientRect();
      const width = Math.max(240, r.width);
      menu.style.left = `${Math.min(r.left, window.innerWidth - width - 8)}px`;
      menu.style.top = `${r.bottom + 4}px`;
      menu.style.minWidth = `${width}px`;
      menu.style.maxHeight = `${Math.max(200, window.innerHeight - r.bottom - 24)}px`;
      const search = menu.querySelector(".tpick-search");
      search.value = "";
      search.dispatchEvent(new Event("input"));
      search.focus();
      menu.querySelector(".tpick-item.on")?.scrollIntoView({ block: "nearest" });
    }
    return;
  }
  const item = e.target.closest(".tpick-item");
  if (item && pick) {
    const input = pick.querySelector("input[type=hidden]");
    input.value = item.dataset.v;
    pick.querySelectorAll(".tpick-item.on").forEach((x) => x.classList.remove("on"));
    item.classList.add("on");
    const b = pick.querySelector("[data-tpick-btn]");
    b.innerHTML = item.innerHTML.replace(/<span>/, '<span class="tpick-label">').replace(/<small[^>]*>.*?<\/small>/, "") + ICON.chevron;
    pick.querySelector(".tpick-menu").hidden = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
}, true);
document.addEventListener("input", (e) => {
  if (!e.target.classList.contains("tpick-search")) return;
  const q = e.target.value.trim().toLowerCase();
  const menu = e.target.closest(".tpick-menu");
  menu.querySelectorAll(".tpick-item").forEach((i) => { i.hidden = q && !i.dataset.search.includes(q); });
  menu.querySelectorAll("[data-group]").forEach((g) => { g.hidden = ![...g.querySelectorAll(".tpick-item")].some((i) => !i.hidden); });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.querySelectorAll(".tpick-menu:not([hidden])").forEach((m) => { m.hidden = true; });
});
window.addEventListener("scroll", () => document.querySelectorAll(".tpick-menu:not([hidden])").forEach((m) => { m.hidden = true; }), { passive: true });

function filterControl(c, params) {
  const f = c.filter, value = params[c.key] ?? "";
  if (f.type === "types") return typePicker("data-filter", c.key, value, f.all || "All types");
  if (f.type === "select") {
    const opt = ([v, l]) => `<option value="${esc(v)}" ${v === value ? "selected" : ""}>${esc(l)}</option>`;
    const opts = f.options.map((o) => (o.group
      ? `<optgroup label="${esc(o.group)}">${o.options.map(opt).join("")}</optgroup>` : opt(o))).join("");
    return `<select data-filter="${c.key}" title="${esc(c.label)}"><option value="">${esc(f.all || "All")}</option>${opts}</select>`;
  }
  return `<input data-filter="${c.key}" value="${esc(value)}" placeholder="${esc(f.placeholder || "filter…")}" title="${esc(c.label)}">`;
}

// Filters inside a badge panel are only applied with "Apply" (or Enter), so several can be
// changed first.
function bindStagedFilter(root, route, params) {
  const apply = () => {
    const changes = { page: 0 };
    root.querySelectorAll("[data-pfilter]").forEach((el) => { changes[el.dataset.pfilter] = el.value.trim(); });
    root.querySelectorAll(".chip.on[data-pchip]").forEach((b) => { changes[b.dataset.pchip] = b.dataset.value; });
    const clean = Object.fromEntries(Object.entries({ ...params, ...changes }).filter(([, v]) => v !== "" && v != null));
    location.hash = route + "?" + new URLSearchParams(clean);
  };
  root.querySelectorAll("[data-apply]").forEach((b) => b.onclick = apply);
  root.querySelectorAll("input[data-pfilter]").forEach((i) => i.onkeydown = (e) => { if (e.key === "Enter") apply(); });
  root.querySelectorAll("[data-pchip]").forEach((b) => b.onclick = () => {
    root.querySelectorAll(`[data-pchip="${b.dataset.pchip}"]`).forEach((x) => x.classList.toggle("on", x === b));
  });
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
    if (el.tagName === "SELECT" || el.type === "hidden") {
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

// Compact summary strip: label, value, optional small note under it.
function statStrip(items, cls = "") {
  return `<div class="stat-strip ${cls}">${items.map(([label, value, note]) => `<div class="stat-item">
      <span class="stat-label">${label}</span><span class="stat-value">${value}</span>${note ? `<span class="stat-note">${note}</span>` : ""}
    </div>`).join("")}</div>`;
}

// ---- Activities ---------------------------------------------------------------------

const VIEWS = [["list", "List", ICON.list], ["small", "Tiles", ICON.tilesSmall], ["large", "Large tiles", ICON.tilesLarge]];

// Small speed-over-time chart for large tiles (higher = faster), with the average pace.
function paceSpark(series) {
  const pts = (series || []).map((v, i) => [i, v]).filter(([, v]) => v);
  if (pts.length < 2) return `<span class="hint">no pace data</span>`;
  const W = 300, H = 120, P = 8;
  const vals = pts.map(([, v]) => v), lo = Math.min(...vals), hi = Math.max(...vals) || 1;
  const n = (series.length - 1) || 1;
  const xy = pts.map(([i, v]) => [P + (i / n) * (W - 2 * P), H - P - ((v - lo) / (hi - lo || 1)) * (H - 2 * P)]);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const area = `${line}L${xy[xy.length - 1][0].toFixed(1)},${H - P}L${xy[0][0].toFixed(1)},${H - P}Z`;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return `<div class="spark"><span class="hint">Avg ${pace(avg)} · best ${pace(hi)}</span>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path d="${area}" fill="var(--accent)" opacity=".12"/><path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg></div>`;
}

function activitySummary(t) {
  const weeks = t.first && t.last ? Math.max(1, (Date.parse(t.last) - Date.parse(t.first)) / (7 * 864e5)) : 1;
  return statStrip([
    ["Activities", num(t.count), `${num(t.active_days || 0)} active days`],
    ["Distance", km(t.distance_m), t.count ? `${km((t.distance_m || 0) / t.count)} avg` : ""],
    ["Moving time", hours(t.moving_s), t.count ? `${hours((t.moving_s || 0) / weeks)} per week` : ""],
    ["Elevation gain", meters(t.ascent_m), ""],
    ["Longest", km(t.longest_m), t.longest_s ? `${dur(t.longest_s)} max time` : ""],
    ["Calories", kcal(t.calories), ""],
  ]);
}

async function renderActivities(params) {
  params = { sort: "date", dir: "desc", ...params };
  const mode = VIEWS.some(([k]) => k === store.get("view")) ? store.get("view") : "list";
  const isAll = CURRENT === "all";
  const q = { limit: PAGE_SIZE, sort: params.sort, dir: params.dir };
  for (const k of ["type", "date"]) if (params[k]) q[k] = params[k];
  if (params.name) q.q = params.name;
  if (!isAll) q.person = CURRENT;
  else if (params.person) q.person = params.person;
  const tileContent = store.get("tile-content") === "pace" ? "pace" : "route";
  if (mode === "large") { if (tileContent === "pace") q.chart = "pace"; else q.track = "1"; }
  const fetchPage = (offset) => api("activities?" + new URLSearchParams({ ...q, offset }));
  const data = await fetchPage(0);

  const columns = [
    { key: "date", label: "Date", sort: true, filter: { type: "text", placeholder: "2026-02" },
      render: (a) => `<a href="#/activity/${a.id}">${localTime(a)}</a>` },
    { key: "type", label: "Type", sort: true, filter: { type: "types", all: "All types" },
      render: (a) => typeName(a.activity_type) + (a.indoor ? ` <span class="hint">indoor</span>` : "") },
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
      ${mode === "large" ? `<div class="tile-map">${tileContent === "pace" ? paceSpark(a.speed_series) : a.polyline ? trackSvg(a.polyline, "tile-track") : `<span class="hint">${a.indoor ? "indoor" : "no route"}</span>`}</div>` : ""}
      <div class="tile-head">
        <span class="tile-icon">${typeIcon(a.activity_type, mode === "large" ? 40 : 32)}</span>
        <span class="tile-title"><b>${esc(a.name || typeLabel(a.activity_type))}</b>
        <span class="hint">${esc(typeLabel(a.activity_type))} · ${localTime(a)}${isAll ? ` · ${esc(personLabel(a.person_id))}` : ""}</span></span>
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
    ? tableHtml(columns, data.items, params, data.total)
    : `${listBar(columns, params, data.items.length, data.total)}
       <div class="tiles ${mode}" data-rows>${data.items.map(tile).join("") || hint("Nothing matches the filters.")}</div>
       ${data.items.length < data.total ? `<div class="sentinel" data-sentinel><span class="hint">Loading…</span></div>` : ""}`;

  const showSummary = store.get("activity-kpis") !== "0";
  const active = filterCols.filter((c) => params[c.key]).map((c) => {
    const v = params[c.key];
    if (c.key === "type") return v.startsWith("g:") ? groupLabel(v.slice(2)) : typeLabel(v);
    if (c.key === "person") return personLabel(v);
    return v;
  });
  const filterPanelHtml = `<div class="panel-grid">${filterCols.map((c) => section(c.label, filterControl(c, params).replace("data-filter=", "data-pfilter="))).join("")}</div>
    <div class="panel-actions"><button class="primary small" data-apply>Apply</button></div>`;
  view.innerHTML = `
    ${pageHead("Activities", `
      ${badgeHtml("filter", "Filter", active.join(" · ") || "All", { panel: filterPanelHtml, on: active.length > 0 })}
      ${active.length ? `<button class="badge" data-clear title="Clear filters">✕ Clear</button>` : ""}
      ${badgeHtml("options", "Options", "", { panel: `<div class="opt-panel">${row("Large tiles", selectCtl("tile-content", [["route", "Route map"], ["pace", "Pace chart"]], tileContent))}
        <div class="hint" style="margin-top:6px">More chart types (intervals) will follow.</div></div>` })}
      <button class="badge ${showSummary ? "on" : ""}" data-kpis>Summary</button>`,
      switchHtml("view", VIEWS.map(([k, label, icon]) => [k, `${icon}<span>${label}</span>`]), mode))}
    <div data-summary ${showSummary ? "" : "hidden"}>${activitySummary(data.totals)}</div>
    <div class="card">${body}</div>`;
  bindBadges(view.querySelector(".page-head"));
  bindTable("#/activities", params);
  bindStagedFilter(view.querySelector(".page-head"), "#/activities", params);
  infinite(view, data.items.length, data.total, async (offset) => (await fetchPage(offset)).items, (items) => {
    view.querySelector("[data-rows]").insertAdjacentHTML("beforeend", items.map((a) => (mode === "list" ? rowHtml(columns, a) : tile(a))).join(""));
  });
  view.querySelector("[data-kpis]").onclick = (e) => {
    const on = !e.currentTarget.classList.contains("on");
    store.set("activity-kpis", on ? "1" : "0");
    e.currentTarget.classList.toggle("on", on);
    view.querySelector("[data-summary]").hidden = !on;
  };
  view.querySelectorAll("[data-switch=view]").forEach((b) => b.onclick = () => { store.set("view", b.dataset.value); renderActivities(params); });
  view.querySelectorAll("select[name=tile-content]").forEach((sel) => sel.onchange = () => {
    store.set("tile-content", sel.value);
    if (mode === "large") renderActivities(params);
  });
  view.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-delete]");
    if (!b) return;
    if (!confirm("Delete this activity from the database?\n\nThe FIT file is not touched. It will not be imported again unless you remove it from the import history.")) return;
    await api("activities/" + b.dataset.delete, { method: "DELETE" }).catch((err) => alert(err.message));
    b.closest("tr, .tile")?.remove();
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
    <div class="page-head"><h2 class="tb-activity-name">${typeIcon(a.activity_type, 24)}<span>${esc(a.name || typeLabel(a.activity_type))}</span></h2></div>
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
    ${activityTrainingHtml(a)}
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

// Base maps offered by the server (fetched once).
let BASEMAPS = null;
// Light tones first, then dark ones. The soft dark tones lift the blacks and lower the
// contrast, so the map stays calm and routes on top stand out.
const BASE_TONES = [
  ["faded", "Faded light", { "raster-saturation": -0.8, "raster-brightness-min": 0.3, "raster-contrast": -0.2 }],
  ["original", "Original colours", {}],
  ["muted", "Muted", { "raster-saturation": -0.55 }],
  ["grayscale", "Grayscale", { "raster-saturation": -1 }],
  ["soft-dark", "Soft dark", { "raster-saturation": -0.85, "raster-brightness-min": 0.1, "raster-brightness-max": 0.42, "raster-contrast": -0.25 }],
  ["slate", "Slate", { "raster-saturation": -0.6, "raster-hue-rotate": 200, "raster-brightness-min": 0.12, "raster-brightness-max": 0.45, "raster-contrast": -0.3 }],
  ["dusk", "Dusk", { "raster-saturation": -0.45, "raster-brightness-min": 0.08, "raster-brightness-max": 0.5, "raster-contrast": -0.35 }],
  ["dark", "Dark (high contrast)", { "raster-saturation": -1, "raster-brightness-max": 0.32, "raster-contrast": 0.15 }],
];

// ---- saved map settings -------------------------------------------------------------

const COLOR_PRESETS = ["#e8590c", "#d6336c", "#7048e8", "#0f766e", "#2b8a3e", "#f59f00", "#1c7ed6", "#212529", "#f4f4f4"];
const RAMPS = {
  fire: ["#3b0f70", "#a3195b", "#f0562a", "#ffc23f", "#fff7c2"],
  ice: ["#0b1e3f", "#1e5aa8", "#3fa9f5", "#9be7ff", "#ffffff"],
  viridis: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"],
  magma: ["#1c1044", "#6b1d81", "#c63d73", "#fb8761", "#fcfdbf"],
};
const TILE_SIZES = [[13, "Large squares"], [14, "Explorer tiles"], [16, "Medium squares"], [17, "Small squares"]];

function defaultMapSettings() {
  return {
    layer: "heatmap",
    kpis: true,
    map: { source: "osm", tone: "faded" },
    heatmap: { style: "density", color: "#e8590c", ramp: "fire", width: 2, intensity: 0.45, perPerson: true },
    tiles: { zoom: 14, style: "coverage", color: "#0f766e", ramp: "viridis", display: "grid",
             square: true, cluster: true, routes: true },
  };
}

function loadMapSettings() {
  const d = defaultMapSettings();
  let s = null;
  try { s = JSON.parse(store.get("map-settings-v3") || "null"); } catch (e) { s = null; }
  if (!s) return d;
  return { ...d, ...s, map: { ...d.map, ...s.map }, heatmap: { ...d.heatmap, ...s.heatmap }, tiles: { ...d.tiles, ...s.tiles } };
}

const saveMapSettings = (s) => store.set("map-settings-v3", JSON.stringify(s));

const DARK_TONES = new Set(["soft-dark", "slate", "dusk", "dark"]);
const TONE_PROPS = ["raster-saturation", "raster-brightness-min", "raster-brightness-max", "raster-contrast", "raster-hue-rotate"];
const TONE_DEFAULTS = { "raster-saturation": 0, "raster-brightness-min": 0, "raster-brightness-max": 1, "raster-contrast": 0, "raster-hue-rotate": 0 };
const toneOf = (key) => (BASE_TONES.find(([k]) => k === key) || BASE_TONES[0])[2];

function baseStyle(mapSettings) {
  const src = (BASEMAPS || []).find((b) => b.key === mapSettings.source);
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--surface-2").trim() || "#1e222b";
  const style = { version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": bg } }] };
  if (src) {
    const tiles = new URL(`api/basemap/${src.key}/`, document.baseURI).href + "{z}/{x}/{y}.png";
    style.sources.base = { type: "raster", tiles: [tiles], tileSize: 256, maxzoom: src.max_zoom, attribution: src.attribution };
    style.layers.push({ id: "base", type: "raster", source: "base", paint: toneOf(mapSettings.tone) });
  }
  return style;
}

function boundsOf(coordsList) {
  let w = 180, s = 90, e = -180, n = -90;
  for (const coords of coordsList) for (const [lon, lat] of coords) {
    w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat);
  }
  return w <= e ? [[w, s], [e, n]] : null;
}

async function createMap(container, mapSettings, opts = {}) {
  const ml = await loadMapLibre();
  BASEMAPS ??= await api("basemaps");
  disposeMap();
  // Start directly at the data (no jump from a world view = no flicker).
  const start = opts.bounds ? { bounds: opts.bounds, fitBoundsOptions: opts.fitBoundsOptions || { padding: 40, maxZoom: 15 } } : { center: [10, 50], zoom: 3 };
  const zoomOffset = opts.zoomOffset || 0;
  delete opts.bounds; delete opts.fitBoundsOptions; delete opts.zoomOffset;
  activeMap = new ml.Map({ container, style: baseStyle(mapSettings), attributionControl: { compact: true },
                           fadeDuration: 0, ...start, ...opts });
  if (zoomOffset) activeMap.jumpTo({ zoom: Math.max(1, activeMap.getZoom() + zoomOffset) });
  activeMap.addControl(new ml.NavigationControl({ showCompass: false }), "bottom-right");
  await new Promise((resolve) => activeMap.on("load", resolve));
  activeMap.resize();
  return activeMap;
}

function fitTo(map, coordsList, padding = 40) {
  const b = boundsOf(coordsList);
  if (b) map.fitBounds(b, { padding, duration: 0, maxZoom: 15 });
}

const lonLat = (polyline) => decodePolyline(polyline).map(([lat, lon]) => [lon, lat]);

// ---- explorer tiles, computed in the browser for any tile size ----------------------
// (The server only sends the routes; nothing here runs on the Home Assistant box.)

function tileOf(lat, lon, z) {
  const n = 2 ** z;
  lat = Math.max(Math.min(lat, 85.0511), -85.0511);
  const r = (lat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return [Math.min(Math.max(x, 0), n - 1), Math.min(Math.max(y, 0), n - 1)];
}

function tileBounds(x, y, z) {
  const n = 2 ** z;
  const lon = (xx) => (xx / n) * 360 - 180;
  const lat = (yy) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

const tileKey = (x, y) => x * 4194304 + y; // 2^22 > 2^17 tiles per row

function computeTiles(tracks, z) {
  const tiles = new Map(); // key -> {x, y, visits, first}
  for (const t of tracks) {
    const seen = new Set();
    let prev = null;
    const add = (tx, ty) => {
      const k = tileKey(tx, ty);
      if (seen.has(k)) return;
      seen.add(k);
      const cur = tiles.get(k);
      if (cur) { cur.visits += 1; if (t.day < cur.first) cur.first = t.day; }
      else tiles.set(k, { x: tx, y: ty, visits: 1, first: t.day });
    };
    for (const [lon, lat] of t.coords) {
      const [x, y] = tileOf(lat, lon, z);
      add(x, y);
      if (prev) {
        const steps = Math.max(Math.abs(x - prev[2]), Math.abs(y - prev[3]));
        if (steps > 1) {
          const k = steps * 4;
          for (let i = 1; i < k; i++) {
            const f = i / k;
            const [ix, iy] = tileOf(prev[1] + (lat - prev[1]) * f, prev[0] + (lon - prev[0]) * f, z);
            add(ix, iy);
          }
        }
      }
      prev = [lon, lat, x, y];
    }
  }
  return tiles;
}

function maxSquare(tiles) {
  const dp = new Map();
  let best = { size: 0, x: 0, y: 0 };
  const list = [...tiles.values()].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const { x, y } of list) {
    const size = 1 + Math.min(dp.get(tileKey(x - 1, y)) || 0, dp.get(tileKey(x, y - 1)) || 0, dp.get(tileKey(x - 1, y - 1)) || 0);
    dp.set(tileKey(x, y), size);
    if (size > best.size) best = { size, x: x - size + 1, y: y - size + 1 };
  }
  return best;
}

function clusterOf(tiles) {
  const has = (x, y) => tiles.has(tileKey(x, y));
  const inner = new Map();
  for (const t of tiles.values()) {
    if (has(t.x - 1, t.y) && has(t.x + 1, t.y) && has(t.x, t.y - 1) && has(t.x, t.y + 1)) inner.set(tileKey(t.x, t.y), t);
  }
  let best = [];
  const seen = new Set();
  for (const [k, start] of inner) {
    if (seen.has(k)) continue;
    const group = [start]; seen.add(k);
    for (let i = 0; i < group.length; i++) {
      const { x, y } = group[i];
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        const nk = tileKey(nx, ny);
        if (inner.has(nk) && !seen.has(nk)) { seen.add(nk); group.push(inner.get(nk)); }
      }
    }
    if (group.length > best.length) best = group;
  }
  return best;
}

const tileFeature = (t, z, props = {}) => {
  const [w, s, e, n] = tileBounds(t.x, t.y, z);
  return { type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } };
};
const tileWidthKm = (z, lat) => (40075 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

// Evenly spaced points along all routes (for the heat-glow layer). Spacing ~30 m, larger
// when there is a lot of data, so the browser never gets more than ~1.5 million points.
function densify(tracks) {
  const segLen = ([lon1, lat1], [lon2, lat2]) => {
    const k = Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
    return Math.hypot((lon2 - lon1) * k, lat2 - lat1) * 111320;
  };
  let total = 0;
  for (const t of tracks) for (let i = 1; i < t.coords.length; i++) total += segLen(t.coords[i - 1], t.coords[i]);
  const step = Math.max(30, total / 1.5e6);
  const out = [];
  for (const t of tracks) {
    let carry = 0;
    for (let i = 1; i < t.coords.length; i++) {
      const a = t.coords[i - 1], b = t.coords[i], len = segLen(a, b);
      let d = step - carry;
      while (d <= len) {
        const f = d / len;
        out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
        d += step;
      }
      carry = len - (d - step);
    }
  }
  return out;
}

// ---- badges (shared by every tab's header) ------------------------------------------
// A page header is: title, then badges; badges open panels. Panels stay open while their
// settings change; only what changed is updated.

function pageHead(title, badges = "", right = "") {
  return `<div class="page-head"><h2>${title}</h2><div class="badges">${badges}</div><span class="spacer"></span>${right}</div>`;
}
function badgeHtml(id, label, value = "", { panel = "", on = false, wide = false } = {}) {
  return `<div class="badge-wrap">
    <button class="badge ${on ? "on" : ""}" data-badge="${id}" ${panel ? 'aria-haspopup="true"' : ""}>
      <span class="badge-label">${label}</span>${value ? `<span class="badge-value" data-badge-value="${id}">${value}</span>` : ""}${panel ? ICON.chevron : ""}
    </button>
    ${panel ? `<div class="badge-panel ${wide ? "wide" : ""}" data-panel="${id}" hidden>${panel}</div>` : ""}
  </div>`;
}
function switchHtml(name, options, current) {
  return `<div class="switch" role="group">${options.map(([v, l]) =>
    `<button class="${v === current ? "on" : ""}" data-switch="${name}" data-value="${v}">${l}</button>`).join("")}</div>`;
}
function bindBadges(root) {
  root.querySelectorAll("[data-badge]").forEach((b) => b.addEventListener("click", (e) => {
    const panel = root.querySelector(`[data-panel="${b.dataset.badge}"]`);
    if (!panel) return;
    e.stopPropagation();
    const open = panel.hidden;
    root.querySelectorAll(".badge-panel").forEach((p) => { p.hidden = true; });
    root.querySelectorAll(".badge.open").forEach((x) => x.classList.remove("open"));
    panel.hidden = !open;
    b.classList.toggle("open", open);
  }));
  root.querySelectorAll(".badge-panel").forEach((p) => p.addEventListener("click", (e) => e.stopPropagation()));
  document.onclick = () => {
    root.querySelectorAll(".badge-panel").forEach((p) => { p.hidden = true; });
    root.querySelectorAll(".badge.open").forEach((x) => x.classList.remove("open"));
  };
}
// Compact option rows: label on the left, control on the right.
const row = (label, control) => `<div class="opt-row"><span class="opt-label">${label}</span><div class="opt-control">${control}</div></div>`;
const selectCtl = (name, options, current) => `<select name="${name}">${options.map(([v, l]) =>
  `<option value="${esc(v)}" ${String(v) === String(current) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
const segCtl = (name, options, current) => `<div class="seg">${options.map(([v, l]) =>
  `<button class="${String(v) === String(current) ? "on" : ""}" data-chip="${name}" data-value="${v}">${l}</button>`).join("")}</div>`;
const checkCtl = (name, on, label, title = "") =>
  `<label class="check" ${title ? `title="${esc(title)}"` : ""}><input type="checkbox" name="${name}" ${on ? "checked" : ""}> ${label}</label>`;

// Accordion: one section open at a time.
function accordion(sections, open) {
  return `<div class="acc">${sections.map(([key, title, summary, body]) => `
    <section class="acc-item ${key === open ? "open" : ""}" data-acc="${key}">
      <button class="acc-head" data-acc-head="${key}"><span>${title}</span>${ICON.chevron}</button>
      <div class="acc-body">${body}</div>
    </section>`).join("")}</div>`;
}
function bindAccordion(el, onOpen) {
  el.querySelectorAll("[data-acc-head]").forEach((h) => h.onclick = () => {
    const item = h.closest(".acc-item");
    const willOpen = !item.classList.contains("open");
    el.querySelectorAll(".acc-item").forEach((x) => x.classList.remove("open"));
    item.classList.toggle("open", willOpen);
    if (onOpen) onOpen(willOpen ? item.dataset.acc : null);
  });
}

// Choice chips (one of many) and toggle chips (on/off).
const chips = (name, options, current) => `<div class="chips">${options.map(([v, l, title]) =>
  `<button class="chip ${String(v) === String(current) ? "on" : ""}" data-chip="${name}" data-value="${v}" ${title ? `title="${esc(title)}"` : ""}>${l}</button>`).join("")}</div>`;
const toggleChip = (name, on, label, title = "") =>
  `<button class="chip toggle ${on ? "on" : ""}" data-toggle="${name}" ${title ? `title="${esc(title)}"` : ""}>${label}</button>`;
const optRadio = (name, value, current, label, title = "") =>
  `<label class="opt" ${title ? `title="${esc(title)}"` : ""}><input type="radio" name="${name}" value="${value}" ${String(value) === String(current) ? "checked" : ""}><span>${label}</span></label>`;
const optCheck = (name, on, label, title = "") =>
  `<label class="opt" ${title ? `title="${esc(title)}"` : ""}><input type="checkbox" name="${name}" ${on ? "checked" : ""}><span>${label}</span></label>`;
const colorPickerOld = (name, current) => `<div class="swatch-row">${COLOR_PRESETS.map((c) =>
    `<button class="swatch ${c.toLowerCase() === String(current).toLowerCase() ? "active" : ""}" style="background:${c}" data-color="${name}" data-value="${c}" aria-label="${c}"></button>`).join("")}
    <label class="swatch custom" title="Any colour"><input type="color" name="${name}" value="${esc(current)}"></label></div>`;
const rampPickerOld = (name, current) => `<div class="ramp-list">${Object.entries(RAMPS).map(([k, cols]) =>
    `<button class="ramp ${k === current ? "active" : ""}" data-ramp="${name}" data-value="${k}" title="${k}" style="background:linear-gradient(90deg,${cols.join(",")})"></button>`).join("")}</div>`;
const colorPicker = (name, current) => `<div class="swatch-row small">${COLOR_PRESETS.map((c) =>
    `<button class="swatch ${c.toLowerCase() === String(current).toLowerCase() ? "active" : ""}" style="background:${c}" data-color="${name}" data-value="${c}" aria-label="${c}"></button>`).join("")}
    <label class="swatch custom" title="Any colour"><input type="color" name="${name}" value="${esc(current)}"></label></div>`;
const RAMP_LABELS = { fire: "Fire", ice: "Ice", viridis: "Viridis", magma: "Magma" };
const rampPicker = (name, current) => `<div class="ramp-select"><span class="ramp-preview" data-ramp-preview="${name}" style="background:linear-gradient(90deg,${(RAMPS[current] || RAMPS.fire).join(",")})"></span>
    ${selectCtl(name, Object.keys(RAMPS).map((k) => [k, RAMP_LABELS[k]]), current)}</div>`;
const section = (title, body) => `<div class="panel-section"><div class="panel-title">${title}</div>${body}</div>`;

// ---- Heatmap page -------------------------------------------------------------------

let heat = null; // { settings, tracks, years, tileCache, params, isAll, map }

const ICON_HEAT = svg(`<path d="M3 17c3-1 4-6 7-6s3 4 6 4 3-6 5-8"/><path d="M3 21c3-1 4-4 7-4s3 2 6 2 3-3 5-4" opacity=".5"/>`);
const ICON_GRID = svg(`<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7" opacity=".4"/>`);

async function renderHeatmap(params) {
  const isAll = CURRENT === "all";
  const q = {};
  if (!isAll) q.person = CURRENT;
  if (params.type) q.type = params.type;
  if (params.year) q.year = params.year;
  document.body.classList.add("fullmap");
  const [data] = await Promise.all([api("heatmap/tracks?" + new URLSearchParams(q)), (async () => { BASEMAPS ??= await api("basemaps"); })()]);
  const tracks = data.items.map((t) => ({ ...t, coords: lonLat(t.polyline) }));
  heat = { settings: loadMapSettings(), tracks, years: data.years, tileCache: new Map(), params, isAll, map: null };
  const s = heat.settings;
  const activeFilter = Boolean(params.type || params.year);

  view.innerHTML = `<div class="heat-wrap">
      <div id="map" class="heat-map"></div>
      <div class="heat-overlay"><div class="heat-column">
        <div class="float-bar">${pageHead("Map", `
          ${badgeHtml("filter", "Filter", filterSummary(), { panel: filterPanel(), on: activeFilter })}
          ${activeFilter ? `<button class="badge" data-clear-map title="Clear filters">✕ Clear</button>` : ""}
          ${badgeHtml("settings", "Options", "", { panel: "<div data-settings></div>" })}
          <button class="badge ${s.kpis ? "on" : ""}" data-kpis>Summary</button>`,
          switchHtml("layer", [["heatmap", `${ICON_HEAT}<span>Heatmap</span>`], ["tiles", `${ICON_GRID}<span>Explorer tiles</span>`]], s.layer))}</div>
        <div id="heat-kpis" ${s.kpis ? "" : "hidden"}></div>
      </div></div>
    </div>`;
  const head = view.querySelector(".float-bar");
  bindBadges(head);
  renderSettingsPanel();
  head.querySelectorAll("[data-switch=layer]").forEach((b) => b.onclick = () => {
    if (s.layer === b.dataset.value) return;
    s.layer = b.dataset.value; saveMapSettings(s);
    head.querySelectorAll("[data-switch=layer]").forEach((x) => x.classList.toggle("on", x === b));
    drawHeatLayers();
  });
  head.querySelector("[data-kpis]").onclick = (e) => {
    s.kpis = !s.kpis; saveMapSettings(s);
    e.currentTarget.classList.toggle("on", s.kpis);
    document.getElementById("heat-kpis").hidden = !s.kpis;
  };
  bindStagedFilter(head, "#/heatmap", heat.params);
  head.querySelector("[data-clear-map]")?.addEventListener("click", () => { location.hash = "#/heatmap"; });

  const bounds = boundsOf(tracks.map((t) => t.coords));
  const map = await createMap("map", s.map, bounds ? { bounds, fitBoundsOptions: { padding: { top: 150, left: 40, right: 40, bottom: 40 }, maxZoom: 15 }, zoomOffset: -4 } : {});
  heat.map = map;
  drawHeatLayers();
  map.on("click", "routes", (e) => {
    const items = [...new Map(e.features.map((f) => [f.properties.id, f.properties])).values()].slice(0, 6);
    new maplibregl.Popup({ closeButton: false, maxWidth: "260px" }).setLngLat(e.lngLat)
      .setHTML(items.map((p) => `<a href="#/activity/${p.id}">${esc(p.type)} · ${esc(p.day)}</a>${isAll ? ` <span class="hint">${esc(p.person)}</span>` : ""}`).join("<br>"))
      .addTo(map);
  });
  map.on("mouseenter", "routes", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "routes", () => { map.getCanvas().style.cursor = ""; });
  map.on("moveend", () => {
    const sel = view.querySelector('select[name="tiles.zoom"]');
    if (sel) [...sel.options].forEach((o) => { const z = Number(o.value); o.textContent = `${TILE_SIZES.find(([k]) => k === z)[1]} · ${num(tileWidthKm(z, map.getCenter().lat), z >= 16 ? 2 : 1)} km`; });
  });
}

function filterSummary() {
  const pt = heat.params.type || "";
  return [pt.startsWith("g:") ? groupLabel(pt.slice(2)) : pt ? typeLabel(pt) : "", heat.params.year || ""].filter(Boolean).join(" · ") || "All";
}
function filterPanel() {
  return `<div class="panel-grid">${section("Activity type", typePicker("data-pfilter", "type", heat.params.type || ""))}
    ${section("Year", `<div class="chips">${[["", "All"], ...heat.years.map((y) => [y, y])].map(([v, l]) =>
      `<button class="chip ${v === (heat.params.year || "") ? "on" : ""}" data-pchip="year" data-value="${v}">${l}</button>`).join("")}</div>`)}</div>
    <div class="panel-actions"><button class="primary small" data-apply>Apply</button></div>`;
}

function renderSettingsPanel() {
  const s = heat.settings, M = s.map, H = s.heatmap, T = s.tiles;
  const lat = heat.map ? heat.map.getCenter().lat : 52;
  const srcLabel = (BASEMAPS || []).find((b) => b.key === M.source)?.label.split(" (")[0] || "None";
  const toneLabel = (BASE_TONES.find(([k]) => k === M.tone) || BASE_TONES[0])[1];
  const sizeLabel = (TILE_SIZES.find(([z]) => z === T.zoom) || TILE_SIZES[1])[1];
  const styleLabel = { density: "Density", coverage: "Coverage", glow: "Heat glow" }[H.style];
  const mapBody = row("Base map", selectCtl("map.source", [...(BASEMAPS || []).map((b) => [b.key, b.label]), ["none", "None"]], M.source))
    + row("Colours", selectCtl("map.tone", BASE_TONES.map(([k, l]) => [k, l]), M.tone));
  const heatBody = row("Style", selectCtl("heatmap.style", [["density", "Density — overlaps get stronger"], ["coverage", "Coverage — solid lines"], ["glow", "Heat glow — colour gradient"]], H.style))
    + row("Line colour", colorPicker("heatmap.color", H.color))
    + (heat.isAll ? row("People", checkCtl("heatmap.perPerson", H.perPerson, "A colour per person")) : "")
    + row("Gradient", rampPicker("heatmap.ramp", H.ramp))
    + row("Line width", `<input type="range" min="1" max="6" step="0.5" value="${H.width}" name="heatmap.width">`)
    + row("Overlap", `<input type="range" min="0.1" max="0.9" step="0.05" value="${H.intensity}" name="heatmap.intensity">`);
  const tilesBody = row("Tile size", selectCtl("tiles.zoom", TILE_SIZES.map(([z, l]) => [z, `${l} · ${num(tileWidthKm(z, lat), z >= 16 ? 2 : 1)} km`]), T.zoom))
    + row("Style", selectCtl("tiles.style", [["coverage", "Coverage"], ["heat", "By number of visits"]], T.style))
    + row("Tile colour", colorPicker("tiles.color", T.color))
    + row("Gradient", rampPicker("tiles.ramp", T.ramp))
    + row("Display", selectCtl("tiles.display", [["grid", "Single tiles"], ["area", "One area"]], T.display))
    + row("Highlights", `<div class="checks">${checkCtl("tiles.square", T.square, "Max square", "Largest square made only of visited tiles")}
        ${checkCtl("tiles.cluster", T.cluster, "Cluster", "Largest connected group of tiles with visited tiles on all four sides")}
        ${checkCtl("tiles.routes", T.routes, "Routes")}</div>`);
  heat.openAcc ??= s.layer;
  const el = view.querySelector("[data-settings]");
  el.innerHTML = accordion([
    ["map", "Map", `${srcLabel} · ${toneLabel}`, mapBody],
    ["heatmap", "Heatmap", styleLabel, heatBody],
    ["tiles", "Explorer tiles", sizeLabel, tilesBody],
  ], heat.openAcc);
  bindAccordion(el, (key) => { heat.openAcc = key; });
  bindSettingsPanel(el);
}

// Apply one setting with the cheapest possible map update. Settings of the mode that is not
// shown are only saved.
function bindSettingsPanel(el) {
  const s = heat.settings;
  const set = (path, value) => {
    const [a, b] = path.split(".");
    if (b === undefined) s[a] = value; else s[a][b] = value;
    saveMapSettings(s);
  };
  const shown = (path) => path.startsWith("map.") || path.startsWith(s.layer + ".");
  const refresh = (path, kind) => {
    if (path === "map.source") return applyBase(true);
    if (path === "map.tone") return applyBase(false);
    if (!shown(path)) return;
    if (kind === "paint") updatePaint(); else drawHeatLayers();
  };
  const summary = () => { const keep = heat.openAcc; renderSettingsPanel(); heat.openAcc = keep; };
  el.querySelectorAll("select").forEach((sel) => sel.onchange = () => {
    const value = sel.name === "tiles.zoom" ? Number(sel.value) : sel.value;
    set(sel.name, value);
    const paint = sel.name.endsWith(".ramp");
    refresh(sel.name, paint ? "paint" : "layers");
    if (paint) el.querySelector(`[data-ramp-preview="${sel.name}"]`).style.background = `linear-gradient(90deg,${RAMPS[value].join(",")})`;
    else summary();
  });
  el.querySelectorAll("[data-chip]").forEach((b) => b.onclick = () => {
    set(b.dataset.chip, b.dataset.value);
    el.querySelectorAll(`[data-chip="${b.dataset.chip}"]`).forEach((x) => x.classList.toggle("on", x === b));
    refresh(b.dataset.chip, "layers");
    if (b.dataset.chip === "heatmap.style") summary();
  });
  el.querySelectorAll("input[type=checkbox]").forEach((c) => c.onchange = () => {
    set(c.name, c.checked);
    refresh(c.name, c.name === "heatmap.perPerson" ? "paint" : "layers");
  });
  el.querySelectorAll("input[type=range]").forEach((r) => { r.oninput = () => { set(r.name, Number(r.value)); refresh(r.name, "paint"); }; });
  el.querySelectorAll("[data-color]").forEach((b) => b.onclick = () => {
    set(b.dataset.color, b.dataset.value);
    el.querySelectorAll(`[data-color="${b.dataset.color}"]`).forEach((x) => x.classList.toggle("active", x === b));
    el.querySelector(`input[type=color][name="${b.dataset.color}"]`).value = b.dataset.value;
    refresh(b.dataset.color, "paint");
  });
  el.querySelectorAll("input[type=color]").forEach((inp) => { inp.oninput = () => {
    set(inp.name, inp.value);
    el.querySelectorAll(`[data-color="${inp.name}"]`).forEach((x) => x.classList.remove("active"));
    refresh(inp.name, "paint");
  }; });
}

function applyBase(newSource) {
  const map = heat.map;
  if (!map) return;
  const M = heat.settings.map;
  if (newSource) {
    map.setStyle(baseStyle(M));
    map.once("style.load", () => drawHeatLayers());
    return;
  }
  if (!map.getLayer("base")) return;
  const tone = toneOf(M.tone);
  for (const p of TONE_PROPS) map.setPaintProperty("base", p, tone[p] ?? TONE_DEFAULTS[p]);
  drawHeatLayers();
}

const heatRadius = (w) => ["interpolate", ["linear"], ["zoom"], 6, 2 * w, 12, 6 * w, 16, 14 * w];
const lineWidth = (w) => ["interpolate", ["linear"], ["zoom"], 8, w * 0.5, 13, w, 16, w * 2];
const rampExpr = (r, input) => ["interpolate", ["linear"], input, 0, r[0], 0.25, r[1], 0.5, r[2], 0.75, r[3], 1, r[4]];

// Colour / width / strength: update paint properties only (instant, no data rebuild).
function updatePaint() {
  const map = heat.map, s = heat.settings;
  if (!map) return;
  if (s.layer === "heatmap") {
    const H = s.heatmap;
    if (map.getLayer("routes-glow")) {
      const r = RAMPS[H.ramp] || RAMPS.fire;
      map.setPaintProperty("routes-glow", "heatmap-radius", heatRadius(H.width));
      map.setPaintProperty("routes-glow", "heatmap-weight", 0.15 * H.intensity);
      map.setPaintProperty("routes-glow", "heatmap-color", ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(0,0,0,0)", 0.08, r[0], 0.3, r[1], 0.55, r[2], 0.8, r[3], 1, r[4]]);
    } else if (map.getLayer("routes")) {
      map.setPaintProperty("routes", "line-width", lineWidth(H.width));
      map.setPaintProperty("routes", "line-opacity", H.style === "coverage" ? 1 : H.intensity);
      map.setPaintProperty("routes", "line-color", heat.isAll && H.perPerson ? ["get", "pcolor"] : H.color);
    }
  } else {
    const T = s.tiles;
    if (map.getLayer("tiles-fill")) {
      map.setPaintProperty("tiles-fill", "fill-color", T.style === "heat" ? rampExpr(RAMPS[T.ramp] || RAMPS.viridis, ["get", "f"]) : T.color);
    }
    if (map.getLayer("tiles-line")) map.setPaintProperty("tiles-line", "line-color", T.style === "heat" ? "#ffffff" : T.color);
  }
}

function heatTiles() {
  const z = heat.settings.tiles.zoom;
  if (!heat.tileCache.has(z)) {
    const tiles = computeTiles(heat.tracks, z);
    heat.tileCache.set(z, { tiles, square: maxSquare(tiles), cluster: clusterOf(tiles) });
  }
  return heat.tileCache.get(z);
}

function renderHeatKpis() {
  const el = document.getElementById("heat-kpis");
  if (!el) return;
  const t = heat.tracks;
  const sum = (k) => t.reduce((a, x) => a + (x[k] || 0), 0);
  const days = new Set(t.map((x) => x.day)).size;
  const items = [
    ["Activities", num(t.length), `${num(days)} active days`],
    ["Distance", km(sum("distance_m")), ""],
    ["Moving time", hours(sum("moving_s")), ""],
  ];
  if (heat.settings.layer === "tiles") {
    const { tiles, square, cluster } = heatTiles();
    items.push(["Tiles", num(tiles.size), TILE_SIZES.find(([z]) => z === heat.settings.tiles.zoom)?.[1] || ""],
      ["Max square", square.size ? `${square.size} × ${square.size}` : "–", ""],
      ["Cluster", `${num(cluster.length)} tiles`, ""]);
  } else {
    items.push(["Elevation gain", meters(sum("ascent_m")), ""]);
  }
  el.innerHTML = statStrip(items, "floating");
}

const HEAT_LAYERS = ["routes-glow", "tiles-fill", "tiles-line", "cluster", "square", "routes"];
const HEAT_SOURCES = ["routes", "route-points", "tiles", "cluster", "square"];

// Rebuild the data layers (mode, style, tile size, display or highlights changed).
function drawHeatLayers() {
  const map = heat.map, s = heat.settings;
  if (!map) return;
  for (const id of HEAT_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
  for (const id of HEAT_SOURCES) if (map.getSource(id)) map.removeSource(id);
  const people = realPeople();
  const order = (pid) => people.findIndex((p) => p.id === pid);
  const colorFor = (pid) => personColor(person(pid), Math.max(0, order(pid)));
  // People later in the order are drawn first, so the first person ends up on top.
  const routes = [...heat.tracks].sort((a, b) => order(b.person_id) - order(a.person_id)).map((t) => ({
    type: "Feature",
    properties: { id: t.id, day: t.day, type: typeLabel(t.activity_type), person: personLabel(t.person_id), pcolor: colorFor(t.person_id) },
    geometry: { type: "LineString", coordinates: t.coords },
  }));
  map.addSource("routes", { type: "geojson", data: { type: "FeatureCollection", features: routes } });

  if (s.layer === "heatmap") {
    const H = s.heatmap;
    if (H.style === "glow") {
      heat.glowPoints ??= densify(heat.tracks).map((c) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: c } }));
      map.addSource("route-points", { type: "geojson", data: { type: "FeatureCollection", features: heat.glowPoints } });
      map.addLayer({ id: "routes-glow", type: "heatmap", source: "route-points", paint: {
        "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 6, 0.5, 14, 1], "heatmap-opacity": 0.9 } });
      map.addLayer({ id: "routes", type: "line", source: "routes", paint: { "line-opacity": 0, "line-width": 8 } });
    } else {
      map.addLayer({ id: "routes", type: "line", source: "routes", layout: { "line-join": "round", "line-cap": "round" }, paint: {} });
    }
  } else {
    const T = s.tiles, z = T.zoom;
    const { tiles, square, cluster } = heatTiles();
    const max = Math.max(1, ...[...tiles.values()].map((t) => t.visits));
    map.addSource("tiles", { type: "geojson", data: { type: "FeatureCollection",
      features: [...tiles.values()].map((t) => tileFeature(t, z, { v: t.visits, f: Math.log(t.visits) / Math.log(max + 1) })) } });
    map.addLayer({ id: "tiles-fill", type: "fill", source: "tiles", paint: {
      "fill-opacity": T.style === "heat" ? 0.55 : 0.32, "fill-antialias": T.display === "grid" } });
    if (T.display === "grid") map.addLayer({ id: "tiles-line", type: "line", source: "tiles", paint: { "line-opacity": 0.35, "line-width": 0.6 } });
    if (T.cluster && cluster.length) {
      map.addSource("cluster", { type: "geojson", data: { type: "FeatureCollection", features: cluster.map((t) => tileFeature(t, z)) } });
      map.addLayer({ id: "cluster", type: "fill", source: "cluster", paint: { "fill-color": "#a678ff", "fill-opacity": 0.35 } });
    }
    if (T.square && square.size) {
      const [w, , , n] = tileBounds(square.x, square.y, z);
      const [, sth, e] = tileBounds(square.x + square.size - 1, square.y + square.size - 1, z);
      map.addSource("square", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[w, sth], [e, sth], [e, n], [w, n], [w, sth]]] } } });
      map.addLayer({ id: "square", type: "line", source: "square", paint: { "line-color": "#ffd23f", "line-width": 3 } });
    }
    // Routes on top of the tiles, so they stay visible.
    map.addLayer({ id: "routes", type: "line", source: "routes", layout: { "line-join": "round", "line-cap": "round", visibility: T.routes ? "visible" : "none" },
      paint: { "line-color": DARK_TONES.has(s.map.tone) || s.map.source === "none" && document.documentElement.dataset.theme === "dark" ? "#ffffff" : "#1b1e25",
               "line-opacity": 0.7, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 14, 1.6] } });
  }
  updatePaint();
  renderHeatKpis();
}

async function showRouteMap(container, polyline) {
  const coords = lonLat(polyline);
  const map = await createMap(container, loadMapSettings().map, { bounds: boundsOf([coords]) });
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  map.addSource("route", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } } });
  map.addLayer({ id: "route", type: "line", source: "route", layout: { "line-join": "round", "line-cap": "round" },
                 paint: { "line-color": accent, "line-width": 3.5 } });
  map.addSource("ends", { type: "geojson", data: { type: "FeatureCollection", features: [
    { type: "Feature", properties: { c: "#3ecf8e" }, geometry: { type: "Point", coordinates: coords[0] } },
    { type: "Feature", properties: { c: "#ff6b6b" }, geometry: { type: "Point", coordinates: coords[coords.length - 1] } }] } });
  map.addLayer({ id: "ends", type: "circle", source: "ends", paint: { "circle-radius": 5, "circle-color": ["get", "c"], "circle-stroke-width": 2, "circle-stroke-color": "#fff" } });
}

// ---- Coming-soon pages --------------------------------------------------------------

const PLANNED = {
  wellbeing: ["Wellbeing", "after Fitness", [
    "Sleep, stress and heart rate — mostly charts over days, weeks and months.",
    "Data from the Garmin Connect personal API (sleep, HRV, stress, resting heart rate, steps, weight).",
    "Some daily values (resting heart rate, steps) will also appear in the Calendar.",
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
    ${pageHead("Compare", badgeHtml("year", "Period", params.year || "All time", { panel: section("Year", `<select id="year"><option value="">All time</option>${data.years.map((y) => `<option ${y === params.year ? "selected" : ""}>${y}</option>`).join("")}</select>`) }))}
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
  bindBadges(view.querySelector(".page-head"));
  document.getElementById("year").onchange = (e) => {
    location.hash = "#/compare" + (e.target.value ? "?year=" + e.target.value : "");
  };
}

// ---- Settings: General / People / Import / Types ------------------------------------

const SETTINGS_TABS = [
  ["general", "General", svg(`<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>`)],
  ["people", "People", svg(`<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .7 3.2 2.5 3.6 5.2"/>`)],
  ["import", "Imported", svg(`<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 17v3h16v-3"/>`)],
  ["types", "Activity types", svg(`<path d="M3 12V4h8l9 9-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>`)],
  ["backup", "Backup", svg(`<path d="M4 7h16v13H4z"/><path d="M2 4h20v3H2z"/><path d="M10 11h4"/>`)],
];

async function renderSettings(tab, params) {
  tab = SETTINGS_TABS.some(([k]) => k === tab) ? tab : "general";
  view.innerHTML = `${pageHead("Settings", "", switchHtml("tab", SETTINGS_TABS.map(([k, l, icon]) => [k, `${icon}<span>${l}</span>`]), tab))}<div id="tab"></div>`;
  view.querySelectorAll("[data-switch=tab]").forEach((b) => b.onclick = () => { location.hash = "#/settings/" + b.dataset.value; });
  const el = document.getElementById("tab");
  if (tab === "people") await settingsPeople(el);
  else if (tab === "import") await settingsImport(el, params);
  else if (tab === "types") settingsTypes(el, params);
  else if (tab === "backup") await settingsBackup(el);
  else await settingsGeneral(el);
}

async function settingsGeneral(el) {
  const [s, devices, garminState] = await Promise.all([api("settings"), api("devices"), api("garmin")]);
  PERSONS = await api("persons");
  const people = realPeople();
  const accounts = garminState.accounts || {};
  const accent = store.get("accent") || "sky";
  const interval = (m) => (m === 0 ? "Off" : m < 60 ? `${m} min` : m === 60 ? "1 hour" : `${m / 60} hours`);
  const source = s.data_source || "folder";
  const choice = (name, value, current, title, text, extra = "") =>
    `<label class="choice"><input type="radio" name="${name}" value="${value}" ${value === current ? "checked" : ""}>
      <span><b>${title}${extra}</b><span class="hint">${text}</span></span></label>`;

  const watchesHtml = `<div class="watches" ${s.person_mode === "devices" ? "" : "hidden"}>
      <div class="panel-title" style="margin-top:14px">Watches</div>
      <div class="note"><b>A watch's person applies to files imported from now on.</b> Activities that already have a person stay where they are; only activities still <i>Unassigned</i> move to the person you choose.</div>
      <div class="scroll"><table class="data"><thead><tr><th>Watch</th><th>Serial</th><th>Person</th><th class="num">Activities</th><th>Last seen</th></tr></thead>
      <tbody>${devices.map((d) => `<tr><td>${esc(d.product_name || "–")}</td><td><code>${d.serial}</code></td>
        <td><select data-serial="${d.serial}"><option value="">Unassigned</option>${people.map((p) =>
          `<option value="${esc(p.id)}" ${p.id === d.person_id ? "selected" : ""}>${esc(p.label)}</option>`).join("")}</select></td>
        <td class="num">${num(d.activities)}</td><td>${browserTime(d.last_seen)}</td></tr>`).join("")
        || `<tr><td colspan="5" class="hint">No watches seen yet — they appear after the first scan.</td></tr>`}</tbody></table></div>
      <span data-watch-msg></span>
    </div>`;

  const folderCards = `
    <div class="card">
      <h3>Watched folder</h3>
      ${hint(`Absolute path to the folder with FIT files.${s.allowed_roots ? ` It must be inside: ${esc(s.allowed_roots)}.` : ""}`)}
      <input class="field-input" name="root" value="${esc(s.root || "")}" placeholder="/share/trailbook">
      ${hint("Changing the folder marks files of the old folder as missing; their activities stay.")}
      <div class="card-row" style="margin-top:12px"><button class="primary" data-save="root">Save</button><span data-msg></span></div>
    </div>
    <div class="card">
      <h3>Assigning files to people</h3>
      ${choice("person_mode", "folders", s.person_mode, "One subfolder per person", "folder/alice/…, folder/bob/… — the folder decides. Works when two people share a watch.")}
      ${choice("person_mode", "devices", s.person_mode, "One shared folder, assign by watch", "Any folder layout. Choose below which person each watch belongs to.")}
      <div class="note">
        <b>Applies only to files imported from now on.</b> Activities that are already imported keep their person.
        Nothing is imported twice: every activity is recognised by its FIT id (watch serial number + creation time),
        so changing this setting never re-imports or duplicates anything.
      </div>
      <div class="card-row" style="margin-top:12px"><button class="primary" data-save="person_mode">Save</button><span data-msg></span></div>
      ${watchesHtml}
    </div>
    <div class="card">
      <h3>Automatic folder scan</h3>
      ${hint("A scan only compares file sizes and dates; new files are then imported at the lowest priority.")}
      <select class="field-input" name="scan_interval_min" style="max-width:200px">${s.scan_interval_choices.map((m) =>
        `<option value="${m}" ${m === s.scan_interval_min ? "selected" : ""}>${interval(m)}</option>`).join("")}</select>
      <div>${s.next_scan_at ? state(`Next scan at ${browserTime(s.next_scan_at)}`) : state("No automatic scan scheduled", "warn")}</div>
      <div class="card-row" style="margin-top:12px"><button class="primary" data-save="scan_interval_min">Save</button><span data-msg></span></div>
    </div>`;

  const uploadCard = `
    <div class="card">
      <h3>Upload a Garmin export or FIT file</h3>
      ${hint("A one-time import for one person: the ZIP from Garmin's “Export your data”, a ZIP of FIT files, or a single .fit file. Sleep and monitoring files inside are skipped.")}
      <div class="upload-row">
        <select name="upload-person"><option value="">Choose a person…</option>${people.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join("")}</select>
        <input type="file" name="upload-file" accept=".zip,.fit">
        <button class="primary" data-upload>Upload and import</button>
      </div>
      <div class="note"><b>Nothing is imported twice.</b> Activities already in Trailbook (same FIT id) are recognised and skipped, so uploading an export again is safe.</div>
      <div data-upload-msg style="margin-top:8px"></div>
    </div>`;

  const GSTATE = { new: ["not tested", "warn"], ok: ["connected", "ok"], error: ["paused", "warn"], auth_error: ["key refused", "bad"] };
  const garminRow = (p) => {
    const a = accounts[p.id];
    const st = a ? GSTATE[a.status] || [a.status, ""] : ["not connected", "muted"];
    return `<div class="garmin-person" data-gperson="${esc(p.id)}">
      <div class="garmin-head">
        <span class="garmin-who">${avatar(p, 20)} <b>${esc(p.label)}</b></span>
        ${state(st[0], st[1])}
        ${a ? `<span class="hint">key ${esc(a.key_hint || "")} · ${num(a.downloaded)} activities downloaded${a.failed ? ` · ${num(a.failed)} failed` : ""}${a.last_sync_at ? ` · last download ${browserTime(a.last_sync_at)}` : ""}${a.downloaded && !a.backfill_done ? " · history still downloading" : ""}</span>` : ""}
      </div>
      ${a && a.last_error ? `<div class="hint garmin-err">${esc(a.last_error)}</div>` : ""}
      <div class="garmin-form">
        <label><span class="opt-label">Personal API key</span>
          <input type="password" name="gkey" autocomplete="off" spellcheck="false" placeholder="${a ? "Stored — paste a new key to replace it" : "Paste the key from Garmin Connect"}"></label>
        <label><span class="opt-label">Download from</span>
          <input type="date" name="gfrom" value="${esc(a?.history_from || "")}" title="Empty = the whole history"></label>
        <div class="garmin-actions">
          <button class="primary small" data-gsave>${a ? "Save" : "Connect"}</button>
          ${a ? `<button class="small" data-gtest>Test</button><button class="small" data-gremove>Disconnect</button>` : ""}
          <span data-gmsg></span>
        </div>
      </div>
    </div>`;
  };
  const connected = Object.keys(accounts).length;
  const garminCard = `
    <div class="card">
      <h3>Garmin Connect</h3>
      ${hint("Each person connects their own Garmin account with a personal API key. Activities are downloaded as original FIT files in the background, slowly, at the lowest priority.")}
      <ol class="plain steps">
        <li>Sign in to <b>Garmin Connect on the web</b> and open the <b>Personal API key</b> page (account settings).</li>
        <li><b>Create Key</b>, accept the terms and choose how long it stays valid (30 days – 1 year).</li>
        <li>Copy the key — Garmin shows it only once — and paste it below for that person.</li>
      </ol>
      <div class="garmin-people">${people.map(garminRow).join("") || hint("Add people first (Settings › People).")}</div>
      <div class="note"><b>Nothing is downloaded or imported twice.</b> Downloaded activities are remembered, and each activity is recognised by its FIT id, so activities you already imported from a folder or a ZIP are skipped. To save time, set <i>Download from</i> to the day after your last imported activity.</div>
      <div class="note">The key is stored only in Trailbook's database on this Home Assistant and is never shown again. Keys expire — Garmin e-mails a reminder a week before; then paste the new key here. Sleep, HRV, stress and other health data will follow with the Wellbeing tab.</div>
    </div>
    <div class="card">
      <h3>Automatic download</h3>
      ${hint("New activities are checked for every connected person. The first run downloads the newest activities; older ones follow in the next runs (up to 60 activities per run, one request every 3 seconds). If Garmin refuses requests, downloading pauses until the next run.")}
      <select class="field-input" name="scan_interval_min" style="max-width:200px">${s.scan_interval_choices.map((m) =>
        `<option value="${m}" ${m === s.scan_interval_min ? "selected" : ""}>${interval(m)}</option>`).join("")}</select>
      <div>${s.next_scan_at ? state(`Next download at ${browserTime(s.next_scan_at)}`) : state(connected ? "No automatic download scheduled" : "Connect a person first", "warn")}</div>
      <div class="card-row" style="margin-top:12px">
        <button class="primary" data-save="scan_interval_min">Save</button>
        <button data-gsync ${connected ? "" : "disabled"}>Download now</button>
        <span data-msg></span>
      </div>
    </div>`;

  el.innerHTML = `
    <div class="card appearance">
      <h3>Appearance</h3>
      <div class="appearance-grid">
        <div>
          <div class="panel-title">Theme</div>
          ${switchHtml("theme", [["light", `${ICON.sun}<span>Light</span>`], ["dark", `${ICON.moon}<span>Dark</span>`]], document.documentElement.dataset.theme === "dark" ? "dark" : "light")}
        </div>
        <div>
          <div class="panel-title">Accent colour</div>
          <div class="accents">${ACCENTS.map(([k, l, light, dark]) =>
            `<button class="accent-pick ${k === accent ? "on" : ""}" data-accent="${k}" title="${l}" aria-label="${l}"><span style="background:${document.documentElement.dataset.theme === "dark" ? dark : light}"></span><small>${l}</small></button>`).join("")}</div>
        </div>
      </div>
      ${hint("Saved in this browser.")}
    </div>
    <div class="card">
      <h3>Data connection</h3>
      ${hint("Where new activities come from.")}
      <div class="source-grid">
        ${choice("data_source", "garmin", source, "Garmin Connect", "Download automatically for every person with their personal API key. Recommended: the most complete data — the original FIT files plus what only Garmin Connect has (names and edits, weather, training status, Body Battery, sleep score and more).")}
        ${choice("data_source", "upload", source, "Upload a ZIP", "One-time import of a Garmin export or FIT files for a chosen person.")}
        ${choice("data_source", "folder", source, "Watch a folder", "Import FIT files that appear in a folder, e.g. saved by a Home Assistant automation.")}
      </div>
      <span data-source-msg></span>
    </div>
    ${source === "folder" ? folderCards : source === "upload" ? uploadCard : garminCard}`;

  const reload = () => settingsGeneral(el);
  el.querySelectorAll("[data-accent]").forEach((b) => b.onclick = () => {
    store.set("accent", b.dataset.accent);
    applyAccent();
    el.querySelectorAll("[data-accent]").forEach((x) => x.classList.toggle("on", x === b));
  });
  el.querySelectorAll("[data-switch=theme]").forEach((b) => b.onclick = () => {
    document.documentElement.dataset.theme = b.dataset.value;
    store.set("theme", b.dataset.value);
    applyAccent();
    setupTheme();
    reload();
  });
  el.querySelectorAll("input[name=data_source]").forEach((r) => r.onchange = async () => {
    try { await api("settings", { method: "PUT", body: JSON.stringify({ data_source: r.value }) }); reload(); }
    catch (e) { el.querySelector("[data-source-msg]").innerHTML = state(esc(e.message), "bad"); }
  });
  // Watches are shown as soon as "assign by watch" is chosen.
  el.querySelectorAll("input[name=person_mode]").forEach((r) => r.onchange = () => {
    const w = el.querySelector(".watches");
    if (w) w.hidden = r.value !== "devices";
  });
  el.querySelectorAll("select[data-serial]").forEach((sel) => sel.onchange = async () => {
    const out = el.querySelector("[data-watch-msg]");
    try {
      const r = await api("devices/" + sel.dataset.serial, { method: "PATCH", body: JSON.stringify({ person_id: sel.value || null }) });
      out.innerHTML = state(r.moved_activities ? `Saved · ${r.moved_activities} unassigned activit${r.moved_activities === 1 ? "y" : "ies"} moved` : "Saved · applies to new imports", "ok");
    } catch (e) { out.innerHTML = state(esc(e.message), "bad"); }
  });
  el.querySelectorAll("[data-save]").forEach((btn) => btn.onclick = async () => {
    const key = btn.dataset.save, card = btn.closest(".card"), out = card.querySelector("[data-msg]");
    const field = key === "person_mode" ? card.querySelector("input[name=person_mode]:checked") : card.querySelector(`[name=${key}]`);
    const value = key === "scan_interval_min" ? Number(field.value) : field.value;
    try {
      await api("settings", { method: "PUT", body: JSON.stringify({ [key]: value }) });
      out.innerHTML = state("Saved", "ok");
    } catch (e) { out.innerHTML = state(esc(e.message), "bad"); }
  });
  el.querySelectorAll("[data-gperson]").forEach((box) => {
    const pid = box.dataset.gperson, out = box.querySelector("[data-gmsg]");
    const show = (r) => {
      out.innerHTML = r.ok
        ? state(`Connected${r.latest ? ` · newest activity: ${esc(r.latest.name || "")} (${esc((r.latest.start || "").slice(0, 10))})` : ""}`, "ok")
        : state(esc(r.error || "Failed"), "bad");
    };
    box.querySelector("[data-gsave]").onclick = async (e) => {
      const key = box.querySelector("[name=gkey]").value.trim();
      const from = box.querySelector("[name=gfrom]").value || null;
      e.target.disabled = true;
      out.innerHTML = state("Checking the key with Garmin…");
      try {
        const r = await api("garmin/" + encodeURIComponent(pid), { method: "PUT", body: JSON.stringify({ api_key: key, history_from: from }) });
        if (r.ok) { reload(); return; }
        show(r);
      } catch (err) { out.innerHTML = state(esc(err.message), "bad"); }
      e.target.disabled = false;
    };
    const test = box.querySelector("[data-gtest]");
    if (test) test.onclick = async () => {
      out.innerHTML = state("Checking…");
      try { show(await api(`garmin/${encodeURIComponent(pid)}/test`, { method: "POST" })); }
      catch (err) { out.innerHTML = state(esc(err.message), "bad"); }
    };
    const rm = box.querySelector("[data-gremove]");
    if (rm) rm.onclick = async () => {
      if (!confirm("Disconnect this Garmin account? The stored key is deleted; imported activities stay.")) return;
      await api("garmin/" + encodeURIComponent(pid), { method: "DELETE" });
      reload();
    };
  });
  const gsync = el.querySelector("[data-gsync]");
  if (gsync) gsync.onclick = async () => {
    const out = gsync.closest(".card").querySelector("[data-msg]");
    try {
      await api("import/scan", { method: "POST" });
      out.innerHTML = state("Started — progress in Settings › Imported", "ok");
    } catch (e) { out.innerHTML = state(esc(e.message), "bad"); }
  };
  const up = el.querySelector("[data-upload]");
  if (up) up.onclick = async () => {
    const out = el.querySelector("[data-upload-msg]");
    const pid = el.querySelector("[name=upload-person]").value;
    const file = el.querySelector("[name=upload-file]").files[0];
    if (!pid || !file) { out.innerHTML = state("Choose a person and a file", "warn"); return; }
    up.disabled = true;
    out.innerHTML = state(`Uploading ${esc(file.name)} (${num(file.size / 1048576, 1)} MB)…`);
    try {
      const r = await api(`uploads?${new URLSearchParams({ person: pid, name: file.name })}`, { method: "POST", body: file, headers: {} });
      out.innerHTML = state(`Uploaded · ${num(r.queued)} FIT file(s) queued — progress in Settings › Imported`, "ok");
    } catch (e) { out.innerHTML = state(esc(e.message), "bad"); }
    up.disabled = false;
  };
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
        : "Drag rows to set the order used everywhere. The first person is selected by default. Watches are linked to people in Settings › General.")}
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
      <div class="card-row" style="margin-top:12px"><input id="new-label" placeholder="New person's name"><button id="add" class="primary">Add person</button></div>
      <div class="card-row" style="margin-top:8px"><span id="people-msg"></span></div>
    </div>
    <div class="card" hidden>
      <h3>Watches</h3>
      ${hint("FIT files contain no Garmin account id, but every file carries the serial number of the watch that recorded it.")}
      <div class="note"><b>Linking a watch applies to files imported from now on.</b> Activities that already have a person stay where they are; only activities still <i>Unassigned</i> move to the linked person.
        ${byFolder ? "In “one subfolder per person” mode the folder decides; a watch only matters for files lying directly in the watched folder." : ""}</div>
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
      msg(r.moved_activities ? `Watch linked · ${r.moved_activities} unassigned activit${r.moved_activities === 1 ? "y" : "ies"} moved` : "Watch linked · applies to new imports");
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
  el.insertAdjacentHTML("beforeend", `<div data-thresholds></div>`);
  await renderThresholds(el.querySelector("[data-thresholds]"));
}

const FILE_PAGE = 100;
const STATUSES = ["new", "imported", "skipped", "duplicate", "error", "missing", "removed"];
const STATUS_KIND = { error: "bad", missing: "warn", imported: "ok", skipped: "muted", duplicate: "muted", removed: "muted" };

function fileContent(f) {
  if (f.activity_id && f.status !== "duplicate") {
    return `<a class="tb-activity-name" href="#/activity/${f.activity_id}">${typeIcon(f.activity_type)}<span>${esc(f.name || typeLabel(f.activity_type))}</span></a>
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
  const src = st.data_source || "folder";
  const last = st.running || p.state === "running"
    ? (p.phase === "garmin"
      ? state(`Downloading from Garmin: ${num(p.done ?? 0)} activities${p.current ? ` · ${esc(p.current)}` : ""}`, "warn")
      : state(`Running: ${esc(p.phase || "")} ${num(p.done ?? 0)} / ${p.total != null ? num(p.total) : "?"} files`, "warn"))
    : p.state === "failed" ? state(`Last run failed: ${esc(p.error)}`, "bad")
    : p.state === "finished" ? state(`Last run ${browserTime(p.finished_at)} — ${num(p.scanned)} files checked, ${num(p.imported)} imported, ${num(p.skipped)} skipped, ${num(p.duplicates)} duplicates, ${num(p.errors)} errors, ${num(p.missing)} missing`)
    : state("No scan yet");
  const next = src === "upload" ? ""
    : st.scan_interval_min && st.next_scan_at
      ? state(`Automatic ${src === "garmin" ? "download" : "scan"} every ${st.scan_interval_min} min · next at ${browserTime(st.next_scan_at)}`)
      : state(`Automatic ${src === "garmin" ? "download" : "scan"} is off`, "warn");
  const title = { folder: "Folder scan", garmin: "Garmin Connect download", upload: "Uploads" }[src];
  const where = src === "folder" ? `<code>${esc(st.root || "No folder configured")}</code>`
    : src === "garmin" ? `<span class="hint">Activities of every connected person</span>` : `<span class="hint">ZIP and FIT files uploaded in Settings › General</span>`;
  const label = { folder: "Scan folder now", garmin: "Download now", upload: "Process queued uploads" }[src];
  return `<div class="card">
    <h3>${title}</h3>
    <div class="card-row">${where}<a href="#/settings/general">Change</a></div>
    <div class="card-row">${last}</div>
    <div class="card-row">
      <button id="scan" class="primary" ${st.running || (src === "folder" && !st.root) ? "disabled" : ""}>${label}</button>
      ${next}
      ${st.missing_to_review ? state(`${num(st.missing_to_review)} missing file(s) to review`, "warn") : ""}
    </div>
  </div>`;
}

async function settingsImport(el, params) {
  params = { sort: "processed", dir: "desc", ...params };
  const q = { limit: PAGE_SIZE, sort: params.sort, dir: params.dir };
  for (const k of ["status", "person", "file", "content", "recorded", "fit", "processed"]) if (params[k]) q[k] = params[k];
  const fetchPage = (offset) => api("import/files?" + new URLSearchParams({ ...q, offset }));
  const [st, files] = await Promise.all([api("import/status"), fetchPage(0)]);
  const columns = [
    { key: "status", label: "Status", sort: true,
      filter: { type: "select", options: STATUSES.map((x) => [x, `${x} (${num(st.files[x] ?? 0)})`]) },
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
  el.innerHTML = `<div data-scan>${scanCard(st)}</div><div class="card"><h3>Files</h3>${tableHtml(columns, files.items, params, files.total)}</div>`;
  bindTable("#/settings/import", params);
  infinite(el, files.items.length, files.total, async (offset) => (await fetchPage(offset)).items, (items) => {
    el.querySelector("[data-rows]").insertAdjacentHTML("beforeend", items.map((f) => rowHtml(columns, f)).join(""));
  });
  const reload = () => settingsImport(el, params);
  const bindScan = () => {
    el.querySelector("#scan").onclick = async () => {
      await api("import/scan", { method: "POST" }).catch((e) => alert(e.message));
      pollScan();
    };
  };
  // While a scan runs only the scan card refreshes, so the list keeps its scroll position.
  const pollScan = async () => {
    const now = await api("import/status");
    el.querySelector("[data-scan]").innerHTML = scanCard(now);
    bindScan();
    if (now.running) timer = setTimeout(pollScan, 2000);
  };
  bindScan();
  if (st.running) timer = setTimeout(pollScan, 2000);
  el.onclick = async (e) => {
    const b = e.target.closest("[data-retry], [data-keep], [data-del], [data-forget]");
    if (!b) return;
    if (b.dataset.retry) { await api(`import/files/${b.dataset.retry}/retry`, { method: "POST" }); return reload(); }
    if (b.dataset.keep) { await api(`import/files/${b.dataset.keep}/dismiss`, { method: "POST" }); return reload(); }
    if (b.dataset.del) {
      if (!confirm("Delete this activity from the database? The file stays in the history as 'removed' and will not be imported again.")) return;
      await api(`activities/${b.dataset.del}`, { method: "DELETE" }); return reload();
    }
    const msg = b.dataset.owner === "1"
      ? "Remove this file from the import history?\n\nIts activity is deleted too and will be rebuilt from the file on the next folder scan (manual type changes are lost)."
      : "Remove this file from the import history?\n\nThe next folder scan will process it again.";
    if (!confirm(msg)) return;
    await api(`import/files/${b.dataset.forget}`, { method: "DELETE" });
    b.closest("tr")?.remove();
  };
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
        <td>${esc(groupLabel(t.group))}</td><td><span class="tb-activity-name">${typeIcon(t.key)}<b>${esc(t.en)}</b></span> <code class="hint">${t.key}</code></td>
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
  stopObservers();
  disposeMap();
  document.body.classList.remove("fullmap");
  const [path, query] = (location.hash.slice(1) || "/activities").split("?");
  const params = Object.fromEntries(new URLSearchParams(query || ""));
  const parts = path.split("/").filter(Boolean);
  try {
    TYPES ??= await api("types");
    PERSONS = await api("persons");
    if (CURRENT === null || (CURRENT !== "all" && !person(CURRENT))) CURRENT = pickDefaultPerson();
    let section = parts[0] === "activity" ? "activities" : parts[0] || "activities";
    // Views that only make sense for one person / for everyone.
    if (CURRENT === "all" && (section === "fitness" || section === "stats" || section === "wellbeing")) { location.hash = "#/compare"; return; }
    if (CURRENT !== "all" && section === "compare") { location.hash = "#/activities"; return; }
    TYPE_COUNTS = await api("types/counts" + (CURRENT && CURRENT !== "all" ? "?" + new URLSearchParams({ person: CURRENT }) : ""));
    renderHeader(section);
    document.documentElement.style.setProperty("--header-h", document.querySelector("header").offsetHeight + "px");
    if (parts[0] === "activity") await renderActivity(parts[1]);
    else if (section === "settings") await renderSettings(parts[1], params);
    else if (section === "compare") await renderCompare(params);
    else if (section === "heatmap") await renderHeatmap(params);
    else if (section === "calendar") await renderCalendar(params);
    else if (section === "fitness") await renderFitness(params);
    else if (section === "stats") await renderStats(params);
    else if (PLANNED[section]) renderPlanned(section);
    else await renderActivities(params);
  } catch (e) {
    view.innerHTML = `<div class="card">${state("Error: " + esc(e.message), "bad")}</div>`;
  }
}

applyAccent();
window.addEventListener("hashchange", route);
// Pages in training.js are loaded after this file; start once every script is in.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", route);
else route();
