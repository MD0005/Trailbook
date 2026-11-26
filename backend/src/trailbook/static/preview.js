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
let PAIR = null; // the two person ids compared (CURRENT is then "all"), else null
let timer = null;
// Tab state: views and toggles that start from fixed defaults every time a tab is entered
// (Activities → Tiles, Map → Heatmap, Summary off). Cleared when the tab changes.
const TAB = {};
let LAST_SECTION = null;
// UI settings the user changes (Map options…), per person on the server (`/api/ui-settings`).
const UI = { person: null, data: {} };
let uiSaveTimer = null;
function saveUi(key, value) {
  UI.data[key] = value;
  const person = UI.person || "all";
  clearTimeout(uiSaveTimer);
  uiSaveTimer = setTimeout(() => api(`ui-settings/${key}?${new URLSearchParams({ person })}`,
    { method: "PUT", body: JSON.stringify(value) }).catch(() => {}), 400);
}

const api = async (path, opts = {}) => {
  const res = await fetch("api/" + path, {
    headers: { "Content-Type": "application/json" }, ...opts,
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && body.login) location.reload();  // outside HA: back to the login page
  else if (res.status === 401 && document.documentElement.classList.contains("embed-page")) {
    window.parent.postMessage({ trailbook: "auth" }, "*"); // a Home Assistant card renews its session
  }
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
  pencil: svg(`<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16Z"/><path d="m13.5 6.5 4 4"/>`),
  back: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 4 6 12l11 8Z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  chevLeft: svg(`<path d="M15 6l-6 6 6 6"/>`),
  chevRight: svg(`<path d="M9 6l6 6-6 6"/>`),
  trash: svg(`<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>`),
  sun: svg(`<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`),
  moon: svg(`<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>`),
  help: svg(`<circle cx="12" cy="12" r="9.5"/><path d="M9.3 9.2a2.8 2.8 0 0 1 5.4 1c0 1.9-2.7 2.4-2.7 4.1"/><circle cx="12" cy="17.6" r=".4" fill="currentColor"/>`),
  // Home Assistant's mark: the house (no eaves) with the tree of three nodes inside
  ha: svg(`<path d="M12 2.6 21.2 10.6V21.2H2.8V10.6Z"/><path d="M12 21.2V10.6M12 16.2l-3.1-3M12 18.4l3.1-3"/><circle cx="12" cy="9.1" r="1.5" fill="currentColor" stroke="none"/><circle cx="8" cy="12.3" r="1.5" fill="currentColor" stroke="none"/><circle cx="16" cy="14.5" r="1.5" fill="currentColor" stroke="none"/>`),
  gear: svg(`<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>`),
  list: svg(`<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>`),
  tilesSmall: svg(`<rect x="3" y="3" width="18" height="18" rx="3.5"/><path d="M7.5 17v-3.5M10.5 17v-7M13.5 17v-5M16.5 17v-9" stroke-width="2.2"/>`),
  tilesLarge: svg(`<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>`),
  grip: svg(`<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>`),
  chevron: svg(`<path d="M6 9l6 6 6-6"/>`),
  swap: svg(`<path d="M3 12h18M8 7l-5 5 5 5M16 7l5 5-5 5"/>`),
  sliders: svg(`<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>`),
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
// Numbers: decimal comma, space between thousands (1 234,56) — everywhere in the app.
const num = (v, digits = 0) => Number(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).replace(/,/g, " ").replace(".", ",");
const unit = (v, u, digits = 0) => (v == null ? "–" : `${num(v, digits)} ${u}`);
const km = (m) => (m == null ? "–" : `${num(m / 1000, 2)} km`); // distance: always 2 decimals
const kmh = (ms) => (ms == null ? "–" : `${num(ms * 3.6, 1)} km/h`); // a speed in m/s
const bpm = (v) => unit(v, "bpm");
const meters = (v) => unit(v, "m");
const watts = (v) => unit(v, "W");
const kcal = (v) => unit(v, "kcal");
const cadence = (v, group) => unit(v, ["run", "walk", "hike"].includes(group) ? "spm" : "rpm");
const dur = (s) => {
  if (s == null) return "–";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}min` : `${m}min ${String(sec).padStart(2, "0")}s`;
};
// Hours and minutes, no seconds (rounded to the minute): "37min", "10h 35min".
const durMin = (s) => (s == null ? "–" : dur(Math.round(s / 60) * 60).replace(/ 00s$/, ""));
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
// Workout kind (Easy, Long, Tempo…): the person's choice, else the detected one.
const workoutLabel = (key) => TYPES?.workouts?.find((w) => w.key === key)?.en ?? key;
const workoutOf = (a) => a.workout_override || a.workout;
// Activity type icons (assets/icons, “Trailbook B”): small next to names in lists and
// filters, larger only in Activities › tiles. Unknown types fall back to “other”.
const typeIcon = (key, size = 18) => (OWN_TYPE_ICONS[key]
  ? `<svg class="tb-activity-icon" viewBox="0 0 24 24" fill="none" stroke="none" width="${size}" height="${size}" style="--tb-icon-size:${size}px" focusable="false" aria-hidden="true">${OWN_TYPE_ICONS[key]}</svg>`
  : window.TrailbookIcons ? TrailbookIcons.render(key, { size }) : "");
// Own replacements for weak drawings of the set (same runner as `run`).
const OWN_TYPE_ICONS = {
  // runner on a treadmill: deck with rollers and a handrail in front
  treadmill_run: `<g transform="translate(-1 -0.5) scale(.78)"><circle cx="16.2" cy="3.5" r="2" fill="currentColor"/>
    <path fill="currentColor" d="M13 6.5c1.4-.5 3 .8 2.3 2.2l-3.7 6.1-3-1.9 3.2-5.3c.3-.5.7-.9 1.2-1.1Z"/>
    <path d="m14.1 8 2.5 3L20 9M13 7.7 9 7 6.6 10M10.3 13.2l4.7 3-1.5 4.8M10 13.5 6.5 17 3 15.5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></g>
    <rect x="1.5" y="17.2" width="16" height="3.6" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.8"/>
    <path d="M17 17.2 19.6 7.5h2.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="4.2" cy="19" r=".9" fill="currentColor"/><circle cx="14.8" cy="19" r=".9" fill="currentColor"/>`,
};
const typeName = (key, text = typeLabel(key), size = 18) =>
  `<span class="tb-activity-name">${typeIcon(key, size)}<span>${esc(text)}</span></span>`;
// Group rows use the icon of the group's main type (run, ride, swim, …) when there is one.
const groupIcon = (g, size = 18) => typeIcon(window.TrailbookIcons?.keys?.includes(g) ? g : (TYPES.types.find((t) => t.group === g)?.key || "other"), size);
const groupLabel = (key) => TYPES?.groups.find((g) => g.key === key)?.en ?? key;
// Metric icons (assets/metric-icons, 20 or 32 px), coloured by metric group — docs/ICONS.md.
const METRIC_COLOR = {
  power: ["power", "avg_power", "max_power", "normalized_power", "total_work", "intensity_factor",
    "training_stress_score", "time_in_power_zone"],
  heart: ["heart_rate", "avg_heart_rate", "min_heart_rate", "max_heart_rate", "time_in_hr_zone",
    "rr_intervals", "hrv", "rmssd", "sdrr"],
  sleep: ["sleep"],
  breath: ["respiration_rate", "avg_respiration_rate", "min_respiration_rate", "max_respiration_rate"],
  temp: ["temperature", "core_temperature", "feels_like"],
  speed: ["speed", "avg_speed", "max_speed", "pace", "avg_pace", "best_pace", "grade_adjusted_speed", "grade_adjusted_pace"],
  elev: ["altitude", "min_altitude", "max_altitude", "total_ascent", "total_descent", "grade", "vertical_speed", "vam"],
  cadence: ["cadence", "avg_cadence", "max_cadence", "steps", "cycles", "crank_revolutions", "swim_strokes", "wheelchair_pushes"],
  energy: ["calories", "active_calories", "resting_calories", "metabolic_calories", "fat_calories"],
  oxygen: ["spo2", "muscle_oxygen", "hemoglobin"],
};
const metricGroup = (key) => Object.keys(METRIC_COLOR).find((g) => METRIC_COLOR[g].includes(key));
// Trailbook's own drawings in the style of the set (24 grid, 2.1 stroke, round joins):
// icons the set lacks (sleep, type, name) and replacements for weak ones.
const iconLine = (w = 2.1) => `fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;
const OWN_ICONS = {
  sleep: `<path d="M20 13.5A8 8 0 1 1 10.5 4a6.2 6.2 0 0 0 9.5 9.5Z" ${iconLine()}/><path d="M15 4h3l-3 3.5h3" ${iconLine(1.6)}/>`,
  // calendar with one day marked
  date: `<rect x="3.5" y="5" width="17" height="15.5" rx="2.5" ${iconLine()}/><path d="M8 3v4M16 3v4M3.5 10h17" ${iconLine()}/><circle cx="15.5" cy="15.5" r="1.9" fill="currentColor"/>`,
  // activity type: four kinds of shapes
  type: `<circle cx="7.5" cy="7.5" r="3.5" ${iconLine()}/><rect x="13" y="4" width="7" height="7" rx="1.5" ${iconLine()}/><path d="M7.5 13.5 11 20H4Z" ${iconLine()}/><path d="m16.5 13 3.5 3.5-3.5 3.5-3.5-3.5Z" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>`,
  // name: a title letter and text lines
  name: `<path d="M3.5 5.5h11M9 5.5v13" ${iconLine()}/><path d="M14 13h6.5M14 17.5h6.5" ${iconLine()}/>`,
  // heart with a pulse line through it
  avg_heart_rate: `<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20Z" ${iconLine()}/><path d="M2.5 12.5h5l1.5-2.5 2.5 5 2-3.5 1 1h7" ${iconLine(1.8)}/>`,
  // stopwatch with motion lines
  timer_time: `<circle cx="14" cy="13.5" r="7" ${iconLine()}/><path d="M12 3.5h4M14 3.5v3M14 13.5v-3.5M14 13.5l2.5 1.5" ${iconLine()}/><path d="M2.5 10h3M2 13.5h2.5M2.5 17h3" ${iconLine(1.8)}/>`,
  // mountain profile with an arrow up / down
  total_ascent: `<path d="M2.5 20 9 9.5l3.5 5.5 2-2.5 5 7.5Z" ${iconLine()}/><path d="M18.5 9.5V3M16 5.5 18.5 3 21 5.5" ${iconLine()}/>`,
  total_descent: `<path d="M2.5 20 9 9.5l3.5 5.5 2-2.5 5 7.5Z" ${iconLine()}/><path d="M18.5 3v6.5M16 7l2.5 2.5L21 7" ${iconLine()}/>`,
  // explorer tiles: a grid of squares, one of them filled (a new tile)
  tiles: `<rect x="3.5" y="3.5" width="7" height="7" rx="1.2" ${iconLine()}/><rect x="13.5" y="3.5" width="7" height="7" rx="1.2" ${iconLine()}/><rect x="3.5" y="13.5" width="7" height="7" rx="1.2" ${iconLine()}/><rect x="13.5" y="13.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round"/>`,
  // speedometer
  avg_pace: `<path d="M4.2 18.5a8.8 8.8 0 1 1 15.6 0" ${iconLine()}/><path d="M12 15.5 16.5 10" ${iconLine()}/><circle cx="12" cy="15.5" r="1.9" fill="currentColor"/><path d="M12 6.5v1.6M6.4 9.3l1.1 1.1M17.6 9.3l-1.1 1.1" ${iconLine(1.8)}/>`,
};
const metricIcon = (key, size = 20) => {
  const g = metricGroup(key), cls = `tb-metric-icon${g ? " m-" + g : ""}`;
  if (OWN_ICONS[key]) return `<svg class="${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" style="--tb-metric-size:${size}px" aria-hidden="true">${OWN_ICONS[key]}</svg>`;
  if (!window.TrailbookMetricIcons) return "";
  return TrailbookMetricIcons.render(key, { size }).replace('class="tb-metric-icon"', `class="${cls}"`);
};
// FIT files that are not activities (Settings › Imported): FIT file type → metric icon.
const FIT_TYPE_ICON = {
  sleep: "sleep", hrv: "hrv", respiration: "respiration_rate", skin_temperature: "temperature",
  health_snapshot: "heart_rate", blood_pressure: "heart_rate",
  monitoring_a: "steps", monitoring_b: "steps", monitoring_daily: "steps",
  totals: "distance_total", activity_summary: "distance_total", workout: "interval_time",
  course: "route", segment: "route", segment_list: "route",
  device: "watch", settings: "watch", sport: "watch", exd_configuration: "watch", schedules: "date",
};
const person = (id) => PERSONS.find((p) => p.id === id);
const personLabel = (id) => person(id)?.label ?? id;
const personColor = (p, i = 0) => p?.color || PERSON_COLORS[i % PERSON_COLORS.length];
const hint = (text) => `<div class="hint">${text}</div>`;

// File input with the same look as the other buttons; the native input stays (hidden), so
// `input.files` works as before.
const filePicker = (name, accept, multiple = false) => `<span class="file-pick"><input type="file" name="${name}" accept="${accept}" ${multiple ? "multiple" : ""} hidden><button type="button" data-file-pick>${multiple ? "Choose files…" : "Choose file…"}</button><span class="hint" data-file-name></span></span>`;
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-file-pick]");
  if (b) b.parentElement.querySelector("input[type=file]").click();
});
document.addEventListener("change", (e) => {
  if (!e.target.matches(".file-pick input[type=file]")) return;
  const files = e.target.files;
  e.target.parentElement.querySelector("[data-file-name]").textContent = files.length > 1 ? `${num(files.length)} files` : files[0]?.name || "";
});
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
  { key: "segments", label: "Segments" },
  { key: "fitness", label: "Fitness", single: true },
  { key: "wellbeing", label: "Wellbeing", single: true },
  { key: "stats", label: "Statistics", single: true },
];
// What a pair of people has: the other tabs are not built for two yet.
const PAIR_PAGES = ["activities", "settings", "manual", "ha"];

const realPeople = () => PERSONS.filter((p) => p.id !== "_unassigned");

// Every two people, in the order set in Settings › People.
const personPairs = () => realPeople().flatMap((a, i, all) => all.slice(i + 1).map((b) => [a.id, b.id]));
const pairKey = (ids) => "pair:" + JSON.stringify([...ids].sort());
const pairAvatars = (ids, size = 26) => `<span class="pair-avatars">${avatar(person(ids[0]), size)}${ICON.swap}${avatar(person(ids[1]), size)}</span>`;

// A choice of the picker: a person id or the key of a pair.
function selectPeople(value) {
  PAIR = personPairs().find((ids) => pairKey(ids) === value) || null;
  CURRENT = PAIR ? "all" : value;
}

function pickDefaultPerson() {
  const saved = store.get("person");
  if (saved && (person(saved) || personPairs().some((ids) => pairKey(ids) === saved))) return saved;
  return realPeople()[0]?.id ?? "all";
}

// The selection still stands (people renamed, reordered or removed meanwhile).
function keepSelection() {
  if (PAIR) selectPeople(pairKey(PAIR));
  if (!PAIR && !(CURRENT && person(CURRENT))) selectPeople(pickDefaultPerson());
}

function renderHeader(section) {
  const isAll = CURRENT === "all";
  document.getElementById("nav").innerHTML = NAV
    .filter((n) => (PAIR ? PAIR_PAGES.includes(n.key) : !(n.single && isAll)))
    .map((n) => `<a href="#/${n.key}" class="${section === n.key ? "active" : ""}">${n.label}</a>`).join("");
  const cur = isAll ? null : person(CURRENT);
  const options = realPeople().map((p) => `<button class="menu-item ${p.id === CURRENT ? "active" : ""}" data-person="${esc(p.id)}">${avatar(p, 22)} ${esc(p.label)}</button>`).join("");
  const names = (ids) => ids.map((id) => personLabel(id)).join(" and ");
  const pairs = personPairs().map((ids) => `<button class="menu-item ${PAIR && pairKey(ids) === pairKey(PAIR) ? "active" : ""}" data-person="${esc(pairKey(ids))}" title="Compare ${esc(names(ids))}">${pairAvatars(ids, 22)} Compare</button>`).join("");
  document.getElementById("tools").innerHTML = `
    <div class="picker">
      <button id="person-btn" class="picker-btn" title="${PAIR ? `Compare ${esc(names(PAIR))}` : "Choose person"}">${PAIR ? pairAvatars(PAIR) : avatar(cur)} <span>${PAIR ? "Compare" : esc(cur ? cur.label : "No people")}</span> ${ICON.chevron}</button>
      <div id="person-menu" class="menu" hidden>
        ${options}
        ${pairs}
      </div>
    </div>
    <button id="theme" class="icon" aria-label="Switch theme"></button>
    <a href="#/manual" class="icon-link ${section === "manual" ? "active" : ""}" title="Manual" aria-label="Manual">${ICON.help}</a>
    <a href="#/ha" class="icon-link ${section === "ha" ? "active" : ""}" title="Home Assistant" aria-label="Home Assistant">${ICON.ha}</a>
    <a href="#/settings" class="icon-link ${section === "settings" ? "active" : ""}" title="Settings" aria-label="Settings">${ICON.gear}</a>`;
  const menu = document.getElementById("person-menu");
  document.getElementById("person-btn").onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener("click", () => { menu.hidden = true; }, { once: true });
  menu.querySelectorAll("[data-person]").forEach((b) => b.onclick = () => {
    selectPeople(b.dataset.person);
    store.set("person", b.dataset.person);
    setMenu(false);
    // the page of a shared activity belongs to its pair, an activity page to a person
    if (location.hash.startsWith("#/together/") || (PAIR && location.hash.startsWith("#/activity/"))) location.hash = "#/activities";
    else route();
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
// Waiting: a cyclist riding along a road (wheels turning, the road passing under), with a small
// label. Used while a page takes long to load and at the end of lists that load more on scroll.
// Waiting: a road cyclist leaning to the bar, the wheels turning, the legs pedalling round the
// crank (knee worked out from thigh and shin length; frames made by a small script, SMIL).
function loaderHtml(label = "Loading…") {
  return `<div class="loader" role="status" aria-live="polite">
    <svg class="loader-bike" viewBox="0 0 72 44" aria-hidden="true">
      <line class="loader-road" x1="0" y1="40.5" x2="72" y2="40.5"/>
      <g class="loader-ride">
        <path class="loader-leg far" d="M29.6 12.6L37.1 22.5L28.4 31L31 31.3"><animate attributeName="d" dur="0.9s" repeatCount="indefinite" values="M29.6 12.6L37.1 22.5L28.4 31L31 31.3;M29.6 12.6L38.2 21.5L28.8 29.2L31.4 29.5;M29.6 12.6L39.4 20.2L29.7 27.7L32.3 28;M29.6 12.6L40.4 18.7L31.2 26.8L33.8 27.1;M29.6 12.6L41.1 17.3L33 26.4L35.6 26.7;M29.6 12.6L41.4 16.5L34.8 26.8L37.4 27.1;M29.6 12.6L41.3 16.6L36.3 27.7L38.9 28;M29.6 12.6L40.9 17.6L37.2 29.2L39.8 29.5;M29.6 12.6L40.2 19.1L37.6 31L40.2 31.3;M29.6 12.6L39 20.7L37.2 32.8L39.8 33.1;M29.6 12.6L37.5 22.1L36.3 34.3L38.9 34.6;M29.6 12.6L36.1 23.1L34.8 35.2L37.4 35.5;M29.6 12.6L35.3 23.6L33 35.6L35.6 35.9;M29.6 12.6L35.1 23.7L31.2 35.2L33.8 35.5;M29.6 12.6L35.5 23.5L29.7 34.3L32.3 34.6;M29.6 12.6L36.2 23.1L28.8 32.8L31.4 33.1;M29.6 12.6L37.1 22.5L28.4 31L31 31.3"/></path>
        <g class="loader-wheel"><circle cx="16" cy="31" r="9"/><path d="M16 22v18M7 31h18M9.6 24.6l12.8 12.8M22.4 24.6 9.6 37.4"/></g>
        <g class="loader-wheel"><circle cx="56" cy="31" r="9"/><path d="M56 22v18M47 31h18M49.6 24.6l12.8 12.8M62.4 24.6 49.6 37.4"/></g>
        <path class="loader-frame" d="M16 31H33L30.4 19ZM30.4 19H49M33 31 48.6 23.2M49 19l-.5 4.2L56 31M30.4 19l-.9-5.6M26.6 13.4h5.4M49 19l1.6-3.6h3q1.6 0 1.6 1.7v1.8"/>
        <path class="loader-crank" d="M28.4 31L37.6 31"><animate attributeName="d" dur="0.9s" repeatCount="indefinite" values="M28.4 31L37.6 31;M28.8 29.2L37.2 32.8;M29.7 27.7L36.3 34.3;M31.2 26.8L34.8 35.2;M33 26.4L33 35.6;M34.8 26.8L31.2 35.2;M36.3 27.7L29.7 34.3;M37.2 29.2L28.8 32.8;M37.6 31L28.4 31;M37.2 32.8L28.8 29.2;M36.3 34.3L29.7 27.7;M34.8 35.2L31.2 26.8;M33 35.6L33 26.4;M31.2 35.2L34.8 26.8;M29.7 34.3L36.3 27.7;M28.8 32.8L37.2 29.2;M28.4 31L37.6 31"/></path>
        <path class="loader-rider" d="M29.6 12.6Q35.6 6.4 43.2 7.6M43.2 7.6 47 11.4 53.4 15.4"/><circle class="loader-head" cx="47" cy="4.2" r="3"/>
        <path class="loader-leg" d="M29.6 12.6L40.2 19.1L37.6 31L40.2 31.3"><animate attributeName="d" dur="0.9s" repeatCount="indefinite" values="M29.6 12.6L40.2 19.1L37.6 31L40.2 31.3;M29.6 12.6L39 20.7L37.2 32.8L39.8 33.1;M29.6 12.6L37.5 22.1L36.3 34.3L38.9 34.6;M29.6 12.6L36.1 23.1L34.8 35.2L37.4 35.5;M29.6 12.6L35.3 23.6L33 35.6L35.6 35.9;M29.6 12.6L35.1 23.7L31.2 35.2L33.8 35.5;M29.6 12.6L35.5 23.5L29.7 34.3L32.3 34.6;M29.6 12.6L36.2 23.1L28.8 32.8L31.4 33.1;M29.6 12.6L37.1 22.5L28.4 31L31 31.3;M29.6 12.6L38.2 21.5L28.8 29.2L31.4 29.5;M29.6 12.6L39.4 20.2L29.7 27.7L32.3 28;M29.6 12.6L40.4 18.7L31.2 26.8L33.8 27.1;M29.6 12.6L41.1 17.3L33 26.4L35.6 26.7;M29.6 12.6L41.4 16.5L34.8 26.8L37.4 27.1;M29.6 12.6L41.3 16.6L36.3 27.7L38.9 28;M29.6 12.6L40.9 17.6L37.2 29.2L39.8 29.5;M29.6 12.6L40.2 19.1L37.6 31L40.2 31.3"/></path>
      </g>
    </svg>
    <span class="hint">${label}</span></div>`;
}

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
    const label = c.icon ? `<span class="th-icon">${metricIcon(c.icon)}${esc(c.label)}</span>` : esc(c.label);
    const cls = c.num ? "num" : "";
    if (!c.sort) return `<th class="${cls}">${label}</th>`;
    const active = sort === c.key;
    const arrow = active ? (dir === "asc" ? "▲" : "▼") : "↕";
    return `<th class="${cls}"><a href="#" class="sort ${active ? "active" : ""}" data-sort="${c.key}">${label} <span class="arrow">${arrow}</span></a></th>`;
  }).join("");
  const filters = columns.map((c) => (c.filter ? `<th>${filterControl(c, params)}</th>` : "<th></th>")).join("");
  const body = rows.length ? rows.map((r) => rowHtml(columns, r)).join("")
    : `<tr><td colspan="${columns.length}" class="hint">Nothing matches the filters.</td></tr>`;
  return listBar(columns, params, rows.length, total) + `
    <div class="scroll"><table class="data" data-spread>
      <thead><tr>${head}</tr>${columns.some((c) => c.filter) ? `<tr class="filters-row">${filters}</tr>` : ""}</thead>
      <tbody data-rows>${body}</tbody></table></div>
    ${rows.length < total ? `<div class="sentinel" data-sentinel>${loaderHtml()}</div>` : ""}`;
}

// Spare table width as equal visible gaps. Text columns are left-aligned (room shows on their
// right), number columns right-aligned (room on their left), so the gap between columns i and
// i+1 goes to whichever side is free; between a number and a text column neither is, so the
// text column gets it as left padding. `right[i]`: column i is right-aligned. The gap after the
// first column is left alone.
function gapPlan(natural, right, avail) {
  const n = natural.length, widths = [...natural], pads = Array(n).fill(0);
  if (n < 3) return { widths, pads };
  const g = Math.max(0, avail - natural.reduce((s, w) => s + w, 0)) / (n - 2);
  for (let i = 1; i < n - 1; i++) {
    if (!right[i]) widths[i] += g;
    else if (right[i + 1]) widths[i + 1] += g;
    else { widths[i + 1] += g; pads[i + 1] += g; }
  }
  return { widths, pads };
}
// Rows with one cell per column (not colspan title rows) of a table.
const fullRows = (table, n) => [...table.rows].filter((r) => r.cells.length === n);
function clearGapPads(table) {
  [...table.rows].forEach((r) => [...r.cells].forEach((c) => { c.style.paddingLeft = ""; }));
}
function setGapPads(table, pads) {
  pads.forEach((p, i) => {
    if (!p) return;
    fullRows(table, pads.length).forEach((r) => {
      const c = r.cells[i];
      c.style.paddingLeft = `${parseFloat(getComputedStyle(c).paddingLeft) + p}px`;
    });
  });
}

// Column widths of a list table: each column as wide as its content, the spare width split
// as equal visible gaps between the contents of neighbouring columns (the first column stays
// next to the second). Done again when the table's box resizes or rows are added.
function spreadColumns(table) {
  const ths = [...table.tHead.rows[0].cells];
  const wrap = table.parentElement;
  const fit = () => {
    if (!table.isConnected || !wrap.clientWidth) return;
    ths.forEach((th) => { th.style.width = ""; });
    clearGapPads(table);
    table.style.width = "max-content"; // not "auto": the 100 % wide filter inputs would stretch it
    const natural = ths.map((th) => th.getBoundingClientRect().width);
    table.style.width = "";
    const { widths, pads } = gapPlan(natural, ths.map((th) => th.classList.contains("num")), wrap.clientWidth);
    ths.forEach((th, i) => { th.style.boxSizing = "border-box"; th.style.width = `${widths[i]}px`; });
    setGapPads(table, pads);
  };
  let frame = 0;
  const later = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); };
  new ResizeObserver(later).observe(wrap);
  new MutationObserver(later).observe(table.tBodies[0], { childList: true });
  fit();
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
  const icon = (v) => (!v || v.startsWith("g:") ? "" : typeIcon(v)); // groups have no icon
  // Only types that have activities (plus the current choice), each with its count.
  const n = (k) => TYPE_COUNTS[k] || 0;
  const item = (v, text, ic, cls = "", count = null) =>
    `<button type="button" class="tpick-item ${cls} ${v === value ? "on" : ""}" data-v="${esc(v)}" data-search="${esc(text.toLowerCase())}">${ic}<span>${esc(text)}</span>${count != null ? `<small class="tpick-n">${num(count)}</small>` : ""}</button>`;
  const groups = TYPES.groups.map((g) => {
    const types = TYPES.types.filter((t) => t.group === g.key && (n(t.key) > 0 || t.key === value));
    if (!types.length && value !== `g:${g.key}`) return "";
    const total = types.reduce((sum, t) => sum + n(t.key), 0);
    return `<div class="tpick-group" data-group>${item(`g:${g.key}`, `All ${g.en.toLowerCase()}`, "", "grp", total)}
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
  view.querySelectorAll("table[data-spread]").forEach(spreadColumns);
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


const kpi = (label, value) => `<div class="kpi"><span class="hint">${label}</span><b>${value}</b></div>`;

// Compact summary strip: label, value, optional small note under it.
function statStrip(items, cls = "") {
  return `<div class="stat-strip ${cls}">${items.map(([label, value, note]) => `<div class="stat-item">
      <span class="stat-label">${label}</span><span class="stat-value">${value}</span>${note ? `<span class="stat-note">${note}</span>` : ""}
    </div>`).join("")}</div>`;
}

// ---- Activities ---------------------------------------------------------------------

// Tiles: the route on a static map; Charts: smaller tiles with a chart of the training type (tilechart.py).
const VIEWS = [["large", "Tiles", ICON.tilesLarge], ["small", "Charts", ICON.tilesSmall], ["list", "List", ICON.list]];
// Two people: only the activities they did together (together.js), without Charts.
const PAIR_VIEWS = VIEWS.filter(([k]) => k !== "small");

// Small chart filling a large tile (tilechart.py), no numbers, the colours of the activity charts:
// heart rate blocks (Intervals: the sections; Easy, Long, Tempo, Race, games: stretches of one
// zone), Hills - the altitude profile in green with the climbs darker, Commute - the route alone
// in the heart rate zone colours; without the data - speed over time.
// A climb on a Hills tile: a rise of at least min_m metres and this share of the profile's
// height (Manual › Activity charts reads the same values).
const TILE_CLIMB = { min_m: 5, share: 0.12 };
function tileChart(tc) {
  const W = 400, H = 160, svg = (body) => `<svg class="tile-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${body}</svg>`;
  if (!tc) return `<span class="hint">no chart data</span>`;
  const zoneColor = (z, n) => (!z ? "var(--muted)" : tc.power ? powerZoneColor(z) : rampColor(ROUTE_SCALES.hr.stops, n > 1 ? (z - 1) / (n - 1) : 0));
  if (tc.kind === "blocks") {
    // blocks side by side (no gaps), height = heart rate from the resting to the maximum, a
    // dashed line at the average heart rate. Each block: its zone colour under a light vertical
    // gloss (lighter at the top) and a faint shadow along its left edge, so two blocks of one
    // zone side by side still read as two.
    const n = tc.zones || 5;
    const defs = `<defs><linearGradient id="tb-gloss" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fff" stop-opacity=".38"/><stop offset=".45" stop-color="#fff" stop-opacity=".08"/>
        <stop offset="1" stop-color="#000" stop-opacity=".06"/></linearGradient>
      <linearGradient id="tb-edge" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#000" stop-opacity=".13"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient></defs>`;
    const rects = tc.bars.map(([x0, x1, h, z], k) => {
      const bh = Math.max(2, h * H), x = (x0 * W).toFixed(2), y = (H - bh).toFixed(2), w = ((x1 - x0) * W + 0.4).toFixed(2);
      const edge = k ? `<rect x="${x}" y="${y}" width="${Math.min(4, (x1 - x0) * W * 0.3).toFixed(2)}" height="${bh.toFixed(2)}" fill="url(#tb-edge)"/>` : "";
      return `<rect x="${x}" y="${y}" width="${w}" height="${bh.toFixed(2)}" fill="${zoneColor(z, n)}"/>
        <rect x="${x}" y="${y}" width="${w}" height="${bh.toFixed(2)}" fill="url(#tb-gloss)"/>${edge}`;
    }).join("");
    const avg = tc.avg ? `<line x1="0" x2="${W}" y1="${(H - tc.avg * H).toFixed(1)}" y2="${(H - tc.avg * H).toFixed(1)}" stroke="var(--fg)" stroke-opacity=".18" stroke-width=".7" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>` : "";
    return svg(defs + rects + avg);
  }
  if (tc.kind === "track") {
    // the route alone, like a map without the map: a thick line in the heart rate zone colours
    // on a plain background, kept in proportion and centred
    const n = tc.zones || 5, pad = 14, s = Math.min((W - 2 * pad) / (tc.w || 1), (H - 2 * pad) / (tc.h || 1));
    const ox = (W - (tc.w || 0) * s) / 2, oy = (H - (tc.h || 0) * s) / 2;
    const P = ([x, y]) => `${(ox + x * s).toFixed(1)},${(H - oy - y * s).toFixed(1)}`;
    const all = tc.pts.map(P).join(" "), anyZone = tc.pts.some((q) => q[2]);
    let segs = "";
    for (let i = 1; i < tc.pts.length; i++) {
      // below zone 1 in the zone 1 colour (a grey line disappears on the background); no heart
      // rate anywhere (a ride without an HR strap, motor sports): one plain zone 1 green
      const col = anyZone ? zoneColor(tc.pts[i][2] || 1, n) : ROUTE_SCALES.hr.stops[0];
      segs += `<line x1="${P(tc.pts[i - 1]).replace(",", '" y1="')}" x2="${P(tc.pts[i]).replace(",", '" y2="')}" stroke="${col}"/>`;
    }
    return `<svg class="tile-chart tile-trace" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      <polyline points="${all}" fill="none" stroke="var(--surface)" stroke-width="13" stroke-linejoin="round" stroke-linecap="round"/>
      <g stroke-width="8" stroke-linecap="round">${segs}</g></svg>`;
  }
  const vals = tc.alt || tc.speed || [];
  if (vals.filter((v) => v != null).length < 2) return `<span class="hint">no chart data</span>`;
  const known = vals.filter((v) => v != null), lo = Math.min(...known), hi = Math.max(...known), pad = (hi - lo) * 0.08 || 1;
  const X = (i) => (i / (vals.length - 1)) * W, Y = (v) => H - ((v - lo + pad) / (hi - lo + 2 * pad)) * H;
  const path = (a, b) => {
    let d = "";
    for (let i = a; i <= b; i++) if (vals[i] != null) d += `${d ? "L" : "M"}${X(i).toFixed(1)},${Y(vals[i]).toFixed(1)}`;
    return d;
  };
  const area = (a, b) => `${path(a, b)}L${X(b).toFixed(1)},${H}L${X(a).toFixed(1)},${H}Z`;
  if (tc.alt) {
    // climbs: rises between the turning points of the profile (as Hills on the altitude chart)
    const piv = chartPivots(vals, Math.max(TILE_CLIMB.min_m, (hi - lo) * TILE_CLIMB.share)), ups = [];
    for (let k = 1; k < piv.length; k++) if (vals[piv[k]] > vals[piv[k - 1]]) ups.push([piv[k - 1], piv[k]]);
    return svg(`<path d="${area(0, vals.length - 1)}" fill="#93cf99" opacity=".45"/>
      ${ups.map(([a, b]) => `<path d="${area(a, b)}" fill="#4f9d56" opacity=".55"/>`).join("")}
      <path d="${path(0, vals.length - 1)}" fill="none" stroke="#4f9d56" stroke-width="2" vector-effect="non-scaling-stroke"/>`);
  }
  return svg(`<path d="${area(0, vals.length - 1)}" fill="#86aef5" opacity=".3"/>
    <path d="${path(0, vals.length - 1)}" fill="none" stroke="#86aef5" stroke-width="2" vector-effect="non-scaling-stroke"/>`);
}

function activitySummary(t) {
  const weeks = t.first && t.last ? Math.max(1, (Date.parse(t.last) - Date.parse(t.first)) / (7 * 864e5)) : 1;
  return statStrip([
    ["Activities", num(t.count), `${num(t.active_days || 0)} active days`],
    ["Distance", km(t.distance_m), t.count ? `${km((t.distance_m || 0) / t.count)} avg` : ""],
    ["Time", hours(t.time_s), t.count ? `${hours((t.time_s || 0) / weeks)} per week` : ""],
    ["Elevation gain", meters(t.ascent_m), ""],
    ["Longest", km(t.longest_m), t.longest_s ? `${dur(t.longest_s)} max time` : ""],
    ["Calories", kcal(t.calories), ""],
  ]);
}

async function renderActivities(params) {
  // Filters and sort stay for this tab: "#/activities" with no parameters (the back button, the
  // tab link from an activity) brings them back; leaving the tab or reloading forgets them.
  const KEEP = ["from", "to", "last", "years", "types", "workouts", "device", "person", "sort", "dir"];
  if (!Object.keys(params).length && TAB.filter && Object.keys(TAB.filter).length) {
    location.replace("#/activities?" + new URLSearchParams(TAB.filter));
    return;
  }
  TAB.filter = Object.fromEntries(KEEP.filter((k) => params[k]).map((k) => [k, params[k]]));
  params = { sort: "date", dir: "desc", ...params };
  if (PAIR) { await renderTogetherActivities(params); return; }
  const mode = VIEWS.some(([k]) => k === TAB.view) ? TAB.view : "large";
  const isAll = CURRENT === "all";
  const q = { limit: PAGE_SIZE, sort: params.sort, dir: params.dir, ...filterQuery(params) };
  if (!isAll) q.person = CURRENT;
  else if (params.person) q.person = params.person;
  if (mode === "large") q.track = "1";
  if (mode === "small") q.chart = "chart";
  const fetchPage = (offset) => api("activities?" + new URLSearchParams({ ...q, offset }));
  const [data] = await Promise.all([fetchPage(0),
    mode === "large" ? (async () => { BASEMAPS ??= await api("basemaps"); })() : null]);

  const columns = [
    { key: "date", label: "Date", icon: "date", sort: true,
      render: (a) => `<a class="plain-link" href="#/activity/${a.id}">${localTime(a)}</a>` },
    { key: "type", label: "Type", icon: "type", sort: true,
      render: (a) => typeName(a.activity_type) + (a.indoor ? ` <span class="hint">indoor</span>` : "") },
    { key: "workout", label: "Training type", icon: "interval_time", sort: true,
      render: (a) => (workoutOf(a) ? esc(workoutLabel(workoutOf(a))) : `<span class="hint">–</span>`) },
    { key: "name", label: "Name", icon: "name", sort: true, render: (a) => `<a href="#/activity/${a.id}">${esc(a.name || typeLabel(a.activity_type))}</a>` + (a.segment_count ? ` ${segBadge(a)}` : "") },
    { key: "distance", label: "Distance", icon: "distance_total", sort: true, num: true, render: (a) => km(a.distance_m) },
    { key: "time", label: "Time", icon: "timer_time", sort: true, num: true, render: (a) => dur(a.time_s) },
    { key: "pace", label: "Pace", icon: "avg_pace", sort: true, num: true, render: (a) => (a.distance_m ? pace(a.avg_speed) : "–") },
    { key: "hr", label: "Avg HR", icon: "avg_heart_rate", sort: true, num: true, render: (a) => bpm(a.avg_hr) },
    { key: "ascent", label: "Ascent", icon: "total_ascent", sort: true, num: true, render: (a) => meters(a.ascent_m) },
    ...(isAll ? [{ key: "person", label: "Person", sort: true, filter: { type: "select", options: personOptions(), all: "Everyone" },
      render: (a) => `${avatar(person(a.person_id), 18)} ${esc(personLabel(a.person_id))}` }] : []),
    { key: "actions", label: "", cls: "actions",
      render: (a) => `<button class="icon delete" data-delete="${a.id}" title="Delete activity" aria-label="Delete activity">${ICON.trash}</button>` },
  ];

  // Segment badge: the (first) segment's name, "+n" when there are more.
  const segBadge = (a, cls = "") => `<span class="seg-badge ${cls}" title="Segment${a.segment_count > 1 ? "s" : ""} in this activity">${esc(a.segment_name || "Segment")}${a.segment_count > 1 ? ` +${a.segment_count - 1}` : ""}</span>`;
  const kind = (a) => (workoutOf(a) ? esc(workoutLabel(workoutOf(a))) : "");
  // Hovering a chart tile: the averages in a light frame at the top centre - heart rate, pace (on
  // foot) or speed, and power on rides.
  const tileAverages = (a) => {
    const foot = ["run", "walk", "hike"].includes(a.category);
    const parts = [
      a.avg_hr ? bpm(a.avg_hr) : "",
      // no speed for games (a match's average speed says nothing)
      a.distance_m && a.avg_speed && !["team", "racket"].includes(a.category) ? (foot ? pace(a.avg_speed) : `${num(a.avg_speed * 3.6, 1)} km/h`) : "",
      a.category === "ride" && a.avg_power ? watts(a.avg_power) : "",
    ].filter(Boolean);
    return parts.length ? `<span class="tile-avg">${parts.join(" · ")}</span>` : "";
  };
  const head = (a, small) => `
      <div class="tile-head">
        <span class="tile-icon">${typeIcon(a.activity_type)}</span>
        <span class="tile-title"><b>${esc(a.name || typeLabel(a.activity_type))}</b>
        <span class="hint">${a.name ? `${esc(typeLabel(a.activity_type))} · ` : ""}${localTime(a)}${kind(a) && !small ? ` · ${kind(a)}` : ""}${isAll ? ` · ${esc(personLabel(a.person_id))}` : ""}</span></span>
        ${small ? `<span class="tile-dist">${a.distance_m ? `<b>${km(a.distance_m)}</b>` : ""}<b>${dur(a.time_s)}</b></span>` : ""}
      </div>`;
  const tile = (a) => (mode === "small" ? `
    <a class="tile small" href="#/activity/${a.id}">
      <div class="tile-map"><div class="tile-top">${kind(a) ? `<span class="tile-kind">${kind(a)}</span>` : "<span></span>"}${tileAverages(a)}${a.segment_count ? segBadge(a, "tile-seg") : "<span></span>"}</div>${a.tile_chart ? tileChart(a.tile_chart) : `<span class="tile-sport">${typeIcon(a.activity_type, 64)}</span>`}</div>
      ${head(a, true)}
    </a>` : `
    <a class="tile ${mode}" href="#/activity/${a.id}">
      <div class="tile-map">${a.segment_count ? segBadge(a, "tile-seg") : ""}${a.polyline ? staticMap(a.polyline, { W: 400, H: 160, cls: "tile-track", tiles: "faded-tiles" }) : `<span class="hint">${a.indoor ? "indoor" : "no route"}</span>`}</div>
      ${head(a, false)}
      <div class="tile-stats">${[ // only the values the activity has (a treadmill run: no ascent)
        a.distance_m && ["Distance", km(a.distance_m)], a.time_s && ["Time", dur(a.time_s)],
        a.distance_m && a.avg_speed && ["Pace", pace(a.avg_speed)], a.avg_hr && ["Avg HR", bpm(a.avg_hr)],
        a.ascent_m && ["Ascent", meters(a.ascent_m)],
      ].filter(Boolean).map(([l, v]) => `<span><span class="hint">${l}</span>${v}</span>`).join("")}</div>
    </a>`);

  const filterCols = columns.filter((c) => c.filter);
  const body = mode === "list"
    ? tableHtml(columns, data.items, params, data.total)
    : `${listBar(columns, params, data.items.length, data.total)}
       <div class="tiles ${mode}" data-rows>${data.items.map(tile).join("") || hint("Nothing matches the filters.")}</div>
       ${data.items.length < data.total ? `<div class="sentinel" data-sentinel>${loaderHtml()}</div>` : ""}`;

  const showSummary = TAB.kpis ?? false;
  view.innerHTML = `
    ${pageHead("Activities", `
      ${timeBadge(params)}${typeBadge(params)}${workoutBadge(params, data.workout_counts)}
      ${data.device ? badgeHtml("device", "Device", `${esc(data.device.name || "unknown")} ×`, { on: true }) : ""}
      <button class="badge ${showSummary ? "on" : ""}" data-kpis>Summary</button>`,
      switchHtml("view", VIEWS.map(([k, label, icon]) => [k, `${icon}<span>${label}</span>`]), mode))}
    <div data-summary ${showSummary ? "" : "hidden"}>${activitySummary(data.totals)}</div>
    <div class="card">${body}</div>`;
  bindBadges(view.querySelector(".page-head"));
  bindTable("#/activities", params);
  bindFilterBadges(view.querySelector(".page-head"), "#/activities", params, { drop: ["date"] });
  // one device only (a click on it on Statistics › Gear): the badge takes the filter off
  const off = view.querySelector("[data-badge=device]");
  if (off) off.onclick = () => {
    const { device, ...rest } = params;
    location.hash = "#/activities?" + new URLSearchParams(rest);
  };
  infinite(view, data.items.length, data.total, async (offset) => (await fetchPage(offset)).items, (items) => {
    view.querySelector("[data-rows]").insertAdjacentHTML("beforeend", items.map((a) => (mode === "list" ? rowHtml(columns, a) : tile(a))).join(""));
  });
  view.querySelector("[data-kpis]").onclick = (e) => {
    const on = !e.currentTarget.classList.contains("on");
    TAB.kpis = on;
    e.currentTarget.classList.toggle("on", on);
    view.querySelector("[data-summary]").hidden = !on;
    if (on) window.scrollTo({ top: 0, behavior: "smooth" });
  };
  view.querySelectorAll("[data-switch=view]").forEach((b) => b.onclick = () => { TAB.view = b.dataset.value; renderActivities(params); });
  view.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-delete]");
    if (!b) return;
    if (!confirm("Delete this activity from the database?\n\nThe FIT file is not touched. It will not be imported again unless you remove it from the import history.")) return;
    await api("activities/" + b.dataset.delete, { method: "DELETE" }).catch((err) => alert(err.message));
    b.closest("tr, .tile")?.remove();
  });
}

// ---- Activity detail ---------------------------------------------------------------

// Charts of an activity: every stream the file has (watch dependent). Visible by default: heart
// rate, speed, altitude; power and cadence on rides. The user's choice is saved per person.
// [key, label, unit, decimals, pastel colour, icon, explanation, convert]
const CHART_DEFS = [
  ["hr", "Heart rate", "bpm", 0, "#ef8a8a", "heart_rate", "Heart beats per minute, from a chest strap or the watch's optical sensor."],
  ["speed", "Speed", "km/h", 1, "#86aef5", "speed", "Speed over ground (GPS, foot pod or speed sensor).", (v) => v * 3.6],
  ["power", "Power", "W", 0, "#b9a2f2", "power", "Mechanical power in watts — a power meter on the bike, or running power from the watch."],
  ["cadence", "Cadence", null, 0, "#7ccfc3", "cadence", "Steps per minute on foot, crank revolutions per minute on a bike."],
  ["altitude", "Altitude", "m", 0, "#93cf99", "altitude", "Height above sea level, from the barometer (or GPS); Garmin's corrected elevation when Garmin Connect corrected it."],
  ["body_battery", "Body Battery", "", 0, "#7aa7e8", "battery", "Garmin's estimate of your energy reserve (0–100), from Garmin Connect."],
  ["gap_speed", "Grade adjusted speed", "km/h", 1, "#86aef5", "grade_adjusted_speed", "Speed adjusted for the slope: what it would be on flat ground (Garmin Connect).", (v) => v * 3.6],
  ["respiration", "Respiration", "br/min", 0, "#86cfe6", "respiration_rate", "Breaths per minute, estimated by the watch from heart-rate variability."],
  ["temperature", "Temperature", "°C", 0, "#f5b27f", "temperature", "Temperature at the watch or sensor; worn on the wrist it is warmed by the body."],
  ["stance_time", "Ground contact time", "ms", 0, "#7ccfc3", "steps", "How long each foot stays on the ground per step (running dynamics)."],
  ["step_length", "Step length", "m", 2, "#7ccfc3", "steps", "Distance from one foot strike to the next.", (v) => v / 1000],
  ["vertical_oscillation", "Vertical oscillation", "cm", 1, "#7ccfc3", "vertical_speed", "How much the torso moves up and down with each step.", (v) => v / 10],
  ["vertical_ratio", "Vertical ratio", "%", 1, "#7ccfc3", "grade", "Vertical oscillation divided by step length; lower is more efficient."],
  ["left_pco", "Platform centre offset (left)", "mm", 0, "#b9a2f2", "crank_revolutions", "Where on the left pedal the force is applied, sideways from the centre."],
  ["right_pco", "Platform centre offset (right)", "mm", 0, "#b9a2f2", "crank_revolutions", "Where on the right pedal the force is applied, sideways from the centre."],
  ["left_smoothness", "Pedal smoothness (left)", "%", 0, "#b9a2f2", "crank_revolutions", "How evenly force is applied through the left pedal stroke."],
  ["right_smoothness", "Pedal smoothness (right)", "%", 0, "#b9a2f2", "crank_revolutions", "How evenly force is applied through the right pedal stroke."],
  ["left_torque", "Torque effectiveness (left)", "%", 0, "#b9a2f2", "power", "Share of the left pedal's force that drives the bike forward."],
  ["right_torque", "Torque effectiveness (right)", "%", 0, "#b9a2f2", "power", "Share of the right pedal's force that drives the bike forward."],
  ["performance_condition", "Performance condition", "", 0, "#ef8a8a", "aerobic_effect", "Garmin's live estimate of your form against your usual fitness (−20 … +20)."],
  ["stamina", "Stamina", "%", 0, "#f4a6c8", "battery", "Garmin's estimate of how much energy is left for the current effort."],
  ["stamina_potential", "Potential stamina", "%", 0, "#f4a6c8", "battery", "The most stamina you could recover to with rest."],
];
const chartDefault = (key, a) => ["hr", "speed", "altitude"].includes(key) || (a.category === "ride" && ["power", "cadence"].includes(key));

// `col`: one column of a shared activity (together.js › renderTogether) - drawn into col.root
// without the page header, map, segments and files; the charts wait for mount() and share the
// clock of col.pair; col.route stands for the page's map. Returns the column's handle.
async function renderActivity(id, col = null) {
  const root = col?.root || view;
  // Previous / next stay within the filters set on the Activities list (kept for this tab).
  const who = PAIR ? (PAIR.includes(TAB.filter?.person) ? TAB.filter.person : PAIR.join(",")) : TAB.filter?.person;
  const nq = col ? {} : { ...filterQuery(TAB.filter || {}), ...(CURRENT === "all" ? { neighbours: "all", ...(who ? { person: who } : {}) } : {}) };
  const a = await api("activities/" + id + (Object.keys(nq).length ? "?" + new URLSearchParams(nq) : ""));
  // Section lines the person moved (Hills, Intervals): kept per activity for its training type;
  // without them the detected ones (intervals from the server, hills from the altitude line).
  let savedLines = null;
  try { savedLines = a.section_lines ? JSON.parse(a.section_lines) : null; } catch { savedLines = null; }
  if (savedLines?.kind !== workoutOf(a)) savedLines = null;
  const [s, track, iv] = await Promise.all([
    api(`activities/${id}/streams?max_points=1500`),
    a.has_gps && !col ? api(`activities/${id}/track`).catch(() => null) : null,
    workoutOf(a) === "intervals" ? (savedLines ? { splits: savedLines.splits } : api(`activities/${id}/intervals`).catch(() => null)) : null,
  ]);
  const st = s.streams;
  const onFoot = ["run", "walk", "hike"].includes(a.category);
  const cadUnit = onFoot ? "spm" : "rpm";
  const typeSelect = `<select name="type">${TYPES.groups.map((g) => `<optgroup label="${esc(g.en)}">${TYPES.types
    .filter((t) => t.group === g.key).map((t) =>
      `<option value="${t.key}" ${t.key === a.activity_type ? "selected" : ""}>${esc(t.en)}</option>`).join("")}</optgroup>`).join("")}</select>`;

  // Series the file has, with the stats shown next to each chart.
  const hasVals = (arr) => Array.isArray(arr) && arr.some((v) => v != null && v !== 0);
  const vals = (arr) => arr.filter((v) => v != null);
  const avgOf = (arr) => { const v = vals(arr); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
  // Garmin corrected the elevation (devices without a barometer): use its profile.
  if (st.altitude_connect?.some((v) => v != null) && a.connect?.elevationCorrected) st.altitude = st.altitude_connect;
  const chartX = activityChartX(st);
  // seconds on the clock both columns share (0 = the first moment together)
  if (col && chartX) {
    const first = st.time?.find((v) => v != null) ?? 0;
    chartX.together = chartX.time.map((v) => v + first + col.offset);
  }
  // Altitude: the steepest stretch of at least 300 m and the longest climb (needs distance).
  const CLIMB_TIP = "A climb: at least 20 m up over at least 50 m. Dips on the way count as part of it while each is at most a quarter as long as the rise before it and loses at most a third of the height gained.";
  const climbStats = (alt) => {
    const d = chartX?.distance;
    if (!d) return [];
    const climbs = chartClimbs(alt, d);
    const steep = climbs.filter((c) => c.len >= 0.3).sort((p, q) => q.grade - p.grade)[0];
    const long = [...climbs].sort((p, q) => q.len - p.len)[0];
    return [
      steep && ["Steepest climb", `${num(steep.grade, 1)} %`, { ranges: [[steep.i0, steep.i1]] },
        `Steepest climb: ${num(steep.grade, 1)} % average over ${km(steep.len * 1000)}, +${num(steep.gain)} m. The steepest climb at least 300 m long. ${CLIMB_TIP}`],
      long && ["Longest climb", km(long.len * 1000), { ranges: [[long.i0, long.i1]] },
        `Longest climb: ${km(long.len * 1000)}, +${num(long.gain)} m at ${num(long.grade, 1)} % on average. ${CLIMB_TIP}`],
    ].filter(Boolean);
  };
  // Best average over a window (seconds), weighted by time; [value, i0, i1] or null. Power: a
  // sample without a value counts as 0 (a stop); otherwise it is left out of the average.
  const bestPower = (p, secs, zero = true) => {
    const t = chartX?.time;
    if (!t || t[t.length - 1] - t[0] < secs) return null;
    const cum = [0], cw = [0];
    for (let i = 1; i < t.length; i++) {
      const dt = Math.min(30, t[i] - t[i - 1]), has = p[i] != null;
      cum.push(cum[i - 1] + (p[i] ?? 0) * dt);
      cw.push(cw[i - 1] + (has || zero ? dt : 0));
    }
    let best = null;
    for (let i = 0, j = 0; i < t.length; i++) {
      while (j < t.length && t[j] - t[i] < secs) j++;
      if (j >= t.length) break;
      const w = cw[j] - cw[i];
      if (!zero && w < secs * 0.8) continue; // mostly without data
      const avg = w ? (cum[j] - cum[i]) / w : 0;
      if (!best || avg > best[0]) best = [avg, i, j];
    }
    return best;
  };
  // Best average over 20 min and 1 h (power, heart rate, speed), highlighted on hover.
  const windows = (values, fmt, what) => [[1200, "Max 20 min"], [3600, "Max 1 h"]].map(([secs, label]) => {
    const b = bestPower(values, secs, what === "power");
    return b && b[0] > 0 && [label, fmt(b[0]), { ranges: [[b[1], b[2]]] }, `The highest average ${what} held for ${label.slice(4)}.`];
  }).filter(Boolean);
  const powerWindows = (p) => windows(p, watts, "power");
  // Total crank revolutions (or steps on foot): cadence integrated over time, pauses skipped.
  const totalTurns = (c) => {
    const t = chartX?.time;
    if (!t) return [];
    let n = 0;
    for (let i = 1; i < t.length; i++) { const dt = t[i] - t[i - 1]; if (dt > 0 && dt < 60 && c[i] != null) n += (c[i] * dt) / 60; }
    return n > 0 ? [[onFoot ? "Steps" : "Revolutions", num(n), null, onFoot ? "Total steps, from the cadence over time." : "Total crank revolutions, from the cadence over time."]] : [];
  };
  // Workout targets: share of the steps' time within the target; hover shows where it was outside.
  const inTarget = (values, targets) => {
    const t = chartX?.time;
    if (!t || !targets.length) return [];
    let tot = 0, ok = 0, out = [], run = null;
    for (const g of targets) {
      for (let i = Math.max(1, g.i0); i <= g.i1; i++) {
        const v = values[i], dt = Math.min(30, t[i] - t[i - 1]);
        if (v == null || dt <= 0) continue;
        tot += dt;
        const inside = v >= g.lo && v <= g.hi;
        if (inside) ok += dt;
        else if (run && i - run[1] <= 3) run[1] = i; // short returns into the range do not split a stretch
        else { if (run) out.push(run); run = [i, i]; }
      }
      if (run) { out.push(run); run = null; }
    }
    if (run) out.push(run);
    return tot ? [["In target", `${num((ok / tot) * 100)} %`, { ranges: out, color: "#e5484d" },
      "Share of the workout steps' time spent within the step's target range. Hover: where it was outside."]] : [];
  };
  const statsFor = (key, values, unit, dec) => {
    const f = (v) => (v == null ? null : `${num(v, dec)}${unit ? " " + unit : ""}`);
    const mx = vals(values).length ? Math.max(...vals(values)) : null, mn = vals(values).length ? Math.min(...vals(values)) : null;
    switch (key) {
      // [label, value, mark] - mark: what hovering the stat highlights on the chart (charts.js)
      case "hr": return [["Avg", bpm(a.avg_hr), a.avg_hr ?? avgOf(values)], ["Max", bpm(a.max_hr), "max"], ...windows(values, bpm, "heart rate")];
      case "speed": return [[onFoot ? "Avg pace" : "Avg", onFoot ? pace(a.avg_speed) : f(a.avg_speed * 3.6), a.avg_speed != null ? a.avg_speed * 3.6 : avgOf(values), onFoot ? "Average pace" : "Average speed"],
        ["Max", f(a.max_speed != null ? a.max_speed * 3.6 : mx), "max"],
        ...windows(values, (v) => (onFoot ? pace(v / 3.6) : f(v)), onFoot ? "pace" : "speed")];
      case "power": return [["Avg", watts(a.avg_power), a.avg_power ?? avgOf(values)], ["Weighted", a.np_power ? watts(a.np_power) : null, a.np_power, "Weighted power: the steady power that would have cost the same effort (4th-power mean of the 30 s average)."], ["Max", watts(a.max_power ?? mx), "max"], ...powerWindows(values)];
      case "cadence": return [["Avg", cadence(a.avg_cadence, a.category), avgOf(values)], ["Max", cadence(a.max_cadence ?? mx, a.category), "max"], ...totalTurns(values)];
      case "altitude": return [["Ascent", meters(a.ascent_m), "up", "Total ascent"], ["Descent", meters(a.descent_m), "down", "Total descent"], ["Max", f(mx), "max", "Highest altitude"], ["Min", f(mn), "min", "Lowest altitude"], ...climbStats(values)];
      default: return [["Avg", f(avgOf(values)), avgOf(values)], ["Max", f(mx), "max"], ["Min", f(mn), "min"]];
    }
  };
  // Workout step targets (structured workouts) per lap, as sample index ranges.
  const targetsFor = (key, conv) => (chartX ? a.laps.filter((l) => l.target === key && l.start_offset_s != null).map((l) => {
    const t = chartX.time, end = l.start_offset_s + (l.elapsed_s || 0);
    const i0 = t.findIndex((v) => v >= l.start_offset_s);
    let i1 = t.length - 1;
    while (i1 > 0 && t[i1] > end) i1--;
    const c = conv || ((v) => v);
    return i0 >= 0 && i1 > i0 ? { i0, i1, lo: c(l.target_low), hi: c(l.target_high) } : null;
  }).filter(Boolean) : []);
  // Chart order: the person's saved order first, then the rest in the default order.
  const order = UI.data["activity-chart-order"] || [];
  const rank = (k) => (order.includes(k) ? order.indexOf(k) : order.length + CHART_DEFS.findIndex(([x]) => x === k));
  const available = CHART_DEFS.filter(([key]) => hasVals(st[key])).map(([key, label, unit, dec, color, icon, tip, conv]) => {
    const values = conv ? st[key].map((v) => (v == null ? null : conv(v))) : st[key];
    const u = key === "cadence" ? cadUnit : unit;
    const targets = targetsFor(key, conv);
    return { key, label, unit: u, dec, color, icon, tip, values, raw: values, stats: [...statsFor(key, values, u, dec), ...inTarget(values, targets)], targets };
  }).sort((p, q) => rank(p.key) - rank(q.key));
  // Stamina and potential stamina belong together (Garmin shows them as one chart).
  const stam = available.find((x) => x.key === "stamina"), pot = available.findIndex((x) => x.key === "stamina_potential");
  if (stam && pot >= 0) {
    stam.lines = [{ label: "Potential", values: available[pot].values, color: "#a3487d", dash: [5, 4] }];
    stam.fill = true;
    stam.title = "Stamina and potential"; // the dashed line is the potential; no legend
    stam.legend = false;
    const v = stam.values.filter((x) => x != null);
    stam.stats = [["Start", `${num(v[0])} %`, null, "Stamina at the start"], ["End", `${num(v[v.length - 1])} %`, null, "Stamina at the end"],
      ["Min", `${num(Math.min(...v))} %`, "min", "Lowest stamina"]];
    available.splice(pot, 1);
  }
  // Easy: where the heart rate went over the tempo line: those stretches drawn thick on the heart
  // rate chart, and an "Above tempo" stat (share and time; hover shows where, on the map too).
  // Stretches: 30 s or longer, gaps under 20 s joined.
  function easyAccents() {
    // the limit: the detection's tempo line (90 % of the sport's threshold HR), so the stat and
    // the training type agree (Garmin's zone 2 from % of max HR is often far lower)
    const hr = available.find((q) => q.key === "hr"), lim = a.tempo_hr, t = chartX.time;
    if (!hr || !lim) return;
    const v = hr.raw, runs = [];
    let above = 0, total = 0, run = null;
    for (let i = 1; i < v.length; i++) {
      const dt = Math.min(30, t[i] - t[i - 1]);
      if (v[i] == null || dt <= 0) continue;
      total += dt;
      if (v[i] < lim) continue;
      above += dt;
      if (run && t[i] - t[run[1]] < 20) run[1] = i; else { if (run) runs.push(run); run = [i, i]; }
    }
    if (run) runs.push(run);
    const long = runs.filter(([i0, i1]) => t[i1] - t[i0] >= 30);
    if (!total) return;
    hr.stats.push(["Above tempo", `${num((above / total) * 100)} % · ${clock(above)}`, { ranges: long }, // highlighted like every other stat
      `Time with the heart rate at the tempo line or over (${num(lim)} bpm, 90 % of your threshold heart rate, the line the training type uses). Hover: where.`]);
    // one strong colour (zone colours on a red line read badly); the zone is in the value flag
    if (long.length) hr.climbs = { items: long.map(([i0, i1]) => ({ i0, i1 })), edit: false,
      label: () => ({ lines: [], color: EASY_OVER_COLOR }),
      tip: (i0, i1, i) => `<span class="chart-tip-dot" style="background:${EASY_OVER_COLOR}"></span>Above tempo${zoneOf("hr", v[i]) ? ` · Z${zoneOf("hr", v[i])[0]}` : ""} · ${clock(t[i1] - t[i0])} stretch` };
  }
  // Climbs on the altitude chart (docs/MANUAL.md › Climbs). Hills: lines at the turning points of
  // the profile (a climb's foot or top; wiggles under 12 % of the altitude range, at least 15 m,
  // ignored; without any, the hill repeats the detector stored), values over every climb.
  // Other activities: no lines; the climbs that have a category (climbCategory) are accented.
  // Above a climb: the gain and the category (in the category's colour), length and time.
  function climbSections(hills) {
    const alt = available.find((q) => q.key === "altitude"), t = chartX?.time, d = chartX?.distance;
    if (!alt || !t) return null;
    const v = alt.raw;
    const catOf = (i0, i1, up) => (d ? climbCategory(up, (d[i1] - d[i0]) * 1000, onFoot) : null);
    let spans;
    if (hills) {
      const vals = v.filter((x) => x != null);
      const th = Math.max(15, (Math.max(...vals) - Math.min(...vals)) * 0.12);
      spans = [chartPivots(v, th)];
      if (spans[0].length <= 2) {
        let det = null;
        try { det = a.workout_detail ? JSON.parse(a.workout_detail) : null; } catch { det = null; }
        const idx = (sec) => t.findIndex((x) => x >= sec);
        spans = (det?.bouts || []).map(([s0, s1]) => [idx(s0), idx(s1)]).filter(([i0, i1]) => i0 >= 0 && i1 > i0);
      }
    } else {
      // other activities: no lines - the climbs with a class are drawn thick on the altitude
      // line with their values above (charts.js › s.climbs); the range can be dragged
      if (!d) return null;
      const items = chartClimbs(v, d).filter((c) => catOf(c.i0, c.i1, c.gain)).map((c) => ({ i0: c.i0, i1: c.i1 }));
      alt.climbs = items.length ? { items, label: (i0, i1) => {
        const up = v[i1] != null && v[i0] != null ? v[i1] - v[i0] : null;
        const cat = up > 0 ? catOf(i0, i1, up) : null;
        return { color: cat?.color || null, lines: up == null ? [] : [
          [`${up >= 0 ? "+" : "−"}${num(Math.abs(up))} m`, cat?.color || alt.color],
          ...(cat ? [[cat.name, cat.color]] : []),
          [km((d[i1] - d[i0]) * 1000), null],
          [clock(t[i1] - t[i0]), null],
        ] };
      } } : null;
      return null;
    }
    if (hills && savedLines) spans = [savedLines.splits.map((sec) => t.findIndex((x) => x >= sec))];
    const at = [...new Set(spans.flat())].filter((i) => i > 0 && i < t.length - 1).sort((p, q) => p - q);
    const label = (key, i0, i1) => {
      if (key !== "altitude") return [];
      const up = v[i1] != null && v[i0] != null ? v[i1] - v[i0] : null;
      if (up == null || up <= 0) return []; // climbs only: descents and flats stay empty
      const cat = catOf(i0, i1, up);
      if (!hills && !cat) return [];
      return [
        [`+${num(up)} m`, cat?.color || alt.color],
        ...(cat ? [[cat.name, cat.color]] : []),
        ...(d ? [[km((d[i1] - d[i0]) * 1000), null]] : []),
        [clock(t[i1] - t[i0]), null],
      ];
    };
    return { kind: hills ? "hills" : "climbs", keys: ["altitude"], at, label, lines: 4 };
  }
  // Interval sections: lines on the speed, heart rate, power and cadence charts; above each chart
  // the section's average (heart rate and power with the zone, speed with the section's time).
  let zones = null;
  try { zones = a.zones ? JSON.parse(a.zones) : null; } catch { zones = null; }
  // zone of a value from Garmin's limits of this activity (as in the zone tiles): [number, colour] or null
  const zoneOf = (kind, v) => {
    const b = zones?.[kind]?.bounds;
    if (!b || v == null) return null;
    const lowFirst = kind === "hr" || b[0] === 0, his = lowFirst ? b.slice(1) : b;
    if (lowFirst && v < b[0]) return null;
    let k = his.findIndex((hi) => v < hi);
    if (k < 0) k = his.length - 1; // above the last limit: the top zone
    return [k + 1, kind === "power" ? powerZoneColor(k + 1) : rampColor(ROUTE_SCALES[kind].stops, his.length > 1 ? k / (his.length - 1) : 0)];
  };
  const sections = iv && chartX ? (() => {
    const t = chartX.time, d = chartX.distance;
    const at = [...new Set(iv.splits.map((sec) => t.findIndex((v) => v >= sec)))].filter((i) => i > 0 && i < t.length - 1).sort((p, q) => p - q);
    // time-weighted average of samples i0..i1 (samples without a value left out)
    const avg = (v, i0, i1) => {
      let sum = 0, w = 0;
      for (let i = i0 + 1; i <= i1; i++) {
        const dt = Math.min(30, t[i] - t[i - 1]);
        if (v[i] == null || dt <= 0) continue;
        sum += v[i] * dt; w += dt;
      }
      return w ? sum / w : null;
    };
    const label = (key, i0, i1) => {
      const x = available.find((q) => q.key === key);
      if (!x) return [];
      const v = avg(x.raw, i0, i1);
      // the value and its zone, both in the zone's colour (the series colour without zones)
      const zoned = (kind, text) => { const z = zoneOf(kind, v); return z ? [[text, z[1]], [`Z${z[0]}`, z[1]]] : [[text, x.color]]; };
      switch (key) {
        case "hr": return v == null ? [] : zoned("hr", bpm(v));
        case "power": return v == null ? [] : zoned("power", watts(v));
        case "cadence": return v == null ? [] : [[cadence(v, a.category), x.color]];
        case "speed": {
          const secs = t[i1] - t[i0];
          // distance over time where there is distance (as the pace of a lap)
          const kmh = d && secs > 0 && d[i1] > d[i0] ? ((d[i1] - d[i0]) / secs) * 3600 : v;
          return [...(kmh ? [[onFoot ? pace(kmh / 3.6) : `${num(kmh, 1)} km/h`, x.color]] : []), [clock(secs), null]];
        }
        default: return [];
      }
    };
    return { kind: "intervals", keys: ["speed", "hr", "power", "cadence"], at, label };
  })() : null;
  const climbs = chartX ? climbSections(workoutOf(a) === "hills") : null;
  if (chartX && workoutOf(a) === "easy") easyAccents();
  const chartChoice = () => ({ ...(UI.data["activity-charts"] || {}) });
  const isShown = (key) => chartChoice()[key] ?? chartDefault(key, a);
  let common = null; // a column: the charts both people have, shown first
  const visibleSeries = () => {
    const list = available.filter((x) => isShown(x.key));
    return common ? list.sort((p, q) => Number(common.has(q.key)) - Number(common.has(p.key))) : list;
  };

  // Tiles: a tile only when there is a value. Values that belong to a chart (avg/max HR, pace,
  // power, cadence, ascent...) live only next to their chart, visible or not; they stay in the
  // tiles only when the activity has no such chart.
  const stat = (label, raw, value = raw, icon = null) => (raw == null || raw === "" || raw === 0 ? ""
    : `<div class="card stat-card"><h3 class="tile-title">${icon ? metricIcon(icon, 18) : ""}<span>${label}</span></h3><b>${value}</b></div>`);
  const active = a.calories != null && a.metabolic_calories != null ? a.calories - a.metabolic_calories : null;
  const TE_SCALE = [[5, "overreaching"], [4, "highly improving"], [3, "improving"], [2, "maintaining"], [1, "minor benefit"], [0, "no benefit"]];
  // Garmin's primary benefit of an activity: [code, name, what it means].
  const TE_LABELS = [["RECOVERY", "recovery", "very easy, helps you recover"], ["AEROBIC_BASE", "base", "long and easy, builds endurance"],
    ["TEMPO", "tempo", "steady and moderately hard"], ["LACTATE_THRESHOLD", "threshold", "hard, near the lactate threshold"],
    ["VO2MAX", "VO2 max", "intervals at maximum oxygen uptake"], ["ANAEROBIC_CAPACITY", "anaerobic", "short, very hard efforts"],
    ["SPEED", "sprint", "sprints of a few seconds"], ["SPRINT", "sprint", "sprints of a few seconds"]];
  // Small cards: column 1 distance, time (timer) and elapsed time; column 2 effect, Body Battery and
  // calories (only the ones with data; the others in the column grow to fill it).
  const tilesHtml = () => {
    const on = new Set(chartX ? available.map((x) => x.key) : []);
    // Garmin Connect first; without it Garmin's values written in the FIT file (no label, no Body Battery)
    const c = a.connect || {}, fm = a.fit_metrics || {}, bb = c.differenceBodyBattery;
    const te = c.aerobicTrainingEffect ?? fm.te_aerobic, an = c.anaerobicTrainingEffect ?? fm.te_anaerobic;
    const known = TE_LABELS.find(([k]) => k === c.trainingEffectLabel);
    const label = known ? known[1] : c.trainingEffectLabel ? String(c.trainingEffectLabel).replace(/_/g, " ").toLowerCase() : "";
    // Garmin's wording of the 0–5 scale, the same for aerobic and anaerobic.
    const teWord = (v) => TE_SCALE.find(([lo]) => v >= lo)?.[1] ?? "no benefit";
    // tooltip (HTML, like the weather help): the primary benefit in bold, then each score with
    // its name in bold, a blank line between them, the source as a light note
    const effectTip = [known ? `<b>${esc(known[1][0].toUpperCase() + known[1].slice(1))}</b> ${esc(known[2])}` : "<b>Training effect</b>",
      `<b>Aerobic</b> ${te != null ? num(te, 1) : "–"} · ${teWord(te ?? 0)}`,
      `<b>Anaerobic</b> ${an != null ? num(an, 1) : "–"} · ${teWord(an ?? 0)}`,
      `<span class="tip-note">Garmin's training effect, 0–5 scale (Manual › Training effect).</span>`].join("\n\n");
    // Small "label value" lines (time, calories, effect scores, load): the label small, the value bold.
    const kv = (label, value, tip = "") => (value == null || value === "" ? "" : `<span${tip ? ` data-tip="${tip}"` : ""}><small>${label}</small> <b>${value}</b></span>`);
    // Time: the timer time first (what pace and speed are based on), the elapsed time under it.
    const timeCard = stat("Time", a.time_s || a.elapsed_s, `<span class="kv-lines">${a.time_s ? kv("timer", durMin(a.time_s), "Timer time: while the watch was running - pauses left out") : ""}
        ${a.elapsed_s ? kv("elapsed", durMin(a.elapsed_s), "Elapsed time: from start to finish, pauses and stops included") : ""}</span>`, "timer_time");
    // Calories: active and total, one small line each
    const calories = stat("Calories", a.calories, `<span class="kv-lines">${active != null ? kv("active", kcal(active), "Active calories: burned by the activity, without the resting ones") : ""}
        ${kv("total", kcal(a.calories), "Total calories: active plus resting")}</span>`, "calories");
    const colA = [stat("Distance", a.distance_m, km(a.distance_m), "distance_total"), timeCard, calories];
    const kind = workoutOf(a);
    // Effect: Garmin's primary benefit (from Garmin Connect), then both scores, always visible
    const effect = te != null || an != null ? stat("Effect", "x", `<span class="effect-lines" data-tip-html="${esc(effectTip)}">
        <b>${label ? esc(label[0].toUpperCase() + label.slice(1)) : teWord(Math.max(te ?? 0, an ?? 0))}</b>
        <span class="kv-lines">${kv("aerobic", te != null ? num(te, 1) : "–")}${kv("anaerobic", an != null ? num(an, 1) : "–")}${kv("VO2 max", fm.vo2max ? num(fm.vo2max) : null, "VO2 max the watch estimated after the activity, ml/kg/min (Garmin)")}</span></span>`, "aerobic_effect") : "";
    // Load: this app's load of the activity (the one the calendar sums and fitness is built
    // from), Garmin's training load (its own scale) and the Body Battery change
    const sign = (v) => `${v > 0 ? "+" : ""}${num(v)}`;
    const gl = c.activityTrainingLoad ?? fm.load;
    // recovery time the watch showed after the activity (FIT file; earlier training included)
    const rec = fm.recovery_min;
    const method = METHOD_LABELS[a.load_method];
    const loadLines = [
      kv("Load", a.load != null ? num(a.load) : null,
        `Training load${method ? ` from ${method.toLowerCase()}` : ""}: one hour at your threshold = 100`),
      kv("Garmin", gl != null ? num(gl) : null, "Training load of the activity (Garmin, its own scale)"),
      kv("Body Battery", bb != null ? sign(bb) : null, "Change of Body Battery during the activity (Garmin)"),
      kv("Recovery", rec ? `${num(rec / 60)} h` : null, "Recovery time the watch showed after the activity, earlier training included (Garmin)"),
    ].join("");
    const colB = [
      kind ? stat("Training type", kind, `<span data-tip="${a.workout_override ? "Chosen in Edit" : "Detected from the activity; Edit changes it"} (Help › Training types)">${esc(workoutLabel(kind))}</span>`, "interval_time") : "",
      effect,
      loadLines ? stat("Effort", "x", `<span class="kv-lines">${loadLines}</span>`, "training_load") : "",
      on.has("speed") ? "" : stat("Average pace", a.distance_m && a.avg_speed, pace(a.avg_speed), "avg_pace"),
      on.has("hr") ? "" : stat("Average heart rate", a.avg_hr, bpm(a.avg_hr), "avg_heart_rate") + stat("Maximum heart rate", a.max_hr, bpm(a.max_hr), "max_heart_rate"),
      on.has("power") ? "" : stat("Average power", a.avg_power, watts(a.avg_power), "avg_power") + stat("Weighted power", a.np_power, watts(a.np_power), "normalized_power"),
      on.has("cadence") ? "" : stat("Average cadence", a.avg_cadence, cadence(a.avg_cadence, a.category), "avg_cadence"),
      on.has("altitude") ? "" : stat("Total ascent", a.ascent_m, meters(a.ascent_m), "total_ascent") + stat("Total descent", a.descent_m, meters(a.descent_m), "total_descent"),
    ].join("");
    const a1 = colA.join(""), n = (a1 + colB).match(/stat-card/g)?.length || 0;
    // two cards or fewer: one column; three or four: two columns, half each in order (one
    // column of four squeezed them while the cards beside got the width); more: as above
    if (n <= 2) return `<div class="stat-col">${a1}${colB}</div>`;
    if (n <= 4) {
      const cards = (a1 + colB).split(/(?=<div class="card stat-card">)/).filter((x) => x.trim());
      const half = Math.ceil(cards.length / 2);
      return `<div class="stat-col">${cards.slice(0, half).join("")}</div><div class="stat-col">${cards.slice(half).join("")}</div>`;
    }
    return `<div class="stat-col">${a1}</div><div class="stat-col">${colB}</div>`;
  };

  // Training types this sport can have: from the activity, else from the sport families.
  const workoutOptions = a.workout_options
    ?? TYPES?.workout_families?.find((f) => f.types.includes(a.activity_type))?.kinds
    ?? (["team", "racket"].includes(a.category) ? ["match", "training", "recreation"]
      : a.workout ? ["easy", "long", "tempo", "intervals", "hills", "race", "commute"] : []);
  let fixed = [];
  try { fixed = a.fixes ? JSON.parse(a.fixes) : []; } catch { fixed = []; }
  const optLabel = (label, hint) => `${label}<small class="opt-hint">${hint}</small>`;
  const editPanel = `<div class="opt-panel">
      ${row("Name", `<input name="name" value="${esc(a.name || "")}" placeholder="${esc(typeLabel(a.activity_type))}">`)}
      ${row("Type", typeSelect)}
      ${workoutOptions.length ? row("Training type", pickList("workout",
        [["auto", a.workout ? `Automatic · ${workoutLabel(a.workout)}` : "Not set"], ...workoutOptions.map((k) => [k, workoutLabel(k)])],
        a.workout_override || "auto")) : ""}
      ${a.channels.includes("power") ? row(`FTP<small class="opt-hint">${a.ftp_override ? "For this activity only. Empty: automatic." : "Empty: automatic."}</small>`,
        `<input name="ftp" type="number" min="30" max="2000" step="1" value="${a.ftp_override ?? ""}" placeholder="${a.ftp_source && a.ftp_source !== "activity" ? `${num(a.ftp_used)} W` : "None"}"> W`) : ""}
      ${["intervals", "hills"].includes(workoutOf(a)) ? `<div data-reset-lines ${savedLines ? "" : "hidden"}>${row(`Section lines<small class="opt-hint">Moved by you. Reset brings back the detected ones.</small>`,
        `<button id="reset-lines" class="badge">Reset lines</button>`)}</div>` : ""}
      ${row("", `<button id="del" class="badge danger">Delete activity</button>`)}
      ${hasVals(st.altitude) ? row(optLabel("Altitude", fixed.includes("altitude") ? "Corrected once." : "Spikes smoothed out."),
        `<button class="badge" data-fix="altitude">Correct altitude</button>`) : ""}
      ${hasVals(st.speed) || hasVals(st.distance) ? row(optLabel("Speed", fixed.includes("speed") ? "Corrected once." : "GPS jumps taken out."),
        `<button class="badge" data-fix="speed">Correct speed</button>`) : ""}
      ${row(optLabel("Statistics", a.excluded ? "Left out of records." : "Counted in records."),
        `<button class="badge" data-exclude="${a.excluded ? "0" : "1"}">${a.excluded ? "Include again" : "Exclude from statistics"}</button>`)}
    </div>`;
  const hasData = (arr) => Array.isArray(arr) && arr.some((v) => v != null && v > 0);
  const ROUTE_MODES = [["plain", "Single colour", true], ["speed", "Speed", hasData(st.speed)], ["hr", "Heart rate", hasData(st.hr)],
    ["power", "Power", hasData(st.power)], ["cadence", "Cadence", hasData(st.cadence)], ["altitude", "Altitude", hasVals(st.altitude)], ["surface", "Surface", hasSurface(a)],
    ["intervals", "Intervals", sections?.kind === "intervals"]].filter((m) => m[2]);
  // fixed defaults on every visit; a Home Assistant card may set the route colour (when there is data)
  const embedMode = typeof EMBED_ROUTE_MAP !== "undefined" && document.body.classList.contains("embed-detail") ? EMBED_ROUTE_MAP?.mode : null;
  const mode = ROUTE_MODES.some(([k]) => k === embedMode) ? embedMode : "plain", kmOn = true;
  const laps = lapSource(a, chartX, st); // 1 km laps: the device auto-laps, else from the streams
  // grouped by 1 km (runs) or 5 km (rides, long activities); device laps without a distance
  const lapsN = laps.options.includes(lapKmStep(a)) ? lapKmStep(a) : laps.options[0];
  const X_KINDS = col ? [["together", "Clock time"]]
    : [chartX?.distance && ["distance", "Distance"], ["time", "Elapsed time"], chartX?.timer && ["timer", "Timer time"], ["percent", "Percent"]].filter(Boolean);
  const xKind = X_KINDS[0]?.[0];
  // Averaging of the power and cadence lines (one choice for both): remembered per person, default 10 s.
  const POWER_AVG = [[0, "None"], [5, "5 s"], [10, "10 s"], [15, "15 s"], [30, "30 s"], [60, "1 min"], [300, "5 min"], [1200, "20 min"]];
  let powerAvg = UI.data["activity-power-avg"] ?? 10;
  const hasPower = available.some((x) => x.key === "power" || x.key === "cadence");
  // Records to compare with (best efforts, power curve): remembered per person, default all time.
  const COMPARE = [["all", "All time"], ["365d", "Last 12 months"], ["90d", "Last 3 months"], ["30d", "Last 30 days"]];
  let compare = col ? "all" : UI.data["activity-compare"] ?? "all";
  if (!COMPARE.some(([k]) => k === compare)) compare = "all"; // "This year" is always a column now
  let routeOffset = UI.data["activity-route-offset"] ?? true;
  const optionsPanel = `<div class="opt-panel">${track ? row(optLabel("Route lines", "Where the route runs twice (out and back): side by side or on top"),
      pickList("route-offset", [["on", "Side by side"], ["off", "On top"]], routeOffset ? "on" : "off")) : ""}
      ${row(optLabel("X-axis", "Charts along distance, time or % of the activity"), pickList("chart-x", X_KINDS, xKind))}
      ${hasPower ? row(optLabel("Smoothing", "Power and cadence lines: rolling average"), pickList("power-avg", POWER_AVG, powerAvg)) : ""}
      ${(a.best_efforts || []).length ? row(optLabel("Compare with", "Your best from this period, in best efforts and the power curve"), pickList("compare", COMPARE, compare)) : ""}</div>`;
  const chartsPanel = `<div class="opt-panel"><div class="checks checks-col">${available.map((x) =>
    `<label class="check"><input type="checkbox" data-chart-key="${x.key}" ${isShown(x.key) ? "checked" : ""}> ${metricIcon(x.icon, 16)} ${esc(x.label)}</label>`).join("")}</div></div>`;
  const chartsBox = available.length && chartX ? `<div class="charts" data-charts></div>` : "";
  const lapsCard = laps.options.length ? `<div class="card"><div class="card-head"><h3>Laps</h3><span class="spacer"></span>
        <div class="badges">${badgeHtml("laps-n", "Group", lapsLabel(lapsN), { panel: `<div class="opt-panel">${pickList("laps-n", laps.options.map((n) => [n, lapsLabel(n)]), lapsN)}</div>`, right: true })}</div></div>
      <div data-laps>${lapsTable(a, laps, lapsN)}</div></div>` : "";
  const owner = `${avatar(person(a.person_id), 22)} <b>${esc(personLabel(a.person_id))}</b>`;
  root.innerHTML = col ? `
    <div class="card pair-head">${owner}<a href="#/activity/${a.id}" title="Open this activity">${esc(a.name || typeLabel(a.activity_type))}</a>
      <span class="hint">${localTime(a)}${a.connect?.locationName ? ` · ${esc(a.connect.locationName)}` : ""}${a.excluded ? " · Excluded from statistics" : ""}</span></div>
    <div class="act-top" data-top></div>
    <div></div>
    <div><div class="pair-owner">${owner}</div>${chartsBox}</div>
    <div><div class="pair-owner">${owner}</div>${lapsCard}</div>` : `
    ${backLink(`#/activities`, "Activities")}
    <div class="page-head"><h2 class="tb-activity-name">${typeIcon(a.activity_type, 24)}<span>${esc(a.name || typeLabel(a.activity_type))}</span><span class="head-date">${localTime(a)}${a.connect?.locationName ? ` · ${esc(a.connect.locationName)}` : ""}${a.country_name ? ` · ${esc(a.country_name)}` : ""}${a.excluded ? ` · <span data-tip="Edit › Statistics">Excluded from statistics</span>` : ""}</span></h2>
      <div class="badges">${available.length && chartX ? `${badgeHtml("charts", "Charts", `${visibleSeries().length} of ${available.length}`, { panel: chartsPanel })}
          ${badgeHtml("chart-options", "Options", "", { panel: optionsPanel })}` : ""}
        ${badgeHtml("edit", "Edit", "", { panel: editPanel })}${track && !PAIR ? `<div class="badge-wrap"><button class="badge" data-go="#/segments/new/activity?id=${id}&from=activity">Create segment</button></div>` : ""}
        ${badgeHtml("export", "Export", "", { panel: `<div class="opt-panel">${pickList("export", [["fit", "FIT · the whole activity"], ...(track ? [["gpx", "GPX · the route only"]] : [])], "")}</div>` })}</div><span class="spacer"></span>
      ${prevNextHtml(a.prev_id && `#/activity/${a.prev_id}`, a.next_id && `#/activity/${a.next_id}`)}</div>
    <div class="act-top" data-top></div>
    ${a.description ? `<div class="card act-description">${esc(a.description)}</div>` : ""}
    ${track ? `<div class="card route-card"><div class="card-head"><h3 class="tile-title">${metricIcon("route", 18)}<span>Route</span></h3><span class="spacer"></span>
        <div class="badges">${badgeHtml("route-color", "Data", routeModeLabel(mode), { panel: `<div class="opt-panel">${pickList("route-color", ROUTE_MODES.map(([k, l]) => [k, l]), mode, () => "", routeModeIcon)}</div>`, right: true })}
        ${badgeHtml("route-km", "Markers", kmOn ? `Every ${routeKmStep(a)} km` : "None", { panel: `<div class="opt-panel">${pickList("route-km", [["off", "None"], ...routeKmSteps(a).map((k) => [String(k), `Every ${k} km`])], kmOn ? String(routeKmStep(a)) : "off")}</div>`, right: true })}</div></div>
      <div class="route-wrap"><div id="route-map" class="map"></div>
        <div class="route-overlays">${a.activity_type?.startsWith("virtual_") ? `<div class="route-virtual" data-tip="Virtual: ridden or run on a trainer or treadmill in an app; the route is the app's.">Virtual</div>` : ""}<div class="route-weather" data-weather hidden></div><div class="route-legend" id="route-legend" hidden></div></div></div></div>` : ""}
    ${chartsBox}
    ${PAIR ? "" : (a.segments || []).map((s, k) => segmentCardHtml(a, s, k)).join("") /* a pair has no segment pages */}
    ${lapsCard}
    ${track ? `<div class="card" data-new-tiles hidden></div>` : ""}
    <div class="card"><h3>Source files</h3>
      ${a.files.map((f) => `<div>${esc(f.rel_path)}${f.zip_member ? " › " + esc(f.zip_member) : ""} ${state(f.status)}${f.imported_at ? ` <span class="hint">imported ${browserTime(f.imported_at)}</span>` : ""}</div>`).join("") || hint("None")}</div>`;
  if (!col) bindBadges(view); // a column's badges are bound with the page header's
  if (a.segments?.length && !col) { fitEffortCols(view); fillWeather(view); } // weather of the efforts in the segment cards
  root.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", (e) => { location.hash = e.currentTarget.dataset.go; }));
  const panel = root.querySelector('[data-panel="edit"]');
  // Single-choice badges (route colour, markers, lap grouping, x axis): pick, update the value, close.
  const pickBadge = (name, label, apply) => root.querySelectorAll(`[data-pick="${name}"]`).forEach((b) => b.onclick = () => {
    root.querySelectorAll(`[data-pick="${name}"]`).forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); });
    root.querySelector(`[data-badge-value="${name}"]`).innerHTML = label(b.dataset.value);
    document.onclick?.();
    apply(b.dataset.value);
  });
  const lapsBox = root.querySelector("[data-laps]");
  const spreadLaps = () => lapsBox?.querySelectorAll("table[data-spread]").forEach(spreadColumns);
  spreadLaps();
  pickBadge("laps-n", (v) => lapsLabel(v), (v) => { lapsBox.innerHTML = lapsTable(a, laps, v === "device" ? v : Number(v)); spreadLaps(); });
  if (panel) {
    panel.querySelector("[name=type]").onchange = async (e) => {
      await api("activities/" + id, { method: "PATCH", body: JSON.stringify({ type: e.target.value }) });
      renderActivity(id);
    };
    panel.querySelectorAll('[data-pick="workout"]').forEach((b) => b.onclick = async () => {
      const v = b.dataset.value === "auto" ? null : b.dataset.value;
      await api("activities/" + id, { method: "PATCH", body: JSON.stringify({ workout: v }) });
      renderActivity(id);
    });
    const ftpInput = panel.querySelector("[name=ftp]");
    if (ftpInput) {
      ftpInput.onchange = async () => {
        const v = ftpInput.value.trim() === "" ? null : Math.round(Number(ftpInput.value));
        if (v === (a.ftp_override ?? null) || (v != null && !(v >= 30 && v <= 2000))) return;
        await api("activities/" + id, { method: "PATCH", body: JSON.stringify({ ftp: v }) });
        renderActivity(id);
      };
      ftpInput.onkeydown = (e) => { if (e.key === "Enter") ftpInput.blur(); };
    }
    const nameInput = panel.querySelector("[name=name]");
    nameInput.onchange = async () => {
      const v = nameInput.value.trim();
      if (v === (a.name || "")) return;
      await api("activities/" + id, { method: "PATCH", body: JSON.stringify({ name: v || null }) });
      renderActivity(id);
    };
    nameInput.onkeydown = (e) => { if (e.key === "Enter") nameInput.blur(); };
    const resetLines = panel.querySelector("#reset-lines");
    if (resetLines) resetLines.onclick = async () => {
      await api("activities/" + id, { method: "PATCH", body: JSON.stringify({ section_lines: null }) });
      renderActivity(id);
    };
  }
  // Export: the file is downloaded (FIT: the whole activity, GPX: the route only)
  root.querySelectorAll('[data-pick="export"]').forEach((b) => b.onclick = () => {
    document.onclick?.();
    const link = document.createElement("a");
    link.href = `api/activities/${id}/export?format=${b.dataset.value}`;
    link.download = "";
    document.body.append(link);
    link.click();
    link.remove();
  });
  if (panel) {
    // Corrections: the streams are rewritten, so the values taken out are gone
    panel.querySelectorAll("[data-fix]").forEach((b) => b.onclick = async () => {
      const what = b.dataset.fix === "altitude"
        ? "Smooth out the unrealistic altitude spikes?\n\nThe original altitude values are replaced and cannot be brought back (only by importing the file again). Ascent, descent, records and climbs are computed again."
        : "Take the GPS jumps out of this activity?\n\nPositions, speed and distance at the jumps are replaced and cannot be brought back (only by importing the file again). Distance, best efforts and segments are computed again.";
      if (!confirm(what + "\n\nContinue?")) return;
      b.disabled = true;
      try { await api("activities/" + id, { method: "PATCH", body: JSON.stringify({ fix: b.dataset.fix }) }); }
      catch (e) { alert(e.message); }
      renderActivity(id);
    });
    const excl = panel.querySelector("[data-exclude]");
    if (excl) excl.onclick = async () => {
      const out = excl.dataset.exclude === "1";
      if (out && !confirm("Exclude this activity from statistics?\n\nIt stays in Activities, but its totals, records, best efforts and segment times are left out until you include it again.\n\nContinue?")) return;
      await api("activities/" + id, { method: "PATCH", body: JSON.stringify({ excluded: out }) });
      renderActivity(id);
    };
    panel.querySelector("#del").onclick = async () => {
      if (!confirm("Delete this activity from the database?\n\nThe FIT file is not touched. It will not be imported again unless you remove it from the import history.")) return;
      await api("activities/" + id, { method: "DELETE" });
      location.hash = "#/activities";
    };
  }
  // A best effort (list row or power curve point): its stretch on the charts and the map.
  const highlightEffort = (e) => {
    const t = chartX?.time;
    if (!e || !t || !(e.end_s > e.start_s)) { charts?.highlight(null); route?.highlight?.(null); return; }
    const i0 = Math.max(0, t.findIndex((v) => v >= e.start_s));
    let i1 = t.length - 1;
    while (i1 > i0 && t[i1] > e.end_s) i1--;
    charts?.highlight([[i0, i1]]);
    route?.highlight?.([[i0, i1]]);
  };
  // Top tiles: rebuilt when the comparison changes.
  let curve = null, hrCurve = null;
  const renderTop = (records, year) => {
    const cmp = COMPARE.find(([k]) => k === compare) || COMPARE[0];
    const efforts = (a.best_efforts || []).map((e) => {
      const r = records ? records[`${e.kind}:${e.key}:${e.v}`] : { value: e.record, start_time_utc: e.record_time, utc_offset_s: e.record_offset_s };
      const y = year?.[`${e.kind}:${e.key}:${e.v}`];
      const rec = r?.start_time_utc ? r : null;
      // the best before this activity: what a new record beat, and how long it stood
      const before = (p) => (p ? { value: p.value, date: localTime(p).slice(0, 10),
        days: Math.round((Date.parse(a.start_time_utc) - Date.parse(p.start_time_utc)) / 86400000) } : null);
      return { ...e, record: r?.value ?? null, recordDate: rec ? localTime(rec).slice(0, 10) : "",
        recordId: records ? r?.activity_id : e.record_activity, year: y?.value ?? null,
        yearDate: y?.start_time_utc ? localTime(y).slice(0, 10) : "", yearId: y?.activity_id,
        recordPrev: before(records ? r?.prev : e.prev), yearPrev: before(y?.prev) };
    });
    const top = root.querySelector("[data-top]");
    const tiles = tilesHtml();
    // tiles one under another in a column (nothing without a tile)
    const stack = (...cards) => (cards.some(Boolean) ? `<div class="act-col-hr">${cards.join("")}</div>` : "");
    const efforts_ = () => effortsCard(efforts, cmp[0], a.category, a.segments || [], a.start_time_utc.slice(0, 4), a.category === "ride" && Boolean(a.indoor));
    const statsBox = `<div class="act-col-stats${(tiles.match(/stat-col/g) || []).length > 1 ? " two" : ""}${col ? " t-stats" : ""}" data-tiles>${tiles}</div>`;
    // a column: every group has its place (an empty one too), so both sides line up
    const place = (name, html) => `<div class="t-stack t-${name}">${html}</div>`;
    top.innerHTML = col ? statsBox + place("gear", devicesHtml(a) + surfaceCardHtml(a)) + place("zones", hrZonesCard(a) + powerZonesCard(a))
      + place("curve", powerCard(a, efforts) || hrCurveCard(efforts)) + place("efforts", efforts_()) : `${statsBox}${(a.devices || []).length <= 1
      // no device tile: the surface goes under the heart rate zones (no column of its own that
      // would take room from the power curve)
      // Power in zones goes under the heart rate zones
      ? (devicesHtml(a) ? `<div class="act-col-dev">${devicesHtml(a)}${surfaceCardHtml(a)}</div>${stack(hrZonesCard(a), powerZonesCard(a))}`
        : stack(hrZonesCard(a), powerZonesCard(a), surfaceCardHtml(a)))
      : `${devicesHtml(a)}${stack(hrZonesCard(a), powerZonesCard(a), surfaceCardHtml(a))}`}${powerCard(a, efforts) || hrCurveCard(efforts)}${efforts_()}`;
    // A zone row: where the heart rate (or power, as drawn) was in that zone, on charts and map.
    top.querySelectorAll("[data-zone]").forEach((el) => {
      const [kind, lo, hi] = el.dataset.zone.split(":");
      el.onmouseenter = () => {
        const v = available.find((x) => x.key === kind)?.values;
        if (!v) return;
        const ranges = [];
        let run = null;
        for (let i = 0; i < v.length; i++) {
          const inZone = v[i] != null && v[i] >= Number(lo) && v[i] < Number(hi);
          if (inZone) { if (run && i - run[1] <= 3) run[1] = i; else { if (run) ranges.push(run); run = [i, i]; } }
        }
        if (run) ranges.push(run);
        el.classList.add("on");
        charts?.highlight(ranges);
        route?.highlight?.(ranges);
      };
      el.onmouseleave = () => { el.classList.remove("on"); charts?.highlight(null); route?.highlight?.(null); };
    });
    top.querySelectorAll("[data-effort], [data-seg-effort]").forEach((el) => {
      const e = el.dataset.segEffort != null ? a.segments[Number(el.dataset.segEffort)].effort : efforts[Number(el.dataset.effort)];
      el.onmouseenter = () => { el.classList.add("on"); highlightEffort(e); };
      el.onmouseleave = () => { el.classList.remove("on"); highlightEffort(null); };
    });
    curve?.destroy();
    const cEl = top.querySelector("[data-power-curve]");
    curve = cEl && curveChart(cEl, {
      points: efforts.filter((e) => e.kind === "power").map((e) => ({ ...e, compare: e.record, compareDate: e.recordDate })),
      color: "#b9a2f2", unit: "W", label: "Power", compareLabel: cmp[0] === "all" ? "All time best" : `Best · ${cmp[1].toLowerCase()}`,
      onHover: highlightEffort,
    });
    // Heart rate curve: its own tile when there is room (no power tile), same look as the power curve.
    hrCurve?.destroy();
    const hEl = top.querySelector("[data-hr-curve]");
    hrCurve = hEl && curveChart(hEl, {
      points: efforts.filter((e) => e.kind === "hr").map((e) => ({ ...e, compare: e.record, compareDate: e.recordDate })),
      color: "#ef8a8a", unit: "bpm", label: "Heart rate", compareLabel: cmp[0] === "all" ? "All time best" : `Best · ${cmp[1].toLowerCase()}`,
      onHover: highlightEffort,
    });
    bindSlides(top);
    fitZoneStrip(top);
    if (surfaceData) fillSurfaceTile();
  };
  // Best efforts: this year always, the comparison (all time by default) as the last column.
  const byKey = (r) => Object.fromEntries(r.records.map((x) => [`${x.kind}:${x.key}:${x.v}`, x]));
  let yearRecords = null;
  const loadCompare = async () => {
    const [yr, cr] = await Promise.all([
      yearRecords ? null : api(`activities/${id}/records?range=year`).catch(() => null),
      compare === "all" ? null : api(`activities/${id}/records?range=${compare}`),
    ]);
    if (yr) yearRecords = byKey(yr);
    renderTop(cr ? byKey(cr) : null, yearRecords);
  };
  // Moved, added or removed lines are saved at once (seconds from the start); Edit › Reset lines
  // drops them and the detection is back.
  const saveLines = (kind, at) => {
    const t = chartX.time;
    api("activities/" + id, { method: "PATCH", body: JSON.stringify({ section_lines: { kind, splits: at.map((i) => Math.round(t[i])) } }) })
      .then(() => { const r = root.querySelector("[data-reset-lines]"); if (r) r.hidden = false; }).catch(() => {});
  };
  // Charts (docs/CHARTS.md): synced with each other and with the route map.
  let charts = null;
  const route = col ? col.route : track ? { a, st, mode, km: kmOn ? routeKmStep(a) : 0, sections } : null;
  // lines moved, added or removed: the Intervals layer of the map follows
  if (sections) sections.onChange = (at) => { if (route?.mode === "intervals") drawActivityRoute(route); saveLines("intervals", at); };
  if (climbs) climbs.onChange = (at) => saveLines("hills", at);
  const chartsEl = root.querySelector("[data-charts]");
  let surfaceData = null;
  // all stretches of one surface kind highlighted on the charts and the map (null clears)
  const highlightSurface = (kind) => {
    const d = chartX?.distance;
    if (!kind || !d || !surfaceData) { charts?.highlight(null); route?.highlight?.(null); return; }
    const idx = (m) => { const k = d.findIndex((v) => v * 1000 >= m); return k < 0 ? d.length - 1 : k; };
    const ranges = surfaceData.runs.filter((r) => r[2] === kind).map(([a0, b0]) => [idx(a0), idx(b0)]);
    charts?.highlight(ranges);
    route?.highlight?.(ranges);
  };
  const fillSurfaceTile = () => {
    const box = root.querySelector("[data-surface-share]");
    if (!box) return;
    box.innerHTML = `<h3 class="tile-title">${metricIcon("route", 18)}<span>Surface</span></h3>${surfaceShareHtml(surfaceData)}`;
    const d = chartX?.distance;
    box.querySelectorAll("[data-surface-kind]").forEach((el) => {
      el.onmouseenter = () => {
        if (!d) return;
        const idx = (m) => { const k = d.findIndex((v) => v * 1000 >= m); return k < 0 ? d.length - 1 : k; };
        const ranges = surfaceData.runs.filter((r) => r[2] === el.dataset.surfaceKind).map(([a0, b0]) => [idx(a0), idx(b0)]);
        el.classList.add("on");
        charts?.highlight(ranges);
        route?.highlight?.(ranges);
      };
      el.onmouseleave = () => { el.classList.remove("on"); charts?.highlight(null); route?.highlight?.(null); };
    });
  };
  // Surface runs (metres) → sample index ranges, drawn on the altitude chart (or the first one).
  const applySurface = () => {
    const d = chartX?.distance;
    if (!surfaceData || !charts || !d) return;
    const idx = (m) => { const k = d.findIndex((v) => v * 1000 >= m); return k < 0 ? d.length - 1 : k; };
    charts.surface("altitude", surfaceData.runs.map(([a, b, kind]) => [idx(a), idx(b), kind]), surfaceData.shares, highlightSurface);
  };
  const applyPower = () => available.filter((x) => x.key === "power" || x.key === "cadence")
    .forEach((p) => { p.values = smoothByTime(p.raw, chartX.time, powerAvg); });
  const mountCharts = () => {
    if (!chartsEl) return;
    applyPower();
    charts = chartGroup(chartsEl, {
      x: chartX, kind: xKind, series: visibleSeries(), sections: [sections, climbs].filter(Boolean), pair: col?.pair,
      onHover: (i) => (col ? col.route.hover(i) : route && routeHover(route, i)),
      onRanges: (r) => route?.highlight?.(r), // a stat's stretches on the map too
      // Dragged into a new order: kept per person, like the chart list.
      onOrder: (keys) => {
        const all = [...keys, ...available.map((x) => x.key).filter((k) => !keys.includes(k))];
        available.sort((p, q) => all.indexOf(p.key) - all.indexOf(q.key));
        saveUi("activity-chart-order", all);
        col?.onOrder();
      },
    });
    // Options panel choices: mark the pick, apply, keep the panel open.
    const pickOpt = (name, apply) => root.querySelectorAll(`[data-pick="${name}"]`).forEach((b) => b.onclick = () => {
      root.querySelectorAll(`[data-pick="${name}"]`).forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); });
      apply(b.dataset.value);
    });
    pickOpt("chart-x", (v) => { charts.setKind(v); setTimeout(applySurface, 200); });
    pickOpt("compare", (v) => { compare = v; saveUi("activity-compare", v); loadCompare(); });
    pickOpt("power-avg", (v) => { powerAvg = Number(v); saveUi("activity-power-avg", powerAvg); applyPower(); charts.setSeries(visibleSeries()); });
    root.querySelectorAll("[data-chart-key]").forEach((c) => c.onchange = () => {
      const choice = chartChoice();
      choice[c.dataset.chartKey] = c.checked;
      saveUi("activity-charts", choice);
      charts.setSeries(visibleSeries());
      setTimeout(applySurface, 200);
      root.querySelector('[data-badge-value="charts"]').textContent = `${visibleSeries().length} of ${available.length}`;
    });
    applySurface(); // the map data may be here already
  };
  if (!col) mountCharts();
  if (track) {
    route.charts = charts;
    const draw = () => drawActivityRoute(route);
    showRouteMap("route-map", track.polyline, { offset: routeOffset }).then(() => { route.ready = true; bindRouteHover(route); draw(); newTilesCard(root, a, track); }).catch((e) => {
      document.getElementById("route-map").outerHTML = state("Map unavailable: " + esc(e.message), "bad") + trackSvg(track.polyline);
    });
    pickBadge("route-color", routeModeLabel, (v) => { route.mode = v; draw(); });
    const mapEl = document.getElementById("route-map");
    if (mapEl) cardResize(mapEl.closest(".card"), () => mapEl.offsetHeight, (h) => { mapEl.style.height = `${h}px`; activeMap?.resize(); }, 220, 1000);
    route.highlight = (r) => routeHighlight(route, r);
    root.querySelectorAll('[data-pick="route-offset"]').forEach((b) => b.onclick = () => {
      root.querySelectorAll('[data-pick="route-offset"]').forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); });
      routeOffset = b.dataset.value === "on";
      saveUi("activity-route-offset", routeOffset);
      setRouteOffset(routeOffset);
    });
    pickBadge("route-km", (v) => (v === "off" ? "None" : `Every ${v} km`), (v) => { route.km = v === "off" ? 0 : Number(v); draw(); });
  }
  loadCompare();
  // Weather during the activity (Open-Meteo, cached after the first time): a widget on the map.
  // Not indoors or virtual: the weather outside is not theirs, a virtual route is a game world.
  if (a.has_gps && !a.indoor && !col) {
    api(`activities/${id}/weather`).then((w) => {
      const box = root.querySelector("[data-weather]");
      if (box && w && w.temp != null) { box.innerHTML = weatherHtml(w); box.hidden = false; }
      // under it, without a background: did the weather help (rides and runs outdoors)
      const meter = track ? activityHelpHtml(a, track.polyline, w) : "";
      if (box && meter) box.insertAdjacentHTML("afterend", `<div class="route-wx-help">${meter}</div>`);
    }).catch(() => {});
  }
  // Road surface (OpenStreetMap, cached after the first time): shares in the tile, strip on a chart.
  if (hasSurface(a)) {
    api(`activities/${id}/surface`).then((sf) => {
      if (!sf || !sf.runs) { root.querySelector("[data-surface-share]")?.remove(); return; }
      surfaceData = sf;
      fillSurfaceTile();
      applySurface();
      if (route) { route.surface = sf; if (route.mode === "surface") drawActivityRoute(route); }
    }).catch(() => { const box = root.querySelector("[data-surface-share]"); if (box) box.querySelector(".hint").textContent = "Map data not available now."; });
  }
  if (!col) return null;
  return {
    st, chartX, isShown,
    series: () => (chartX ? available : []),
    options: { powerAvgs: POWER_AVG, powerAvg, hasPower },
    charts: () => charts,
    mount(shared) { common = shared; mountCharts(); },
    refreshCharts() {
      const saved = UI.data["activity-chart-order"] || [];
      const at = (k) => (saved.includes(k) ? saved.indexOf(k) : saved.length + CHART_DEFS.findIndex(([x]) => x === k));
      available.sort((p, q) => at(p.key) - at(q.key));
      charts?.setSeries(visibleSeries());
      setTimeout(applySurface, 200);
    },
    setPowerAvg(v) { powerAvg = v; applyPower(); this.refreshCharts(); },
  };
}

// X values for the activity charts: distance in km (forward-filled, never decreasing) and
// time in seconds from the start. Distance is null when the activity has none (indoor).
function activityChartX(st) {
  const n = Math.max(st.time?.length || 0, st.distance?.length || 0);
  if (!n) return null;
  const t0 = st.time?.find((v) => v != null) ?? 0;
  let lastT = 0, lastD = 0;
  const time = [], dist = [];
  for (let i = 0; i < n; i++) {
    lastT = Math.max(lastT, st.time?.[i] != null ? st.time[i] - t0 : lastT); time.push(lastT);
    lastD = Math.max(lastD, st.distance?.[i] != null ? st.distance[i] / 1000 : lastD); dist.push(lastD);
  }
  const base = lastD > 0.05 ? dist : time, total = base[base.length - 1] || 1;
  // Timer time: the watch records nothing while paused, so a gap over 30 s is a pause and
  // counts 1 s; everything else counts in full (standing still included).
  const timer = [];
  let tm = 0;
  for (let i = 0; i < n; i++) {
    if (i) { const dt = time[i] - time[i - 1]; tm += dt > 30 ? 1 : Math.max(0, dt); }
    timer.push(tm);
  }
  return { time, timer: tm > 0 && tm < time[n - 1] - 30 ? timer : null, distance: lastD > 0.05 ? dist : null, percent: base.map((v) => (v / total) * 100) };
}

// Trailing average over `secs` seconds of time t (samples without a value are skipped).
function smoothByTime(v, t, secs) {
  if (!secs || !t) return v;
  const out = new Array(v.length);
  let sum = 0, n = 0, j = 0;
  for (let i = 0; i < v.length; i++) {
    if (v[i] != null) { sum += v[i]; n++; }
    while (t[i] - t[j] >= secs && j < i) { if (v[j] != null) { sum -= v[j]; n--; } j++; }
    out[i] = v[i] == null ? null : n ? sum / n : null;
  }
  return out;
}

// ---- Activity top tiles: stats, devices, HR zones, power (curve | zones), best efforts ----

// Device pictures: own photos (data/device-images/<product>.png) or a drawing per kind.
const DEVICE_ART = {
  watch: `<rect x="20" y="4" width="24" height="12" rx="3"/><rect x="20" y="48" width="24" height="12" rx="3"/><rect x="14" y="14" width="36" height="36" rx="11" class="fill"/><circle cx="32" cy="32" r="11" class="screen"/><path d="M32 25v7l5 3"/><path d="M50 26h3v8h-3"/>`,
  bike_computer: `<rect x="14" y="6" width="36" height="52" rx="8" class="fill"/><rect x="19" y="12" width="26" height="32" rx="3" class="screen"/><path d="M23 20h12M23 26h18M23 32h9"/><circle cx="26" cy="51" r="2.5"/><circle cx="38" cy="51" r="2.5"/>`,
  hr_strap: `<path d="M4 34c8-8 16-10 28-10s20 2 28 10"/><path d="M4 40c8-8 16-10 28-10s20 2 28 10"/><rect x="20" y="22" width="24" height="18" rx="7" class="fill"/><path d="M27 31c1.5-3 4-3 5 0 1-3 3.5-3 5 0-1 3-5 5-5 5s-4-2-5-5z" class="accent"/>`,
  power_meter: `<rect x="8" y="24" width="38" height="16" rx="6" class="fill"/><path d="M46 32h12"/><circle cx="58" cy="32" r="3"/><rect x="14" y="28" width="12" height="8" rx="2" class="screen"/><path d="M32 28l-3 5h4l-3 5" class="accent-stroke"/>`,
  radar: `<rect x="22" y="6" width="20" height="52" rx="8" class="fill"/><rect x="26" y="12" width="12" height="16" rx="4" class="accent"/><path d="M27 38h10M27 43h10M27 48h10"/><path d="M12 22c-3 6-3 14 0 20M8 18c-5 9-5 19 0 28"/>`,
  light: `<rect x="22" y="10" width="20" height="44" rx="8" class="fill"/><rect x="26" y="16" width="12" height="20" rx="4" class="accent"/><path d="M14 26h-6M14 32h-8M14 38h-6"/>`,
  speed_cadence: `<rect x="18" y="20" width="28" height="24" rx="9" class="fill"/><circle cx="32" cy="32" r="5" class="screen"/><path d="M8 32h10M46 32h10"/>`,
  foot_pod: `<path d="M10 42c10 0 14-12 24-12h12c6 0 10 4 10 10v4H10z" class="fill"/><rect x="28" y="22" width="14" height="10" rx="4" class="screen"/>`,
  scale: `<rect x="8" y="8" width="48" height="48" rx="12" class="fill"/><rect x="20" y="15" width="24" height="13" rx="4" class="screen"/><path d="M32 25l4-6" class="accent-stroke"/><path d="M18 46h8M38 46h8"/>`,
  trainer: `<circle cx="22" cy="40" r="12" class="fill"/><circle cx="22" cy="40" r="4"/><path d="M34 40h18l4 14H30M44 40V24l8-6"/>`,
  app: `<rect x="18" y="4" width="28" height="56" rx="6" class="fill"/><rect x="22" y="12" width="20" height="38" rx="2" class="screen"/><path d="M27 34l4-8 4 6 3-4" class="accent-stroke"/>`,
  sensor: `<rect x="16" y="18" width="32" height="28" rx="10" class="fill"/><path d="M26 32h12M32 26v12"/>`,
};
const DEVICE_KIND_LABEL = { watch: "Watch", bike_computer: "Bike computer", app: "App", power_meter: "Power meter",
  hr_strap: "Heart rate strap", trainer: "Smart trainer", radar: "Radar", light: "Bike light",
  speed_cadence: "Speed / cadence sensor", foot_pod: "Foot pod", shifting: "Shifting", sensor: "Sensor",
  scale: "Scale" };
const devicePic = (d) => `<div class="device-pic">${d.image ? `<img src="${esc(d.image)}" alt="">` : `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${DEVICE_ART[d.kind] || DEVICE_ART.sensor}</svg>`}</div>`;
function devicesHtml(a) {
  const seen = new Set();
  const list = (Array.isArray(a.devices) ? a.devices : []).filter((d) => {
    const k = `${d.maker}|${d.name}|${d.kind}`;
    return !seen.has(k) && seen.add(k);
  });
  if (!list.length) return "";
  return `<div class="card act-tile act-devices"><h3 class="tile-title">${metricIcon("watch", 18)}<span>Gear</span></h3><div class="devices">${list.map((d) => `<div class="device">
      ${devicePic(d)}
      <div class="device-text"><b>${esc(d.name || "Device")}</b><span title="${esc([d.maker, DEVICE_KIND_LABEL[d.kind]].filter(Boolean).join(" · "))}">${esc([d.maker, DEVICE_KIND_LABEL[d.kind]].filter(Boolean).join(" · "))}</span></div></div>`).join("")}</div></div>`;
}

// A segment ridden in the activity: title with its name (link), a Show segment badge and the
// person's efforts in three tables like the one on the segment page - Last (this one and the
// two before it), Best, Best · last 12 months; this activity marked in the Activity column.
function segmentCardHtml(a, s, k) {
  const seg = s.segment;
  const all = [s.effort, ...s.best, ...s.best_12m, ...s.previous];
  const opts = { power: all.some((e) => e.avg_power != null), thisId: s.effort.id, polyline: seg.polyline };
  const table = (title, list) => (list.length ? `<div class="act-seg-table"><h4>${title}</h4>${effortTable(list, a.category, opts)}</div>` : "");
  return `<div class="card act-seg" data-seg-card="${k}"><div class="card-head"><h3 class="tile-title">${metricIcon("route", 18)}<span>Segment:</span><a href="#/segment/${seg.id}">${esc(seg.name || "Segment")}</a></h3>
      <span class="hint">${km(seg.distance_m)}${seg.ascent_m ? ` · +${num(seg.ascent_m)} m` : ""}</span><span class="spacer"></span>
      <div class="badges"><div class="badge-wrap"><button class="badge" data-go="#/segment/${seg.id}">Show segment</button></div></div></div>
    ${table("Last", [s.effort, ...s.previous])}${table("Best", s.best)}${table("Best · last 12 months", s.best_12m)}</div>`;
}

// Clock-style duration: 1:02:03, 4:12.
const clock = (s) => {
  const t = Math.round(s), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
};

// Garmin's time in zones (from the FIT file) as one bar per zone, highest zone on top, in the
// zone colours (HR green → red, power grey → black, as on the route map). Share only; the
// time and the zone range on hover.
function zoneBars(a, kind) {
  let z = null;
  try { z = a.zones ? JSON.parse(a.zones) : null; } catch { z = null; }
  const d = z?.[kind];
  if (!d) return "";
  const b = d.bounds, unitLabel = kind === "hr" ? "bpm" : "W";
  // HR (and cycling power, starting at 0): bounds[0] is the low limit of zone 1 (times[0] =
  // below zone 1); running power: every bound is the high limit of a zone.
  const lowFirst = kind === "hr" || b[0] === 0;
  const zones = lowFirst ? b.slice(1).map((hi, k) => ({ lo: b[k], hi, t: d.times[k + 1] || 0 }))
    : b.map((hi, k) => ({ lo: k ? b[k - 1] : 0, hi, t: d.times[k] || 0 }));
  const total = zones.reduce((s, x) => s + x.t, 0) + (lowFirst ? d.times[0] || 0 : 0);
  if (!total) return "";
  const max = Math.max(...zones.map((x) => x.t), 1);
  const rng = (x, k) => (k === zones.length - 1 && x.hi >= 1000 ? `${num(x.lo)}+` : k === 0 && !x.lo ? `under ${num(x.hi)}` : `${num(x.lo)}–${num(x.hi)}`);
  return `<div class="zone-bars${kind === "power" ? " with-time" : ""}">${zones.map((x, k) => {
    const c = kind === "power" ? powerZoneColor(k + 1) : rampColor(ROUTE_SCALES[kind].stops, zones.length > 1 ? k / (zones.length - 1) : 0);
    return `<div class="zone-row" style="--zc:${c}" data-zone="${kind}:${x.lo}:${x.hi}" data-tip="Zone ${k + 1} (${rng(x, k)} ${unitLabel}): ${x.t ? clock(x.t) : "no time"}"><span class="zone-name">Z${k + 1}</span>
      <span class="zone-bar"><span style="width:${(x.t / max) * 100}%"></span></span>${kind === "power" ? `<span class="zone-time">${x.t ? clock(x.t) : "–"}</span>` : ""}<span class="zone-pct">${num((x.t / total) * 100)}%</span></div>`;
  }).reverse().join("")}${lowFirst && d.times[0] / total >= 0.01 ? `<div class="zone-row zone-below" style="--zc:var(--muted)" data-tip="Below zone 1 (under ${num(b[0])} ${unitLabel}): ${clock(d.times[0])}">
      <span class="zone-name">–</span><span class="zone-bar"><span style="width:${Math.min(100, (d.times[0] / max) * 100)}%"></span></span>${kind === "power" ? `<span class="zone-time">${clock(d.times[0])}</span>` : ""}<span class="zone-pct">${num((d.times[0] / total) * 100)}%</span></div>` : ""}</div>`;
}
// The file had no time in zones (virtual rides): counted from the line, with the zones of the
// nearest activity that has them.
function computedZonesTip(a, kind) {
  let from = null;
  try { const z = JSON.parse(a.zones || "{}")[kind]; if (z?.computed) from = z.from; } catch { from = null; }
  return from ? ` data-tip="Counted from the ${kind === "hr" ? "heart rate" : "power"}, with the zones of your activity of ${esc(from.slice(0, 10))}"` : "";
}
function hrZonesCard(a) {
  const bars = zoneBars(a, "hr");
  const tip = computedZonesTip(a, "hr");
  return bars ? `<div class="card act-tile act-hr"><h3 class="tile-title"${tip}>${metricIcon("time_in_hr_zone", 18)}<span>Heart rate in zones</span></h3>${bars}</div>` : "";
}
// Road surface: outdoors only - a virtual route is an app's world, not a road.
const hasSurface = (a) => Boolean(a.has_gps) && !a.activity_type?.startsWith("virtual_");
// Road surface tile (filled when the map data arrives).
function surfaceCardHtml(a) {
  return hasSurface(a) ? `<div class="card act-tile act-surface" data-surface-share><h3 class="tile-title">${metricIcon("route", 18)}<span>Surface</span></h3><div class="hint">Loading map data…</div></div>` : "";
}
// Surface shares: one stacked bar in the surface hatching and the share of each kind.
function surfaceShareHtml(sf) {
  const total = Object.values(sf.shares || {}).reduce((x, y) => x + y, 0);
  if (!total) return "";
  const kinds = SURFACE_KINDS.filter((k) => sf.shares[k]);
  return `<div class="surface-bar">${kinds.map((k) => `<span class="surface-swatch s-${k}" style="width:${(sf.shares[k] / total) * 100}%" data-surface-kind="${k}" data-tip="${SURFACE_LABEL[k]}: ${km(sf.shares[k])}"></span>`).join("")}</div>
    <div class="surface-list">${kinds.map((k) => `<span data-surface-kind="${k}" data-tip="${SURFACE_LABEL[k]}: ${km(sf.shares[k])}"><i class="surface-swatch s-${k}"></i>${SURFACE_LABEL[k]} <b>${num((sf.shares[k] / total) * 100)}%</b></span>`).join("")}</div>`;
}
// Power curve (rides: a power meter, not an estimate).
function powerCard(a, efforts) {
  if (a.category !== "ride" || efforts.filter((e) => e.kind === "power").length < 2) return "";
  return `<div class="card act-tile act-power"><h3 class="tile-title">${metricIcon("power", 18)}<span>Power curve</span></h3>
    <div class="curve-box" data-power-curve></div></div>`;
}
// Power in zones: a small tile of its own (like Surface) with the zones as one bar.
function powerZonesCard(a) {
  const strip = a.category === "ride" ? powerZoneStrip(a) : "";
  return strip ? `<div class="card act-tile act-pzones"><h3 class="tile-title"${computedZonesTip(a, "power")}>${metricIcon("time_in_power_zone", 18)}<span>Power in zones</span></h3>${strip}</div>` : "";
}
// Time in power zones as one bar (as wide as the surface bar's tile allows): each zone its share
// in fixed colours, Z1 grey … Z7 black; the share over a zone and its name under it only where
// they fit (fitZoneStrip); hovering a zone: its range, share and time, and where it was on the
// charts and the map.
const POWER_ZONE_COLORS = ["#a3a9b3", "#4a90e2", "#43a047", "#f2c200", "#e53935", "#8e44ad", "var(--zone-black)"];
// Power zone z (1…) in the colours above - everywhere power zones are shown.
const powerZoneColor = (z) => POWER_ZONE_COLORS[Math.min(Math.max(z, 1), POWER_ZONE_COLORS.length) - 1];
const PZ_LABEL_MIN = 0.15; // a zone with a smaller share gets neither its share nor its name
function powerZoneStrip(a) {
  let z = null;
  try { z = a.zones ? JSON.parse(a.zones) : null; } catch { z = null; }
  const d = z?.power;
  if (!d) return "";
  const b = d.bounds;
  const lowFirst = b[0] === 0; // cycling power starts at 0: times[0] (under 0 W) belongs to zone 1
  const zones = lowFirst ? b.slice(1).map((hi, k) => ({ lo: b[k], hi, t: (d.times[k + 1] || 0) + (k ? 0 : d.times[0] || 0) }))
    : b.map((hi, k) => ({ lo: k ? b[k - 1] : 0, hi, t: d.times[k] || 0 }));
  const total = zones.reduce((s, x) => s + x.t, 0);
  if (!total) return "";
  const rng = (x, k) => (k === zones.length - 1 && x.hi >= 1000 ? `${num(x.lo)}+` : `${num(x.lo)}–${num(x.hi)}`);
  const parts = zones.map((x, k) => ({ ...x, k, share: x.t / total })).filter((x) => x.t > 0);
  const col = (x) => POWER_ZONE_COLORS[Math.min(x.k, POWER_ZONE_COLORS.length - 1)];
  const grid = parts.map((x) => `${x.share}fr`).join(" ");
  return `<div class="pz-strip" style="grid-template-columns:${grid}">
    ${parts.map((x) => `<span class="pz-pct" data-fit>${x.share >= PZ_LABEL_MIN ? `${num(x.share * 100)}%` : ""}</span>`).join("")}
    ${parts.map((x, i) => `<span class="pz-seg${i ? "" : " first"}${i === parts.length - 1 ? " last" : ""}" style="--zc:${col(x)}" data-zone="power:${x.lo}:${x.hi}" data-tip="Zone ${x.k + 1} (${rng(x, x.k)} W): ${num(x.share * 100)} % · ${clock(x.t)}"></span>`).join("")}
    ${parts.map((x) => `<span class="pz-name" data-fit>${x.share >= PZ_LABEL_MIN ? `Z${x.k + 1}` : ""}</span>`).join("")}</div>`;
}
// The shares and zone names only where they fit with a little room; the others stay empty.
function fitZoneStrip(root) {
  root.querySelectorAll(".pz-strip").forEach((s) => {
    const fit = () => s.querySelectorAll("[data-fit]").forEach((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      el.style.visibility = r.getBoundingClientRect().width + 6 > el.clientWidth ? "hidden" : "";
    });
    fit();
    if (!s._fit) { s._fit = new ResizeObserver(fit); s._fit.observe(s); } // the tile changes width
  });
}
// Heart rate curve tile (shown instead of the power tile when there is none).
function hrCurveCard(efforts) {
  if (efforts.filter((e) => e.kind === "hr").length < 2) return "";
  return `<div class="card act-tile act-power"><div class="slides"><div class="slide"><h3 class="tile-title">${metricIcon("heart_rate", 18)}<span>Heart rate curve</span></h3>
    <div class="curve-box" data-hr-curve></div></div></div></div>`;
}
// Sliding tiles: dots switch, horizontal scroll (trackpad, touch) moves the dots.
function bindSlides(root) {
  root.querySelectorAll("[data-slides]").forEach((box) => {
    const dots = box.parentElement.querySelectorAll("[data-slide]");
    dots.forEach((d) => d.onclick = () => box.scrollTo({ left: Number(d.dataset.slide) * box.clientWidth, behavior: "smooth" }));
    box.onscroll = () => { const k = Math.round(box.scrollLeft / box.clientWidth); dots.forEach((d, j) => d.classList.toggle("on", j === k)); };
  });
}

// Best efforts: fastest time over each distance, the record in brackets (or a record badge);
// hover = the stretch on the charts and the map.
const LAUREL_SVG = `<svg class="laurel" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#c99a2e" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21c-4.5-1-7.5-5-7.5-10.5 0-2 .4-3.8 1-5.5"/><path d="M12 21c4.5-1 7.5-5 7.5-10.5 0-2-.4-3.8-1-5.5"/><path d="M5.2 8.5c-1.6-.4-2.6-1.6-2.8-3 1.5-.2 2.7.6 3.2 1.9M4.6 12.4c-1.6.1-2.9-.8-3.4-2.2 1.4-.5 2.8 0 3.6 1.2M5.6 16.1c-1.5.5-3 0-3.8-1.3 1.3-.8 2.8-.6 3.8.4M8 19c-1.3.9-2.9.8-3.9-.2 1-1.1 2.6-1.3 3.9-.6"/><path d="M18.8 8.5c1.6-.4 2.6-1.6 2.8-3-1.5-.2-2.7.6-3.2 1.9M19.4 12.4c1.6.1 2.9-.8 3.4-2.2-1.4-.5-2.8 0-3.6 1.2M18.4 16.1c1.5.5 3 0 3.8-1.3-1.3-.8-2.8-.6-3.8.4M16 19c1.3.9 2.9.8 3.9-.2-1-1.1-2.6-1.3-3.9-.6"/></svg>`;
const EFFORT_NAMES = { 400: "400 m", 1000: "1 km", 1609.344: "1 mile", 5000: "5 km", 10000: "10 km", 20000: "20 km", 30000: "30 km",
  21097.5: "Half marathon", 40000: "40 km", 42195: "Marathon", 50000: "50 km", 100000: "100 km" };
const COMPARE_SHORT = { all: ["ATH", "All-time best"], year: ["YTD", "Best this year (from 1 January)"], "365d": ["12 mo", "Best in the last 12 months"],
  "90d": ["3 mo", "Best in the last 3 months"], "30d": ["30 d", "Best in the last 30 days"] };
// Tooltip of a record laurel: by how much the previous best ({value, date, days}) is beaten and
// how long it stood. Times in seconds (lower is better), or watts with `isPower`.
// isPower: higher is better, in W; "km": higher is better, a distance (the longest)
// "kmh": higher is better, a speed in m/s (the top speed)
function recordTip(tip, value, p, isPower) {
  if (!p) return `${tip}: this activity, the first result`;
  const d = p.value - value;
  const fmt = (v) => (isPower === "km" ? km(v) : isPower === "kmh" ? kmh(v) : isPower === "m" ? meters(v) : isPower === "pct" ? `${num(v, 1)} %` : isPower ? watts(v) : clock(v));
  const gain = isPower === "km" ? `${km(-d)} farther` : isPower === "m" ? `${meters(-d)} more` : isPower === "pct" ? `${num(-d, 1)} % steeper` : isPower === "kmh" ? `${kmh(-d)} faster` : isPower ? `${watts(-d)} more` : `${d < 60 ? `${num(d, d < 10 ? 1 : 0)} s` : clock(d)} faster`;
  return `${tip}: this activity. ${gain} than ${fmt(p.value)} from ${p.date} (${num(p.days)} ${p.days === 1 ? "day" : "days"} earlier)`;
}
// year: the activity's year - its column holds the best of that whole year ("YTD" this year)
// indoor: an indoor ride (virtual, trainer) - its distances and top speed are records of their own
function effortsCard(efforts, compareKey, category, segs = [], year = todayDay().slice(0, 4), indoor = false) {
  const ride = category === "ride";
  const thisYear = year === todayDay().slice(0, 4);
  const yearTip = thisYear ? "Best this year" : `Best in ${year}`;
  // Distances (fastest time), then the longest distance ("Max"); on rides also the top speed
  // over 1 min and the best 20 min and 1 h power.
  // distances, then Distance, Ascent and Steepest side by side, Speed1m and Hour (Cooper), power
  const RANK = { longest: 1, ascent: 2, grade: 3, speed: 4, within: 5, power: 6 };
  const order = (e) => RANK[e.kind] || 0;
  // runs and rides only (walks and hikes have their records in Statistics › Records)
  const list = efforts.map((e, k) => ({ ...e, k }))
    .filter((e) => (ride || category === "run") && (e.kind === "pace" || e.kind === "ride" || e.kind === "longest" || e.kind === "within" || e.kind === "ascent" || e.kind === "grade" || (ride && e.kind === "speed") || (ride && e.kind === "power" && (e.key === 1200 || e.key === 3600))))
    .sort((p, q) => order(p) - order(q) || p.key - q.key);
  if (!list.length && !segs.length) return "";
  const [short, long] = COMPARE_SHORT[compareKey] || COMPARE_SHORT.all;
  const longest = (e) => e.kind === "longest" || e.kind === "within"; // a distance, higher is better
  const power = (e) => e.kind === "power" || e.kind === "speed" || e.kind === "ascent" || e.kind === "grade" || longest(e); // one wide value, higher is better
  const better = (e, v, than) => than != null && (power(e) ? v >= than - 0.05 : v <= than + 0.05);
  const val = (e, v) => (e.kind === "ascent" ? meters(v) : e.kind === "grade" ? `${num(v, 1)} %` : longest(e) ? km(v) : e.kind === "speed" ? kmh(v) : power(e) ? watts(v) : clock(v));
  const speed = (e, t) => (power(e) ? "" : ride ? `${num((e.key / t) * 3.6, 1)} km/h` : `${clock(t / (e.key / 1000))} /km`);
  const name = (e) => (e.kind === "grade" ? `<span data-tip="Steepest 1 km: the highest average grade over 1 km; altitude and distance jumps left out">Steepest</span>`
    : e.kind === "ascent" ? `<span data-tip="Elevation gain of the whole activity">Ascent</span>`
    : e.kind === "within" ? (e.key === 720 ? `<span data-tip="Longest distance run within 12 minutes (Cooper test)">Cooper</span>`
      : `<span data-tip="Longest distance within ${durFull(e.key)}">Hour</span>`)
    : longest(e) ? `<span data-tip="Longest distance in one activity">Distance</span>`
    : e.kind === "speed" ? `<span data-tip="Top speed held for 1 minute (stretches with GPS jumps left out)">Speed1m</span>`
    : power(e) ? (e.key === 1200 ? "Power20m" : "Power1h") : EFFORT_NAMES[e.key] || km(e.key));
  // a past best: time and speed, or a laurel when this activity is that best
  // a past best links to its activity; the tooltip says when it was set
  const recLink = (txt, date, id, tip, cls = "") => (id ? `<a class="effort-rec plain-link ${cls}" href="#/activity/${id}" data-tip="${tip}${date ? `: ${date}` : ""}">${txt}</a>`
    : `<span class="effort-rec ${cls}" data-tip="${tip}${date ? `: ${date}` : ""}">${txt}</span>`);
  // a new record: how long the previous one stood and by how much it is beaten
  const pbTip = (e, tip, p) => recordTip(tip, e.value, p, e.kind === "grade" ? "pct" : e.kind === "ascent" ? "m" : longest(e) ? "km" : e.kind === "speed" ? "kmh" : power(e));
  const cell = (e, rec, tip, date = "", id = null, prev = null) => (better(e, e.value, rec) ? `<span class="effort-rec effort-pb span2" data-tip="${pbTip(e, tip, prev)}">${LAUREL_SVG}</span>`
    : rec != null ? (power(e) ? recLink(val(e, rec), date, id, tip, "span2") : `${recLink(val(e, rec), date, id, tip)}<span class="effort-speed">${speed(e, rec)}</span>`)
    : `<span class="effort-rec${power(e) ? " span2" : ""}">–</span>${power(e) ? "" : "<span></span>"}`);
  // segments ridden in this activity: time this time, best this year, best of all time
  const segSpeed = (s, t) => (t ? (ride ? `${num((s.segment.distance_m / t) * 3.6, 1)} km/h` : `${clock(t / (s.segment.distance_m / 1000))} /km`) : "");
  const segPrev = (s, p) => (p ? { value: p.elapsed_s, date: localTime(p).slice(0, 10),
    days: Math.round((Date.parse(s.effort.start_time_utc) - Date.parse(p.start_time_utc)) / 86400000) } : null);
  const segCell = (s, t, tip, b, p) => (t != null && s.effort.elapsed_s <= t + 0.05 ? `<span class="effort-rec effort-pb span2" data-tip="${recordTip(tip, s.effort.elapsed_s, segPrev(s, p), false)}">${LAUREL_SVG}</span>`
    : t != null ? `${recLink(clock(t), b?.start_time_utc ? localTime(b).slice(0, 10) : "", b?.activity_id, tip)}<span class="effort-speed">${segSpeed(s, t)}</span>` : `<span class="effort-rec">–</span><span></span>`);
  const segRows = segs.map((s, k) => `<div class="effort effort-seg" data-seg-effort="${k}"><span class="effort-name" title="Segment: ${esc(s.segment.name || "Segment")}">${esc(s.segment.name || "Segment")}</span>
      <b>${clock(s.effort.elapsed_s)}</b><span class="effort-speed">${segSpeed(s, s.effort.elapsed_s)}</span>${segCell(s, s.year_best, yearTip, s.year_best_effort, s.year_prev)}${segCell(s, s.all_best, "All-time best", s.all_best_effort, s.all_prev)}</div>`).join("");
  return `<div class="card act-tile act-efforts"><h3 class="tile-title"${indoor ? ` data-tip="Indoor rides (virtual, trainer): distances and top speed compared with indoor rides only, power with all rides"` : ""}>${LAUREL_SVG}<span>Best efforts${indoor ? " virtual" : ""}</span></h3>
    <div class="efforts"><div class="effort effort-head"><span></span><span class="eh-now" data-tip="This activity">Activity</span><span class="eh-year" data-tip="${thisYear ? "Best this year: from 1 January to today" : `Best in the whole year ${year}`}">${thisYear ? "YTD" : year}</span><span class="eh-rec" data-tip="${long}">${short}</span></div>
    ${list.filter((e) => !power(e)).map((e) => row(e)).join("")}${segRows}${list.filter(power).map((e) => row(e)).join("")}</div></div>`;
  function row(e) {
    return `<div class="effort${better(e, e.value, e.record) ? " pb" : ""}" data-effort="${e.k}"><span class="effort-name">${name(e)}</span>
        ${power(e) ? `<b class="span2">${val(e, e.value)}</b>` : `<b>${val(e, e.value)}</b><span class="effort-speed">${speed(e, e.value)}</span>`}${cell(e, e.year, yearTip, e.yearDate, e.yearId, e.yearPrev)}${cell(e, e.record, long, e.recordDate, e.recordId, e.recordPrev)}</div>`;
  }
}

// Out-and-back sections side by side (lines shifted to their right) or on top of each other.
let ROUTE_OFFSET_PX = 2.2;
function setRouteOffset(on) {
  ROUTE_OFFSET_PX = on ? 2.2 : 0;
  const map = activeMap;
  if (!map?.getLayer) return;
  ["route", "route-color", "effort-hl", "effort-hl-casing"].forEach((id) => { if (map.getLayer(id)) map.setPaintProperty(id, "line-offset", ROUTE_OFFSET_PX); });
}

// Weather widget: sky icon and temperature, wind arrow (pointing where the wind blows) with
// speed and direction, rain when there was some. Model data for the hour and the area.
const WMO = [[0, "Clear", "sun"], [2, "Partly cloudy", "partly"], [3, "Overcast", "cloud"], [48, "Fog", "fog"],
  [57, "Drizzle", "rain"], [67, "Rain", "rain"], [77, "Snow", "snow"], [82, "Showers", "rain"], [86, "Snow showers", "snow"], [99, "Thunderstorm", "storm"]];
const SKY_SVG = {
  sun: `<circle cx="12" cy="12" r="4.2" fill="#f5b400"/><g stroke="#f5b400" stroke-width="1.8" stroke-linecap="round"><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></g>`,
  partly: `<circle cx="9" cy="9" r="3.6" fill="#f5b400"/><path d="M7.5 19h9.3a3.6 3.6 0 0 0 .3-7.2 5 5 0 0 0-9.6 1.4A2.9 2.9 0 0 0 7.5 19z" fill="#e8ecf2" stroke="#9aa3b2" stroke-width="1.3"/>`,
  cloud: `<path d="M6.5 18.5h10.8a4 4 0 0 0 .3-8 5.6 5.6 0 0 0-10.8 1.6 3.2 3.2 0 0 0-.3 6.4z" fill="#dfe4ea" stroke="#8b94a3" stroke-width="1.3"/>`,
  fog: `<path d="M5 9h14M3.5 12.5h17M5 16h14M7 19.5h10" stroke="#9aa3b2" stroke-width="1.8" stroke-linecap="round"/>`,
  rain: `<path d="M6.5 14.5h10.8a4 4 0 0 0 .3-8 5.6 5.6 0 0 0-10.8 1.6 3.2 3.2 0 0 0-.3 6.4z" fill="#dfe4ea" stroke="#8b94a3" stroke-width="1.3"/><path d="M8.5 17l-1 3M12.5 17l-1 3M16.5 17l-1 3" stroke="#3b82f6" stroke-width="1.7" stroke-linecap="round"/>`,
  snow: `<path d="M6.5 14.5h10.8a4 4 0 0 0 .3-8 5.6 5.6 0 0 0-10.8 1.6 3.2 3.2 0 0 0-.3 6.4z" fill="#eef1f5" stroke="#8b94a3" stroke-width="1.3"/><g fill="#7aa7e8"><circle cx="8.5" cy="18.5" r="1.2"/><circle cx="12.5" cy="19.5" r="1.2"/><circle cx="16.5" cy="18.5" r="1.2"/></g>`,
  storm: `<path d="M6.5 14.5h10.8a4 4 0 0 0 .3-8 5.6 5.6 0 0 0-10.8 1.6 3.2 3.2 0 0 0-.3 6.4z" fill="#cfd5de" stroke="#6b7280" stroke-width="1.3"/><path d="M12.5 15l-2 3.5h2.5l-1.5 3.5" stroke="#f5b400" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
};
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
function weatherHtml(w) {
  const sky = WMO.find(([max]) => (w.code ?? 0) <= max) || WMO[WMO.length - 1];
  const temp = w.temp_min !== w.temp_max ? `${num(w.temp_min)}–${num(w.temp_max)} °C` : `${num(w.temp)} °C`;
  const from = w.wind_dir != null ? COMPASS[Math.round(w.wind_dir / 45) % 8] : "";
  // the arrow points where the wind blows (it comes from wind_dir)
  return `<div class="wx" data-tip="Weather from Open-Meteo: ${sky[1].toLowerCase()}, wind from the ${from}${w.precip ? `, ${num(w.precip, 1)} mm of rain` : ""}; model data for the hour and the area (~10 km).">
    <svg class="wx-sky" viewBox="0 0 24 24" fill="none" aria-label="${sky[1]}">${SKY_SVG[sky[2]]}</svg>
    <span>${temp}${w.precip ? ` · ${num(w.precip, 1)} mm` : ""}</span>
    ${w.wind_speed != null ? `<span class="wx-wind"><svg viewBox="0 0 24 24" style="transform:rotate(${(w.wind_dir ?? 0) + 180}deg)"><path d="M12 3v16M12 3l-4.5 5M12 3l4.5 5" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>${num(w.wind_speed)} km/h</span>` : ""}
  </div>`;
}

// A stretch of the route (samples i0..i1) drawn bold over the route; null clears it.
function routeHighlight(route, range) {
  const map = activeMap;
  // route.ready: the map has loaded (isStyleLoaded() stays false while tiles load)
  if (!map?.getSource || !route.ready || (!range && !map.getSource("effort-hl"))) return;
  // range: [[i0, i1], …] (several stretches, e.g. all gravel) or null
  const all = range ? routePoints(route.st, null) : [];
  const lines = (range || []).map(([a, b]) => all.filter((p) => p.i >= a && p.i <= b).map((p) => p.p)).filter((l) => l.length > 1);
  const data = { type: "FeatureCollection", features: lines.length ? [{ type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: lines } }] : [] };
  if (map.getSource("effort-hl")) { map.getSource("effort-hl").setData(data); return; }
  map.addSource("effort-hl", { type: "geojson", data });
  map.addLayer({ id: "effort-hl-casing", type: "line", source: "effort-hl", layout: { "line-join": "round", "line-cap": "round" },
                 paint: { "line-color": mapHalo(), "line-width": 9, "line-offset": ROUTE_OFFSET_PX } }, "ends");
  map.addLayer({ id: "effort-hl", type: "line", source: "effort-hl", layout: { "line-join": "round", "line-cap": "round" },
                 paint: { "line-color": "#f59e0b", "line-width": 5.5, "line-offset": ROUTE_OFFSET_PX } }, "ends");
}

// Chart ↔ map: a dot on the route at the hovered sample; hovering the route moves the charts.
function routeHover(route, i) {
  const map = activeMap, src = map?.getSource("hover-pt");
  if (!src) return;
  const lat = route.st.lat?.[i], lon = route.st.lon?.[i];
  src.setData({ type: "FeatureCollection", features: i == null || lat == null || lon == null ? []
    : [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [lon, lat] } }] });
}
function bindRouteHover(route) {
  const map = activeMap;
  map.addSource("hover-pt", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "hover-pt", type: "circle", source: "hover-pt",
                 paint: { "circle-radius": 6, "circle-color": cssVar("--fg") || "#1b1e25", "circle-stroke-width": 2.5, "circle-stroke-color": mapHalo() } });
  const pts = routePoints(route.st, null);
  map.on("mousemove", (e) => {
    if (!route.charts || !pts.length) return;
    let best = null, bd = 400; // within 20 px
    for (const x of pts) {
      const p = map.project(x.p), d = (p.x - e.point.x) ** 2 + (p.y - e.point.y) ** 2;
      if (d < bd) { bd = d; best = x.i; }
    }
    route.charts.hover(best);
    if (best == null) routeHover(route, null);
  });
  map.getCanvas().addEventListener("mouseleave", () => { route.charts?.hover(null); routeHover(route, null); });
}

// ---- Activity route: colour by a stream, kilometre markers, legend --------------------

// Colour scales (low → high). HR: green to red like HR zones; power in the power zone colours
// (grey, blue, green, yellow, red, violet, black).
const ROUTE_SCALES = {
  speed: { label: "Speed", unit: "km/h", f: (v) => v * 3.6, dec: 1, stops: ["#1e3a8a", "#2563eb", "#22d3ee", "#a3e635", "#facc15"] },
  hr: { label: "Heart rate", unit: "bpm", f: (v) => v, dec: 0, stops: ["#2b9348", "#a7c957", "#f9c74f", "#f3722c", "#d00000"] },
  power: { label: "Power", unit: "W", f: (v) => v, dec: 0, stops: ["#a3a9b3", "#4a90e2", "#43a047", "#f2c200", "#e53935", "#8e44ad", "#1f2126"] },
  cadence: { label: "Cadence", unit: "", f: (v) => v, dec: 0, stops: ["#a3e635", "#2dd4bf", "#0d9488", "#0e7490", "#1e3a8a"] },
  // Altitude like a relief map: lowland green, hills yellow, mountains brown.
  altitude: { label: "Altitude", unit: "m", f: (v) => v, dec: 0, any: true, stops: ["#1a9850", "#91cf60", "#fee08b", "#d8a35d", "#8c510a"] },
};
// Laps: every 5 km for bikes and long activities, otherwise every km.
const lapKmStep = (a) => (a.category === "ride" || (a.distance_m || 0) >= 40000 ? 5 : 1);
// Route markers, any sport: every 25 km from 125 km, every 10 km from 50 km, else as the laps.
// The choices: 1, 5, 10 and 25 km (rides from 5 km) while they give at least two markers.
const routeKmStep = (a) => { const d = a.distance_m || 0; return d >= 125000 ? 25 : d >= 50000 ? 10 : lapKmStep(a); };
const routeKmSteps = (a) => {
  const def = routeKmStep(a), d = a.distance_m || 0;
  return [1, 5, 10, 25].filter((k) => k === def || (!(a.category === "ride" && k === 1) && k * 2000 <= d));
};
const ROUTE_ICON = { speed: "speed", hr: "avg_heart_rate", power: "power", cadence: "cadence", altitude: "altitude", surface: "route", intervals: "interval_time" };
// Easy's time above the tempo line on the heart rate chart: a colour that stands out on the red line.
const EASY_OVER_COLOR = "#b42318";
// Climb categories (docs/MANUAL.md › Climbs): the cycling scale - length × grade, which is the
// gain × 100 - at least 3 % over 500 m, for every sport; on foot also "Hill" below Cat 4.
const CLIMB_CATS = [["HC", 800, "#7b2d8e"], ["Cat 1", 640, "#c2252d"], ["Cat 2", 320, "#e4572e"], ["Cat 3", 160, "#ee8a1f"], ["Cat 4", 80, "#c79a00"]];
const CLIMB_HILL = { gain: 30, grade: 0.05, len: 200, color: "#4f9d56" };
function climbCategory(gain, lenM, foot) {
  const grade = lenM > 0 ? gain / lenM : 0;
  const c = grade >= 0.03 && lenM >= 500 ? CLIMB_CATS.find(([, lo]) => gain >= lo) : null;
  if (c) return { name: c[0], color: c[2] };
  return foot && gain >= CLIMB_HILL.gain && grade >= CLIMB_HILL.grade && lenM >= CLIMB_HILL.len ? { name: "Hill", color: CLIMB_HILL.color } : null;
}
// Intervals on the map: work bouts and recoveries (warm-up and cool-down are recoveries too).
const INTERVAL_MAP_COLOR = { work: "#f2552c", rest: "#9aa3b2" };
// Surface on the map: one colour per kind (the base colours of the chart hatching). On the dark
// map the same kinds lighter, so a grey paved road does not sink into the grey streets.
const SURFACE_MAP_LIGHT = { paved: "#5b6472", gravel: "#d39a2f", dirt: "#8b5a2b", unknown: "#b8bec7" };
const SURFACE_MAP_DARK = { paved: "#c9d0db", gravel: "#f0b041", dirt: "#d08850", unknown: "#7a8291" };
const surfaceMapColor = (k) => (document.documentElement.dataset.theme === "dark" ? SURFACE_MAP_DARK : SURFACE_MAP_LIGHT)[k];
// Outline of lines, dots and markers on maps: white on light maps, near black on dark ones.
const mapHalo = () => cssVar("--map-halo") || "#fff";
const routeModeIcon = (k) => (ROUTE_ICON[k] ? metricIcon(ROUTE_ICON[k], 16) : "");
const routeModeLabel = (k) => (k === "plain" ? "None" : `<span class="badge-metric">${routeModeIcon(k)}${k === "surface" ? "Surface" : k === "intervals" ? "Intervals" : ROUTE_SCALES[k].label}</span>`);

// ---- Laps: grouped by n, header icons, columns without data hidden --------------------
const lapsLabel = (n) => (n === "device" ? "Device laps" : `Every ${n} km`);
// Laps of 1 km to group by n km: the device auto-laps when they are 1 km long, else cut from
// the streams (distance, time, heart rate, power, cadence). Device laps that are something else
// (manual laps, workout steps) stay available as their own choice.
function lapSource(a, chartX, st) {
  const L = a.laps || [];
  const autoKm = L.length > 1 && L.slice(0, -1).every((l) => Math.abs((l.distance_m || 0) - 1000) <= 25);
  const km1 = autoKm ? L : streamKmLaps(chartX, st);
  const device = !autoKm && L.length > 1 ? L : null;
  const options = [...(km1.length ? [1, 2, 5, 10] : []), ...(device ? ["device"] : [])];
  return { km1, device, options };
}
function streamKmLaps(chartX, st) {
  const d = chartX?.distance, t = chartX?.time, mv = chartX?.timer;
  if (!d || d[d.length - 1] < 1) return [];
  const out = [];
  let i0 = 0;
  for (let k = 1, i = 1; i < d.length; i++) {
    const last = i === d.length - 1;
    if (d[i] < k && !last) continue;
    const acc = { hr: [0, 0], power: [0, 0], cadence: [0, 0] };
    let maxHr = null;
    for (let j = i0 + 1; j <= i; j++) {
      const dt = Math.min(30, t[j] - t[j - 1]);
      for (const ch of ["hr", "power", "cadence"]) {
        const v = st[ch]?.[j];
        if (v != null && (ch === "power" || v > 0)) { acc[ch][0] += v * dt; acc[ch][1] += dt; }
      }
      if (st.hr?.[j] != null) maxHr = Math.max(maxHr ?? 0, st.hr[j]);
    }
    const avg = (ch) => (acc[ch][1] ? acc[ch][0] / acc[ch][1] : null);
    const dist = (d[i] - d[i0]) * 1000;
    if (dist >= 50 || !last) out.push({ idx: out.length, distance_m: dist, timer_s: (mv || t)[i] - (mv || t)[i0],
      avg_hr: avg("hr"), max_hr: maxHr, avg_power: avg("power"), avg_cadence: avg("cadence"), intensity: null });
    i0 = i;
    k = Math.floor(d[i]) + 1;
  }
  return out;
}
function lapGroups(laps, n, byKm) {
  const out = [];
  let total = 0;
  for (let i = 0; i < laps.length; i += n) {
    const g = laps.slice(i, i + n);
    const t = g.reduce((s, l) => s + (l.timer_s || 0), 0), d = g.reduce((s, l) => s + (l.distance_m || 0), 0);
    total += d;
    const avg = (k) => { // time-weighted
      let sum = 0, w = 0;
      for (const l of g) if (l[k] != null && l.timer_s) { sum += l[k] * l.timer_s; w += l.timer_s; }
      return w ? sum / w : null;
    };
    out.push({
      label: byKm ? num(total / 1000, Math.abs(total / 1000 - Math.round(total / 1000)) < 0.05 ? 0 : 1)
        : g.length > 1 ? `${g[0].idx + 1}–${g[g.length - 1].idx + 1}` : String(g[0].idx + 1),
      distance_m: d, timer_s: t, avg_speed: t ? d / t : null,
      avg_hr: avg("avg_hr"), max_hr: g.some((l) => l.max_hr != null) ? Math.max(...g.map((l) => l.max_hr ?? 0)) : null, avg_power: avg("avg_power"), avg_cadence: avg("avg_cadence"),
      intensity: [...new Set(g.map((l) => l.intensity).filter(Boolean))].join(", "),
    });
  }
  return out;
}
const thIcon = (icon, label, num = true) => `<th class="${num ? "num" : ""}"><span class="th-icon">${icon ? metricIcon(icon) : ""}${label}</span></th>`;
function lapsTable(a, src, n) {
  const device = n === "device";
  const rows = lapGroups(device ? src.device : src.km1, device ? 1 : n, !device);
  const ride = !["run", "walk", "hike"].includes(a.category);
  const has = (k) => rows.some((r) => r[k] != null && r[k] !== 0);
  // Intensity only when it changes (a workout that never left its warm-up step marks all laps "warmup").
  const showInt = device && new Set(src.device.map((l) => l.intensity)).size > 1;
  const cols = [
    ["", device ? "#" : "km", false, (r) => r.label],
    ["distance_total", "Distance", true, (r) => km(r.distance_m)],
    ["timer_time", "Time", true, (r) => dur(r.timer_s)],
    has("distance_m") && (ride ? ["speed", "Speed", true, (r) => (r.distance_m && r.avg_speed ? `${num(r.avg_speed * 3.6, 1)} km/h` : "–")]
      : ["avg_pace", "Pace", true, (r) => (r.distance_m ? pace(r.avg_speed) : "–")]),
    has("avg_hr") && ["avg_heart_rate", "Avg HR", true, (r) => bpm(r.avg_hr)],
    has("max_hr") && ["max_heart_rate", "Max HR", true, (r) => bpm(r.max_hr)],
    has("avg_power") && ["avg_power", "Avg power", true, (r) => watts(r.avg_power)],
    has("avg_cadence") && ["avg_cadence", "Cadence", true, (r) => cadence(r.avg_cadence, a.category)],
    showInt && ["intensity_factor", "Intensity", false, (r) => esc(r.intensity)],
  ].filter(Boolean);
  return `<div class="scroll"><table class="data" data-spread><thead><tr>${cols.map(([i, l, nm]) => thIcon(i, l, nm)).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${cols.map(([, , nm, f]) => `<td class="${nm ? "num" : ""}">${f(r)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function rampColor(stops, t) {
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const [p, q] = [hexRgb(stops[i]), hexRgb(stops[i + 1])];
  return `rgb(${p.map((v, k) => Math.round(v + (q[k] - v) * f)).join(",")})`;
}
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
function haversineLonLat(p, q) {
  const r = Math.PI / 180, dLat = (q[1] - p[1]) * r, dLon = (q[0] - p[0]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p[1] * r) * Math.cos(q[1] * r) * Math.sin(dLon / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
}

// Stream points that have a position: [lon, lat], distance from the start and the value.
function routePoints(st, key) {
  const pts = [];
  let d = 0, prev = null;
  for (let i = 0; i < (st.lat || []).length; i++) {
    const lat = st.lat[i], lon = st.lon?.[i];
    if (lat == null || lon == null) continue;
    const p = [lon, lat];
    d = st.distance?.[i] != null ? st.distance[i] : d + (prev ? haversineLonLat(prev, p) : 0);
    pts.push({ p, d, i, v: key ? st[key]?.[i] : null });
    prev = p;
  }
  return pts;
}

function drawActivityRoute(route) {
  const map = activeMap;
  if (!map) return;
  if (!route.ready) return; // drawn as soon as the map is ready
  const legend = document.getElementById("route-legend");
  const scale = ROUTE_SCALES[route.mode];
  const pts = routePoints(route.st, scale ? route.mode : null);
  // Coloured route: one short line per pair of points, coloured by the value (5–95 % range).
  const features = [];
  if (route.mode === "surface" && route.surface && pts.length > 1) {
    // Road surface (OpenStreetMap): one colour per kind, legend with the kinds present.
    const runs = route.surface.runs;
    let r = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = pts[i].d;
      while (r < runs.length - 1 && d > runs[r][1]) r++;
      features.push({ type: "Feature", properties: { c: surfaceMapColor(runs[r]?.[2]) || surfaceMapColor("unknown") },
                      geometry: { type: "LineString", coordinates: [pts[i - 1].p, pts[i].p] } });
    }
    const kinds = SURFACE_KINDS.filter((k) => route.surface.shares?.[k]);
    legend.innerHTML = `<span class="route-legend-title">Surface</span><div class="route-legend-kinds">${kinds.map((k) =>
      `<span><i style="background:${surfaceMapColor(k)}"></i>${SURFACE_LABEL[k]}</span>`).join("")}</div>`;
  }
  else if (route.mode === "intervals" && route.sections && pts.length > 1) {
    // Sections between the chart lines: work where the section is faster (or harder) than
    // halfway between the slowest and the fastest section, else recovery.
    const sig = route.st.speed?.some((v) => v) ? route.st.speed : route.st.power || route.st.hr || [];
    const n = Math.max(sig.length, 1), bd = [0, ...route.sections.at, n - 1];
    const means = bd.slice(1).map((i1, k) => {
      const v = sig.slice(bd[k], i1 + 1).filter((x) => x != null);
      return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null;
    });
    const known = means.filter((m) => m != null), mid = (Math.min(...known) + Math.max(...known)) / 2;
    const work = means.map((m) => m != null && known.length > 1 && m >= mid);
    let k = 0;
    for (let i = 1; i < pts.length; i++) {
      while (k < bd.length - 2 && pts[i].i > bd[k + 1]) k++;
      features.push({ type: "Feature", properties: { c: INTERVAL_MAP_COLOR[work[k] ? "work" : "rest"] },
                      geometry: { type: "LineString", coordinates: [pts[i - 1].p, pts[i].p] } });
    }
    legend.innerHTML = `<span class="route-legend-title">Intervals</span><div class="route-legend-kinds">
      <span><i style="background:${INTERVAL_MAP_COLOR.work}"></i>Work</span><span><i style="background:${INTERVAL_MAP_COLOR.rest}"></i>Recovery</span></div>`;
  }
  else if (scale && pts.length > 1) {
    const vals = pts.map((x) => x.v).filter((v) => v != null && (scale.any || v > 0)).sort((x, y) => x - y);
    const lo = quantile(vals, 0.05), hi = quantile(vals, 0.95);
    for (let i = 1; i < pts.length; i++) {
      const v = pts[i].v ?? pts[i - 1].v;
      const t = v == null || hi === lo ? 0.5 : (v - lo) / (hi - lo);
      features.push({ type: "Feature", properties: { c: rampColor(scale.stops, t) },
                      geometry: { type: "LineString", coordinates: [pts[i - 1].p, pts[i].p] } });
    }
    const fmt = (v) => num(scale.f(v), scale.dec);
    legend.innerHTML = `<span class="route-legend-title">${scale.label}${scale.unit ? ` · ${scale.unit}` : ""}</span>
      <div class="route-ramp" style="background:linear-gradient(90deg,${scale.stops.join(",")})"></div>
      <div class="route-ramp-labels"><span>${fmt(lo)}</span><span>${fmt(hi)}</span></div>`;
  }
  legend.hidden = !features.length;
  map.setLayoutProperty("route", "visibility", features.length ? "none" : "visible");
  const data = { type: "FeatureCollection", features };
  if (map.getSource("route-color")) { // quick fade out → new colours → fade in
    map.setPaintProperty("route-color", "line-opacity", 0);
    setTimeout(() => { map.getSource("route-color")?.setData(data); map.setPaintProperty("route-color", "line-opacity", 1); }, 180);
  }
  else {
    map.addSource("route-color", { type: "geojson", data });
    map.addLayer({ id: "route-color", type: "line", source: "route-color", layout: { "line-join": "round", "line-cap": "round" },
                   paint: { "line-color": ["get", "c"], "line-width": 3.5, "line-offset": ROUTE_OFFSET_PX,
                            "line-opacity": 1, "line-opacity-transition": { duration: 180 } } }, "ends");
  }
  // Kilometre markers: a numbered dot every route.km km (0: none).
  (route.markers || []).forEach((m) => m.remove());
  route.markers = [];
  if (route.km) {
    const step = route.km * 1000;
    let next = step;
    for (const x of pts) {
      if (x.d < next) continue;
      const el = document.createElement("div");
      el.className = "km-marker";
      el.textContent = Math.round(next / 1000);
      route.markers.push(new maplibregl.Marker({ element: el }).setLngLat(x.p).addTo(map));
      next += step;
    }
  }
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
const EXTRA_MAPS = []; // further maps on the page (createMap `extra`), removed with the main one
function disposeMap() {
  if (activeMap) { activeMap.remove(); activeMap = null; }
  EXTRA_MAPS.splice(0).forEach((m) => m.remove());
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
const TILE_SIZES = [[13, "Squares"], [14, "Explorer tiles"]];

function defaultMapSettings() {
  return {
    layer: "heatmap",
    kpis: false,
    // until the person picks: Humanitarian with relief; colours chosen for each theme apart
    map: { source: "hot", toneLight: "muted", toneDark: "dusk", relief: "on", trails: "none" },
    heatmap: { style: "density", color: "#e8590c", ramp: "fire", width: 2, intensity: 0.45, perPerson: true },
    tiles: { zoom: 14, style: "coverage", color: "#0f766e", ramp: "viridis", display: "grid",
             square: true, cluster: true, routes: true, regions: [] },
  };
}

function loadMapSettings() {
  const d = defaultMapSettings();
  let s = null;
  s = UI.data["map-settings"] || null;
  if (!s) try { s = JSON.parse(store.get("map-settings-v3") || "null"); } catch (e) { s = null; }
  const tab = { layer: TAB.layer || "heatmap", kpis: TAB.kpis ?? false }; // not saved: fixed per visit
  if (!s) return { ...d, ...tab };
  const tiles = { ...d.tiles, ...s.tiles };
  if (!TILE_SIZES.some(([z]) => z === tiles.zoom)) tiles.zoom = d.tiles.zoom; // a size no longer offered
  const map = { ...d.map, ...s.map };
  if ("tone" in map) { // one choice for both themes (before): kept for the theme it suits
    if (BASE_TONES.some(([k]) => k === map.tone) && !(s.map || {})[DARK_TONES.has(map.tone) ? "toneDark" : "toneLight"]) {
      map[DARK_TONES.has(map.tone) ? "toneDark" : "toneLight"] = map.tone;
    }
    delete map.tone;
  }
  return { ...d, ...s, ...tab, map, heatmap: { ...d.heatmap, ...s.heatmap }, tiles };
}

function saveMapSettings(s) {
  TAB.layer = s.layer; TAB.kpis = s.kpis;
  const { layer, kpis, ...keep } = s;
  saveUi("map-settings", keep);
}

const DARK_TONES = new Set(["soft-dark", "slate", "dusk", "dark"]);
const TONE_PROPS = ["raster-saturation", "raster-brightness-min", "raster-brightness-max", "raster-contrast", "raster-hue-rotate"];
const TONE_DEFAULTS = { "raster-saturation": 0, "raster-brightness-min": 0, "raster-brightness-max": 1, "raster-contrast": 0, "raster-hue-rotate": 0 };
const toneOf = (key) => (BASE_TONES.find(([k]) => k === key) || BASE_TONES[0])[2];
// Map tab colours: chosen for the light and the dark theme apart (defaults muted / dusk); a
// `tone` given outright (route maps) wins. A base map no longer offered: the default.
const MAP_TONE = { light: "muted", dark: "dusk" };
const themeKey = () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
const toneKey = () => (themeKey() === "dark" ? "toneDark" : "toneLight");
const validTone = (k) => BASE_TONES.some(([t]) => t === k);
const mapTone = (M) => (validTone(M.tone) ? M.tone : validTone(M[toneKey()]) ? M[toneKey()] : MAP_TONE[themeKey()]);
const baseSource = (key) => (key === "none" ? null : (BASEMAPS || []).find((b) => b.key === key) || (BASEMAPS || []).find((b) => b.key === "hot") || null);
// Route maps (activity, segment, segment creator) have fixed colours per theme: Faded light in
// light, Soft dark in dark. The colours chosen in Map › Options belong to the Map tab only.
const ROUTE_TONE = { light: "faded", dark: "soft-dark" };
const routeTone = () => ROUTE_TONE[document.documentElement.dataset.theme === "dark" ? "dark" : "light"];

function baseStyle(mapSettings) {
  const src = baseSource(mapSettings.source);
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--surface-2").trim() || "#1e222b";
  const style = { version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": bg } }] };
  if (src) {
    const tiles = new URL(`api/basemap/${src.key}/`, document.baseURI).href + "{z}/{x}/{y}.png";
    style.sources.base = { type: "raster", tiles: [tiles], tileSize: 256, maxzoom: src.max_zoom, attribution: src.attribution };
    style.layers.push({ id: "base", type: "raster", source: "base", paint: toneOf(mapTone(mapSettings)) });
  }
  if (mapSettings.relief === "on") { // hills shaded over the base map (under the routes)
    const dem = new URL("api/basemap/terrain/", document.baseURI).href + "{z}/{x}/{y}.png";
    style.sources.dem = { type: "raster-dem", tiles: [dem], tileSize: 256, maxzoom: RELIEF_MAX_Z, encoding: "terrarium", attribution: RELIEF_ATTRIBUTION };
    style.layers.push({ id: "relief", type: "hillshade", source: "dem", paint: { "hillshade-exaggeration": 0.45, "hillshade-illumination-direction": 315,
      "hillshade-shadow-color": "rgba(0,0,0,0.55)", "hillshade-highlight-color": "rgba(255,255,255,0.35)", "hillshade-accent-color": "rgba(0,0,0,0.25)" } });
  }
  if (TRAILS.some(([k]) => k === mapSettings.trails && k !== "none")) { // marked routes, transparent
    const t = new URL(`api/basemap/trails-${mapSettings.trails}/`, document.baseURI).href + "{z}/{x}/{y}.png";
    style.sources.trails = { type: "raster", tiles: [t], tileSize: 256, maxzoom: 18, attribution: TRAILS_ATTRIBUTION };
    style.layers.push({ id: "trails", type: "raster", source: "trails", paint: { "raster-opacity": 0.85 } });
  }
  return style;
}

// Trails: marked routes of Waymarked Trails over the base map (basemap.OVERLAYS `trails-<kind>`).
const TRAILS = [["none", "None"], ["hiking", "Hiking"], ["cycling", "Cycling"], ["mtb", "MTB"]];
const TRAILS_ATTRIBUTION = "Trails © waymarkedtrails.org";

// Relief: elevation tiles (Terrain Tiles, open data; basemap.OVERLAYS) through the server's
// tile cache. Interactive maps shade them themselves (a hillshade layer); the static route
// maps (staticMap) get the shading drawn here on a canvas, one image per tile, kept for the visit.
const RELIEF_MAX_Z = 15;
const RELIEF_ATTRIBUTION = "Relief: Terrain Tiles (Mapzen, AWS Open Data)";
const RELIEF_CACHE = new Map();
function reliefShade(z, x, y) { // a canvas of the shading of elevation tile z/x/y (a promise)
  const key = `${z}/${x}/${y}`;
  if (!RELIEF_CACHE.has(key)) RELIEF_CACHE.set(key, new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = reject;
    img.onload = () => {
      const N = 256, cv = document.createElement("canvas");
      cv.width = cv.height = N;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const src = ctx.getImageData(0, 0, N, N).data, out = ctx.createImageData(N, N), o = out.data;
      const h = new Float32Array(N * N);
      for (let i = 0; i < N * N; i++) h[i] = src[i * 4] * 256 + src[i * 4 + 1] + src[i * 4 + 2] / 256 - 32768;
      // metres per pixel at the tile's middle; the slopes RELIEF_STEEP x steeper, so gentle hills show too
      const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / 2 ** z)));
      const cell = (40075016.7 * Math.cos(lat)) / (N * 2 ** z) / RELIEF_STEEP;
      const zen = Math.PI / 4, az = (135 * Math.PI) / 180, flat = Math.cos(zen); // sun from the north-west, 45° high
      const at = (c, r) => h[Math.min(N - 1, Math.max(0, r)) * N + Math.min(N - 1, Math.max(0, c))];
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        const a = at(c - 1, r - 1), b = at(c, r - 1), cc = at(c + 1, r - 1), d = at(c - 1, r), f = at(c + 1, r);
        const g = at(c - 1, r + 1), hh = at(c, r + 1), i = at(c + 1, r + 1);
        const dx = (cc + 2 * f + i - (a + 2 * d + g)) / (8 * cell), dy = (g + 2 * hh + i - (a + 2 * b + cc)) / (8 * cell);
        const slope = Math.atan(Math.hypot(dx, dy)), aspect = Math.atan2(dy, -dx);
        const v = Math.cos(zen) * Math.cos(slope) + Math.sin(zen) * Math.sin(slope) * Math.cos(az - aspect) - flat;
        const k = (r * N + c) * 4, w = v > 0 ? 255 : 0; // shadows black, lit slopes white
        o[k] = o[k + 1] = o[k + 2] = w;
        o[k + 3] = Math.min(255, Math.abs(v) * (v > 0 ? 160 : 300));
      }
      ctx.putImageData(out, 0, 0);
      resolve(cv);
    };
    img.src = `api/basemap/terrain/${key}.png`;
  }));
  return RELIEF_CACHE.get(key);
}
const RELIEF_STEEP = 3;
// The relief image of map tile z/x/y (above RELIEF_MAX_Z: a part of the bigger tile, enlarged).
const RELIEF_URLS = new Map();
function reliefUrl(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (!RELIEF_URLS.has(key)) RELIEF_URLS.set(key, (async () => {
    const dz = Math.min(z, RELIEF_MAX_Z), n = 2 ** (z - dz), px = Math.floor(x / n), py = Math.floor(y / n);
    let cv = await reliefShade(dz, px, py);
    if (n > 1) {
      const part = document.createElement("canvas"), s = 256 / n;
      part.width = part.height = 256;
      part.getContext("2d").drawImage(cv, (x - px * n) * s, (y - py * n) * s, s, s, 0, 0, 256, 256);
      cv = part;
    }
    return new Promise((resolve) => cv.toBlob((b) => resolve(URL.createObjectURL(b))));
  })());
  return RELIEF_URLS.get(key);
}
// Fill the relief images of the static maps on the page (staticMap leaves them empty).
function fillRelief() {
  document.querySelectorAll("image[data-relief]").forEach((im) => {
    const [z, x, y] = im.dataset.relief.split("/").map(Number);
    im.removeAttribute("data-relief");
    reliefUrl(z, x, y).then((u) => im.setAttribute("href", u), () => im.remove());
  });
}

function boundsOf(coordsList) {
  let w = 180, s = 90, e = -180, n = -90;
  for (const coords of coordsList) for (const [lon, lat] of coords) {
    w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat);
  }
  return w <= e ? [[w, s], [e, n]] : null;
}

// The furthest the start view zooms out: central Europe (about zoom 5
// on a laptop screen, where small countries such as Malta get their labels).
const CONTINENT = [[2, 40], [24, 52]];

async function createMap(container, mapSettings, opts = {}) {
  const ml = await loadMapLibre();
  BASEMAPS ??= await api("basemaps");
  // `extra`: a second map on the page (Activity › New tiles); the main one stays.
  const extra = opts.extra;
  delete opts.extra;
  if (!extra) disposeMap();
  // Start directly at the data (no jump from a world view = no flicker).
  const start = opts.bounds ? { bounds: opts.bounds, fitBoundsOptions: opts.fitBoundsOptions || { padding: 40, maxZoom: 15 } } : { center: [10, 50], zoom: 3 };
  const zoomOffset = opts.zoomOffset || 0, focus = opts.focus, withReset = opts.reset, keepTone = opts.keepTone;
  delete opts.bounds; delete opts.fitBoundsOptions; delete opts.zoomOffset; delete opts.focus; delete opts.reset; delete opts.keepTone;
  // Route maps (activity, segment, segment creator): the fixed tone of the theme (routeTone).
  // The Map tab (keepTone) shows exactly the tone of its options; a Home Assistant card's route
  // map may give its own `tone`.
  const tone = () => (keepTone ? mapTone(mapSettings) : validTone(mapSettings.tone) ? mapSettings.tone : routeTone());
  const map = new ml.Map({ container, style: baseStyle({ ...mapSettings, tone: tone() }), attributionControl: false,
                                       fadeDuration: 0, ...start, ...opts });
  if (extra) EXTRA_MAPS.push(map); else activeMap = map;
  // Light / dark switched while the map is open: the base tone and the outlines follow.
  const watch = new MutationObserver(() => {
    if (activeMap !== map && !EXTRA_MAPS.includes(map)) { watch.disconnect(); return; }
    if (map.getLayer("base")) {
      const paint = toneOf(tone());
      TONE_PROPS.forEach((p) => map.setPaintProperty("base", p, paint[p] ?? TONE_DEFAULTS[p]));
    }
    for (const [id, prop] of [["ends", "circle-stroke-color"], ["hover-pt", "circle-stroke-color"], ["effort-hl-casing", "line-color"],
      ["pair-casing-0", "line-color"], ["pair-casing-1", "line-color"], ["pair-pt-0", "circle-stroke-color"], ["pair-pt-1", "circle-stroke-color"], ["pair-ends", "circle-stroke-color"]]) {
      if (map.getLayer(id)) map.setPaintProperty(id, prop, mapHalo());
    }
  });
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  if (zoomOffset) {
    // Zoom out from the data, but never further than the CONTINENT view on this screen.
    // When even the data does not fit at that level, centre on `focus`.
    const fitZ = map.getZoom();
    const floor = map.cameraForBounds(CONTINENT, { padding: 20 })?.zoom ?? 3;
    const zoom = Math.max(fitZ + zoomOffset, floor);
    map.jumpTo(fitZ < floor && focus ? { zoom, center: focus } : { zoom });
  }
  // bottom corners stack the newer control on top: attribution first, so it sits under +/-
  map.addControl(new ml.AttributionControl({ compact: false }), "bottom-right"); // small, below the buttons
  map.addControl(new ml.NavigationControl({ showCompass: false }), "bottom-right"); // buttons: bottom right
  map.addControl(new ml.ScaleControl({ unit: "metric", maxWidth: 110 }), "bottom-left"); // scale: bottom left
  if (!document.body.classList.contains("fullmap")) map.addControl(new ml.FullscreenControl(), "top-right");
  const reset = withReset ? new MapResetControl() : null;
  if (reset) map.addControl(reset, "top-right");
  await new Promise((resolve) => map.on("load", resolve));
  map.resize();
  reset?.home();
  return map;
}

// Reset view: the refresh pictogram of the charts in a block like Fullscreen (top right),
// shown only after the map was moved, zoomed or rotated; restores the start view.
const REFRESH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 3.5v4.5H15"/></svg>`;
class MapResetControl {
  onAdd(map) {
    this.map = map;
    this.el = Object.assign(document.createElement("div"), { className: "maplibregl-ctrl maplibregl-ctrl-group map-reset", hidden: true });
    this.el.innerHTML = `<button type="button" title="Reset view">${REFRESH_SVG}</button>`;
    this.el.firstChild.onclick = () => map.easeTo({ ...this.start, duration: 450 });
    map.on("moveend", () => this.check());
    return this.el;
  }
  home() { const m = this.map; this.start = { center: m.getCenter(), zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() }; this.check(); }
  check() {
    if (!this.start) return;
    const m = this.map, s = this.start, p = m.project(s.center), c = m.project(m.getCenter());
    this.el.hidden = Math.abs(m.getZoom() - s.zoom) < 0.01 && Math.hypot(p.x - c.x, p.y - c.y) < 2
      && Math.abs(m.getBearing() - s.bearing) < 0.5 && Math.abs(m.getPitch() - s.pitch) < 0.5;
  }
  onRemove() { this.el.remove(); }
}

// Centre of the area with the most activities (10° cells), for a start view that cannot show
// all of them at once.
function busiestArea(tracks) {
  const cells = new Map();
  for (const t of tracks) {
    const p = t.coords?.[0];
    if (!p) continue;
    const k = `${Math.floor(p[0] / 10)},${Math.floor(p[1] / 10)}`;
    const c = cells.get(k) || { n: 0, lon: 0, lat: 0 };
    c.n++; c.lon += p[0]; c.lat += p[1];
    cells.set(k, c);
  }
  const best = [...cells.values()].sort((a, b) => b.n - a.n)[0];
  return best ? [best.lon / best.n, best.lat / best.n] : null;
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

// The position in tile units (not rounded): whole numbers are tile edges.
function tileXY(lat, lon, z) {
  const n = 2 ** z;
  lat = Math.max(Math.min(lat, 85.0511), -85.0511);
  const r = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n];
}
// Every tile a straight segment passes through, in order (a grid walk: crossing an x or a y
// edge, whichever comes first), so a line cutting the corner of a tile counts it too.
function walkTiles([ax, ay], [bx, by], add) {
  let x = Math.floor(ax), y = Math.floor(ay);
  const ex = Math.floor(bx), ey = Math.floor(by), dx = bx - ax, dy = by - ay;
  const sx = Math.sign(dx), sy = Math.sign(dy);
  const tdx = dx ? Math.abs(1 / dx) : Infinity, tdy = dy ? Math.abs(1 / dy) : Infinity;
  let tx = dx > 0 ? (x + 1 - ax) / dx : dx < 0 ? (ax - x) / -dx : Infinity;
  let ty = dy > 0 ? (y + 1 - ay) / dy : dy < 0 ? (ay - y) / -dy : Infinity;
  for (let guard = 0; (x !== ex || y !== ey) && guard < 100000; guard++) {
    if (tx < ty) { x += sx; tx += tdx; } else { y += sy; ty += tdy; }
    add(x, y);
  }
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
      const p = tileXY(lat, lon, z);
      if (prev) walkTiles(prev, p, add); // every tile on the way, corners included
      else add(Math.floor(p[0]), Math.floor(p[1]));
      prev = p;
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

// One level below a tab (an activity, a segment…): a square back button left of the page
// header on wide screens; on narrow ones it folds above the header as a text link.
const backLink = (href, label) => `<a class="back" href="${href}" title="Back to ${esc(label)}" aria-label="Back to ${esc(label)}">
  <span class="back-box">${ICON.back}</span><span class="back-text">← ${esc(label)}</span></a>`;
// Previous / next item (e.g. activity) at the right of the page header, in the style of the
// view switch (Tiles / List). Newer on the left, older on the right, like the newest-first
// list. A missing side is left out.
const prevNextHtml = (prev, next) => (prev || next ? `<div class="switch" role="group">
  ${next ? `<button data-go="${next}" title="Next activity">${ICON.chevLeft}<span>Next</span></button>` : ""}
  ${prev ? `<button data-go="${prev}" title="Previous activity"><span>Previous</span>${ICON.chevRight}</button>` : ""}</div>` : "");

function pageHead(title, badges = "", right = "") {
  return `<div class="page-head"><h2>${title}</h2><div class="badges">${badges}</div><span class="spacer"></span>${right}</div>`;
}
function badgeHtml(id, label, value = "", { panel = "", on = false, wide = false, right = false } = {}) {
  return `<div class="badge-wrap">
    <button class="badge ${on ? "on" : ""}" data-badge="${id}" ${panel ? 'aria-haspopup="true"' : ""}>
      <span class="badge-label">${label}</span>${value ? `<span class="badge-value" data-badge-value="${id}">${value}</span>` : ""}${panel ? ICON.chevron : ""}
    </button>
    ${panel ? `<div class="badge-panel ${wide ? "wide" : ""} ${right ? "right" : ""}" data-panel="${id}" hidden>${panel}</div>` : ""}
  </div>`;
}
function switchHtml(name, options, current) {
  return `<div class="switch" role="group">${options.map(([v, l]) =>
    `<button class="${v === current ? "on" : ""}" data-switch="${name}" data-value="${v}">${l}</button>`).join("")}</div>`;
}
function bindBadges(root) {
  root.querySelectorAll("[data-badge]").forEach((b) => b.addEventListener("click", (e) => {
    const own = `[data-panel="${b.dataset.badge}"]`;
    const panel = b.parentElement.querySelector(own) || root.querySelector(own);
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
// `na`: a reason when the option does not apply to the current choice (shown greyed out).
// An option the current style does not use: its control is greyed out and cannot be changed.
const row = (label, control, na = false) => `<div class="opt-row ${na ? "na" : ""}"><span class="opt-label">${label}</span><div class="opt-control" ${na ? "inert" : ""}>${control}</div></div>`;
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
// All options visible, one chosen (radio-like list); `extra(value)` adds e.g. a gradient bar.
const pickList = (name, options, current, extra = () => "", icon = () => "") => `<div class="pick-list" role="radiogroup">${options.map(([v, l]) =>
  `<button type="button" role="radio" aria-checked="${String(v) === String(current)}" class="pick-item ${String(v) === String(current) ? "on" : ""}" data-pick="${name}" data-value="${esc(v)}"><span class="pick-dot"></span>${icon(v)}<span class="pick-label">${esc(l)}</span>${extra(v)}</button>`).join("")}</div>`;
// Gradients: full-width bars one under another, the chosen one framed (like the colour swatches).
const rampPicker = (name, current) => `<div class="ramp-pick" role="radiogroup">${Object.entries(RAMPS).map(([k, cols]) =>
  `<button type="button" role="radio" aria-checked="${k === current}" aria-label="${esc(RAMP_LABELS[k] || k)}" title="${esc(RAMP_LABELS[k] || k)}" class="ramp-bar ${k === current ? "on" : ""}" data-pick="${name}" data-value="${k}" style="background:linear-gradient(90deg,${cols.join(",")})"></button>`).join("")}</div>`;
const section = (title, body) => `<div class="panel-section"><div class="panel-title">${title}</div>${body}</div>`;

// ---- Heatmap page -------------------------------------------------------------------

let heat = null; // { settings, tracks, years, tileCache, params, isAll, map }

const ICON_HEAT = svg(`<path d="M3 17c3-1 4-6 7-6s3 4 6 4 3-6 5-8"/><path d="M3 21c3-1 4-4 7-4s3 2 6 2 3-3 5-4" opacity=".5"/>`);
const ICON_GRID = svg(`<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7" opacity=".4"/>`);

async function renderHeatmap(params) {
  const isAll = CURRENT === "all";
  const q = {};
  if (!isAll) q.person = CURRENT;
  Object.assign(q, filterQuery(params));
  const [data] = await Promise.all([api("heatmap/tracks?" + new URLSearchParams(q)), (async () => { BASEMAPS ??= await api("basemaps"); })()]);
  const tracks = data.items.map((t) => ({ ...t, coords: lonLat(t.polyline) }));
  heat = { settings: loadMapSettings(), tracks, years: data.years, tileCache: new Map(), params, isAll, map: null };
  const s = heat.settings;

  view.innerHTML = `<div class="heat-wrap">
      <div id="map" class="heat-map"></div>
      <div class="heat-overlay"><div class="heat-column">
        <div class="float-bar">${pageHead("Map", `
          ${timeBadge(params)}${typeBadge(params)}
          ${badgeHtml("settings", "Options", "", { panel: "<div data-settings></div>" })}
          <button class="badge ${s.kpis ? "on" : ""}" data-kpis>Summary</button>`,
          switchHtml("layer", [["heatmap", `${ICON_HEAT}<span>Heatmap</span>`], ["tiles", `${ICON_GRID}<span>Explorer tiles</span>`]], s.layer))}</div>
        <div id="heat-kpis" ${s.kpis ? "" : "hidden"}></div>
      </div></div>
    </div>`;
  document.body.classList.add("fullmap"); // now, before the map measures its box (the observer agrees)
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
    if (s.kpis) window.scrollTo({ top: 0, behavior: "smooth" });
  };
  bindFilterBadges(head, "#/heatmap", params);
  // Options always open on the first section.
  head.querySelector("[data-badge=settings]")?.addEventListener("click", () => {
    if (!head.querySelector('[data-panel="settings"]').hidden) { heat.openAcc = "map"; renderSettingsPanel(); }
  });

  const bounds = boundsOf(tracks.map((t) => t.coords));
  const map = await createMap("map", s.map, { keepTone: true, ...(bounds ? { bounds, fitBoundsOptions: { padding: { top: 150, left: 40, right: 40, bottom: 40 }, maxZoom: 15 }, zoomOffset: -4, focus: busiestArea(tracks) } : {}) });
  heat.map = map;
  drawHeatLayers();
  map.on("click", "routes", (e) => {
    const items = [...new Map(e.features.map((f) => [f.properties.id, f.properties])).values()].slice(0, 6);
    // one flat row per activity: its type icon, type and day (and who, for everyone)
    new maplibregl.Popup({ closeButton: false, maxWidth: "300px", className: "route-pop" }).setLngLat(e.lngLat)
      .setHTML(items.map((p) => `<a class="route-pop-row" href="#/activity/${p.id}">${typeIcon(p.at, 16)}<span>${esc(p.type)}</span><span class="hint">${esc(p.day)}${isAll ? ` · ${esc(p.person)}` : ""}</span></a>`).join(""))
      .addTo(map);
  });
  map.on("mouseenter", "routes", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "routes", () => { map.getCanvas().style.cursor = ""; });
  map.on("moveend", () => {
    const sel = view.querySelector('select[name="tiles.zoom"]');
    if (sel) [...sel.options].forEach((o) => { const z = Number(o.value); o.textContent = `${TILE_SIZES.find(([k]) => k === z)[1]} · ${num(tileWidthKm(z, map.getCenter().lat), 1)} km`; });
  });
}

// The tone the options panel shows: of the page's theme, or of the theme a card creator previews.
function heatTone(M) {
  if (!heat.theme) return mapTone(M);
  const k = M[heat.theme === "dark" ? "toneDark" : "toneLight"];
  return validTone(k) ? k : MAP_TONE[heat.theme];
}

function renderSettingsPanel() {
  const s = heat.settings, M = s.map, H = s.heatmap, T = s.tiles;
  const lat = heat.map ? heat.map.getCenter().lat : 52;
  const srcLabel = baseSource(M.source)?.label.split(" (")[0] || "None";
  const panelTone = heatTone(M), toneLabel = BASE_TONES.find(([k]) => k === panelTone)[1];
  const sizeLabel = (TILE_SIZES.find(([z]) => z === T.zoom) || TILE_SIZES[1])[1];
  const styleLabel = { density: "Density", coverage: "Coverage", glow: "Heat glow" }[H.style];
  const glow = H.style === "glow", byVisits = T.style === "heat";
  const mapBody = row("Base map", pickList("map.source", [...(BASEMAPS || []).map((b) => [b.key, b.label]), ["none", "None"]], M.source === "none" ? "none" : baseSource(M.source)?.key))
    + row(`Colours<small class="opt-hint">For the ${heat.theme || themeKey()} theme.</small>`, pickList("map.tone", BASE_TONES.map(([k, l]) => [k, l]), panelTone))
    + row("Relief", pickList("map.relief", [["off", "Off"], ["on", "On — hills shaded"]], M.relief))
    + row("Trails", pickList("map.trails", TRAILS, M.trails || "none"));
  const heatBody = row("Style", pickList("heatmap.style", [["density", "Density — overlaps get stronger"], ["coverage", "Coverage — solid lines"], ["glow", "Heat glow — colour gradient"]], H.style))
    + row("Line colour", colorPicker("heatmap.color", H.color), glow)
    + (heat.isAll ? row("People", checkCtl("heatmap.perPerson", H.perPerson, "A colour per person"), glow ? "Not used by Heat glow" : "") : "")
    + row("Gradient", rampPicker("heatmap.ramp", H.ramp), !glow)
    + row("Line width", `<input type="range" min="1" max="6" step="0.5" value="${H.width}" name="heatmap.width">`)
    + row("Overlap", `<input type="range" min="0.1" max="0.9" step="0.05" value="${H.intensity}" name="heatmap.intensity">`);
  const tilesBody = row("Tile size", pickList("tiles.zoom", TILE_SIZES.map(([z, l]) => [z, `${l} · ${num(tileWidthKm(z, lat), 1)} km`]), T.zoom))
    + row("Style", pickList("tiles.style", [["coverage", "Coverage"], ["heat", "By number of visits"]], T.style))
    + row("Tile colour", colorPicker("tiles.color", T.color), byVisits)
    + row("Gradient", rampPicker("tiles.ramp", T.ramp), !byVisits)
    + row("Display", pickList("tiles.display", [["grid", "Single tiles"], ["area", "One area"]], T.display))
    + row("Highlights", `<div class="checks">${checkCtl("tiles.square", T.square, "Max square", "Largest square made only of visited tiles")}
        ${checkCtl("tiles.cluster", T.cluster, "Cluster", "Largest connected group of tiles with visited tiles on all four sides")}
        ${checkCtl("tiles.routes", T.routes, "Routes")}</div>`)
    + (heat.card ? "" : regionPickerHtml(T.regions));
  heat.openAcc ??= "map";
  const el = heat.panelEl || view.querySelector("[data-settings]");
  el.innerHTML = accordion([
    ["map", "Map", `${srcLabel} · ${toneLabel}${M.relief === "on" ? " · Relief" : ""}${M.trails && M.trails !== "none" ? " · Trails" : ""}`, mapBody],
    ["heatmap", "Heatmap", styleLabel, heatBody],
    ["tiles", "Explorer tiles", sizeLabel, tilesBody],
  ], heat.openAcc);
  bindAccordion(el, (key) => { heat.openAcc = key; });
  bindSettingsPanel(el);
  bindRegionPicker(el, () => heat.settings.tiles.regions || [], (ids) => {
    heat.settings.tiles.regions = ids; (heat.save || saveMapSettings)(heat.settings); renderHeatKpis();
  });
}

// Apply one setting with the cheapest possible map update. Settings of the mode that is not
// shown are only saved.
function bindSettingsPanel(el) {
  const s = heat.settings;
  const set = (path, value) => {
    const [a, b] = path.split(".");
    if (path === "map.tone") s.map[heat.theme ? (heat.theme === "dark" ? "toneDark" : "toneLight") : toneKey()] = value; // for one theme
    else if (b === undefined) s[a] = value; else s[a][b] = value;
    (heat.save || saveMapSettings)(s);
  };
  const shown = (path) => path.startsWith("map.") || path.startsWith(s.layer + ".");
  const refresh = (path, kind) => {
    if (path === "map.source" || path === "map.relief" || path === "map.trails") return applyBase(true);
    if (path === "map.tone") return applyBase(false);
    if (!shown(path)) return;
    if (kind === "paint") updatePaint(); else drawHeatLayers();
  };
  const summary = () => { const keep = heat.openAcc; renderSettingsPanel(); heat.openAcc = keep; };
  el.querySelectorAll("select").forEach((sel) => sel.onchange = () => {
    const value = sel.name === "tiles.zoom" ? Number(sel.value) : sel.value;
    set(sel.name, value);
    refresh(sel.name, "layers");
    summary();
  });
  el.querySelectorAll("[data-pick]").forEach((b) => b.onclick = () => {
    const name = b.dataset.pick;
    set(name, name === "tiles.zoom" ? Number(b.dataset.value) : b.dataset.value);
    el.querySelectorAll(`[data-pick="${name}"]`).forEach((x) => {
      x.classList.toggle("on", x === b);
      x.setAttribute("aria-checked", String(x === b));
    });
    const paint = name.endsWith(".ramp");
    refresh(name, paint ? "paint" : "layers");
    if (!paint) summary(); // the section header shows the chosen base map / colours
  });
  el.querySelectorAll("[data-chip]").forEach((b) => b.onclick = () => {
    set(b.dataset.chip, b.dataset.value);
    el.querySelectorAll(`[data-chip="${b.dataset.chip}"]`).forEach((x) => x.classList.toggle("on", x === b));
    refresh(b.dataset.chip, "layers");
    if (b.dataset.chip === "heatmap.style") summary();
  });
  el.querySelectorAll("input[type=checkbox][name]").forEach((c) => c.onchange = () => {
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

// A new base map, shading or trails: the base layers swapped, the layers on top (routes,
// tiles) kept. setStyle alone diffs the style and drops them without a "style.load".
function swapBase(map, style) {
  const own = new Set(["background", "base", "relief", "trails"]), ownSrc = new Set(["base", "dem", "trails"]);
  map.setStyle(style, { transformStyle: (prev, next) => prev ? { ...next,
    sources: { ...Object.fromEntries(Object.entries(prev.sources).filter(([k]) => !ownSrc.has(k))), ...next.sources },
    layers: [...next.layers, ...prev.layers.filter((l) => !own.has(l.id))] } : next });
}

function applyBase(newSource) {
  const map = heat.map;
  if (!map) return;
  const M = heat.settings.map;
  if (newSource) { swapBase(map, baseStyle(M)); return; }
  if (!map.getLayer("base")) return;
  const tone = toneOf(mapTone(M));
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
    ["Time", hours(sum("time_s")), ""],
  ];
  if (heat.settings.layer === "tiles") {
    const { tiles, square, cluster } = heatTiles();
    items.push(["Tiles", num(tiles.size), TILE_SIZES.find(([z]) => z === heat.settings.tiles.zoom)?.[1] || ""],
      ["Max square", square.size ? `${square.size} × ${square.size}` : "–", ""],
      ["Cluster", `${num(cluster.length)} tiles`, ""],
      ...regionSummaryItems(heat.settings.tiles.regions, heat.settings.tiles.zoom, tiles, renderHeatKpis));
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
    properties: { id: t.id, day: t.day, at: t.activity_type, type: typeLabel(t.activity_type), person: personLabel(t.person_id), pcolor: colorFor(t.person_id) },
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
    // clusterOnly (a Home Assistant map card's Cluster): the tiles only as a thin grid
    map.addLayer({ id: "tiles-fill", type: "fill", source: "tiles", paint: {
      "fill-opacity": T.clusterOnly ? 0 : T.style === "heat" ? 0.55 : 0.32, "fill-antialias": T.display === "grid" } });
    if (T.display === "grid" || T.clusterOnly) map.addLayer({ id: "tiles-line", type: "line", source: "tiles", paint: { "line-opacity": 0.35, "line-width": 0.6 } });
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
      paint: { "line-color": DARK_TONES.has(mapTone(s.map)) || s.map.source === "none" && document.documentElement.dataset.theme === "dark" ? "#ffffff" : "#1b1e25",
               "line-opacity": 0.7, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 14, 1.6] } });
  }
  updatePaint();
  renderHeatKpis();
}

// Activity › New tiles: the tiles of each size this activity visited before any earlier
// activity of the person did (virtual ones count, as on the map), on a map with the route.
// Computed here from the earlier routes that come near (earlier-tracks); shown only when there
// is a new tile. The size picker lists only sizes with new tiles, the largest first.
const NEW_TILE_NOUN = { 13: "square", 14: "explorer tile" };
async function newTilesCard(view, a, track) {
  const box = view.querySelector("[data-new-tiles]");
  if (!box) return;
  const earlier = await api(`activities/${a.id}/earlier-tracks`).catch(() => null);
  if (!earlier || !box.isConnected) return;
  const coords = lonLat(track.polyline);
  const before = earlier.items.map((p) => ({ coords: lonLat(p), day: "" }));
  const sizes = TILE_SIZES.map(([z, label]) => {
    const seen = computeTiles(before, z);
    const tiles = [...computeTiles([{ coords, day: "" }], z).entries()].filter(([k]) => !seen.has(k)).map(([, t]) => t);
    return { z, label, tiles };
  }).filter((x) => x.tiles.length);
  if (!sizes.length) return;
  let cur = sizes[0];
  const countText = (x) => `${num(x.tiles.length)} new ${NEW_TILE_NOUN[x.z]}${x.tiles.length === 1 ? "" : "s"}`;
  box.hidden = false;
  box.innerHTML = `<div class="card-head"><h3 class="tile-title">${metricIcon("tiles", 18)}<span>New tiles</span></h3><span class="spacer"></span>
      <div class="badges">${badgeHtml("new-tiles", "Size", cur.label, { panel: `<div class="opt-panel">${pickList("new-tiles", sizes.map((x) => [x.z, `${x.label} · ${num(x.tiles.length)}`]), cur.z)}</div>`, right: true })}</div></div>
    <div class="route-wrap"><div id="new-tiles-map" class="map"></div>
      <div class="route-overlays new-tiles-count"><div class="route-virtual" data-new-count>${countText(cur)}</div></div></div>`;
  bindBadges(box);
  const corners = cur.tiles.flatMap((t) => { const [w, so, e, n] = tileBounds(t.x, t.y, cur.z); return [[w, so], [e, n]]; });
  const map = await createMap("new-tiles-map", loadMapSettings().map, { bounds: boundsOf([coords, corners]), reset: true, extra: true });
  const color = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#0f766e";
  const data = () => ({ type: "FeatureCollection", features: cur.tiles.map((t) => tileFeature(t, cur.z)) });
  map.addSource("tiles", { type: "geojson", data: data() });
  map.addLayer({ id: "tiles-fill", type: "fill", source: "tiles", paint: { "fill-color": color, "fill-opacity": 0.32 } });
  map.addLayer({ id: "tiles-line", type: "line", source: "tiles", paint: { "line-color": color, "line-opacity": 0.6, "line-width": 0.8 } });
  map.addSource("route", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } } });
  map.addLayer({ id: "route", type: "line", source: "route", layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": document.documentElement.dataset.theme === "dark" ? "#ffffff" : "#1b1e25", "line-opacity": 0.7, "line-width": 1.6 } });
  box.querySelectorAll('[data-pick="new-tiles"]').forEach((b) => b.onclick = () => {
    box.querySelectorAll('[data-pick="new-tiles"]').forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); });
    cur = sizes.find((x) => x.z === Number(b.dataset.value));
    box.querySelector('[data-badge-value="new-tiles"]').textContent = cur.label;
    box.querySelector("[data-new-count]").textContent = countText(cur);
    map.getSource("tiles").setData(data());
    document.onclick?.();
  });
}

// `dashed`: a segment line (dashed from the first frame); `ends`: one colour for both ends.
async function showRouteMap(container, polyline, { offset = false, dashed = false, ends = null, corridor = 0 } = {}) {
  const coords = lonLat(polyline);
  // a Home Assistant card (Activity detailed) may set its own base map and shading
  const ms = { ...loadMapSettings().map, ...(typeof EMBED_ROUTE_MAP !== "undefined" && document.body.classList.contains("embed-detail") ? EMBED_ROUTE_MAP : {}) };
  const map = await createMap(container, ms, { bounds: boundsOf([coords]), reset: true });
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  map.addSource("route", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } } });
  map.addLayer({ id: "route", type: "line", source: "route", layout: { "line-join": "round", "line-cap": dashed ? "butt" : "round" },
                 paint: { "line-color": accent, "line-width": 3.5, "line-offset": (ROUTE_OFFSET_PX = offset ? 2.2 : 0), ...(dashed ? { "line-dasharray": [1.4, 0.55] } : {}) } });
  setCorridor(map, coords, corridor); // a segment's corridor (half width in m) under the line
  map.addSource("ends", { type: "geojson", data: { type: "FeatureCollection", features: [
    { type: "Feature", properties: { c: ends || "#3ecf8e" }, geometry: { type: "Point", coordinates: coords[0] } },
    { type: "Feature", properties: { c: ends || "#ff6b6b" }, geometry: { type: "Point", coordinates: coords[coords.length - 1] } }] } });
  map.addLayer({ id: "ends", type: "circle", source: "ends", paint: { "circle-radius": 5, "circle-color": ["get", "c"], "circle-stroke-width": 2, "circle-stroke-color": mapHalo() } });
}

// The corridor of a segment: a soft shadow 2 × half width metres wide around the line, hidden
// with 0. Drawn opaque on a canvas in Web Mercator and shown see-through as one image, so the
// shadow is even (a see-through map line darkens where it overlaps itself at the bends).
function setCorridor(map, coords, halfWidth) {
  if (!map?.getSource || !map.getSource("route")) return;
  const layer = map.getLayer("corridor");
  if (!(halfWidth > 0) || coords.length < 2) { if (layer) map.setLayoutProperty("corridor", "visibility", "none"); return; }
  const R = Math.PI / 180;
  const mx = (lon) => (lon + 180) / 360, my = (lat) => { const t = Math.sin(lat * R); return 0.5 - Math.log((1 + t) / (1 - t)) / (4 * Math.PI); };
  const lonOf = (x) => x * 360 - 180, latOf = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / R;
  const lat0 = coords[Math.floor(coords.length / 2)][1];
  const half = halfWidth / (40075016.686 * Math.cos(lat0 * R)); // in Mercator units
  const xs = coords.map(([lon]) => mx(lon)), ys = coords.map(([, lat]) => my(lat));
  const x0 = Math.min(...xs) - half * 1.5, x1 = Math.max(...xs) + half * 1.5, y0 = Math.min(...ys) - half * 1.5, y1 = Math.max(...ys) + half * 1.5;
  const k = 2048 / Math.max(x1 - x0, y1 - y0);
  const cv = Object.assign(document.createElement("canvas"), { width: Math.max(2, Math.ceil((x1 - x0) * k)), height: Math.max(2, Math.ceil((y1 - y0) * k)) });
  const ctx = cv.getContext("2d");
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#3b82f6";
  ctx.lineWidth = 2 * half * k; ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath();
  xs.forEach((x, i) => (i ? ctx.lineTo((x - x0) * k, (ys[i] - y0) * k) : ctx.moveTo((x - x0) * k, (ys[i] - y0) * k)));
  ctx.stroke();
  const img = { url: cv.toDataURL(), coordinates: [[lonOf(x0), latOf(y0)], [lonOf(x1), latOf(y0)], [lonOf(x1), latOf(y1)], [lonOf(x0), latOf(y1)]] };
  if (map.getSource("corridor")) map.getSource("corridor").updateImage(img);
  else map.addSource("corridor", { type: "image", ...img });
  if (!layer) map.addLayer({ id: "corridor", type: "raster", source: "corridor", paint: { "raster-opacity": 0.2, "raster-fade-duration": 0 } }, "route");
  else map.setLayoutProperty("corridor", "visibility", "visible");
}

// ---- Coming-soon pages --------------------------------------------------------------

const PLANNED = {}; // section: [title, stage, [lines]] (none at the moment)

function renderPlanned(key) {
  const [title, stage, items] = PLANNED[key];
  view.innerHTML = `<div class="page-head"><h2>${title}</h2></div>
    <div class="card"><div class="card-row">${state(`Planned — ${stage}`, "warn")}</div>
      <ul class="plain">${items.map((i) => `<li>${i}</li>`).join("")}</ul></div>`;
}

// ---- Compare (everyone): not in the navigation for now (two people: together.js) ------

async function renderCompare(params) {
  const data = await api("compare?" + new URLSearchParams(filterQuery(params)));
  const people = data.people;
  const max = (k) => Math.max(1, ...people.map((p) => p[k] || 0));
  const bar = (p, k, i, fmt) => `<div class="bar-row"><span class="bar-label">${avatar(p, 18)} ${esc(p.label)}</span>
      <span class="bar"><span style="width:${((p[k] || 0) / max(k)) * 100}%;background:${personColor(p, i)}"></span></span>
      <span class="bar-value">${fmt(p[k])}</span></div>`;
  view.innerHTML = `
    ${pageHead("Compare", timeBadge(params) + typeBadge(params))}
    ${hint("Everyone side by side, in the order set in Settings › People.")}<br>
    <div class="cards">
      ${[["Activities", "activities", (v) => num(v || 0)], ["Distance", "distance_m", km], ["Time", "time_s", hours], ["Ascent", "ascent_m", meters]]
        .map(([label, k, fmt]) => `<div class="card"><h3>${label}</h3>${people.map((p, i) => bar(p, k, i, fmt)).join("")}</div>`).join("")}
    </div>
    <div class="cards">${people.map((p, i) => `<div class="card">
      <div class="card-row">${avatar(p, 28)} <h3 style="margin:0">${esc(p.label)}</h3></div>
      ${hint(p.last_activity ? `Last activity ${browserTime(p.last_activity)}` : "No activities")}
      <table class="data"><thead><tr><th>Group</th><th class="num">Activities</th><th class="num">Distance</th><th class="num">Time</th></tr></thead>
      <tbody>${p.groups.map((g) => `<tr><td>${esc(groupLabel(g.category))}</td><td class="num">${num(g.activities)}</td>
        <td class="num">${g.distance_m ? km(g.distance_m) : "–"}</td><td class="num">${hours(g.time_s)}</td></tr>`).join("")
        || `<tr><td colspan="4" class="hint">No activities</td></tr>`}</tbody></table></div>`).join("")}</div>`;
  bindBadges(view.querySelector(".page-head"));
  bindFilterBadges(view.querySelector(".page-head"), "#/compare", params);
}

// ---- Settings: General / People / Import / Backup -----------------------------------

const SETTINGS_TABS = [
  ["general", "General", svg(`<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>`)],
  ["data", "Data sources", svg(`<ellipse cx="12" cy="5.5" rx="7.5" ry="2.5"/><path d="M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13"/><path d="M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5"/>`)],
  ["people", "People", svg(`<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .7 3.2 2.5 3.6 5.2"/>`)],
  ["workouts", "Workouts API", svg(`<rect x="3" y="12" width="4" height="8" rx="1"/><rect x="10" y="5" width="4" height="15" rx="1"/><rect x="17" y="9" width="4" height="11" rx="1"/>`)],
  ["import", "Imported", svg(`<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 17v3h16v-3"/>`)],
  ["backup", "Backup", svg(`<path d="M4 7h16v13H4z"/><path d="M2 4h20v3H2z"/><path d="M10 11h4"/>`)],
  ["log", "Log", svg(`<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M9 11h7M9 15h7M9 19h4"/>`)],
];

async function renderSettings(tab, params) {
  tab = SETTINGS_TABS.some(([k]) => k === tab) ? tab : "general";
  view.innerHTML = `${pageHead("Settings", "", switchHtml("tab", SETTINGS_TABS.map(([k, l, icon]) => [k, `${icon}<span>${l}</span>`]), tab))}<div id="tab" class="settings-body"></div>`;
  view.querySelectorAll("[data-switch=tab]").forEach((b) => b.onclick = () => { location.hash = "#/settings/" + b.dataset.value; });
  const el = document.getElementById("tab");
  if (tab === "people") await settingsPeople(el);
  else if (tab === "import") await settingsImport(el, params);
  else if (tab === "backup") await settingsBackup(el);
  else if (tab === "workouts") await settingsWorkouts(el);
  else if (tab === "log") await settingsLog(el);
  else await settingsGeneral(el, tab);
}

// Log: everything the server and the import runs logged (the same lines as the add-on's log in
// Home Assistant), newest first; green info, yellow warnings, red errors. Refreshed every 10 s
// while open; the level choice is fixed on every visit (All).
const LOG_LEVELS = [["all", "All"], ["warning", "Warnings and errors"], ["error", "Errors"]];
async function settingsLog(el) {
  let level = "all", entries = [];
  const cls = (lv) => (lv === "INFO" ? "ok" : lv === "WARNING" ? "warn" : lv === "DEBUG" ? "" : "bad");
  const shown = () => entries.filter((e) => level === "all" || (level === "warning" ? e.level !== "INFO" && e.level !== "DEBUG" : cls(e.level) === "bad"));
  const row = (e) => {
    const [first, ...rest] = e.message.split("\n");
    const msg = rest.length ? `<details><summary>${esc(first)}</summary><pre>${esc(rest.join("\n"))}</pre></details>` : esc(first);
    return `<div class="log-row ${cls(e.level)}"><span class="log-time" title="${esc(e.time)}">${browserTime(e.time)}</span>
      <span class="log-level">${esc(e.level.toLowerCase())}</span><span class="log-area">${esc(e.area)}</span><div class="log-msg">${msg}</div></div>`;
  };
  el.innerHTML = `<div class="card"><div class="card-head"><h3>Log</h3><span class="hint" data-log-count></span><span class="spacer"></span>
      <div class="badges">${badgeHtml("log-level", "Show", LOG_LEVELS[0][1], { panel: `<div class="opt-panel">${pickList("log-level", LOG_LEVELS, level)}</div>`, right: true })}</div></div>
    <div class="log-list" data-log></div></div>`;
  bindBadges(el);
  const box = el.querySelector("[data-log]");
  const paint = () => {
    const list = shown();
    el.querySelector("[data-log-count]").textContent = `${num(list.length)} entries`;
    // the open tracebacks stay open after a refresh
    const open = new Set([...box.querySelectorAll("details[open]")].map((d) => d.closest(".log-row").dataset.key));
    box.innerHTML = list.map((e, i) => row(e).replace('<div class="log-row', `<div data-key="${esc(e.time + e.message.slice(0, 40))}" class="log-row`)).join("") || hint("Nothing logged yet.");
    box.querySelectorAll(".log-row").forEach((r) => { if (open.has(r.dataset.key)) r.querySelector("details")?.setAttribute("open", ""); });
  };
  el.querySelectorAll('[data-pick="log-level"]').forEach((b) => b.onclick = () => {
    el.querySelectorAll('[data-pick="log-level"]').forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); });
    level = b.dataset.value;
    el.querySelector('[data-badge-value="log-level"]').textContent = LOG_LEVELS.find(([k]) => k === level)[1];
    document.onclick?.();
    paint();
  });
  const load = async () => {
    if (!el.isConnected) return false;
    entries = (await api("log").catch(() => ({ entries }))).entries;
    paint();
    return true;
  };
  await load();
  const timer = setInterval(async () => { if (!(await load())) clearInterval(timer); }, 10000);
}

// General (appearance, road surface) and Data (sources: Garmin Connect, upload, folder, Strava)
// share one function; `tab` picks the cards.
async function settingsGeneral(el, tab = "general") {
  const [s, devices, garminState, icuFiles] = await Promise.all([api("settings"), api("devices"), api("garmin"),
    tab === "data" ? api("icu-files").catch(() => ({ persons: {} })) : { persons: {} }]);
  PERSONS = await api("persons");
  const people = realPeople();
  const accounts = garminState.accounts || {};
  const est = garminState.estimate || {};
  // Upper bound for a download time, rounded up: "12 h", "3 days".
  const upTo = (sec) => (sec < 36 * 3600 ? `${Math.ceil(sec / 3600 + 0.5)} h` : `${Math.ceil(sec / 86400)} days`);
  const accent = store.get("accent") || "sky";
  const interval = (m) => (m === 0 ? "Off" : m < 60 ? `${m} min` : m === 60 ? "1 hour" : `${m / 60} hours`);
  const source = s.data_source || "folder";
  const choice = (name, value, current, title, text, extra = "") =>
    `<label class="choice"><input type="radio" name="${name}" value="${value}" ${value === current ? "checked" : ""}>
      <span><b>${title}${extra}</b><span class="hint">${text}</span></span></label>`;

  const watchesHtml = `<div class="watches" ${s.person_mode === "devices" ? "" : "hidden"}>
      <div class="panel-title" style="margin-top:14px">Watches <span class="title-note">(new files only)</span></div>
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
      <h3>Watched folder <span class="title-note">(absolute path${s.allowed_roots ? `, inside ${esc(s.allowed_roots)}` : ""})</span></h3>
      <input class="field-input" name="root" value="${esc(s.root || "")}" placeholder="${s.desktop ? "C:\\Users\\…\\Trailbook" : "/share/trailbook"}">
      <div class="card-row" style="margin-top:12px"><button class="primary" data-save="root">Save</button><span data-msg></span></div>
    </div>
    <div class="card">
      <h3>Assigning files to people <span class="title-note">(new files only)</span></h3>
      ${choice("person_mode", "folders", s.person_mode, "One subfolder per person", "folder/alice/… — the folder decides.")}
      ${choice("person_mode", "devices", s.person_mode, "One shared folder", "The watch decides.")}
      <span data-msg></span>
      ${watchesHtml}
    </div>
    <div class="card">
      <h3>Automatic folder scan</h3>
      <select class="field-input" name="scan_interval_min" style="max-width:200px">${s.scan_interval_choices.map((m) =>
        `<option value="${m}" ${m === s.scan_interval_min ? "selected" : ""}>${interval(m)}</option>`).join("")}</select>
      <div>${s.next_scan_at ? state(`Next scan at ${browserTime(s.next_scan_at)}`) : state("Off", "warn")} <span data-msg></span></div>
    </div>`;

  const uploadCard = `
    <div class="card">
      <h3>Upload <span class="title-note">(Garmin export ZIP, ZIP of FIT files or a single .fit)</span></h3>
      <div class="upload-row">
        <select name="upload-person"><option value="">Choose a person…</option>${people.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join("")}</select>
        ${filePicker("upload-file", ".zip,.fit")}
        <button class="primary" data-upload>Upload and import</button>
      </div>
      <div data-upload-msg style="margin-top:8px"></div>
    </div>`;

  const otherSourcesCard = `
    <div class="card">
      <h3>Other sources: Strava <span class="title-note">(one-time import, e.g. history from before Garmin)</span></h3>
      <ol class="plain steps">
        <li>Strava (web) › Settings › My Account › <b>Download or Delete Your Account</b> › Request your archive.</li>
        <li>Upload the ZIP from the e-mail, or single .fit, .gpx and .tcx files (also .gz).</li>
      </ol>
      <div class="hint">The ZIP also brings titles, descriptions and activities entered by hand. Activities you already have are skipped.</div>
      <div class="garmin-form strava-range">
        <label><span class="opt-label">From</span><input type="date" name="strava-from" title="Empty = from the first activity"></label>
        <label><span class="opt-label">To</span><input type="date" name="strava-to" title="Empty = up to the last activity"></label>
        <span class="hint">Only the ZIP's activities from these days (both included).</span>
      </div>
      <div class="upload-row">
        <select name="strava-person"><option value="">Choose a person…</option>${people.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join("")}</select>
        ${filePicker("strava-files", ".zip,.fit,.gpx,.tcx,.gz", true)}
        <button class="primary" data-strava-upload>Upload and import</button>
      </div>
      <div data-strava-msg style="margin-top:8px"></div>
    </div>`;

  // intervals.icu: on/off per person with a key, and the files waiting for their download.
  const ON_OFF = [["on", "On"], ["off", "Off"]];
  const icuRow = (p) => {
    const f = icuFiles.persons[p.id];
    const v = f.on ? "on" : "off";
    return `<div class="garmin-person" data-iperson="${esc(p.id)}">
      <div class="garmin-head">
        <span class="garmin-who">${avatar(p, 20)} <b>${esc(p.label)}</b></span>
        <div class="badges">${badgeHtml("icu-on-" + p.id, "Check", ON_OFF.find(([k]) => k === v)[1],
          { panel: `<div class="opt-panel">${pickList("icu-on-" + p.id, ON_OFF, v)}</div>` })}</div>
        ${f.on ? `<span class="hint">Next check at ${browserTime(icuFiles.next_check)}</span>` : ""}
        ${f.status === "auth_error" ? state("key refused", "bad") : ""}
      </div>
      ${f.files.length ? `<div class="badges icu-files">${f.files.map((x) =>
        `<button class="badge" data-ifile="${esc(x.id)}"><span class="badge-label">Download</span><span class="badge-value">${esc(x.name || x.id)}</span></button>`).join("")}</div>` : ""}
    </div>`;
  };
  const icuPeople = people.filter((p) => icuFiles.persons[p.id]);
  const icuCard = `
    <div class="card">
      <h3>Other sources: Intervals.icu</h3>
      <div class="hint">Testing phase — not working yet.</div>
      <div class="garmin-people">${icuPeople.map(icuRow).join("") || hint("Add the intervals.icu API key first (Settings › Workouts API).")}</div>
    </div>`;

  const GSTATE = { new: ["not tested", "warn"], ok: ["connected", "ok"], error: ["paused", "warn"], auth_error: ["key refused", "bad"] };
  const garminRow = (p) => {
    const a = accounts[p.id];
    const st = a ? GSTATE[a.status] || [a.status, ""] : ["not connected", "muted"];
    return `<div class="garmin-person" data-gperson="${esc(p.id)}">
      <div class="garmin-head">
        <span class="garmin-who">${avatar(p, 20)} <b>${esc(p.label)}</b></span>
        ${state(st[0], st[1])}
        ${a ? `<span class="hint">${num(a.downloaded)} downloaded${a.failed ? ` · ${num(a.failed)} failed` : ""}${!a.backfill_done && est.persons?.[p.id] ? ` · ≈ ${num(est.persons[p.id].remaining)} left` : ""}</span>` : ""}
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
      <ol class="plain steps">
        <li>Garmin Connect (web) › Account settings › <b>Personal API key</b>.</li>
        <li><b>Create Key</b> and copy it (shown only once).</li>
        <li>Paste it below.</li>
        <li>Click <b>Connect</b>${est.typical?.seconds ? ` — it may take up to ${upTo(est.typical.seconds)} to download` : ""}.</li>
      </ol>
      <div class="garmin-people">${people.map(garminRow).join("") || hint("Add people first (Settings › People).")}</div>
    ${connected ? `<div class="garmin-auto">
      <h3>Automatic download</h3>
      <select class="field-input" name="scan_interval_min" style="max-width:200px">${s.scan_interval_choices.map((m) =>
        `<option value="${m}" ${m === s.scan_interval_min ? "selected" : ""}>${interval(m)}</option>`).join("")}</select>
      <div>${s.next_scan_at ? state(`Next download at ${browserTime(s.next_scan_at)}${est.remaining && est.seconds ? ` · history: up to ${upTo(est.seconds)} left` : ""}`) : state("Off", "warn")}</div>
      <div class="card-row" style="margin-top:12px">
        <button data-gsync>Download now</button>
        <span data-msg></span>
      </div>
    </div>` : ""}
    </div>`;

  el.innerHTML = tab === "data" ? `
    <div class="card">
      <h3>Data connection</h3>
      <div class="source-grid">
        ${choice("data_source", "garmin", source, "Garmin Connect", "Recommended — the most complete data.")}
        ${choice("data_source", "upload", source, "Upload a ZIP", "One-time import of an export or FIT files.")}
        ${choice("data_source", "folder", source, "Watch a folder", "FIT files saved to a folder, e.g. by Home Assistant.")}
      </div>
      <span data-source-msg></span>
    </div>
    ${source === "folder" ? folderCards : source === "upload" ? uploadCard : garminCard}
    ${otherSourcesCard}
    ${icuCard}` : `
    ${updateCardHtml(s.desktop ? UPDATE || await api("update").catch(() => null) : null)}
    <div class="card appearance">
      <h3>Appearance <span class="title-note">(saved per browser)</span></h3>
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
    </div>
    <div class="card">
      <h3>Road surface <span class="title-note">(from OpenStreetMap: the route's area is sent to a public map server)</span></h3>
      ${choice("surface_mode", "open", s.surface_mode, "When an activity is opened", "The first visit can take a few minutes.")}
      ${choice("surface_mode", "background", s.surface_mode, "All activities, slowly in the background", "Newest first, one at a time with a pause; opened activities are then ready.")}
      <div>${state(`${num(s.surface_progress.done)} of ${num(s.surface_progress.total)} activities with a route done`)} <span data-msg></span></div>
    </div>
    <div class="card">
      <h3>Support Trailbook</h3>
      <div class="hint">Trailbook is free. If it helps you, you can support its development.</div>
      <a class="bmc-link" href="https://buymeacoffee.com/md0005" target="_blank" rel="noopener"><img src="bmc-button.svg" alt="Buy me a coffee" height="48"></a>
    </div>`;

  const reload = () => {
    api("garmin/alerts").then((a) => { renderAlerts(a); setHeaderHeight(); }).catch(() => {});
    return settingsGeneral(el, tab);
  };
  bindBadges(el);
  bindUpdateCard(el);
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
  const autosave = async (key, value, out) => {
    try {
      await api("settings", { method: "PUT", body: JSON.stringify({ [key]: value }) });
      out.innerHTML = state("Saved", "ok");
    } catch (e) { out.innerHTML = state(esc(e.message), "bad"); }
  };
  el.querySelectorAll("input[name=surface_mode]").forEach((r) => r.onchange = () =>
    autosave("surface_mode", r.value, r.closest(".card").querySelector("[data-msg]")));
  el.querySelectorAll("input[name=person_mode]").forEach((r) => r.onchange = () => {
    const w = el.querySelector(".watches");
    if (w) w.hidden = r.value !== "devices";
    autosave("person_mode", r.value, r.closest(".card").querySelector("[data-msg]"));
  });
  el.querySelectorAll("select[name=scan_interval_min]").forEach((sel) => sel.onchange = async () => {
    await autosave("scan_interval_min", Number(sel.value), sel.closest(".card").querySelector("[data-msg]"));
    reload();
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
    const value = card.querySelector(`[name=${key}]`).value;
    try {
      await api("settings", { method: "PUT", body: JSON.stringify({ [key]: value }) });
      out.innerHTML = state("Saved", "ok");
    } catch (e) { out.innerHTML = state(esc(e.message), "bad"); }
  });
  el.querySelectorAll("[data-gperson]").forEach((box) => {
    const pid = box.dataset.gperson, out = box.querySelector("[data-gmsg]");
    const show = (r) => {
      api("garmin/alerts").then((a) => { renderAlerts(a); setHeaderHeight(); }).catch(() => {});
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
  el.querySelectorAll("[data-iperson]").forEach((box) => {
    const pid = box.dataset.iperson, name = "icu-on-" + pid;
    box.querySelectorAll(`[data-pick="${name}"]`).forEach((b) => b.onclick = async () => {
      document.onclick?.();
      try { await api("icu-files/" + encodeURIComponent(pid), { method: "PUT", body: JSON.stringify({ on: b.dataset.value === "on" }) }); }
      catch (e) { alert(e.message); }
      reload();
    });
    box.querySelectorAll("[data-ifile]").forEach((b) => b.onclick = () => {
      const a = document.createElement("a");
      a.href = `api/icu-files/${encodeURIComponent(pid)}/${encodeURIComponent(b.dataset.ifile)}`;
      a.download = "";
      document.body.append(a);
      a.click();
      a.remove();
      b.remove();
    });
  });
  const sup = el.querySelector("[data-strava-upload]");
  if (sup) sup.onclick = async () => {
    const out = el.querySelector("[data-strava-msg]");
    const pid = el.querySelector("[name=strava-person]").value;
    const files = [...el.querySelector("[name=strava-files]").files];
    if (!pid || !files.length) { out.innerHTML = state("Choose a person and files", "warn"); return; }
    sup.disabled = true;
    try {
      const range = { from: el.querySelector("[name=strava-from]").value, to: el.querySelector("[name=strava-to]").value };
      if (range.from && range.to && range.from > range.to) { out.innerHTML = state("From is after To", "warn"); sup.disabled = false; return; }
      const r = await uploadFiles(pid, files, out, range);
      out.innerHTML = state(`Uploaded · ${num(r.queued)} activities queued${r.failed ? ` · ${num(r.failed)} files refused` : ""} — progress in Settings › Imported`, r.failed ? "warn" : "ok");
    } catch (e) { out.innerHTML = state(esc(e.message), "bad"); }
    sup.disabled = false;
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
      const r = await uploadOne({ person: pid, name: file.name }, file,
        (share) => { out.innerHTML = state(`Uploading ${esc(file.name)} · ${num(share * 100)} %…`); });
      out.innerHTML = state(`Uploaded · ${num(r.queued)} FIT file(s) queued — progress in Settings › Imported`, "ok");
    } catch (e) { out.innerHTML = state(esc(e.message), "bad"); }
    up.disabled = false;
  };
}

// Big files go in parts: a proxy in front (Home Assistant's Ingress) refuses big requests.
const UPLOAD_PART = 8 * 1048576;
async function uploadOne(params, file, onPart = () => {}) {
  if (file.size <= UPLOAD_PART) return api(`uploads?${new URLSearchParams(params)}`, { method: "POST", body: file, headers: {} });
  const part = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  for (let offset = 0; offset < file.size; offset += UPLOAD_PART) {
    onPart(offset / file.size);
    await api(`uploads/part?${new URLSearchParams({ part, offset })}`, { method: "POST", body: file.slice(offset, offset + UPLOAD_PART), headers: {} });
  }
  return api(`uploads?${new URLSearchParams({ ...params, part })}`, { method: "POST", headers: {} });
}

// Upload files one after another; the import job picks up each one as it arrives.
async function uploadFiles(pid, files, out, range = {}) {
  const span = Object.fromEntries(Object.entries(range).filter(([, v]) => v)); // from / to: ZIPs of a Strava export only
  let queued = 0, failed = 0;
  for (const [i, file] of files.entries()) {
    const label = files.length > 1
      ? `Uploading ${num(i + 1)} of ${num(files.length)}: ${esc(file.name)}`
      : `Uploading ${esc(file.name)} (${num(file.size / 1048576, 1)} MB)`;
    out.innerHTML = state(`${label}…`);
    try {
      const r = await uploadOne({ person: pid, name: file.name, ...span }, file,
        (share) => { out.innerHTML = state(`${label} · ${num(share * 100)} %…`); });
      queued += r.queued;
    } catch (e) {
      failed++;
      if (files.length === 1) throw e;
    }
  }
  return { queued, failed };
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
      <h3>People <span class="title-note">(drag rows to reorder)</span></h3>
      <div class="scroll"><table class="data people"><thead><tr><th></th><th>Icon</th><th>Color</th><th>Label</th><th>Sex</th><th>Id</th><th class="num">Activities</th><th>Training thresholds</th><th></th></tr></thead>
      <tbody id="people-rows">${people.map((p, i) => `<tr draggable="true" data-row="${esc(p.id)}">
        <td class="grip" title="Drag to reorder">${ICON.grip}</td>
        <td><select data-icon="${esc(p.id)}" class="icon-select">${PERSON_ICONS.map((ic) =>
          `<option value="${ic}" ${ic === (p.icon || "") ? "selected" : ""}>${ic || "Aa"}</option>`).join("")}</select></td>
        <td><span class="swatches">${PERSON_COLORS.map((c) =>
          `<button class="swatch ${c === personColor(p, i) ? "active" : ""}" style="background:${c}" data-color="${c}" data-pid="${esc(p.id)}" aria-label="Color ${c}"></button>`).join("")}</span></td>
        <td><input data-label="${esc(p.id)}" value="${esc(p.label)}"></td>
        <td><select data-sex="${esc(p.id)}" title="The silhouette in Wellbeing › Body">${[["", "–"], ["female", "Female"], ["male", "Male"]].map(([v, l]) =>
          `<option value="${v}" ${v === (p.sex || "") ? "selected" : ""}>${l}</option>`).join("")}</select></td>
        <td><code>${esc(p.id)}</code></td>
        <td class="num">${num(p.activities)}</td>
        <td class="th-cell" data-th-sum="${esc(p.id)}"><span class="hint">…</span></td>
        <td class="actions"><button class="icon" data-th-edit="${esc(p.id)}" title="Edit training thresholds" aria-label="Edit training thresholds">${ICON_PENCIL}</button></td></tr>
        <tr class="th-row" data-th-row="${esc(p.id)}" hidden><td colspan="9"><div data-th-box></div></td></tr>`).join("") || `<tr><td colspan="9" class="hint">No people yet.</td></tr>`}
      ${unassigned && unassigned.activities ? `<tr><td></td><td></td><td></td><td>${state("Unassigned", "warn")}</td><td></td><td><code>—</code></td><td class="num">${num(unassigned.activities)}</td><td></td><td></td></tr>` : ""}
      </tbody></table></div>
      <div class="card-row add-row"><input id="new-label" placeholder="New person's name"><button id="add" class="primary">Add person</button></div>
      <div class="card-row" style="margin-top:8px"><span id="people-msg"></span></div>
    </div>
    <div class="card" hidden>
      <h3>Watches <span class="title-note">(new files only)</span></h3>
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
  el.querySelectorAll("[data-sex]").forEach((sel) => sel.onchange = () => patch(sel.dataset.sex, { sex: sel.value || null }, "Saved"));
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
      tbody.querySelectorAll("tr[data-row]").forEach((r) => { const d = tbody.querySelector(`[data-th-row="${r.dataset.row}"]`); if (d) r.after(d); });
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
  // Training thresholds: values in use per person, the pencil opens the editor below the row.
  const loadSummary = async (pid) => {
    const cell = el.querySelector(`[data-th-sum="${pid}"]`);
    if (!cell) return;
    try { cell.innerHTML = thresholdSummary(await api("thresholds/" + encodeURIComponent(pid))); }
    catch { cell.innerHTML = `<span class="hint">–</span>`; }
  };
  await Promise.all(people.map((p) => loadSummary(p.id)));
  el.querySelectorAll("[data-th-edit]").forEach((b) => b.onclick = async () => {
    const pid = b.dataset.thEdit;
    const row = el.querySelector(`[data-th-row="${pid}"]`);
    const open = row.hidden;
    row.hidden = !open;
    b.classList.toggle("active", open);
    if (open) await renderThresholds(row.querySelector("[data-th-box]"), pid, () => loadSummary(pid));
  });
}

const FILE_PAGE = 100;
const STATUSES = ["new", "imported", "skipped", "duplicate", "error", "missing", "removed"];
const STATUS_KIND = { error: "bad", missing: "warn", imported: "ok", skipped: "muted", duplicate: "muted", removed: "muted" };

// A Garmin Connect daily summary (one row per day): what it holds, as icons in the metric colours;
// hover shows the value. Keys from garmin.DAY_CONTENTS.
const dayIc = (body, color) => `<svg class="tb-metric-icon" viewBox="0 0 24 24" width="16" height="16" style="--tb-metric-size:16px;color:var(${color})" aria-hidden="true">${body}</svg>`;
const DAY_CONTENT = {
  steps: ["Steps", "", () => metricIcon("steps", 16)],
  floors: ["Floors climbed", "", () => dayIc(`<path d="M2.5 21h7v-6h6V9h6" ${iconLine(2.4)}/><path d="M3 12.5 10.5 5M7 5h3.5v3.5" ${iconLine(1.9)}/>`, "--m-elev")],
  resting_hr: ["Resting heart rate", "bpm", () => metricIcon("heart_rate", 16)],
  stress: ["Average stress", "", () => dayIc(`<circle cx="12" cy="12" r="9" ${iconLine()}/><path d="M6.5 13.5 9 9.5l2.5 5 2.5-6 3.5 4.5" ${iconLine(1.9)}/>`, "--m-stress")],
  body_battery: ["Body Battery, highest", "", () => dayIc(`<rect x="3" y="7" width="16" height="10" rx="2" ${iconLine()}/><path d="M21.5 10.5v3" ${iconLine()}/><path d="m11.5 8.5-2.5 4h3l-2 3" ${iconLine(1.7)}/>`, "--m-breath")],
  respiration: ["Respiration, average", "brpm", () => metricIcon("respiration_rate", 16)],
  spo2: ["Pulse Ox, average", "%", () => metricIcon("muscle_oxygen", 16)],
  intensity: ["Intensity minutes", "min", () => dayIc(`<path d="M13.5 2.5 5 13.5h6l-1 8 8.5-11h-6Z" ${iconLine()}/>`, "--m-temp")],
  calories: ["Calories", "kcal", () => metricIcon("calories", 16)],
  hydration: ["Hydration", "ml", () => dayIc(`<path d="M12 3s-6.5 7.2-6.5 11.5a6.5 6.5 0 0 0 13 0C18.5 10.2 12 3 12 3Z" ${iconLine()}/>`, "--m-breath")],
};
function dayContent(f) {
  const icons = (f.day_contents || []).filter(([k]) => DAY_CONTENT[k]).map(([k, v]) => {
    const [label, u, icon] = DAY_CONTENT[k];
    return `<span class="day-part" title="${esc(label)}: ${num(v)}${u ? " " + u : ""}">${icon()}</span>`;
  }).join("");
  return `<span class="tb-metric-name">${metricIcon("date", 16)}<span>Daily summary</span></span><span class="day-parts">${icons}</span>`;
}

// File column: only the file name; the full path (and the ZIP member) on hover.
function fileShort(f) {
  if (f.kind === "day") return `<span class="file-short">Garmin Connect</span>`;
  const full = f.rel_path + (f.zip_member ? " › " + f.zip_member : "");
  const name = f.zip_member || f.rel_path.split("/").pop();
  return `<span class="file-short" title="${esc(full)}">${name !== full ? "…" : ""}${esc(name)}</span>`;
}

function fileContent(f) {
  if (f.kind === "day") return dayContent(f);
  if (f.activity_id && f.status !== "duplicate") {
    return `<a class="tb-activity-name" href="#/activity/${f.activity_id}">${typeIcon(f.activity_type)}<span>${esc(f.name || typeLabel(f.activity_type))}</span></a>${f.name ? `
      <span class="hint">${esc(typeLabel(f.activity_type))}</span>` : ""}`;
  }
  if (f.status === "duplicate" && f.activity_id) {
    return `duplicate of <a href="#/activity/${f.activity_id}">activity ${f.activity_id}</a>`;
  }
  const text = esc(f.skip_reason || f.fit_type || "");
  const icon = metricIcon(FIT_TYPE_ICON[f.fit_type] || "other");
  return `${text ? `<span class="tb-metric-name">${icon}<span>${text}</span></span>` : ""}${f.error ? " " + state(esc(f.error), "bad") : ""}`;
}

function fileActions(f) {
  if (f.kind === "day") return "";
  const owner = f.status === "imported" || f.prev_status === "imported";
  return [
    f.status === "error" ? `<button class="small" data-retry="${f.id}">Retry</button>` : "",
    f.status === "missing" && !f.dismissed ? `<button class="small" data-keep="${f.id}">Keep data</button>` : "",
    f.status === "missing" && f.activity_id ? `<button class="small danger" data-del="${f.activity_id}">Delete activity</button>` : "",
    `<button class="small" data-forget="${f.id}" data-owner="${owner ? 1 : 0}" title="Remove from import history; the next scan processes the file again">Remove from history</button>`,
  ].join(" ");
}

// Settings › Imported: the current data connection, the last run and — only when running it
// can change something — one button.
function scanCard(st) {
  const p = st.progress;
  const src = st.data_source || "folder";
  const sourceName = { folder: "Watch a folder", garmin: "Garmin Connect", upload: "Upload a ZIP" }[src];
  const sourceText = src === "folder" ? `${sourceName} · <code>${esc(st.root || "no folder set")}</code>` : sourceName;
  const every = (m) => (m < 60 ? `${m} min` : m === 60 ? "1 hour" : `${m / 60} hours`);
  const auto = src === "upload" ? ""
    : st.scan_interval_min && st.next_scan_at ? `every ${every(st.scan_interval_min)} · next ${browserTime(st.next_scan_at)}` : "off";
  const counts = (r) => [["imported", r.imported], ["skipped", r.skipped], ["duplicates", r.duplicates], ["errors", r.errors], ["missing", r.missing]]
    .filter(([, n]) => n).map(([k, n]) => `${num(n)} ${k}`).join(", ") || "nothing new";
  const last = st.running || p.state === "running"
    ? state(p.phase === "garmin"
      ? `Downloading from Garmin: ${num(p.done ?? 0)} activities`
      : `Running: ${esc(p.phase || "")} ${num(p.done ?? 0)} / ${p.total != null ? num(p.total) : "?"}`, "warn")
    : p.state === "failed" ? state(`Failed ${browserTime(p.finished_at)}: ${esc(p.error)}`, "bad")
    : p.state === "finished" ? `${browserTime(p.finished_at)} — ${counts(p)}`
    : "never";
  const queued = st.files?.new || 0;
  const useful = !st.running && (src === "folder" ? !!st.root : src === "garmin" ? st.garmin_connected > 0 || queued : queued > 0);
  const label = { folder: "Scan now", garmin: "Download now", upload: `Import ${num(queued)} queued file${queued === 1 ? "" : "s"}` }[src];
  return `<div class="card">
    <dl class="kv">
      <dt>Current setting</dt><dd>${sourceText} <a href="#/settings/data">Change</a></dd>
      ${auto ? `<dt>Automatic</dt><dd>${auto}</dd>` : ""}
      <dt>Last run</dt><dd>${last}</dd>
      ${st.missing_to_review ? `<dt>To review</dt><dd>${state(`${num(st.missing_to_review)} missing file(s)`, "warn")}</dd>` : ""}
    </dl>
    ${useful ? `<div class="card-row" style="margin-top:12px"><button id="scan" class="primary">${label}</button></div>` : ""}
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
    { key: "file", label: "File", sort: true, filter: { type: "text" }, render: fileShort },
    { key: "person", label: "Person", sort: true, filter: { type: "select", options: personOptions() },
      render: (f) => f.person_id ? `${avatar(person(f.person_id), 18)} ${esc(personLabel(f.person_id))}` : "" },
    { key: "content", label: "Activity / content", sort: true, cls: "content-cell", filter: { type: "text", placeholder: "walk, sleep…" },
      render: (f) => fileContent(f) + (f.status === "missing"
        ? ` <span class="hint">missing since ${browserTime(f.missing_since)}${f.dismissed ? ", reviewed" : ""}</span>` : "") },
    { key: "recorded", label: "Recorded", sort: true, filter: { type: "text", placeholder: "2026-02" },
      render: (f) => (f.day || (f.start_time_utc ? localTime(f) : browserTime(f.fit_created))) || "–" },
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
    const btn = el.querySelector("#scan");
    if (btn) btn.onclick = async () => {
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

// ---- Router ------------------------------------------------------------------------

// The page header frame sticks right below the top bar, whose height changes when it wraps.
// Banner under the header: Garmin keys refused for 12 h or more (garmin.key_alerts).
// The Windows app only: the newest release (api/update), asked once per page load.
let UPDATE = null, LAST_ALERTS = null;
function renderAlerts(alerts) {
  LAST_ALERTS = alerts;
  const el = document.getElementById("alerts");
  const keys = alerts?.keys || [];
  const lines = [];
  if (keys.length) lines.push(`Garmin stopped accepting the key of ${keys.map((k) => `<b>${esc(k.label)}</b>`).join(", ")}, new activities are not downloaded. <a href="#/settings/data">Paste a new key in Settings › Data sources</a>`);
  if (UPDATE?.available && !location.hash.startsWith("#/settings/general") && location.hash !== "#/settings") lines.push(`Trailbook ${esc(UPDATE.latest)} is available. <a href="#/settings/general">Update in Settings › General</a>`);
  el.hidden = !lines.length;
  el.innerHTML = lines.join("<br>");
}
api("update").then((u) => { if (u.enabled) { UPDATE = u; renderAlerts(LAST_ALERTS); setHeaderHeight(); } }).catch(() => {});

// Release notes (the changelog section): "### Added" headings and "- " lines.
function releaseNotesHtml(md) {
  const out = [];
  let items = [];
  const flush = () => { if (items.length) out.push(`<ul class="plain notes">${items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`); items = []; };
  for (const raw of (md || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#")) { flush(); out.push(`<div class="panel-title">${esc(line.replace(/^#+\s*/, ""))}</div>`); }
    else if (line.startsWith("- ")) items.push(line.slice(2));
    else if (line && items.length) items[items.length - 1] += " " + line;
  }
  flush();
  return out.join("");
}

// Settings › General, Windows app: the version, the newest release and one click to install it.
function updateCardHtml(u) {
  if (!u?.enabled) return "";
  const body = u.available
    ? `<div>${state(`Trailbook ${esc(u.latest)} is available`, "warn")} <span class="hint">You have ${esc(u.current)}.</span></div>
       ${releaseNotesHtml(u.notes)}
       <div class="badges" style="margin-top:12px"><div class="badge-wrap"><button class="badge" data-update-install>Update to ${esc(u.latest)}</button></div></div>`
    : `<div>${u.error ? state("Could not look for updates", "warn") : state(`Trailbook ${esc(u.current)} is up to date`, "ok")}</div>
       <div class="badges" style="margin-top:12px"><div class="badge-wrap"><button class="badge" data-update-check>Check now</button></div></div>`;
  return `<div class="card" data-update-card><h3>Updates</h3>${body}<div data-update-msg style="margin-top:8px"></div></div>`;
}
function bindUpdateCard(el) {
  const card = el.querySelector("[data-update-card]");
  if (!card) return;
  const msg = card.querySelector("[data-update-msg]");
  const check = card.querySelector("[data-update-check]");
  if (check) check.onclick = async () => {
    msg.innerHTML = state("Looking…");
    try { UPDATE = await api("update?check=1"); card.outerHTML = updateCardHtml(UPDATE); bindUpdateCard(el); }
    catch (e) { msg.innerHTML = state(esc(e.message), "bad"); }
  };
  const install = card.querySelector("[data-update-install]");
  if (install) install.onclick = async () => {
    install.closest(".badges").hidden = true;
    msg.innerHTML = state("Downloading the update…");
    try { await api("update", { method: "POST" }); }
    catch (e) { install.closest(".badges").hidden = false; msg.innerHTML = state(esc(e.message), "bad"); return; }
    msg.innerHTML = state("Installing. Trailbook restarts and this page reloads by itself.");
    const from = UPDATE.current;
    const timer = setInterval(async () => {
      const info = await api("info").catch(() => null);
      if (info && info.version !== from) { clearInterval(timer); location.reload(); }
    }, 2000);
  };
}

// Phones (narrow screens): the tabs and the header tools fold into a menu behind the
// hamburger, the page title moves into the top bar, and each page header's badges (filters, options) fold behind an icon at its
// right; the view switch stays visible. On wider screens neither button is shown.
const menuBtn = document.getElementById("menu-btn");
function setMenu(open) {
  document.querySelector("header").classList.toggle("menu-open", open);
  menuBtn.setAttribute("aria-expanded", String(open));
}
menuBtn.onclick = (e) => { e.stopPropagation(); setMenu(!document.querySelector("header").classList.contains("menu-open")); };
// A tap outside the open menu only closes it (it does not also open what lies under it).
document.addEventListener("click", (e) => {
  if (!document.querySelector("header").classList.contains("menu-open") || e.target.closest("#menu-panel, #menu-btn")) return;
  e.preventDefault();
  e.stopPropagation();
  setMenu(false);
}, true);
let headFiltersOpen = false;
// On phones the page title sits in the top bar, between the app icon and the hamburger: a copy
// of the page header's title, kept up to date with it.
const pageTitle = document.getElementById("page-title");
function addHeadFilterButton() {
  const head = view.querySelector(".page-head");
  const title = head?.querySelector(":scope > h2")?.innerHTML ?? "";
  if (pageTitle.innerHTML !== title) pageTitle.innerHTML = title;
  if (!head || head.querySelector(":scope > .head-filters")) return;
  // a view switch wider than the phone scrolls; show its chosen button
  const sw = head.querySelector(":scope > .switch:not([data-fit])"), on = sw?.querySelector(".on");
  if (on && sw.scrollWidth > sw.clientWidth) {
    sw.dataset.fit = "";
    sw.scrollLeft = on.offsetLeft - sw.offsetLeft - (sw.clientWidth - on.offsetWidth) / 2;
  }
  if (!head.querySelector(":scope > .badges > *")) return;
  head.classList.toggle("filters-open", headFiltersOpen);
  const b = document.createElement("button");
  b.className = "icon head-filters";
  b.title = "Filters and options";
  b.setAttribute("aria-label", "Filters and options");
  b.innerHTML = ICON.sliders;
  b.onclick = (e) => { e.stopPropagation(); headFiltersOpen = head.classList.toggle("filters-open"); };
  head.append(b);
}
new MutationObserver(addHeadFilterButton).observe(view, { childList: true, subtree: true });
window.addEventListener("hashchange", () => { headFiltersOpen = false; setMenu(false); });

function setHeaderHeight() {
  document.documentElement.style.setProperty("--header-h", document.querySelector("header").offsetHeight + "px");
}
window.addEventListener("resize", setHeaderHeight, { passive: true });

// The full-screen map look (body.fullmap) goes with the map page itself: switched in the same
// moment the page content is replaced, so neither the page that is left nor the map's
// floating header jumps while the next page loads.
new MutationObserver(() => document.body.classList.toggle("fullmap", Boolean(view.querySelector(":scope > .heat-wrap, :scope > .embed-map"))))
  .observe(view, { childList: true });

let pageLoader = null;
async function route() {
  clearTimeout(timer);
  // A page that takes long (over 0,4 s) shows the cyclist meanwhile; only while the old page is
  // still there (a page that started drawing itself is left alone).
  clearTimeout(pageLoader);
  const shown = view.firstElementChild;
  pageLoader = setTimeout(() => { if (view.firstElementChild === shown) view.innerHTML = `<div class="page-loader">${loaderHtml()}</div>`; }, 400);
  stopObservers();
  disposeMap();
  const [path, query] = (location.hash.slice(1) || "/activities").split("?");
  const params = Object.fromEntries(new URLSearchParams(query || ""));
  const parts = path.split("/").filter(Boolean);
  try {
    TYPES ??= await api("types");
    PERSONS = await api("persons");
    if (parts[0] === "embed") PAIR = null; // a Home Assistant card chooses its own people
    else keepSelection();
    if (parts[0] === "embed") { await renderEmbed(parts[1], params); return; } // a Home Assistant card (hacards.js)
    let section = parts[0] === "activity" || parts[0] === "together" ? "activities" : parts[0] === "segment" ? "segments" : parts[0] || "activities";
    if (section !== LAST_SECTION) { for (const k of Object.keys(TAB)) delete TAB[k]; LAST_SECTION = section; }
    if (UI.person !== CURRENT) {
      UI.data = await api("ui-settings?" + new URLSearchParams({ person: CURRENT || "all" })).catch(() => ({}));
      UI.person = CURRENT;
    }
    // Pages a pair does not have, and those that only make sense for one person.
    const single = section === "fitness" || section === "stats" || section === "wellbeing";
    if (section === "compare" || (PAIR && !PAIR_PAGES.includes(section)) || (CURRENT === "all" && single)) { location.hash = "#/activities"; return; }
    const chosen = PAIR ? PAIR.join(",") : CURRENT !== "all" ? CURRENT : "";
    const who = chosen ? "?" + new URLSearchParams({ person: chosen }) : "";
    let alerts;
    [TYPE_COUNTS, TIME_RANGE, alerts] = await Promise.all([api("types/counts" + who), api("time-range" + who).catch(timeRangeFallback), api("garmin/alerts").catch(() => null)]);
    renderHeader(section);
    renderAlerts(alerts);
    setHeaderHeight();
    if (parts[0] === "activity") await renderActivity(parts[1]);
    else if (parts[0] === "together") await renderTogether(parts[1], parts[2]);
    else if (parts[0] === "segment") await renderSegment(parts[1], params);
    else if (section === "segments" && parts[1] === "new") await (parts[2] === "map" ? renderSegmentFromMap(params) : renderSegmentFromActivity(params));
    else if (section === "segments") await renderSegments(params);
    else if (section === "settings") await renderSettings(parts[1], params);
    else if (section === "ha") await renderHa(parts[1], params);
    else if (section === "manual") await renderManual(parts[1]);
    else if (section === "heatmap") await renderHeatmap(params);
    else if (section === "calendar") await renderCalendar(params);
    else if (section === "fitness") await renderFitness(params);
    else if (section === "stats") await renderStats(params);
    else if (section === "wellbeing") await renderWellbeing(parts[1], params);
    else if (PLANNED[section]) renderPlanned(section);
    else await renderActivities(params);
    // The back button matches the page header's height.
    const head = view.querySelector(".page-head");
    if (head) document.documentElement.style.setProperty("--head-h", head.offsetHeight + "px");
  } catch (e) {
    view.innerHTML = `<div class="card">${state("Error: " + esc(e.message), "bad")}</div>`;
  } finally {
    clearTimeout(pageLoader);
  }
}

applyAccent();
window.addEventListener("hashchange", route);
// On an activity the arrow keys press the header buttons: ← the left one (Next, newer),
// → the right one (Previous, older). Not while typing or with a modifier key.
document.addEventListener("keydown", (e) => {
  if (!["ArrowLeft", "ArrowRight"].includes(e.key) || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (!/^#\/(activity|together)\//.test(location.hash) || e.target.closest?.("input, textarea, select, [contenteditable=true], .maplibregl-map")) return;
  const label = e.key === "ArrowLeft" ? "Next" : "Previous";
  const b = [...view.querySelectorAll(".page-head .switch button[data-go]")].find((x) => x.textContent.trim() === label);
  if (b) { e.preventDefault(); location.hash = b.dataset.go; }
});
// Pages in training.js are loaded after this file; start once every script is in.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", route);
else route();
