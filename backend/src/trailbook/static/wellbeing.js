// Wellbeing (docs/SPEC.md › Wellbeing): tabs Movement | Sleep | Recovery | Body in the top right,
// the Time filter after the title (the last 12 months on every visit) and, on Movement, the
// X-axis (Mixed: by day, the columns by week | Weeks | Months). Steps and floors: dots or
// columns, a switch in the chart's header.

const WB_TABS = [
  ["movement", "Movement", () => metricIcon("steps", 16)],
  ["sleep", "Sleep", () => dayIc(`<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" ${iconLine()}/>`, "--m-sleep")],
  ["recovery", "Recovery", () => dayIc(`<rect x="3" y="7" width="16" height="10" rx="2" ${iconLine()}/><path d="M21.5 10.5v3" ${iconLine()}/><path d="m11.5 8.5-2.5 4h3l-2 3" ${iconLine(1.7)}/>`, "--m-breath")],
  ["body", "Body", () => dayIc(`<circle cx="12" cy="5" r="2.5" ${iconLine()}/><path d="M5 9.5h14M12 9.5V15m0 0-3.5 6.5M12 15l3.5 6.5" ${iconLine()}/>`, "--m-energy")],
];
const WB_X = [["mixed", "Mixed"], ["week", "Weeks"], ["month", "Months"]];
const WB_PLANNED = {
  sleep: "Sleep length and stages, sleep score, bed and wake times, the night's heart rate, breathing and HRV.",
  recovery: "HRV status against its baseline, resting heart rate, training readiness and Body Battery.",
  body: "Weight and body composition, blood pressure, VO2 max and fitness age.",
};
const WB_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WB_RED = "#e5484d"; // an extremely good day (far over the goal) turns towards it
const WB_AVG_W = 46; // the dots' row averages, right of the plot (in the side column)
// Steps and floors: the colour, the default look; the goal from Options (wbGoals)
const WB_M = {
  steps: { key: "steps", title: "Steps", word: "steps", dec: 0, color: "var(--accent)", look: "dots", icon: () => metricIcon("steps", 18) },
  floors: { key: "floors", title: "Floors", word: "floors", dec: 1, color: "#5fb873", look: "bars", icon: () => DAY_CONTENT.floors[2]() },
};
// Options › goals, saved per person (ui_settings `wellbeing-goals`): steps a day (10 000),
// floors a day (none: no goal on the charts), intensity minutes a week (150); Body: weight (kg)
// and body fat (%), none by default.
const WB_GOALS = { steps: 10000, floors: null, intensity: 150, weight: null, fat: null };
const WB_BODY_X = [["day", "Measurements"], ["week", "Weeks"], ["month", "Months"]];
const wbGoals = () => ({ ...WB_GOALS, ...(UI.data["wellbeing-goals"] || {}) });
const WB_LOOK_ICON = {
  dots: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="5" cy="8" r="2.2"/><circle cx="12" cy="8" r="3"/><circle cx="19" cy="8" r="1.5"/><circle cx="5" cy="16" r="3"/><circle cx="12" cy="16" r="1.5"/><circle cx="19" cy="16" r="2.4"/></svg>`,
  bars: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><rect x="3" y="11" width="4" height="9" rx="1"/><rect x="10" y="5" width="4" height="15" rx="1"/><rect x="17" y="8" width="4" height="12" rx="1"/></svg>`,
};
let WB_GROUPS = []; // the chart groups of the page (destroyed on the next draw)

async function renderWellbeing(tab, params) {
  tab = WB_TABS.some(([k]) => k === tab) ? tab : "movement";
  if (!timeActive(params)) params = { ...params, last: "1y" }; // fixed default (the last 12 months), every visit
  // X-axis and the looks: kept while on the page (Movement and Body each their own X-axis)
  const xList = tab === "body" ? WB_BODY_X : WB_X, xKey = tab === "body" ? "wbBodyX" : "wbX";
  let x = xList.some(([k]) => k === TAB[xKey]) ? TAB[xKey] : xList[0][0];
  TAB.wbLook ??= {};
  const goals = wbGoals();
  const goalRow = (key, label, hintText, unit, step = 1) => row(`${label}<small class="opt-hint">${hintText}</small>`, `<input type="number" class="wb-goal" min="0" step="${step}" data-wb-goal="${key}" value="${goals[key] ?? ""}" placeholder="none"> ${unit}`);
  const optionsPanel = tab === "body"
    ? `<div class="opt-panel">${goalRow("weight", "Weight goal", "Empty: no goal on the charts", "kg", 0.1)}
      ${goalRow("fat", "Body fat goal", "Share of the weight; empty: no goal", "%", 0.1)}</div>`
    : `<div class="opt-panel">${goalRow("steps", "Step goal", "Steps a day; dots and Goal met follow it", "a day")}
      ${goalRow("floors", "Floor goal", "Floors a day; empty: no goal", "a day")}
      ${goalRow("intensity", "Intensity goal", "Intensity minutes a week", "min")}</div>`;
  const badges = tab === "movement" || tab === "body" ? badgeHtml("wb-x", "X-axis", xList.find(([k]) => k === x)[1], { panel: `<div class="opt-panel">${pickList("wb-x", xList, x)}</div>` })
    + badgeHtml("wb-options", "Options", "", { panel: optionsPanel }) : "";
  const sw = switchHtml("wbtab", WB_TABS.map(([k, l, icon]) => [k, `${icon()}<span>${l}</span>`]), tab);
  view.innerHTML = `${pageHead("Wellbeing", timeBadge(params) + badges, sw)}<div class="charts" data-wb><div class="page-loader">${loaderHtml()}</div></div>`;
  const head = view.querySelector(".page-head");
  bindBadges(head);
  bindFilterBadges(head, `#/wellbeing/${tab}`, params, { allTime: "all" });
  const time = Object.fromEntries(TIME_KEYS.filter((k) => params[k]).map((k) => [k, params[k]]));
  head.querySelectorAll("[data-switch=wbtab]").forEach((b) => b.onclick = () => {
    location.hash = `#/wellbeing/${b.dataset.value}` + (Object.keys(time).length ? "?" + new URLSearchParams(time) : "");
  });
  const box = view.querySelector("[data-wb]");
  if (tab !== "movement" && tab !== "body") {
    box.innerHTML = `<div class="card"><div class="card-row">${state("Planned", "warn")}</div>${hint(WB_PLANNED[tab])}</div>`;
    return;
  }
  const { types, workouts, ...q } = filterQuery(params);
  let draw;
  if (tab === "body") {
    const data = await api("wellbeing/body?" + new URLSearchParams({ person: CURRENT, ...q }));
    data.years = yearList(params);
    // Fitness's whole series, once: the daily load (Additional series) and VO2 max (Fitness age)
    const f = await api("fitness?" + new URLSearchParams({ person: CURRENT })).catch(() => null);
    data.fitness = f?.series || [];
    data.loads = Object.fromEntries(data.fitness.map((d) => [d.date, d.load || 0]));
    draw = () => wbBody(box, data, x, draw);
  } else {
    const data = await api("wellbeing/movement?" + new URLSearchParams({ person: CURRENT, ...q }));
    data.years = yearList(params);
    // the activities of the period: icons under the intensity minutes (as on Fitness)
    data.acts = (await api("calendar?" + new URLSearchParams({ from: data.from, to: data.to, ...personParam() })).catch(() => null))?.activities || [];
    draw = () => wbMovement(box, data, x, { steps: TAB.wbLook.steps || WB_M.steps.look, floors: TAB.wbLook.floors || WB_M.floors.look }, (key, v) => { TAB.wbLook[key] = v; draw(); });
  }
  // Options › goals: a change is saved and the charts are drawn again (empty: the default)
  head.querySelectorAll("[data-wb-goal]").forEach((inp) => inp.onchange = () => {
    const key = inp.dataset.wbGoal, whole = ["steps", "floors", "intensity"].includes(key);
    const n = inp.value.trim() === "" ? null : Math.max(0, Number(inp.value));
    const v = n ? (whole ? Math.round(n) : Math.round(n * 10) / 10) : null;
    const next = { ...wbGoals(), [key]: v ?? WB_GOALS[key] };
    UI.data["wellbeing-goals"] = next;
    saveUi("wellbeing-goals", next);
    inp.value = next[key] ?? "";
    draw();
  });
  head.querySelectorAll('[data-pick="wb-x"]').forEach((b) => b.onclick = () => {
    head.querySelectorAll('[data-pick="wb-x"]').forEach((o) => { o.classList.toggle("on", o === b); o.setAttribute("aria-checked", o === b); });
    x = TAB[xKey] = b.dataset.value;
    head.querySelector('[data-badge-value="wb-x"]').textContent = xList.find(([k]) => k === x)[1];
    document.onclick?.();
    draw();
  });
  draw();
}

// The Dots | Columns switch in a chart's header (right).
const wbLookSwitch = (key, look) => `<div class="switch wb-look" role="group">${[["dots", "Dots"], ["bars", "Columns"]].map(([v, l]) =>
  `<button class="${v === look ? "on" : ""}" data-wb-look="${key}" data-value="${v}" title="${l}" aria-label="${l}" aria-pressed="${v === look}">${WB_LOOK_ICON[v]}</button>`).join("")}</div>`;

// ---- periods ------------------------------------------------------------------------------

const wbMs = (d) => Date.parse(d + "T00:00:00Z");
// Week of the year as Statistics counts it: weeks start on Monday, the days before the first
// Monday belong to week 1 (weekSpan).
function wbWeekNo(day) {
  const y = day.slice(0, 4), jan1 = wbMs(`${y}-01-01`);
  const mon = jan1 + ((8 - new Date(jan1).getUTCDay()) % 7) * DAY;
  const t = wbMs(day);
  return t < mon ? 1 : Math.floor((t - mon) / (7 * DAY)) + 1;
}
const wbAvg = (rows, f) => { const v = rows.map(f).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const wbShort = (day) => `${+day.slice(8)} ${WB_MONTHS[+day.slice(5, 7) - 1]} ${day.slice(0, 4)}`;
const wbDayLabel = (day) => `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(wbMs(day)).getUTCDay()]} ${wbShort(day)}`;

// The weeks (Statistics' weeks of the year) or months of the days, in date order: { key, year,
// no, from, to, label (with the dates), name ("Week 12 2026"), days } — one list for the dots,
// the columns and their links.
function wbPeriods(days, by) {
  const out = new Map();
  for (const d of days) {
    const y = +d.day.slice(0, 4), no = by === "week" ? wbWeekNo(d.day) : +d.day.slice(5, 7);
    const key = `${y}-${no}`;
    if (!out.has(key)) {
      const [from, to] = by === "week" ? weekSpan(y, no) : monthSpan(y, no);
      const name = by === "week" ? `Week ${no} ${y}` : `${MONTHS[no - 1]} ${y}`;
      const label = by === "week" ? `${name} · ${wbShort(from).replace(` ${y}`, "")} – ${wbShort(to)}` : name;
      out.set(key, { key, year: String(y), no, from, to, label, name, days: [] });
    }
    out.get(key).days.push(d);
  }
  return [...out.values()];
}

// A dot's colour: the metric's colour up to 1,5 × the goal, then towards red (full at 2,5 ×).
function wbColor(v, M) {
  if (!M.goal) return M.color;
  const t = Math.max(0, Math.min(1, v / M.goal - 1.5));
  return t ? `color-mix(in srgb, ${WB_RED} ${Math.round(t * 100)}%, ${M.color})` : M.color;
}

// ---- the page -----------------------------------------------------------------------------
// Steps (dots, or columns: by day in Mixed, the years compared when there are several, else by
// week or month), floors (columns, or dots), intensity minutes and active calories (columns).
// Every chart is linked: a day, week or month hovered shows its week or month on all others.

function wbMovement(box, data, x, look, setLook) {
  WB_GROUPS.forEach((g) => g.destroy());
  WB_GROUPS = [];
  const days = data.days || [];
  if (!days.some((d) => d.steps != null || d.floors != null || d.intensity != null)) {
    box.innerHTML = `<div class="card">${hint("No daily data in this period: steps and floors come from the watch's monitoring files or Garmin Connect, intensity minutes and calories from Garmin Connect (Settings › Garmin).")}</div>`;
    return;
  }
  const by = x === "month" ? "month" : "week", gridBy = x === "mixed" ? "day" : by;
  const goals = wbGoals();
  const MS = { ...WB_M.steps, goal: goals.steps }, MF = { ...WB_M.floors, goal: goals.floors };
  const periods = wbPeriods(days, by);
  const periodOf = new Map(periods.flatMap((p, i) => p.days.map((d) => [d.day, i])));
  const years = new Set(periods.map((p) => p.year));
  box.innerHTML = `<div data-wb-steps></div><div data-wb-floors></div><div data-wb-bars></div>`;
  const el = (k) => box.querySelector(`[data-wb-${k}]`);
  const shared = {}; // one y axis width and pill column for every group of the page
  const lower = wbBars(periods, by, goals, data.acts); // floors (columns), intensity, calories
  // links: each chart shows a period (index in `periods`, null: none) hovered elsewhere
  const links = [];
  let busy = false;
  const show = (src, p) => {
    if (busy) return;
    busy = true;
    try { for (const l of links) if (l !== src || l.self) l.show(p); } finally { busy = false; }
  };
  const grids = [];
  const addGrid = (target, M) => {
    const link = { self: true };
    const g = wbGrid(target, data, gridBy, periods, M, wbLookSwitch(M.key, "dots"), (day) => show(link, day == null ? null : periodOf.get(day) ?? null));
    link.show = (p) => g.mark(p == null ? null : new Set(periods[p].days.map((d) => d.day)));
    links.push(link);
    grids.push(g);
  };
  const addGroup = (target, cfg, toP, fromP) => {
    const link = {};
    const g = chartGroup(target, { ...cfg, shared, onHover: (i) => show(link, i == null ? null : toP(i)) });
    link.show = (p) => fromP(g, p);
    links.push(link);
    WB_GROUPS.push(g);
    return g;
  };
  // steps
  const stepDays = days.filter((d) => d.steps != null);
  const head = wbLookSwitch("steps", "bars");
  if (look.steps === "dots") addGrid(el("steps"), MS);
  else if (x === "mixed") { // a column per day; a week hovered elsewhere: its days marked
    addGroup(el("steps"), wbDailySteps(stepDays, head, goals.steps), (i) => periodOf.get(stepDays[i].day) ?? null, (g, p) => {
      const idx = p == null ? [] : stepDays.map((d, k) => (periodOf.get(d.day) === p ? k : -1)).filter((k) => k >= 0);
      g.highlight(idx.length ? [[idx[0], idx[idx.length - 1]]] : null);
    });
  } else if (years.size > 1) { // the years compared over W1 … W53 or Jan … Dec
    addGroup(el("steps"), wbYearSteps(periods, by, head, goals.steps), (k) => { const i = periods.findLastIndex((p) => p.no === k + 1); return i >= 0 ? i : null; },
      (g, p) => g.hover(p == null ? null : periods[p].no - 1));
  } else addGroup(el("steps"), { ...lower, series: [wbPeriodSteps(periods, by, head, goals.steps)] }, (i) => i, (g, p) => g.hover(p));
  // floors
  const floorsBars = lower.series.find((s) => s.key === "floors");
  if (look.floors === "dots" && floorsBars) {
    lower.series = lower.series.filter((s) => s !== floorsBars);
    addGrid(el("floors"), MF);
  } else if (floorsBars) floorsBars.headHtml = wbLookSwitch("floors", "bars");
  if (lower.series.length) addGroup(el("bars"), lower, (i) => i, (g, p) => g.hover(p));
  box.querySelectorAll("[data-wb-look]").forEach((b) => b.onclick = () => { if (!b.classList.contains("on")) setLook(b.dataset.wbLook, b.dataset.value); });
  // every chart of the page ends at one x: one side column width (the dots' cards need room for
  // their row averages too), then the dots' plots take the columns' left and right edge
  const roots = ["steps", "bars"].map(el).filter((r) => r.querySelector(".uplot"));
  const w = Math.max(0, ...grids.map((g) => g.sideNeed()), Math.ceil(shared.tagW || 0) + 2, ...roots.map((r) => parseFloat(r.style.getPropertyValue("--side-w")) || 0));
  if (w) {
    roots.forEach((r) => r.style.setProperty("--side-w", `${w}px`));
    grids.forEach((g) => g.row.style.setProperty("--side-w", `${w}px`));
  }
  WB_GROUPS.forEach((g) => g.realign());
  grids.forEach((g) => { g.edges = () => wbPlotEdges(box); });
  requestAnimationFrame(() => requestAnimationFrame(() => grids.forEach((g) => g.paint())));
}

// The left and right edge of the first column chart's plot on the page, from the left of its
// chart row (the dots' plots take them; none: their own defaults).
function wbPlotEdges(box) {
  const over = box.querySelector(".u-over"), row = over?.closest(".chart-row");
  if (!over || !row) return null;
  const a = over.getBoundingClientRect(), r = row.getBoundingClientRect();
  return { left: a.left - r.left, right: a.right - r.left };
}

// ---- dots: steps or floors ----------------------------------------------------------------
// Day: a row per month (newest on top), the days of the month across. Weeks / Months: a row
// per year, its weeks or months across (the average day). A dot's size follows the value, its
// colour the share of the goal: the metric's colour at the goal, red when far above, fading out
// and shrinking towards none. No dot: no data. Returns { row, paint, mark, sideNeed, edges }.

function wbGrid(el, data, by, periods, M, headHtml, onDot) {
  const days = data.days.filter((d) => d[M.key] != null);
  const cells = []; // { row, col, v, label, days }
  const rows = []; // [key, label]
  if (by === "day") {
    // every month of the period (newest first) from the first with data, also those without;
    // with Years: their months only
    const first = [data.from, days[0]?.day].filter(Boolean).sort().pop().slice(0, 7);
    for (let m = data.to.slice(0, 7); m >= first;) {
      if (!data.years.length || data.years.includes(m.slice(0, 4))) rows.push([m, `${WB_MONTHS[+m.slice(5) - 1]}${m.endsWith("-01") || m === data.to.slice(0, 7) || m === first ? ` ${m.slice(0, 4)}` : ""}`]);
      const [y, mm] = m.split("-").map(Number);
      m = mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, "0")}`;
    }
    for (const d of days) cells.push({ row: d.day.slice(0, 7), col: +d.day.slice(8), v: d[M.key], days: [d], label: wbDayLabel(d.day) });
  } else {
    for (const p of periods) {
      const v = wbAvg(p.days, (d) => d[M.key]);
      if (v != null) cells.push({ row: p.year, col: p.no, v, days: p.days, label: p.label });
    }
    [...new Set(cells.map((c) => c.row))].sort().reverse().forEach((y) => rows.push([y, y]));
  }
  const dec = by === "day" ? 0 : M.dec;
  const n = by === "day" ? 31 : by === "week" ? 53 : 12;
  // without a goal the dots grow up to the 90th percentile of the values (no Goal met, Streak)
  const sorted = cells.map((c) => c.v).sort((a, b) => a - b);
  const ref = M.goal || sorted[Math.floor(sorted.length * 0.9)] || 1;
  const met = M.goal ? cells.filter((c) => c.v >= M.goal) : [];
  const best = cells.reduce((b, c) => (!b || c.v > b.v ? c : b), null);
  const avgDay = wbAvg(days, (d) => d[M.key]);
  // the longest run of days in a row at the goal (Day only)
  let streak = [], run = [];
  if (by === "day" && M.goal) {
    for (const c of cells) {
      const prev = run[run.length - 1];
      const next = prev && wbMs(c.days[0].day) - wbMs(prev.days[0].day) === DAY;
      if (c.v >= M.goal) run = next ? [...run, c] : [c]; else run = [];
      if (run.length > streak.length) streak = run;
    }
  }
  const unit = by === "day" ? "days" : by === "week" ? "weeks" : "months";
  const stats = [
    ["Avg", num(avgDay, M.dec), "avg", `Average ${M.word} a day in the period.`],
    ...(M.goal ? [["Goal met", `${num((met.length / Math.max(1, cells.length)) * 100)} %`, "met", `Share of the ${unit} at ${num(M.goal)} ${M.word} a day or more (${num(met.length)} of ${num(cells.length)}).`]] : []),
    ["Best", num(best?.v, dec), "best", best ? `Most ${M.word}${by === "day" ? "" : " a day on average"}: ${best.label}.` : ""],
    ...(by === "day" && streak.length > 1 ? [["Streak", `${num(streak.length)} days`, "streak", `Longest run of days at the goal: ${wbShort(streak[0].days[0].day)} – ${wbShort(streak[streak.length - 1].days[0].day)}.`]] : []),
  ];
  const title = by === "day" ? `${M.title} a day` : `${M.title} a day, by ${by}`;
  const tip = M.goal ? `Each dot: the ${M.word} (a day, or a day on average in the week or month). Size and colour against the goal of ${num(M.goal)} ${M.word} a day (Options): full colour at the goal, turning red far above it (${num(M.goal * 2.5)} and more), fading towards none.`
    : `Each dot: the ${M.word} (a day, or a day on average in the week or month); no goal set (Options), so size and colour grow up to the busiest tenth of them.`;
  el.innerHTML = `<div class="card wb-dots">
      <div class="card-head"><h3 class="chart-title" data-tip="${esc(tip)}">${M.icon()}<span>${title}</span></h3><span class="spacer"></span>${headHtml}</div>
      <div class="chart-row">
        <div class="wb-grid" data-wb-grid></div>
        <div class="chart-stats wb-stats">${stats.map(([l, v, mark, t]) => (v == null ? "" : `<div class="chart-stat" data-wb-stat="${mark}" data-tip="${esc(t)}"><span class="chart-stat-label">${l}</span><span class="chart-ribbon" style="--c:${mark === "best" && best ? wbColor(best.v, M) : M.color}">${v}</span></div>`)).join("")}</div>
      </div></div>`;
  const grid = el.querySelector("[data-wb-grid]");
  const byKey = new Map(cells.map((c) => [`${c.row}|${c.col}`, c]));
  const api = {
    row: el.querySelector(".chart-row"),
    edges: () => null,
    sideNeed: () => WB_AVG_W + Math.ceil(Math.max(0, ...[...el.querySelectorAll(".wb-stats .chart-stat")].map((s) => s.getBoundingClientRect().width))) + 2,
    paint() { grid.innerHTML = wbGridSvg(grid.clientWidth, rows, cells, n, by, M, dec, ref, api.edges()); },
    // dots of these days marked, the others faded (null: all back)
    mark(daySet) {
      grid.classList.toggle("marking", !!daySet);
      grid.querySelectorAll("circle[data-k]").forEach((c) => c.classList.toggle("mark", !!daySet && byKey.get(c.dataset.k).days.some((d) => daySet.has(d.day))));
    },
  };
  const ro = new ResizeObserver(() => { if (!grid.isConnected) { ro.disconnect(); return; } api.paint(); });
  ro.observe(grid);
  // a dot hovered: its week or month shown on every chart; a row's average hovered: that row's
  // dots marked, the others faded
  grid.onmouseover = (e) => {
    const k = e.target.dataset?.k, row = e.target.dataset?.row;
    if (row) { api.mark(new Set(cells.filter((c) => c.row === row).flatMap((c) => c.days.map((d) => d.day)))); return; }
    onDot(k ? byKey.get(k).days[0].day : null);
  };
  grid.onmouseout = (e) => { if (e.target.dataset?.row) api.mark(null); };
  grid.onmouseleave = () => onDot(null);
  // hovering a stat marks its dots: Best its dot, Goal met the dots at the goal, Streak its days;
  // Avg is a value only (marks nothing)
  const sets = { best: best ? [best] : [], met, streak };
  let pinned = null; // a clicked stat keeps its marking (until it is clicked again)
  el.querySelectorAll("[data-wb-stat]:not([data-wb-stat=avg])").forEach((s) => {
    const on = () => api.mark(new Set(sets[s.dataset.wbStat].flatMap((c) => c.days.map((d) => d.day))));
    s.onmouseenter = on;
    s.onmouseleave = () => (pinned ? pinned.onmouseenter() : api.mark(null));
    s.onclick = () => {
      pinned?.classList.remove("pinned");
      pinned = pinned === s ? null : s;
      pinned?.classList.add("pinned");
      if (pinned) on();
    };
  });
  return api;
}

function wbGridSvg(width, rows, cells, n, by, M, dec, ref, edges) {
  const L = edges?.left ?? 62, T = 4, B = 30; // plot left (as the columns), room for the x axis
  const pw = Math.max(120, (edges?.right ?? width) - L), pitch = pw / n;
  const rowH = by === "month" ? Math.max(20, Math.min(36, pitch)) : by === "week" ? 22 : Math.max(14, Math.min(24, pitch));
  const H = T + rows.length * rowH + B;
  const rMax = Math.max(2, Math.min(pitch, rowH) / 2 - 1);
  const rowIdx = new Map(rows.map(([k], i) => [k, i]));
  const cx = (col) => L + (col - 0.5) * pitch, cy = (i) => T + (i + 0.5) * rowH;
  const ax = width + 6; // the averages: in the side column, past the gap
  const parts = [];
  rows.forEach(([key, label], i) => { // dashed row lines (the grid), labels, averages
    parts.push(`<line class="wb-row-line" x1="${L}" x2="${L + pw}" y1="${cy(i)}" y2="${cy(i)}"/>`);
    parts.push(`<text class="wb-lab" x="${L - 6}" y="${cy(i)}" text-anchor="end" dominant-baseline="central">${esc(label)}</text>`);
    const avg = wbAvg(cells.filter((c) => c.row === key), (c) => c.v);
    if (avg != null) parts.push(`<text class="wb-avg" data-row="${key}" x="${ax}" y="${cy(i)}" dominant-baseline="central" data-tip="${esc(`${label}: ${num(avg, M.dec)} ${M.word} a day on average`)}">${num(avg, M.dec)}</text>`);
  });
  parts.push(`<rect class="wb-frame" x="${L}" y="${T}" width="${pw}" height="${rows.length * rowH}"/>`);
  for (const c of cells) {
    const i = rowIdx.get(c.row);
    if (i == null) continue;
    const share = c.v / ref;
    const r = Math.max(1.3, rMax * Math.sqrt(Math.min(share, 1.2) / 1.2));
    const a = share >= 1 ? 1 : 0.07 + 0.93 * share ** 2;
    const tip = `${c.label}\n${num(c.v, dec)} ${M.word}${by === "day" ? "" : " a day"}${M.goal ? ` · ${num(share * 100)} % of the goal` : ""}`;
    parts.push(`<circle data-k="${c.row}|${c.col}" class="${M.goal && share >= 1 ? "met" : ""}" cx="${cx(c.col)}" cy="${cy(i)}" r="${r.toFixed(1)}" style="fill:${wbColor(c.v, M)}" fill-opacity="${a.toFixed(2)}" data-tip="${esc(tip)}"/>`);
  }
  // x axis: days 1, 5, 10 … 31 | weeks every 4 | months
  const ticks = by === "day" ? [1, 5, 10, 15, 20, 25, 31] : by === "week" ? [1, 5, 9, 13, 17, 21, 25, 29, 33, 37, 41, 45, 49, 53] : [...Array(12)].map((_, k) => k + 1);
  const yb = T + rows.length * rowH;
  for (const t of ticks) parts.push(`<text class="wb-tick" x="${cx(t)}" y="${yb + 12}" text-anchor="middle">${by === "month" ? WB_MONTHS[t - 1] : by === "week" ? `W${t}` : t}</text>`);
  const xTitle = by === "day" ? "Day of the month" : by === "week" ? "Week of the year" : "";
  if (xTitle) parts.push(`<text class="wb-xtitle" x="${L + pw / 2}" y="${yb + 26}" text-anchor="middle">${xTitle}</text>`);
  parts.push(`<text class="wb-xtitle" x="${ax}" y="${yb + 12}" data-tip="Average ${M.word} a day in the row">Avg</text>`);
  return `<svg class="wb-svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}">${parts.join("")}</svg>`;
}

// ---- steps as columns ---------------------------------------------------------------------

// Goal and Goal met (it marks every column at the goal, in full colour; the others fade).
const wbMetRanges = (values, goal) => values.map((x, i) => (x != null && x >= goal ? [i, i] : null)).filter(Boolean);
function wbGoalStats(values, goal, per, word, unit = "") {
  const v = values.filter((x) => x != null);
  if (!goal || !v.length) return [];
  return [["Goal", `${num(goal)}${unit}`, goal, `The ${word} goal (Options).`],
    ["Goal met", `${num((v.filter((x) => x >= goal).length / v.length) * 100)} %`, { ranges: wbMetRanges(values, goal) }, `Share of the ${per} at the goal or above.`]];
}
function wbStepStats(values, per, goal) {
  const v = values.filter((x) => x != null);
  if (!v.length) return [];
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  return [["Avg", num(avg), avg, "Average steps a day."], ["Max", num(Math.max(...v)), "max"], ...wbGoalStats(values, goal, per, "step")];
}
const WB_STEPS = { key: "steps", label: "Steps", unit: "", dec: 0, bars: true, barSize: 0.88, yMin: 0, icon: "steps" };
const wbAccent = () => cssVar("--accent") || "#5b8def";

// Mixed: a column per day (its own group, x = the days with steps).
function wbDailySteps(days, headHtml, goal) {
  const values = days.map((d) => d.steps);
  return { x: { date: days.map((d) => wbMs(d.day) / 1000) }, kind: "date", xExact: (v) => wbDayLabel(isoDay(new Date(v * 1000))),
    series: [{ ...WB_STEPS, title: "Steps a day", yTitle: "Steps", color: wbAccent(), values, headHtml,
      tip: "Steps of each day; hovering Goal shows the goal as a dashed line.", stats: wbStepStats(values, "days", goal) }] };
}
// Weeks / Months of one year: the average day of each period.
function wbPeriodSteps(periods, by, headHtml, goal) {
  const values = periods.map((p) => wbAvg(p.days, (d) => d.steps));
  return { ...WB_STEPS, title: `Steps a day, by ${by}`, yTitle: "Steps a day", color: wbAccent(), values, headHtml,
    tip: `Steps a day, on average over the ${by}.`, stats: wbStepStats(values, `${by}s`, goal) };
}

// Several years (Weeks / Months): a line per year over the weeks or months of the year, its
// average steps a day, as Statistics compares years (newest first, pills on the right).
function wbYearSteps(periods, by, headHtml, goal) {
  const n = by === "month" ? 12 : 53, xs = [...Array(n)].map((_, i) => i + 1);
  const years = [...new Set(periods.map((p) => p.year))].sort().reverse();
  const lines = years.map((y, k) => {
    const values = xs.map((no) => { const p = periods.find((q) => q.year === y && q.no === no); return p ? wbAvg(p.days, (d) => d.steps) : null; });
    return { label: y, values, color: SERIES_COLORS[k % SERIES_COLORS.length] };
  });
  const tags = lines.map((l) => {
    const i = l.values.findLastIndex((v) => v != null);
    return { label: l.label, value: i >= 0 ? l.values[i] : null, i, color: l.color, text: i >= 0 ? num(l.values[i]) : "–" };
  });
  let top = null;
  for (const l of lines) l.values.forEach((v, i) => { if (v != null && (!top || v > top.v)) top = { v, i, l }; });
  const name = (i) => (by === "month" ? MONTHS[i] : `week ${i + 1}`);
  const stats = [...(top ? [["Max", num(top.v), { i: top.i, values: top.l.values, color: top.l.color }, `Most steps a day in one ${by}: ${num(top.v)} in ${name(top.i)} ${top.l.label}`]] : []),
    ...(goal ? [["Goal", num(goal), goal, "The step goal (Options)."]] : [])];
  return { x: { [by]: xs }, kind: by, series: [{ key: "steps-years", label: "Steps", title: `Steps a day, by ${by}`, icon: "steps", yTitle: "Steps a day", unit: "", dec: 0,
    multi: true, points: true, tagsInside: true, lines, tags, stats, yMin: 0, color: lines[0].color, headHtml,
    tip: `Steps a day on average in each ${by}, one line per year.` }] };
}

// ---- floors, intensity minutes, calories: a column per week or month ---------------------

function wbBars(periods, by, goals, acts = []) {
  // a column at the middle of its period: the short last week of a year and the long first one
  // keep even gaps (columns are as wide as the smallest gap allows)
  const xs = periods.map((p) => Math.round((wbMs(p.from) + wbMs(p.to)) / 2 / 1000));
  const label = new Map(xs.map((x, i) => [x, periods[i].name])); // under the x axis: "Week 12 2026"
  const floors = periods.map((p) => wbAvg(p.days, (d) => d.floors));
  const intensity = periods.map((p) => { const v = wbAvg(p.days, (d) => d.intensity); return v == null ? null : v * 7; }); // the average day × 7
  const kcal = periods.map((p) => wbAvg(p.days, (d) => d.calories_active));
  const igoal = goals.intensity;
  // the activities under the intensity minutes: one icon per week or month, at its column (the
  // type done most often first), with their count; hovering marks the column
  const at = new Map(periods.flatMap((p, i) => p.days.map((d) => [d.day, xs[i]])));
  const freq = {};
  acts.forEach((a) => { freq[a.activity_type] = (freq[a.activity_type] || 0) + 1; });
  const marks = acts.filter((a) => at.has(a.day)).map((a) => ({ x: at.get(a.day), icon: typeIcon(a.activity_type, 13), href: `#/activity/${a.id}`, act: a }));
  const inPeriod = (x) => marks.filter((m) => m.x === x);
  const count = (m) => inPeriod(m.x).filter((o) => o.act.activity_type === m.act.activity_type).length;
  marks.sort((p, q) => p.x - q.x || count(q) - count(p) || (freq[q.act.activity_type] || 0) - (freq[p.act.activity_type] || 0));
  const stat = (vals, dec, unit) => {
    const v = vals.filter((x) => x != null);
    if (!v.length) return [];
    const avg = v.reduce((a, b) => a + b, 0) / v.length;
    return [["Avg", `${num(avg, dec)}${unit}`, avg], ["Max", `${num(Math.max(...v), dec)}${unit}`, "max"]];
  };
  const per = `${by}s`;
  const series = [
    { key: "floors", label: "Floors", title: `Floors a day, by ${by}`, yTitle: "Floors a day", unit: "", dec: 1, color: "#93cf99", bars: true, barSize: 0.88, yMin: 0, values: floors,
      iconHtml: DAY_CONTENT.floors[2](), tip: `Floors climbed a day, on average over the ${by} (about 3 m of ascent each).`,
      stats: [...stat(floors, 1, ""), ...wbGoalStats(floors, goals.floors, per, "floor")] },
    { key: "intensity", label: "Intensity minutes", title: `Intensity minutes a week${by === "week" ? "" : ", by month"}`, yTitle: "Intensity", unit: "min", dec: 0, color: "#f5b27f", bars: true, barSize: 0.88, yMin: 0, values: intensity,
      iconHtml: DAY_CONTENT.intensity[2](), tip: "Moderate minutes plus vigorous minutes counted twice, as Garmin counts them: the average day of the period × 7.",
      marks, marksPerX: true, marksTip, onMarks: marksPopup, stats: [...stat(intensity, 0, " min"), ...wbGoalStats(intensity, igoal, per, "weekly intensity", " min")] },
    { key: "calories", label: "Active calories", title: `Active calories a day, by ${by}`, yTitle: "Active calories", unit: "kcal", dec: 0, color: "#e99bbf", bars: true, barSize: 0.88, yMin: 0, values: kcal,
      icon: "active_calories", tip: `Calories burned by moving, without the resting (BMR) part; a day on average over the ${by}.`, stats: stat(kcal, 0, " kcal") },
  ].filter((s) => s.values.some((v) => v != null));
  return { x: { date: xs }, kind: "date", series, xExact: (v) => label.get(v) || "" };
}

// ---- Body -----------------------------------------------------------------------------------
// On top: a silhouette (a quarter of the width) filled with the layers of the last full body
// composition, beside it the weight with its moving average (and the weight goal); under them,
// the whole width, the layers as a share of the weight (stacked, fat at the bottom; a click on a
// layer's pill hides it, so e.g. fat alone can be compared; the fat goal dashed). X-axis: every
// weigh-in, or the average of each week or month.

const WB_LAYERS = [ // bottom to top
  ["fat", "Fat", "#f5b041"],
  ["muscle", "Muscle", "#26a69a"],
  ["bone", "Bone", "#9fb3c8"],
  ["other", "Other", "#4f8ff0"],
];
// The layers drawn (the silhouette and the chart): "other" (the rest of the weight) is left out
const WB_CHART_LAYERS = WB_LAYERS.filter(([k]) => k !== "other");
// Weight › Additional series: [key, label]; on their own y axis on the right
const WB_EXTRA = [["", "None"], ["load", "Training load"]];
const WB_LOAD = "#7c5cd6";
const WB_WEIGHT = "#86aef5", WB_WEIGHT_AVG = "#e8833a", WB_GOAL_GREY = "#8d99ae";
const WB_AVG_DAYS = 90; // the weight's moving average: the mean of the last 90 days
const WB_SCALE_ICON = `<svg class="tb-metric-icon" viewBox="0 0 24 24" width="18" height="18" style="--tb-metric-size:18px;color:var(--m-energy)" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4" ${iconLine()}/><path d="M8 9.5a5 5 0 0 1 8 0" ${iconLine()}/><path d="m12 11 1.6-2.4" ${iconLine(1.8)}/></svg>`;

// The layers of a weigh-in in kg (fat from its share, the rest is what fat, muscle and bone
// leave); null without a full composition.
function wbLayersKg(r) {
  if (r?.fat_pct == null || !r.weight) return null;
  const fat = (r.weight * r.fat_pct) / 100, muscle = r.muscle_kg || 0, bone = r.bone_kg || 0;
  return { fat, muscle, bone, other: Math.max(0, r.weight - fat - muscle - bone) };
}

// Points of the charts: every weigh-in, or the average of each week or month (each value over
// the weigh-ins that have it). { x (unix s), label, weight, fat_pct, muscle_kg, bone_kg, … }
function wbBodyPoints(items, by) {
  const keys = ["weight", "fat_pct", "water_pct", "muscle_kg", "bone_kg", "bmi"];
  if (by === "day") {
    return items.map((r) => ({ ...r, x: Date.parse(r.ts) / 1000, label: `${wbDayLabel(r.day)} ${r.ts.slice(11, 16)}` }));
  }
  return wbPeriods(items, by).map((p) => ({
    ...Object.fromEntries(keys.map((k) => [k, wbAvg(p.days, (d) => d[k])])),
    x: Math.round((wbMs(p.from) + wbMs(p.to)) / 2 / 1000), label: p.name, n: p.days.length,
  }));
}

// The training load of a point: the moving average of the daily load (Fitness) over the 30 days
// up to its day (a week or month: up to its last day).
const WB_LOAD_DAYS = 30;
function wbLoadOf(loads, p, by) {
  const end = by === "day" ? p.x : wbMs(p.to) / 1000;
  let sum = 0;
  for (let k = 0; k < WB_LOAD_DAYS; k++) sum += loads[isoDay(new Date((end - k * 86400) * 1000))] || 0;
  return sum / WB_LOAD_DAYS;
}

function wbBody(box, data, by, redraw) {
  WB_GROUPS.forEach((g) => g.destroy());
  WB_GROUPS = [];
  const goals = wbGoals();
  if (!data.items.length && !data.last) {
    box.innerHTML = `<div class="card">${hint("No weigh-ins yet: they come from a scale's FIT files (e.g. Garmin Index) in the import folder.")}</div>`;
    return;
  }
  const extra = data.fitness?.length && TAB.wbBodyExtra === "load" ? "load" : "";
  let pts = wbBodyPoints(data.items, by);
  if (by !== "day") { // the periods' first and last day (for the load)
    const per = wbPeriods(data.items, by);
    pts = pts.map((p, i) => ({ ...p, from: per[i].from, to: per[i].to }));
  }
  // two columns: the silhouette over the tiles | the weight over the composition (one width)
  box.innerHTML = `<div class="wb-body-grid"><div class="card wb-figure" data-wb-fig></div><div class="wb-weight" data-wb-weight></div>
    <div class="wb-tiles" data-wb-tiles></div><div class="wb-lwrap" data-wb-layers></div></div>`;
  wbTiles(box.querySelector("[data-wb-tiles]"), data);
  const figEl = box.querySelector("[data-wb-fig]");
  wbFigure(figEl, data.last_full, data.last, goals.fat);
  let weight = null;
  // the composition first: its pill column sets the width of the weight chart's pills
  const comp = pts.filter((p) => wbLayersKg(p));
  const layers = wbLayersChart(box.querySelector("[data-wb-layers]"), comp, by, goals.fat,
    (x) => weight?.hover(x == null ? null : wpts.findIndex((p) => p.x === x)));
  const lRow = box.querySelector(".wb-layers .chart-row");
  const mark = (k) => { // a layer pointed at on the figure or its pill: marked on both
    figEl.querySelector(".wb-fig-svg")?.classList.toggle("marking", !!k);
    figEl.querySelectorAll("[data-fig-layer]").forEach((x) => x.classList.toggle("mark", x.dataset.figLayer === k));
    layers.mark(k);
  };
  // the layer chosen alone (a click on its pill or on the figure) stays marked on the figure
  const rest = () => mark(TAB.wbLayerOnly || null);
  figEl.querySelectorAll("[data-fig-layer]").forEach((x) => {
    x.onmouseenter = () => mark(x.dataset.figLayer);
    x.onmouseleave = rest;
    x.onclick = () => box.querySelector(`.wb-layers [data-layer="${x.dataset.figLayer}"]`)?.click(); // as its pill
  });
  box.querySelectorAll(".wb-layers [data-layer]").forEach((x) => {
    x.onmouseenter = () => mark(x.dataset.layer);
    x.onmouseleave = rest;
    x.addEventListener("click", () => setTimeout(rest));
  });
  rest();
  const shared = { tagW: lRow ? Math.ceil(Math.max(0, ...[...lRow.querySelectorAll(".chart-stat")].map((x) => x.getBoundingClientRect().width))) : 0 };
  // with an additional series by weigh-in: a point every day (the weigh-ins on theirs), so the
  // series runs on between the weigh-ins
  let wpts = pts;
  if (extra && by === "day" && pts.length) {
    const byDay = new Map();
    pts.forEach((p) => { const d = p.ts.slice(0, 10); byDay.set(d, [...(byDay.get(d) || []), p]); });
    wpts = [];
    for (let t = wbMs(pts[0].ts.slice(0, 10)); t <= wbMs(pts[pts.length - 1].ts.slice(0, 10)); t += DAY) {
      const d = isoDay(new Date(t)), on = byDay.get(d);
      wpts.push({ x: t / 1000 + 43200, label: wbDayLabel(d), weight: on ? wbAvg(on, (q) => q.weight) : null, day: d });
    }
  }
  if (wpts.length) {
    const xs = wpts.map((p) => p.x), values = wpts.map((p) => p.weight);
    const win = WB_AVG_DAYS * 86400;
    const avg = xs.map((x, i) => (values[i] == null && extra ? null : wbAvg(wpts.filter((p, k) => k <= i && p.x > x - win), (p) => p.weight)));
    const lines = [{ label: `Moving average, ${WB_AVG_DAYS} days`, values: avg, color: WB_WEIGHT_AVG, dash: [7, 4] },
      ...(goals.weight ? [{ label: "Goal", values: xs.map(() => goals.weight), color: WB_GOAL_GREY, dash: [3, 4] }] : []),
      ...(extra === "load" ? [{ label: "Training load", values: wpts.map((p) => wbLoadOf(data.loads, by === "day" ? { x: p.x - 43200 } : p, by)), color: WB_LOAD, axis: "right",
        axisTitle: `Load, ${WB_LOAD_DAYS}-day average`, fill: true, fmt: (v) => num(v) }] : [])];
    const last = values.findLastIndex((v) => v != null), lastAvg = avg.findLastIndex((v) => v != null);
    // pills on the right at the height of their value (as Fitness): the latest weight, the
    // latest average, the goal
    const label0 = (i) => wpts[i].label;
    const tags = [{ label: "Weight", value: values[last], i: last, color: WB_WEIGHT, text: `${num(values[last], 1)} kg` },
      { label: "Moving average", value: avg[lastAvg], i: lastAvg, values: avg, color: WB_WEIGHT_AVG, text: `${num(avg[lastAvg], 1)} kg`,
        tip: `Moving average: the mean weight of the last ${WB_AVG_DAYS} days, ${num(avg[lastAvg], 1)} kg` },
      ...(goals.weight ? [{ label: "Goal", value: goals.weight, color: WB_GOAL_GREY, text: `${num(goals.weight, 1)} kg` }] : [])];
    // Max and Min: pills at their heights among the others; hovering marks the weigh-in
    let hi = -1, lo = -1;
    values.forEach((v, i) => { if (v != null && (hi < 0 || v > values[hi])) hi = i; if (v != null && (lo < 0 || v < values[lo])) lo = i; });
    const stats = hi < 0 ? [] : [
      ["Max", `${num(values[hi], 1)} kg`, { i: hi, values, color: WB_WEIGHT }, `Highest weight: ${num(values[hi], 1)} kg, ${label0(hi)}`],
      ["Min", `${num(values[lo], 1)} kg`, { i: lo, values, color: WB_WEIGHT }, `Lowest weight: ${num(values[lo], 1)} kg, ${label0(lo)}`]];
    const label = new Map(wpts.map((p) => [p.x, p.label]));
    const head = badgeHtml("wb-extra", "Additional series", WB_EXTRA.find(([k]) => k === extra)[1], { panel: `<div class="opt-panel">${pickList("wb-extra", WB_EXTRA, extra)}</div>`, right: true });
    weight = chartGroup(box.querySelector("[data-wb-weight]"), { x: { date: xs }, kind: "date", xExact: (v) => label.get(v) || "", shared,
      series: [{ key: "weight", label: "Weight", title: "Weight", yTitle: "Weight", unit: "kg", dec: 1, color: WB_WEIGHT, values, points: true, height: 330,
        iconHtml: WB_SCALE_ICON, lines, tags, stats, headHtml: `<div class="badges">${head}</div>`,
        tip: `${by === "day" ? "Every weigh-in" : `Average weight of each ${by}`}. Moving average (dashed): the mean weight of the last ${WB_AVG_DAYS} days.${extra ? ` Training load (right axis): the daily load, moving average of the last ${WB_LOAD_DAYS} days.` : ""}` }],
      onHover: (i) => layers.show(i == null ? null : comp.find((p) => Math.abs(p.x - xs[i]) < 43200)?.x ?? null) });
    WB_GROUPS.push(weight);
    const card = box.querySelector("[data-wb-weight]");
    bindBadges(card);
    card.querySelectorAll('[data-pick="wb-extra"]').forEach((b) => b.onclick = () => { TAB.wbBodyExtra = b.dataset.value; document.onclick?.(); redraw(); });
  }
  if (lRow) {
    const w = Math.ceil(shared.tagW || 0);
    if (w) lRow.style.setProperty("--side-w", `${w}px`);
    // one right edge: the composition's plot ends where the weight's does (its right axis too)
    requestAnimationFrame(() => {
      const over = box.querySelector("[data-wb-weight] .u-over");
      if (over) layers.setEdges(over.getBoundingClientRect().left, over.getBoundingClientRect().right); // page x
    });
  }
}

// Fitness age from VO2 max: the age at which that VO2 max is the average of the person's sex,
// interpolated in the norms of the HUNT fitness study (mean VO2 max by age, ml/kg/min); 20 to 80.
const WB_VO2_NORMS = {
  male: [[25, 54.4], [35, 49.0], [45, 47.7], [55, 42.6], [65, 39.2], [75, 35.5]],
  female: [[25, 43.0], [35, 40.0], [45, 38.4], [55, 34.4], [65, 31.1], [75, 28.6]],
};
function wbFitnessAge(vo2, sex) {
  const n = WB_VO2_NORMS[sex === "female" ? "female" : "male"];
  if (vo2 >= n[0][1]) return Math.max(20, n[0][0] - ((vo2 - n[0][1]) / (n[0][1] - n[1][1])) * 10);
  for (let i = 1; i < n.length; i++) {
    if (vo2 >= n[i][1]) return n[i - 1][0] + ((n[i - 1][1] - vo2) / (n[i - 1][1] - n[i][1])) * 10;
  }
  const [a, b] = n.slice(-2);
  return Math.min(80, b[0] + ((b[1] - vo2) / (a[1] - b[1])) * 10);
}

// The tiles under the silhouette (the activity's tile style), together as high as the
// composition: the latest value of the period large, a word on it, and a bar from the period's
// lowest to its highest with the latest value marked.
const WB_BMI_CLASSES = [[18.5, "Underweight"], [25, "Normal weight"], [30, "Overweight"], [Infinity, "Obese"]];
function wbTiles(el, data) {
  const tile = (title, icon, color, value, unit, note, last, lo, hi, fmt, loTip, hiTip, tip) => {
    const span = hi - lo, pos = span > 0 ? ((last - lo) / span) * 100 : 50;
    return `<div class="card wb-tile" style="--c:${color}">
      <h3 class="tile-title" data-tip="${esc(tip)}">${icon}<span>${title}</span></h3>
      <div class="wb-tile-main"><span class="wb-tile-value">${value}</span>${unit ? `<span class="wb-tile-unit">${unit}</span>` : ""}${note ? `<span class="wb-tile-note">${note}</span>` : ""}</div>
      <div class="wb-tile-range">
        <div class="wb-tile-bar"><i style="left:${pos.toFixed(1)}%"></i></div>
        <div class="wb-tile-ends"><span data-tip="${esc(loTip)}"><small>min</small> ${fmt(lo)}</span><span data-tip="${esc(hiTip)}"><small>max</small> ${fmt(hi)}</span></div>
      </div></div>`;
  };
  const bmi = data.items.filter((r) => r.bmi != null);
  const sex = person(CURRENT)?.sex;
  const vo2 = (data.fitness || []).filter((d) => d.date >= data.from && d.date <= data.to && (d.vo2_run ?? d.vo2_ride) != null)
    .map((d) => ({ day: d.date, vo2: d.vo2_run ?? d.vo2_ride }));
  const ages = vo2.map((d) => ({ ...d, age: wbFitnessAge(d.vo2, sex) }));
  const pick = (list, key, f) => list.reduce((b, x) => (!b || f(x[key], b[key]) ? x : b), null);
  let html = "";
  if (bmi.length) {
    const hi = pick(bmi, "bmi", (a, b) => a > b), lo = pick(bmi, "bmi", (a, b) => a < b), last = bmi[bmi.length - 1];
    html += tile("BMI", WB_SCALE_ICON, "#4f8ff0", num(last.bmi, 1), "", WB_BMI_CLASSES.find(([lim]) => last.bmi < lim)[1],
      last.bmi, lo.bmi, hi.bmi, (v) => num(v, 1), `Lowest in the period: ${wbShort(lo.day)}`, `Highest in the period: ${wbShort(hi.day)}`,
      "Body mass index of the last weigh-in in the period (the scale's): weight ÷ height². The bar runs from the period's lowest to its highest.");
  }
  if (ages.length) {
    const old = pick(ages, "age", (a, b) => a > b), young = pick(ages, "age", (a, b) => a < b), last = ages[ages.length - 1];
    html += tile("Fitness age", metricIcon("aerobic_effect", 18), "#26a69a", num(last.age), "years", "",
      last.age, young.age, old.age, (v) => num(v), `Lowest in the period: ${wbShort(young.day)}, VO2 max ${num(young.vo2, 1)}`,
      `Highest in the period: ${wbShort(old.day)}, VO2 max ${num(old.vo2, 1)}`,
      "The age at which your VO2 max (the watch's latest estimate from a run, else a ride) is the average for your sex (Settings › People). The bar runs from the period's lowest to its highest.");
  }
  el.innerHTML = html;
}

// Silhouettes: one smooth outline (the right half, mirrored) and the head, in a 120 × 300 box,
// the feet at 298. The person's sex (Settings › People) picks the figure, male when not set.
const WB_FIGURES = {
  male: { head: [60, 22, 13, 15], start: [65, 40], half: [
    [[65, 47], [67, 53], [72, 55]], [[80, 57], [90, 58], [96, 64]], [[101, 69], [104, 77], [105, 87]],
    [[106, 106], [108, 126], [108, 142]], [[108, 158], [107, 172], [106, 184]], [[106, 192], [104, 199], [100, 199]],
    [[96, 199], [95, 192], [95, 184]], [[95, 170], [95, 154], [94, 140]], [[93, 122], [92, 104], [85, 92]],
    [[84, 110], [82, 126], [81, 138]], [[82, 150], [85, 160], [85, 170]], [[85, 196], [82, 220], [80, 238]],
    [[78, 254], [79, 268], [76, 282]], [[75, 288], [79, 292], [79, 295]], [[79, 298], [65, 298], [64, 295]],
    [[64, 282], [65, 264], [64, 246]], [[63, 224], [63, 200], [62, 186]], [[62, 178], [61, 172], [60, 170]]] },
  female: { head: [60, 22, 12.5, 14.5], start: [64, 40], half: [
    [[64, 46], [66, 50], [70, 52]], [[77, 54], [85, 54], [90, 59]], [[95, 64], [98, 72], [99, 82]],
    [[100, 100], [102, 120], [102, 136]], [[102, 152], [101, 166], [100, 178]], [[100, 186], [98, 192], [94, 192]],
    [[90, 192], [89, 186], [89, 178]], [[89, 164], [89, 148], [88, 134]], [[87, 118], [86, 100], [80, 88]],
    [[80, 102], [76, 116], [76, 128]], [[76, 142], [86, 152], [87, 170]], [[87, 196], [82, 220], [79, 238]],
    [[77, 254], [78, 268], [75, 282]], [[74, 288], [77, 292], [77, 295]], [[77, 298], [65, 298], [64, 295]],
    [[64, 282], [65, 264], [64, 246]], [[63, 224], [62, 200], [61, 186]], [[61, 178], [60.5, 174], [60, 172]]] },
};
// The outline as one path: down the right half, back up the left half (mirrored, reversed).
function wbFigurePath({ start, half }) {
  const m = ([x, y]) => `${120 - x} ${y}`, pt = ([x, y]) => `${x} ${y}`;
  const ends = [start, ...half.map((c) => c[2])];
  let d = `M${pt(start)}`;
  for (const [a, b, e] of half) d += `C${pt(a)} ${pt(b)} ${pt(e)}`;
  for (let i = half.length - 1; i >= 0; i--) d += `C${m(half[i][1])} ${m(half[i][0])} ${m(ends[i])}`;
  return `${d}Z`;
}

// The silhouette: the last full body composition, its layers filling the figure from the feet up
// in their share of the weight (fat at the bottom), a soft light across it; the fat goal dashed.
function wbFigure(el, full, last, fatGoal) {
  const r = full || last;
  if (!r) { el.innerHTML = hint("No weigh-in yet."); return; }
  const kg = wbLayersKg(full);
  const fig = WB_FIGURES[person(CURRENT)?.sex === "female" ? "female" : "male"];
  const TOP = 7, FEET = 298, H = FEET - TOP;
  const shape = `<ellipse cx="${fig.head[0]}" cy="${fig.head[1]}" rx="${fig.head[2]}" ry="${fig.head[3]}"/><path d="${wbFigurePath(fig)}"/>`;
  let y = FEET;
  const layers = kg ? WB_LAYERS.filter(([k]) => k !== "other").map(([k, label, color]) => { // the rest stays empty
    const h = (kg[k] / full.weight) * H;
    y -= h;
    return `<rect class="wb-fig-layer" data-fig-layer="${k}" x="0" y="${y.toFixed(2)}" width="120" height="${(h + 0.3).toFixed(2)}" fill="${color}" data-tip="${esc(`${label}: ${num(kg[k], 1)} kg · ${num((kg[k] / full.weight) * 100, 1)} % of ${num(full.weight, 1)} kg`)}"/>`
      + (y > TOP + 1 ? `<line x1="0" x2="120" y1="${y.toFixed(2)}" y2="${y.toFixed(2)}" class="wb-fig-sep"/>` : "");
  }).join("") : `<rect x="0" y="0" width="120" height="300" fill="${WB_WEIGHT}"><title>Weight ${num(r.weight, 1)} kg</title></rect>`;
  const goalY = kg && fatGoal ? FEET - (fatGoal / 100) * H : null;
  el.innerHTML = `<div class="card-head"><h3 class="chart-title">${WB_SCALE_ICON}<span>Body composition</span></h3><span class="spacer"></span><span class="wb-fig-date">${(r.ts || "").slice(0, 10) ? wbShort(r.ts.slice(0, 10)) : ""}</span></div>
    <div class="wb-fig-box"><svg class="wb-fig-svg" viewBox="0 0 120 306" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <defs>
        <clipPath id="wb-fig-clip">${shape}</clipPath>
        <linearGradient id="wb-fig-light" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stop-color="#000" stop-opacity=".10"/><stop offset=".38" stop-color="#fff" stop-opacity=".30"/>
          <stop offset=".62" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".14"/>
        </linearGradient>
        <radialGradient id="wb-fig-floor"><stop offset="0" stop-color="#000" stop-opacity=".22"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
      </defs>
      <ellipse cx="60" cy="300" rx="34" ry="4.5" fill="url(#wb-fig-floor)"/>
      <g clip-path="url(#wb-fig-clip)"><rect x="0" y="0" width="120" height="300" class="wb-fig-rest" data-tip="${esc(kg ? `The rest of the weight (organs, skin, water outside the muscles): ${num(kg.other, 1)} kg` : `Weight ${num(r.weight, 1)} kg; no body composition measured`)}"/>${layers}<rect x="0" y="0" width="120" height="300" fill="url(#wb-fig-light)" pointer-events="none"/></g>
      ${goalY != null ? `<line class="wb-fig-goal" x1="8" x2="112" y1="${goalY.toFixed(1)}" y2="${goalY.toFixed(1)}"><title>Body fat goal: ${num(fatGoal, 1)} %</title></line>` : ""}
    </svg></div>`;
}

// The layers as a share of the weight, stacked (fat at the bottom), over time: SVG in the chart
// card style (framed plot, dashed grid, axis titles); pills on the right with the latest share.
// A click on a pill leaves that layer alone: its own share as a line (no fill), the y range from
// its values; a click on it again brings all back. Returns { show(x | null), setRight(px) }.
function wbLayersChart(el, pts, by, fatGoal, onHover) {
  if (!pts.length) {
    el.innerHTML = `<div class="card">${hint("No body composition in this period: only scales that measure it (fat, muscle, bone) fill this chart.")}</div>`;
    return { show() {} };
  }
  const only = () => WB_CHART_LAYERS.find(([k]) => k === TAB.wbLayerOnly)?.[0] || null; // the layer shown alone
  const pct = pts.map((p) => { const kg = wbLayersKg(p); return Object.fromEntries(WB_LAYERS.map(([k]) => [k, (kg[k] / p.weight) * 100])); });
  const last = pct[pct.length - 1];
  const tip = "Each layer's share of the weight: fat (from the scale's fat %), muscle and bone (the scale's kg), stacked with fat at the bottom. Click a pill to see that layer alone.";
  el.innerHTML = `<div class="card wb-layers">
      <div class="card-head"><h3 class="chart-title" data-tip="${esc(tip)}">${WB_SCALE_ICON}<span>Composition${by === "day" ? "" : `, by ${by}`}</span></h3></div>
      <div class="chart-row">
        <div class="wb-layers-plot" data-wb-lplot><div class="wb-tip" hidden></div></div>
        <div class="chart-stats wb-lpills">${[...WB_CHART_LAYERS].reverse().map(([k, label, color]) => `<div class="chart-stat wb-layer${only() && only() !== k ? " off" : ""}" data-layer="${k}" data-tip="${esc(`${label}: ${num(last[k], 1)} % of the weight at the last weigh-in · click to show it alone (again: all)`)}"><span class="chart-stat-label">${label}</span><span class="chart-ribbon" style="--c:${color}">${num(last[k], 1)} %</span></div>`).join("")}</div>
      </div></div>`;
  const plot = el.querySelector("[data-wb-lplot]"), tipEl = plot.querySelector(".wb-tip");
  let hoverX = null, rightEdge = null, leftEdge = null, marked = null, Hh = 380; // its height: the grip changes it
  const geo = {};
  const paint = () => {
    const W = plot.clientWidth, T = 8, B = 34, R = 2;
    const L = leftEdge != null ? Math.max(40, leftEdge - plot.getBoundingClientRect().left) : 52; // the weight plot's left edge
    const edge = rightEdge != null ? rightEdge - plot.getBoundingClientRect().left : null; // the weight plot's right edge
    const pw = Math.max(100, (edge && edge <= W ? edge : W - R) - L), ph = Hh - T - B;
    const one = only(), vis = WB_CHART_LAYERS.filter(([k]) => !one || k === one);
    // the y range from the data: from just under the lowest boundary of the layers to just over
    // the highest; one layer: its own values
    const bounds = pct.map((p) => { let a = 0; return vis.map(([k]) => (a += p[k])); });
    const showGoal = fatGoal && vis.some(([k]) => k === "fat");
    const inner = bounds.flat();
    const lo0 = Math.min(...inner, showGoal ? fatGoal : Infinity), hi0 = Math.max(...inner, showGoal ? fatGoal : -Infinity);
    const pad = Math.max(one ? 0.3 : 1, (hi0 - lo0) * 0.12);
    const step = niceStep(Math.max(one ? 0.2 : 0.5, hi0 - lo0 + 2 * pad) / 6);
    const bottom = Math.max(0, Math.floor((lo0 - pad) / step) * step), top = Math.min(100, Math.ceil((hi0 + pad) / step) * step);
    const x0 = pts[0].x, x1 = pts[pts.length - 1].x, span = Math.max(1, x1 - x0);
    const X = (x) => L + (pts.length === 1 ? pw / 2 : ((x - x0) / span) * pw), Y = (v) => T + ph - ((v - bottom) / (top - bottom)) * ph;
    Object.assign(geo, { X, L, pw });
    const parts = [];
    for (let v = bottom; v <= top + 1e-9; v += step) {
      if (v > bottom && v < top) parts.push(`<line class="wb-row-line" x1="${L}" x2="${L + pw}" y1="${Y(v)}" y2="${Y(v)}"/>`);
      parts.push(`<text class="wb-tick" x="${L - 5}" y="${Y(v)}" text-anchor="end" dominant-baseline="central">${num(v, step < 1 ? 1 : 0)}</text>`);
    }
    parts.push(`<clipPath id="wb-lclip"><rect x="${L}" y="${T}" width="${pw}" height="${ph}"/></clipPath><g clip-path="url(#wb-lclip)">`);
    // one layer: its line; all: the stacked areas, bottom up
    if (one) {
      const color = vis[0][2], line = pct.map((p, i) => `${X(pts[i].x).toFixed(1)},${Y(p[one]).toFixed(1)}`);
      parts.push(`<polyline points="${line.join(" ")}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round"/>`);
      pct.forEach((p, i) => parts.push(`<circle cx="${X(pts[i].x).toFixed(1)}" cy="${Y(p[one]).toFixed(1)}" r="2.6" fill="${color}"/>`));
    }
    let base = pct.map(() => 0);
    for (const [k, , color] of one ? [] : vis) {
      const upper = pct.map((p, i) => base[i] + p[k]);
      const fwd = upper.map((v, i) => `${X(pts[i].x).toFixed(1)},${Y(v).toFixed(1)}`);
      const back = base.map((v, i) => `${X(pts[i].x).toFixed(1)},${Y(v).toFixed(1)}`).reverse();
      const dim = marked && marked !== k;
      parts.push(`<polygon points="${[...fwd, ...back].join(" ")}" fill="${color}" fill-opacity="${dim ? 0.18 : 0.85}"/>`);
      parts.push(`<polyline points="${fwd.join(" ")}" fill="none" stroke="${color}" stroke-width="1.5"/>`);
      base = upper;
    }
    parts.push("</g>");
    // the pills at the height of their layer's top at the last point; one layer alone: its pill at
    // the line's end, Max and Min at theirs (the points marked), the other layers' pills at the
    // bottom of the column (to pick another)
    const pills = el.querySelector(".wb-lpills");
    pills.style.height = `${Hh}px`;
    pills.querySelectorAll(".wb-lext").forEach((x) => x.remove());
    const n = pct.length - 1, at = (v) => Y(Math.min(top, Math.max(bottom, v))) - 22; // the ribbon's middle on the value
    let acc = 0;
    const want = [], rest = [];
    for (const [k] of WB_CHART_LAYERS) {
      acc += pct[n][k];
      const pill = pills.querySelector(`[data-layer="${k}"]`);
      if (one && k !== one) rest.push(pill);
      else want.push({ pill, y: at(one ? pct[n][k] : acc) });
    }
    if (one) {
      const color = vis[0][2], vals = pct.map((p) => p[one]);
      const iMax = vals.indexOf(Math.max(...vals)), iMin = vals.indexOf(Math.min(...vals));
      for (const [label, i] of [["Max", iMax], ["Min", iMin]]) {
        pills.insertAdjacentHTML("beforeend", `<div class="chart-stat wb-lext" data-tip="${esc(`${label}: ${num(vals[i], 1)} %, ${pts[i].label}`)}"><span class="chart-stat-label">${label}</span><span class="chart-ribbon" style="--c:${color}">${num(vals[i], 1)} %</span></div>`);
        want.push({ pill: pills.lastElementChild, y: at(vals[i]) });
        parts.push(`<circle cx="${X(pts[i].x).toFixed(1)}" cy="${Y(vals[i]).toFixed(1)}" r="5" fill="${color}" stroke="var(--surface)" stroke-width="2"/>`);
      }
    }
    const placed = want.sort((p, q) => p.y - q.y);
    for (let i = 1; i < placed.length; i++) placed[i].y = Math.max(placed[i].y, placed[i - 1].y + 34); // never overlapping
    const low = Hh - 36 - rest.length * 34, over = placed.length ? placed[placed.length - 1].y - low : 0;
    if (over > 0) placed.forEach((w) => { w.y -= over; });
    placed.forEach((w) => { w.pill.style.top = `${Math.max(0, w.y)}px`; });
    rest.forEach((pill, k) => { pill.style.top = `${Hh - 36 - (rest.length - 1 - k) * 34}px`; });
    if (showGoal) parts.push(`<line class="wb-goal-line" x1="${L}" x2="${L + pw}" y1="${Y(fatGoal)}" y2="${Y(fatGoal)}"/><text class="wb-goal-text" x="${L + pw - 4}" y="${Y(fatGoal) - 4}" text-anchor="end">Fat goal ${num(fatGoal, 1)} %</text>`);
    parts.push(`<rect class="wb-frame" x="${L}" y="${T}" width="${pw}" height="${ph}"/>`);
    // x axis: months (the year on January and the first one), as many as fit
    const d0 = new Date(x0 * 1000), months = [];
    for (let k = 1; k < 1200; k++) { // the first day of every month after the first point
      const t = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + k, 1);
      if (t > x1 * 1000) break;
      const d = new Date(t);
      months.push([t / 1000, d.getUTCFullYear(), d.getUTCMonth()]);
    }
    const every = Math.max(1, Math.ceil(46 / (pw / Math.max(1, months.length + 1))));
    months.forEach(([t, y, m], k) => {
      if (k % every) return;
      const px = X(t);
      parts.push(`<line class="wb-frame" x1="${px}" x2="${px}" y1="${T + ph}" y2="${T + ph + 3}"/><text class="wb-tick" x="${px}" y="${T + ph + 13}" text-anchor="middle">${WB_MONTHS[m]}</text>`);
      if (m === 0 || k === 0) parts.push(`<text class="wb-tick" x="${px}" y="${T + ph + 25}" text-anchor="middle">${y}</text>`);
    });
    if (hoverX != null) {
      const i = pts.findIndex((p) => p.x === hoverX);
      if (i >= 0) {
        const px = X(hoverX);
        parts.push(`<line class="wb-cursor" x1="${px}" x2="${px}" y1="${T}" y2="${T + ph}"/>`);
        let acc = 0;
        for (const [k, , color] of vis) { acc = one ? pct[i][k] : acc + pct[i][k]; parts.push(`<circle cx="${px}" cy="${Y(acc)}" r="3.5" fill="${color}" stroke="var(--surface)" stroke-width="1.5"/>`); }
      }
    }
    const svg = `<svg class="wb-svg" width="${W}" height="${Hh}" viewBox="0 0 ${W} ${Hh}"><text class="wb-xtitle" transform="translate(11 ${T + ph / 2}) rotate(-90)" text-anchor="middle">Share of the weight (%)</text>${parts.join("")}<rect class="wb-hit" x="${L}" y="${T}" width="${pw}" height="${ph}"/></svg>`;
    plot.querySelector("svg")?.remove();
    plot.insertAdjacentHTML("afterbegin", svg);
  };
  const nearest = (px) => {
    let best = null;
    pts.forEach((p) => { const d = Math.abs(geo.X(p.x) - px); if (!best || d < best.d) best = { d, p }; });
    return best?.p || null;
  };
  const showTip = (x) => {
    const i = pts.findIndex((p) => p.x === x);
    if (i < 0) { tipEl.hidden = true; return; }
    const vis = WB_CHART_LAYERS.filter(([k]) => !only() || k === only());
    tipEl.innerHTML = `<div class="chart-tip-name">${esc(pts[i].label)}</div>${vis.map(([k, label, color]) => `<div><span class="chart-tip-name">${label}</span> <b style="color:${color}">${num(pct[i][k], 1)} %</b></div>`).join("")}`;
    tipEl.hidden = false;
    const px = geo.X(x);
    tipEl.style.left = `${px + 12 + 150 > plot.clientWidth ? px - 12 - tipEl.offsetWidth : px + 12}px`;
  };
  const api = {
    setEdges(left, right) { leftEdge = left; rightEdge = right; paint(); },
    mark(k) { marked = k; el.querySelectorAll("[data-layer]").forEach((x) => x.classList.toggle("on", x.dataset.layer === k)); paint(); },
    show(x) { hoverX = x != null && pts.some((p) => p.x === x) ? x : null; paint(); if (hoverX == null) tipEl.hidden = true; else showTip(hoverX); },
  };
  plot.addEventListener("mousemove", (e) => {
    if (!e.target.classList?.contains("wb-hit")) return;
    const p = nearest(e.clientX - plot.getBoundingClientRect().left);
    if (p && p.x !== hoverX) { api.show(p.x); onHover(p.x); }
  });
  plot.addEventListener("mouseleave", () => { api.show(null); onHover(null); });
  el.querySelectorAll("[data-layer]").forEach((pill) => pill.onclick = () => {
    TAB.wbLayerOnly = only() === pill.dataset.layer ? null : pill.dataset.layer;
    el.querySelectorAll("[data-layer]").forEach((x) => x.classList.toggle("off", !!only() && x.dataset.layer !== only()));
    paint();
  });
  const ro = new ResizeObserver(() => { if (!plot.isConnected) { ro.disconnect(); return; } paint(); });
  ro.observe(plot);
  // the grip on the card's bottom edge: the height, as every chart (this visit only)
  cardResize(el.querySelector(".wb-layers"), () => Hh, (h) => { Hh = h; paint(); }, 120, 640);
  paint();
  return api;
}
