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

const FITNESS_RANGES = [["90", "3 months"], ["180", "6 months"], ["365", "1 year"], ["all", "All"]];
const FORM_ZONES = [
  [25, Infinity, "Transition", "#8b92a3"],
  [5, 25, "Fresh", "#0ea5e9"],
  [-10, 5, "Grey zone", "#a3a3a3"],
  [-30, -10, "Optimal", "#16a34a"],
  [-Infinity, -30, "High risk", "#dc2626"],
];
const formZone = (tsb) => FORM_ZONES.find(([lo, hi]) => tsb >= lo && tsb < hi) || FORM_ZONES[2];
const COLORS = { ctl: "var(--accent)", atl: "#e5487a", load: "var(--line)" };

async function renderFitness(params) {
  const range = FITNESS_RANGES.some(([k]) => k === params.range) ? params.range : (store.get("fitness-range") || "180");
  store.set("fitness-range", range);
  const from = range === "all" ? "" : addDays(todayIso(), -Number(range));
  const data = await api("fitness?" + new URLSearchParams({ person: CURRENT, ...(from ? { from } : {}) }));
  const s = data.series;
  const sw = switchHtml("frange", FITNESS_RANGES, range);
  if (!s.length) {
    view.innerHTML = `${pageHead("Fitness", "", sw)}<div class="card">${hint(data.pending
      ? `Training load is being computed for ${num(data.pending)} activities — refresh in a moment.`
      : "No activity has a training load yet. Load needs heart rate (or power + FTP, or pace + threshold pace for runs).")}</div>${methodsCard(data)}`;
    bindFitnessSwitch();
    return;
  }
  const last = s[s.length - 1];
  const weekAgo = s[Math.max(0, s.length - 8)];
  const load7 = s.slice(-7).reduce((a, d) => a + d.load, 0);
  const zone = formZone(last.tsb);
  const strip = statStrip([
    ["Fitness (CTL)", num(last.ctl), "42-day load average"],
    ["Fatigue (ATL)", num(last.atl), "7-day load average"],
    ["Form (TSB)", `<span style="color:${zone[3]}">${num(last.tsb)}</span>`, zone[2]],
    ["Ramp rate", `${last.ctl - weekAgo.ctl >= 0 ? "+" : ""}${num(last.ctl - weekAgo.ctl, 1)}`, "fitness change in 7 days"],
    ["Load, 7 days", loadUnit(load7)],
  ]);
  view.innerHTML = `${pageHead("Fitness", "", sw)}${strip}
    <div class="card"><h3>Fitness and fatigue</h3>
      <div class="legend"><span><i style="background:${COLORS.ctl}"></i>Fitness (CTL)</span><span><i style="background:${COLORS.atl}"></i>Fatigue (ATL)</span><span><i style="background:var(--muted);opacity:.35"></i>Daily load</span></div>
      <div class="fit-chart" data-chart="main">${fitnessChart(s)}</div>
      <h3 style="margin-top:18px">Form</h3>
      <div class="legend">${FORM_ZONES.map(([, , n, c]) => `<span><i style="background:${c}"></i>${n}</span>`).join("")}</div>
      <div class="fit-chart" data-chart="form">${formChart(s)}</div>
      <div class="fit-tip" hidden></div>
    </div>
    ${data.pending ? `<div class="card">${state(`Computing training load for ${num(data.pending)} activities…`, "warn")}</div>` : ""}
    ${methodsCard(data)}`;
  bindFitnessSwitch();
  bindFitnessHover(s);
}

function bindFitnessSwitch() {
  view.querySelectorAll("[data-switch=frange]").forEach((b) => b.onclick = () => { location.hash = "#/fitness?range=" + b.dataset.value; });
}

const FW = 1000, FH = 260, FP = { l: 40, r: 10, t: 10, b: 24 };
function axisDates(s, w, h) {
  const n = s.length, out = [];
  const step = Math.max(1, Math.ceil(n / 8));
  for (let i = 0; i < n; i += step) {
    const x = FP.l + (i / Math.max(1, n - 1)) * (w - FP.l - FP.r);
    out.push(`<text x="${x.toFixed(1)}" y="${h - 6}" class="ax" text-anchor="middle">${s[i].date.slice(2)}</text>`);
  }
  return out.join("");
}
function yTicks(lo, hi, y, w) {
  const span = hi - lo || 1;
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200].find((v) => span / v <= 6) || 500;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    out.push(`<line x1="${FP.l}" x2="${w - FP.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid${v === 0 ? " zero" : ""}"/><text x="${FP.l - 6}" y="${(y(v) + 4).toFixed(1)}" class="ax" text-anchor="end">${v}</text>`);
  }
  return out.join("");
}
function fitnessChart(s) {
  const n = s.length;
  const hi = Math.max(10, ...s.map((d) => Math.max(d.ctl, d.atl, d.load)));
  const x = (i) => FP.l + (i / Math.max(1, n - 1)) * (FW - FP.l - FP.r);
  const y = (v) => FH - FP.b - (v / hi) * (FH - FP.t - FP.b);
  const bw = Math.max(1, (FW - FP.l - FP.r) / n - 1);
  const line = (k) => s.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d[k]).toFixed(1)}`).join("");
  return `<svg viewBox="0 0 ${FW} ${FH}" preserveAspectRatio="none">
    ${yTicks(0, hi, y, FW)}
    ${s.map((d, i) => (d.load ? `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${y(d.load).toFixed(1)}" width="${bw.toFixed(1)}" height="${(FH - FP.b - y(d.load)).toFixed(1)}" class="loadbar"/>` : "")).join("")}
    <path d="${line("atl")}" fill="none" stroke="${COLORS.atl}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
    <path d="${line("ctl")}" fill="none" stroke="${COLORS.ctl}" stroke-width="2.4" vector-effect="non-scaling-stroke"/>
    ${axisDates(s, FW, FH)}
    <line class="cursor" x1="0" x2="0" y1="${FP.t}" y2="${FH - FP.b}" visibility="hidden"/>
  </svg>`;
}
function formChart(s) {
  const n = s.length, H = 170;
  const lo = Math.min(-35, ...s.map((d) => d.tsb)), hi = Math.max(30, ...s.map((d) => d.tsb));
  const x = (i) => FP.l + (i / Math.max(1, n - 1)) * (FW - FP.l - FP.r);
  const y = (v) => H - FP.b - ((v - lo) / (hi - lo)) * (H - FP.t - FP.b);
  const bands = FORM_ZONES.map(([a, b, , c]) => {
    const top = y(Math.min(hi, b)), bottom = y(Math.max(lo, a));
    return bottom > top ? `<rect x="${FP.l}" width="${FW - FP.l - FP.r}" y="${top.toFixed(1)}" height="${(bottom - top).toFixed(1)}" fill="${c}" opacity=".08"/>` : "";
  }).join("");
  const line = s.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.tsb).toFixed(1)}`).join("");
  return `<svg viewBox="0 0 ${FW} ${H}" preserveAspectRatio="none">
    ${bands}${yTicks(lo, hi, y, FW)}
    <path d="${line}" fill="none" stroke="var(--fg)" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
    ${axisDates(s, FW, H)}
    <line class="cursor" x1="0" x2="0" y1="${FP.t}" y2="${H - FP.b}" visibility="hidden"/>
  </svg>`;
}
function bindFitnessHover(s) {
  const tip = view.querySelector(".fit-tip");
  view.querySelectorAll(".fit-chart svg").forEach((svgEl) => {
    svgEl.onmousemove = (e) => {
      const r = svgEl.getBoundingClientRect();
      const fx = ((e.clientX - r.left) / r.width) * FW;
      const i = Math.max(0, Math.min(s.length - 1, Math.round(((fx - FP.l) / (FW - FP.l - FP.r)) * (s.length - 1))));
      const cx = FP.l + (i / Math.max(1, s.length - 1)) * (FW - FP.l - FP.r);
      view.querySelectorAll(".fit-chart .cursor").forEach((c) => { c.setAttribute("x1", cx); c.setAttribute("x2", cx); c.setAttribute("visibility", "visible"); });
      const d = s[i], z = formZone(d.tsb);
      tip.hidden = false;
      tip.innerHTML = `<b>${d.date}</b><span>Load ${num(d.load)}</span><span style="color:${COLORS.ctl}">Fitness ${num(d.ctl)}</span><span style="color:${COLORS.atl}">Fatigue ${num(d.atl)}</span><span style="color:${z[3]}">Form ${num(d.tsb)} · ${z[2]}</span>`;
      const card = svgEl.closest(".card").getBoundingClientRect();
      tip.style.left = `${Math.min(e.clientX - card.left + 14, card.width - 190)}px`;
      tip.style.top = `${e.clientY - card.top + 14}px`;
    };
    svgEl.onmouseleave = () => {
      tip.hidden = true;
      view.querySelectorAll(".fit-chart .cursor").forEach((c) => c.setAttribute("visibility", "hidden"));
    };
  });
}

const METHOD_LABELS = { power: "Power (TSS)", pace: "Running pace (rTSS)", hr: "Heart rate (hrTSS)", none: "No load (no data)" };
const SOURCE_LABEL = { set: "", auto: " (estimated)", default: " (default)" };
function methodsCard(data) {
  const th = data.thresholds || {}, src = th.sources || {};
  const val = (k, fmt) => (th[k] == null ? `<span class="hint">not set</span>` : fmt(th[k]) + `<span class="hint">${SOURCE_LABEL[src[k]] || ""}</span>`);
  const total = Object.values(data.methods || {}).reduce((a, b) => a + b, 0);
  return `<div class="card"><h3>How training load is calculated</h3>
    ${hint("Each activity gets a load (TSS-like: one hour at threshold = 100) from the best data it has: power with FTP, running pace with threshold pace, otherwise heart rate. Fitness is the 42-day and fatigue the 7-day exponential average of the daily load; form is yesterday's fitness minus fatigue.")}
    <div class="two-col">
      <div><div class="panel-title">Activities by method</div>
        ${Object.entries(METHOD_LABELS).map(([k, l]) => (data.methods?.[k] ? `<div class="bar-row"><span class="bar-label">${l}</span><span class="bar"><span style="width:${(data.methods[k] / total) * 100}%;background:var(--accent)"></span></span><span class="bar-value">${num(data.methods[k])}</span></div>` : "")).join("")}
      </div>
      <div><div class="panel-title">Thresholds in use today</div>
        <table class="kv"><tbody>
          <tr><td>HR max</td><td>${val("hr_max", bpm)}</td></tr>
          <tr><td>Resting HR</td><td>${val("hr_rest", bpm)}</td></tr>
          <tr><td>Threshold HR</td><td>${val("lthr", bpm)}</td></tr>
          <tr><td>FTP</td><td>${val("ftp", watts)}</td></tr>
          <tr><td>Threshold pace</td><td>${val("threshold_pace", (v) => fmtPace(v))}</td></tr>
        </tbody></table>
        <a href="#/settings/people">Change thresholds in Settings › People</a>
      </div>
    </div></div>`;
}
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
  const by = ["year", "month", "week"].includes(params.by) ? params.by : (params.year ? "month" : "year");
  const metric = STAT_METRICS.some(([k]) => k === params.metric) ? params.metric : "moving_s";
  const q = { person: CURRENT, by, ...(params.type ? { type: params.type } : {}), ...(params.year ? { year: params.year } : {}) };
  const data = await api("stats/totals?" + new URLSearchParams(q));
  const route = "#/stats";
  const typeText = !params.type ? "All" : params.type.startsWith("g:") ? groupLabel(params.type.slice(2)) : typeLabel(params.type);
  const filterPanel = `<div class="panel-grid">${section("Activity type", typePicker("data-pfilter", "type", params.type || ""))}
      ${section("Year", `<select data-pfilter="year"><option value="">All years</option>${data.years.map((y) => `<option ${y === params.year ? "selected" : ""}>${y}</option>`).join("")}</select>`)}
      ${section("Group by", `<select data-pfilter="by">${[["year", "Year"], ["month", "Month"], ["week", "Week"]].map(([v, l]) => `<option value="${v}" ${v === by ? "selected" : ""}>${l}</option>`).join("")}</select>`)}
      ${section("Chart", `<select data-pfilter="metric">${STAT_METRICS.map(([v, l]) => `<option value="${v}" ${v === metric ? "selected" : ""}>${l}</option>`).join("")}</select>`)}
    </div><div class="panel-actions">${params.type || params.year ? `<button class="primary small" data-clear-stats title="Remove all filters">Clear filters</button>` : ""}<button class="primary small" data-apply>Apply</button></div>`;
  const active = params.type || params.year;
  const badges = badgeHtml("filter", "Filter", [typeText !== "All" ? typeText : "", params.year || ""].filter(Boolean).join(" · ") || "All", { panel: filterPanel, on: !!active });
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
        <tbody>${[...rows].reverse().map((r) => `<tr><td>${by === "year" ? `<a href="#/stats?${new URLSearchParams({ ...(params.type ? { type: params.type } : {}), year: r.period, by: "month", metric })}">${r.period}</a>` : esc(periodLabel(r.period))}</td>
          <td class="num">${num(r.count)}</td><td class="num">${num(r.active_days)}</td><td class="num">${km(r.distance_m)}</td><td class="num">${hours(r.moving_s)}</td><td class="num">${meters(r.ascent_m)}</td><td class="num">${loadUnit(r.load)}</td></tr>`).join("")}</tbody></table></div></div>
      <div class="card"><h3>By activity group</h3>${hint("Moving time")}
        ${data.groups.map((g) => `<div class="bar-row"><span class="bar-label tb-activity-name">${groupIcon(g.category)}<span>${esc(groupLabel(g.category))}</span></span><span class="bar"><span style="width:${((g.moving_s || 0) / gmax) * 100}%;background:var(--accent)"></span></span><span class="bar-value">${hours(g.moving_s)}</span></div>`).join("") || hint("–")}
      </div>
    </div>`;
  bindBadges(view.querySelector(".page-head"));
  bindStagedFilter(view.querySelector(".page-head"), route, { tab: "totals", ...params });
  const clear = view.querySelector("[data-clear-stats]");
  if (clear) clear.onclick = () => { location.hash = "#/stats?tab=totals"; };
}

async function renderRecords(params, sw) {
  const kind = ["pace", "power", "hr"].includes(params.kind) ? params.kind : "pace";
  const range = params.range || "all";
  const type = kind === "pace" ? "g:run" : params.type ?? (kind === "power" ? "g:ride" : "");
  const q = (r) => api("stats/records?" + new URLSearchParams({ person: CURRENT, kind, range: r, ...(type ? { type } : {}) }));
  const [data, all] = await Promise.all([q(range), range === "all" ? null : q("all")]);
  const go = (p) => { location.hash = "#/stats?" + new URLSearchParams({ tab: "records", kind, range, ...(params.type != null && kind !== "pace" ? { type: params.type } : {}), ...p }); };
  const labels = RECORD_LABELS[kind];
  const fmt = (r) => (kind === "pace"
    ? `${dur(r.value)} <span class="hint">${pace(r.key / r.value)}</span>`
    : kind === "power" ? watts(r.value) : bpm(r.value));
  const rangeLabel = range === "all" ? "All time" : range === "90d" ? "Last 90 days" : range;
  const typeOptions = kind === "power" ? [["g:ride", "Cycling"], ["g:run", "Running"], ["", "All activities"]] : [["", "All activities"], ["g:run", "Running"], ["g:ride", "Cycling"]];
  const controls = `<div class="seg">${[["pace", "Running pace"], ["power", "Power"], ["hr", "Heart rate"]].map(([k, l]) => `<button class="${k === kind ? "on" : ""}" data-kind="${k}">${l}</button>`).join("")}</div>
    <select data-range><option value="all">All time</option><option value="90d" ${range === "90d" ? "selected" : ""}>Last 90 days</option>${data.years.map((y) => `<option ${y === range ? "selected" : ""}>${y}</option>`).join("")}</select>
    ${kind !== "pace" ? `<select data-rtype>${typeOptions.map(([v, l]) => `<option value="${v}" ${v === type ? "selected" : ""}>${l}</option>`).join("")}</select>` : ""}`;
  const best = Object.fromEntries((all?.records || []).map((r) => [r.key, r.value]));
  const table = data.records.length ? `<div class="scroll"><table class="data">
      <thead><tr><th>${kind === "pace" ? "Distance" : "Duration"}</th><th class="num">${kind === "pace" ? "Time" : kind === "power" ? "Avg power" : "Avg HR"}</th>${all ? `<th class="num">All-time best</th>` : ""}<th>Date</th><th>Activity</th></tr></thead>
      <tbody>${data.records.map((r) => `<tr><td><b>${labels[r.key] || r.key}</b></td><td class="num">${fmt(r)}</td>
        ${all ? `<td class="num">${best[r.key] != null ? fmt({ key: r.key, value: best[r.key] }) : "–"}</td>` : ""}
        <td>${localTime(r).slice(0, 10)}</td><td><a class="tb-activity-name" href="#/activity/${r.id}">${typeIcon(r.activity_type)}<span>${esc(r.name || typeLabel(r.activity_type))}</span></a></td></tr>`).join("")}</tbody></table></div>`
    : hint(kind === "pace" ? "No runs with distance data in this period." : kind === "power" ? "No activities with power data in this period." : "No activities with heart rate in this period.");
  view.innerHTML = `${pageHead("Statistics", "", sw)}
    <div class="card"><div class="card-row records-bar">${controls}</div></div>
    <div class="card"><h3>${kind === "pace" ? "Fastest times" : kind === "power" ? "Best average power" : "Highest average heart rate"} · ${esc(rangeLabel)}</h3>
      ${data.records.length > 1 ? recordsCurve(data.records, all?.records, kind) : ""}
      ${table}
      ${hint(kind === "pace" ? "Fastest time over each distance within any run (from the distance stream), not only whole races." : "Best average over each duration within any activity, with pauses of more than 10 s breaking a window.")}
    </div>`;
  view.querySelectorAll("[data-kind]").forEach((b) => b.onclick = () => { location.hash = "#/stats?" + new URLSearchParams({ tab: "records", kind: b.dataset.kind, range }); });
  view.querySelector("[data-range]").onchange = (e) => go({ range: e.target.value });
  const rt = view.querySelector("[data-rtype]");
  if (rt) rt.onchange = (e) => go({ type: e.target.value });
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

async function renderThresholds(el, pid) {
  const people = realPeople();
  if (!people.length) { el.innerHTML = ""; return; }
  pid = pid && people.some((p) => p.id === pid) ? pid : (CURRENT && CURRENT !== "all" && people.some((p) => p.id === CURRENT) ? CURRENT : people[0].id);
  const st = await api("thresholds/" + encodeURIComponent(pid));
  const eff = st.effective, src = eff.sources || {};
  const ph = (k, fmt) => (eff[k] != null && src[k] !== "set" ? `${fmt(eff[k])}${SOURCE_LABEL[src[k]]}` : "");
  el.innerHTML = `<div class="card">
    <h3>Training thresholds</h3>
    ${hint("Used for training load and the Fitness tab. Leave a field empty to use the estimate. A new row applies from its date on, so older activities keep the values that were true back then. Saving recomputes the load of this person's activities in the background.")}
    <div class="card-row" style="margin:8px 0 12px">
      <select data-th-person>${people.map((p) => `<option value="${esc(p.id)}" ${p.id === pid ? "selected" : ""}>${esc(p.label)}</option>`).join("")}</select>
      ${st.pending ? state(`Recomputing ${num(st.pending)} activities…`, "warn") : ""}
    </div>
    <div class="th-form">
      <label><span class="opt-label">Valid from</span><input type="date" name="valid_from" value="${todayIso()}"></label>
      <label><span class="opt-label">HR max (bpm)</span><input name="hr_max" inputmode="numeric" placeholder="${esc(ph("hr_max", (v) => v))}"></label>
      <label><span class="opt-label">Resting HR (bpm)</span><input name="hr_rest" inputmode="numeric" placeholder="${esc(ph("hr_rest", (v) => v))}"></label>
      <label><span class="opt-label">Threshold HR (bpm)</span><input name="lthr" inputmode="numeric" placeholder="${esc(ph("lthr", (v) => v))}"></label>
      <label><span class="opt-label">FTP (W)</span><input name="ftp" inputmode="numeric"></label>
      <label><span class="opt-label">Threshold pace (min:s /km)</span><input name="threshold_pace" placeholder="4:30"></label>
      <div class="th-actions"><button class="primary small" data-th-save>Add</button><span data-th-msg></span></div>
    </div>
    ${st.rows.length ? `<div class="scroll" style="margin-top:12px"><table class="data">
      <thead><tr><th>Valid from</th><th class="num">HR max</th><th class="num">Resting HR</th><th class="num">Threshold HR</th><th class="num">FTP</th><th class="num">Threshold pace</th><th></th></tr></thead>
      <tbody>${st.rows.map((r) => `<tr><td>${r.valid_from === "1970-01-01" ? "always" : r.valid_from}</td>
        <td class="num">${r.hr_max ? bpm(r.hr_max) : "–"}</td><td class="num">${r.hr_rest ? bpm(r.hr_rest) : "–"}</td><td class="num">${r.lthr ? bpm(r.lthr) : "–"}</td>
        <td class="num">${r.ftp ? watts(r.ftp) : "–"}</td><td class="num">${r.threshold_pace ? fmtPace(r.threshold_pace) : "–"}</td>
        <td class="actions"><button class="icon delete" data-th-del="${r.valid_from}" title="Delete row" aria-label="Delete row">${ICON.trash}</button></td></tr>`).join("")}</tbody></table></div>`
      : hint(`No thresholds set yet — estimates in use: HR max ${eff.hr_max ? bpm(eff.hr_max) : "unknown"} (highest recorded), resting HR ${bpm(eff.hr_rest)}, threshold HR ${eff.lthr ? bpm(eff.lthr) : "unknown"} (90 % of HR max).`)}
  </div>`;
  el.querySelector("[data-th-person]").onchange = (e) => renderThresholds(el, e.target.value);
  const msg = el.querySelector("[data-th-msg]");
  el.querySelector("[data-th-save]").onclick = async () => {
    const f = (n) => el.querySelector(`[name=${n}]`).value.trim();
    const paceText = f("threshold_pace");
    const paceSec = paceText ? parsePace(paceText) : null;
    if (paceText && paceSec == null) { msg.innerHTML = state("Threshold pace as min:s, e.g. 4:30", "bad"); return; }
    const body = { valid_from: f("valid_from"), hr_max: f("hr_max"), hr_rest: f("hr_rest"), lthr: f("lthr"), ftp: f("ftp"), threshold_pace: paceSec };
    if (!["hr_max", "hr_rest", "lthr", "ftp"].some((k) => body[k]) && !paceSec) { msg.innerHTML = state("Enter at least one value", "warn"); return; }
    try {
      await api("thresholds/" + encodeURIComponent(pid), { method: "PUT", body: JSON.stringify(body) });
      await renderThresholds(el, pid);
      el.querySelector("[data-th-msg]").innerHTML = state("Saved · load is being recomputed", "ok");
    } catch (e) { msg.innerHTML = state(esc(e.message), "bad"); }
  };
  el.querySelectorAll("[data-th-del]").forEach((b) => b.onclick = async () => {
    if (!confirm("Delete this row of thresholds?")) return;
    await api(`thresholds/${encodeURIComponent(pid)}/${b.dataset.thDel}`, { method: "DELETE" });
    renderThresholds(el, pid);
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
