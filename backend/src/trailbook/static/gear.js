"use strict";
// Statistics › Gear (docs/SPEC.md › Statistics, docs/CHARTS.md › Statistics, Manual › Gear):
// a row of square cards, the most used device first, each with a ring filled against it and
// its battery; per device a bar over the stretches it was used; a table, the last used first,
// where a device is marked retired: faded and at the bottom there and on the bars, no card.
// The scale has weigh-ins only, so no card. Header: Time (All time on every visit) and
// Options (retired devices shown or hidden, remembered per person). Hovering a device
// anywhere lights its card, bars and row; a click on it opens its activities. Each device
// keeps one colour.

const GEAR_CARD_MIN = 150, GEAR_CARD_MIN_PHONE = 104, GEAR_GAP = 12; // px
const GEAR_TICK_PX = 52; // room a date label needs
const GEAR_TICK_STEPS = [["d", 7], ["m", 1], ["m", 2], ["m", 3], ["m", 6], ["m", 12], ["m", 24], ["m", 60]];
const GEAR_RETIRED = "gear-retired"; // ui setting of the person: keys of the retired devices
const GEAR_VIEW = "gear-view"; // ui setting of the person: Options, each "show" | "hide"
// [key, label, hint] of the Options rows
const GEAR_OPTIONS = [["retired", "Retired devices", "In the chart and table"]];
// The series colours and a few more: a person soon has more than ten devices.
const GEAR_MORE_COLORS = ["#7aa95c", "#a8628f", "#4d7f94", "#c4645a", "#6f6bb8", "#8c7a5b"];
// How full the battery is drawn for a status without a percentage.
const GEAR_BATTERY = { new: 1, good: 0.8, ok: 0.6, low: 0.25, critical: 0.08 };

// "14 Apr 2026" (without the year: "14 Apr")
const gearMonth = (day) => MONTHS[+day.slice(5, 7) - 1].slice(0, 3);
const gearDate = (day, year = true) => `${+day.slice(8, 10)} ${gearMonth(day)}${year ? ` ${day.slice(0, 4)}` : ""}`;
const gearCount = (n) => `${num(n)} ${n === 1 ? "activity" : "activities"}`;
const gearRetired = () => (Array.isArray(UI.data[GEAR_RETIRED]) ? UI.data[GEAR_RETIRED] : []);
const gearView = () => ({ retired: "show", ...(UI.data[GEAR_VIEW] || {}) });
// What tells two devices of one name apart: the end of the serial number.
const gearTag = (d) => (!d.twin ? "" : d.serial ? `…${String(d.serial).slice(-4)}` : "no serial");
const gearKind = (d) => [d.maker, DEVICE_KIND_LABEL[d.kind]].filter(Boolean).join(" · ");
const gearWeighins = (n) => `${num(n)} ${n === 1 ? "weigh-in" : "weigh-ins"}`;
const gearTip = (d) => [`${d.name}${gearTag(d) ? ` ${gearTag(d)}` : ""}`, gearKind(d),
  d.serial ? `Serial number ${d.serial}` : "No serial number in the files",
  `${gearDate(d.first.day)} – ${gearDate(d.last.day)}`,
  d.weighins ? gearWeighins(d.weighins) : `${gearCount(d.activities)} · ${durMin(d.time_s)} · ${km(d.distance_m)}`].join("\n");

// Options changed while the page shows: redraws it (set once the data is there).
let GEAR_REDRAW = null;

async function renderGear(params, sw) {
  GEAR_REDRAW = null;
  const options = `<div class="opt-panel">${GEAR_OPTIONS.map(([key, label, hint]) => row(`${label}<small class="opt-hint">${hint}</small>`,
    pickList(`gear-${key}`, [["show", "Shown"], ["hide", "Hidden"]], gearView()[key]))).join("")}</div>`;
  view.innerHTML = `${pageHead("Statistics", timeBadge(params) + badgeHtml("gear-options", "Options", "", { panel: options }), sw)}<div class="page-loader">${loaderHtml()}</div>`;
  const head = view.querySelector(".page-head");
  bindBadges(head);
  bindFilterBadges(head, "#/stats", { ...params, tab: "gear" });
  GEAR_OPTIONS.forEach(([key]) => head.querySelectorAll(`[data-pick="gear-${key}"]`).forEach((b) => b.onclick = () => {
    head.querySelectorAll(`[data-pick="gear-${key}"]`).forEach((o) => { o.classList.toggle("on", o === b); o.setAttribute("aria-checked", o === b); });
    saveUi(GEAR_VIEW, { ...gearView(), [key]: b.dataset.value });
    GEAR_REDRAW?.();
  }));
  const time = Object.fromEntries(Object.entries(filterQuery(params)).filter(([k]) => TIME_KEYS.includes(k)));
  const data = await api("stats/gear?" + new URLSearchParams({ person: CURRENT, ...time }));
  const loader = view.querySelector(".page-loader");
  if (!loader || !head.isConnected) return; // another page meanwhile
  loader.remove();
  const devices = data.devices;
  if (!devices.length) {
    view.insertAdjacentHTML("beforeend", `<div class="card">${hint(Object.keys(time).length ? "No activity with devices in this period." : "No activity names the devices that recorded it.")}</div>`);
    return;
  }
  const colors = [...SERIES_COLORS, ...GEAR_MORE_COLORS];
  devices.forEach((d) => {
    d.color = colors[d.order % colors.length];
    // the scale is in no activity
    d.href = d.weighins ? null : "#/activities?" + new URLSearchParams({ ...time, device: d.key });
  });
  // the x axis: the days of the Time filter, else from the first activity to today
  const days = Object.keys(time).length ? statWindow(params) : [data.first_day, todayDay()];
  view.insertAdjacentHTML("beforeend", `<div class="gear-rings"></div>
    <div class="card gear-span-card"><h3 class="chart-title" data-tip="When each device was used; a break of 30 days or more is left empty">${metricIcon("date", 18)}<span>In use</span></h3>${gearSpans(devices, days)}</div>
    <div class="card gear-table-card"><h3 class="chart-title" data-tip="The last used first">${metricIcon("watch", 18)}<span>Devices</span></h3>${gearTable(devices)}
      ${data.without ? hint(`${gearCount(data.without)} without device information.`) : ""}</div>`);
  bindGearSpans(view.querySelector(".gear-span"), days);
  const table = view.querySelector(".gear-table-card table");
  // the rows as first drawn (table: the last used first; bars: the first used first)
  const rowsOf = (sel) => [...view.querySelectorAll(sel)];
  const trs = [...table.tBodies[0].rows], labels = rowsOf(".gear-ylab"), tracks = rowsOf(".gear-row");
  trs.forEach((tr, i) => { tr.dataset.key = devices[i].key; });
  // hovering a device in one place lights it in all three: its card, bars and table row
  const light = (key) => view.querySelectorAll(".gear-card, .gear-ylab, .gear-row, .gear-table-card tr[data-key]")
    .forEach((x) => x.classList.toggle("hot", x.dataset.key === key));
  const link = (box) => {
    box.onmouseover = (e) => light(e.target.closest("[data-key]")?.dataset.key);
    box.onmouseleave = () => light(null);
  };
  link(view.querySelector(".gear-span"));
  link(table.tBodies[0]);
  // the cards and the rows follow the retired devices (faded, moved below the others) and
  // the Options
  const mark = () => {
    const off = gearRetired(), shown = gearView();
    view.querySelectorAll(".gear-span-card, .gear-table-card").forEach((c) => {
      for (const [key] of GEAR_OPTIONS) c.classList.toggle(`gear-hide-${key}`, shown[key] === "hide");
    });
    const old = view.querySelector(".gear-rings");
    const el = old.cloneNode(false);
    old.replaceWith(el); // the old row's size watcher ends with it
    const active = devices.filter((d) => d.time_s != null && !off.includes(d.key))
      .sort((a, b) => b.time_s - a.time_s || b.activities - a.activities);
    el.hidden = !active.length;
    if (active.length) gearRings(el, active);
    link(el);
    for (const rows of [trs, labels, tracks]) {
      const retired = (r) => off.includes(r.dataset.key);
      for (const r of [...rows.filter((x) => !retired(x)), ...rows.filter(retired)]) {
        r.classList.toggle("gear-retired", retired(r));
        // the bars' cursor line stays the last child of the plot
        r.parentElement.insertBefore(r, r.parentElement.querySelector(":scope > .gear-cursor"));
      }
    }
    table.querySelectorAll("[data-retire]").forEach((b) => {
      const on = off.includes(b.dataset.retire);
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on);
    });
  };
  table.querySelectorAll("[data-retire]").forEach((b) => b.onclick = () => {
    const off = gearRetired(), key = b.dataset.retire;
    saveUi(GEAR_RETIRED, off.includes(key) ? off.filter((k) => k !== key) : [...off, key]);
    mark();
  });
  mark();
  spreadColumns(table);
  GEAR_REDRAW = () => { if (table.isConnected) mark(); };
}

// The battery as the last activity that tells: a percentage where the files give one (the
// watch, the bike computer), else the status only.
function gearBattery(b) {
  if (!b) return "";
  const share = b.level != null ? b.level / 100 : GEAR_BATTERY[b.status];
  if (share == null) return "";
  const cls = share <= 0.1 ? "b-critical" : share <= 0.25 ? "b-low" : "";
  const value = b.level != null ? `${num(b.level)} %` : b.status;
  return `<span class="gear-bat ${cls}" data-tip="${esc(`Battery: ${value}\nIn the activity of ${gearDate(b.day)}`)}">
    <svg viewBox="0 0 24 12" aria-hidden="true"><rect x=".75" y=".75" width="19.5" height="10.5" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="21.5" y="3.5" width="2" height="5" rx="1" fill="currentColor"/><rect x="2.75" y="2.75" width="${(15.5 * share).toFixed(1)}" height="6.5" rx="1.2" fill="currentColor"/></svg>${b.level != null ? `<i>${value}</i>` : ""}</span>`;
}

// The ring: only its filled part, from the top clockwise; the most used device closes it.
function gearRing(share, color) {
  const r = 45, round = 2 * Math.PI * r;
  return `<svg class="gear-arc" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="${r}" fill="none" stroke="${color}"
    stroke-width="8" stroke-linecap="round" stroke-dasharray="${share >= 1 ? "none" : `${(share * round).toFixed(2)} ${round.toFixed(2)}`}" transform="rotate(-90 50 50)"/></svg>`;
}

// As many cards as one row takes.
function gearRings(el, devices) {
  const max = devices[0].time_s;
  const card = (d) => `<a class="card gear-card" data-key="${esc(d.key)}" href="${esc(d.href)}" data-tip="${esc(gearTip(d))}">${gearBattery(d.battery)}
    <div class="gear-ring">${max && d.time_s ? gearRing(d.time_s / max, d.color) : ""}${devicePic(d)}</div>
    <b class="gear-value">${hours(d.time_s)}</b>
    <span class="gear-name">${esc(d.name)}${gearTag(d) ? ` <i>${gearTag(d)}</i>` : ""}</span></a>`;
  let shown = 0;
  const fit = () => {
    if (!el.isConnected) { ro.disconnect(); return; }
    const min = matchMedia("(max-width: 760px)").matches ? GEAR_CARD_MIN_PHONE : GEAR_CARD_MIN;
    const n = Math.max(1, Math.floor((el.clientWidth + GEAR_GAP) / (min + GEAR_GAP)));
    if (n === shown) return;
    shown = n;
    el.style.gridTemplateColumns = `repeat(${n}, minmax(0, 1fr))`;
    el.innerHTML = devices.slice(0, n).map(card).join("");
  };
  const ro = new ResizeObserver(fit);
  ro.observe(el);
  fit();
}

// The days the chart covers, both whole.
function gearAxis([first, last]) {
  const lo = dayMs(first), hi = Math.max(dayMs(last), lo) + 86400000;
  return { lo, hi, at: (ms) => ((ms - lo) / (hi - lo)) * 100 };
}

// A row per device, the first used on top, its picture on the y axis; a bar per stretch of use.
function gearSpans(devices, days) {
  const { at } = gearAxis(days);
  const rows = [...devices].sort((a, b) => a.first.day.localeCompare(b.first.day) || a.order - b.order);
  const bar = (d, [first, last]) => {
    const from = at(dayMs(first)), to = at(dayMs(last) + 86400000);
    const what = d.weighins ? "Weighed" : "In use";
    const tip = `${what} ${first === last ? gearDate(first) : `${gearDate(first)} – ${gearDate(last)}`}\n\n${gearTip(d)}`;
    return `<i class="gear-bar" style="left:min(${from}%, 100% - 4px);width:${to - from}%;background:${d.color}" data-tip="${esc(tip)}"></i>`;
  };
  return `<div class="gear-span">
    <div class="gear-yaxis">${rows.map((d) => `<div class="gear-ylab" data-key="${esc(d.key)}" data-tip="${esc(gearTip(d))}">${devicePic(d)}${gearTag(d) ? `<i>${gearTag(d)}</i>` : ""}</div>`).join("")}</div>
    <div class="gear-plot">${rows.map((d) => `<div class="gear-row" data-key="${esc(d.key)}">${d.spans.map((x) => bar(d, x)).join("")}</div>`).join("")}<i class="gear-cursor" hidden></i></div>
    <span></span><div class="gear-xaxis"><div data-ticks></div><span class="gear-flag" hidden></span></div></div>`;
}

// Date labels in even steps that fit the width; the first one and every January carry the year.
function gearTicks({ lo, hi, at }, width) {
  const room = Math.max(1, Math.floor(width / GEAR_TICK_PX));
  const days = (hi - lo) / 86400000;
  const [unit, step] = GEAR_TICK_STEPS.find(([u, n]) => days / (u === "d" ? n : n * 30.44) <= room) || GEAR_TICK_STEPS.at(-1);
  const out = [];
  const d = new Date(lo);
  if (unit === "d") d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7)); // Mondays
  else {
    if (d.getUTCDate() > 1) d.setUTCMonth(d.getUTCMonth() + 1, 1);
    while ((d.getUTCFullYear() * 12 + d.getUTCMonth()) % step) d.setUTCMonth(d.getUTCMonth() + 1);
  }
  while (+d < hi) {
    const day = isoDay(d), year = d.getUTCFullYear();
    const label = unit === "d" ? gearDate(day, false) : step >= 12 ? String(year) : gearMonth(day);
    const withYear = step < 12 && (!out.length || out.at(-1).year !== year);
    out.push({ left: at(+d), year, html: `${label}${withYear ? `<br>${year}` : ""}` });
    if (unit === "d") d.setUTCDate(d.getUTCDate() + step); else d.setUTCMonth(d.getUTCMonth() + step);
  }
  return out.map((t) => `<span style="left:${t.left}%">${t.html}</span>`).join("");
}

// The x axis labels (redrawn with the width) and, under the cursor, a line with the date.
function bindGearSpans(el, days) {
  const axis = gearAxis(days);
  const plot = el.querySelector(".gear-plot"), ticks = el.querySelector("[data-ticks]");
  const line = el.querySelector(".gear-cursor"), flag = el.querySelector(".gear-flag");
  let width = 0;
  const draw = () => {
    if (!el.isConnected) { ro.disconnect(); return; }
    if (plot.clientWidth === width) return;
    width = plot.clientWidth;
    ticks.innerHTML = gearTicks(axis, width);
    line.hidden = flag.hidden = true; // placed for the old width
  };
  const ro = new ResizeObserver(draw);
  ro.observe(plot);
  draw();
  plot.onpointermove = (e) => {
    const box = plot.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - box.left - plot.clientLeft, 0), plot.clientWidth - 1);
    const ms = axis.lo + (x / plot.clientWidth) * (axis.hi - axis.lo);
    line.hidden = flag.hidden = false;
    line.style.left = `${x}px`;
    flag.textContent = gearDate(isoDay(new Date(ms)));
    const half = flag.offsetWidth / 2;
    flag.style.left = `${Math.min(Math.max(x, half), plot.clientWidth - half)}px`;
  };
  plot.onpointerleave = () => { line.hidden = flag.hidden = true; };
}

function gearTable(devices) {
  const types = (d) => (d.weighins ? gearWeighins(d.weighins)
    : `<span class="gear-types">${d.types.map((t) => `<span data-tip="${esc(`${typeLabel(t.type)}: ${gearCount(t.activities)}`)}">${typeIcon(t.type)}</span>`).join("")}</span>`);
  const day = (m) => (m.activity_id ? `<a class="plain-link" href="#/activity/${m.activity_id}">${m.day}</a>` : m.day);
  const name = (d) => `${devicePic(d)}<span><b><i class="gear-dot" style="background:${d.color}"></i>${esc(d.name)}</b><span>${esc(gearKind(d))}</span></span>`;
  const columns = [
    { key: "device", label: "Device", render: (d) => (d.href ? `<a class="plain-link gear-dev" href="${esc(d.href)}" data-tip="Show its activities">${name(d)}</a>` : `<span class="gear-dev">${name(d)}</span>`) },
    { key: "serial", label: "Serial number", render: (d) => d.serial ?? "–" },
    { key: "count", label: "Activities", icon: "type", num: true, render: (d) => (d.activities == null ? "–" : num(d.activities)) },
    { key: "distance", label: "Distance", icon: "distance_total", num: true, render: (d) => km(d.distance_m) },
    { key: "time", label: "Time", icon: "timer_time", num: true, render: (d) => durMin(d.time_s) },
    { key: "ascent", label: "Elevation gain", icon: "total_ascent", num: true, render: (d) => (d.ascent_m == null ? "–" : meters(Math.round(d.ascent_m))) },
    { key: "types", label: "Activity types", render: types },
    { key: "first", label: "First used", icon: "date", render: (d) => day(d.first) },
    { key: "last", label: "Last used", icon: "date", render: (d) => day(d.last) },
    { key: "retired", label: "", cls: "actions", render: (d) => `<button class="badge" data-retire="${esc(d.key)}" data-tip="A retired device is faded and listed last, here and in the chart, and has no card on top">Retired</button>` },
  ];
  return tableHtml(columns, devices, {}, devices.length);
}
