// Trailbook — planned workouts: Settings › Workouts (the intervals.icu key), the tray of workout
// templates above the calendar, the workout creator, and the planned workouts in the calendar.
// Server side: planner.py (workouts, estimates), icu.py (intervals.icu → Garmin).

const ICON_WORKOUTS = svg(`<rect x="3" y="12" width="4" height="8" rx="1"/><rect x="10" y="5" width="4" height="15" rx="1"/><rect x="17" y="9" width="4" height="11" rx="1"/>`);
const ICON_SYNC_OFF = svg(`<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8"/><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16"/><path d="M4 4v4h4M20 20v-4h-4"/><path d="M3 3l18 18"/>`);
const ICON_PLANNED = svg(`<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="m8.5 15 2.5 2.5 4.5-4.5"/>`);

const WO_TYPES = [["warmup", "Warm-up"], ["active", "Interval"], ["recovery", "Recovery"], ["rest", "Rest"], ["cooldown", "Cool-down"]];
const woTypeLabel = (t) => WO_TYPES.find(([k]) => k === t)?.[1] || t;
const WO_SPORTS = [["run", "Run"], ["ride", "Ride"]];
const WO_TARGETS = { run: [["hr", "Heart rate"], ["pace", "Pace"]], ride: [["hr", "Heart rate"], ["power", "Power"]] };
const woZones = (target) => (target === "power" ? 7 : 5);

// The best length for each step type: time, except a running interval (distance: the heart
// rate lags behind, the stretch has a fixed end); rest without a target.
function woDefaultStep(type, sport) {
  const t = (kind, value, zone) => ({ type, length: { kind, value }, target: zone ? { zone } : null, cue: "" });
  if (type === "warmup") return t("time", 900, [1, 2]);
  if (type === "active") return sport === "run" ? t("distance", 1000, [4, 4]) : t("time", 300, [4, 4]);
  if (type === "recovery") return t("time", 120, [1, 1]);
  if (type === "rest") return t("time", 60, null);
  return t("time", 600, [1, 1]);
}
// Ready sets: added as single steps inside one repeat, editable like any other.
const WO_SETS = {
  run: [
    ["5 × 1 km", 5, [["active", "distance", 1000, [5, 5]], ["recovery", "time", 150, [1, 1]]]],
    ["3 × 10 min", 3, [["active", "time", 600, [4, 4]], ["recovery", "time", 120, [1, 1]]]],
    ["8 × 400 m", 8, [["active", "distance", 400, [5, 5]], ["recovery", "time", 90, [1, 1]]]],
    ["4 × 4 min", 4, [["active", "time", 240, [5, 5]], ["recovery", "time", 180, [1, 1]]]],
    ["6 × 800 m", 6, [["active", "distance", 800, [5, 5]], ["recovery", "time", 120, [1, 1]]]],
    ["2 × 15 min", 2, [["active", "time", 900, [4, 4]], ["recovery", "time", 180, [1, 1]]]],
  ],
  ride: [
    ["2 × 20 min", 2, [["active", "time", 1200, [4, 4]], ["recovery", "time", 300, [1, 1]]]],
    ["5 × 3 min", 5, [["active", "time", 180, [5, 5]], ["recovery", "time", 180, [1, 1]]]],
    ["3 × 12 min", 3, [["active", "time", 720, [3, 4]], ["recovery", "time", 240, [1, 1]]]],
    ["10 × 1 min", 10, [["active", "time", 60, [6, 6]], ["recovery", "time", 60, [1, 1]]]],
    ["4 × 8 min", 4, [["active", "time", 480, [5, 5]], ["recovery", "time", 240, [1, 1]]]],
    ["2 × 30 min", 2, [["active", "time", 1800, [3, 3]], ["recovery", "time", 300, [1, 1]]]],
  ],
};

const woZoneColor = (z, n) => rampColor(ROUTE_SCALES.hr.stops, n > 1 ? (Math.min(Math.max(z, 1), n) - 1) / (n - 1) : 0);
const woLength = (ln) => (ln.kind === "distance"
  ? (ln.value >= 1000 ? `${num(ln.value / 1000, ln.value % 1000 ? 2 : 0)} km` : `${num(ln.value)} m`)
  : woClock(ln.value)); // one time format: 35:30, 1:05:00
const woClock = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60), p = (x) => String(x).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
};

// A step on the zone scale 0 … n (zone z spans z − 1 … z; planner.span_of): drawn as a solid
// block up to the bottom of its zone and a lighter part (30 %) over the zone itself, both in
// the colour of its top zone. `head` = the share of the height the top zone reaches.
function woBars(lo, hi, n, head) {
  if (lo == null) return { solid: 0.3 / n * head, band: 0, color: "var(--line)", none: true };
  const solid = Math.max(lo, 0.3) / n * head;
  return { solid, band: Math.max(0, (hi / n) * head - solid), color: woZoneColor(Math.ceil(hi - 1e-6), n) };
}

// Small chart of a planned workout, in the style of the activity tiles (the same gloss).
function planChart(est) {
  const W = 400, H = 160;
  if (!est) return "";
  const n = est.zones || 5;
  const defs = `<defs><linearGradient id="tb-gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".38"/><stop offset=".45" stop-color="#fff" stop-opacity=".08"/>
      <stop offset="1" stop-color="#000" stop-opacity=".06"/></linearGradient></defs>`;
  const rects = est.blocks.map(([x0, x1, lo, hi]) => {
    const x = (x0 * W).toFixed(2), w = ((x1 - x0) * W + 0.4).toFixed(2);
    const b = woBars(lo, hi, n, 1);
    const sh = b.solid * H, bh = b.band * H;
    return `${bh ? `<rect x="${x}" y="${(H - sh - bh).toFixed(2)}" width="${w}" height="${bh.toFixed(2)}" fill="${b.color}" fill-opacity=".3"/>` : ""}
      <rect x="${x}" y="${(H - sh).toFixed(2)}" width="${w}" height="${sh.toFixed(2)}" fill="${b.color}"/>
      <rect x="${x}" y="${(H - sh).toFixed(2)}" width="${w}" height="${sh.toFixed(2)}" fill="url(#tb-gloss)"/>`;
  }).join("");
  return `<svg class="tile-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${defs}${rects}</svg>`;
}

// A planned workout as a calendar tile (also the tray tiles): header with the sport, the
// expected time and the kind, then the chart (hover: the name). `extra` goes into the header.
const PLAN_ITEMS = new Map(); // planned workouts drawn in the calendar, by id (to edit one)
function planCardHtml(w, { extra = "", badge = "", attrs = "", cls = "" } = {}) {
  const e = w.estimate;
  const facts = [dur(e.duration_s), e.distance_m ? `≈ ${km(e.distance_m)}` : "", `load ≈ ${num(e.load)}`].filter(Boolean).join(" · ");
  return `<div class="cal-act plan ${cls}" ${attrs}>
    <span class="cal-act-head" title="${esc(facts)}">${groupIcon(w.sport, 16)}<span class="cal-act-text">${esc(shortDur(e.duration_s))}</span>${badge}
      <span class="cal-kind">${esc(workoutLabel(e.kind))}</span>${extra}</span>
    <span class="cal-act-chart" title="${esc(w.name)}">${planChart(e)}<span class="plan-sum">${esc(planSummary(w))}</span></span></div>`;
}
// The workout in one short line (hovering the chart): its main part without warm-up and
// cool-down — a repeat as "5 × 1 km Z5", a step as "25' Z3" — joined with " + ".
function planSummary(w) {
  const step = (s) => [woLength(s.length), woTargetLabel(s, w.target)].filter(Boolean).join(" ");
  const main = (w.steps || []).filter((it) => it.repeat || !["warmup", "cooldown"].includes(it.type));
  const parts = (main.length ? main : w.steps || []).map((it) => {
    if (!it.repeat) return step(it);
    const work = it.steps.find((s) => s.type === "active") || it.steps[0];
    return `${it.repeat} × ${step(work)}`;
  });
  return parts.join(" + ");
}
// A name for a workout nobody named: its kind and its main part — "Intervals 5 × 1 km",
// "Tempo 2 × 15:00" — or, without repeats, the kind and the whole length — "Easy 45 min",
// "Long 16 km". Without a kind yet the sport stands for it.
function woSuggestName(w, est) {
  const steps = w.steps || [];
  if (!steps.length) return "";
  const kind = est?.kind ? workoutLabel(est.kind) : WO_SPORTS.find(([k]) => k === w.sport)?.[1] || "";
  const reps = steps.filter((it) => it.repeat);
  let core = "";
  if (reps.length) {
    core = reps.map((it) => {
      const work = it.steps.find((s) => s.type === "active") || it.steps[0];
      return `${it.repeat} × ${woLength(work.length)}`;
    }).join(" + ");
  } else {
    const all = steps.filter((s) => s.length);
    const byDistance = all.length && all.every((s) => s.length.kind === "distance");
    if (byDistance) core = shortDist(all.reduce((m, s) => m + s.length.value, 0));
    else if (est?.duration_s) core = shortDur(est.duration_s);
  }
  return [kind, core].filter(Boolean).join(" ").slice(0, 60);
}
const planSyncIcon = (p) => (p.sync ? `<span class="cal-sync-off" title="${esc(p.sync)}">${ICON_SYNC_OFF}</span>` : "");
const plannedFlag = (p) => `<span class="cal-planned" title="Planned: ${esc(p.name)} · ${esc(dur(p.estimate.duration_s))} · ${esc(workoutLabel(p.estimate.kind))}">${ICON_PLANNED}</span>`;

// ---- Settings › Workouts ----------------------------------------------------------------------

async function settingsWorkouts(el) {
  const [{ accounts }] = await Promise.all([api("icu"), api("persons").then((p) => { PERSONS = p; })]);
  const people = realPeople();
  const ST = { new: ["not tested", "warn"], ok: ["connected", "ok"], error: ["not reachable", "warn"], auth_error: ["key refused", "bad"] };
  const rowHtml = (p) => {
    const a = accounts[p.id];
    const st = a ? ST[a.status] || [a.status, ""] : ["not connected", "muted"];
    return `<div class="garmin-person" data-iperson="${esc(p.id)}">
      <div class="garmin-head"><span class="garmin-who">${avatar(p, 20)} <b>${esc(p.label)}</b></span>${state(st[0], st[1])}
        ${a?.athlete ? `<span class="hint">intervals.icu: ${esc(a.athlete)}</span>` : ""}</div>
      ${a?.last_error ? `<div class="hint garmin-err">${esc(a.last_error)}</div>` : ""}
      <div class="garmin-form one">
        <label><span class="opt-label">intervals.icu API key</span>
          <input type="password" name="ikey" autocomplete="off" spellcheck="false" placeholder="${a ? `Stored (${esc(a.key_hint || "")}) — paste a new key to replace it` : "Paste the key from intervals.icu"}"></label>
        <div class="garmin-actions">
          <button class="primary small" data-isave>${a ? "Save" : "Connect"}</button>
          ${a ? `<button class="small" data-itest>Test</button><button class="small" data-iremove>Disconnect</button>` : ""}
          <span data-imsg></span>
        </div>
      </div>
    </div>`;
  };
  el.innerHTML = `<div class="card">
      <h3>Send workouts to a Garmin watch <span class="title-note">(through intervals.icu, free)</span></h3>
      <ol class="plain steps">
        <li>Create an account on <b>intervals.icu</b> and connect Garmin Connect there (Settings › Connections › Garmin).</li>
        <li>In that Garmin connection turn on <b>Upload planned workouts</b>.</li>
        <li>In intervals.icu set your <b>threshold heart rate (LTHR)</b> for running and cycling, and the <b>threshold pace</b> for running (pace targets).</li>
        <li>intervals.icu › Settings › Developer settings › <b>API key</b>: copy it and paste it below.</li>
      </ol>
      <div class="garmin-people">${people.map(rowHtml).join("") || hint("Add people first (Settings › People).")}</div>
    </div>`;
  const reload = () => settingsWorkouts(el);
  el.querySelectorAll("[data-iperson]").forEach((box) => {
    const pid = encodeURIComponent(box.dataset.iperson), out = box.querySelector("[data-imsg]");
    const show = (r) => { out.innerHTML = r.ok ? state(`Connected${r.athlete ? ` · ${esc(r.athlete)}` : ""}`, "ok") : state(esc(r.error || "Failed"), "bad"); };
    box.querySelector("[data-isave]").onclick = async (e) => {
      e.target.disabled = true;
      out.innerHTML = state("Checking the key with intervals.icu…");
      try {
        const r = await api("icu/" + pid, { method: "PUT", body: JSON.stringify({ api_key: box.querySelector("[name=ikey]").value.trim() }) });
        if (r.ok) { reload(); return; }
        show(r);
      } catch (err) { out.innerHTML = state(esc(err.message), "bad"); }
      e.target.disabled = false;
    };
    const test = box.querySelector("[data-itest]");
    if (test) test.onclick = async () => {
      out.innerHTML = state("Checking…");
      try { show(await api(`icu/${pid}/test`, { method: "POST" })); } catch (err) { out.innerHTML = state(esc(err.message), "bad"); }
    };
    const rm = box.querySelector("[data-iremove]");
    if (rm) rm.onclick = async () => {
      if (!confirm("Disconnect intervals.icu? The stored key is deleted; workouts already on the watch stay.")) return;
      await api("icu/" + pid, { method: "DELETE" });
      reload();
    };
  });
}

// ---- the tray above the calendar ---------------------------------------------------------------

// `onChange()` runs after a workout was placed in the calendar (the calendar redraws the week).
async function renderWorkoutTray(box, onPlaced) {
  const pid = CURRENT;
  const data = await api("workouts?" + new URLSearchParams({ person: pid }));
  const list = data.workouts;
  box.innerHTML = `<div class="wo-panel"><h3 class="tile-title wo-panel-title">${ICON_WORKOUTS}<span>Workouts</span></h3>
    <div class="wo-tray" data-wotray>${list.map((w) => planCardHtml(w, {
      cls: "wo-tile", attrs: `draggable="true" data-wo="${w.id}"`,
      extra: `<span class="wo-tools">
        <button class="icon" data-wo-edit="${w.id}" title="Edit workout" aria-label="Edit workout">${ICON.pencil}</button>
        <button class="icon delete" data-wo-del="${w.id}" title="Delete workout" aria-label="Delete workout">${ICON.trash}</button></span>` })).join("")}
    <button class="wo-add" data-wo-add>Add new</button></div></div>`;
  const tray = box.querySelector("[data-wotray]");
  // a scrollbar takes the space under the tiles; without one the tray keeps an equal margin
  const fit = () => tray.classList.toggle("scrolls", tray.scrollWidth > tray.clientWidth + 1);
  fit();
  new ResizeObserver(fit).observe(tray);
  const reload = () => renderWorkoutTray(box, onPlaced);
  box.querySelector("[data-wo-add]").onclick = () => openWorkoutCreator(null, data.context, reload);
  tray.querySelectorAll("[data-wo-edit]").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    openWorkoutCreator(list.find((w) => w.id === +b.dataset.woEdit), data.context, reload);
  });
  tray.querySelectorAll("[data-wo-del]").forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    const w = list.find((x) => x.id === +b.dataset.woDel);
    if (!confirm(`Delete the workout "${w.name}"? Workouts already in the calendar stay.`)) return;
    await api(`workouts/${w.id}`, { method: "DELETE" });
    reload();
  });
  // drag: within the tray = new order; onto a day of the calendar = plan it
  let dragged = null;
  tray.querySelectorAll("[data-wo]").forEach((t) => {
    t.addEventListener("dragstart", (e) => {
      dragged = t;
      e.dataTransfer.effectAllowed = "copyMove";
      e.dataTransfer.setData("text/trailbook-workout", t.dataset.wo);
      t.classList.add("dragging");
      document.body.classList.add("wo-dragging");
    });
    t.addEventListener("dragend", () => {
      t.classList.remove("dragging");
      document.body.classList.remove("wo-dragging");
      dragged = null;
    });
  });
  tray.addEventListener("dragover", (e) => {
    if (!dragged) return;
    e.preventDefault();
    const over = e.target.closest("[data-wo]");
    if (!over || over === dragged) return;
    const r = over.getBoundingClientRect();
    over.parentNode.insertBefore(dragged, e.clientX > r.left + r.width / 2 ? over.nextSibling : over);
  });
  tray.addEventListener("drop", async (e) => {
    if (!dragged) return;
    e.preventDefault();
    const ids = [...tray.querySelectorAll("[data-wo]")].map((t) => +t.dataset.wo);
    await api("workouts/order?" + new URLSearchParams({ person: pid }), { method: "PUT", body: JSON.stringify({ ids }) });
  });
  return data;
}

// Days of the calendar take workouts from the tray (today and later) and planned workouts
// moved from another day. `refresh(days)` redraws the weeks of those days.
function bindPlanDrops(weeks, refresh) {
  const today = todayIso();
  const dayOf = (e) => e.target.closest?.(".cal-day[data-day]");
  weeks.addEventListener("dragover", (e) => {
    const d = dayOf(e);
    const types = e.dataTransfer.types;
    if (!d || d.dataset.day < today || !(types.includes("text/trailbook-workout") || types.includes("text/trailbook-planned"))) return;
    e.preventDefault();
    weeks.querySelectorAll(".cal-day.drop").forEach((x) => x !== d && x.classList.remove("drop"));
    d.classList.add("drop");
  });
  weeks.addEventListener("dragleave", (e) => { const d = dayOf(e); if (d && !d.contains(e.relatedTarget)) d.classList.remove("drop"); });
  weeks.addEventListener("drop", async (e) => {
    const d = dayOf(e);
    if (!d) return;
    e.preventDefault();
    d.classList.remove("drop");
    const wid = e.dataTransfer.getData("text/trailbook-workout"), moved = e.dataTransfer.getData("text/trailbook-planned");
    try {
      if (wid) await api("planned?" + new URLSearchParams({ person: CURRENT }), { method: "POST", body: JSON.stringify({ workout_id: +wid, day: d.dataset.day }) });
      else if (moved) {
        const [id, from] = moved.split(" ");
        if (from === d.dataset.day) return;
        await api(`planned/${id}`, { method: "PATCH", body: JSON.stringify({ day: d.dataset.day }) });
        await refresh([from, d.dataset.day]);
        return;
      }
      await refresh([d.dataset.day]);
    } catch (err) { alert(err.message); }
  });
  weeks.addEventListener("dragstart", (e) => {
    const p = e.target.closest?.("[data-plan]");
    if (!p) return;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/trailbook-planned", `${p.dataset.plan} ${p.closest(".cal-day").dataset.day}`);
  });
  weeks.addEventListener("click", async (e) => {
    const ed = e.target.closest("[data-plan-edit]");
    if (ed) { // edits this planned workout only, not its template in the tray
      e.preventDefault();
      const p = PLAN_ITEMS.get(+ed.dataset.planEdit);
      if (!p) return;
      const { context } = await api("workouts?" + new URLSearchParams({ person: CURRENT }));
      openWorkoutCreator(p, context, () => refresh([p.day]), {
        save: (w) => api(`planned/${p.id}`, { method: "PUT", body: JSON.stringify(w) }) });
      return;
    }
    const b = e.target.closest("[data-plan-del]");
    if (!b) return;
    e.preventDefault();
    const day = b.closest(".cal-day").dataset.day;
    await api(`planned/${b.dataset.planDel}`, { method: "DELETE" });
    await refresh([day]);
  });
}

// ---- the creator ------------------------------------------------------------------------------

// Editing works on a flat list of steps; a repeat is a run of neighbouring steps with the same
// `group` (its count in `groups`). Saved as the nested form of planner.py. Each step has a
// `uid`, so the canvas moves its blocks (animated) instead of drawing them anew. An empty
// repeat holds one placeholder (`ph`): an empty frame that takes the first step dropped in it;
// placeholders are never saved.
const woPlaceholder = (group) => ({ ph: true, group, uid: ++WO_UID, type: "rest", length: { kind: "time", value: 0 }, target: null, cue: "" });
let WO_UID = 0;
function woToFlat(w) {
  const items = [], groups = {};
  let gid = 0;
  for (const it of w.steps) {
    if (it.repeat) {
      gid += 1;
      groups[gid] = it.repeat;
      for (const s of it.steps) items.push({ ...structuredClone(s), group: gid, uid: ++WO_UID });
    } else items.push({ ...structuredClone(it), group: null, uid: ++WO_UID });
  }
  return { items, groups, next: gid + 1 };
}
function woToTree(items, groups) {
  const steps = [];
  const strip = ({ group, uid, ...s }) => s;
  for (let i = 0; i < items.length;) {
    const g = items[i].group;
    if (g == null) { if (!items[i].ph) steps.push(strip(items[i])); i += 1; continue; }
    const run = [];
    while (i < items.length && items[i].group === g) { if (!items[i].ph) run.push(strip(items[i])); i += 1; }
    if (run.length) steps.push({ repeat: groups[g] || 2, steps: run });
  }
  return steps;
}
// Pace targets ([fast, slow] s/km) have no Garmin zones: their speed against the usual speed
// reads as a heart rate zone (planner.pace_zone, SPEED_SHARE["hr"] backwards).
const WO_SPEED_SHARE = [0.85, 0.93, 1.0, 1.07, 1.13];
function woPaceZone(speed, usual) {
  const share = speed / usual, t = WO_SPEED_SHARE;
  if (share <= t[0]) return 1;
  for (let k = 1; k < t.length; k++) if (share <= t[k]) return k + (share - t[k - 1]) / (t[k] - t[k - 1]);
  return t.length;
}
// a pace range for a zone range: the usual speed × the zone's share, ±2 %, to 5 s
function woPaceOfZone(zone, usual) {
  const z = Math.min(5, Math.max(1, (zone[0] + zone[1]) / 2)), k = Math.floor(z);
  const share = k >= 5 ? WO_SPEED_SHARE[4] : WO_SPEED_SHARE[k - 1] + (WO_SPEED_SHARE[k] - WO_SPEED_SHARE[k - 1]) * (z - k);
  const pace = 1000 / (usual * share), r5 = (x) => Math.round(x / 5) * 5;
  return [r5(pace * 0.98), r5(pace * 1.02)];
}
const woPaceText = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
const woParsePace = (txt) => {
  const m = String(txt).trim().match(/^(\d{1,2})[:.,](\d{1,2})$/) || String(txt).trim().match(/^(\d{1,2})$/);
  if (!m) return null;
  const v = +m[1] * 60 + +(m[2] || 0);
  return v >= 120 && v <= 900 ? v : null;
};
// a step's target made to fit the workout's target kind (after a change of the kind)
function woFitTarget(s, target, usual) {
  if (!s.target) return;
  if (target === "pace") {
    if (!s.target.pace) s.target = { pace: woPaceOfZone(s.target.zone || [3, 3], usual) };
    return;
  }
  const n = woZones(target);
  const zone = s.target.zone || (s.target.pace
    ? [Math.round(woPaceZone(1000 / s.target.pace[1], usual)), Math.round(woPaceZone(1000 / s.target.pace[0], usual))]
    : [3, 3]);
  s.target = { zone: zone.map((x) => Math.max(1, Math.min(x, n))) };
}

// zone scale span of a step in the creator (as planner.span_of)
function woSpan(s, target, b, usual = 3) {
  const t = s.target;
  if (!t) return [null, null];
  if (t.pace) return [Math.max(0.3, woPaceZone(1000 / t.pace[1], usual) - 1), Math.max(0.6, woPaceZone(1000 / t.pace[0], usual))];
  if (t.zone) return [t.zone[0] - 1, t.zone[1]];
  const v = t.bpm || t.watts, n = woZones(target);
  if (!b) return [2, 3];
  const z = (x) => { for (let k = 0; k < n; k++) if (x < b[k + 1]) return k + Math.max(0, (x - b[k]) / Math.max(1, b[k + 1] - b[k])); return n; };
  return [Math.min(z(v[0]), n), Math.min(z(v[1]), n)];
}
const woTargetLabel = (s, target) => {
  const t = s.target;
  if (!t) return "";
  if (t.zone) return t.zone[0] === t.zone[1] ? `Z${t.zone[0]}` : `Z${t.zone[0]}–${t.zone[1]}`;
  if (t.pace) return `${woPaceText(t.pace[0])}–${woPaceText(t.pace[1])}`;
  const v = t.bpm || t.watts;
  return `${num(v[0])}–${num(v[1])}`;
};

// Slider values: time 15 s … 6 h, distance 100 m … 50 km, finer at short lengths.
const woRange = (parts) => parts.flatMap(([from, to, step]) => { const out = []; for (let v = from; v < to; v += step) out.push(v); return out; });
const WO_LENGTHS = {
  time: [...woRange([[15, 120, 5], [120, 600, 15], [600, 1800, 30], [1800, 7200, 60], [7200, 21600, 300]]), 21600],
  distance: [...woRange([[100, 1000, 50], [1000, 5000, 100], [5000, 21000, 250], [21000, 50000, 500]]), 50000],
};
// a typed length: time "15" (min), "15:30", "1:05:00", "90s"; distance "1,6" (km), "800 m"
function woParseLength(kind, text) {
  const t = String(text).trim().toLowerCase().replace(",", ".").replace(/['′]/g, "").replace(/\s+/g, "");
  let v = null;
  if (kind === "time") {
    if (/^\d+(\.\d+)?s$/.test(t)) v = parseFloat(t);
    else if (/^\d+(:\d{1,2}){0,2}$/.test(t)) {
      const p = t.split(":").map(Number);
      v = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0] * 60;
    } else if (/^\d+(\.\d+)?(min|m)$/.test(t)) v = parseFloat(t) * 60;
    else if (/^\d+(\.\d+)?h(\d+(min|m)?)?$/.test(t)) { const [, h, m] = t.match(/^([\d.]+)h(\d+)?/); v = parseFloat(h) * 3600 + (+m || 0) * 60; }
    return v && v >= 5 && v <= 21600 ? Math.round(v) : null;
  }
  if (/^\d+(\.\d+)?km$/.test(t) || /^\d+(\.\d+)?$/.test(t)) v = parseFloat(t) * 1000;
  else if (/^\d+m$/.test(t)) v = parseFloat(t);
  return v && v >= 10 && v <= 200000 ? Math.round(v) : null;
}
const woNearest = (list, v) => list.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(list[best] - v) ? i : best), 0);

const WO_HEAD = 0.8; // the top zone reaches 80 % of the canvas: room for the repeat frames

// `save(workout)` replaces the default (the template: new or updated), e.g. for a planned one.
function openWorkoutCreator(workout, ctx, onSaved, { save = null } = {}) {
  const w = workout ? structuredClone(workout) : { name: "", sport: "run", target: "hr", steps: [] };
  let { items, groups, next } = woToFlat(w);
  let sel = null; // { step: index } | { group: id }
  let est = null, seq = 0, layout = [];
  const dlg = document.createElement("dialog");
  dlg.className = "wo-dialog";
  document.body.append(dlg);
  const zonesN = () => woZones(w.target);
  const bounds = () => ctx?.[w.sport]?.[w.target] || null;
  const tree = () => ({ name: w.name, sport: w.sport, target: w.target, steps: woToTree(items, groups) });
  const refresh = async () => {
    const my = ++seq;
    const r = items.some((s) => !s.ph) ? await api("workouts/estimate?" + new URLSearchParams({ person: CURRENT }), { method: "POST", body: JSON.stringify(tree()) }) : { estimate: null };
    if (my !== seq) return;
    est = r.estimate;
    drawCanvas();
    showSuggestion();
  };
  // Undo: the state before each change (steps, repeats, sport, target), the last 100; the
  // name has its own undo in its field.
  const snap = () => JSON.stringify({ items, groups, next, sport: w.sport, target: w.target });
  const history = [];
  let last = snap();
  const record = () => {
    const now = snap();
    if (now !== last) {
      history.push(last);
      if (history.length > 100) history.shift();
      last = now;
    }
    const b = dlg.querySelector("[data-wo-undo]");
    if (b) b.disabled = !history.length;
  };
  const undo = () => {
    if (!history.length) return;
    const prev = JSON.parse(history.pop());
    ({ items, groups, next } = prev);
    w.sport = prev.sport;
    w.target = prev.target;
    last = snap();
    sel = null;
    est = null;
    draw();
    refresh();
  };
  // without a name of its own the workout gets a suggested one (shown in the empty field)
  const suggestion = () => woSuggestName(tree(), est);
  const showSuggestion = () => {
    const inp = dlg.querySelector("[data-wo-name]");
    if (inp) inp.placeholder = suggestion() || "New workout name";
  };
  const changed = () => { est = null; drawCanvas(); refresh(); drawSettings(); record(); };
  const drawPaceSettings = (s, box) => {
    const usual = ctx?.[w.sport]?.speed || 3;
    const pace = s.target?.pace || woPaceOfZone(woDefaultStep(s.type, w.sport).target?.zone || [2, 2], usual);
    box.innerHTML = field("Type", woPick("type", "Type", WO_TYPES, s.type))
      + field("Pace", `${woPick("tkind", "Target", [["value", "Pace range"], ["none", "None"]], s.target ? "value" : "none")}
        ${s.target ? `<div class="wo-inline"><input type="text" inputmode="decimal" data-p="0" value="${woPaceText(pace[0])}">–<input type="text" inputmode="decimal" data-p="1" value="${woPaceText(pace[1])}"><span class="hint">min/km</span></div>
        <span class="hint">Your usual pace: ${woPaceText(1000 / usual)} /km</span>` : ""}`)
      + field("Length", lengthCtl(s))
      + field("Cue", `<input type="text" maxlength="40" data-cue value="${esc(s.cue || "")}" placeholder="${esc(woTypeLabel(s.type))} (shown on the watch)">`)
      + `<div class="wo-actions"><span class="spacer"></span><button class="badge" data-dup>Duplicate</button><button class="badge danger" data-del>Remove</button></div>`;
    bindWoPicks(box, (name, v) => {
      if (name === "type") s.type = v;
      if (name === "tkind") s.target = v === "none" ? null : { pace };
      changed();
    });
    box.querySelectorAll("[data-p]").forEach((inp) => inp.onchange = () => {
      const v = [...box.querySelectorAll("[data-p]")].map((x) => woParsePace(x.value));
      if (v.every((x) => x)) { s.target = { pace: v.sort((a, b) => a - b) }; changed(); } else drawSettings();
    });
    bindStepCommon(s, box);
  };
  // repeats without steps go; a placeholder goes once its repeat has a step (or is outside one)
  const tidyGroups = () => {
    items = items.filter((s) => !s.ph || (s.group != null && !items.some((x) => !x.ph && x.group === s.group)));
    for (const g of Object.keys(groups)) if (!items.some((s) => s.group === +g)) delete groups[g];
  };

  // ---- canvas: one block per step, repeats unrolled (the copies lighter, behind the frame).
  // The steps take a share of the width that grows with their number, centred.
  // `previewing`: a drag shows its result (see preview); the estimate does not fit it yet
  let liftUid = null; // the step being moved, marked in a preview
  let dragging = null, dragAt = null; // { tool } | { step } | { group }, and where it would go
  const drawCanvas = (previewing = false) => {
    const c = dlg.querySelector("[data-wo-canvas]"), track = c.querySelector("[data-wo-track]");
    c.classList.toggle("empty", !items.length);
    c.classList.toggle("previewing", previewing);
    if (!items.length) {
      track.innerHTML = "";
      layout = [];
      dlg.querySelector("[data-wo-kpis]").innerHTML = "";
      return;
    }
    const secs = (!previewing && est?.seconds) || [];
    const sp = ctx?.[w.sport]?.speed || 3;
    const rows = [];
    let k = 0;
    for (let i = 0; i < items.length;) {
      const g = items[i].group;
      const run = [];
      while (i < items.length && (g == null ? run.length === 0 : items[i].group === g)) run.push(i++);
      const empty = run.every((idx) => items[idx].ph); // an empty repeat: its frame once
      for (let r = 0; r < (g == null || empty ? 1 : groups[g]); r++) for (const idx of run) {
        const s = items[idx];
        if (s.ph) { rows.push({ idx, r, group: g, ph: true, sec: 0 }); continue; }
        rows.push({ idx, r, group: g, sec: secs[k] ?? (s.length.kind === "time" ? s.length.value : s.length.value / sp) });
        k += 1;
      }
    }
    const real = rows.reduce((a, r) => a + r.sec, 0);
    for (const r of rows) if (r.ph) r.sec = real ? Math.max(real * 0.1, 120) : 600; // room to drop into
    const total = rows.reduce((a, r) => a + r.sec, 0) || 1;
    // The steps take a share of the width: more for a longer workout and for more steps, so a
    // short one with few steps stands in the middle and a long one fills the width.
    const share = Math.min(0.96, 0.3 + 0.05 * items.length + 0.6 * (1 - Math.exp(-real / 5400)));
    const off = (1 - share) / 2 * 100;
    const n = zonesN(), cw = c.clientWidth || 800;
    let x = 0;
    const want = new Map(), frames = {};
    layout = [];
    for (const r of rows) {
      const s = items[r.idx];
      const left = off + (x / total) * share * 100, width = (r.sec / total) * share * 100;
      x += r.sec;
      layout.push({ ...r, left, right: left + width });
      if (r.group != null && r.r === 0) {
        const f = frames[r.group] ||= { left, right: left };
        f.right = left + width;
      }
      if (r.ph) { // an empty repeat: only its frame and a hint inside
        want.set(`p${s.uid}`, { ph: true, left, width, group: r.group, ghost: previewing && s.uid < 0, sel: sel?.group === r.group });
        continue;
      }
      const [lo, hi] = woSpan(s, w.target, bounds(), sp);
      const b = woBars(lo, hi, n, WO_HEAD);
      const key = r.r ? `c${s.uid}-${r.r}` : `s${s.uid}`;
      const wide = (width / 100) * cw > 34;
      want.set(key, { left, width, b, copy: r.r > 0, idx: r.idx, group: r.group,
        ghost: previewing && s.uid < 0, lift: previewing && s.uid === liftUid,
        lab: wide && !r.r ? woTargetLabel(s, w.target) : "", len: wide && !r.r ? woLength(s.length) : "",
        sel: !r.r && sel?.step === r.idx, title: `${woTypeLabel(s.type)} · ${woLength(s.length)}${s.target ? ` · ${woTargetLabel(s, w.target)}` : ""}` });
    }
    for (const [g, f] of Object.entries(frames)) want.set(`f${g}`, { frame: true, g: +g, left: f.left, width: f.right - f.left });
    // keyed update: existing blocks move (CSS transitions), new ones grow in, gone ones go
    const have = new Map([...track.children].map((el) => [el.dataset.key, el]));
    for (const [key, el] of have) if (!want.has(key)) el.remove();
    for (const [key, v] of want) {
      let el = have.get(key);
      if (!el) {
        el = document.createElement("div");
        el.dataset.key = key;
        if (v.frame) {
          el.className = "wo-frame";
          el.innerHTML = `<span class="wo-frame-tag" draggable="true"></span><span class="wo-handle l" data-handle="l"></span><span class="wo-handle r" data-handle="r"></span>`;
        } else if (v.ph) el.innerHTML = `<span class="wo-ph-text">Drop a step</span>`;
        else el.innerHTML = `<i class="band"></i><i class="core"></i><span class="wo-blk-labs"><span class="wo-blk-z"></span><span class="wo-blk-len"></span></span>`;
        el.style.left = `${v.left}%`;
        el.style.width = `${v.width}%`;
        el.dataset.fresh = "1";
        track.append(el);
      }
      el.style.left = `${v.left}%`;
      el.style.width = `${v.width}%`;
      if (v.frame) {
        el.classList.toggle("sel", sel?.group === v.g);
        el.dataset.frame = v.g;
        el.querySelectorAll("[data-handle]").forEach((h) => { h.dataset.g = v.g; });
        const tag = el.querySelector(".wo-frame-tag");
        tag.dataset.frameTag = v.g;
        tag.textContent = `×${num(groups[v.g])}`;
        continue;
      }
      if (v.ph) {
        el.className = `wo-ph ${v.sel ? "sel" : ""} ${v.ghost ? "ghost" : ""}`;
        delete el.dataset.fresh;
        el.dataset.ph = v.group;
        continue;
      }
      el.className = `wo-blk ${v.copy ? "copy" : ""} ${v.sel ? "sel" : ""} ${el.dataset.fresh ? "new" : ""} ${v.ghost ? "ghost" : ""} ${v.lift ? "lift" : ""}`;
      delete el.dataset.fresh;
      el.title = v.title;
      delete el.dataset.step; delete el.dataset.copy;
      if (v.copy) el.dataset.copy = v.group; else { el.dataset.step = v.idx; el.draggable = true; }
      const [band, core] = el.querySelectorAll("i");
      core.style.height = `${v.b.solid * 100}%`;
      core.style.background = v.b.color;
      band.style.bottom = `${v.b.solid * 100}%`;
      band.style.height = `${v.b.band * 100}%`;
      band.style.background = v.b.color;
      el.querySelector(".wo-blk-labs").style.height = `${Math.max(v.b.solid * 100, 26)}%`;
      el.querySelector(".wo-blk-z").textContent = v.lab;
      el.querySelector(".wo-blk-len").textContent = v.len;
    }
    const e = previewing ? null : est;
    if (e) dlg.querySelector("[data-wo-kpis]").innerHTML = [["Time", durMin(e.duration_s)], ["Distance", e.distance_m ? `≈ ${km(e.distance_m)}` : ""],
      ["Load", `≈ ${num(e.load)}`], ["Kind", workoutLabel(e.kind)], ["Watch steps", num(e.steps)]]
      .filter(([, v]) => v).map(([l, v]) => `<span class="wo-kpi"><span>${l}</span><b>${esc(v)}</b></span>`).join("");
  };

  // ---- step settings: a label and its control to the right, one row under another
  const field = (label, control) => `<div class="wo-field"><span class="opt-label">${label}</span><div class="wo-control">${control}</div></div>`;
  const drawSettings = () => {
    const box = dlg.querySelector("[data-wo-settings]");
    if (sel?.group != null && groups[sel.group]) {
      const g = sel.group;
      box.innerHTML = field("Repeat", `<div class="wo-inline"><input type="number" min="1" max="50" step="1" value="${groups[g]}" data-rep-count><span class="hint">times</span></div>`)
        + `<div class="wo-actions"><span class="spacer"></span><button class="badge danger" data-rep-remove>Remove repeat</button></div>`;
      box.querySelector("[data-rep-count]").oninput = (e) => {
        const v = Math.round(+e.target.value);
        if (v >= 1 && v <= 50) { groups[g] = v; est = null; drawCanvas(); refresh(); record(); }
      };
      box.querySelector("[data-rep-remove]").onclick = () => {
        items.forEach((s) => { if (s.group === g) s.group = null; });
        delete groups[g];
        tidyGroups();
        sel = null;
        changed();
      };
      return;
    }
    const s = sel?.step != null ? items[sel.step] : null;
    if (!s) { box.innerHTML = `<div class="hint wo-none">Click a step to change it.</div>`; return; }
    if (w.target === "pace") return drawPaceSettings(s, box);
    const kind = s.target?.bpm || s.target?.watts ? "value" : s.target ? "zone" : "none";
    const power = w.target === "power", unitTxt = power ? "W" : "bpm";
    const b = bounds(), n = zonesN();
    const zr = s.target?.zone || [1, 1];
    const vals = s.target?.bpm || s.target?.watts || (b ? [b[zr[0] - 1], b[zr[1]]] : [power ? 200 : 140, power ? 240 : 150]);
    const zoneNote = b ? `Z${zr[0]}${zr[1] > zr[0] ? `–Z${zr[1]}` : ""} = ${num(b[zr[0] - 1])}–${num(b[zr[1]])} ${unitTxt} · your latest ${w.sport === "run" ? "run" : "ride"} (${esc(ctx[w.sport].from || "")})`
      : "No zones yet: they come from the latest activity of this sport.";
    box.innerHTML = field("Type", woPick("type", "Type", WO_TYPES, s.type))
      + field(power ? "Power" : "Heart rate", `${woPick("tkind", "Target", [["zone", "Zone"], ["value", `${power ? "Watt" : "bpm"} range`], ["none", "None"]], kind)}
        ${kind === "zone" ? `<div class="wo-zones" data-zones>${[...Array(n)].map((_, i) => `<button type="button" class="wo-zone ${i + 1 >= zr[0] && i + 1 <= zr[1] ? "on" : ""}" data-z="${i + 1}" style="--zc:${woZoneColor(i + 1, n)}">Z${i + 1}</button>`).join("")}</div>
          <span class="hint">${zoneNote}</span>` : ""}
        ${kind === "value" ? `<div class="wo-inline"><input type="number" data-v="0" value="${Math.round(vals[0])}">–<input type="number" data-v="1" value="${Math.round(vals[1])}"><span class="hint">${unitTxt}</span></div>` : ""}`)
      + field("Length", lengthCtl(s))
      + field("Cue", `<input type="text" maxlength="40" data-cue value="${esc(s.cue || "")}" placeholder="${esc(woTypeLabel(s.type))} (shown on the watch)">`)
      + `<div class="wo-actions"><span class="spacer"></span><button class="badge" data-dup>Duplicate</button><button class="badge danger" data-del>Remove</button></div>`;
    bindWoPicks(box, (name, v) => {
      if (name === "type") s.type = v;
      if (name === "tkind") s.target = v === "none" ? null : v === "zone" ? { zone: zr } : { [power ? "watts" : "bpm"]: vals.map(Math.round) };
      changed();
    });
    const zbox = box.querySelector("[data-zones]");
    if (zbox) { // click one zone, or drag across several for a range
      let start = null;
      const mark = () => zbox.querySelectorAll("[data-z]").forEach((z) => z.classList.toggle("on", +z.dataset.z >= s.target.zone[0] && +z.dataset.z <= s.target.zone[1]));
      const set = (a, c) => { s.target = { zone: [Math.min(a, c), Math.max(a, c)] }; mark(); drawCanvas(); };
      zbox.onpointerdown = (e) => { const z = e.target.closest("[data-z]"); if (!z) return; start = +z.dataset.z; set(start, start); zbox.setPointerCapture(e.pointerId); };
      zbox.onpointermove = (e) => {
        if (start == null) return;
        const z = document.elementFromPoint(e.clientX, e.clientY)?.closest?.("[data-z]");
        if (z && zbox.contains(z)) set(start, +z.dataset.z);
      };
      zbox.onpointerup = () => { if (start == null) return; start = null; changed(); };
    }
    box.querySelectorAll("[data-v]").forEach((inp) => inp.onchange = () => {
      const v = [...box.querySelectorAll("[data-v]")].map((x) => Math.round(+x.value)).sort((p, q) => p - q);
      if (v.every((x) => x > 0)) { s.target = { [power ? "watts" : "bpm"]: v }; changed(); }
    });
    bindStepCommon(s, box);
  };
  // Length: a switch Time | Distance and a slider over WO_LENGTHS (finer steps at short lengths);
  // the canvas follows while sliding, the estimate once let go
  const lengthCtl = (st) => {
    const list = WO_LENGTHS[st.length.kind];
    return `<div class="wo-len"><label class="wo-switch"><span class="${st.length.kind === "time" ? "on" : ""}">Time</span>
        <input type="checkbox" data-lswitch ${st.length.kind === "distance" ? "checked" : ""}><i></i>
        <span class="${st.length.kind === "distance" ? "on" : ""}">Distance</span></label>
      <div class="wo-slide"><input type="range" min="0" max="${list.length - 1}" step="1" value="${woNearest(list, st.length.value)}" data-lslide><input type="text" class="wo-lval" data-lval value="${esc(woLength(st.length))}" spellcheck="false" aria-label="Length"></div></div>`;
  };
  let slideTimer = null;
  const bindStepCommon = (s, box) => {
    const usualSp = () => (s.target?.pace ? 2000 / (s.target.pace[0] + s.target.pace[1]) : ctx?.[w.sport]?.speed || 3);
    box.querySelector("[data-lswitch]").onchange = (e) => { // about the same time at the step's speed
      const sp = usualSp(), list = WO_LENGTHS[e.target.checked ? "distance" : "time"];
      const v = e.target.checked ? s.length.value * sp : s.length.value / sp;
      s.length = { kind: e.target.checked ? "distance" : "time", value: list[woNearest(list, v)] };
      changed();
    };
    const lval = box.querySelector("[data-lval]");
    lval.onkeydown = (e) => { if (e.key === "Enter") lval.blur(); };
    lval.onchange = () => {
      const v = woParseLength(s.length.kind, lval.value);
      if (v) { s.length = { kind: s.length.kind, value: v }; changed(); } else lval.value = woLength(s.length);
    };
    box.querySelector("[data-lslide]").oninput = (e) => {
      s.length = { kind: s.length.kind, value: WO_LENGTHS[s.length.kind][+e.target.value] };
      box.querySelector("[data-lval]").value = woLength(s.length);
      est = null;
      drawCanvas();
      clearTimeout(slideTimer);
      slideTimer = setTimeout(refresh, 250);
    };
    box.querySelector("[data-lslide]").onchange = record; // one undo step per slide
    box.querySelector("[data-cue]").onchange = (e) => { s.cue = e.target.value.trim(); record(); };
    box.querySelector("[data-dup]").onclick = () => {
      items.splice(sel.step + 1, 0, { ...structuredClone(s), uid: ++WO_UID });
      sel = { step: sel.step + 1 };
      changed();
    };
    box.querySelector("[data-del]").onclick = () => {
      items.splice(sel.step, 1);
      tidyGroups();
      sel = null;
      changed();
    };
  };

  // ---- adding and moving steps
  // inside a repeat when both neighbours are in it
  const groupAt = (at) => (at > 0 && at < items.length && items[at - 1].group != null && items[at - 1].group === items[at].group ? items[at].group : null);
  // after a change: the selection by its step (indices move when placeholders go)
  const selOf = (r) => {
    tidyGroups();
    if (r?.uid != null) { const i = items.findIndex((s) => s.uid === r.uid); return i >= 0 ? { step: i } : null; }
    return r?.group != null && groups[r.group] ? { group: r.group } : null;
  };
  const toolItems = (tool) => {
    const mk = (s, group) => { const x = { ...s, group, uid: ++WO_UID }; woFitTarget(x, w.target, ctx?.[w.sport]?.speed || 3); return x; };
    if (tool.startsWith("set:")) {
      const [, times, steps] = WO_SETS[w.sport].find(([name]) => name === tool.slice(4));
      const g = next++;
      groups[g] = times;
      return steps.map(([type, kind, value, zone]) => mk({ type, length: { kind, value }, target: { zone: [...zone] }, cue: "" }, g));
    }
    return [mk(woDefaultStep(tool, w.sport), undefined)];
  };
  const groupRange = (g) => { const idx = items.map((s, i) => (s.group === g ? i : -1)).filter((i) => i >= 0); return [idx[0], idx[idx.length - 1]]; };
  const afterSel = () => (sel?.step != null ? sel.step + 1 : sel?.group != null ? groupRange(sel.group)[1] + 1 : items.length);
  // What is under a pointer x: `at` the place in the list (before a block, after it on its
  // right half; over the copies of a repeat: after the repeat), `on` the step block under it
  // (not a copy), `into` the repeat of an empty frame under it.
  const hitAt = (clientX) => {
    const cr = dlg.querySelector("[data-wo-canvas]").getBoundingClientRect();
    const p = ((clientX - cr.left) / cr.width) * 100;
    for (const r of layout) {
      if (p >= r.right) continue;
      if (p < r.left) return { at: r.idx, on: null, into: null }; // the margin before the first
      if (r.ph) return { at: r.idx, on: null, into: r.group };
      if (r.r > 0) return { at: groupRange(r.group)[1] + 1, on: null, into: null };
      return { at: p < (r.left + r.right) / 2 ? r.idx : r.idx + 1, on: r.idx, into: null };
    }
    return { at: items.length, on: null, into: null };
  };
  const indexAt = (clientX) => hitAt(clientX).at;
  // ---- what a drag does, shared by its live preview and the drop (null = nothing changes)
  // A repeat from the columns: dropped on a step it frames that step (not one already in a
  // repeat: one level only); dropped on empty space it is an empty frame to drop steps in.
  const placeRepeat = (hit, temp) => {
    if (hit.on != null) {
      const s = items[hit.on];
      if (s.group != null) return null;
      const g = next++;
      groups[g] = 4;
      s.group = g;
      return { group: g };
    }
    let at = hit.into != null ? groupRange(hit.into)[1] + 1 : hit.at;
    while (groupAt(at) != null) at += 1; // never inside another repeat
    const g = next++;
    groups[g] = 4;
    const ph = woPlaceholder(g);
    if (temp) ph.uid = -1;
    items.splice(at, 0, ph);
    return { group: g };
  };
  // a new step or a ready set from the columns (`temp`: preview ids, stable while dragging);
  // into an empty frame it fills it (a ready set brings its count)
  const placeTool = (hit, tool, temp = false) => {
    if (tool === "repeat") return placeRepeat(hit, temp);
    const added = toolItems(tool);
    if (temp) added.forEach((s, i) => { s.uid = -1 - i; });
    if (hit.into != null) {
      const own = added[0].group;
      if (own != null) { groups[hit.into] = groups[own]; delete groups[own]; }
      added.forEach((s) => { s.group = hit.into; });
      const i = items.findIndex((s) => s.ph && s.group === hit.into);
      items.splice(i, 1, ...added);
      return own != null ? { group: hit.into } : { uid: added[0].uid };
    }
    const g = groupAt(hit.at);
    added.forEach((s) => { if (s.group === undefined) s.group = g; });
    items.splice(hit.at, 0, ...added);
    return added[0].group != null && added[0].group !== g ? { group: added[0].group } : { uid: added[0].uid };
  };
  // a step (it joins a repeat when put between two of its steps, or into an empty frame) or a
  // whole repeat (outside any other repeat) moved to `hit`
  const placeMove = (hit, mv) => {
    const at = hit.at;
    if (mv.group != null) {
      if (hit.into === mv.group) return null;
      const [a, z] = groupRange(mv.group);
      if (at >= a && at <= z + 1) return null;
      const part = items.splice(a, z - a + 1);
      let to = at > z ? at - part.length : at;
      while (to > 0 && to < items.length && items[to - 1].group != null && items[to - 1].group === items[to].group) to += 1;
      items.splice(to, 0, ...part);
      return { group: mv.group };
    }
    const s = items[mv.step];
    if (hit.into != null) {
      items.splice(mv.step, 1);
      s.group = hit.into;
      items.splice(items.findIndex((x) => x.ph && x.group === hit.into), 1, s);
      return { uid: s.uid };
    }
    if (at === mv.step || at === mv.step + 1) {
      const prev = items[mv.step - 1], nxt = items[mv.step + 1];
      const g = prev && nxt && prev.group != null && prev.group === nxt.group ? prev.group : s.group;
      if (g === s.group) return null; // the same place
    }
    items.splice(mv.step, 1);
    const to = at > mv.step ? at - 1 : at;
    const prev = items[to - 1], nxt = items[to];
    s.group = prev && nxt && prev.group != null && prev.group === nxt.group ? prev.group : null;
    items.splice(to, 0, s);
    return { uid: s.uid };
  };
  // a click on a step or set in the columns: after the selection; Repeat frames the selected
  // step (or adds an empty frame after the selection)
  const clickTool = (tool) => {
    const hit = tool === "repeat" && sel?.step != null && !items[sel.step]?.ph
      ? { at: sel.step, on: sel.step, into: null }
      : { at: afterSel(), on: null, into: null };
    if (tool !== "repeat" && sel?.group != null && items.some((s) => s.ph && s.group === sel.group)) hit.into = sel.group;
    const r = placeTool(hit, tool);
    if (!r) return;
    sel = selOf(r);
    changed();
  };
  // Delete: the selected step, or the selected repeat with its steps
  const deleteSel = () => {
    if (sel?.step != null) items.splice(sel.step, 1);
    else if (sel?.group != null) { items = items.filter((s) => s.group !== sel.group); delete groups[sel.group]; }
    else return false;
    tidyGroups();
    sel = null;
    changed();
    return true;
  };
  // the left or right edge of repeat `g` dragged to `at`: neighbouring steps join or leave it
  // (never into another repeat)
  const placeEdge = (g, side, at) => {
    const [first, last] = groupRange(g);
    if (side === "l") {
      let f = Math.min(at, last);
      while (f < first && items[f].group != null && items[f].group !== g) f += 1;
      for (let i = f; i < first; i++) if (items[i].group == null) items[i].group = g;
      for (let i = first; i < f; i++) items[i].group = null;
    } else {
      let t = Math.max(at - 1, first);
      while (t > last && items[t]?.group != null && items[t].group !== g) t -= 1;
      for (let i = last + 1; i <= t && i < items.length; i++) if (items[i].group == null) items[i].group = g;
      for (let i = t + 1; i <= last; i++) items[i].group = null;
    }
    tidyGroups();
    return groups[g] ? { group: g } : null;
  };
  // the canvas with a change applied to a copy of the steps; the steps themselves, the
  // selection and the layout used for pointer positions stay as they are
  const preview = (apply) => {
    const keep = { items, groups, next, sel, layout };
    items = items.map((s) => ({ ...s }));
    groups = { ...groups };
    const r = apply();
    if (r) { tidyGroups(); drawCanvas(true); }
    ({ items, groups, next, sel, layout } = keep);
    if (!r) drawCanvas();
  };

  const draw = () => {
    dlg.innerHTML = `
      <div class="wo-head">
        <input type="text" class="wo-name" maxlength="60" placeholder="New workout name" value="${esc(w.name)}" data-wo-name>
        ${woPick("sport", "Sport", WO_SPORTS, w.sport)}
        ${woPick("target", "Target", WO_TARGETS[w.sport], w.target)}
      </div>
      <div class="wo-board">
        <div class="wo-canvas" data-wo-canvas>
          <div class="wo-grid">${[...Array(zonesN())].map((_, i) => `<i style="bottom:${((i + 1) / zonesN()) * WO_HEAD * 100}%"></i>`).join("")}</div>
          <div class="wo-empty">Drop the first step here</div>
          <div class="wo-track" data-wo-track></div>
          <div class="wo-drop" data-wo-drop hidden></div>
        </div>
        <div class="wo-kpis" data-wo-kpis></div>
      </div>
      <div class="wo-cols">
        <div class="wo-col"><div class="panel-title">Steps</div>
          ${WO_TYPES.map(([k, l]) => { const d = woDefaultStep(k, w.sport); return woToolHtml(k, l, woLength(d.length), [[1, d.target?.zone]]); }).join("")}
          ${woToolHtml("repeat", "Repeat", "frames a step", [], true)}</div>
        <div class="wo-col"><div class="panel-title">Ready steps</div>${WO_SETS[w.sport].map(([name, times, steps]) =>
          woToolHtml(`set:${name}`, name, "", [...Array(Math.min(times, 4))].flatMap(() => steps.map(([, kind, value, zone]) => [kind === "time" ? value : value / 4, zone])))).join("")}</div>
        <div class="wo-col wo-settings"><div class="panel-title">Step settings</div><div data-wo-settings></div></div>
      </div>
      <div class="wo-foot"><button type="button" class="badge" data-wo-undo title="Undo the last change (Ctrl+Z)" ${history.length ? "" : "disabled"}>Undo</button>
        <span data-wo-msg></span><span class="spacer"></span>
        <button type="button" class="badge" data-wo-cancel>Cancel</button>
        <button type="button" class="badge on" data-wo-save>Save</button></div>`;
    dlg.querySelector("[data-wo-name]").oninput = (e) => { w.name = e.target.value; };
    bindWoPicks(dlg.querySelector(".wo-head"), (name, v) => {
      if (name === "sport" && v !== w.sport) {
        w.sport = v;
        if (!WO_TARGETS[v].some(([k]) => k === w.target)) w.target = "hr";
      }
      if (name === "target") w.target = v;
      items.forEach((s) => woFitTarget(s, w.target, ctx?.[w.sport]?.speed || 3));
      draw();
      refresh();
      record();
    });
    bindCanvas();
    dlg.querySelectorAll("[data-tool]").forEach((t) => {
      t.onclick = () => clickTool(t.dataset.tool);
      t.ondragstart = (e) => {
        e.dataTransfer.setData("text/trailbook-step", t.dataset.tool);
        e.dataTransfer.effectAllowed = "copy";
        dragging = { tool: t.dataset.tool };
        dragAt = null;
      };
      t.ondragend = () => { if (dragging) { dragging = dragAt = null; drawCanvas(); } };
    });
    drawCanvas();
    drawSettings();
    showSuggestion();
    dlg.querySelector("[data-wo-undo]").onclick = undo;
    dlg.querySelector("[data-wo-cancel]").onclick = () => dlg.close();
    dlg.querySelector("[data-wo-save]").onclick = async () => {
      const msg = dlg.querySelector("[data-wo-msg]");
      if (!w.name.trim()) w.name = suggestion(); // the suggested name, unless one was typed
      if (!w.name.trim()) { msg.innerHTML = state("Enter a name", "bad"); dlg.querySelector("[data-wo-name]").focus(); return; }
      try {
        const q = new URLSearchParams({ person: CURRENT });
        if (save) await save(tree());
        else if (workout?.id) await api(`workouts/${workout.id}?${q}`, { method: "PUT", body: JSON.stringify(tree()) });
        else await api(`workouts?${q}`, { method: "POST", body: JSON.stringify(tree()) });
        dlg.close();
        onSaved();
      } catch (err) { msg.innerHTML = state(esc(err.message), "bad"); }
    };
  };

  const bindCanvas = () => {
    const c = dlg.querySelector("[data-wo-canvas]"), line = c.querySelector("[data-wo-drop]");
    c.addEventListener("click", (e) => {
      const tag = e.target.closest("[data-frame-tag]"), b = e.target.closest("[data-step]"), copy = e.target.closest("[data-copy]"), ph = e.target.closest("[data-ph]");
      sel = tag ? { group: +tag.dataset.frameTag } : b ? { step: +b.dataset.step } : copy ? { group: +copy.dataset.copy } : ph ? { group: +ph.dataset.ph } : null;
      drawCanvas();
      drawSettings();
    });
    // dragging: a step (its block), a whole repeat (its ×N tag), or a new one from the columns;
    // the canvas shows the result while dragging (the blocks make room, the new one sits in
    // its place) and nothing changes until it is dropped
    c.addEventListener("dragstart", (e) => {
      const tag = e.target.closest?.("[data-frame-tag]"), b = e.target.closest?.("[data-step]");
      if (tag) dragging = { group: +tag.dataset.frameTag };
      else if (b) dragging = { step: +b.dataset.step };
      else return;
      dragAt = null;
      liftUid = dragging.step != null ? items[dragging.step].uid : null;
      e.dataTransfer.setData("text/trailbook-move", "1");
      e.dataTransfer.effectAllowed = "move";
    });
    const show = (hit) => {
      const key = `${hit.at}|${hit.on}|${hit.into}`;
      if (key === dragAt) return;
      dragAt = key;
      const d = dragging;
      preview(() => (d.tool ? placeTool(hit, d.tool, true) : placeMove(hit, d)));
    };
    const stop = () => { dragging = dragAt = liftUid = null; line.hidden = true; c.classList.remove("over"); };
    c.addEventListener("dragend", () => { if (dragging) { stop(); drawCanvas(); } });
    c.addEventListener("dragover", (e) => {
      if (!dragging) return;
      e.preventDefault();
      c.classList.add("over");
      show(hitAt(e.clientX));
    });
    c.addEventListener("dragleave", (e) => {
      if (c.contains(e.relatedTarget) || !dragging) return;
      dragAt = null;
      c.classList.remove("over");
      drawCanvas(); // left the canvas: as it was
    });
    c.addEventListener("drop", (e) => {
      e.preventDefault();
      const d = dragging, hit = hitAt(e.clientX);
      stop();
      if (!d) return;
      const r = d.tool ? placeTool(hit, d.tool) : placeMove(hit, d);
      if (!r) { drawCanvas(); return; }
      sel = selOf(r);
      changed();
    });
    // the edges of a repeat frame: drag over neighbouring steps to take them in or leave them
    // out; the frame shows which steps it would take while dragging, the change comes on release
    c.addEventListener("pointerdown", (e) => {
      const h = e.target.closest("[data-handle]");
      if (!h) return;
      e.preventDefault();
      const g = +h.dataset.g, side = h.dataset.handle, frame = h.closest(".wo-frame");
      h.setPointerCapture(e.pointerId);
      frame.classList.add("resizing");
      let at = null;
      h.onpointermove = (ev) => {
        const now = indexAt(ev.clientX);
        if (now === at) return;
        at = now;
        preview(() => placeEdge(g, side, now));
      };
      h.onpointerup = (ev) => {
        h.onpointermove = h.onpointerup = null;
        frame.classList.remove("resizing");
        const r = placeEdge(g, side, indexAt(ev.clientX));
        sel = r;
        changed();
      };
    });
  };

  dlg.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!e.target.closest(".badge-wrap")) dlg.querySelectorAll(".badge-panel").forEach((p) => { p.hidden = true; });
  });
  // Ctrl+Z (Cmd+Z) undoes the last change, except while typing in a text field (its own undo)
  // Delete removes the selected step or repeat; both keys never while typing in a field
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "Delete" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (!e.target.matches?.("input, textarea, select") && deleteSel()) e.preventDefault();
      return;
    }
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== "z") return;
    if (e.target.matches?.('input[type="text"], input:not([type]), textarea')) return;
    e.preventDefault();
    undo();
  });
  dlg.addEventListener("close", () => dlg.remove());
  draw();
  dlg.showModal();
  if (!w.name) dlg.querySelector("[data-wo-name]").focus();
  refresh();
}

// A step or a ready set in the creator's columns: a small picture of its shape (blocks in
// their zone colours, like the canvas), the name and its default length.
function woToolHtml(tool, label, note, parts, repeat = false) {
  const W = 30, H = 22, total = parts.reduce((a, [w]) => a + w, 0) || 1;
  let x = 1;
  const rects = parts.map(([w, zone]) => {
    const width = (w / total) * (W - 2), z = zone ? zone[1] : 0, h = zone ? 5 + (z / 5) * (H - 8) : 6;
    const r = `<rect x="${x.toFixed(1)}" y="${(H - 1 - h).toFixed(1)}" width="${Math.max(1.5, width - 1).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${zone ? woZoneColor(z, 5) : "var(--line)"}"/>`;
    x += width;
    return r;
  }).join("");
  const frame = repeat ? `<rect x="0.75" y="0.75" width="${W - 1.5}" height="${H - 1.5}" rx="4" fill="none" stroke="var(--accent)" stroke-dasharray="2.5 2" stroke-width="1.2"/>` : "";
  return `<button type="button" class="wo-tool" draggable="true" data-tool="${esc(tool)}">
    <span class="wo-tool-ico"><svg viewBox="0 0 ${W} ${H}" aria-hidden="true">${frame}${rects}</svg></span>
    <span class="wo-tool-name">${esc(label)}</span>${note ? `<span class="wo-tool-note">${esc(note)}</span>` : ""}</button>`;
}

// "Label: value" badge with a pick list (the one control style), inside the creator.
const woPick = (name, label, options, current) => badgeHtml(`wo-${name}`, label, esc(options.find(([k]) => k === current)?.[1] || ""), {
  panel: `<div class="opt-panel">${pickList(`wo-${name}`, options, current)}</div>` });
function bindWoPicks(root, onPick) {
  root.querySelectorAll("[data-badge^=wo-]").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    const panel = root.querySelector(`[data-panel="${b.dataset.badge}"]`);
    const open = panel.hidden;
    root.closest("dialog")?.querySelectorAll(".badge-panel").forEach((p) => { p.hidden = true; });
    panel.hidden = !open;
  });
  root.querySelectorAll("[data-pick^=wo-]").forEach((p) => p.onclick = (e) => {
    e.stopPropagation();
    onPick(p.dataset.pick.slice(3), p.dataset.value);
  });
}
