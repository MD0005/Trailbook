"use strict";
// Gear › Equipment (docs/SPEC.md §12d, docs/CHARTS.md › Gear, Manual › Gear): shoes, bikes and
// other equipment, each a Home Assistant distance sensor the person adds in Options. The same
// look as Electronics: a row of square cards, the most distance first, each ring filled
// against it; In use, from the first day Home Assistant has statistics of; a table. A click on
// a card or a name opens the activities paired with it.

const EQ_SETTING = "equipment"; // ui setting of the person: [{entity, label}]
const EQ_VIEW = "equipment-view"; // ui setting of the person: {retired: "show" | "hide"}
// the integration whose gear sensors this tab is made for
const EQ_INTEGRATION = "https://github.com/cyberjunky/home-assistant-garmin_connect";
const eqList = () => (Array.isArray(UI.data[EQ_SETTING]) ? UI.data[EQ_SETTING] : []);
const eqView = () => ({ retired: "show", ...(UI.data[EQ_VIEW] || {}) });
const eqKm = (v) => (v == null ? "–" : `${num(v, v < 100 ? 1 : 0)} km`);
const EQ_KIND_LABEL = { shoe: "Shoes", bike: "Bike", ebike: "E-bike", trainer: "Trainer", equipment: "Equipment" };

const eqTip = (d) => [d.label, d.entity,
  d.missing ? "Home Assistant does not have this sensor now" : `${eqKm(d.km)} now${d.limit_km ? ` of ${num(d.limit_km)} km` : ""}`,
  d.activities == null ? null : `${gearCount(d.activities)} in Garmin Connect`,
  d.first ? `Used ${gearDate(d.first.day)} – ${gearDate(d.last.day)}` : "No use in Home Assistant's history yet",
  d.data_from ? `${gearCount(d.paired)} paired · history since ${gearDate(d.data_from)}` : null].filter(Boolean).join("\n");

// The list is saved at once (the page then asks the server again with it).
async function eqSave(list) {
  UI.data[EQ_SETTING] = list;
  await api(`ui-settings/${EQ_SETTING}?${new URLSearchParams({ person: UI.person })}`, { method: "PUT", body: JSON.stringify(list) });
  route();
}

// Options: retired shown or hidden; the equipment with its name and Remove; the sensors that
// can be added.
function eqOptions(sensors) {
  const chosen = eqList();
  const free = sensors.filter((s) => !chosen.some((x) => x.entity === s.entity));
  const names = chosen.map((x) => `<div class="opt-line" data-entity="${esc(x.entity)}">
      <input type="text" maxlength="60" value="${esc(x.label)}" aria-label="Name" data-tip="${esc(x.entity)}">
      <button type="button" class="badge" data-eq-remove>Remove</button></div>`).join("");
  return `${row(`Retired<small class="opt-hint">In Garmin Connect</small>`, pickList("eq-retired", [["show", "Shown"], ["hide", "Hidden"]], eqView().retired))}
    ${chosen.length ? row(`Equipment<small class="opt-hint">Names</small>`, names) : ""}
    ${row(`Add<small class="opt-hint">Home Assistant distance sensors, from <a href="${EQ_INTEGRATION}" target="_blank" rel="noopener">Garmin Connect by cyberjunky</a></small>`, `<div data-eq-add>${free.length
      ? gearChecks(free.map((s) => [s.entity, s.name, eqKm(s.km)]), "Add") : hint("No other distance sensors.")}</div>`)}`;
}

function eqBindOptions(panel, sensors, redraw) {
  panel.querySelectorAll('[data-pick="eq-retired"]').forEach((b) => b.onclick = () => {
    panel.querySelectorAll('[data-pick="eq-retired"]').forEach((o) => { o.classList.toggle("on", o === b); o.setAttribute("aria-checked", o === b); });
    saveUi(EQ_VIEW, { retired: b.dataset.value });
    redraw();
  });
  gearBindChecks(panel.querySelector("[data-eq-add]"), 1, (entities) => eqSave([...eqList(),
    ...sensors.filter((s) => entities.includes(s.entity)).map((s) => ({ entity: s.entity, label: String(s.name).slice(0, 60) }))]));
  panel.querySelectorAll(".opt-line[data-entity]").forEach((line) => {
    const entity = line.dataset.entity, input = line.querySelector("input");
    input.onchange = () => {
      const label = input.value.trim();
      if (label) eqSave(eqList().map((x) => (x.entity === entity ? { entity, label } : x)));
    };
    line.querySelector("[data-eq-remove]").onclick = () => eqSave(eqList().filter((x) => x.entity !== entity));
  });
}

async function renderEquipment(sw) {
  view.innerHTML = `${pageHead("Gear", badgeHtml("eq-options", "Options", "", { panel: `<div class="opt-panel gear-panel">${loaderHtml()}</div>` }), sw)}<div class="page-loader">${loaderHtml()}</div>`;
  const head = view.querySelector(".page-head");
  bindBadges(head);
  bindGearTabs(head);
  const [data, found] = await Promise.all([api("equipment?" + new URLSearchParams({ person: CURRENT })), api("equipment/sensors")]);
  const loader = view.querySelector(".page-loader");
  if (!loader || !head.isConnected) return; // another page meanwhile
  loader.remove();
  const panel = head.querySelector(".gear-panel");
  let redraw = () => {};
  panel.innerHTML = eqOptions(found.sensors);
  eqBindOptions(panel, found.sensors, () => redraw());
  const items = data.items;
  if (!items.length) {
    view.insertAdjacentHTML("beforeend", `<div class="card">${hint("Add a shoe or bike sensor from Home Assistant in Options.")}</div>`);
    return;
  }
  const colors = [...SERIES_COLORS, ...GEAR_MORE_COLORS];
  items.forEach((d) => {
    d.color = colors[d.order % colors.length];
    d.href = "#/activities?" + new URLSearchParams({ equipment: d.key });
    d.image = null;
  });
  const days = data.first_day ? [data.first_day, todayDay()] : null;
  view.insertAdjacentHTML("beforeend", `<div class="gear-rings"></div>
    ${days ? `<div class="card gear-span-card"><h3 class="chart-title" data-tip="The days the sensor grew; a break of 30 days or more is left empty">${metricIcon("date", 18)}<span>In use</span></h3>${gearSpans(eqRows(items), days, eqBar)}</div>` : ""}
    <div class="card gear-table-card"><h3 class="chart-title" data-tip="The most distance first">${metricIcon("distance_total", 18)}<span>Equipment</span></h3>${eqTable(items)}
      ${data.history ? "" : hint("Home Assistant did not give the history: no use and no activities.")}</div>`);
  if (days) bindGearSpans(view.querySelector(".gear-span"), days);
  const table = view.querySelector(".gear-table-card table");
  const trs = [...table.tBodies[0].rows];
  trs.forEach((tr, i) => { tr.dataset.key = items[i].key; });
  const rowsOf = (sel) => [...view.querySelectorAll(sel)];
  const labels = rowsOf(".gear-ylab"), tracks = rowsOf(".gear-row");
  const linked = view.querySelector(".gear-span");
  if (linked) gearLink(linked);
  gearLink(table.tBodies[0]);
  redraw = () => {
    if (!table.isConnected) return;
    const retired = new Set(items.filter((d) => d.retired).map((d) => d.key));
    view.querySelectorAll(".gear-span-card, .gear-table-card").forEach((c) => c.classList.toggle("gear-hide-retired", eqView().retired === "hide"));
    gearOrder([trs, labels, tracks], retired);
    const cards = items.filter((d) => !d.retired && d.km != null);
    gearCards(cards, {
      max: cards[0]?.km, amount: (d) => d.km, tip: eqTip,
      body: (d) => `<b class="gear-value">${eqKm(d.km)}</b><span class="gear-name">${esc(d.label)}</span>${d.activities == null ? "" : `<span class="gear-sub">${gearCount(d.activities)}</span>`}`,
    });
  };
  redraw();
  spreadColumns(table);
}

// The chart's rows: one per equipment, the first used on top.
const eqRows = (items) => items.map((d) => ({ start: d.first?.day || d.data_from || "9999", order: d.order, members: [d] }));
const eqBar = {
  label: (d) => eqTip(d),
  bar: (d, when) => `In use ${when}\n\n${eqTip(d)}`,
};

function eqTable(items) {
  const day = (m) => (!m ? "–" : m.activity_id ? `<a class="plain-link" href="#/activity/${m.activity_id}">${m.day}</a>` : m.day);
  const name = (d) => `${devicePic(d)}<span><b><i class="gear-dot" style="background:${d.color}"></i>${esc(d.label)}</b><span>${esc(EQ_KIND_LABEL[d.kind])}${d.retired ? " · retired" : ""}</span></span>`;
  const columns = [
    { key: "equipment", label: "Equipment", render: (d) => `<a class="plain-link gear-dev" href="${esc(d.href)}" data-tip="Show its activities">${name(d)}</a>` },
    { key: "distance", label: "Distance", icon: "distance_total", num: true, render: (d) => eqKm(d.km) },
    { key: "limit", label: "Limit", num: true, render: (d) => (d.limit_km && d.km != null ? `<span data-tip="${esc(`${eqKm(d.km)} of ${num(d.limit_km)} km`)}">${num(Math.round((d.km / d.limit_km) * 100))} %</span>` : "–") },
    { key: "count", label: "Activities", icon: "type", num: true, render: (d) => (d.activities == null ? "–" : num(d.activities)) },
    { key: "paired", label: "Paired", num: true, render: (d) => `<span data-tip="Activities paired with a growth of the sensor">${num(d.paired)}</span>` },
    { key: "time", label: "Time", icon: "timer_time", num: true, render: (d) => (d.time_s == null ? "–" : durMin(d.time_s)) },
    { key: "types", label: "Activity types", render: (d) => `<span class="gear-types">${d.types.map((t) => `<span data-tip="${esc(`${typeLabel(t.type)}: ${gearCount(t.activities)}`)}">${typeIcon(t.type)}</span>`).join("")}</span>` },
    { key: "first", label: "First used", icon: "date", render: (d) => day(d.first) },
    { key: "last", label: "Last used", icon: "date", render: (d) => day(d.last) },
  ];
  return tableHtml(columns, items, {}, items.length);
}
