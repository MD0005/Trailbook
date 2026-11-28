"use strict";
// Gear (its own tab; docs/SPEC.md §12d, docs/CHARTS.md › Gear, Manual › Gear). Electronics:
// a row of square cards, the most used device first, each with a ring filled against it and
// its battery; per device a bar over the stretches it was used (several devices can share one
// line); a table, the last used first, where a device is marked retired: faded and at the
// bottom there and on the bars, no card. The scale has weigh-ins only, so no card. Header:
// Time (All time on every visit) and Options (retired devices shown or hidden, lines joined;
// remembered per person). Hovering a device anywhere lights its card, bars and row; a click on
// it opens its activities. Each device keeps one colour. Equipment: equipment.js.

const GEAR_CARD_MIN = 150, GEAR_CARD_MIN_PHONE = 104, GEAR_GAP = 12; // px
const GEAR_TICK_PX = 52; // room a date label needs
const GEAR_TICK_STEPS = [["d", 7], ["m", 1], ["m", 2], ["m", 3], ["m", 6], ["m", 12], ["m", 24], ["m", 60]];
const GEAR_RETIRED = "gear-retired"; // ui setting of the person: keys of the retired devices
const GEAR_VIEW = "gear-view"; // ui setting of the person: Options, each "show" | "hide"
// [key, label, hint] of the Options rows
const GEAR_OPTIONS = [["retired", "Retired devices", "In the chart and table"]];
const GEAR_GROUPS = "gear-groups"; // ui setting of the person: [[device keys that share a line]]
const GEAR_TAB = "gear-tab"; // ui setting of the person: the part of Gear opened last
const GEAR_TABS = [["electronics", "Electronics", "watch"], ["equipment", "Equipment", "distance_total"]];
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
const gearGroups = () => (Array.isArray(UI.data[GEAR_GROUPS]) ? UI.data[GEAR_GROUPS] : []);

// The Gear page: the part named in the address, else the one used last. Equipment comes from
// Home Assistant: without it Electronics is the whole page.
async function renderGearPage(tab, params) {
  if (!APP.ha) {
    if (tab === "equipment") location.replace("#/gear/electronics");
    else await renderGear(params, "");
    return;
  }
  if (!GEAR_TABS.some(([k]) => k === tab)) tab = GEAR_TABS.some(([k]) => k === UI.data[GEAR_TAB]) ? UI.data[GEAR_TAB] : "electronics";
  if (UI.data[GEAR_TAB] !== tab) saveUi(GEAR_TAB, tab);
  const sw = switchHtml("gtab", GEAR_TABS.map(([k, l, icon]) => [k, `${metricIcon(icon, 16)}<span>${l}</span>`]), tab);
  if (tab === "equipment") await renderEquipment(sw);
  else await renderGear(params, sw);
}
const bindGearTabs = (head) => head.querySelectorAll("[data-switch=gtab]").forEach((b) => b.onclick = () => { location.hash = "#/gear/" + b.dataset.value; });

// Hovering a device in one place lights it everywhere: its card, bars and table row.
function gearLight(key) {
  view.querySelectorAll(".gear-card, .gear-ylab, .gear-row, .gear-table-card tr[data-key]")
    .forEach((x) => x.classList.toggle("hot", key != null && (x.dataset.keys || x.dataset.key || "").split(" ").includes(key)));
}
function gearLink(box) {
  box.onmouseover = (e) => gearLight(e.target.closest("[data-key]")?.dataset.key);
  box.onmouseleave = () => gearLight(null);
}

// Retired ones below the others, faded; a joined line when all of its devices are.
function gearOrder(lists, off) {
  const retired = (r) => (r.dataset.keys || r.dataset.key).split(" ").every((k) => off.has(k));
  for (const rows of lists) {
    for (const r of [...rows.filter((x) => !retired(x)), ...rows.filter(retired)]) {
      r.classList.toggle("gear-retired", retired(r));
      // the bars' cursor line stays the last child of the plot
      r.parentElement.insertBefore(r, r.parentElement.querySelector(":scope > .gear-cursor"));
    }
  }
}

// The cards on top, drawn anew (the old row's size watcher ends with it).
function gearCards(items, opts) {
  const old = view.querySelector(".gear-rings");
  const el = old.cloneNode(false);
  old.replaceWith(el);
  el.hidden = !items.length;
  if (items.length) gearRings(el, items, opts);
  gearLink(el);
}

// The chart's rows: a joined line takes the place of its devices (two or more of them shown).
function gearRows(devices) {
  const rows = [], taken = new Set();
  for (const keys of gearGroups()) {
    const members = devices.filter((d) => keys.includes(d.key) && !taken.has(d.key));
    if (members.length < 2) continue;
    members.forEach((d) => taken.add(d.key));
    rows.push({ members });
  }
  for (const d of devices) if (!taken.has(d.key)) rows.push({ members: [d] });
  for (const r of rows) {
    r.members.sort((a, b) => a.first.day.localeCompare(b.first.day) || a.order - b.order);
    r.start = r.members[0].first.day;
    r.order = r.members[0].order;
  }
  return rows;
}
const gearName = (d) => `${d.name}${gearTag(d) ? ` ${gearTag(d)}` : ""}`;
const gearBar = {
  label: (d) => gearTip(d),
  bar: (d, when) => `${d.weighins ? "Weighed" : "In use"} ${when}\n\n${gearTip(d)}`,
};

// A list in an Options panel to pick several from, and its button (enabled with `min` picked).
const gearChecks = (items, button) => `<div class="checks-col">${items.map(([v, label, note]) =>
  `<label class="check"><input type="checkbox" value="${esc(v)}"><span>${esc(label)}${note ? ` <small>${esc(note)}</small>` : ""}</span></label>`).join("")}</div>
  <div class="opt-actions"><button type="button" class="badge" disabled>${button}</button></div>`;
function gearBindChecks(box, min, done) {
  const button = box.querySelector(".opt-actions button");
  if (!button) return;
  const picked = () => [...box.querySelectorAll("input[type=checkbox]:checked")].map((x) => x.value);
  box.querySelectorAll("input[type=checkbox]").forEach((x) => x.onchange = () => { button.disabled = picked().length < min; });
  button.onclick = (e) => { e.stopPropagation(); done(picked()); }; // the panel is drawn anew: stay open
}

// Options › One line: the lines joined (each with Separate) and the devices to join.
function gearJoinHtml(devices) {
  const groups = gearGroups().map((keys) => ({ keys, members: devices.filter((d) => keys.includes(d.key)) })).filter((g) => g.members.length);
  const taken = new Set(gearGroups().flat());
  const free = devices.filter((d) => !taken.has(d.key));
  const lines = groups.map((g) => `<div class="opt-line"><span>${g.members.map((d) => esc(gearName(d))).join(" + ")}</span><button type="button" class="badge" data-separate="${esc(g.keys.join(" "))}">Separate</button></div>`).join("");
  return row(`One line<small class="opt-hint">Devices that share a line of the chart</small>`,
    `${lines}${free.length > 1 ? gearChecks(free.map((d) => [d.key, gearName(d)]), "Join") : ""}`);
}

async function renderGear(params, sw) {
  GEAR_REDRAW = null;
  const options = `<div class="opt-panel gear-panel">${GEAR_OPTIONS.map(([key, label, hint]) => row(`${label}<small class="opt-hint">${hint}</small>`,
    pickList(`gear-${key}`, [["show", "Shown"], ["hide", "Hidden"]], gearView()[key]))).join("")}<div data-gear-join></div></div>`;
  view.innerHTML = `${pageHead("Gear", timeBadge(params) + badgeHtml("gear-options", "Options", "", { panel: options }), sw)}<div class="page-loader">${loaderHtml()}</div>`;
  const head = view.querySelector(".page-head");
  bindBadges(head);
  bindGearTabs(head);
  bindFilterBadges(head, "#/gear/electronics", params);
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
  // the x axis: the days of the Time filter, else from the first device to today
  const days = Object.keys(time).length ? statWindow(params) : [data.first_day, todayDay()];
  view.insertAdjacentHTML("beforeend", `<div class="gear-rings"></div>
    <div class="card gear-span-card"><h3 class="chart-title" data-tip="When each device was used; a break of 30 days or more is left empty">${metricIcon("date", 18)}<span>In use</span></h3><div data-spans></div></div>
    <div class="card gear-table-card"><h3 class="chart-title" data-tip="The last used first">${metricIcon("watch", 18)}<span>Devices</span></h3>${gearTable(devices)}
      ${data.without ? hint(`${gearCount(data.without)} without device information.`) : ""}</div>`);
  const table = view.querySelector(".gear-table-card table");
  const trs = [...table.tBodies[0].rows];
  trs.forEach((tr, i) => { tr.dataset.key = devices[i].key; });
  gearLink(table.tBodies[0]);
  // the chart with its joined lines, drawn anew when they change
  const chart = () => {
    const box = view.querySelector("[data-spans]");
    box.innerHTML = gearSpans(gearRows(devices), days, gearBar);
    bindGearSpans(box.querySelector(".gear-span"), days);
    gearLink(box);
  };
  // the cards and the rows follow the retired devices and the Options
  const mark = () => {
    const off = new Set(gearRetired()), shown = gearView();
    view.querySelectorAll(".gear-span-card, .gear-table-card").forEach((c) => {
      for (const [key] of GEAR_OPTIONS) c.classList.toggle(`gear-hide-${key}`, shown[key] === "hide");
    });
    const active = devices.filter((d) => d.time_s != null && !off.has(d.key))
      .sort((a, b) => b.time_s - a.time_s || b.activities - a.activities);
    gearCards(active, {
      max: active[0]?.time_s, amount: (d) => d.time_s, tip: gearTip, badge: (d) => gearBattery(d.battery),
      body: (d) => `<b class="gear-value">${hours(d.time_s)}</b><span class="gear-name">${esc(d.name)}${gearTag(d) ? ` <i>${gearTag(d)}</i>` : ""}</span>`,
    });
    const rowsOf = (sel) => [...view.querySelectorAll(sel)];
    gearOrder([trs, rowsOf(".gear-ylab"), rowsOf(".gear-row")], off);
    table.querySelectorAll("[data-retire]").forEach((b) => {
      const on = off.has(b.dataset.retire);
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on);
    });
  };
  const join = head.querySelector("[data-gear-join]");
  const drawJoin = () => {
    join.innerHTML = gearJoinHtml(devices);
    const change = (groups) => { saveUi(GEAR_GROUPS, groups); drawJoin(); chart(); mark(); };
    gearBindChecks(join, 2, (keys) => change([...gearGroups(), keys]));
    join.querySelectorAll("[data-separate]").forEach((b) => b.onclick = (e) => {
      e.stopPropagation();
      change(gearGroups().filter((keys) => keys.join(" ") !== b.dataset.separate));
    });
  };
  table.querySelectorAll("[data-retire]").forEach((b) => b.onclick = () => {
    const off = gearRetired(), key = b.dataset.retire;
    saveUi(GEAR_RETIRED, off.includes(key) ? off.filter((k) => k !== key) : [...off, key]);
    mark();
  });
  drawJoin();
  chart();
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

// As many cards as one row takes. `max` / `amount`: the ring's share; `tip`, `body` and
// `badge` (top right) of a card.
function gearRings(el, items, { max, amount, tip, body, badge }) {
  const card = (d) => `<a class="card gear-card" data-key="${esc(d.key)}" href="${esc(d.href)}" data-tip="${esc(tip(d))}">${badge ? badge(d) : ""}
    <div class="gear-ring">${max && amount(d) ? gearRing(amount(d) / max, d.color) : ""}${devicePic(d)}</div>
    ${body(d)}</a>`;
  let shown = 0;
  const fit = () => {
    if (!el.isConnected) { ro.disconnect(); return; }
    const min = matchMedia("(max-width: 760px)").matches ? GEAR_CARD_MIN_PHONE : GEAR_CARD_MIN;
    const n = Math.max(1, Math.floor((el.clientWidth + GEAR_GAP) / (min + GEAR_GAP)));
    if (n === shown) return;
    shown = n;
    el.style.gridTemplateColumns = `repeat(${n}, minmax(0, 1fr))`;
    el.innerHTML = items.slice(0, n).map(card).join("");
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

// A line per row, the first used on top, its picture on the y axis; a bar per stretch of
// use. A row of several (`members`) is one bar: each in its colour, the height shared where
// their stretches overlap. rows: [{members, start, order}]; tips: {label(d), bar(d, when)}.
function gearSpans(rows, days, tips) {
  const { at } = gearAxis(days);
  const when = ([first, last]) => (first === last ? gearDate(first) : `${gearDate(first)} – ${gearDate(last)}`);
  const place = (from, to) => `left:min(${from}%, 100% - 4px);width:${to - from}%`;
  const edges = ([first, last]) => [dayMs(first), dayMs(last) + 86400000];
  const single = (d) => d.spans.map((x) => `<i class="gear-bar" style="${place(...edges(x).map(at))};background:${d.color}" data-tip="${esc(tips.bar(d, when(x)))}"></i>`).join("");
  const joined = (members) => {
    const all = members.flatMap((d) => d.spans.map((x) => ({ d, x, from: edges(x)[0], to: edges(x)[1] }))).sort((a, b) => a.from - b.from);
    const bars = []; // stretches that touch or overlap are one bar
    for (const part of all) {
      const last = bars.at(-1);
      if (last && part.from <= last.to) { last.to = Math.max(last.to, part.to); last.parts.push(part); } else bars.push({ from: part.from, to: part.to, parts: [part] });
    }
    return bars.map((b) => {
      const cuts = [...new Set(b.parts.flatMap((q) => [q.from, q.to]))].sort((x, y) => x - y);
      const width = b.to - b.from;
      const slices = cuts.slice(0, -1).map((from, i) => {
        const to = cuts[i + 1], here = b.parts.filter((q) => q.from <= from && q.to >= to);
        return here.map((q, k) => `<b data-key="${esc(q.d.key)}" style="left:${((from - b.from) / width) * 100}%;width:${((to - from) / width) * 100}%;top:${(k / here.length) * 100}%;height:${100 / here.length}%;background:${q.d.color}" data-tip="${esc(tips.bar(q.d, when(q.x)))}"></b>`).join("");
      }).join("");
      return `<span class="gear-bar gear-join" style="${place(at(b.from), at(b.to))}">${slices}</span>`;
    }).join("");
  };
  const sorted = [...rows].sort((a, b) => a.start.localeCompare(b.start) || a.order - b.order);
  const keys = (r) => `data-key="${esc(r.members[0].key)}" data-keys="${esc(r.members.map((d) => d.key).join(" "))}"`;
  const label = (r) => {
    const [first] = r.members;
    if (r.members.length === 1) return `<div class="gear-ylab" ${keys(r)} data-tip="${esc(tips.label(first))}">${devicePic(first)}${gearTag(first) ? `<i>${gearTag(first)}</i>` : ""}</div>`;
    const tip = `${num(r.members.length)} devices in one line\n${r.members.map((d) => `${gearName(d)}: ${gearDate(d.first.day)} – ${gearDate(d.last.day)}`).join("\n")}`;
    return `<div class="gear-ylab" ${keys(r)} data-tip="${esc(tip)}">${devicePic(first)}<i>×${num(r.members.length)}</i></div>`;
  };
  return `<div class="gear-span">
    <div class="gear-yaxis">${sorted.map(label).join("")}</div>
    <div class="gear-plot">${sorted.map((r) => `<div class="gear-row" ${keys(r)}>${r.members.length === 1 ? single(r.members[0]) : joined(r.members)}</div>`).join("")}<i class="gear-cursor" hidden></i></div>
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
