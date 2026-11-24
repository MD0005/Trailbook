// Home Assistant (SPEC §12b): the record notification automation, and dashboard cards made
// here (hacards.py). A card's page is #/embed/<id>: the Lovelace card `trailbook-card` shows
// it in a frame, and Cards shows the same page as its preview.

const HA_TABS = [
  ["cards", "Cards", svg(`<rect x="3" y="4" width="8" height="7" rx="1.5"/><rect x="13" y="4" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="7" rx="1.5"/><rect x="13" y="17" width="8" height="3" rx="1.5"/>`)],
  ["automation", "Record automation", svg(`<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3a3 3 0 0 1-3 4M7 5H4a3 3 0 0 0 3 4"/>`)],
];
const HA_KINDS = [["map", "Map"], ["activity", "Activity"], ["detail", "Activity detailed"], ["records", "Records"], ["calendar", "Calendar"]];
const HA_PERIODS = () => [["", "All time"], ...LAST_PERIODS.map(([k, , l]) => [k, l])];
const HA_WHICH = [[0, "Latest"], [1, "2nd latest"], [2, "3rd latest"]];
const HA_HEIGHTS = [250, 300, 400, 500, 600, 800].map((h) => [h, `${h} px`]);
const HA_ON = [[true, "On"], [false, "Off"]];
const HA_COLUMNS = [[1, "1"], [2, "2"], [3, "3"]];
// The record tables of a card, in the order picked (cards made before: one `group`).
const haRecordGroups = (c) => (Array.isArray(c.groups) ? c.groups : [c.group || "run"]).filter((g) => HA_RECORDS.some(([k]) => k === g));
const HA_RECORDS = [["run", "Running"], ["power", "Cycling power"], ["ride", "Cycling"], ["virtual", "Cycling virtual"],
  ["walk", "Walking & hiking"], ["segments", "Segments"]];
// The values an Activity card can show, in the order they are picked.
const HA_VALUES = [
  ["distance", "Distance", (a) => (a.distance_m >= 50 ? km(a.distance_m) : null)],
  ["time", "Time", (a) => (a.time_s ? dur(a.time_s) : null)],
  ["elapsed", "Elapsed time", (a) => (a.elapsed_s ? dur(a.elapsed_s) : null)],
  ["pace", "Pace / speed", (a) => {
    const sp = a.distance_m && a.time_s ? a.distance_m / a.time_s : a.avg_speed;
    return sp && a.distance_m >= 50 ? (ON_FOOT.has(a.category) ? pace(sp) : kmh(sp)) : null;
  }],
  ["max_speed", "Max speed", (a) => (a.max_speed ? kmh(a.max_speed) : null)],
  ["avg_hr", "Avg HR", (a) => (a.avg_hr ? bpm(a.avg_hr) : null)],
  ["max_hr", "Max HR", (a) => (a.max_hr ? bpm(a.max_hr) : null)],
  ["ascent", "Ascent", (a) => (a.ascent_m ? meters(a.ascent_m) : null)],
  ["power", "Avg power", (a) => (a.avg_power ? watts(a.avg_power) : null)],
  ["np", "Normalized power", (a) => (a.np_power ? watts(a.np_power) : null)],
  ["cadence", "Cadence", (a) => (a.avg_cadence ? cadence(a.avg_cadence, a.category) : null)],
  ["calories", "Calories", (a) => (a.calories ? kcal(a.calories) : null)],
  ["load", "Load", (a) => (a.load ? num(a.load) : null)],
  ["workout", "Training type", (a) => (workoutOf(a) ? workoutLabel(workoutOf(a)) : null)],
];

const haLabel = (options, v) => (options.find(([k]) => String(k) === String(v)) || options[0])[1];
const haSports = () => [["", "All sports"], ...(TYPES?.groups || []).filter((g) => (TYPES.types || []).some((t) => t.group === g.key && t.activities))
  .map((g) => [g.key, g.en])];
const haPersonOptions = (everyone = true) => [...realPeople().map((p) => [p.id, p.label]), ...(everyone ? [["", "Everyone"]] : [])];

// A card's own theme (light / dark), whatever theme Trailbook or Home Assistant shows.
const HA_THEMES = [["light", "Light"], ["dark", "Dark"]];
const haTheme = (c) => (c?.theme === "dark" ? "dark" : "light");

// A new card's settings (or the ones a card gets when its type changes): the people and the
// theme stay.
function haDefaults(kind, prev = {}) {
  return { theme: prev.theme || themeKey(), ...haKindDefaults(kind, prev) };
}
function haKindDefaults(kind, prev) {
  const first = CURRENT && CURRENT !== "all" ? CURRENT : realPeople()[0]?.id;
  const people = prev.people?.length ? prev.people : first ? [first] : [];
  if (kind === "map") {
    const m = loadMapSettings(); // starts from the Map tab's options
    return { people, period: "", sport: "", layer: "heatmap", view: "all", interactive: true, height: 400,
             map: m.map, heatmap: m.heatmap, tiles: { ...m.tiles, regions: [] } };
  }
  if (kind === "activity") return { people: people.slice(0, 1), which: 0, sport: "", values: ["distance", "time", "pace", "avg_hr", "ascent"], map: true, chart: false };
  if (kind === "detail") return { people: people.slice(0, 1), which: 0, sport: "" };
  if (kind === "records") return { people: (people.length ? people : first ? [first] : []).slice(0, 1), groups: ["run"], columns: 1, period: "" };
  return { people: people.slice(0, 1), weeks: 2, ahead: false, summary: true };
}

// ---- the page: Home Assistant › Record automation | Cards ---------------------------------

async function renderHa(tab, params) {
  tab = HA_TABS.some(([k]) => k === tab) ? tab : "cards";
  view.innerHTML = `${pageHead("Home Assistant", "", switchHtml("hatab", HA_TABS.map(([k, l, icon]) => [k, `${icon}<span>${l}</span>`]), tab))}<div id="tab" class="settings-body"></div>`;
  view.querySelectorAll("[data-switch=hatab]").forEach((b) => b.onclick = () => { location.hash = "#/ha/" + b.dataset.value; });
  const el = document.getElementById("tab");
  if (tab === "automation") await haAutomationTab(el);
  else await haCardsTab(el, params);
}

const HA_AUTOMATION = `alias: Trailbook - record notification
description: A notification for every new record from Trailbook.
triggers:
  - trigger: state
    entity_id: sensor.trailbook_records
    not_from: [unavailable, unknown]
    not_to: [unavailable, unknown, "0"]
conditions:
  # a record is always a change from a number: a restart of Home Assistant never repeats one
  - condition: template
    value_template: "{{ trigger.from_state is not none and trigger.from_state.state | is_number }}"
actions:
  # to a phone instead: action: notify.mobile_app_<your phone>
  - action: persistent_notification.create
    data:
      title: "{{ trigger.to_state.attributes.title }}"
      message: "{{ trigger.to_state.attributes.message }}"
mode: queued`;

function haCopyButton(text) {
  return `<button class="badge" data-copy="${esc(text)}">Copy</button>`;
}
function bindCopy(root) {
  root.querySelectorAll("[data-copy]").forEach((b) => b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copied"; } catch (e) { b.textContent = "Select and copy by hand"; }
    setTimeout(() => { b.textContent = "Copy"; }, 1500);
  });
}

async function haAutomationTab(el) {
  const [setup, last] = await Promise.all([api("ha/setup"), api("ha/records").catch(() => null)]);
  el.innerHTML = `<div class="card">
      <h3>Record notification <span class="title-note">(sensor.trailbook_records, after each import${setup.addon ? "" : "; only in the Home Assistant add-on"})</span></h3>
      <ol class="plain steps">
        <li>Home Assistant › Settings › Automations &amp; scenes › Create automation › Create new automation.</li>
        <li>⋮ › Edit in YAML, paste the text below, Save: a notification for every new record.</li>
      </ol>
      <pre class="ha-yaml">${esc(HA_AUTOMATION)}</pre>
      <div class="card-row">${haCopyButton(HA_AUTOMATION)}</div>
    </div>
    ${last?.title ? `<div class="card">
      <h3>Latest record sent <span class="title-note">(${esc(last.title)})</span></h3>
      <div class="ha-msg">${esc(last.message || "")}</div>
    </div>` : ""}`;
  bindCopy(el);
}

// ---- Cards: the creator ------------------------------------------------------------------

var HA = null; // { el, cards, card, draft, setup, timer, rev }; var: the preview frame reads window.parent.HA

async function haCardsTab(el, params) {
  const [cards, setup] = await Promise.all([api("ha/cards"), api("ha/setup")]);
  BASEMAPS ??= await api("basemaps"); // Options › Base map
  HA = { el, cards, setup, card: null, draft: true, timer: null, rev: 0 };
  const open = cards.find((c) => c.id === params.card);
  if (open) haEdit(open, false); else haNewDraft(false);
  haDraw();
}

const haCopy = (card) => JSON.parse(JSON.stringify(card));
function haNewDraft(draw = true) {
  HA.card = { name: "Map", kind: "map", config: haDefaults("map") };
  HA.draft = true;
  history.replaceState(null, "", "#/ha/cards");
  if (draw) haDraw();
}
function haEdit(card, draw = true) {
  HA.card = haCopy(card);
  HA.draft = false;
  history.replaceState(null, "", "#/ha/cards?" + new URLSearchParams({ card: card.id }));
  if (draw) { haDraw(); window.scrollTo({ top: 0, behavior: "smooth" }); }
}

// What is left to do in Home Assistant (add-on only): a card of steps, shown only when needed.
function haSetupHtml() {
  const { addon, install, url } = HA.setup;
  if (!addon) return "";
  const steps = [];
  if (!install || install.file === "no_access") steps.push("Update the Trailbook add-on, then restart it: it needs access to Home Assistant's config folder.");
  else {
    if (install.www_created) steps.push("Restart Home Assistant once: it serves the new <code>www</code> folder only after a restart.");
    if (install.resource === "failed" || install.resource == null) {
      steps.push(`Settings › Dashboards › ⋮ › Resources › Add resource: URL <code>${esc(url)}</code>, JavaScript module.`);
    }
  }
  return steps.length ? `<div class="card"><h3>Card in Home Assistant <span class="title-note">(once)</span></h3>
    <ol class="plain steps">${steps.map((l) => `<li>${l}</li>`).join("")}</ol></div>` : "";
}

// One frame: the creator (a new card, or the one being edited) with its preview; under it a
// frame for each card made, with a small preview, Edit and its text for the dashboard.
function haDraw() {
  const { el, card, cards, draft } = HA;
  el.innerHTML = `${haSetupHtml()}
    <div class="card">
      <div class="card-head"><h3>${draft ? "New card" : `Edit card <span class="title-note">(${esc(card.id)})</span>`}</h3></div>
      <div class="badges ha-bar" data-ha-opts></div>
      <div class="ha-frame ha-frame-${card.kind}"${card.kind === "records" ? ` style="max-width:${560 * (card.config.columns || 1)}px"` : ""}><iframe title="Card preview" data-ha-frame src="${haFrameSrc()}"></iframe></div>
      <div class="card-row ha-row">${draft ? `<button class="badge" data-ha-create>Create card</button>`
        : `<button class="badge" data-ha-new>New card</button><button class="badge danger" data-ha-del>Delete card</button>`}</div>
    </div>
    ${cards.length ? `<div class="cards ha-list">${cards.map(haCardFrame).join("")}</div>` : ""}`;
  bindBadges(el);
  bindCopy(el);
  el.querySelector("[data-ha-create]")?.addEventListener("click", async () => {
    const created = await api("ha/cards", { method: "POST", body: JSON.stringify({ name: card.name, kind: card.kind, config: card.config }) });
    HA.cards.push(created);
    haEdit(created);
  });
  el.querySelector("[data-ha-new]")?.addEventListener("click", () => haNewDraft());
  el.querySelector("[data-ha-del]")?.addEventListener("click", async () => {
    if (!confirm(`Delete the card "${card.name}"? A dashboard that shows it gets an empty card.`)) return;
    await api(`ha/cards/${encodeURIComponent(card.id)}`, { method: "DELETE" });
    HA.cards = HA.cards.filter((c) => c.id !== card.id);
    haNewDraft();
  });
  bindEditButtons(el);
  // the creator's preview takes the height its page asks for (the map: its height)
  const frame = el.querySelector("[data-ha-frame]");
  window.onmessage = (e) => {
    if (e.source === frame.contentWindow && e.data?.trailbook === "size") frame.style.height = `${e.data.height}px`;
  };
  haDrawOptions();
}

function bindEditButtons(root) {
  root.querySelectorAll("[data-ha-edit]").forEach((b) => b.onclick = () => haEdit(HA.cards.find((c) => c.id === b.dataset.haEdit)));
}

// A card made: its name and type, a small preview (half size, nothing to click), Edit, and the
// text for the dashboard.
function haCardFrame(c) {
  const yaml = haYaml(c);
  return `<div class="card ha-item${!HA.draft && HA.card.id === c.id ? " editing" : ""}" data-ha-item="${esc(c.id)}">
    <div class="card-head"><h3>${esc(c.name)} <span class="title-note">(${esc(haLabel(HA_KINDS, c.kind))})</span></h3></div>
    <div class="ha-mini"><iframe title="${esc(c.name)}" tabindex="-1" loading="lazy" src="${haMiniSrc(c)}"></iframe></div>
    <pre class="ha-yaml">${esc(yaml)}</pre>
    <div class="card-row"><button class="badge" data-ha-edit="${esc(c.id)}">Edit</button>${haCopyButton(yaml)}</div>
  </div>`;
}

// The creator's preview reads the card from this page (`_creator`), so it shows each change at
// once, saved or not; the small previews read the saved card.
const haFrameSrc = () => `index.html#/embed/_creator?${new URLSearchParams({ r: HA.rev })}`;
const haMiniSrc = (c) => `index.html#/embed/${encodeURIComponent(c.id)}?${new URLSearchParams({ r: HA.rev })}`;
const haYaml = (card) => `type: custom:trailbook-card\ncard: ${card.id}`;

// The card's settings: a badge each ("Label: value" with a pick list), as the map's filters.
function haDrawOptions() {
  const card = HA.card, c = card.config, k = card.kind;
  const bar = HA.el.querySelector("[data-ha-opts]");
  const one = (key, label, options, value, extra = {}) => badgeHtml(`ha-${key}`, label, esc(haLabel(options, value)), { panel: pickList(`ha.${key}`, options, value), ...extra });
  const checks = (key, label, options, chosen, value) => badgeHtml(`ha-${key}`, label, esc(value), {
    panel: `<div class="pick-list ha-checks">${options.map(([v, l]) => optCheck(`hax.${key}.${v}`, chosen.includes(v), esc(l))).join("")}</div>` });
  const peopleValue = (ids) => (ids.length ? ids.map((id) => personLabel(id)).join(", ") : "Everyone");
  const groupsValue = (keys) => (!keys.length ? "none" : keys.length === 1 ? haLabel(HA_RECORDS, keys[0]) : `${keys.length} tables`);
  const parts = [one("kind", "Type", HA_KINDS, k), one("theme", "Theme", HA_THEMES, haTheme(c))];
  if (k === "map") {
    parts.push(checks("people", "People", haPersonOptions(false), c.people || [], peopleValue(c.people || [])),
      one("period", "Period", HA_PERIODS(), c.period || ""), one("sport", "Sport", haSports(), c.sport || ""),
      one("layer", "Layer", [["heatmap", "Heatmap"], ["tiles", "Explorer tiles"]], c.layer || "heatmap"),
      one("view", "View", [["all", "All routes"], ["main", "Home area"]], c.view || "all"),
      one("interactive", "Move and zoom", HA_ON, c.interactive !== false),
      one("height", "Height", HA_HEIGHTS, c.height || 400),
      badgeHtml("ha-options", "Options", "", { panel: "<div data-settings></div>" }));
  } else if (k === "activity") {
    const values = (c.values || []).filter((v) => HA_VALUES.some(([key]) => key === v));
    parts.push(one("person", "Person", haPersonOptions(), c.people?.[0] || ""), one("which", "Activity", HA_WHICH, c.which || 0),
      one("sport", "Sport", haSports(), c.sport || ""),
      checks("values", "Values", HA_VALUES.map(([key, l]) => [key, l]), values, values.length ? `${values.length} shown` : "none"),
      one("map", "Map", HA_ON, c.map !== false), one("chart", "Chart", HA_ON, !!c.chart));
  } else if (k === "detail") {
    parts.push(one("person", "Person", haPersonOptions(), c.people?.[0] || ""), one("which", "Activity", HA_WHICH, c.which || 0),
      one("sport", "Sport", haSports(), c.sport || ""));
  } else if (k === "records") {
    parts.push(one("person", "Person", haPersonOptions(false), c.people?.[0] || realPeople()[0]?.id),
      checks("groups", "Records", HA_RECORDS, haRecordGroups(c), groupsValue(haRecordGroups(c))),
      one("columns", "Columns", HA_COLUMNS, c.columns || 1), one("period", "Period", HA_PERIODS(), c.period || ""));
  } else {
    parts.push(one("person", "Person", haPersonOptions(), c.people?.[0] || ""),
      one("weeks", "Weeks", [1, 2, 3, 4, 6].map((n) => [n, String(n)]), c.weeks || 2),
      one("ahead", "Next week", HA_ON, !!c.ahead), one("summary", "Week summary", HA_ON, c.summary !== false));
  }
  parts.push(badgeHtml("ha-name", "Name", esc(card.name), { panel: `<div class="opt-panel"><input type="text" class="ha-name" maxlength="60" value="${esc(card.name)}"></div>` }));
  bar.innerHTML = parts.join("");
  bindBadges(bar);
  // one choice: saved, the badges drawn again (the panel closes)
  bar.querySelectorAll("[data-pick^='ha.']").forEach((b) => b.onclick = () => {
    const key = b.dataset.pick.slice(3);
    const opts = { kind: HA_KINDS, which: HA_WHICH, height: HA_HEIGHTS, columns: HA_COLUMNS, interactive: HA_ON, map: HA_ON, chart: HA_ON, ahead: HA_ON, summary: HA_ON,
                   weeks: [1, 2, 3, 4, 6].map((n) => [n]) }[key];
    const value = opts ? opts.find(([v]) => String(v) === b.dataset.value)[0] : b.dataset.value;
    if (key === "kind") {
      if (value === card.kind) return;
      if (card.name === haLabel(HA_KINDS, card.kind)) card.name = haLabel(HA_KINDS, value); // a name never typed follows the type
      card.kind = value;
      card.config = haDefaults(value, c);
      haSave(true);
      return;
    }
    if (key === "person") c.people = value ? [value] : [];
    else c[key] = value;
    if (key === "columns" || key === "theme") { haSave(true); return; } // the preview's width / the colours panel follow
    haSave();
    haDrawOptions();
  });
  // several choices: the panel stays open, the badge's value follows
  bar.querySelectorAll("input[type=checkbox][name^='hax.']").forEach((inp) => inp.onchange = () => {
    const [, key, v] = inp.name.split(".");
    if (key === "groups" && !c.groups) c.groups = haRecordGroups(c);
    const list = (c[key] || []).filter((x) => x !== v);
    if (inp.checked) list.push(v); // values: in the order picked
    c[key] = list;
    const shown = bar.querySelector(`[data-badge-value="ha-${key}"]`);
    if (shown) shown.textContent = key === "people" ? peopleValue(list) : key === "groups" ? groupsValue(list) : list.length ? `${list.length} shown` : "none";
    haSave();
  });
  const name = bar.querySelector(".ha-name");
  name.onchange = () => {
    const v = name.value.trim();
    if (!v || v === card.name) return;
    card.name = v;
    haSave(true);
  };
  name.onkeydown = (e) => { if (e.key === "Enter") name.blur(); };
  if (k === "map") haMapOptions(bar);
}

// Map › Options as on the Map tab (base map, colours, heatmap, explorer tiles), for this card.
function haMapOptions(bar) {
  const c = HA.card.config, d = defaultMapSettings();
  const settings = { ...d, layer: c.layer || "heatmap", map: { ...d.map, ...c.map }, heatmap: { ...d.heatmap, ...c.heatmap }, tiles: { ...d.tiles, ...c.tiles } };
  heat = { settings, tracks: [], years: [], tileCache: new Map(), params: {}, isAll: (c.people || []).length !== 1, map: null, card: true,
           theme: haTheme(c), panelEl: bar.querySelector("[data-settings]"),
           save: (s) => { c.map = s.map; c.heatmap = s.heatmap; c.tiles = s.tiles; haSave(); } };
  renderSettingsPanel();
  bar.querySelector("[data-badge=ha-options]")?.addEventListener("click", () => {
    if (!bar.querySelector('[data-panel="ha-options"]').hidden) { heat.openAcc = "map"; renderSettingsPanel(); }
  });
}

// A change in the creator: the preview shows it at once; an existing card is saved a moment
// after the last change (then its frame below follows). `full`: the creator is drawn again (a
// new name or type).
function haSave(full = false) {
  const card = HA.card;
  HA.rev++;
  if (full) haDraw();
  else {
    const frame = HA.el.querySelector("[data-ha-frame]");
    if (frame?.contentWindow) frame.contentWindow.location.hash = haFrameSrc().split("#")[1];
  }
  if (HA.draft) return;
  clearTimeout(HA.timer);
  HA.timer = setTimeout(async () => {
    const saved = await api(`ha/cards/${encodeURIComponent(card.id)}`, { method: "PUT", body: JSON.stringify({ name: card.name, kind: card.kind, config: card.config }) });
    const i = HA.cards.findIndex((c) => c.id === saved.id);
    if (i >= 0) HA.cards[i] = saved;
    const item = HA.el.querySelector(`[data-ha-item="${CSS.escape(saved.id)}"]`);
    if (item) {
      item.outerHTML = haCardFrame(saved);
      const fresh = HA.el.querySelector(`[data-ha-item="${CSS.escape(saved.id)}"]`);
      bindCopy(fresh);
      bindEditButtons(fresh);
    }
  }, 600);
}

// ---- the card's page (#/embed/<id>) ------------------------------------------------------

async function renderEmbed(id, params) {
  document.body.classList.add("embed");
  document.body.classList.remove("fullmap", "embed-static", "embed-detail");
  if (!renderEmbed.bound) { // in a card nothing opens: the links stay text
    renderEmbed.bound = true;
    document.addEventListener("click", (e) => { if (e.target.closest?.("a[href]")) e.preventDefault(); }, true);
    new ResizeObserver(() => embedSize()).observe(view);
  }
  let card = null;
  // the creator's preview: the card as it is in the creator now
  if (id === "_creator") card = window.parent !== window && window.parent.HA?.card ? JSON.parse(JSON.stringify(window.parent.HA.card)) : null;
  else card = await api(`ha/cards/${encodeURIComponent(id || "")}`).catch(() => null);
  if (!card) {
    view.innerHTML = `<div class="embed-msg">${hint(`No Trailbook card "${esc(id || "")}". Make it in Trailbook › Home Assistant › Cards.`)}</div>`;
    return;
  }
  const c = card.config || {};
  document.documentElement.dataset.theme = haTheme(c); // the card's own theme
  applyAccent();
  const ids = (c.people || []).filter((p) => person(p));
  embedSize.fill = card.kind === "map" ? c.height || 400 : 0;
  embedSize.phone = card.kind === "detail";
  CURRENT = ids.length === 1 ? ids[0] : "all";
  UI.data = await api("ui-settings?" + new URLSearchParams({ person: CURRENT })).catch(() => ({}));
  UI.person = CURRENT;
  if (card.kind === "map") await embedMap(c, ids);
  else if (card.kind === "activity") await embedActivity(c, ids);
  else if (card.kind === "detail") await embedDetail(c, ids);
  else if (card.kind === "records") await embedRecords(c, ids);
  else await embedCalendar(c, ids);
  embedSize();
}

// The frame's height to the card around it: the map fills the card (at least its height),
// the others are as tall as they are.
function embedSize() {
  if (window.parent === window) return;
  const fill = embedSize.fill || 0;
  window.parent.postMessage({ trailbook: "size", fill: !!fill, phone: !!embedSize.phone,
    height: fill || Math.ceil(view.getBoundingClientRect().height) }, "*");
}

async function embedMap(c, ids) {
  document.body.classList.add("fullmap");
  document.body.classList.toggle("embed-static", c.interactive === false);
  const q = { ...(ids.length ? { person: ids.join(",") } : {}), ...(c.period ? { last: c.period } : {}), ...(c.sport ? { types: `g:${c.sport}` } : {}) };
  const [data] = await Promise.all([api("heatmap/tracks?" + new URLSearchParams(q)), (async () => { BASEMAPS ??= await api("basemaps"); })()]);
  const tracks = data.items.map((t) => ({ ...t, coords: lonLat(t.polyline) }));
  const d = defaultMapSettings();
  heat = { settings: { ...d, layer: c.layer || "heatmap", kpis: false, map: { ...d.map, ...c.map }, heatmap: { ...d.heatmap, ...c.heatmap }, tiles: { ...d.tiles, ...c.tiles } },
           tracks, years: data.years, tileCache: new Map(), params: {}, isAll: ids.length !== 1, map: null, card: true, save: () => {} };
  view.innerHTML = `<div id="map" class="embed-map"></div>`;
  // Home area: the routes that start in the half-degree square with the most starts
  let shown = tracks;
  if (c.view === "main") {
    const cell = (p) => `${Math.floor(p[0] * 2)},${Math.floor(p[1] * 2)}`;
    const n = new Map();
    for (const t of tracks) if (t.coords[0]) n.set(cell(t.coords[0]), (n.get(cell(t.coords[0])) || 0) + 1);
    const best = [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (best) shown = tracks.filter((t) => t.coords[0] && cell(t.coords[0]) === best);
  }
  const bounds = boundsOf(shown.map((t) => t.coords));
  const map = await createMap("map", heat.settings.map, { keepTone: true, interactive: c.interactive !== false,
    ...(bounds ? { bounds, fitBoundsOptions: { padding: 24, maxZoom: 15 } } : {}) });
  heat.map = map;
  drawHeatLayers();
}

async function embedActivity(c, ids) {
  const q = { limit: 1, offset: c.which || 0, track: "1", chart: "chart", ...(ids.length ? { person: ids[0] } : {}), ...(c.sport ? { types: `g:${c.sport}` } : {}) };
  const first = (await api("activities?" + new URLSearchParams(q))).items[0];
  if (!first) { view.innerHTML = `<div class="embed-msg">${hint("No activity yet.")}</div>`; return; }
  const a = { ...first, ...(await api(`activities/${first.id}`)) };
  const kind = workoutOf(a) ? workoutLabel(workoutOf(a)) : "";
  const values = (c.values || []).map((k) => HA_VALUES.find(([key]) => key === k)).filter(Boolean)
    .map(([, label, f]) => [label, f(a)]).filter(([, v]) => v != null);
  view.innerHTML = `<div class="embed-act">
      <div class="tile-head">
        <span class="tile-icon">${typeIcon(a.activity_type)}</span>
        <span class="tile-title"><b>${esc(a.name || typeLabel(a.activity_type))}</b>
        <span class="hint">${a.name ? `${esc(typeLabel(a.activity_type))} · ` : ""}${localTime(a)}${kind ? ` · ${esc(kind)}` : ""}${ids.length ? "" : ` · ${esc(personLabel(a.person_id))}`}</span></span>
      </div>
      ${c.map !== false && a.polyline ? `<div class="embed-act-map">${staticMap(a.polyline, { W: 560, H: 220, cls: "tile-track", tiles: "faded-tiles" })}</div>` : ""}
      ${c.chart && a.tile_chart ? `<div class="embed-act-chart">${tileChart(a.tile_chart)}</div>` : ""}
      ${values.length ? statStrip(values.map(([l, v]) => [l, esc(v), ""])) : ""}
    </div>`;
  fillRelief();
}

// Activity detailed: the activity's page as a phone shows it (the card is drawn phone-wide),
// with the route map on top as a square; nothing to edit or open.
async function embedDetail(c, ids) {
  document.body.classList.add("embed-detail");
  const q = { limit: 1, offset: c.which || 0, ...(ids.length ? { person: ids[0] } : {}), ...(c.sport ? { types: `g:${c.sport}` } : {}) };
  const first = (await api("activities?" + new URLSearchParams(q))).items[0];
  if (!first) { view.innerHTML = `<div class="embed-msg">${hint("No activity yet.")}</div>`; return; }
  await renderActivity(first.id);
  // the map on top without its card, then the name and the date, then the tiles
  const head = `<div class="ed-head"><h2>${typeIcon(first.activity_type, 20)}<span>${esc(first.name || typeLabel(first.activity_type))}</span></h2>
    <div class="ed-date">${localTime(first)}${first.name ? ` · ${esc(typeLabel(first.activity_type))}` : ""}${ids.length ? "" : ` · ${esc(personLabel(first.person_id))}`}</div></div>`;
  const route = view.querySelector(".route-card"), wrap = route?.querySelector(".route-wrap");
  if (!wrap) { view.insertAdjacentHTML("afterbegin", head); return; }
  view.prepend(wrap);
  route.remove();
  wrap.insertAdjacentHTML("afterend", head);
  // the map is now wider: the route fitted again once the map has it
  const track = await api(`activities/${first.id}/track`).catch(() => null);
  let tries = 40;
  const refit = () => {
    if (!track?.polyline || !tries--) return;
    if (!activeMap?.getSource("route")) { setTimeout(refit, 150); return; }
    activeMap.resize();
    activeMap.fitBounds(boundsOf([lonLat(track.polyline)]), { padding: 28, maxZoom: 15, duration: 0 });
  };
  refit();
}

async function embedRecords(c, ids) {
  const pid = ids[0] || realPeople()[0]?.id;
  const data = await api("stats/records?" + new URLSearchParams({ person: pid, ...(c.period ? { last: c.period } : {}) }));
  const label = haLabel(HA_PERIODS(), c.period || "");
  const parts = recordTiles(data, label).parts;
  const tables = haRecordGroups(c).map((g) => parts[g]).filter(Boolean);
  view.innerHTML = tables.length ? `<div class="embed-rec" style="--rec-n:${Math.min(3, Math.max(1, c.columns || 1))}">${tables.join("")}</div>`
    : `<div class="embed-msg">${hint("No records yet.")}</div>`;
}

async function embedCalendar(c, ids) {
  const who = ids.length ? "?" + new URLSearchParams({ person: ids[0] }) : "";
  TIME_RANGE = await api("time-range" + who).catch(timeRangeFallback);
  await renderCalendar({}, { weeks: c.weeks || 2, ahead: !!c.ahead, summary: c.summary !== false });
}
