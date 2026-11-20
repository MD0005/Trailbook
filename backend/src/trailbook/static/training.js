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
const ICON_TOTALS = svg(`<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>`);
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

async function renderCalendar(params) {
  const mode = params.view === "year" ? "year" : "month";
  if (mode === "year") return renderCalendarYear(params);
  const today = todayIso();
  // always one whole week ahead, and one after the last planned workout
  let newest = addDays(mondayOf(today), 7);
  const first = TIME_RANGE.first && TIME_RANGE.first < today ? TIME_RANGE.first : today;
  const oldest = mondayOf(first);
  const target = /^\d{4}-\d{2}-\d{2}$/.test(params.date || "") ? params.date : null;
  const anchor = target ? mondayOf(target < first ? first : target > today ? today : target) : null;
  let top = anchor ? [addDays(anchor, 14), newest].sort()[0] : newest;
  let bottom = [anchor ? addDays(anchor, -21) : addDays(newest, -7 * (CAL_BATCH - 1)), oldest].sort().reverse()[0];
  const isAll = CURRENT === "all";
  CAL_MONTHS.clear(); // data may have changed since the last visit

  const fetchWeeks = (a, b) => api("calendar?" + new URLSearchParams({ from: a, to: addDays(b, 6), chart: "1", planned: "1", ...personParam() }));
  const [data, fc] = await Promise.all([fetchWeeks(bottom, top), calForecast()]);
  if (data.last_planned && addDays(mondayOf(data.last_planned), 7) > newest) {
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
      <span class="cal-act-chart" title="${esc(actFacts(a))}">${chart.startsWith("<svg") ? chart : `<span class="tile-sport">${typeIcon(a.activity_type, 26)}</span>`}</span></a>`;
  };
  // Hovering the chart: distance, time, pace (on foot) or power / speed (rides), load.
  const actFacts = (a) => {
    const foot = ["run", "walk", "hike"].includes(a.category);
    const speed = a.distance_m && a.time_s ? a.distance_m / a.time_s : a.avg_speed;
    return [a.distance_m >= 50 ? km(a.distance_m) : "", dur(a.time_s),
      foot && speed ? pace(speed) : "", !foot && a.avg_power ? watts(a.avg_power) : !foot && speed && a.distance_m ? unit(speed * 3.6, "km/h", 1) : "",
      a.load ? `load ${num(a.load)}` : ""].filter(Boolean).join(" · ");
  };
  // One line each: in a narrow day the long forms give way to short ones (CSS container
  // queries: `full` / `short`), the full values stay in the tooltip.
  const both = (full, short) => `<span class="cal-full">${full}</span><span class="cal-short">${short}</span>`;
  // The day's line: its number, then its values (steps, floors, stress); days from today on
  // without values: day length and the forecast on the same line.
  const dayHead = (d, v) => {
    const parts = [];
    let weather = "";
    const k = (n) => (n < 10000 ? `${num(n / 1000, 1)}k` : `${num(n / 1000, 0)}k`);
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
    return `<div class="cal-dh"><span class="cal-num">${label}</span>${parts.join("")}</div>${weather}`;
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

  const showSummary = TAB.kpis ?? false;
  const single = !isAll && CURRENT;
  const showTray = single && (TAB.workouts ?? false);
  const sw = switchHtml("calview", [["month", `${ICON_CAL_MONTH}<span>Month</span>`], ["year", `${ICON_CAL_YEAR}<span>Year</span>`]], mode);
  view.innerHTML = `${pageHead("Calendar", `${gotoBadge(target)}${single ? `${badgeHtml("ctargets", "Targets", "", { panel: `<div class="opt-panel targets-panel" data-targets></div>` })}<button class="badge ${showTray ? "on" : ""}" data-cworkouts>Workouts</button>` : ""}<button class="badge ${showSummary ? "on" : ""}" data-ckpis>Summary</button>`, sw)}
    <div class="cal-sticky" data-csticky>
      <div data-csummary ${showSummary ? "" : "hidden"}></div>
      <div data-ctray ${showTray ? "" : "hidden"}></div>
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

  // The summary and the weekday names stay under the page header; the summary is the month
  // of the first week row below them (its Thursday's month).
  const sticky = view.querySelector("[data-csticky]"), weeks = view.querySelector("[data-weeks]");
  const head = view.querySelector(".page-head");
  const placeSticky = () => { sticky.style.top = `${parseFloat(getComputedStyle(head).top) + head.offsetHeight + 6}px`; };
  placeSticky();
  let month = null;
  const activeMonth = () => {
    const edge = sticky.getBoundingClientRect().bottom + 4;
    const row = [...weeks.children].find((r) => r.getBoundingClientRect().bottom > edge) || weeks.lastElementChild;
    return row ? addDays(row.dataset.week, 3).slice(0, 7) : today.slice(0, 7);
  };
  const paintSummary = async () => {
    const box = view.querySelector("[data-csummary]");
    if (!box || box.hidden) return;
    const m = activeMonth();
    if (m === month) return;
    month = m;
    const html = await calMonthSummary(m);
    if (month === m) box.innerHTML = html;
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
    paintSummary();
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
  const sw = switchHtml("calview", [["month", `${ICON_CAL_MONTH}<span>Month</span>`], ["year", `${ICON_CAL_YEAR}<span>Year</span>`]], "year");
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
const FITNESS_SECTIONS = [["fitness", "Fitness", ICON_FITNESS], ["form", "Form", ICON_FORM]];
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

function fitnessShown() {
  const raw = store.get("fitness-sections");
  const keys = FITNESS_SECTIONS.map(([k]) => k);
  return new Set(raw == null ? keys : raw.split(",").filter((k) => keys.includes(k)));
}

// Fitness › Options, saved per person on the server (like the Map options).
const FITNESS_OPTIONS = { activities: "on", fill: "fill", fatigue: "on", zones: "on" };
const fitnessOptions = () => ({ ...FITNESS_OPTIONS, ...(UI.data["fitness-options"] || {}) });

async function renderFitness(params) {
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
    x: Date.parse(a.day + "T00:00:00Z") / 1000, icon: typeIcon(a.activity_type, 16), href: `#/activity/${a.id}`,
    tip: [a.name || typeLabel(a.activity_type), `${typeLabel(a.activity_type)} · ${a.day}`, [shortDur(a.time_s), a.distance_m >= 50 ? km(a.distance_m) : ""].filter(Boolean).join(" · ")].join("\n"),
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
  return [
    { key: "fitness", label: "Fitness", title: opt.fatigue === "off" ? "Fitness" : "Fitness and fatigue", yTitle: "Training load per day", unit: "", dec: 0, height: 396,
      color: COLORS.ctl, iconHtml: ICON_FITNESS, values: ctl, lines: opt.fatigue === "off" ? [] : [{ label: "Fatigue", color: COLORS.atl, values: atl }],
      fill: opt.fill === "fill", marks, marksHidden: opt.activities === "off",
      tip: "Fitness: 42-day average of the daily training load. Fatigue: the same over 7 days.",
      tags: [tag("Fitness", ctl, last, COLORS.ctl, 0, false), ...(opt.fatigue === "off" ? [] : [tag("Fatigue", atl, last, COLORS.atl, 0, false)])] },
    { key: "form", label: "Form", title: "Form", yTitle: "Form", unit: "", dec: 0, height: 259, color: COLORS.neutral, iconHtml: ICON_FORM,
      values: tsb, zones: zonesOf(FORM_ZONES), bands: opt.zones !== "off", yMin: -40, yMax: 30, ySplits: [-40, -30, -10, 5, 25],
      tip: "Yesterday's fitness minus fatigue: higher = fresher, lower = more tired. Training builds fitness in the optimal zone below the grey zone.",
      tags: [tag("Form", tsb, last, zc(FORM_ZONES, tsb[last])), tag("Freshest", tsb, fresh, zc(FORM_ZONES, tsb[fresh])), tag("Most tired", tsb, tired, zc(FORM_ZONES, tsb[tired]))] },
  ];
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
  bindFilterBadges(head, "#/fitness", params);
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

const STAT_METRICS = [["time_s", "Time"], ["distance_m", "Distance"], ["ascent_m", "Elevation gain"], ["load", "Training load"], ["count", "Activities"]];
const fmtMetric = (k, v) => (k === "time_s" ? hours(v) : k === "distance_m" ? km(v) : k === "ascent_m" ? meters(v) : k === "load" ? loadUnit(v) : num(v || 0));
const RECORD_LABELS = {
  pace: { 400: "400 m", 1000: "1 km", 1609.344: "1 mile", 5000: "5 km", 10000: "10 km", 21097.5: "Half marathon", 42195: "Marathon" },
  power: { 5: "5 s", 15: "15 s", 30: "30 s", 60: "1 min", 300: "5 min", 600: "10 min", 1200: "20 min", 3600: "60 min" },
  hr: { 60: "1 min", 300: "5 min", 1200: "20 min", 3600: "60 min" },
};

async function renderStats(params) {
  const tab = params.tab === "records" ? "records" : "totals";
  const sw = switchHtml("stab", [["totals", `${ICON_TOTALS}<span>Totals</span>`], ["records", `${ICON_RECORDS}<span>Records</span>`]], tab);
  if (tab === "records") await renderRecords(params, sw);
  else await renderTotals(params, sw);
  view.querySelectorAll("[data-switch=stab]").forEach((b) => b.onclick = () => { location.hash = "#/stats?tab=" + b.dataset.value; });
}

async function renderTotals(params, sw) {
  const oneYear = (params.from && params.to && params.from.slice(0, 4) === params.to.slice(0, 4)) || yearList(params).length === 1
    || ["1m", "3m", "6m", "ytd"].includes(params.last);
  const by = ["year", "month", "week"].includes(params.by) ? params.by : (oneYear ? "month" : "year");
  const metric = STAT_METRICS.some(([k]) => k === params.metric) ? params.metric : "time_s";
  const q = { person: CURRENT, by, ...filterQuery(params) };
  const data = await api("stats/totals?" + new URLSearchParams(q));
  const route = "#/stats";
  const optionsPanel = `<div class="panel-grid">
      ${section("Group by", `<select data-pfilter="by">${[["year", "Year"], ["month", "Month"], ["week", "Week"]].map(([v, l]) => `<option value="${v}" ${v === by ? "selected" : ""}>${l}</option>`).join("")}</select>`)}
      ${section("Chart", `<select data-pfilter="metric">${STAT_METRICS.map(([v, l]) => `<option value="${v}" ${v === metric ? "selected" : ""}>${l}</option>`).join("")}</select>`)}
    </div><div class="panel-actions"><button class="primary small" data-apply>Apply</button></div>`;
  const badges = timeBadge(params) + typeBadge(params) + badgeHtml("options", "Options", "", { panel: optionsPanel });
  const rows = data.rows;
  const t = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
  const strip = statStrip([
    ["Activities", num(t("count")), `${num(t("active_days"))} active days`],
    ["Distance", km(t("distance_m"))],
    ["Time", hours(t("time_s"))],
    ["Elevation gain", meters(t("ascent_m"))],
    ["Training load", loadUnit(t("load"))],
    ["Calories", kcal(t("calories"))],
  ]);
  const max = Math.max(1, ...rows.map((r) => r[metric] || 0));
  const periodLabel = (p) => (by === "month" ? `${MONTHS[+p.slice(5, 7) - 1].slice(0, 3)} ${p.slice(2, 4)}` : by === "week" ? p.replace("-W", " W") : p);
  const chart = rows.length ? `<div class="bars-v">${rows.map((r) => `<div class="bar-v" title="${esc(periodLabel(r.period))}: ${fmtMetric(metric, r[metric])}">
      <span class="bar-v-val">${fmtMetric(metric, r[metric])}</span>
      <span class="bar-v-fill" style="height:${((r[metric] || 0) / max) * 100}%"></span>
      <span class="bar-v-label">${esc(periodLabel(r.period))}</span></div>`).join("")}</div>` : hint("No activities match the filters.");
  const gmax = Math.max(1, ...data.groups.map((g) => g.time_s || 0));
  view.innerHTML = `${pageHead("Statistics", badges, sw)}${strip}
    <div class="card"><h3>${STAT_METRICS.find(([k]) => k === metric)[1]} per ${by}</h3>${chart}</div>
    <div class="two-col wide-first">
      <div class="card"><h3>Totals per ${by}</h3><div class="scroll"><table class="data">
        <thead><tr><th>${by[0].toUpperCase() + by.slice(1)}</th><th class="num">Activities</th><th class="num">Active days</th><th class="num">Distance</th><th class="num">Time</th><th class="num">Elevation gain</th><th class="num">Load</th></tr></thead>
        <tbody>${[...rows].reverse().map((r) => `<tr><td>${by === "year" ? `<a href="#/stats?${new URLSearchParams({ ...filterQuery(params), from: "", to: "", last: "", years: r.period, by: "month", metric })}">${r.period}</a>` : esc(periodLabel(r.period))}</td>
          <td class="num">${num(r.count)}</td><td class="num">${num(r.active_days)}</td><td class="num">${km(r.distance_m)}</td><td class="num">${hours(r.time_s)}</td><td class="num">${meters(r.ascent_m)}</td><td class="num">${loadUnit(r.load)}</td></tr>`).join("")}</tbody></table></div></div>
      <div class="card"><h3>By activity group</h3>${hint("Time")}
        ${data.groups.map((g) => `<div class="bar-row"><span class="bar-label tb-activity-name">${groupIcon(g.category)}<span>${esc(groupLabel(g.category))}</span></span><span class="bar"><span style="width:${((g.time_s || 0) / gmax) * 100}%;background:var(--accent)"></span></span><span class="bar-value">${hours(g.time_s)}</span></div>`).join("") || hint("–")}
      </div>
    </div>`;
  bindBadges(view.querySelector(".page-head"));
  bindStagedFilter(view.querySelector(".page-head"), route, { tab: "totals", ...params });
  bindFilterBadges(view.querySelector(".page-head"), route, { tab: "totals", ...params }, { drop: ["by"] });
}

async function renderRecords(params, sw) {
  const kind = ["pace", "power", "hr"].includes(params.kind) ? params.kind : "pace";
  const fq = filterQuery(params);
  if (kind === "pace") fq.types = "g:run";
  const filtered = timeActive(params);
  const q = (f) => api("stats/records?" + new URLSearchParams({ person: CURRENT, kind, ...f }));
  const [data, all] = await Promise.all([q(fq), filtered ? q({ ...fq, from: "", to: "", last: "", years: "" }) : null]);
  const labels = RECORD_LABELS[kind];
  const fmt = (r) => (kind === "pace"
    ? `${dur(r.value)} <span class="hint">${pace(r.key / r.value)}</span>`
    : kind === "power" ? watts(r.value) : bpm(r.value));
  const rangeLabel = timeLabel(params);
  const controls = `<div class="seg">${[["pace", "Running pace"], ["power", "Power"], ["hr", "Heart rate"]].map(([k, l]) => `<button class="${k === kind ? "on" : ""}" data-kind="${k}">${l}</button>`).join("")}</div>`;
  const best = Object.fromEntries((all?.records || []).map((r) => [r.key, r.value]));
  const table = data.records.length ? `<div class="scroll"><table class="data">
      <thead><tr><th>${kind === "pace" ? "Distance" : "Duration"}</th><th class="num">${kind === "pace" ? "Time" : kind === "power" ? "Avg power" : "Avg HR"}</th>${all ? `<th class="num">All-time best</th>` : ""}<th>Date</th><th>Activity</th></tr></thead>
      <tbody>${data.records.map((r) => `<tr><td><b>${labels[r.key] || r.key}</b></td><td class="num">${fmt(r)}</td>
        ${all ? `<td class="num">${best[r.key] != null ? fmt({ key: r.key, value: best[r.key] }) : "–"}</td>` : ""}
        <td>${localTime(r).slice(0, 10)}</td><td><a class="tb-activity-name" href="#/activity/${r.id}">${typeIcon(r.activity_type)}<span>${esc(r.name || typeLabel(r.activity_type))}</span></a></td></tr>`).join("")}</tbody></table></div>`
    : hint(kind === "pace" ? "No runs with distance data in this period." : kind === "power" ? "No activities with power data in this period." : "No activities with heart rate in this period.");
  view.innerHTML = `${pageHead("Statistics", timeBadge(params) + (kind === "pace" ? "" : typeBadge(params)), sw)}
    <div class="card"><div class="card-row records-bar">${controls}</div></div>
    <div class="card"><h3>${kind === "pace" ? "Fastest times" : kind === "power" ? "Best average power" : "Highest average heart rate"} · ${esc(rangeLabel)}</h3>
      ${data.records.length > 1 ? recordsCurve(data.records, all?.records, kind) : ""}
      ${table}
      ${hint(kind === "pace" ? "Fastest time over each distance within any run (from the distance stream), not only whole races." : "Best average over each duration within any activity, with pauses of more than 10 s breaking a window.")}
    </div>`;
  view.querySelectorAll("[data-kind]").forEach((b) => b.onclick = () => {
    location.hash = "#/stats?" + new URLSearchParams({ tab: "records", kind: b.dataset.kind, ...filterQuery(params) });
  });
  bindBadges(view.querySelector(".page-head"));
  bindFilterBadges(view.querySelector(".page-head"), "#/stats", { tab: "records", kind, ...params });
}

// Duration / distance curve on a log x axis. Pace is shown as speed (higher = faster).
function recordsCurve(rows, allRows, kind) {
  const W = 1000, H = 220, P = { l: 48, r: 14, t: 12, b: 26 };
  const val = (r) => (kind === "pace" ? (r.key / r.value) * 3.6 : r.value);
  const pts = rows.map((r) => [r.key, val(r)]);
  const pall = (allRows || []).map((r) => [r.key, val(r)]);
  const xs = [...pts, ...pall].map((p) => p[0]), ys = [...pts, ...pall].map((p) => p[1]);
  const x0 = Math.log(Math.min(...xs)), x1 = Math.log(Math.max(...xs));
  let lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = (hi - lo) * 0.12 || 1; lo -= pad; hi += pad;
  const x = (k) => P.l + ((Math.log(k) - x0) / (x1 - x0 || 1)) * (W - P.l - P.r);
  const y = (v) => H - P.b - ((v - lo) / (hi - lo)) * (H - P.t - P.b);
  const path = (ps) => ps.map(([k, v], i) => `${i ? "L" : "M"}${x(k).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const unitLabel = kind === "pace" ? "km/h" : kind === "power" ? "W" : "bpm";
  const labels = RECORD_LABELS[kind];
  return `<div class="fit-chart curve"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${[0, 0.25, 0.5, 0.75, 1].map((f) => { const v = lo + f * (hi - lo); return `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/><text x="${P.l - 6}" y="${(y(v) + 4).toFixed(1)}" class="ax" text-anchor="end">${num(v, kind === "pace" ? 1 : 0)}</text>`; }).join("")}
    ${pall.length ? `<path d="${path(pall)}" fill="none" stroke="var(--muted)" stroke-dasharray="5 4" stroke-width="1.5" vector-effect="non-scaling-stroke"/>` : ""}
    <path d="${path(pts)}" fill="none" stroke="var(--accent)" stroke-width="2.4" vector-effect="non-scaling-stroke"/>
    ${pts.map(([k, v]) => `<circle cx="${x(k).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.5" fill="var(--accent)"/>`).join("")}
    ${rows.map((r) => `<text x="${x(r.key).toFixed(1)}" y="${H - 6}" class="ax" text-anchor="middle">${labels[r.key] || r.key}</text>`).join("")}
    <text x="${P.l + 4}" y="${P.t + 12}" class="ax">${unitLabel}${pall.length ? " · dashed: all time" : ""}</text>
  </svg></div>`;
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
