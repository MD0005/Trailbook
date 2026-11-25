"use strict";
// Training pages: Calendar, Fitness (load, CTL / ATL / TSB), Statistics (totals, records)
// and the per-person thresholds card in Settings › People. Uses the helpers of preview.js.

// ---- shared -----------------------------------------------------------------------------

const DAY_MS = 86400000;
const isoDay = (d) => d.toISOString().slice(0, 10);
const parseDay = (s) => new Date(s + "T00:00:00Z");
const addDays = (s, n) => isoDay(new Date(parseDay(s).getTime() + n * DAY_MS));
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const mondayOf = (s) => addDays(s, -((parseDay(s).getUTCDay() + 6) % 7));
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const loadUnit = (v) => (v == null ? "–" : num(v)); // load has no unit: one hour at threshold = 100
const shortDist = (m) => (m == null || m < 50 ? "" : m >= 10000 ? `${num(m / 1000, 0)} km` : `${num(m / 1000, 1)} km`);
const shortDur = (s) => {
  if (!s) return "";
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, "0")} h` : `${m} min`;
};
const personParam = () => (CURRENT && CURRENT !== "all" ? { person: CURRENT } : {});

const ICON_CAL_MONTH = svg(`<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/><path d="M7 13h2M11 13h2M15 13h2M7 17h2M11 17h2"/>`);
const ICON_CAL_YEAR = svg(`<rect x="3" y="3" width="5" height="5" rx="1"/><rect x="10" y="3" width="5" height="5" rx="1"/><rect x="17" y="3" width="4" height="5" rx="1"/><rect x="3" y="10" width="5" height="5" rx="1"/><rect x="10" y="10" width="5" height="5" rx="1"/><rect x="17" y="10" width="4" height="5" rx="1"/><rect x="3" y="17" width="5" height="4" rx="1"/><rect x="10" y="17" width="5" height="4" rx="1"/>`);
const ICON_YEARS = svg(`<path d="M3 19h18"/><path d="M4 16c3-5 6-7 9-7s5 2 7 3"/><path d="M4 12c3-4 6-6 9-6s5 1 7 2" opacity=".5"/>`);
const ICON_TIMELINE = svg(`<path d="M3 19h18"/><path d="M4 17l4-5 4 2 4-6 4 3"/>`);
const ICON_RECORDS = svg(`<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3a3 3 0 0 1-3 4M7 5H4a3 3 0 0 0 3 4"/>`);

// ---- Calendar ---------------------------------------------------------------------------

// Weeks run down the page, the newest on top (Mon–Sun and the week's totals); older weeks
// load while scrolling down and, after Go to, newer ones while scrolling up. The top week is
// always a whole week ahead (one after the last planned workout).
// Each day: its number with the day's steps, floors (else ascent) and average stress (the
// watch's monitoring files, the whole day); days without them from today on: the day length
// and the forecast at the start of the latest activity. Activities: a header (type, distance,
// training type) over the small chart of Activities › Charts.
const CAL_BATCH = 6; // weeks per load
const calIcon = (body, color) => `<svg class="cal-ic" viewBox="0 0 24 24" style="color:var(${color})" aria-hidden="true">${body}</svg>`;
const CAL_ICONS = {
  steps: () => metricIcon("steps", 12),
  ascent: () => metricIcon("total_ascent", 12),
  // stairs going up
  floors: () => calIcon(`<path d="M2.5 21h7v-6h6V9h6" ${iconLine(2.6)}/><path d="M3 12.5 10.5 5M7 5h3.5v3.5" ${iconLine(2)}/>`, "--m-elev"),
  // a jagged line in a circle
  stress: () => calIcon(`<circle cx="12" cy="12" r="9" ${iconLine()}/><path d="M6.5 13.5 9 9.5l2.5 5 2.5-6 3.5 4.5" ${iconLine(1.9)}/>`, "--m-stress"),
  // the sun on the horizon, rays above
  daylight: () => calIcon(`<path d="M2.5 19h19M6.5 19a5.5 5.5 0 0 1 11 0" ${iconLine()}/><path d="M12 4.5v3M5.2 7.6l2 2M18.8 7.6l-2 2M2.8 13.5h2.4M18.8 13.5h2.4" ${iconLine(1.9)}/>`, "--m-sleep"),
};
// Day length (sunrise to sunset) at a latitude, in seconds: the sun's declination of the day
// and a sun 0.833° below the horizon at sunrise and sunset (refraction and its radius).
function dayLength(lat, iso) {
  const d = parseDay(iso), n = Math.round((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY_MS) + 1;
  const rad = Math.PI / 180;
  const decl = -23.44 * rad * Math.cos(((2 * Math.PI) / 365) * (n + 10));
  const cosH = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(decl)) / (Math.cos(lat * rad) * Math.cos(decl));
  if (cosH <= -1) return 86400;
  if (cosH >= 1) return 0;
  return ((2 * Math.acos(cosH)) / rad / 15) * 3600;
}
// The day's forecast as part of the day's line, in the style of the map's weather: sky,
// lowest–highest temperature, rain, wind arrow and speed. A narrow day drops the rain, then
// the wind unit, then the wind (CSS container queries); the tooltip has everything.
function calWeather(w) {
  const sky = WMO.find(([max]) => (w.code ?? 0) <= max) || WMO[WMO.length - 1];
  const deg = (t) => Math.round(t) || 0; // whole degrees, no "-0"
  const from = w.wind_dir != null ? COMPASS[Math.round(w.wind_dir / 45) % 8] : "";
  const rain = w.precip >= 0.1 ? `${num(w.precip, 1)} mm` : "";
  const tip = `Forecast: ${sky[1].toLowerCase()}, ${deg(w.temp_min)} to ${deg(w.temp_max)} °C${rain ? `, ${rain} of rain` : ""}${w.wind_speed != null ? `, wind up to ${num(w.wind_speed)} km/h from the ${from}` : ""}. Open-Meteo, for the start of the latest activity.`;
  return `<span class="cal-wx" data-tip="${esc(tip)}"><svg class="wx-sky" viewBox="0 0 24 24" fill="none" aria-label="${sky[1]}">${SKY_SVG[sky[2]]}</svg><span>${deg(w.temp_min)}–${deg(w.temp_max)}°</span>${rain ? `<span class="cal-rain">${rain}</span>` : ""}${w.wind_speed != null ? `<span class="cal-wind"><svg viewBox="0 0 24 24" style="transform:rotate(${(w.wind_dir ?? 0) + 180}deg)"><path d="M12 3v16M12 3l-4.5 5M12 3l4.5 5" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>${num(w.wind_speed)}<span class="cal-unit">&nbsp;km/h</span></span>` : ""}</span>`;
}
const hm = (s) => { const m = Math.round(s / 60); return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`; };
const hmShort = (s) => { const m = Math.round(s / 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };

let CAL_FORECAST = null; // {key, at, data}: forecast of the person, kept for 30 minutes
async function calForecast() {
  const key = CURRENT;
  if (CAL_FORECAST?.key === key && Date.now() - CAL_FORECAST.at < 30 * 60000) return CAL_FORECAST.data;
  const data = await api("forecast?" + new URLSearchParams(personParam())).catch(() => ({ lat: null, days: [] }));
  CAL_FORECAST = { key, at: Date.now(), data };
  return data;
}
// Sports whose headline is the distance (also indoors: treadmill, trainer, pool); the others
// (games, gym, yoga, climbing…) show their time, whatever distance the watch wrote.
const DISTANCE_GROUPS = new Set(["run", "ride", "swim", "walk", "hike", "winter", "water", "multisport"]);
const CAL_MONTHS = new Map(); // "<person> <yyyy-mm>" -> month data (activities, days)

// Weekly targets of the person (Calendar › Targets; ui_settings `week-targets`): activities a
// week, time a week per sport group (s), steps and floors a day. Empty = no target.
const weekTargets = () => UI.data["week-targets"] || {};
const TARGET_SPORTS = ["run", "ride", "swim", "walk", "hike", "fitness", "winter", "water"];
// Targets are set with − / + steps, no typing: time by 30 min, steps by 500,
// floors by 5; an empty field = no target (− at the first step clears it).
const TARGET_STEPS = { time: [1800, 40 * 3600], steps: [500, 40000], floors: [5, 200] };
const targetText = (kind, v) => {
  if (!v) return ""; // no target: an empty field
  if (kind !== "time") return num(v);
  const h = Math.floor(v / 3600), m = Math.round((v % 3600) / 60);
  return h ? (m ? `${h}h ${String(m).padStart(2, "0")}min` : `${h}h`) : `${m}min`; // as dur()
};
function targetsPanel() {
  const T = weekTargets();
  // the person's sports first (by their activities), then the rest of the usual ones
  const counts = {};
  for (const [k, n] of Object.entries(TYPE_COUNTS || {})) {
    const g = TYPES.types.find((t) => t.key === k)?.group;
    if (g) counts[g] = (counts[g] || 0) + n;
  }
  const groups = [...new Set([...Object.keys(counts).sort((a, b) => counts[b] - counts[a]), ...TARGET_SPORTS])]
    .filter((g) => !["other", "multisport"].includes(g)).slice(0, 8);
  const stepper = (key, kind, v) => `<span class="stepper ${v ? "set" : ""}" data-tkey="${key}" data-tkind="${kind}">
      <button type="button" data-tstep="-1" aria-label="Less">−</button><input type="text" class="stepper-val" data-tval value="${targetText(kind, v)}" spellcheck="false" aria-label="Target"><button type="button" data-tstep="1" aria-label="More">+</button></span>`;
  const line = (label, control) => `<div class="target-row"><span class="opt-label">${label}</span>${control}</div>`;
  return `<div class="panel-title">Weekly targets</div>
    ${groups.map((g) => line(`${groupIcon(g, 14)}${esc(groupLabel(g))}`, stepper(`sport:${g}`, "time", T.sports?.[g]))).join("")}
    <div class="panel-title targets-daily">Daily targets</div>
    ${line("Steps", stepper("steps", "steps", T.steps))}
    ${line("Floors", stepper("floors", "floors", T.floors))}`;
}
// a typed target: time as "2:30", "2h 30min", "2h" or minutes ("150"); counts as numbers
function parseTarget(kind, text) {
  const t = String(text).trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) return 0;
  if (kind !== "time") { const v = Math.round(+t.replace(/\s|\u202f/g, "").replace(",", ".")); return Number.isFinite(v) && v > 0 ? v : null; }
  let m = t.match(/^(\d+):(\d{1,2})$/);
  if (m) return (+m[1] * 60 + +m[2]) * 60;
  m = t.match(/^(?:(\d+(?:[.,]\d+)?) ?h)? ?(?:(\d+) ?m(?:in)?)?$/);
  if (m && (m[1] || m[2])) return Math.round((parseFloat((m[1] || "0").replace(",", ".")) * 60 + +(m[2] || 0)) * 60);
  m = t.match(/^(\d+)$/);
  return m ? +m[1] * 60 : null;
}
// one step of a target (or a typed value); returns the new targets
function stepTarget(key, kind, dir, typed = null) {
  const T = structuredClone(weekTargets());
  T.sports ||= {};
  const [step, max] = TARGET_STEPS[kind];
  const cur = key.startsWith("sport:") ? T.sports[key.slice(6)] || 0 : T[key] || 0;
  const v = typed != null ? Math.max(0, Math.min(max, typed)) : Math.max(0, Math.min(max, (Math.round(cur / step) + dir) * step));
  if (key.startsWith("sport:")) { if (v) T.sports[key.slice(6)] = v; else delete T.sports[key.slice(6)]; }
  else if (v) T[key] = v; else delete T[key];
  return T;
}

// `embed` (a Home Assistant card, hacards.js): only `weeks` weeks up to this one (and the next
// with `ahead`), without the page's header, panels and loading more.
async function renderCalendar(params, embed = null) {
  const mode = params.view === "year" && !embed ? "year" : "month";
  if (mode === "year") return renderCalendarYear(params);
  const today = todayIso();
  // always one whole week ahead, and one after the last planned workout
  let newest = addDays(mondayOf(today), embed && !embed.ahead ? 0 : 7);
  const first = TIME_RANGE.first && TIME_RANGE.first < today ? TIME_RANGE.first : today;
  const oldest = embed ? addDays(mondayOf(today), -7 * (embed.weeks - 1)) : mondayOf(first);
  const target = /^\d{4}-\d{2}-\d{2}$/.test(params.date || "") && !embed ? params.date : null;
  const anchor = target ? mondayOf(target < first ? first : target > today ? today : target) : null;
  let top = anchor ? [addDays(anchor, 14), newest].sort()[0] : newest;
  let bottom = [anchor ? addDays(anchor, -21) : addDays(newest, -7 * (CAL_BATCH - 1)), oldest].sort().reverse()[0];
  const isAll = CURRENT === "all";
  CAL_MONTHS.clear(); // data may have changed since the last visit

  const fetchWeeks = (a, b) => api("calendar?" + new URLSearchParams({ from: a, to: addDays(b, 6), chart: "1", planned: "1", ...personParam() }));
  const [data, fc] = await Promise.all([fetchWeeks(bottom, top), calForecast()]);
  if (!embed && data.last_planned && addDays(mondayOf(data.last_planned), 7) > newest) {
    const later = addDays(mondayOf(data.last_planned), 7);
    if (!anchor) {
      const more = await fetchWeeks(addDays(top, 7), later);
      data.activities.push(...more.activities);
      data.planned.push(...more.planned);
      Object.assign(data.days, more.days || {});
      top = later;
    }
    newest = later;
  }
  const wx = Object.fromEntries((fc.days || []).map((d) => [d.date, d]));

  const card = (a, plan) => {
    const kind = workoutOf(a) ? workoutLabel(workoutOf(a)) : "";
    const chart = a.tile_chart ? tileChart(a.tile_chart) : "";
    return `<a class="cal-act" href="#/activity/${a.id}" title="${esc(a.name || typeLabel(a.activity_type))} · ${esc(typeLabel(a.activity_type))}${isAll ? " · " + esc(personLabel(a.person_id)) : ""}">
      <span class="cal-act-head">${isAll ? `<span class="cal-dot" style="background:${personColor(person(a.person_id))}"></span>` : ""}${typeIcon(a.activity_type, 16)}
        <span class="cal-act-text">${esc((DISTANCE_GROUPS.has(a.category) && shortDist(a.distance_m)) || shortDur(a.time_s))}</span>${plan ? plannedFlag(plan) : ""}${kind ? `<span class="cal-kind">${esc(kind)}</span>` : ""}</span>
      ${chart.startsWith("<svg") ? `<span class="cal-act-chart">${chart}${factsPill(a)}</span>` : `<span class="cal-act-chart" title="${esc(actFacts(a))}"><span class="tile-sport">${typeIcon(a.activity_type, 26)}</span></span>`}</a>`;
  };
  // Hovering the bar chart: its values in the middle on a soft pill (as the values over the
  // activity charts), one line, without the one the card's header shows (distance or time); a
  // narrow day drops the load.
  const factsPill = (a) => {
    const head = DISTANCE_GROUPS.has(a.category) && shortDist(a.distance_m) ? "distance" : "time";
    const f = factList(a).filter(([k]) => k !== head);
    return f.length ? `<span class="cal-facts">${f.map(([k, v]) => `<span class="cal-f-${k}">${esc(v).replace(/ /g, "&nbsp;")}</span>`).join("")}</span>` : "";
  };
  // The chart's values: distance, time, pace (on foot) or power / speed (rides), load.
  const factList = (a) => {
    const foot = ["run", "walk", "hike"].includes(a.category);
    const speed = a.distance_m && a.time_s ? a.distance_m / a.time_s : a.avg_speed;
    return [["distance", a.distance_m >= 50 ? km(a.distance_m) : ""], ["time", a.time_s ? durMin(a.time_s) : ""],
      ["speed", foot && speed ? pace(speed) : !foot && a.avg_power ? watts(a.avg_power) : !foot && speed && a.distance_m ? unit(speed * 3.6, "km/h", 1) : ""],
      ["load", a.load ? `load ${num(a.load)}` : ""]].filter(([, v]) => v);
  };
  const actFacts = (a) => factList(a).map(([, v]) => v).join(" · ");
  // One line each: in a narrow day the long forms give way to short ones (CSS container
  // queries: `full` / `short`), the full values stay in the tooltip.
  const both = (full, short) => `<span class="cal-full">${full}</span><span class="cal-short">${short}</span>`;
  // The day's line: its number, then its values (steps, floors, stress); days from today on
  // without values: day length and the forecast on the same line.
  const dayHead = (d, v) => {
    const parts = [];
    let weather = "";
    const k = (n) => (n < 10000 ? `${num(n / 1000, 1)}k` : `${num(n / 1000, 0)}k`);
    if (d === today) v = null; // today: the day is not over, only the forecast (as the coming days)
    if (v?.steps != null) parts.push(`<span class="cal-m cal-steps" title="${num(v.steps)} steps">${CAL_ICONS.steps()}${both(num(v.steps), k(v.steps))}</span>`);
    if (v?.floors != null) parts.push(`<span class="cal-m cal-floors" title="${num(v.floors)} floors climbed">${CAL_ICONS.floors()}${num(v.floors)}</span>`);
    else if (v?.ascent_m != null) parts.push(`<span class="cal-m cal-floors" title="${meters(v.ascent_m)} ascent">${CAL_ICONS.ascent()}${both(meters(v.ascent_m), num(v.ascent_m, 0))}</span>`);
    if (v?.stress != null) parts.push(`<span class="cal-m cal-stress" title="Average stress ${num(v.stress)}">${CAL_ICONS.stress()}${num(v.stress)}</span>`);
    if (!parts.length && d >= today) {
      if (fc.lat != null) {
        const s = dayLength(fc.lat, d);
        parts.push(`<span class="cal-m cal-daylight" title="Day length ${hm(s)}">${CAL_ICONS.daylight()}${hmShort(s)}</span>`);
      }
      if (wx[d]) parts.push(calWeather(wx[d]));
    } else if (d >= today && wx[d]) weather = `<div class="cal-dh">${calWeather(wx[d])}</div>`; // today with values
    const label = d.slice(8) === "01" ? both(`1 ${MONTHS[+d.slice(5, 7) - 1].slice(0, 3)}`, "1") : +d.slice(8);
    const wd = WEEKDAYS[(parseDay(d).getUTCDay() + 6) % 7]; // shown on phones only (one day a row)
    return `<div class="cal-dh"><span class="cal-wd">${wd}</span><span class="cal-num">${label}</span>${parts.join("")}</div>${weather}`;
  };
  // A planned workout of a day up to today goes with an activity of its sport that day (the
  // activity shows that it was planned); one without an activity is hidden once the day is over.
  // header: the sync icon right after the time; on hover edit (this entry only) and remove
  const planCard = (p) => (PLAN_ITEMS.set(p.id, p), planCardHtml(p, {
    attrs: `draggable="${p.day >= today}" data-plan="${p.id}"`, badge: planSyncIcon(p),
    extra: `<span class="wo-tools">${p.day >= today ? `<button class="icon" data-plan-edit="${p.id}" title="Edit this planned workout" aria-label="Edit this planned workout">${ICON.pencil}</button>` : ""}
      <button class="icon delete" data-plan-del="${p.id}" title="Remove from the plan" aria-label="Remove from the plan">${ICON.trash}</button></span>` }));
  const weekHtml = (w, byDay, days, plans = {}) => {
    const wdays = [...Array(7)].map((_, i) => addDays(w, i));
    const wacts = wdays.flatMap((d) => byDay[d] || []);
    const shown = {}, matched = new Map();
    for (const d of wdays) {
      const free = [...(byDay[d] || [])];
      for (const p of plans[d] || []) {
        const i = d <= today ? free.findIndex((a) => a.category === p.sport) : -1;
        if (i >= 0) matched.set(free.splice(i, 1)[0].id, p);
        else if (d >= today) (shown[d] ||= []).push(p);
      }
    }
    const wplans = wdays.flatMap((d) => plans[d] || []);
    const wopen = wdays.flatMap((d) => shown[d] || []);
    const ws = (k) => wacts.reduce((s, a) => s + (a[k] || 0), 0);
    // ISO week: the week of its Thursday's year; shown in the left margin on wide screens
    const thu = addDays(w, 3), wk = Math.floor((parseDay(thu) - parseDay(thu.slice(0, 4) + "-01-01")) / (7 * DAY_MS)) + 1;
    return `<div class="cal-row" data-week="${w}"><div class="cal-wk" aria-hidden="true"><b>W${wk}</b><span>${thu.slice(0, 4)}</span></div>${wdays.map((d, i) => {
      const m = +d.slice(5, 7);
      return `<div class="cal-day ${m % 2 ? "odd" : ""} ${i >= 5 ? "weekend" : ""} ${d === today ? "today" : ""} ${d > today ? "future" : ""} ${d === target ? "target" : ""}" data-day="${d}">
          ${dayHead(d, days[d])}${(byDay[d] || []).map((a) => card(a, matched.get(a.id))).join("")}${(shown[d] || []).map(planCard).join("")}</div>`;
    }).join("")}${weekSummary(wdays, wacts, days, ws, wplans, wopen)}</div>`;
  };
  // The week on the right, as plain text beside the days (no rule, not another day): distance, time
  // and load; the activities with a dot per day (filled = active); time per sport with a bar
  // of its share; the watch's steps, floors and average stress of the week.
  // The week on the right. Targets (Calendar › Targets, per person): time a
  // week per sport, steps and floors a day — a target is a bar of how much is done (accent)
  // and, with planned workouts, how much the plan adds (plan colour); without a target only
  // the value. Planned weeks show the same, their planned sums in the plan colour.
  const weekSummary = (wdays, wacts, days, ws, wplans = [], wopen = []) => {
    const T = weekTargets();
    const life = wdays.map((d) => days[d]).filter(Boolean);
    if (!wacts.length && !life.length && !wplans.length) return `<div class="cal-week empty"></div>`;
    const lines = [];
    const psum = (list, k) => list.reduce((x, p) => x + (p.estimate[k] || 0), 0);
    // a target bar: done (accent), then what the plan adds (plan colour); past the target red
    const bar = (done, plan, goal) => {
      const d = Math.min(100, (done / goal) * 100), q = Math.min(100 - d, (plan / goal) * 100);
      return `<span class="cw-bar"><i class="${done > goal ? "over" : ""}" style="width:${d}%"></i>${q > 0 ? `<b class="${done + plan > goal ? "over" : ""}" style="width:${q}%"></b>` : ""}</span>`;
    };
    // its tooltip: done, planned, target and how much of it is done (with the plan)
    const goalTip = (label, done, plan, goal, fmt) => `${label}: ${fmt(done)} done${plan ? `, ${fmt(plan)} planned` : ""}, target ${fmt(goal)} · ${num((done / goal) * 100)} %${plan ? ` (${num(((done + plan) / goal) * 100)} % with the plan)` : ""}`;
    const ahead = !wacts.length && wplans.length && wdays[6] >= today;
    if (ahead) { // the same lines as a week done, from the plan's estimates
      const pd = psum(wopen, "distance_m"), pt = psum(wopen, "duration_s");
      lines.push(`<div class="cw-big cw-planned" title="Planned (estimate)"><b>${pd >= 50 ? `≈ ${km(pd)}` : shortDur(pt)}</b></div>`);
      lines.push(`<div class="cw-line cw-planned">${[pd >= 50 ? shortDur(pt) : "", `load ≈ ${num(psum(wopen, "load"))}`].filter(Boolean).join(" · ")}</div>`);
    } else if (wacts.length) {
      const dist = ws("distance_m"), time = ws("time_s"), load = ws("load");
      lines.push(`<div class="cw-big">${dist >= 50 ? `<b>${km(dist)}</b>` : `<b>${shortDur(time)}</b>`}</div>`);
      lines.push(`<div class="cw-line">${[dist >= 50 ? shortDur(time) : "", load ? `load ${num(load)}` : ""].filter(Boolean).join(" · ")}</div>`);
    }
    // activities: done and planned, a dot per day (planned days in the plan colour)
    const active = new Set(wacts.map((a) => a.day)), plannedDays = new Set(wopen.map((p) => p.day));
    const count = wacts.length + wopen.length;
    if (count) {
      lines.push(`<div class="cw-line" title="${num(wacts.length)} done${wopen.length ? `, ${num(wopen.length)} planned` : ""}"><span class="cw-n ${wacts.length ? "" : "cw-planned"}">${num(count)}<span class="cw-word"> ${count === 1 ? "activity" : "activities"}</span></span>
        <span class="cw-dots">${wdays.map((d) => `<i class="${active.has(d) ? "on" : plannedDays.has(d) ? "plan" : ""}"></i>`).join("")}</span></div>`);
    }
    // time per sport: with a target a bar; the others only their time, side by side
    const done = {}, planned = {};
    for (const a of wacts) done[a.category] = (done[a.category] || 0) + (a.time_s || 0);
    for (const p of wopen) planned[p.sport] = (planned[p.sport] || 0) + p.estimate.duration_s;
    const goals = Object.keys(T.sports || {}).filter((g) => T.sports[g] > 0);
    const rows = goals.map((g) => `<div class="cw-sport" title="${esc(goalTip(groupLabel(g), done[g] || 0, planned[g] || 0, T.sports[g], durMin))}">${groupIcon(g, 13)}
        ${bar(done[g] || 0, planned[g] || 0, T.sports[g])}<span class="cw-val">${done[g] ? shortDur(done[g]) : planned[g] ? `<span class="cw-planned">${shortDur(planned[g])}</span>` : ""}</span></div>`);
    const free = [...new Set([...Object.keys(done), ...Object.keys(planned)])].filter((g) => !goals.includes(g))
      .sort((a, b) => (done[b] || 0) + (planned[b] || 0) - (done[a] || 0) - (planned[a] || 0));
    if (rows.length) lines.push(`<div class="cw-sports">${rows.join("")}</div>`);
    if (free.length) lines.push(`<div class="cw-free">${free.map((g) => `<span class="cw-f" title="${esc(groupLabel(g))}: ${dur(done[g] || 0)}${planned[g] ? ` + ${dur(planned[g])} planned` : ""}">${groupIcon(g, 13)}${done[g] ? shortDur(done[g]) : ""}${planned[g] ? `<span class="cw-planned">${done[g] ? "+" : ""}${shortDur(planned[g])}</span>` : ""}</span>`).join("")}</div>`);
    if (!wacts.length && !wplans.length) lines.push(`<div class="cw-line hint">No activities</div>`);
    // steps and floors (a day on average): with a target a bar, else a compact value
    const sum = (k) => life.reduce((x, v) => x + (v[k] || 0), 0);
    const daysWith = (k) => life.filter((v) => v[k] != null).length;
    const avg = (k) => (daysWith(k) ? sum(k) / daysWith(k) : null);
    const parts = [], goalRows = [];
    const steps = avg("steps"), floors = avg("floors");
    if (steps != null) {
      if (T.steps) goalRows.push(`<div class="cw-sport" title="${esc(goalTip("Steps a day", Math.round(steps), 0, T.steps, num))}">${CAL_ICONS.steps()}${bar(steps, 0, T.steps)}<span class="cw-val">${num(steps / 1000, 1)}k</span></div>`);
      else parts.push(`<span class="cal-m cal-steps" title="${num(sum("steps"))} steps, ${num(steps, 0)} a day">${CAL_ICONS.steps()}${num(sum("steps") / 1000, 0)}k</span>`);
    }
    if (floors != null) {
      if (T.floors) goalRows.push(`<div class="cw-sport" title="${esc(goalTip("Floors a day", Math.round(floors), 0, T.floors, num))}">${CAL_ICONS.floors()}${bar(floors, 0, T.floors)}<span class="cw-val">${num(floors, 0)}</span></div>`);
      else parts.push(`<span class="cal-m cal-floors" title="${num(sum("floors"))} floors climbed">${CAL_ICONS.floors()}${num(sum("floors"))}</span>`);
    }
    if (life.some((v) => v.stress != null)) {
      const st = life.filter((v) => v.stress != null);
      parts.push(`<span class="cal-m cal-stress" title="Average stress of the days">${CAL_ICONS.stress()}${num(st.reduce((x, v) => x + v.stress, 0) / st.length, 0)}</span>`);
    }
    if (goalRows.length || parts.length) lines.push(`<div class="cw-life">${goalRows.length ? `<div class="cw-sports">${goalRows.join("")}</div>` : ""}${parts.length ? `<div class="cw-free">${parts.join("")}</div>` : ""}</div>`);
    return `<div class="cal-week ${ahead ? "planned" : ""}">${lines.join("")}</div>`;
  };
  // weeks a..b (Mondays) of one load, the newest first
  const rowsHtml = (a, b, d) => {
    const byDay = {}, plans = {};
    for (const x of d.activities) (byDay[x.day] ||= []).push(x);
    for (const p of d.planned || []) (plans[p.day] ||= []).push(p);
    const out = [];
    for (let w = b; w >= a; w = addDays(w, -7)) out.push(weekHtml(w, byDay, d.days || {}, plans));
    return out.join("");
  };

  if (embed) {
    view.innerHTML = `<div class="embed-cal${embed.summary ? "" : " no-week"}"><div class="cal-heads">${WEEKDAYS.map((w) => `<div class="cal-head">${w}</div>`).join("")}<div class="cal-head"></div></div>
      <div class="cal-card"><div class="cal-weeks" data-weeks>${rowsHtml(bottom, top, data)}</div></div></div>`;
    return;
  }
  const showSummary = TAB.kpis ?? false;
  const single = !isAll && CURRENT;
  const showTray = single && (TAB.workouts ?? false);
  const showNext = single && (TAB.next ?? false);
  const sw = switchHtml("calview", [["month", `${ICON_CAL_MONTH}<span>Weeks</span>`], ["year", `${ICON_CAL_YEAR}<span>Year</span>`]], mode);
  view.innerHTML = `${pageHead("Calendar", `${gotoBadge(target)}${single ? `${badgeHtml("ctargets", "Targets", "", { panel: `<div class="opt-panel targets-panel" data-targets></div>` })}<button class="badge ${showTray ? "on" : ""}" data-cworkouts>Plan workouts</button><button class="badge ${showNext ? "on" : ""}" data-cnext-toggle>Next workout</button>` : ""}<button class="badge ${showSummary ? "on" : ""}" data-ckpis>Summary</button>`, sw)}
    <div class="cal-summary" data-csummary ${showSummary ? "" : "hidden"}></div>
    <div class="cal-top">
      <div data-cnext ${showNext ? "" : "hidden"}></div>
      <div data-ctray ${showTray ? "" : "hidden"}></div>
    </div>
    <div class="cal-sticky" data-csticky>
      <div class="cal-heads">${WEEKDAYS.map((w) => `<div class="cal-head">${w}</div>`).join("")}<div class="cal-head"></div></div>
    </div>
    <div class="card cal-card">
      ${top < newest ? `<div class="sentinel" data-csentinel="up">${loaderHtml()}</div>` : ""}
      <div class="cal-weeks" data-weeks>${rowsHtml(bottom, top, data)}</div>
      ${bottom > oldest ? `<div class="sentinel" data-csentinel="down">${loaderHtml()}</div>` : ""}
    </div>`;
  bindBadges(view.querySelector(".page-head"));
  bindGotoPanel(view, (d) => {
    const next = d >= today ? "#/calendar" : "#/calendar?" + new URLSearchParams({ date: d });
    if (location.hash === next) { document.onclick?.(); window.scrollTo({ top: 0 }); } else location.hash = next;
  });
  view.querySelectorAll("[data-switch=calview]").forEach((b) => b.onclick = () => {
    location.hash = "#/calendar?" + new URLSearchParams(b.dataset.value === "year" ? { view: "year", year: (target || today).slice(0, 4) } : {});
  });

  // The summary (wider than a phone) and the weekday names under it stay under the page header,
  // so other months' summaries can be read while scrolling; Next workout and the workouts scroll
  // away. The summary is the month of the first week row under the weekday names (its
  // Thursday's month).
  const sticky = view.querySelector("[data-csticky]"), weeks = view.querySelector("[data-weeks]");
  const head = view.querySelector(".page-head"), sumBox = view.querySelector("[data-csummary]");
  const placeSticky = () => {
    // right under the page header: their own background (padding) fills the space, so nothing
    // scrolling shows between them
    const top = parseFloat(getComputedStyle(head).top) + head.getBoundingClientRect().height;
    sumBox.style.top = `${top}px`;
    const stuck = !sumBox.hidden && getComputedStyle(sumBox).position === "sticky";
    sticky.style.top = `${top + (stuck ? sumBox.getBoundingClientRect().height - 1 : 0)}px`; // 1 px overlap: no hairline
    sticky.style.paddingTop = stuck ? "9px" : ""; // under the summary: the usual 8 px gap (1 px overlapped)
  };
  placeSticky();
  let month = null;
  const activeMonth = () => {
    const edge = sticky.getBoundingClientRect().bottom + 4;
    const row = [...weeks.children].find((r) => r.getBoundingClientRect().bottom > edge) || weeks.lastElementChild;
    const m = row ? addDays(row.dataset.week, 3).slice(0, 7) : today.slice(0, 7);
    return m > today.slice(0, 7) ? today.slice(0, 7) : m; // the weeks ahead belong to this month
  };
  const paintSummary = async () => {
    const box = view.querySelector("[data-csummary]");
    if (!box || box.hidden) return;
    const m = activeMonth();
    if (m === month) return;
    month = m;
    const html = await calMonthSummary(m);
    if (month === m) { box.innerHTML = html; placeSticky(); }
  };
  const onScroll = () => {
    if (!document.body.contains(weeks)) { window.removeEventListener("scroll", onScroll); window.removeEventListener("resize", placeSticky); return; }
    requestAnimationFrame(() => { paintSummary(); paintWeekNumbers(); });
  };
  // week numbers go away under the header at the top and at the bottom edge of the window
  const paintWeekNumbers = () => {
    const topEdge = sticky.getBoundingClientRect().bottom, bottomEdge = innerHeight - 8;
    weeks.querySelectorAll(".cal-wk").forEach((el) => {
      const r = el.getBoundingClientRect();
      el.classList.toggle("off", r.top < topEdge || r.bottom > bottomEdge);
    });
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", placeSticky);
  view.querySelector("[data-ckpis]").onclick = (e) => {
    const on = !e.currentTarget.classList.contains("on");
    TAB.kpis = on;
    e.currentTarget.classList.toggle("on", on);
    view.querySelector("[data-csummary]").hidden = !on;
    month = null;
    placeSticky();
    paintSummary();
    if (on) window.scrollTo({ top: 0, behavior: "smooth" }); // show what was opened
  };
  // Next: the suggested next session (suggest.py), the same frame as the summary
  const nextBox = view.querySelector("[data-cnext]"), nextBtn = view.querySelector("[data-cnext-toggle]");
  const paintNext = () => renderNextPanel(nextBox, today);
  if (showNext) paintNext();
  if (nextBtn) nextBtn.onclick = () => {
    const on = !nextBtn.classList.contains("on");
    TAB.next = on;
    nextBtn.classList.toggle("on", on);
    nextBox.hidden = !on;
    if (on) { paintNext(); window.scrollTo({ top: 0, behavior: "smooth" }); }
  };

  // Workouts: the tray of templates; dropping one on a day plans it (the week is redrawn, and
  // a week is added on top when the newest one gets a plan).
  const trayBox = view.querySelector("[data-ctray]");
  const redrawWeeks = async (changedDays) => {
    for (const w of [...new Set(changedDays.map(mondayOf))]) {
      const row = weeks.querySelector(`[data-week="${w}"]`);
      if (!row) continue;
      row.outerHTML = rowsHtml(w, w, await fetchWeeks(w, w));
      if (w === top && w === newest) {
        const nw = addDays(w, 7);
        weeks.insertAdjacentHTML("afterbegin", rowsHtml(nw, nw, await fetchWeeks(nw, nw)));
        top = newest = nw;
      }
    }
    paintWeekNumbers();
    if (nextBox && !nextBox.hidden) renderNextPanel(nextBox, today); // the plan changed: the suggestion too
  };
  if (single) bindPlanDrops(weeks, redrawWeeks);
  // Targets: typed in the badge's panel, saved per person; the weeks are redrawn
  const tbox = view.querySelector("[data-targets]");
  if (tbox) {
    tbox.innerHTML = targetsPanel();
    let timer = null;
    const apply = (st, dir, typed = null) => {
      const T = stepTarget(st.dataset.tkey, st.dataset.tkind, dir, typed);
      saveUi("week-targets", T);
      const key = st.dataset.tkey, v = key.startsWith("sport:") ? T.sports[key.slice(6)] : T[key];
      st.querySelector("[data-tval]").value = targetText(st.dataset.tkind, v);
      st.classList.toggle("set", !!v);
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const fresh = await fetchWeeks(bottom, top);
        weeks.innerHTML = rowsHtml(bottom, top, fresh);
        paintWeekNumbers();
      }, 500);
    };
    tbox.onclick = (e) => {
      const btn = e.target.closest("[data-tstep]");
      if (btn) apply(btn.closest("[data-tkey]"), +btn.dataset.tstep);
    };
    tbox.onchange = (e) => { // typed: Enter or leaving the field
      const inp = e.target.closest("[data-tval]");
      if (!inp) return;
      const st = inp.closest("[data-tkey]"), v = parseTarget(st.dataset.tkind, inp.value);
      if (v == null) { // not understood: back to what it was
        const T = weekTargets(), key = st.dataset.tkey;
        inp.value = targetText(st.dataset.tkind, key.startsWith("sport:") ? T.sports?.[key.slice(6)] : T[key]);
        return;
      }
      apply(st, 0, v);
    };
    tbox.onkeydown = (e) => { if (e.key === "Enter" && e.target.matches("[data-tval]")) e.target.blur(); };
  }
  if (showTray) renderWorkoutTray(trayBox, redrawWeeks);
  const trayBtn = view.querySelector("[data-cworkouts]");
  if (trayBtn) trayBtn.onclick = () => {
    const on = !trayBtn.classList.contains("on");
    TAB.workouts = on;
    trayBtn.classList.toggle("on", on);
    trayBox.hidden = !on;
    if (on && !trayBox.innerHTML) renderWorkoutTray(trayBox, redrawWeeks);
    if (on) window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // more weeks: older below, newer above (the page keeps its place)
  const more = async (dir, sentinel, obs) => {
    if (dir === "down") {
      const b = addDays(bottom, -7), a = [addDays(bottom, -7 * CAL_BATCH), oldest].sort().reverse()[0];
      const d = await fetchWeeks(a, b);
      weeks.insertAdjacentHTML("beforeend", rowsHtml(a, b, d));
      bottom = a;
      if (bottom <= oldest) { obs.disconnect(); sentinel.remove(); }
    } else {
      const a = addDays(top, 7), b = [addDays(top, 7 * CAL_BATCH), newest].sort()[0];
      const d = await fetchWeeks(a, b);
      // keep the row that was on top where it was (the browser may already have done it)
      const ref = weeks.firstElementChild, y0 = ref.getBoundingClientRect().top;
      weeks.insertAdjacentHTML("afterbegin", rowsHtml(a, b, d));
      window.scrollBy(0, ref.getBoundingClientRect().top - y0);
      top = b;
      if (top >= newest) { obs.disconnect(); sentinel.remove(); }
    }
    paintWeekNumbers();
  };
  view.querySelectorAll("[data-csentinel]").forEach((sentinel) => {
    let busy = false;
    const obs = new IntersectionObserver(async (entries) => {
      if (busy || !entries.some((e) => e.isIntersecting)) return;
      busy = true;
      try { await more(sentinel.dataset.csentinel, sentinel, obs); } finally { busy = false; }
      if (sentinel.isConnected) { obs.unobserve(sentinel); obs.observe(sentinel); } // still visible: load again
    }, { rootMargin: "400px" });
    observers.push(obs);
    // after Go to: start loading upwards only once the target is in place
    if (sentinel.dataset.csentinel === "up") setTimeout(() => obs.observe(sentinel), 300);
    else obs.observe(sentinel);
  });
  await paintSummary(); // its height first, then the place of the target week
  if (target) {
    const el = weeks.querySelector(`[data-week="${anchor}"]`);
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - sticky.getBoundingClientRect().bottom - 8 });
    month = null;
    paintSummary();
  } else window.scrollTo({ top: 0 });
  paintWeekNumbers();
}

// Calendar › Next (docs/MANUAL.md › Next workout): the last 7 days and the plan of the next 7
// split into easy / moderate / hard against the chosen model (per person), the form, and the
// suggested next session with its reasons; notes when the plan pulls away from the model.
// [key, label, colour, what it is without thresholds (Garmin's zones, the backup)]
const NEXT_LEVELS = [["easy", "Easy", "#43a047", "heart rate zones 1–2"], ["moderate", "Moderate", "#f2c200", "heart rate zones 3–4"], ["hard", "Hard", "#e53935", "heart rate zone 5"]];
// with thresholds: the range of each level in bpm (LT1 estimated: Garmin records none); each
// sport split by its own lactate threshold, so with several the bpm per sport
const nextRange = (k, [lt1, lthr], bySport = {}) => {
  const sports = Object.entries(bySport);
  if (sports.length > 1) {
    const per = (f) => sports.map(([g, l]) => `${groupLabel(g).toLowerCase()} ${f(l)}`).join(", ");
    return k === "easy" ? `under the aerobic threshold, 89 % of the lactate threshold: ${per(([a]) => num(a))} bpm`
      : k === "moderate" ? `between the aerobic and the lactate threshold: ${per(([a, b]) => `${num(a)}–${num(b)}`)} bpm`
      : `over the lactate threshold: ${per(([, b]) => num(b))} bpm`;
  }
  if (sports.length) [lt1, lthr] = sports[0][1];
  return k === "easy" ? `under ${num(lt1)} bpm, the aerobic threshold (89 % of the lactate threshold)`
    : k === "moderate" ? `${num(lt1)}–${num(lthr)} bpm, between the aerobic and the lactate threshold` : `over ${num(lthr)} bpm, the lactate threshold`;
};
const NEXT_KIND = { rest: "Rest day", easy: "Easy", long: "Long", tempo: "Tempo", intervals: "Intervals" };
const ICON_NEXT = svg(`<path d="M5 12h12"/><path d="M13 7l5 5-5 5"/><path d="M5 5v14"/>`);
// Form in words: what the zone means for the next session (zones as on Fitness › Form).
const NEXT_FORM_NOTE = { Detraining: "Very fresh: fitness is slipping", Fresh: "Fresh: ready for a hard session",
  Neutral: "Neutral: neither fresh nor tired", Productive: "Tired from training: building fitness", Overreaching: "Very tired: rest first" };
const NEXT_FORM_TIP = "Form now: fitness minus fatigue from the training done (Fitness › Form), planned workouts not counted. Above 0 fresher, below 0 more tired.";
// Under the form: the estimated form after the planned workouts (their estimated loads), the
// day after the last one.
function formAfter(d) {
  if (d.form_after == null) return "";
  const v = `${d.form_after > 0 ? "+" : ""}${num(d.form_after, 0)}`;
  const zone = FORM_ZONES.find(([lo, hi]) => d.form_after >= lo && d.form_after < hi);
  return `<span class="stat-note nx-after" data-tip="${esc(`Estimated form after the planned workouts (to ${d.form_after_day}), from their estimated load; ${zone ? NEXT_FORM_NOTE[zone[2]].toLowerCase() : ""}`)}">Estimated after plan: <b>${v}</b></span>`;
}
// The form as a vertical scale (fresher up, more tired down) over the faint zones: 0 marked
// inside, a solid line at the form now, a dashed one at the estimate after the plan.
const NEXT_FORM_RANGE = [-40, 30];
function formBar(d) {
  const [lo, hi] = NEXT_FORM_RANGE, at = (v) => ((hi - Math.max(lo, Math.min(hi, v))) / (hi - lo)) * 100;
  const bands = FORM_ZONES.map(([a, b, , c]) => `<em style="top:${at(b)}%;bottom:${100 - at(a)}%;background:${c}"></em>`).join("");
  const after = d.form_after == null ? "" : `<s style="top:${at(d.form_after)}%"></s>`;
  return `<span class="nx-vbar" aria-hidden="true"><span class="nx-vbands">${bands}</span><b style="top:${at(0)}%">0</b>${after}<i style="top:${at(d.form)}%"></i></span>`;
}
// Fatigue (ATL) against the limit: a share of the usual load (CTL, the 6-week average). Past
// LIMIT the load rises faster than the body adapts; past HIGH it is excessive. The planned
// workouts hatched on top.
const FATIGUE_LIMIT = 1.3, FATIGUE_HIGH = 1.5, FATIGUE_END = 1.6;
const FATIGUE_LEVELS = [[FATIGUE_LIMIT, "Within your usual load", null], [FATIGUE_HIGH, "High load: monitor recovery", "#f2c200"],
  [Infinity, "Excessive load: reduce training", "#e53935"]]; // null: the fatigue colour (COLORS.atl)
function fatigueItem(d) {
  const f = d.fatigue;
  if (!f) return "";
  if (f.usual < 1) return `<div class="stat-item nx-fatigue"><span class="stat-label">Fatigue</span><span class="stat-value">${num(f.now, 0)}</span><span class="stat-note">No 6-week history yet</span></div>`;
  const limit = f.usual * FATIGUE_LIMIT, end = Math.max(f.usual * FATIGUE_END, f.now, f.after ?? 0), pct = (v) => (v / end) * 100;
  const level = (v) => { const l = FATIGUE_LEVELS.find(([r]) => v / f.usual <= r); return [l[0], l[1], l[2] || COLORS.atl]; };
  const [, note, color] = level(f.now);
  const more = f.after != null && f.after > f.now ? f.after - f.now : 0;
  const tip = `7-day load against your 6-week average. Limit: ${num(FATIGUE_LIMIT, 1)} × the average; over ${num(FATIGUE_HIGH, 1)} × excessive.${more ? " Hatched: after the planned workouts." : ""}`;
  return `<div class="stat-item nx-fatigue" data-tip="${esc(tip)}"><span class="stat-label">Fatigue</span>
    <span class="stat-value">${num(f.now, 0)}<small> · limit ${num(limit, 0)}</small></span>
    <span class="nx-bar"><i style="width:${pct(f.now)}%;background:${color}"></i>${more ? `<b style="width:${pct(more)}%;--c:${level(f.after)[2]}"></b>` : ""}<u style="left:${pct(limit)}%"></u></span>
    <span class="stat-note">${note}</span>${f.after != null ? `<span class="stat-note nx-after">Estimated after plan: <b>${num(f.after, 0)}</b></span>` : ""}</div>`;
}
async function renderNextPanel(box, today) {
  const model = UI.data["training-model"] || "polarized";
  const d = await api("suggest?" + new URLSearchParams({ ...personParam(), today, model })).catch(() => null);
  if (!d || !box.isConnected) return;
  const sumOf = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  const total = sumOf(d.done) + sumOf(d.planned);
  const rows = NEXT_LEVELS.map(([k, label, color, tip]) => {
    const dn = total ? d.done[k] / total : 0, pl = total ? d.planned[k] / total : 0, tg = d.target[k];
    const what = d.limits ? nextRange(k, d.limits, d.limits_by_sport) : tip;
    return `<div class="nx-row" data-tip="${esc(`${label} (${what}): ${hm(d.done[k])} done${d.planned[k] ? `, ${hm(d.planned[k])} planned` : ""} · the model asks ${num(tg * 100)} %`)}">
      <span class="nx-label">${label}</span><span class="nx-bar"><i style="width:${dn * 100}%;background:${color}"></i><b style="width:${pl * 100}%;--c:${color}"></b><u style="left:${tg * 100}%"></u></span>
      <span class="nx-val">${num((dn + pl) * 100)}%<small> / ${num(tg * 100)}%</small></span></div>`;
  }).join("");
  const n = d.next, when = n.day === today ? "Today" : "Tomorrow";
  const what = n.kind === "rest" ? NEXT_KIND.rest : `${NEXT_KIND[n.kind]}${n.sport ? ` ${groupLabel(n.sport).toLowerCase()}` : ""}`;
  const zone = d.form == null ? null : FORM_ZONES.find(([lo, hi]) => d.form >= lo && d.form < hi);
  box.innerHTML = `<div class="wo-panel nx-panel"><div class="nx-head"><h3 class="tile-title wo-panel-title">${ICON_NEXT}<span>Next workout</span></h3><span class="spacer"></span>
    <div class="badges">${badgeHtml("cmodel", "Model", d.models[d.model], { panel: `<div class="opt-panel">${pickList("cmodel", Object.entries(d.models), d.model)}</div>`, right: true })}</div></div>
    <div class="stat-strip cal-next">
    <div class="stat-item nx-zones"><span class="stat-label">Last 7 days + next 3 planned</span>${rows}</div>
    ${fatigueItem(d)}
    <div class="stat-item nx-form" data-tip="${esc(NEXT_FORM_TIP)}">${d.form == null ? "" : formBar(d)}<div class="nx-form-text"><span class="stat-label">Form</span><span class="stat-value">${d.form == null ? "–" : (d.form > 0 ? "+" : "") + num(d.form, 0)}</span><span class="stat-note">${esc(zone ? NEXT_FORM_NOTE[zone[2]] : "")}</span>${formAfter(d)}</div></div>
    <div class="stat-item nx-next"><span class="stat-label">Next training · ${when.toLowerCase()}</span><span class="stat-value">${n.sport && n.kind !== "rest" ? groupIcon(n.sport, 18) : ""}${esc(what)}${n.minutes ? ` <small>· ${num(n.minutes)} min</small>` : ""}</span>
      ${n.reasons.map((r) => `<span class="stat-note">${esc(r)}</span>`).join("")}${d.notes.map((r) => `<span class="stat-note nx-note">${esc(r)}</span>`).join("")}</div>
  </div></div>`;
  bindBadges(box);
  box.querySelectorAll('[data-pick="cmodel"]').forEach((b) => b.onclick = () => { saveUi("training-model", b.dataset.value); document.onclick?.(); renderNextPanel(box, today); });
}

// Summary of one month: activities and the watch's daily values (one person).
async function calMonthSummary(m) {
  const key = `${CURRENT} ${m}`;
  if (!CAL_MONTHS.has(key)) {
    const last = isoDay(new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)));
    CAL_MONTHS.set(key, api("calendar?" + new URLSearchParams({ from: `${m}-01`, to: last, ...personParam() })));
  }
  const data = await CAL_MONTHS.get(key);
  const acts = data.activities, days = Object.values(data.days || {});
  const sum = (k) => acts.reduce((s, a) => s + (a[k] || 0), 0);
  const active = new Set(acts.map((a) => a.day)).size;
  const longest = acts.reduce((best, a) => ((a.distance_m || 0) > (best?.distance_m || 0) ? a : best), null);
  const of = (k) => days.map((d) => d[k]).filter((v) => v != null);
  const steps = of("steps"), floors = of("floors"), ascent = of("ascent_m"), stress = of("stress");
  const total = (xs) => xs.reduce((s, v) => s + v, 0);
  const items = [
    ["Activities", num(acts.length), `${num(active)} active days`],
    ["Distance", km(sum("distance_m")), longest?.distance_m ? `longest ${km(longest.distance_m)}` : ""],
    ["Time", hours(sum("time_s")), acts.length ? `${dur(sum("time_s") / acts.length)} on average` : ""],
    ["Elevation gain", meters(sum("ascent_m"))],
    ["Training load", loadUnit(sum("load"))],
  ];
  if (steps.length) items.push(["Steps", num(total(steps)), `${num(total(steps) / steps.length, 0)} a day`]);
  if (floors.length) items.push(["Floors", num(total(floors)), `${num(total(floors) / floors.length, 0)} a day`]);
  else if (ascent.length) items.push(["Ascent, whole days", meters(total(ascent)), `${meters(total(ascent) / ascent.length)} a day`]);
  if (stress.length) items.push(["Stress", num(total(stress) / stress.length, 0), "average of the days"]);
  const name = `<div class="stat-item cal-mstat"><span class="cal-mname">${MONTHS[+m.slice(5, 7) - 1]}</span><span class="stat-note">${m.slice(0, 4)}</span></div>`;
  return statStrip(items).replace('<div class="stat-strip ">', `<div class="stat-strip ">${name}`);
}

// Year: one small grid per month, each day coloured by its time; Go to picks the year.
async function renderCalendarYear(params) {
  const today = todayIso();
  const year = /^\d{4}$/.test(params.year || "") ? params.year : today.slice(0, 4);
  const data = await api("calendar?" + new URLSearchParams({ from: `${year}-01-01`, to: `${year}-12-31`, ...personParam() }));
  const acts = data.activities;
  const days = new Set(acts.map((a) => a.day));
  const rsum = (k) => acts.reduce((s, a) => s + (a[k] || 0), 0);
  const strip = statStrip([
    ["Activities", num(acts.length), `${num(days.size)} active days`],
    ["Distance", km(rsum("distance_m"))],
    ["Time", hours(rsum("time_s"))],
    ["Elevation gain", meters(rsum("ascent_m"))],
    ["Training load", loadUnit(rsum("load"))],
  ]);
  const dayTime = {};
  for (const a of acts) dayTime[a.day] = (dayTime[a.day] || 0) + (a.time_s || 0);
  const level = (s) => (!s ? 0 : s < 1800 ? 1 : s < 3600 ? 2 : s < 7200 ? 3 : 4);
  const body = `<div class="cal-year">${MONTHS.map((name, mi) => {
    const m = `${year}-${String(mi + 1).padStart(2, "0")}`;
    const lastDay = new Date(Date.UTC(+year, mi + 1, 0)).getUTCDate();
    const lead = (parseDay(m + "-01").getUTCDay() + 6) % 7;
    const macts = acts.filter((a) => a.day.startsWith(m));
    const ms = (k) => macts.reduce((s, a) => s + (a[k] || 0), 0);
    const to = `${m}-${String(lastDay).padStart(2, "0")}`;
    return `<a class="cal-mini" href="#/calendar?${new URLSearchParams({ date: to > today ? today : to })}">
      <div class="cal-mini-head"><b>${name}</b><span class="hint">${macts.length ? `${hours(ms("time_s"))} · ${km(ms("distance_m"))}` : "–"}</span></div>
      <div class="cal-mini-grid">${"<span></span>".repeat(lead)}${[...Array(lastDay)].map((_, i) => {
        const d = `${m}-${String(i + 1).padStart(2, "0")}`;
        return `<span class="lv${level(dayTime[d])} ${d === today ? "today" : ""}" title="${d}${dayTime[d] ? " · " + dur(dayTime[d]) : ""}"></span>`;
      }).join("")}</div></a>`;
  }).join("")}</div>
  <div class="cal-legend hint">Time per day: <span class="lv1"></span> &lt; 30 min <span class="lv2"></span> &lt; 1 h <span class="lv3"></span> &lt; 2 h <span class="lv4"></span> 2 h +</div>`;
  const showSummary = TAB.kpis ?? false;
  const sw = switchHtml("calview", [["month", `${ICON_CAL_MONTH}<span>Weeks</span>`], ["year", `${ICON_CAL_YEAR}<span>Year</span>`]], "year");
  view.innerHTML = `${pageHead(`Calendar <span class="hint">${year}</span>`, `${gotoBadge(year === today.slice(0, 4) ? today : `${year}-12-31`)}<button class="badge ${showSummary ? "on" : ""}" data-ckpis>Summary</button>`, sw)}
    <div data-csummary ${showSummary ? "" : "hidden"}>${strip}</div><div class="card cal-card">${body}</div>`;
  bindBadges(view.querySelector(".page-head"));
  bindGotoPanel(view, (d) => { location.hash = "#/calendar?" + new URLSearchParams({ view: "year", year: d.slice(0, 4) }); });
  view.querySelectorAll("[data-switch=calview]").forEach((b) => b.onclick = () => {
    location.hash = "#/calendar?" + new URLSearchParams(b.dataset.value === "year" ? { view: "year", year } : { date: year === today.slice(0, 4) ? today : `${year}-12-31` });
  });
  view.querySelector("[data-ckpis]").onclick = (e) => {
    const on = !e.currentTarget.classList.contains("on");
    TAB.kpis = on;
    e.currentTarget.classList.toggle("on", on);
    view.querySelector("[data-csummary]").hidden = !on;
  };
}

// ---- Fitness ----------------------------------------------------------------------------

// Sections of the Fitness page, each shown or hidden by its toggle in the header.
const ICON_FITNESS = svg(`<path d="M3 20h18"/><path d="M4 16l5-5 4 3 7-7"/><path d="M15 7h5v5"/>`);
const ICON_FORM = svg(`<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-5"/><circle cx="12" cy="18" r="1"/>`);
const ICON_VO2 = svg(`<path d="M12 4v7"/><path d="M12 11c-1.5 0-2.5 1-4 1.5S4 14 4 17.5 6 21 8 21s4-1.5 4-5"/><path d="M12 11c1.5 0 2.5 1 4 1.5s4 1.5 4 5-2 3.5-4 3.5-4-1.5-4-5"/>`);
const FITNESS_SECTIONS = [["fitness", "Fitness", ICON_FITNESS], ["form", "Form", ICON_FORM], ["vo2max", "VO2 max", ICON_VO2]];
// VO2 max lines (pastel, docs/CHARTS.md): running and cycling, each the watch's own estimate
const VO2_COLORS = { run: "#e0a36f", ride: "#6fb3a4" };
// Pastel zone colours (docs/CHARTS.md): the form line, its bands and the summary use them.
const FORM_ZONES = [
  [25, Infinity, "Detraining", "#9aa3b5"],
  [5, 25, "Fresh", "#5fb0e6"],
  [-10, 5, "Neutral", "#a9adb5"],
  [-30, -10, "Productive", "#4fb67c"],
  [-Infinity, -30, "Overreaching", "#e8716f"],
];
const formZone = (tsb) => FORM_ZONES.find(([lo, hi]) => tsb >= lo && tsb < hi) || FORM_ZONES[2];
// Ramp rate (fitness change in 7 days): above 8 builds too fast, below 0 fitness is lost.
const RAMP_ZONES = [
  [8, Infinity, "Too fast", "#e8716f"],
  [0, 8, "Building", "#4fb67c"],
  [-Infinity, 0, "Losing fitness", "#9aa3b5"],
];
const rampZone = (r) => RAMP_ZONES.find(([lo, hi]) => r >= lo && r < hi) || RAMP_ZONES[1];
// Pastel series colours (docs/CHARTS.md); the form and ramp lines take their zone colour.
const COLORS = { ctl: "#6f8fbf", atl: "#e08aa3", neutral: "#7c8494" }; // muted steel blue, dusty pink
const zonesOf = (zones) => zones.map(([lo, hi, label, color]) => ({ lo, hi, label, color }));
let FITNESS_CHARTS = null; // chart group of the page (destroyed on the next render)

// Sections shown (kept in this browser); a section added later is shown until switched off.
function fitnessShown() {
  const raw = store.get("fitness-sections");
  const keys = FITNESS_SECTIONS.map(([k]) => k);
  if (raw == null) return new Set(keys);
  const known = (store.get("fitness-sections-known") || "fitness,form").split(",");
  return new Set([...raw.split(",").filter((k) => keys.includes(k)), ...keys.filter((k) => !known.includes(k))]);
}

// Fitness › Options, saved per person on the server (like the Map options).
const FITNESS_OPTIONS = { activities: "on", fill: "fill", fatigue: "on", zones: "on" };
const fitnessOptions = () => ({ ...FITNESS_OPTIONS, ...(UI.data["fitness-options"] || {}) });

async function renderFitness(params) {
  // Opens on the last 6 months (fixed, for everyone); All time is `last=all`.
  if (!timeActive(params)) params = { ...params, last: "6m" };
  const shown = fitnessShown();
  const opt = fitnessOptions();
  const { types, workouts, ...time } = filterQuery(params); // Fitness: the time filter only
  const data = await api("fitness?" + new URLSearchParams({ person: CURRENT, ...time }));
  const s = data.series;
  const toggles = `<div class="switch" role="group">${FITNESS_SECTIONS.map(([k, l, icon]) =>
    `<button class="${shown.has(k) ? "on" : ""}" data-fsec="${k}" aria-pressed="${shown.has(k)}">${icon}<span>${l}</span></button>`).join("")}</div>`;
  const showSummary = TAB.kpis ?? false;
  const optionsPanel = `<div class="opt-panel">
      ${row("Activities", pickList("f-activities", [["on", "Shown"], ["off", "Hidden"]], opt.activities))}
      ${row("Fitness", pickList("f-fill", [["fill", "Filled"], ["line", "Line"]], opt.fill))}
      ${row("Fatigue", pickList("f-fatigue", [["on", "Shown"], ["off", "Hidden"]], opt.fatigue))}
      ${row("Form zones", pickList("f-zones", [["on", "Shown"], ["off", "Hidden"]], opt.zones))}</div>`;
  const head = pageHead(`Fitness${thresholdWarning(data.warnings)}`, `${timeBadge(params)}${badgeHtml("f-options", "Options", "", { panel: optionsPanel })}<button class="badge ${showSummary ? "on" : ""}" data-fkpis>Summary</button>`, toggles);
  if (!s.length) {
    view.innerHTML = `${head}<div class="card">${hint(data.pending
      ? `Training load is being computed for ${num(data.pending)} activities — refresh in a moment.`
      : data.first ? "No training data in this period."
      : `No activity has a training load yet: it needs heart rate, or power and FTP. <a href="#/manual/fitness">How load is computed</a>`)}</div>`;
    bindFitnessHead(params);
    return;
  }
  const last = s[s.length - 1];
  const load7 = s.slice(-7).reduce((a, d) => a + d.load, 0);
  const zone = formZone(last.tsb);
  const ramp = last.ramp ?? 0;
  const strip = statStrip([
    ["Fitness (CTL)", num(last.ctl), "42-day load average"],
    ["Fatigue (ATL)", num(last.atl), "7-day load average"],
    ["Form (TSB)", `<span style="color:${zone[3]}">${num(last.tsb)}</span>`, zone[2]],
    ["Ramp rate", `<span style="color:${rampZone(ramp)[3]}">${ramp >= 0 ? "+" : ""}${num(ramp, 1)}</span>`, "fitness change in 7 days"],
    ["Load, 7 days", loadUnit(load7)],
  ]);
  view.innerHTML = `${head}<div data-fsummary ${showSummary ? "" : "hidden"}>${strip}</div>
    <div class="charts" data-fcharts></div>
    ${data.pending ? `<div class="card">${state(`Computing training load for ${num(data.pending)} activities…`, "warn")}</div>` : ""}`;
  // Charts (docs/CHARTS.md): one group over the days, each section toggled in the header.
  // Activities of the period for the icon strip under the x axis.
  const acts = (await api("calendar?" + new URLSearchParams({ from: s[0].date, to: s[s.length - 1].date, ...personParam() })).catch(() => null))?.activities || [];
  const marks = acts.map((a) => ({
    x: Date.parse(a.day + "T00:00:00Z") / 1000, icon: typeIcon(a.activity_type, 16), href: `#/activity/${a.id}`, act: a,
  })).sort((p, q) => p.x - q.x);
  const all = fitnessSeries(s, { marks, opt });
  const order = UI.data["fitness-chart-order"] || [];
  all.sort((p, q) => (order.indexOf(p.key) + 1 || 99) - (order.indexOf(q.key) + 1 || 99));
  FITNESS_CHARTS?.destroy();
  FITNESS_CHARTS = chartGroup(view.querySelector("[data-fcharts]"), {
    x: { date: s.map((d) => Date.parse(d.date + "T00:00:00Z") / 1000) }, kind: "date", series: all,
    hidden: all.map((x) => x.key).filter((k) => !shown.has(k)),
    onOrder: (keys) => {
      const full = [...keys, ...all.map((x) => x.key).filter((k) => !keys.includes(k))];
      all.sort((p, q) => full.indexOf(p.key) - full.indexOf(q.key));
      saveUi("fitness-chart-order", full);
    },
  });
  bindFitnessHead(params, (key, on) => FITNESS_CHARTS.show(key, on));
  // Options: pick, save, apply (the panel stays open).
  const setOpt = (key, v) => { opt[key] = v; saveUi("fitness-options", { ...opt }); };
  const pick = (name, apply) => view.querySelectorAll(`[data-pick="${name}"]`).forEach((b) => b.onclick = () => {
    view.querySelectorAll(`[data-pick="${name}"]`).forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); });
    apply(b.dataset.value);
  });
  pick("f-activities", (v) => { setOpt("activities", v); FITNESS_CHARTS.showMarks(v === "on"); });
  const redraw = (key) => (v) => { setOpt(key, v); FITNESS_CHARTS.setSeries(fitnessSeries(s, { marks, opt })); };
  pick("f-fill", redraw("fill"));
  pick("f-fatigue", redraw("fatigue"));
  pick("f-zones", redraw("zones"));
}

const FATIGUE_AVG_DAYS = 7; // Max fatigue: the highest average over this many days

// The two charts: fitness with fatigue, and form (the usual axis: fresher higher; the line
// takes the colour of its zone, the zones are bands behind it). Ramp rate is only a number in
// the summary: it is the slope of the fitness line.
// The pills on the right: the value at the end of the period, at its height (label = series).
function fitnessSeries(s, { marks = [], opt = FITNESS_OPTIONS } = {}) {
  const vals = (k) => s.map((d) => d[k] ?? null);
  const last = s.length - 1;
  const signed = (v, d = 0) => { const r = Number(v.toFixed(d)) || 0; return `${r > 0 ? "+" : ""}${num(r, d)}`; };
  const extreme = (v, max) => v.reduce((b, x, i) => (x != null && (b < 0 || (max ? x > v[b] : x < v[b])) ? i : b), -1);
  const ctl = vals("ctl"), atl = vals("atl"), tsb = vals("tsb");
  const zc = (zones, v) => zones.find(([lo, hi]) => v >= lo && v < hi)?.[3] || COLORS.neutral;
  const tag = (label, values, i, color, d = 0, sign = true, tip = "") =>
    // the latest value marks nothing on hover: its point is the end of the line, next to the pill
    ({ label, value: values[i], i, values, color, text: sign ? signed(values[i], d) : num(values[i], d), tip, mark: i !== last });
  const fresh = extreme(tsb, true), tired = extreme(tsb, false);
  // the highest fitness of the period, and the highest fatigue as its best 7-day average (a
  // single day's peak says little): hovering its pill draws those days of the fatigue line thick
  const topFit = extreme(ctl, true);
  const atl7 = atl.map((_, i) => {
    if (i < FATIGUE_AVG_DAYS - 1) return null;
    const w = atl.slice(i - FATIGUE_AVG_DAYS + 1, i + 1);
    return w.some((v) => v == null) ? null : w.reduce((a, v) => a + v, 0) / FATIGUE_AVG_DAYS;
  });
  const topTired = extreme(atl7, true);
  return [
    { key: "fitness", label: "Fitness", title: opt.fatigue === "off" ? "Fitness" : "Fitness and fatigue", yTitle: "Training load per day", unit: "", dec: 0, height: 396,
      color: COLORS.ctl, iconHtml: ICON_FITNESS, values: ctl, lines: opt.fatigue === "off" ? [] : [{ label: "Fatigue", color: COLORS.atl, values: atl }],
      fill: opt.fill === "fill", marks, marksHidden: opt.activities === "off", marksTip, onMarks: marksPopup, markSpan: 86400,
      tip: "Fitness: 42-day average of the daily training load. Fatigue: the same over 7 days.",
      tags: [tag("Fitness", ctl, last, COLORS.ctl, 0, false), ...(opt.fatigue === "off" ? [] : [tag("Fatigue", atl, last, COLORS.atl, 0, false)]),
        ...(topFit >= 0 ? [tag("Max fitness", ctl, topFit, COLORS.ctl, 0, false, `Highest fitness in this period: ${s[topFit].date}`)] : []),
        ...(opt.fatigue !== "off" && topTired >= 0 ? [{ ...tag("Max fatigue", atl7, topTired, COLORS.atl, 0, false,
          `Highest fatigue in this period as a ${FATIGUE_AVG_DAYS}-day average: ${s[topTired - FATIGUE_AVG_DAYS + 1].date} – ${s[topTired].date}`),
          mark: true, values: atl, range: [topTired - FATIGUE_AVG_DAYS + 1, topTired] }] : [])] },
    { key: "form", label: "Form", title: "Form", yTitle: "Form", unit: "", dec: 0, height: 259, color: COLORS.neutral, iconHtml: ICON_FORM,
      values: tsb, zones: zonesOf(FORM_ZONES), bands: opt.zones !== "off", yMin: -40, yMax: 30, ySplits: [-40, -30, -10, 5, 25],
      tip: "Yesterday's fitness minus fatigue: higher = fresher, lower = more tired. Training builds fitness in the optimal zone below the grey zone.",
      tags: [tag("Form", tsb, last, zc(FORM_ZONES, tsb[last])), tag("Freshest", tsb, fresh, zc(FORM_ZONES, tsb[fresh])), tag("Most tired", tsb, tired, zc(FORM_ZONES, tsb[tired]))] },
    ...vo2Series(s, tag),
  ];
}

// VO2 max: the watch's estimate after each run and ride (running and cycling apart), standing
// until the next one; the same height as Form. Only the sports that have one.
function vo2Series(s, tag) {
  const last = s.length - 1;
  const sports = [["run", "Running"], ["ride", "Cycling"]]
    .map(([g, label]) => ({ g, label, values: s.map((d) => d[`vo2_${g}`] ?? null), color: VO2_COLORS[g] }))
    .filter((x) => x.values.some((v) => v != null));
  if (!sports.length) return [];
  const [main, ...rest] = sports;
  const top = (v) => v.reduce((b, x, i) => (x != null && (b < 0 || x > v[b]) ? i : b), -1);
  return [{ key: "vo2max", label: main.label, title: "VO2 max", yTitle: "VO2 max (ml/kg/min)", unit: "", dec: 0, height: 259,
    color: main.color, iconHtml: ICON_VO2, values: main.values, fill: false,
    lines: rest.map((x) => ({ label: x.label, color: x.color, values: x.values })),
    tip: "VO2 max the watch estimated after each run and ride (running and cycling have their own), until the next estimate.",
    tags: sports.flatMap((x) => [
      ...(x.values[last] != null ? [tag(x.label, x.values, last, x.color, 0, false)] : []),
      ...(top(x.values) >= 0 && top(x.values) !== last ? [tag(`Max ${x.label.toLowerCase()}`, x.values, top(x.values), x.color, 0, false, `Highest in this period: ${s[top(x.values)].date}`)] : []),
    ]) }];
}

// Activity icons under the fitness chart. Tooltip: the days, then one line per sport (count and
// load), the total load when there are several; a click lists the activities (marksPopup).
const markSport = (a) => groupLabel(typeOf(a.activity_type)?.group || a.category);
const markDays = (items) => {
  const a = items[0].act.day, b = items[items.length - 1].act.day;
  return a === b ? a : `${a} – ${b}`;
};
function marksTip(items) {
  const by = new Map();
  for (const { act } of items) {
    const k = markSport(act), x = by.get(k) || { n: 0, load: 0 };
    x.n += 1; x.load += act.load || 0;
    by.set(k, x);
  }
  const total = items.reduce((t, m) => t + (m.act.load || 0), 0);
  const lines = [...by].sort((p, q) => q[1].n - p[1].n || q[1].load - p[1].load)
    .map(([k, x]) => `${k}: ${num(x.n)} · load ${num(x.load)}`);
  return [markDays(items), ...lines, ...(by.size > 1 ? [`Total load ${num(total)}`] : [])].join("\n");
}
// The activities of an icon in a small window under it: type icon, name, day and load; a row
// opens the activity. Closes on a click outside, Escape or leaving the page.
function marksPopup(items, anchor) {
  document.querySelector(".mark-pop")?.remove();
  const total = items.reduce((t, m) => t + (m.act.load || 0), 0);
  const pop = document.createElement("div");
  pop.className = "mark-pop";
  pop.innerHTML = `<div class="mark-pop-head"><b>${esc(markDays(items))}</b><span>load ${num(total)}</span></div>
    ${items.map(({ act: a, href }) => `<a class="mark-pop-row" href="${href}">${typeIcon(a.activity_type, 16)}
      <span class="mark-pop-name">${esc(a.name || typeLabel(a.activity_type))}<small>${esc(a.day)} · ${esc([shortDur(a.time_s), a.distance_m >= 50 ? km(a.distance_m) : ""].filter(Boolean).join(" · "))}</small></span>
      <span class="mark-pop-load">${a.load != null ? num(a.load) : "–"}</span></a>`).join("")}`;
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${r.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.left + r.width / 2 - pop.offsetWidth / 2))}px`;
  if (r.bottom + 6 + pop.offsetHeight > innerHeight - 8) pop.style.top = `${Math.max(8, r.top - 6 - pop.offsetHeight)}px`;
  const close = () => { pop.remove(); document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", esc_); window.removeEventListener("hashchange", close); window.removeEventListener("scroll", close); };
  const outside = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
  const esc_ = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", esc_);
  window.addEventListener("hashchange", close);
  window.addEventListener("scroll", close, { passive: true });
}

const ICON_WARN = svg(`<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17.5v.01"/>`);
const FIELD_LABEL = { hr_max: "HR max", hr_rest: "Resting HR", lthr: "Threshold HR", ftp: "FTP", threshold_pace: "Threshold pace" };

// Warning icon next to the page title, with a short list and a link to the editor.
function thresholdWarning(warnings) {
  if (!warnings || !warnings.length) return "";
  const line = (w) => (w.kind === "missing"
    ? (w.source === "default" ? `${FIELD_LABEL[w.field]}: default ${num(w.value)} bpm, not from your data.` : `${FIELD_LABEL[w.field]}: highest recorded HR, not from the watch.`)
    : `${w.year}: no watch data, values from ${w.from.slice(0, 4)} used.`);
  return `<span class="badge-wrap title-warn"><button class="icon warn" data-badge="thwarn" title="Load may be off" aria-label="Load may be off">${ICON_WARN}</button>
    <div class="badge-panel" data-panel="thwarn" hidden><div class="warn-panel">
      <b>Load may be off</b><ul>${warnings.map((w) => `<li>${line(w)}</li>`).join("")}</ul>
      <a href="#/settings/people">Set or accept in Settings › People</a></div></div></span>`;
}

function bindFitnessHead(params, onToggle = () => {}) {
  const head = view.querySelector(".page-head");
  bindBadges(head);
  bindFilterBadges(head, "#/fitness", params, { allTime: "all" });
  const kpis = head.querySelector("[data-fkpis]");
  kpis.onclick = () => {
    const on = !kpis.classList.contains("on");
    TAB.kpis = on;
    kpis.classList.toggle("on", on);
    if (on) window.scrollTo({ top: 0, behavior: "smooth" });
    const box = view.querySelector("[data-fsummary]");
    if (box) box.hidden = !on;
  };
  head.querySelectorAll("[data-fsec]").forEach((b) => b.onclick = () => {
    const on = !b.classList.contains("on");
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on);
    const keys = [...head.querySelectorAll("[data-fsec].on")].map((x) => x.dataset.fsec);
    store.set("fitness-sections", keys.join(","));
    store.set("fitness-sections-known", FITNESS_SECTIONS.map(([k]) => k).join(","));
    onToggle(b.dataset.fsec, on);
  });
}

const METHOD_LABELS = { power: "Power", pace: "Running pace", hr: "Heart rate", none: "No load (no data)" };
const SOURCE_LABEL = { set: "", watch: " (watch)", auto: " (estimated)", default: " (default)" };
const SOURCE_CHIP = { set: ["Set", "set"], watch: ["Watch", "watch"], auto: ["Estimated", "est"], default: ["Default", "est"] };
const THRESHOLD_ITEMS = [
  ["hr_max", "HR max", (v) => bpm(v)],
  ["hr_rest", "Resting HR", (v) => bpm(v)],
  ["lthr", "Threshold HR", (v) => bpm(v)],
  ["ftp", "FTP", (v) => watts(v)],
  ["threshold_pace", "Threshold pace", (v) => fmtPace(v)],
];
const sourceChip = (src) => {
  const [label, cls] = SOURCE_CHIP[src] || ["Not set", "none"];
  return `<span class="src-chip ${cls}">${label}</span>`;
};

const fmtPace = (secPerKm) => (secPerKm ? `${Math.floor(secPerKm / 60)}:${String(Math.round(secPerKm % 60)).padStart(2, "0")} /km` : "–");
const parsePace = (txt) => {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(txt || "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// ---- Statistics -------------------------------------------------------------------------
// Three views (docs/SPEC.md › Statistics): Compare years (each year one series over its weeks or
// months; every metric as a chart and its running total, one under the other), Timeline (the whole
// period on one axis) and Records. Header: Time, Type and X-axis. Compare years and Timeline open
// on the last STAT_YEARS years (all time with fewer years of data; All time is `last=all`) and
// share Time, Type and X-axis while on the tab (`TAB.statFilter`, `TAB.statsX`). Records opens on
// all time. X-axis: Compare years Mixed (each period chart by month, each running total by week) |
// Weeks | Months; Timeline Weeks | Months | Years (a choice the other view lacks: its first one).

const STAT_X = [["week", "Weeks"], ["month", "Months"], ["year", "Years"]];
const STAT_X_YEARS = [["mixed", "Mixed"], ["week", "Weeks"], ["month", "Months"]];
const STAT_YEARS = 7;
const TIME_KEYS = ["from", "to", "last", "years"];
// The default period of Compare years and Timeline: the last STAT_YEARS calendar years.
function statDefaultTime() {
  if ((TIME_RANGE.years || []).length <= STAT_YEARS) return {};
  const now = +todayDay().slice(0, 4);
  return { years: [...Array(STAT_YEARS)].map((_, k) => String(now - STAT_YEARS + 1 + k)).join(",") };
}
const RECORD_LABELS = {
  pace: { 400: "400 m", 1000: "1 km", 1609.344: "1 mile", 5000: "5 km", 10000: "10 km", 21097.5: "Half marathon", 42195: "Marathon" },
  power: { 5: "5 s", 15: "15 s", 30: "30 s", 60: "1 min", 300: "5 min", 600: "10 min", 1200: "20 min", 3600: "60 min" },
  hr: { 60: "1 min", 300: "5 min", 1200: "20 min", 3600: "60 min" },
};
// Series colours (pastel, distinct): years newest first, tile sizes large to small.
const SERIES_COLORS = ["#5b8def", "#e0879f", "#5fb48a", "#d9a441", "#9a86d6", "#4fb0b8", "#c98a68", "#8d99ae", "#b5a33b", "#d77fc1"];
// The metrics of Years: [key, title, unit, value from the totals, decimals, icon]. Steps come
// from the daily data (the Type filter does not apply).
const STAT_METRICS = [
  ["distance_m", "Distance", "km", (v) => v / 1000, 1, "distance_total"],
  ["count", "Activities", "", (v) => v, 0, "type"],
  ["ascent_m", "Elevation gain", "m", (v) => v, 0, "total_ascent"],
  ["time_s", "Time", "h", (v) => v / 3600, 1, "timer_time"],
  ["steps", "Steps", "", (v) => v, 0, "steps"],
];
let STAT_CHARTS = []; // chart groups of the page (destroyed on the next draw)

async function renderStats(params) {
  const tab = ["timeline", "records"].includes(params.tab) ? params.tab : "years";
  if (tab !== "records") {
    // entering without a period: the one last used on Compare years / Timeline, else the default
    if (!timeActive(params)) params = { ...params, ...(TAB.statFilter || { ...statDefaultTime(), types: params.types || "" }) };
    const pick = (keys) => Object.fromEntries(keys.filter((k) => params[k]).map((k) => [k, params[k]]));
    TAB.statFilter = { ...pick(TIME_KEYS), types: params.types || "" };
  }
  const sw = switchHtml("stab", [["years", `${ICON_YEARS}<span>Compare years</span>`], ["timeline", `${ICON_TIMELINE}<span>Timeline</span>`],
    ["records", `${ICON_RECORDS}<span>Records</span>`]], tab);
  if (tab === "records") await renderRecords(params, sw);
  else if (tab === "timeline") await renderTimeline(params, sw);
  else await renderStatCharts(params, sw, tab);
  // Compare years and Timeline share their filters (TAB.statFilter); Records opens on all time
  view.querySelectorAll("[data-switch=stab]").forEach((b) => b.onclick = () => {
    const keep = b.dataset.value === "records" ? {} : Object.fromEntries(Object.entries(TAB.statFilter || {}).filter(([, v]) => v));
    location.hash = "#/stats?" + new URLSearchParams({ ...keep, tab: b.dataset.value });
  });
}

async function renderStatCharts(params, sw, tab) {
  const choices = tab === "years" ? STAT_X_YEARS : STAT_X;
  const keep = "statsX"; // shared with Timeline
  let x = choices.some(([k]) => k === TAB[keep]) ? TAB[keep] : choices[0][0]; // kept while on the tab
  const xBadge = badgeHtml("stat-x", "X-axis", choices.find(([k]) => k === x)[1], { panel: `<div class="opt-panel">${pickList("stat-x", choices, x)}</div>` });
  view.innerHTML = `${pageHead("Statistics", timeBadge(params) + typeBadge(params) + xBadge, sw)}
    <div class="charts" data-scharts><div class="page-loader">${loaderHtml()}</div></div>`;
  const head = view.querySelector(".page-head");
  bindBadges(head);
  bindFilterBadges(head, "#/stats", { ...params, tab }, { allTime: "all" });
  const box = view.querySelector("[data-scharts]");
  const draw = async () => {
    // Mixed: the period charts by month, the running totals by week - each chart its own group
    // (other x values), a click on a pill hides the series on all of them
    const builds = x !== "mixed" ? [await yearCharts(params, x)]
      : await Promise.all([yearCharts(params, "month"), yearCharts(params, "week")]);
    const bars = tab === "years" && builds[0] ? await yearBarsData(params) : null;
    STAT_CHARTS.forEach((c) => c?.destroy?.());
    STAT_CHARTS = [];
    if (!box.isConnected) return;
    if (!builds[0]) { box.innerHTML = `<div class="card">${hint("No activities match the filters.")}</div>`; return; }
    box.innerHTML = "";
    // every chart of the page: one y axis width and one pill column, so the plots line up
    const shared = {};
    if (bars) yearBars(box.appendChild(document.createElement("div")), bars);
    if (builds.length === 1) STAT_CHARTS = [chartGroup(box.appendChild(document.createElement("div")), { ...builds[0], shared })];
    else {
      const [byMonth, byWeek] = builds;
      const onToggle = (label, off) => STAT_CHARTS.forEach((c) => c.toggleLine(label, off));
      for (const s of byMonth.series.filter((c) => !c.key.endsWith("-cum"))) {
        const cum = byWeek.series.find((c) => c.key === `${s.key}-cum`);
        for (const [b, one] of [[byWeek, cum], [byMonth, s]]) {
          if (!one) continue;
          const el = box.appendChild(document.createElement("div"));
          STAT_CHARTS.push(chartGroup(el, { ...b, series: [one], onToggle, shared }));
        }
      }
    }
    STAT_CHARTS.forEach((c) => c.realign());
    if (bars && YEAR_PINNED) STAT_CHARTS.forEach((c) => c.emphasize?.(YEAR_PINNED)); // the clicked year stays marked
  };
  head.querySelectorAll('[data-pick="stat-x"]').forEach((b) => b.onclick = () => {
    head.querySelectorAll('[data-pick="stat-x"]').forEach((o) => { o.classList.toggle("on", o === b); o.setAttribute("aria-checked", o === b); });
    x = TAB[keep] = b.dataset.value;
    head.querySelector('[data-badge-value="stat-x"]').textContent = choices.find(([k]) => k === x)[1];
    document.onclick?.();
    draw();
  });
  await draw();
}

// Compare years, on top: three column charts (distance, activities, elevation per year), each
// year a column in its series colour, split into running (bottom), cycling and other (top) in
// three shades of it, in a framed plot with a y axis (nice steps, dashed grid) and axis titles
// (docs/CHARTS.md); the year's total above its column. Hovering a part shows that part only;
// hovering a year marks it on all three and fades the other years below; a click keeps it.
const YEAR_BARS = [["distance_m", "Distance", "km", (v) => v / 1000, "distance_total"], ["count", "Activities", "", (v) => v, "type"],
  ["ascent_m", "Elevation gain", "m", (v) => v, "total_ascent"]];
const YEAR_BAR_TICKS = 4; // about this many steps on the y axis
let YEAR_PINNED = null; // the year clicked in the column charts: marked until clicked again or a reload
const BAR_PARTS = [["run", "Running", 100], ["ride", "Cycling", 62], ["other", "Other", 34]];
async function yearBarsData(params) {
  const d = await api("stats/totals?" + new URLSearchParams({ person: CURRENT, by: "year", parts: 1, ...filterQuery(params) }));
  const years = [...new Set(d.rows.map((r) => r.period))].sort().reverse();
  return years.length ? { years, parts: d.parts || [] } : null;
}
function yearBars(el, { years, parts }) {
  el.className = "year-bars";
  const color = (y) => SERIES_COLORS[years.indexOf(y) % SERIES_COLORS.length];
  const chrono = [...years].reverse();
  el.innerHTML = YEAR_BARS.map(([key, title, unit, conv, icon]) => {
    const val = (y, part) => conv(parts.filter((p) => p.period === y && (!part || p.part === part)).reduce((a, p) => a + (p[key] || 0), 0));
    const max = Math.max(1, ...chrono.map((y) => val(y)));
    const step = Math.max(1, niceStep(max / YEAR_BAR_TICKS)), top = Math.ceil((max * 1.08) / step) * step; // room for the total
    const fmt = (v) => `${num(v, 0)}${unit ? ` ${unit}` : ""}`;
    const pct = (v) => `${(v / top) * 100}%`;
    const ticks = [...Array(Math.round(top / step) + 1)].map((_, k) => k * step);
    const grid = ticks.slice(1, -1).map((v) => `<i class="yb-grid" style="bottom:${pct(v)}"></i>`).join("");
    const ylabs = ticks.map((v) => `<span style="bottom:${pct(v)}">${num(v)}</span>`).join("");
    const cols = chrono.map((y) => {
      const tot = val(y);
      const segs = BAR_PARTS.map(([p, label, shade]) => {
        const v = val(y, p);
        return v ? `<i style="height:${pct(v)};background:color-mix(in srgb, ${color(y)} ${shade}%, var(--surface))" data-tip="${esc(`${y} · ${label}: ${fmt(v)} (${num((v / tot) * 100, 0)} %)`)}"></i>` : "";
      }).join("");
      return `<div class="yb-col" data-year="${y}"><div class="yb-bar">${segs}<span class="yb-val" style="bottom:${pct(tot)}">${num(tot, 0)}</span></div></div>`;
    }).join("");
    const years = chrono.map((y) => `<span data-year="${y}">${y}</span>`).join("");
    return `<div class="card yb-card"><h3 class="chart-title">${metricIcon(icon, 18)}<span>${title} per year</span></h3>
      <div class="yb-chart"><span class="yb-ytitle">${title}${unit ? ` (${unit})` : ""}</span><div class="yb-yaxis">${ylabs}</div>
        <div class="yb-plot">${grid}${cols}</div><span></span><span></span><div class="yb-xaxis">${years}</div>
        <span></span><span></span><span class="yb-xtitle">Year</span></div></div>`;
  }).join("");
  // hovering marks a year; a click keeps it marked (until another click on it or a reload)
  const mark = (y) => {
    y ??= YEAR_PINNED;
    el.querySelectorAll(".yb-col, .yb-xaxis span").forEach((c) => c.classList.toggle("dim", y != null && c.dataset.year !== y));
    el.querySelectorAll(".yb-col").forEach((c) => c.classList.toggle("pinned", c.dataset.year === YEAR_PINNED));
    STAT_CHARTS.forEach((c) => c.emphasize?.(y));
  };
  el.querySelectorAll(".yb-col").forEach((c) => {
    c.onmouseenter = () => mark(c.dataset.year);
    c.onmouseleave = () => mark(null);
    c.onclick = () => { YEAR_PINNED = YEAR_PINNED === c.dataset.year ? null : c.dataset.year; mark(c.dataset.year); };
  });
  if (!years.includes(YEAR_PINNED)) YEAR_PINNED = null;
  mark(null);
  fitYearBars(el);
  const ro = new ResizeObserver(() => (el.isConnected ? fitYearBars(el) : ro.disconnect()));
  ro.observe(el);
}
// Narrow columns: the totals show only on the hovered or clicked year, and the x axis labels
// every k-th year (counted from the newest, so the latest year always has its label).
function fitYearBars(el) {
  el.querySelectorAll(".yb-card").forEach((card) => {
    const cols = card.querySelectorAll(".yb-col"), labels = card.querySelectorAll(".yb-xaxis span");
    if (!cols.length) return;
    const pitch = card.querySelector(".yb-plot").clientWidth / cols.length;
    card.classList.remove("yb-tight");
    const widest = Math.max(...[...card.querySelectorAll(".yb-val")].map((v) => v.offsetWidth));
    card.classList.toggle("yb-tight", widest > pitch - 4);
    const step = Math.max(1, Math.ceil(34 / pitch)); // a year label needs about 34 px
    labels.forEach((s, i) => s.classList.toggle("yb-skip", (labels.length - 1 - i) % step !== 0));
  });
}

// The days the filter covers: [first, last] (the first activity … today without one).
function statWindow(params) {
  const today = todayDay(), ys = yearList(params);
  const lo = params.from || (params.last && params.last !== "all" ? lastSince(params.last) : null)
    || (ys.length ? `${ys[0]}-01-01` : null) || TIME_RANGE.first || today;
  const hi = params.to && params.to < today ? params.to : ys.length && `${ys[ys.length - 1]}-12-31` < today ? `${ys[ys.length - 1]}-12-31` : today;
  return [lo, hi];
}
const dayMs = (d) => Date.parse(d + "T00:00:00Z");
// Week k of year y as the server counts it (%W: weeks start on Monday, days before the first
// Monday are week 0 - here part of week 1): [first day, last day].
function weekSpan(y, k) {
  const jan1 = dayMs(`${y}-01-01`), mon = jan1 + ((8 - new Date(jan1).getUTCDay()) % 7) * 86400000;
  const a = k <= 1 ? jan1 : mon + (k - 1) * 7 * 86400000;
  const b = Math.min(mon + k * 7 * 86400000 - 86400000, dayMs(`${y}-12-31`));
  return [isoDay(new Date(a)), isoDay(new Date(b))];
}
function monthSpan(y, m) {
  const mm = String(m).padStart(2, "0");
  return [`${y}-${mm}-01`, isoDay(new Date(Date.UTC(y, m, 0)))];
}

// Years: one series per year over its weeks or months, for each metric the values and their
// running total; a year's series covers only the filtered days (the current year ends today).
async function yearCharts(params, by) {
  const data = await api("stats/totals?" + new URLSearchParams({ person: CURRENT, by, steps: 1, ...filterQuery(params) }));
  if (!data.rows.length) return null;
  const n = by === "month" ? 12 : 53;
  const xs = [...Array(n)].map((_, i) => i + 1);
  const [lo, hi] = statWindow(params);
  const posOf = (p) => (by === "month" ? +p.slice(5, 7) : Math.max(1, Math.min(53, +p.slice(6))));
  const years = [...new Set(data.rows.map((r) => r.period.slice(0, 4)))].sort().reverse();
  const color = (k) => SERIES_COLORS[k % SERIES_COLORS.length];
  const sums = Object.fromEntries(years.map((y) => [y, xs.map(() => ({}))]));
  for (const r of [...data.rows, ...(data.steps || [])]) {
    const cell = sums[r.period.slice(0, 4)]?.[posOf(r.period) - 1];
    if (!cell) continue; // steps of a year without activities
    for (const [k] of STAT_METRICS) if (r[k] != null) cell[k] = (cell[k] || 0) + r[k];
  }
  const thisYear = todayDay().slice(0, 4), endsToday = hi === todayDay();
  // inside the filter: a value (0 without activities), outside: no point
  const inside = (y, k) => { const [a, b] = by === "month" ? monthSpan(+y, k) : weekSpan(+y, k); return b >= lo && a <= hi; };
  const charts = [];
  for (const [key, title, unit, conv, dec, icon] of STAT_METRICS) {
    if (key === "steps" && !(data.steps || []).length) continue;
    const fmt = (v) => `${num(v, v >= 100 ? 0 : dec)}${unit ? ` ${unit}` : ""}`;
    for (const cumulative of [true, false]) { // the running total first, then per period
      const lines = years.map((y, k) => {
        let run = 0;
        const values = xs.map((p) => {
          if (!inside(y, p)) return null;
          const v = conv(sums[y][p - 1][key] || 0);
          run += v;
          return cumulative ? run : v;
        });
        // the current year's running total runs on dashed and level to the end of the year
        return { label: y, values, color: color(k), extend: cumulative && y === thisYear && endsToday };
      });
      const tags = lines.map((l) => {
        const i = l.values.findLastIndex((v) => v != null);
        return { label: l.label, value: i >= 0 ? l.values[i] : null, i, color: l.color, text: i >= 0 ? fmt(l.values[i]) : "–" };
      });
      // per period: a Max pill - the highest week or month of all years; hovering marks it
      let top = null;
      if (!cumulative) for (const l of lines) l.values.forEach((v, i) => { if (v != null && v > 0 && (!top || v > top.v)) top = { v, i, l }; });
      const periodName = (i) => (by === "month" ? MONTHS[i] : `week ${i + 1}`);
      const stats = top ? [["Max", fmt(top.v), { i: top.i, values: top.l.values, color: top.l.color },
        `Highest ${title.toLowerCase()} in one ${by}: ${fmt(top.v)} in ${periodName(top.i)} ${top.l.label}`]] : [];
      charts.push({ key: `${key}${cumulative ? "-cum" : ""}`, label: title, title: `${title} per ${by}${cumulative ? ", cumulative" : ""}`, icon,
        yTitle: title, unit, dec, multi: true, points: true, tagsInside: true, lines, tags, stats, yMin: 0, height: cumulative ? 325 : 260, color: color(0),
        tipAll: cumulative });
    }
  }
  return { x: { [by]: xs }, kind: by, series: charts };
}

// Records: tiles in the style of the activity's top tiles, a table of best efforts beside its
// curve (one grid: the tables one width, each pair one height): Running; Power; Cycling (outdoor);
// Virtual (indoor rides: records of their own) | Walking & hiking (no speeds); Segments. Without a Time filter the 3 best of all time,
// with one the best in that time and the best of all time. A record opens its activity.
const REC_DIST = { 400: "400 m", 1000: "1 km", 1609.344: "1 mile", 5000: "5 km", 10000: "10 km", 20000: "20 km", 21097.5: "Half marathon",
  30000: "30 km", 40000: "40 km", 42195: "Marathon", 50000: "50 km", 100000: "100 km" };
const REC_POWER_ROWS = [5, 15, 30, 60, 300, 600, 1200, 3600, 7200]; // the table; the curve has every duration
const distShort = (m) => (m === 1609.344 ? "1mi" : m === 21097.5 ? "HM" : m === 42195 ? "M" : m < 1000 ? `${m}m` : `${num(m / 1000)}k`);
const distFull = (m) => REC_DIST[m] || km(m);
const REC_MAIN = "#86aef5", REC_POWER = "#b9a2f2";

// The records tables of one person (GET stats/records): a tile per sport, as Statistics › Records
// and the Home Assistant records card show them.
function recordTiles(data, rangeLabel) {
  const filtered = data.filtered;
  const find = (list, kind, v = 0) => list.filter((e) => e.kind === kind && e.v === v).sort((p, q) => p.key - q.key);
  const run = data.run || [], ride = data.ride || [], walk = data.walk || [];
  // one result: the value and its pace or speed (the time of the longest); the activity and the
  // date on hover, a click opens it
  const value = (e, r) => (e.kind === "steps" ? num(r.value) : e.kind === "ascent" || e.kind === "climb" ? meters(r.value) : e.kind === "grade" ? `${num(r.value, 1)} %` : e.kind === "longest" || e.kind === "within" ? km(r.value) : e.kind === "speed" ? kmh(r.value) : e.kind === "power" ? watts(r.value) : clock(r.value));
  const sub = (e, r) => (e.group === "walk" ? "" : e.kind === "pace" ? pace(e.key / r.value) : e.kind === "ride" ? kmh(e.key / r.value)
    : e.kind === "within" ? (e.group === "run" ? pace(r.value / e.key) : kmh(r.value / e.key)) : e.kind === "longest" ? (r.time_s ? durMin(r.time_s) : "") : "");
  // a segment effort: its time, pace or speed (the activity's group)
  const segValue = (e, r) => clock(r.value);
  const segSub = (e, r) => (ON_FOOT.has(r.category) ? pace(e.segment.distance_m / r.value) : kmh(e.segment.distance_m / r.value));
  // a value without a speed (power, elevation, grade…) sits in the middle of both columns
  const cell = (e, r) => {
    if (!r) return `<span class="effort-rec">–</span><span></span><span></span>`;
    const s = e.segment ? segSub(e, r) : sub(e, r);
    const link = `<a class="effort-rec plain-link${s ? "" : " rec-span2"}" href="#/activity/${r.activity_id}" data-tip="${esc(r.name || typeLabel(r.activity_type))}">${e.segment ? segValue(e, r) : value(e, r)}</a>`;
    return `${link}${s ? `<span class="effort-speed">${s}</span>` : ""}<span class="effort-speed rec-date">${localTime(r).slice(0, 10)}</span>`;
  };
  const name = (e) => (e.segment ? `<a class="plain-link rec-seg" href="#/segment/${e.segment.id}" data-tip="${esc(e.segment.name || "Segment")} · ${km(e.segment.distance_m)}">${esc(e.segment.name || "Segment")}</a>`
    : e.kind === "longest" ? `<span data-tip="Longest distance in one activity">Max distance</span>`
    : e.kind === "steps" ? `<span data-tip="Most steps in one activity, from the cadence">Most steps</span>`
    : e.kind === "speed" ? `<span data-tip="Top speed held for 1 minute; stretches with GPS jumps are left out">Top speed 1 min</span>`
    : e.kind === "ascent" ? `<span data-tip="Elevation gain of the whole activity">Max elevation gain</span>`
    : e.kind === "climb" ? `<span data-tip="The biggest single climb: from a low point to its top, short dips on the way allowed (as the climbs on the altitude chart); altitude jumps left out">Biggest climb</span>`
    : e.kind === "grade" ? `<span data-tip="The steepest ${km(e.key)} of any climb, average grade; altitude and distance jumps left out">Steepest 1 km</span>`
    : e.kind === "within" ? (e.key === 720 ? `<span data-tip="Longest distance run within 12 minutes (Cooper test)">Cooper 12 min</span>`
      : `<span data-tip="Longest distance within ${durFull(e.key)}">Max in 1 h</span>`)
    : e.kind === "power" ? durFull(e.key) : REC_DIST[e.key] || km(e.key));
  const cols = filtered ? [[esc(rangeLabel), `Best in: ${esc(rangeLabel)}`], ["All time", "Best of all time"]]
    : [["Best", "Best of all time"], ["2nd", "Second best of all time"], ["3rd", "Third best of all time"]];
  // the best in the period is the all-time best itself: the laurel instead of the same value twice
  const sameBest = (a, b) => a && b && a.activity_id === b.activity_id && a.value === b.value;
  const laurelCell = `<span class="rec-laurel" data-tip="The all-time best, set in this period">${LAUREL_SVG}</span>`;
  // a row whose result is a point of a curve beside it: data-curve / data-key (lit both ways)
  const curveOf = (e) => (e.segment ? null : e.kind === "pace" ? "run" : e.kind === "ride" && !e.v ? "ride" : e.kind === "power" ? "power" : null);
  const table = (rows) => `<div class="efforts rec-efforts" style="--rec-cols:${cols.length}"><div class="effort effort-head"><span></span>${cols.map(([c, tip]) => `<span class="eh-col" data-tip="${tip}">${c}</span>`).join("")}</div>
    ${rows.map((e) => `<div class="effort"${curveOf(e) ? ` data-curve="${curveOf(e)}" data-key="${e.key}"` : ""}><span class="effort-name">${name(e)}</span>${filtered ? (sameBest(e.range, e.ever[0]) ? laurelCell : cell(e, e.range)) + cell(e, e.ever[0]) : [0, 1, 2].map((k) => cell(e, e.ever[k])).join("")}</div>`).join("")}</div>`;
  // a table tile's title: the sport, then the laurel and BEST EFFORTS
  const be = (what) => `${what}</span>${LAUREL_SVG}<span class="rec-be">Best efforts`;
  const tile = (icon, title, body, cls = "", tip = "") => `<div class="card act-tile rec-tile ${cls}"><h3 class="tile-title"${tip ? ` data-tip="${tip}"` : ""}>${icon}<span>${title}</span></h3>${body}</div>`;
  const runRows = [...find(run, "pace"), ...find(run, "longest"), ...find(run, "within"), ...find(run, "ascent"), ...find(run, "climb"), ...find(run, "grade")];
  const outRows = [...find(ride, "ride"), ...find(ride, "longest"), ...find(ride, "within"), ...find(ride, "speed"), ...find(ride, "ascent"), ...find(ride, "climb"), ...find(ride, "grade")];
  const inRows = [...find(ride, "ride", 1), ...find(ride, "longest", 1), ...find(ride, "within", 1), ...find(ride, "speed", 1), ...find(ride, "ascent", 1), ...find(ride, "climb", 1), ...find(ride, "grade", 1)];
  const walkRows = [...find(walk, "longest"), ...find(walk, "steps"), ...find(walk, "ascent"), ...find(walk, "climb"), ...find(walk, "grade")];
  const powAll = find(ride, "power"), powRows = powAll.filter((e) => REC_POWER_ROWS.includes(e.key));
  const segRows = data.segments || [];
  return { filtered, find, tile, run, ride, powAll, parts: {
    run: runRows.length ? tile(typeIcon("run"), be("Running"), table(runRows)) : "",
    power: powRows.length ? tile(metricIcon("power", 18), be("Cycling power"), table(powRows), "", "Power of every ride, outdoor and indoor") : "",
    ride: outRows.length ? tile(typeIcon("ride"), be("Cycling"), table(outRows), "", "Outdoor rides") : "",
    virtual: inRows.length ? tile(typeIcon("virtual_ride"), be("Cycling virtual"), table(inRows), "", "Virtual and indoor rides: a trainer's distance and speed are records of their own") : "",
    walk: walkRows.length ? tile(typeIcon("walk"), be("Walking & hiking"), table(walkRows), "rec-side-tile", "Walks and hikes together: distance, steps and climbing, no speeds") : "",
    segments: segRows.length ? tile(metricIcon("route", 18), be("Segment"), table(segRows), "rec-seg-tile", "Every segment you have an effort on: the fastest times") : "",
  } };
}

async function renderRecords(params, sw) {
  view.innerHTML = `${pageHead("Statistics", timeBadge(params), sw)}<div class="page-loader">${loaderHtml()}</div>`;
  const head = view.querySelector(".page-head");
  bindBadges(head);
  bindFilterBadges(head, "#/stats", { ...params, tab: "records" }, { allTime: "all" });
  const tq = Object.fromEntries(Object.entries(filterQuery(params)).filter(([k]) => ["from", "to", "last", "years"].includes(k)));
  const data = await api("stats/records?" + new URLSearchParams({ person: CURRENT, ...tq }));
  const rangeLabel = timeLabel(params);
  RECORD_CHARTS.forEach((c) => c?.destroy());
  RECORD_CHARTS = [];
  const { filtered, find, tile, run, ride, powAll, parts: P } = recordTiles(data, rangeLabel);
  const curveTile = (key, title, icon) => tile(metricIcon(icon, 18), title, `<div class="curve-box" data-rec-curve="${key}"></div>`, "rec-curve-tile");
  const pair = (left, right) => `${left}${right || "<div></div>"}`;
  const tiles = [
    P.run && pair(P.run, find(run, "pace").length > 1 && curveTile("run", "Running speed curve", "speed")),
    P.power && pair(P.power, powAll.length > 1 && curveTile("power", "Power curve", "power")),
    P.ride && pair(P.ride, find(ride, "ride").length > 1 && curveTile("ride", "Cycling speed curve", "speed")),
    (P.virtual || P.walk) && pair(P.virtual || "<div></div>", P.walk),
    P.segments && pair(P.segments),
  ].filter(Boolean);
  view.querySelector(".page-loader")?.remove();
  view.insertAdjacentHTML("beforeend", tiles.length ? `<div class="rec-page">${tiles.join("")}</div>` : `<div class="card">${hint("No runs or rides with records yet.")}</div>`);
  fitRecordTables(view.querySelector(".rec-page"));
  // the curves: the best in the Time filter (or of all time) and, filtered, the best of all time dashed
  const open = (p) => { if (p.activity_id) location.hash = `#/activity/${p.activity_id}`; };
  const pts = (rows, val) => rows.map((e) => { const m = filtered ? e.range : e.ever[0];
    return { key: e.key, value: m ? val(e, m) : null, date: m ? localTime(m).slice(0, 10) : "", activity_id: m?.activity_id,
      compare: filtered && e.ever[0] ? val(e, e.ever[0]) : null, compareDate: filtered && e.ever[0] ? localTime(e.ever[0]).slice(0, 10) : "" }; });
  const speedOf = (e, r) => (e.key / r.value) * 3.6;
  const common = { mainLabel: filtered ? rangeLabel : "All time high", compareLabel: "All time high", onClick: open, dots: true, tags: true };
  const distAxis = { keyShort: distShort, keyFull: distFull, xTitle: "Distance", xTip: "The fastest time over each distance, as a speed." };
  // hovering a point lights its row; hovering a row shows its point (the curve's crosshair)
  const curves = {};
  const lightRow = (key, p) => view.querySelectorAll(`.effort[data-curve="${key}"]`).forEach((r) => r.classList.toggle("hot", p != null && Number(r.dataset.key) === p.key));
  const draw = (key, opts) => {
    const el = view.querySelector(`[data-rec-curve="${key}"]`);
    if (!el) return;
    const c = curveChart(el, { ...opts, onHover: (p) => lightRow(key, p) });
    RECORD_CHARTS.push(c);
    curves[key] = c;
  };
  draw("run", { ...common, ...distAxis, points: pts(find(run, "pace"), speedOf), color: REC_MAIN, unit: "km/h", label: "Speed",
    fmt: (v) => pace(v / 3.6) });
  draw("ride", { ...common, ...distAxis, points: pts(find(ride, "ride"), speedOf), color: REC_MAIN, unit: "km/h", label: "Speed",
    fmt: (v) => `${num(v, 1)} km/h` });
  draw("power", { ...common, points: pts(powAll, (e, r) => r.value), color: REC_POWER, unit: "W", label: "Power" });
  view.querySelectorAll(".effort[data-curve]").forEach((r) => {
    r.addEventListener("mouseenter", () => curves[r.dataset.curve]?.show(Number(r.dataset.key)));
    r.addEventListener("mouseleave", () => curves[r.dataset.curve]?.show(null));
  });
}
let RECORD_CHARTS = [];

// Records tables: every value, pace and date on one line. Each column kind (value, speed, date)
// takes the width of its widest cell in any table, so the dividers line up through all tiles,
// and the tables are as wide as that needs (the curves beside them give way).
const REC_CURVE_MIN = 280; // below this the tables take a smaller font (rec-compact)
function fitRecordTables(page, compact = false) {
  if (!page || matchMedia("(max-width: 900px)").matches) return;
  page.classList.remove("rec-fitted");
  page.classList.toggle("rec-compact", compact);
  page.classList.add("rec-measure");
  const w = { v: 0, s: 0, d: 0 };
  page.querySelectorAll(".rec-efforts .effort:not(.effort-head)").forEach((row) => {
    let k = 0; // position inside a result: 0 value, 1 speed, 2 date
    [...row.children].slice(1).forEach((c) => {
      const span = c.classList.contains("rec-laurel") ? 3 : c.classList.contains("rec-span2") ? 2 : 1;
      if (span === 1) { const kind = k === 0 ? "v" : k === 1 ? "s" : "d"; w[kind] = Math.max(w[kind], Math.ceil(c.getBoundingClientRect().width)); }
      k = (k + span) % 3;
    });
  });
  page.classList.remove("rec-measure");
  if (!w.v) return;
  page.style.setProperty("--rc-v", `${w.v}px`); page.style.setProperty("--rc-s", `${w.s}px`); page.style.setProperty("--rc-d", `${w.d}px`);
  const cols = Number(page.querySelector(".rec-efforts")?.style.getPropertyValue("--rec-cols")) || 2;
  const tableW = Math.max(420, 112 + cols * (w.v + w.s + w.d) + 28 + 4);
  // the curves need some room: first a smaller font, else the tables as they come
  if (!compact && page.clientWidth - tableW - 12 < REC_CURVE_MIN) { fitRecordTables(page, true); return; }
  page.style.setProperty("--rec-table-w", `${tableW}px`);
  page.classList.add("rec-fitted");
}

// ---- Thresholds (Settings › People) -------------------------------------------------------
// Each value: your own (Settings) > from the watch (FIT files) > estimated. The People table
// shows the values in use; the pencil opens this editor under the person's row.

const ICON_PENCIL = svg(`<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>`);

// Short line for the People table: the values in use, estimated ones marked.
function thresholdSummary(st) {
  const eff = st.effective, src = eff.sources || {};
  const parts = THRESHOLD_ITEMS.filter(([k]) => eff[k] != null).map(([k, l, fmt]) =>
    `<span class="th-sum ${src[k] === "auto" || src[k] === "default" ? "est" : ""}" title="${esc(l)}${esc(SOURCE_LABEL[src[k]] || "")}">${esc(l)} <b>${fmt(eff[k])}</b></span>`);
  return parts.join("") || `<span class="hint">–</span>`;
}

async function renderThresholds(el, pid, onChange) {
  const st = await api("thresholds/" + encodeURIComponent(pid));
  const eff = st.effective, src = eff.sources || {}, watch = st.watch || {};
  const accepted = new Set(st.accepted || []);
  const weak = (k) => src[k] === "default" || (k === "hr_max" && src[k] === "auto");
  const field = ([k, l, fmt]) => {
    const isPace = k === "threshold_pace";
    const w = watch[k];
    const acceptBtn = weak(k)
      ? (accepted.has(k)
        ? `<button class="small ghost" data-th-accept="${k}" data-on="0" title="Warn again about this estimate">Estimate accepted ✓</button>`
        : `<button class="small" data-th-accept="${k}" data-on="1" title="Keep the estimate and stop the warning">Use estimate</button>`)
      : "";
    return `<div class="th-field">
      <div class="th-field-head"><span class="th-label">${l}</span>${sourceChip(eff[k] == null ? null : src[k])}</div>
      <div class="th-value">${eff[k] == null ? "–" : fmt(eff[k])}</div>
      <div class="hint">${w != null ? `Watch: ${fmt(w)}` : "Not in watch files"}</div>
      <input name="${k}" ${isPace ? 'placeholder="min:s, e.g. 4:30"' : 'inputmode="numeric" placeholder="Your value"'}>
      ${acceptBtn}
    </div>`;
  };
  el.innerHTML = `<div class="th-editor">
    <div class="th-fields">${THRESHOLD_ITEMS.map(field).join("")}</div>
    <div class="th-actions">
      <label class="th-from"><span class="th-label">Valid from</span><input type="date" name="valid_from" value="${todayIso()}"></label>
      <button class="primary small" data-th-save>Save my values</button>
      <span class="hint">Empty field: watch value, otherwise an estimate.</span>
      <span data-th-msg>${st.pending ? state(`Recomputing ${num(st.pending)} activities…`, "warn") : ""}</span>
    </div>
    ${st.rows.length ? `<div class="panel-title" style="margin-top:14px">My values</div><div class="scroll"><table class="data th-rows">
      <thead><tr><th>Valid from</th>${THRESHOLD_ITEMS.map(([, l]) => `<th class="num">${l}</th>`).join("")}<th></th></tr></thead>
      <tbody>${st.rows.map((r) => `<tr><td>${r.valid_from === "1970-01-01" ? "always" : r.valid_from}</td>
        ${THRESHOLD_ITEMS.map(([k, , fmt]) => `<td class="num">${r[k] ? fmt(r[k]) : "–"}</td>`).join("")}
        <td class="actions"><button class="icon delete" data-th-del="${r.valid_from}" title="Delete row" aria-label="Delete row">${ICON.trash}</button></td></tr>`).join("")}</tbody></table></div>`
      : ""}
  </div>`;
  const msg = el.querySelector("[data-th-msg]");
  const refresh = async (text) => {
    await renderThresholds(el, pid, onChange);
    if (text) el.querySelector("[data-th-msg]").innerHTML = state(text, "ok");
    if (onChange) onChange();
  };
  el.querySelector("[data-th-save]").onclick = async () => {
    const f = (n) => el.querySelector(`[name=${n}]`).value.trim();
    const paceText = f("threshold_pace");
    const paceSec = paceText ? parsePace(paceText) : null;
    if (paceText && paceSec == null) { msg.innerHTML = state("Threshold pace as min:s, e.g. 4:30", "bad"); return; }
    const body = { valid_from: f("valid_from"), hr_max: f("hr_max"), hr_rest: f("hr_rest"), lthr: f("lthr"), ftp: f("ftp"), threshold_pace: paceSec };
    if (!["hr_max", "hr_rest", "lthr", "ftp"].some((k) => body[k]) && !paceSec) { msg.innerHTML = state("Enter at least one value", "warn"); return; }
    try {
      await api("thresholds/" + encodeURIComponent(pid), { method: "PUT", body: JSON.stringify(body) });
      await refresh("Saved · load is being recomputed");
    } catch (e) { msg.innerHTML = state(esc(e.message), "bad"); }
  };
  el.querySelectorAll("[data-th-accept]").forEach((b) => b.onclick = async () => {
    try {
      await api(`thresholds/${encodeURIComponent(pid)}/accept`, { method: "PUT", body: JSON.stringify({ field: b.dataset.thAccept, accepted: b.dataset.on === "1" }) });
      await refresh(b.dataset.on === "1" ? "Estimate accepted" : "Warning back on");
    } catch (e) { msg.innerHTML = state(esc(e.message), "bad"); }
  });
  el.querySelectorAll("[data-th-del]").forEach((b) => b.onclick = async () => {
    if (!confirm("Delete this row of your values?")) return;
    await api(`thresholds/${encodeURIComponent(pid)}/${b.dataset.thDel}`, { method: "DELETE" });
    await refresh("Deleted · load is being recomputed");
  });
}

// ---- Activity page additions --------------------------------------------------------------

function activityTrainingHtml(a) {
  const efforts = a.best_efforts || [];
  const group = (k) => efforts.filter((e) => e.kind === k);
  const block = (k, title, fmt) => (group(k).length ? `<div><div class="panel-title">${title}</div><table class="kv"><tbody>${group(k).map((e) =>
    `<tr><td>${RECORD_LABELS[k][e.key] || e.key}</td><td>${fmt(e)}</td></tr>`).join("")}</tbody></table></div>` : "");
  const blocks = [
    block("pace", "Fastest", (e) => `${dur(e.value)} <span class="hint">${pace(e.key / e.value)}</span>`),
    block("power", "Best power", (e) => watts(e.value)),
    block("hr", "Highest heart rate", (e) => bpm(e.value)),
  ].join("");
  return `<div class="card"><h3>Training load and best efforts</h3>
    <div class="card-row">${a.load != null ? `<b>${loadUnit(a.load)}</b> <span class="hint">from ${esc(METHOD_LABELS[a.load_method] || a.load_method)}</span>` : `<span class="hint">${a.analysis_version ? "No load — no heart rate or power data." : "Not computed yet."}</span>`}</div>
    ${blocks ? `<div class="efforts">${blocks}</div>` : ""}</div>`;
}

// ---- Statistics › Timeline ----------------------------------------------------------------
// Always on top a summary strip; then half-width cards: time of day | day of the week
// (columns or pie: two icons in each card's head, one choice for both), activity types |
// countries (pie or columns, the same way; countries with or without virtual routes); three
// table cards in a row: distance (running and cycling each a table of its own) | weather |
// temperature breakdown; at the bottom Explorer tiles: its summary strip and two charts
// (tiles visited so far, new tiles per period), each card with the size icons (Squares /
// Explorer tiles; one choice for all three). Charts as docs/CHARTS.md: framed plot, axis titles,
// dashed grid. All of it from /api/stats/activities and the routes, worked out here.
const WEEKDAYS_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DIST_CHOICES = [["bars", "Columns"], ["pie", "Pie"]];
const SHARE_CHOICES = [["pie", "Pie"], ["bars", "Columns"]];
const ICON_LINE = svg(`<path d="M3 17l5-6 4 3 7-8"/><path d="M3 20h18"/>`);
const ICON_PIE = svg(`<path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M14.5 2.8a9 9 0 0 1 6.7 6.7h-6.7z"/>`);
const ICON_BARS = svg(`<path d="M5 20V11M10 20V5M15 20v-7M20 20V9"/>`);
const CHART_KIND_ICON = { line: ICON_LINE, pie: ICON_PIE, bars: ICON_BARS };
// tile sizes: a big square / a grid of small ones
const ICON_TILES_BIG = svg(`<rect x="4" y="4" width="16" height="16" rx="1.5"/>`);
const ICON_TILES_SMALL = svg(`<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16"/>`);
const DIST_BANDS = {
  run: [[0, 5000, "Under 5 km"], [5000, 10000, "5–10 km"], [10000, 21097.5, "10 km – half"], [21097.5, 42195, "Half – marathon"], [42195, Infinity, "Marathon +"]],
  ride: [[0, 25000, "Under 25 km"], [25000, 50000, "25–50 km"], [50000, 100000, "50–100 km"], [100000, 200000, "100–200 km"], [200000, Infinity, "200 km +"]],
};
const TEMP_BANDS = [[-Infinity, 0, "Below 0 °C"], [0, 10, "0–10 °C"], [10, 20, "10–20 °C"], [20, 30, "20–30 °C"], [30, Infinity, "30 °C +"]];
// WMO weather codes (the hour's worst) → a few kinds
const WEATHER_KINDS = [["Clear", (c) => c <= 1, "sun"], ["Cloudy", (c) => c <= 3, "cloud"], ["Fog", (c) => c >= 45 && c <= 48, "fog"],
  ["Rain", (c) => (c >= 51 && c <= 67) || (c >= 80 && c <= 82), "rain"], ["Snow", (c) => (c >= 71 && c <= 77) || c === 85 || c === 86, "snow"],
  ["Thunderstorm", (c) => c >= 95, "storm"]];
const skyLabel = (label, sky) => `<span class="tl-sky">${sky ? `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">${SKY_SVG[sky]}</svg>` : "<i></i>"}${label}</span>`;
const EARTH_KM = 40075, MOON_KM = 384400;

async function renderTimeline(params, sw) {
  const choices = STAT_X;
  let x = choices.some(([k]) => k === TAB.statsX) ? TAB.statsX : choices[0][0];
  const xBadge = badgeHtml("stat-x", "X-axis", choices.find(([k]) => k === x)[1], { panel: `<div class="opt-panel">${pickList("stat-x", choices, x)}</div>` });
  view.innerHTML = `${pageHead("Statistics", timeBadge(params) + typeBadge(params) + xBadge, sw)}<div data-tl><div class="page-loader">${loaderHtml()}</div></div>`;
  const head = view.querySelector(".page-head");
  bindBadges(head);
  bindFilterBadges(head, "#/stats", { ...params, tab: "timeline" }, { allTime: "all" });
  const box = view.querySelector("[data-tl]");
  const [lo, hi] = statWindow(params);
  const data = await api("stats/activities?" + new URLSearchParams({ person: CURRENT, steps_from: lo, steps_to: hi, ...filterQuery(params) }));
  if (!box.isConnected) return;
  const F = Object.fromEntries(data.fields.map((f, i) => [f, i]));
  const acts = data.items.map((r) => Object.fromEntries(Object.entries(F).map(([k, i]) => [k, r[i]])));
  if (!acts.length) { box.innerHTML = `<div class="card">${hint("No activities match the filters.")}</div>`; return; }
  const onFoot = acts.every((a) => ON_FOOT.has(a.group));
  if (!DIST_CHOICES.some(([k]) => k === TAB.tlChart)) TAB.tlChart = "bars"; TAB.tlShare ??= "pie"; TAB.tlVirtual ??= "in";
  box.innerHTML = `${tlSummary(acts, data.steps)}
    <div class="tl-grid">
      <div class="card tl-card" data-tl-card="hours"></div><div class="card tl-card" data-tl-card="days"></div>
      <div class="card tl-card" data-tl-card="types"></div><div class="card tl-card" data-tl-card="countries"></div>
    </div>
    <div class="tl-grid tl-grid3">
      <div class="card tl-card" data-tl-card="dist"></div><div class="card tl-card" data-tl-card="weather"></div><div class="card tl-card" data-tl-card="temp"></div>
    </div>
    <div class="card tl-tiles" data-tl-tiles></div>`;
  const draw = () => {
    tlCard(box, "hours", "Time of day", "timer_time", "tl-chart", TAB.tlChart, DIST_CHOICES, { ...tlHours(acts, onFoot), xTitle: "Hour" }, "Activities going on in each hour (an activity counts in every hour it spans)");
    tlCard(box, "days", "Day of the week", "date", "tl-chart", TAB.tlChart, DIST_CHOICES, { ...tlDays(acts, onFoot), xTitle: "Day" }, "Activities by the day they started");
    tlCard(box, "types", "Activity types", "type", "tl-share", TAB.tlShare, SHARE_CHOICES, { ...tlTypes(acts), xTitle: "Type" }, "Activities per type");
    tlCard(box, "countries", "Countries", "route", "tl-share", TAB.tlShare, SHARE_CHOICES, { ...tlCountries(acts, data.countries, TAB.tlVirtual === "in"), xTitle: "Country" },
      "Activities per country of the route. Indoor: without a route (treadmill, trainer) and, with virtual excluded, the virtual ones.",
      badgeHtml("tl-virtual-countries", "Virtual", TAB.tlVirtual === "in" ? "Included" : "Excluded", { panel: `<div class="opt-panel">${pickList("tl-virtual", [["in", "Included"], ["out", "Excluded"]], TAB.tlVirtual)}</div>`, right: true }));
    box.querySelector('[data-tl-card="dist"]').innerHTML = tlDistTable(acts);
    box.querySelector('[data-tl-card="weather"]').innerHTML = tlWeatherTable(acts, "kind");
    box.querySelector('[data-tl-card="temp"]').innerHTML = tlWeatherTable(acts, "temp");
    bindBadges(box.querySelector(".tl-grid"));
    const pick = (name, apply) => box.querySelectorAll(`[data-pick="${name}"], [data-switch="${name}"]`).forEach((b) => b.onclick = () => { apply(b.dataset.value); document.onclick?.(); draw(); });
    pick("tl-chart", (v) => { TAB.tlChart = v; });
    pick("tl-share", (v) => { TAB.tlShare = v; });
    pick("tl-virtual", (v) => { TAB.tlVirtual = v; });
  };
  draw();
  const tiles = box.querySelector("[data-tl-tiles]");
  const drawTiles = () => tlTiles(tiles, params, x);
  head.querySelectorAll('[data-pick="stat-x"]').forEach((b) => b.onclick = () => {
    head.querySelectorAll('[data-pick="stat-x"]').forEach((o) => { o.classList.toggle("on", o === b); o.setAttribute("aria-checked", o === b); });
    x = TAB.statsX = b.dataset.value;
    head.querySelector('[data-badge-value="stat-x"]').textContent = choices.find(([k]) => k === x)[1];
    document.onclick?.();
    drawTiles();
  });
  await drawTiles();
}

function tlSummary(acts, steps) {
  const dist = acts.reduce((t, a) => t + a.distance_m, 0), time = acts.reduce((t, a) => t + (a.distance_m ? a.time_s : 0), 0);
  const speed = time ? dist / time : null, kmTot = dist / 1000;
  return statStrip([
    ["Activities", num(acts.length), ""],
    ["Distance", `${num(kmTot, kmTot >= 1000 ? 0 : 1)} km`, ""],
    ["Avg distance", km(dist / acts.length), "per activity"],
    ["Avg speed", speed ? kmh(speed) : "–", speed ? pace(speed) : ""],
    ["Around the world", `× ${num(kmTot / EARTH_KM, 2)}`, `${num(EARTH_KM)} km`],
    ["To the Moon", `× ${num(kmTot / MOON_KM, 3)}`, `${num(MOON_KM)} km`],
    ...(steps ? [["Steps", num(steps), "daily data"]] : []),
  ]);
}

// Icons side by side, one per choice (no words; the name on hover), like the page's view switch.
const iconSwitch = (name, kinds, cur, icon) => `<div class="switch icon-switch" role="group">${kinds.map(([k, l]) =>
  `<button class="${k === cur ? "on" : ""}" data-switch="${name}" data-value="${k}" data-tip="${esc(l)}" aria-label="${esc(l)}">${icon(k)}</button>`).join("")}</div>`;
// One card: icon and title on the left, other badges and the chart kind icons on the right.
function tlCard(box, key, title, icon, pickName, kind, kinds, d, tip, extra = "") {
  const el = box.querySelector(`[data-tl-card="${key}"]`);
  el.innerHTML = `<div class="card-head"><h3 class="chart-title" data-tip="${esc(tip)}">${metricIcon(icon, 18)}<span>${title}</span></h3><span class="spacer"></span>
    <div class="badges">${extra}${iconSwitch(pickName, kinds, kind, (k) => CHART_KIND_ICON[k])}</div></div><div class="tl-chart"></div>`;
  const plot = el.querySelector(".tl-chart"), W = Math.round(plot.clientWidth) || 480;
  plot.innerHTML = d.items.length ? (kind === "pie" ? tlPie(d, W) : tlBars(d, kind === "line", W)) : hint("Nothing to show.");
}

// Averages of a set of activities for the tooltips: distance, elevation, pace or speed.
function tlAvg(list, onFoot) {
  const n = list.length || 1, dist = list.reduce((t, a) => t + a.distance_m, 0), time = list.reduce((t, a) => t + (a.distance_m ? a.time_s : 0), 0);
  const sp = time ? dist / time : null;
  return [`Avg distance <b>${km(dist / n)}</b>`, `Avg elevation <b>${meters(list.reduce((t, a) => t + a.ascent_m, 0) / n)}</b>`,
    `${onFoot ? "Avg pace" : "Avg speed"} <b>${sp ? (onFoot ? pace(sp) : kmh(sp)) : "–"}</b>`].join("\n");
}
const tlTip = (title, n, list, onFoot) => `<b>${esc(title)}</b>\n${num(n)} ${n === 1 ? "activity" : "activities"}${n ? `\n${tlAvg(list, onFoot)}` : ""}`;
const localMs = (s) => Date.parse(s + "Z");

function tlHours(acts, onFoot) {
  const per = [...Array(24)].map(() => []);
  for (const a of acts) {
    const t0 = localMs(a.start), t1 = t0 + Math.max(60, a.elapsed_s) * 1000;
    const seen = new Set();
    for (let t = t0 - (t0 % 3600000); t < t1; t += 3600000) { const h = new Date(t).getUTCHours(); if (!seen.has(h)) { seen.add(h); per[h].push(a); } }
  }
  return { items: per.map((l, h) => ({ label: `${String(h).padStart(2, "0")}:00`, value: l.length, color: SERIES_COLORS[h % SERIES_COLORS.length],
    tip: tlTip(`${String(h).padStart(2, "0")}:00–${String((h + 1) % 24).padStart(2, "0")}:00`, l.length, l, onFoot) })), every: 3,
    oneColor: true }; // an activity counts in every hour it spans: the hours add up to more
}
function tlDays(acts, onFoot) {
  const per = [...Array(7)].map(() => []);
  for (const a of acts) per[(new Date(localMs(a.start)).getUTCDay() + 6) % 7].push(a);
  return { items: per.map((l, d) => ({ label: WEEKDAYS[d], value: l.length, color: SERIES_COLORS[d % SERIES_COLORS.length], tip: tlTip(WEEKDAYS_FULL[d], l.length, l, onFoot) })), every: 1, oneColor: true };
}
// A share chart's items: every group its own, the biggest first. Colours: the series colours,
// then further hues (no colour twice on one ring).
const shareColor = (k) => (k < SERIES_COLORS.length ? SERIES_COLORS[k] : `hsl(${(k * 67 + 20) % 360} 42% 62%)`);
function tlShares(groups, onFootOf = () => false) {
  const list = [...groups].sort((p, q) => q[1].length - p[1].length);
  return { items: list.map(([label, l], k) => ({ label, value: l.length, color: shareColor(k),
    tip: `${tlTip(label, l.length, l, onFootOf(l))}\nDistance <b>${km(l.reduce((t, a) => t + a.distance_m, 0))}</b>\nTime <b>${hours(l.reduce((t, a) => t + a.time_s, 0))}</b>` })) };
}
function tlTypes(acts) {
  const by = new Map();
  for (const a of acts) { const k = typeLabel(a.type); by.set(k, [...(by.get(k) || []), a]); }
  return { ...tlShares(by, (l) => l.every((a) => ON_FOOT.has(a.group))), middle: [by.size, by.size === 1 ? "type" : "types"] };
}
function tlCountries(acts, names, withVirtual) {
  const by = new Map();
  for (const a of acts) {
    const virtual = String(a.type || "").startsWith("virtual_");
    const k = a.country && (withVirtual || !virtual) ? names[a.country] || a.country : a.indoor || virtual ? "Indoor" : "No route";
    by.set(k, [...(by.get(k) || []), a]);
  }
  const n = [...by.keys()].filter((k) => k !== "Indoor" && k !== "No route").length; // real countries only
  return { ...tlShares(by, (l) => l.every((a) => ON_FOOT.has(a.group))), middle: [n, n === 1 ? "country" : "countries"] };
}

// Line or columns: one value per item, drawn at the card's own width (1 px = 1 px, so the text
// keeps its size): framed plot, dashed grid, y labels and title, the labels under the axis
// (every `every`-th; long ones cut) and the x title.
const niceStep = (v) => { const p = 10 ** Math.floor(Math.log10(v || 1)), f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
const TL_H = 240;
// oneColor: every column in the series colour (hours, days); else each item its own (types).
function tlBars({ items, every = 1, xTitle = "", yTitle = "Activities", oneColor = false }, line, W = 480) {
  const H = TL_H, L = 52, R = 8, T = 8, B = 40, max = Math.max(1, ...items.map((i) => i.value));
  const step = Math.max(1, niceStep(max / 4)), top = Math.ceil((max * 1.05) / step) * step;
  const pw = W - L - R, ph = H - T - B, cw = pw / items.length, X = (k) => L + cw * (k + 0.5), Y = (v) => T + ph * (1 - v / top);
  const ticks = [...Array(Math.round(top / step) + 1)].map((_, k) => k * step);
  const grid = ticks.map((v) => `${v && v < top ? `<line x1="${L}" x2="${L + pw}" y1="${Y(v)}" y2="${Y(v)}" class="tl-grid-line"/>` : ""}<text x="${L - 6}" y="${Y(v) + 4}" class="tl-ylab">${num(v)}</text>`).join("");
  const maxChars = Math.max(3, Math.floor((cw * every) / 6.5));
  const cutText = (t) => (t.length > maxChars ? `${t.slice(0, maxChars - 1)}…` : t);
  const labels = items.map((it, k) => (k % every ? "" : `<text x="${X(k)}" y="${T + ph + 16}" class="tl-xlab">${esc(cutText(it.label))}</text>`)).join("");
  const c = SERIES_COLORS[0];
  const path = items.map((it, k) => `${k ? "L" : "M"}${X(k).toFixed(1)} ${Y(it.value).toFixed(1)}`).join("");
  const marks = line
    ? `<path d="${path}L${X(items.length - 1).toFixed(1)} ${Y(0)}L${X(0).toFixed(1)} ${Y(0)}Z" class="tl-area" style="--c:${c}"/><path d="${path}" class="tl-line" style="--c:${c}"/>
       ${items.map((it, k) => `<circle cx="${X(k)}" cy="${Y(it.value)}" r="2" class="tl-dot" style="--c:${c}"/>`).join("")}`
    : items.map((it, k) => `<rect x="${X(k) - Math.min(28, cw * 0.36)}" y="${Y(it.value)}" width="${Math.min(56, cw * 0.72)}" height="${Math.max(0, Y(0) - Y(it.value))}" rx="2" class="tl-bar" style="--c:${oneColor ? c : it.color}"/>`).join("");
  const hits = items.map((it, k) => `<rect x="${X(k) - cw / 2}" y="${T}" width="${cw}" height="${ph}" class="tl-hit" data-tip-html="${esc(it.tip)}"/>`).join("");
  const titles = `<text x="12" y="${T + ph / 2}" transform="rotate(-90 12 ${T + ph / 2})" class="tl-atitle">${esc(yTitle)}</text>`
    + (xTitle ? `<text x="${L + pw / 2}" y="${H - 4}" class="tl-atitle">${esc(xTitle)}</text>` : "");
  return `<svg class="tl-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${grid}${marks}<rect x="${L + 0.5}" y="${T + 0.5}" width="${pw - 1}" height="${ph - 1}" class="tl-frame"/>${labels}${titles}${hits}</svg>`;
}
// Pie: a ring in the middle of the card, each slice labelled beside it (name and share) on a
// short leader line; labels on one side pushed apart so they never overlap. No total inside.
// Slices under PIE_LABEL_MIN of the ring get no label (their tooltip still tells).
const PIE_LABEL_MIN = 0.01;
// middle: [count, word] in the ring (how many countries, types), or nothing (hours, days).
function tlPie({ items, middle = null }, W = 480) {
  const total = items.reduce((t, i) => t + i.value, 0) || 1;
  // higher with many labels: the small slices often sit on one side, one label line each
  const H = Math.max(300, items.filter((i) => i.value / total >= PIE_LABEL_MIN).length * 17 + 30), cx = W / 2, cy = H / 2;
  const R = Math.round(Math.min(96, Math.max(56, W * 0.17))), r = Math.round(R * 0.62); // narrow cards: room for the labels
  // the biggest slice centred on the right: the rest fills the left from the bottom up, so
  // their labels spread down the left side instead of fanning out from one spot
  let a0 = -Math.PI * ((items.find((i) => i.value)?.value || 0) / total);
  const pt = (rad, a) => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
  const p = (rad, a) => pt(rad, a).map((v) => v.toFixed(2)).join(" ");
  const slices = items.filter((i) => i.value).map((it) => {
    const a1 = a0 + (2 * Math.PI * it.value) / total, big = a1 - a0 > Math.PI ? 1 : 0, mid = (a0 + a1) / 2;
    const d = it.value === total ? `M${cx} ${cy - R}A${R} ${R} 0 1 1 ${cx - 0.01} ${cy - R}L${cx - 0.01} ${cy - r}A${r} ${r} 0 1 0 ${cx} ${cy - r}Z`
      : `M${p(R, a0)}A${R} ${R} 0 ${big} 1 ${p(R, a1)}L${p(r, a1)}A${r} ${r} 0 ${big} 0 ${p(r, a0)}Z`;
    a0 = a1;
    return { it, d, mid, right: Math.cos(mid) >= 0 };
  });
  // labels at the slice's height, pushed apart (16 px) and kept inside the card on each side
  const labelled = slices.filter((x) => x.it.value / total >= PIE_LABEL_MIN);
  for (const side of [true, false]) {
    const list = labelled.filter((x) => x.right === side).sort((a, b) => pt(R, a.mid)[1] - pt(R, b.mid)[1]);
    let y = -Infinity;
    for (const x of list) { x.ly = Math.max(pt(R + 14, x.mid)[1], y + 16, 10); y = x.ly; }
    const over = y - (H - 8);
    if (over > 0) for (const x of list) x.ly -= over;
  }
  const labels = labelled.map(({ it, mid, right, ly }) => {
    const [ax, ay] = pt(R + 2, mid), [ex, ey] = pt(R + 14, mid), lx = cx + (right ? 1 : -1) * (R + 30);
    return `<path d="M${ax.toFixed(1)} ${ay.toFixed(1)}L${ex.toFixed(1)} ${ey.toFixed(1)}L${lx.toFixed(1)} ${ly.toFixed(1)}" class="tl-leader"/>
      <text x="${(lx + (right ? 4 : -4)).toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="${right ? "start" : "end"}" class="tl-plab" data-tip-html="${esc(it.tip)}">${esc(it.label)} <tspan class="tl-pval">${num((it.value / total) * 100)}% (${num(it.value)})</tspan></text>`;
  }).join("");
  const arcs = slices.map(({ it, d }) => `<path d="${d}" class="tl-slice" style="--c:${it.color}" data-tip-html="${esc(it.tip)}"/>`).join("");
  return `<svg class="tl-svg tl-pie" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${arcs}${labels}
${middle ? `<text x="${cx}" y="${cy + 2}" class="tl-pie-total">${num(middle[0])}</text><text x="${cx}" y="${cy + 20}" class="tl-pie-sub">${esc(middle[1])}</text>` : ""}</svg>`;
}

// A breakdown: one table per section [heading html | null, rows [label html, activities]],
// each with its column heads (count, distance, share of the section's activities) and its
// heading in the first of them.
function tlTable(title, icon, sections, tip) {
  const tables = sections.map(([headHtml, rows]) => {
    const n = rows.reduce((t, [, l]) => t + l.length, 0) || 1;
    // tables one under another: one set of column widths, so they line up
    const cols = sections.length > 1 ? `<colgroup><col><col style="width:21%"><col style="width:31%"><col style="width:15%"></colgroup>` : "";
    return `<table class="data tl-table${cols ? " tl-fixed" : ""}">${cols}<thead><tr><th class="tl-sub">${headHtml || ""}</th><th class="num">Activities</th><th class="num">Distance</th><th class="num">Share</th></tr></thead>
      <tbody>${rows.map(([label, l]) => `<tr${l.length ? "" : ' class="tl-zero"'}><td>${label}</td><td class="num">${num(l.length)}</td>
      <td class="num">${km(l.reduce((t, a) => t + a.distance_m, 0))}</td><td class="num">${num((l.length / n) * 100)}%</td></tr>`).join("")}</tbody></table>`;
  }).join("");
  return `<div class="card-head"><h3 class="chart-title" data-tip="${esc(tip)}">${metricIcon(icon, 18)}<span>${title}</span></h3></div>${tables}`;
}
function tlDistTable(acts) {
  const secs = [["run", "Running"], ["ride", "Cycling"]].map(([g, headText]) => {
    const list = acts.filter((a) => a.group === g);
    return list.length ? [`${typeIcon(g)}<span>${headText}</span>`, DIST_BANDS[g].map(([a, b, l]) => [l, list.filter((x) => x.distance_m >= a && x.distance_m < b)])] : null;
  }).filter(Boolean);
  return secs.length ? tlTable("Distance breakdown", "distance_total", secs, "Runs and rides by their distance")
    : `<div class="card-head"><h3 class="chart-title">${metricIcon("distance_total", 18)}<span>Distance breakdown</span></h3></div>${hint("No runs or rides.")}`;
}
// Outdoors for sure: a route was recorded, the activity is not marked indoor and not virtual.
const isOutdoor = (a) => a.gps && !a.indoor && !String(a.type || "").startsWith("virtual_");
// Weather (kind) or temperature breakdown, from the weather of each activity (Open-Meteo, the
// hour and the area: weather.py), not from the watch's sensor.
function tlWeatherTable(acts, what) {
  const title = what === "temp" ? "Temperature breakdown" : "Weather breakdown", icon = what === "temp" ? "temperature" : "weather";
  const out = acts.filter(isOutdoor), known = out.filter((a) => a.weather), unknown = out.filter((a) => !a.weather);
  if (!out.length) return `<div class="card-head"><h3 class="chart-title">${metricIcon(icon, 18)}<span>${title}</span></h3></div>${hint("No outdoor activities.")}`;
  const temp = TEMP_BANDS.map(([a, b, l]) => [l, known.filter((x) => x.weather[0] >= a && x.weather[0] < b)]);
  const kind = WEATHER_KINDS.map(([l, , sky]) => [skyLabel(l, sky), []]);
  for (const a of known) { const k = WEATHER_KINDS.findIndex(([, f]) => f(a.weather[1] ?? 0)); if (k >= 0) kind[k][1].push(a); }
  kind.sort((p, q) => q[1].length - p[1].length); // the most common first; Unknown stays last
  const unk = unknown.length ? [["Unknown", unknown]] : [];
  const tip = "Outdoor activities only (a route, not indoor, not virtual), from the weather of the hour and the area (not the watch's sensor). Unknown: its weather is still being fetched in the background (or the weather server had none).";
  const unkSky = unknown.length ? [[skyLabel("Unknown", null), unknown]] : [];
  return what === "temp" ? tlTable(title, icon, [[null, [...temp, ...unk]]], tip) : tlTable(title, icon, [[null, [...kind, ...unkSky]]], tip);
}

// Explorer tiles: the Size badge drives the summary strip and both charts.
const TILE_SIZE_NAMES = Object.fromEntries(TILE_SIZES);
async function tlTiles(el, params, by) {
  const q = { person: CURRENT };
  const types = filterQuery(params).types;
  if (types) q.types = types;
  const key = JSON.stringify(q);
  if (TAB.tileTracks?.key !== key || !TAB.tileTracks.tracks[0]?.id) {
    const d = await api("heatmap/tracks?" + new URLSearchParams(q));
    TAB.tileTracks = { key, tracks: d.items.map((t) => ({ id: t.id, day: t.day, coords: lonLat(t.polyline) })), firsts: {} };
  }
  const T = TAB.tileTracks;
  STAT_CHARTS.forEach((c) => c?.destroy?.());
  STAT_CHARTS = [];
  if (!el.isConnected) return;
  if (!T.tracks.length) { el.hidden = true; return; }
  const z = TAB.tlZoom ??= 14;
  const [lo0, hi] = statWindow(params);
  const lo = lo0 < T.tracks[0].day ? T.tracks[0].day : lo0;
  const inWin = T.tracks.filter((t) => t.day >= lo && t.day <= hi);
  const sizeSwitch = iconSwitch("tl-zoom", TILE_SIZES, z, (k) => (k === 13 ? ICON_TILES_BIG : ICON_TILES_SMALL));
  el.innerHTML = `<div class="card-head"><h3 class="chart-title" data-tip="Map tiles of the routes in this period, for the size chosen (as on Map › Explorer tiles)">${metricIcon("tiles", 18)}<span>${TILE_SIZE_NAMES[z]}</span></h3><span class="spacer"></span>${sizeSwitch}</div>
    ${tlTileStats(inWin, z)}`;
  const chartsBox = el.parentElement.querySelector("[data-tl-tchart]") || el.insertAdjacentElement("afterend", Object.assign(document.createElement("div"), { className: "charts" }));
  chartsBox.dataset.tlTchart = "";
  const bindSize = (root) => root.querySelectorAll('[data-switch="tl-zoom"]').forEach((b) => b.onclick = () => { TAB.tlZoom = Number(b.dataset.value); tlTiles(el, params, by); });
  bindSize(el);
  // the tiles visited by the end of each period (tiles first visited before the Time filter
  // count from its start) and the new ones in each period
  const starts = [];
  if (by === "week") for (let d = mondayOf(lo); d <= hi; d = addDays(d, 7)) starts.push(d);
  else if (by === "month") for (let y = +lo.slice(0, 4), m = +lo.slice(5, 7); `${y}-${String(m).padStart(2, "0")}-01` <= hi; m === 12 ? (y++, m = 1) : m++) starts.push(`${y}-${String(m).padStart(2, "0")}-01`);
  else for (let y = +lo.slice(0, 4); `${y}-01-01` <= hi; y++) starts.push(`${y}-01-01`);
  const ends = starts.map((s, k) => (k + 1 < starts.length ? addDays(starts[k + 1], -1) : hi));
  T.firsts[z] ??= [...computeTiles(T.tracks, z).values()].map((t) => t.first).sort();
  const f = T.firsts[z];
  let j = 0;
  const total = ends.map((e) => { while (j < f.length && f[j] <= e) j++; return j; });
  const before = f.filter((d) => d < starts[0]).length;
  const fresh = total.map((v, k) => v - (k ? total[k - 1] : before));
  const color = SERIES_COLORS[TILE_SIZES.findIndex(([k]) => k === z) % SERIES_COLORS.length];
  const name = TILE_SIZE_NAMES[z].toLowerCase();
  const last = total.length - 1, top = Math.max(...fresh), avg = fresh.reduce((t, v) => t + v, 0) / (fresh.length || 1);
  STAT_CHARTS = [chartGroup(chartsBox, {
    x: { date: starts.map((d) => dayMs(d) / 1000) }, kind: "date",
    series: [
      { key: "tiles-total", label: "Tiles", title: `${TILE_SIZE_NAMES[z]}, cumulative`, icon: "tiles", yTitle: "Tiles visited", unit: "", dec: 0, values: total, color, height: 300, headHtml: sizeSwitch,
        tip: `All ${name} visited by the end of each period.`, tags: [{ label: "Tiles", value: total[last], i: last, color, text: num(total[last]) }] },
      { key: "tiles-new", label: "New", title: `New ${name} per ${by}`, icon: "tiles", yTitle: "New tiles", unit: "", dec: 0, values: fresh, color, bars: true, height: 240, headHtml: sizeSwitch,
        tip: `${TILE_SIZE_NAMES[z]} visited for the first time in each period.`, tags: [{ label: "Most", value: top, i: fresh.indexOf(top), color, text: num(top) },
          { label: `Avg / ${by}`, value: avg, i: last, color, text: num(avg, avg < 10 ? 1 : 0) }] }, // the average over the periods shown
    ],
  })];
  bindSize(chartsBox);
}

// The summary strip of the tiles in the period (the measures of Map › Explorer tiles and more).
function tlTileStats(tracks, z) {
  const tiles = computeTiles(tracks, z);
  if (!tiles.size) return statStrip([["Tiles", "0", ""]]);
  const has = (x, y) => tiles.has(tileKey(x, y));
  const sq = maxSquare(tiles), clus = clusterOf(tiles);
  const inner = [...tiles.values()].filter((t) => has(t.x - 1, t.y) && has(t.x + 1, t.y) && has(t.x, t.y - 1) && has(t.x, t.y + 1)).length;
  const span = clus.length ? Math.max(Math.max(...clus.map((t) => t.x)) - Math.min(...clus.map((t) => t.x)), Math.max(...clus.map((t) => t.y)) - Math.min(...clus.map((t) => t.y))) + 1 : 0;
  // the largest group of tiles touching side by side
  const seen = new Set();
  let connected = 0;
  for (const [k, t0] of tiles) {
    if (seen.has(k)) continue;
    const stack = [t0];
    seen.add(k);
    let n = 0;
    while (stack.length) {
      const t = stack.pop();
      n++;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nk = tileKey(t.x + dx, t.y + dy); if (tiles.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(tiles.get(nk)); } }
    }
    connected = Math.max(connected, n);
  }
  // the longest unbroken column and row
  const run = (col) => {
    let best = 0;
    for (const t of tiles.values()) {
      if (col ? has(t.x, t.y - 1) : has(t.x - 1, t.y)) continue; // not the start of a run
      let n = 1;
      while (col ? has(t.x, t.y + n) : has(t.x + n, t.y)) n++;
      best = Math.max(best, n);
    }
    return best;
  };
  const most = [...tiles.values()].reduce((b, t) => (t.visits > b.visits ? t : b));
  const perAct = tracks.map((t) => [t, computeTiles([t], z).size]).reduce((b, p) => (p[1] > b[1] ? p : b), [null, 0]);
  return statStrip([
    ["Tiles", num(tiles.size), ""],
    ["Max square", sq.size ? `${sq.size} × ${sq.size}` : "–", ""],
    ["Max cluster", num(clus.length), "tiles"],
    ["Cluster tiles", num(inner), "with 4 neighbours"],
    ["Cluster span", num(span), "tiles across"],
    ["Connected tiles", num(connected), "touching side by side"],
    ["Longest column", num(run(true)), "tiles"],
    ["Longest row", num(run(false)), "tiles"],
    ["Most visited", num(most.visits), "visits of one tile"],
    ["One activity", num(perAct[1]), perAct[0] ? `<a href="#/activity/${perAct[0].id}">${esc(perAct[0].day)}</a>` : ""],
  ]);
}
