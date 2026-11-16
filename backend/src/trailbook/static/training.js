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
const loadUnit = (v) => (v == null ? "–" : `${num(v)} TSS`);
const shortDist = (m) => (m == null || m < 50 ? "" : m >= 10000 ? `${num(m / 1000, 0)} km` : `${num(m / 1000, 1)} km`);
const shortDur = (s) => {
  if (!s) return "";
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, "0")} h` : `${m} min`;
};
const personParam = () => (CURRENT && CURRENT !== "all" ? { person: CURRENT } : {});

const ICON_CAL_MONTH = svg(`<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/><path d="M7 13h2M11 13h2M15 13h2M7 17h2M11 17h2"/>`);
const ICON_CAL_YEAR = svg(`<rect x="3" y="3" width="5" height="5" rx="1"/><rect x="10" y="3" width="5" height="5" rx="1"/><rect x="17" y="3" width="4" height="5" rx="1"/><rect x="3" y="10" width="5" height="5" rx="1"/><rect x="10" y="10" width="5" height="5" rx="1"/><rect x="17" y="10" width="4" height="5" rx="1"/><rect x="3" y="17" width="5" height="4" rx="1"/><rect x="10" y="17" width="5" height="4" rx="1"/>`);
const ICON_PREV = svg(`<path d="M15 6l-6 6 6 6"/>`);
const ICON_NEXT = svg(`<path d="M9 6l6 6-6 6"/>`);
const ICON_TOTALS = svg(`<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>`);
const ICON_RECORDS = svg(`<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3a3 3 0 0 1-3 4M7 5H4a3 3 0 0 0 3 4"/>`);

// ---- Calendar ---------------------------------------------------------------------------

async function renderCalendar(params) {
  const mode = params.view === "year" ? "year" : "month";
  const today = todayIso();
  const month = /^\d{4}-\d{2}$/.test(params.month || "") ? params.month : today.slice(0, 7);
  const year = /^\d{4}$/.test(params.year || "") ? params.year : month.slice(0, 4);
  const go = (p) => { location.hash = "#/calendar?" + new URLSearchParams({ view: mode, ...p }); };

  let from, to, label, prev, next;
  if (mode === "month") {
    const first = month + "-01";
    const last = addDays(isoDay(new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1))), -1);
    from = mondayOf(first);
    to = addDays(mondayOf(last), 6);
    label = `${MONTHS[+month.slice(5, 7) - 1]} ${month.slice(0, 4)}`;
    const shift = (n) => { const d = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1 + n, 1)); return isoDay(d).slice(0, 7); };
    prev = { month: shift(-1) }; next = { month: shift(1) };
  } else {
    from = `${year}-01-01`; to = `${year}-12-31`; label = year;
    prev = { year: String(+year - 1) }; next = { year: String(+year + 1) };
  }
  const data = await api("calendar?" + new URLSearchParams({ from, to, ...personParam() }));
  const byDay = {};
  for (const a of data.activities) (byDay[a.day] ||= []).push(a);
  const isAll = CURRENT === "all";

  const nav = `<div class="cal-nav">
      <button class="icon" data-cal="prev" title="Previous" aria-label="Previous">${ICON_PREV}</button>
      <b class="cal-label">${esc(label)}</b>
      <button class="icon" data-cal="next" title="Next" aria-label="Next">${ICON_NEXT}</button>
      <button class="small" data-cal="today">Today</button>
    </div>`;
  const sw = switchHtml("calview", [["month", `${ICON_CAL_MONTH}<span>Month</span>`], ["year", `${ICON_CAL_YEAR}<span>Year</span>`]], mode);

  const acts = data.activities;
  const days = new Set(acts.filter((a) => mode === "year" || a.day.startsWith(month)).map((a) => a.day));
  const inRange = mode === "year" ? acts : acts.filter((a) => a.day.startsWith(month));
  const rsum = (k) => inRange.reduce((s, a) => s + (a[k] || 0), 0);
  const strip = statStrip([
    ["Activities", num(inRange.length), `${num(days.size)} active days`],
    ["Distance", km(rsum("distance_m"))],
    ["Moving time", hours(rsum("moving_s"))],
    ["Elevation gain", meters(rsum("ascent_m"))],
    ["Training load", loadUnit(rsum("load"))],
  ]);

  let body;
  if (mode === "month") {
    const weeks = [];
    for (let d = from; d <= to; d = addDays(d, 7)) weeks.push(d);
    const chip = (a) => `<a class="cal-act" href="#/activity/${a.id}" title="${esc(a.name || typeLabel(a.activity_type))} · ${esc(typeLabel(a.activity_type))}${isAll ? " · " + esc(personLabel(a.person_id)) : ""}">
        ${isAll ? `<span class="cal-dot" style="background:${personColor(person(a.person_id))}"></span>` : ""}${typeIcon(a.activity_type, 16)}
        <span class="cal-act-text">${esc(shortDist(a.distance_m) || shortDur(a.moving_s))}</span></a>`;
    body = `<div class="scroll"><div class="cal-month">
      ${WEEKDAYS.map((w) => `<div class="cal-head">${w}</div>`).join("")}<div class="cal-head">Week</div>
      ${weeks.map((w) => {
        const wdays = [...Array(7)].map((_, i) => addDays(w, i));
        const wacts = wdays.flatMap((d) => byDay[d] || []);
        const ws = (k) => wacts.reduce((s, a) => s + (a[k] || 0), 0);
        return wdays.map((d) => `<div class="cal-day ${d.startsWith(month) ? "" : "other"} ${d === today ? "today" : ""}">
            <span class="cal-num">${+d.slice(8)}</span>${(byDay[d] || []).map(chip).join("")}</div>`).join("")
          + `<div class="cal-week">${wacts.length ? `<b>${hours(ws("moving_s"))}</b><span>${km(ws("distance_m"))}</span><span>${loadUnit(ws("load"))}</span><span class="hint">${num(wacts.length)} activit${wacts.length === 1 ? "y" : "ies"}</span>` : `<span class="hint">–</span>`}</div>`;
      }).join("")}
    </div></div>`;
  } else {
    // Year: one small grid per month, each day coloured by moving time.
    const dayTime = {};
    for (const a of acts) dayTime[a.day] = (dayTime[a.day] || 0) + (a.moving_s || 0);
    const level = (s) => (!s ? 0 : s < 1800 ? 1 : s < 3600 ? 2 : s < 7200 ? 3 : 4);
    body = `<div class="cal-year">${MONTHS.map((name, mi) => {
      const m = `${year}-${String(mi + 1).padStart(2, "0")}`;
      const first = m + "-01";
      const lastDay = new Date(Date.UTC(+year, mi + 1, 0)).getUTCDate();
      const lead = (parseDay(first).getUTCDay() + 6) % 7;
      const macts = acts.filter((a) => a.day.startsWith(m));
      const ms = (k) => macts.reduce((s, a) => s + (a[k] || 0), 0);
      return `<a class="cal-mini" href="#/calendar?${new URLSearchParams({ view: "month", month: m })}">
        <div class="cal-mini-head"><b>${name}</b><span class="hint">${macts.length ? `${hours(ms("moving_s"))} · ${km(ms("distance_m"))}` : "–"}</span></div>
        <div class="cal-mini-grid">${"<span></span>".repeat(lead)}${[...Array(lastDay)].map((_, i) => {
          const d = `${m}-${String(i + 1).padStart(2, "0")}`;
          return `<span class="lv${level(dayTime[d])} ${d === today ? "today" : ""}" title="${d}${dayTime[d] ? " · " + dur(dayTime[d]) : ""}"></span>`;
        }).join("")}</div></a>`;
    }).join("")}</div>
    <div class="cal-legend hint">Moving time per day: <span class="lv1"></span> &lt; 30 min <span class="lv2"></span> &lt; 1 h <span class="lv3"></span> &lt; 2 h <span class="lv4"></span> 2 h +</div>`;
  }

  view.innerHTML = `${pageHead("Calendar", nav, sw)}${strip}<div class="card cal-card">${body}</div>`;
  view.querySelectorAll("[data-switch=calview]").forEach((b) => b.onclick = () => {
    location.hash = "#/calendar?" + new URLSearchParams(b.dataset.value === "year" ? { view: "year", year: month.slice(0, 4) } : { view: "month", month: mode === "year" ? `${year}-${today.slice(5, 7)}` : month });
  });
  view.querySelector("[data-cal=prev]").onclick = () => go(prev);
  view.querySelector("[data-cal=next]").onclick = () => go(next);
  view.querySelector("[data-cal=today]").onclick = () => go(mode === "month" ? { month: today.slice(0, 7) } : { year: today.slice(0, 4) });
}

// ---- Fitness ----------------------------------------------------------------------------

// Sections of the Fitness page, each shown or hidden by its toggle in the header.
const ICON_FITNESS = svg(`<path d="M3 20h18"/><path d="M4 16l5-5 4 3 7-7"/><path d="M15 7h5v5"/>`);
const ICON_FORM = svg(`<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-5"/><circle cx="12" cy="18" r="1"/>`);
const FITNESS_SECTIONS = [["fitness", "Fitness", ICON_FITNESS], ["form", "Form", ICON_FORM]];
// Pastel zone colours (docs/CHARTS.md): the form line, its bands and the summary use them.
const FORM_ZONES = [
  [25, Infinity, "Transition", "#9aa3b5"],
  [5, 25, "Fresh", "#5fb0e6"],
  [-10, 5, "Grey zone", "#a9adb5"],
  [-30, -10, "Optimal", "#4fb67c"],
  [-Infinity, -30, "High risk", "#e8716f"],
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
  const q = { person: CURRENT };
  if (params.from) q.from = params.from;
  if (params.to) q.to = params.to;
  const data = await api("fitness?" + new URLSearchParams(q));
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
    tip: [a.name || typeLabel(a.activity_type), `${typeLabel(a.activity_type)} · ${a.day}`, [shortDur(a.moving_s), a.distance_m >= 50 ? km(a.distance_m) : ""].filter(Boolean).join(" · ")].join("\n"),
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
    ({ label, value: values[i], i, values, color, text: sign ? signed(values[i], d) : num(values[i], d), tip });
  const fresh = extreme(tsb, true), tired = extreme(tsb, false);
  return [
    { key: "fitness", label: "Fitness", title: opt.fatigue === "off" ? "Fitness" : "Fitness and fatigue", yTitle: "Training load", unit: "TSS/d", dec: 0, height: 396,
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

const METHOD_LABELS = { power: "Power (TSS)", pace: "Running pace (rTSS)", hr: "Heart rate (hrTSS)", none: "No load (no data)" };
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

const STAT_METRICS = [["moving_s", "Moving time"], ["distance_m", "Distance"], ["ascent_m", "Elevation gain"], ["load", "Training load"], ["count", "Activities"]];
const fmtMetric = (k, v) => (k === "moving_s" ? hours(v) : k === "distance_m" ? km(v) : k === "ascent_m" ? meters(v) : k === "load" ? loadUnit(v) : num(v || 0));
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
  const oneYear = params.from && params.to && params.from.slice(0, 4) === params.to.slice(0, 4);
  const by = ["year", "month", "week"].includes(params.by) ? params.by : (oneYear ? "month" : "year");
  const metric = STAT_METRICS.some(([k]) => k === params.metric) ? params.metric : "moving_s";
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
    ["Moving time", hours(t("moving_s"))],
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
  const gmax = Math.max(1, ...data.groups.map((g) => g.moving_s || 0));
  view.innerHTML = `${pageHead("Statistics", badges, sw)}${strip}
    <div class="card"><h3>${STAT_METRICS.find(([k]) => k === metric)[1]} per ${by}</h3>${chart}</div>
    <div class="two-col wide-first">
      <div class="card"><h3>Totals per ${by}</h3><div class="scroll"><table class="data">
        <thead><tr><th>${by[0].toUpperCase() + by.slice(1)}</th><th class="num">Activities</th><th class="num">Active days</th><th class="num">Distance</th><th class="num">Moving time</th><th class="num">Elevation gain</th><th class="num">Load</th></tr></thead>
        <tbody>${[...rows].reverse().map((r) => `<tr><td>${by === "year" ? `<a href="#/stats?${new URLSearchParams({ ...filterQuery(params), from: r.period + "-01-01", to: r.period + "-12-31", by: "month", metric })}">${r.period}</a>` : esc(periodLabel(r.period))}</td>
          <td class="num">${num(r.count)}</td><td class="num">${num(r.active_days)}</td><td class="num">${km(r.distance_m)}</td><td class="num">${hours(r.moving_s)}</td><td class="num">${meters(r.ascent_m)}</td><td class="num">${loadUnit(r.load)}</td></tr>`).join("")}</tbody></table></div></div>
      <div class="card"><h3>By activity group</h3>${hint("Moving time")}
        ${data.groups.map((g) => `<div class="bar-row"><span class="bar-label tb-activity-name">${groupIcon(g.category)}<span>${esc(groupLabel(g.category))}</span></span><span class="bar"><span style="width:${((g.moving_s || 0) / gmax) * 100}%;background:var(--accent)"></span></span><span class="bar-value">${hours(g.moving_s)}</span></div>`).join("") || hint("–")}
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
  const filtered = Boolean(params.from || params.to);
  const q = (f) => api("stats/records?" + new URLSearchParams({ person: CURRENT, kind, ...f }));
  const [data, all] = await Promise.all([q(fq), filtered ? q({ ...fq, from: "", to: "" }) : null]);
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
