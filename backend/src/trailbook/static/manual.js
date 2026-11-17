// ---- Manual (the ? icon in the header): how Trailbook computes things and how to read them.
//
// Built from the same pieces as the rest of the app (Settings, the Fitness summary): cards with a title, grey tiles, small uppercase panel titles, plain
// data tables, ranked rows. The first card holds the contents as tiles. Every number about
// Trailbook's own rules comes from the server (/api/types: workout_families, workout_rules,
// workout_channels — the detector reads the same values), so the manual cannot drift from the
// code. Garmin's numbers (training effect) are Garmin's published scale.

const MANUAL_TABS = [
  ["types", "Training types", svg(`<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>`)],
  ["effect", "Training effect", svg(`<path d="M3 12h4l3-8 4 16 3-8h4"/>`)],
  ["weather", "Weather help", svg(`<path d="M3 8h10a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7"/>`)],
  ["fitness", "Fitness", svg(`<path d="M3 20h18"/><path d="M4 16l5-5 4 3 7-7"/><path d="M15 7h5v5"/>`)],
];

async function renderManual(tab) {
  if (tab === "kinds") tab = "types"; // old link
  tab = MANUAL_TABS.some(([k]) => k === tab) ? tab : "types";
  MAN_MISSING.clear();
  const sections = tab === "effect" ? manualEffect() : tab === "weather" ? manualWeather() : tab === "fitness" ? manualFitness() : manualTypes();
  const cols = sections.length <= 4 ? sections.length : Math.ceil(sections.length / 2);
  view.innerHTML = `${pageHead("Manual", "", switchHtml("tab", MANUAL_TABS.map(([k, l, icon]) => [k, `${icon}<span>${l}</span>`]), tab))}
    <div class="man">
      ${MAN_MISSING.size ? `<div class="card">${state("The server runs an older version than this page, so some numbers are missing. Restart the server.", "warn")}</div>` : ""}
      <div class="card"><h3>Contents</h3><div class="method-steps man-toc" style="--cols:${cols}">${sections.map((s) =>
        `<button type="button" class="method-step" data-goto="${s.id}"><b>${s.title}</b><span>${s.sum}</span></button>`).join("")}</div></div>
      ${sections.map((s) => `<section class="card man-sec" id="m-${s.id}"><h3>${s.title}</h3><div class="man-body">${s.body}</div></section>`).join("")}
    </div>`;
  view.querySelectorAll("[data-switch=tab]").forEach((b) => b.onclick = () => { location.hash = "#/manual/" + b.dataset.value; });
  view.querySelectorAll("[data-goto]").forEach((b) => b.onclick = () => {
    document.getElementById("m-" + b.dataset.goto)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  view.querySelectorAll("[data-goto-tab]").forEach((b) => b.onclick = () => { location.hash = "#/manual/" + b.dataset.gotoTab; });
  fitManualTables(view);
}

// Fitted tables: when a table's text fits on one line per cell, every column keeps its natural
// width and only the last column takes the rest (the columns stay at the left). When it does not
// fit, the text columns share the width and wrap. Measured again when the window is resized.
function fitManualTables(root) {
  for (const t of root.querySelectorAll("table.man-fit")) {
    const all = [...t.rows].flatMap((r) => [...r.cells]);
    all.forEach((c) => { c.style.width = ""; });
    t.style.width = "max-content";
    const natural = t.offsetWidth, avail = t.parentElement.clientWidth;
    const widths = [...t.rows[0].cells].map((c) => c.offsetWidth), last = widths.length - 1;
    t.style.width = "";
    // every cell of a column gets the width (the fit class sets one on each cell)
    if (natural <= avail) all.forEach((c) => { c.style.width = c.cellIndex === last ? "auto" : `${widths[c.cellIndex]}px`; });
  }
}
let manualFitTimer = null;
addEventListener("resize", () => {
  clearTimeout(manualFitTimer);
  manualFitTimer = setTimeout(() => { const m = document.querySelector(".man"); if (m) fitManualTables(m); }, 150);
});

// Rule values from the server; a value the server does not send (it runs older code than this
// page) is noted, and the page says so at the top instead of quietly printing NaN.
const MAN_MISSING = new Set();
const manRules = (raw) => new Proxy(raw || {}, {
  get: (t, k) => {
    if (typeof k === "string" && !(k in t)) MAN_MISSING.add(k);
    return t[k];
  },
});

// ---- building blocks ----
const mPct = (x) => `${num(Math.round(x * 100))} %`;
const mX = (x) => `${num(x, Number.isInteger(x) ? 0 : Number.isInteger(x * 10) ? 1 : 2)}×`;
const mMin = (s) => `${num(s / 60)} min`;
const mType = (k) => `<b>${esc(workoutLabel(k))}</b>`;
const mTypes = (keys) => keys.map((k) => esc(workoutLabel(k))).join(", ");
const mLink = (id, text) => `<button type="button" class="man-link" data-goto="${id}">${text}</button>`;
// `widths`: column widths in %, the same for tables that sit under each other; or per column
// "fit" (as wide as its content, one line) / "*" (the rest): the columns sit at the left and
// the row lines still run across the card.
const mTable = (head, rows, widths) => {
  const fit = widths?.some((w) => typeof w === "string");
  const cls = (i) => (fit && widths[i] === "fit" ? ' class="fit"' : "");
  return `<div class="man-table"><table class="data${fit ? " man-fit" : ""}">${widths && !fit ? `<colgroup>${widths.map((w) => `<col style="width:${w}%">`).join("")}</colgroup>` : ""}${head.some(Boolean) ? `<thead><tr>${head.map((h, i) => `<th${cls(i)}>${h}</th>`).join("")}</tr></thead>` : ""}
  <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${cls(i)}>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
};
// Grey tiles, like the Fitness method steps: [title, text].
const mTiles = (tiles) => `<div class="method-steps man-tiles" style="--cols:${tiles.length}">${tiles.map(([t, x]) =>
  `<div class="method-step"><b>${t}</b><span>${x}</span></div>`).join("")}</div>`;
// Rules or steps in order: [name, text] as a standard two-column table, numbered; the name
// column as wide as its content, the text takes the rest.
const mRows = (rows, head = ["", ""]) => mTable(head, rows.map(([n, x], i) => [`<span class="man-n">${i + 1}</span><b>${n}</b>`, x]), ["fit", "*"]);
const mTerms = (terms) => mTable(["Term", "Meaning"], terms.map(([t, d]) => [`<b>${t}</b>`, d]), ["fit", "*"]);
const mPanel = (title) => `<div class="panel-title man-panel">${title}</div>`;

// What each training type is and does — the same words everywhere.
const TYPE_TEXT = {
  easy: ["A steady session at a comfortable effort, below tempo.",
    "Builds the aerobic base: more capillaries and mitochondria, better fat use, a stronger heart. Low fatigue, so it carries most of the weekly volume.",
    "Next day anything"],
  long: ["Clearly longer than your usual session of the sport, mostly easy.",
    "Endurance and fatigue resistance: larger glycogen stores, better fat use late in the session, tendons and muscles used to the duration.",
    "1–2 easy days"],
  tempo: ["A sustained, “comfortably hard” effort around the threshold.",
    "Raises the lactate threshold — the pace or power you can hold for a long time — and teaches you to hold it.",
    "About 1 easy day"],
  intervals: ["Repeated hard bouts with easier recoveries in between.",
    "Bouts up to ~2 min: speed and anaerobic capacity; 3–5 min: VO₂max; 8–20 min: threshold. The most fitness — and fatigue — per minute.",
    "1–2 easy days"],
  hills: ["Repeated climbs of the same hill, or a clearly hilly session.",
    "Strength-endurance and power at a high heart rate, with less impact than flat speed work.",
    "1–2 easy days after repeats"],
  race: ["A near-maximal effort for its duration.",
    "The biggest single stimulus and the biggest fatigue: glycogen used up, muscle damage after long races.",
    "Several easy days; weeks after a marathon"],
  commute: ["Everyday movement: walks, hikes, easy rides from A to B.",
    "Adds easy volume and helps recovery; little training stimulus of its own.",
    "None"],
  match: ["A competitive game.", "Repeated sprints, jumps and changes of direction at a high heart rate; close to a race.", "1–2 easy days"],
  training: ["A practice session of the sport.", "Skill and game fitness; the load depends on the drills.", "As the session felt"],
  recreation: ["A casual game.", "Movement and fun; usually light.", "None"],
};
const ENDURANCE_TYPES = ["easy", "long", "tempo", "intervals", "hills", "race", "commute"];
const GAME_TYPES = ["match", "training", "recreation"];
const typeRows = (keys) => keys.map((k) => [mType(k), ...TYPE_TEXT[k].slice(0, 2), `<span class="man-nowrap">${TYPE_TEXT[k][2]}</span>`]);

function manualTypes() {
  const R = manRules(TYPES?.workout_rules);
  const F = TYPES?.workout_families || [];
  const C = TYPES?.workout_channels || {};
  const detected = F.filter((f) => f.auto && f.key !== "foot");
  const foot = F.find((f) => f.key === "foot");
  const games = F.filter((f) => !f.auto);
  const labels = (fs) => fs.flatMap((f) => f.types).map((t) => typeLabel(t)).filter((l) => !/sport$/i.test(l));
  const some = (fs, n) => { const all = labels(fs); return esc(all.slice(0, n).join(", ")) + (all.length > n ? " and more" : ""); };

  return [
    {
      id: "what", title: "What a training type is", sum: "One word for the kind of session",
      body: `<p>Every activity gets one word for the kind of session it was. It is shown in the activity's tiles and can be changed in its Edit panel; statistics count sessions by it.</p>
        ${mTiles([
          ["Endurance sports — detected", [detected.length ? `${esc(detected.map((f) => f.en).join(", "))}.` : "",
            `${mTypes(ENDURANCE_TYPES)}.`, foot ? `${esc(foot.en)} are always Commute.` : ""].filter(Boolean).join(" ")],
          ["Team and racket sports — detected", [games.length ? `${some(games, 6)}.` : "", `${mTypes(GAME_TYPES)}.`,
            "From the heart rate over the whole game."].filter(Boolean).join(" ")],
          ["Everything else — none", "Strength, yoga, climbing, motor sports, multisport and the rest."],
        ])}`,
    },
    {
      id: "types", title: "The training types", sum: "What each does to you and the recovery",
      body: `${mTable(["Type", "What it is", "What it does", "Recovery"], typeRows(ENDURANCE_TYPES), ["fit", "*", "*", "fit"])}
        ${mPanel("Team and racket sports")}${mTable(["Type", "What it is", "What it does", "Recovery"], typeRows(GAME_TYPES), ["fit", "*", "*", "fit"])}`,
    },
    {
      id: "sports", title: "Sports and their settings", sum: "Families, threshold HR share, Long and Hilly",
      body: `<p>Threshold HR is the share of your threshold heart rate the sport uses — the watch keeps the running value, and on a bike or in water the heart rate runs lower. Long from is the shortest Long session; it must also be ${mX(R.long_median)} your usual length of the sport.</p>
        ${mTable(["Family", "Sports", "Training types", "Threshold HR", "Long from", "Hilly from"], F.map((f) => {
          const measured = f.auto && f.key !== "foot";
          return [`<b>${esc(f.en)}</b>`, esc(f.types.map((t) => typeLabel(t)).join(", ")), mTypes(f.kinds),
            measured ? mPct(f.lthr_share) : "–", measured ? `${num(f.long_min)} min` : "–",
            f.hills ? `${num(f.hills[0])} m/km, ${num(f.hills[1])} m` : "–"];
        }), ["fit", "*", "*", "fit", "fit", "fit"])}`,
    },
    {
      id: "rules", title: "How the type is detected", sum: "The rules in order; the first that fits",
      body: `<p>The first rule that fits gives the type; a type the sport does not have is skipped. Everything is measured against you — your threshold heart rate, your FTP, your own usual sessions (${mLink("you", "Relative to you")}).</p>
        ${mRows([
          ["Commute", "Walks and hikes, always."],
          ["Intervals", `Repeated hard bouts with real recoveries (${mLink("intervals", "Intervals in detail")}). The same climb repeated ${num(R.hill_repeats)}+ times is Hills.`],
          ["Race", `≥ ${mPct(R.race_share)} of the moving time at ≥ ${mPct(R.race_hr)} of threshold HR, in every sport (no heart rate: never a race); rides with power also an intensity factor (NP ÷ FTP) of ${num(R.race_if, 2)}+. And ≥ ${mPct(R.race_best)} of your best intensity for a similar duration (±${mPct(R.race_peer_range)}, last ${num(R.race_days)} days), and ${mX(R.race_typical)} your typical, with few stops (elapsed at most ${mX(R.race_stops)} moving). A hot treadmill run has the heart rate of a race, not the performance.`],
          ["Hills", "As much climbing per kilometre as the sport's Hilly from."],
          ["Long", `${mX(R.long_median)} your median moving time of the sport and at least its Long from.`],
          ["Tempo", `≥ ${mPct(R.tempo_share)} of the moving time at ≥ ${mPct(R.tempo_hr)} of threshold HR with one ${num(R.tempo_block_min)}+ min stretch (dips up to a minute), or ≥ ${mPct(R.tempo_share_any)} in any stretches. Rides with power also: 30 s power at ≥ ${mPct(R.tempo_ftp)} of FTP for ${mPct(R.tempo_ftp_share)} of the time with a ${num(R.tempo_ftp_block_min)}+ min stretch.`],
          ["Commute", `Easy rides and skates — under ${mPct(R.commute_hr_share)} of the time at tempo or harder, intensity factor under ${num(R.commute_if, 2)} — shorter than ${num(R.commute_min)} min or ending ${num(R.commute_ab_m / 1000)}+ km from the start.`],
          ["Easy", "Everything else."],
        ], ["Type", "Endurance sports — the first that fits"])}
        ${mRows([
          ["Match", `≥ ${mPct(R.game_match_share)} of the game at ≥ ${mPct(R.game_hard_hr)} of threshold HR.`],
          ["Recreation", `Average heart rate under ${mPct(R.game_easy_avg)} of threshold HR.`],
          ["Training", "Everything else."],
        ], ["Type", "Team and racket sports — heart rate over the whole game, pauses included"])}`,
    },
    {
      id: "intervals", title: "Intervals in detail", sum: "Signal per sport and the checks",
      body: `<p>Detection uses the fastest-reacting signal the activity has. Heart rate comes last: it follows the effort 30–60 s late, so it only shows long bouts.</p>
        ${mTable(["Signal", "Used for", "Smoothing", "Bout vs recovery", "Shortest bout", "Shortest recovery"],
          [["power", "Power (bike)", "Cycling with a power meter"], ["rpower", "Power (other)", "Running power, rowing and ski machines"],
            ["speed", "Speed", "Runs without power (grade-adjusted on hilly runs), skating, paddling, skiing"],
            ["swim", "Pool laps", "Pool swims: speed from the laps, rests at the wall"],
            ["epower", "Estimated power", "Rides without a power meter"], ["hr", "Heart rate", "Machines without power"]]
            .filter(([k]) => C[k]).map(([k, name, use]) => [`<b>${name}</b>`, use, `${num(C[k].smooth)} s`,
              C[k].ratio ? `≥ ${mX(C[k].ratio)}` : `+${mPct(C[k].diff)} of threshold HR`, `${num(C[k].min_work)} s`, `${num(C[k].min_rec)} s`]),
          ["fit", "*", "fit", "fit", "fit", "fit"])}
        ${mRows([
          ["Bouts", "The smoothed signal is split into a hard and an easy level; a bout starts above the split and ends below it, so small wobbles do not cut it."],
          ["Cycles", `Both bouts above the recovery between them by the factor in the table; the recovery at most ${mX(R.iv_max_rest_x)} the longer bout + 3 min; a bout at most ~6× its recovery (pool 12×) — 10 min on, 1 off is a steady session with a break.`],
          ["Enough", `${num(R.iv_bouts)}+ bouts in a row, or 2 of ${mMin(R.iv_long_bout_s)}+ (2 × 20 min); ${mMin(R.iv_work_s)}+ of work (bikes ${mMin(R.iv_work_ride_s)}).`],
          ["Hard for you", `${mX(R.iv_typical)} your typical power or speed (pool ${mX(R.iv_typical_swim)}) — otherwise it is your normal pace with traffic lights. With FTP: bike ≥ ${mPct(R.iv_ftp_ride)}, running power ≥ ${mPct(R.iv_ftp_run)}; without: heart rate at the end of the bouts ≥ ${mPct(R.iv_hr_peak)} of threshold HR.`],
          ["Real recoveries", `Heart rate falls by ≥ ${mPct(R.iv_hr_drop)} of threshold HR (estimated power, heart rate alone ${mPct(R.iv_hr_drop_strict)}); in a race with surges it stays up. Not checked in the pool: wrist heart rate under water is unreliable.`],
          ["Alike", `Lengths within ${mX(R.iv_alike_len)}, intensity varying by ${mPct(R.iv_alike_cv)} at most. Bike bouts under ${num(R.iv_short_bike_s)} s only above ${mPct(R.iv_short_bike_ftp)} of FTP, longer ones above ${mPct(R.iv_bike_ftp)}. Estimated power: heart rate climbs through each bout (+${mPct(R.iv_est_rise)}), recoveries ridden (${mPct(R.iv_est_ridden)} moving).`],
          ["Not the hill", `A bout steeper than ${mPct(R.iv_hill)} (bikes ${mPct(R.iv_hill_ride)}), or that much steeper than its recoveries, is the terrain and does not count. ${num(R.hill_repeats)}+ of them starting within ${num(R.hill_same_m)} m of each other: Hills.`],
        ], ["Check", "All must pass"])}`,
    },
    {
      id: "you", title: "Relative to you", sum: "Threshold HR, FTP, typical, best",
      body: mTiles([
        ["Threshold HR", "From Settings › People, else what the watch had set, else 90 % of your maximum heart rate. Each sport uses its share."],
        ["FTP", "Per sport: rides the cycling FTP, runs the running-power FTP. A ride without one borrows the nearest ride's. Edit corrects it per activity."],
        ["Typical", "The median of your own activities of the family: moving power, speed, estimated power, moving time."],
        ["Best", `Your highest intensity (power, else speed) in activities of the family ±${mPct(R.race_peer_range)} as long, within ${num(R.race_days)} days.`],
      ]),
    },
    {
      id: "change", title: "Changing the training type", sum: "Edit › Training type; kept",
      body: `<p>Edit › Training type: Automatic (the detected type is named next to it) or one of the types of the sport; team and racket sports start as Not set. Your choice is kept through a new import and through detection running again. Detection runs after each import for new activities, and when the activity's type, its FTP or your thresholds change.</p>`,
    },
    {
      id: "terms", title: "Terms", sum: "LTHR, FTP, NP, IF and more",
      body: mTerms([
        ["Threshold heart rate (LTHR)", "The heart rate you can hold for about an hour of hard effort."],
        ["FTP", "Functional threshold power: the power you can hold for about an hour."],
        ["NP, IF", "Normalized power: the steady power that would cost the same as the actual, varying power. Intensity factor = NP ÷ FTP."],
        ["Grade-adjusted speed", "Running speed corrected for the slope by the energy cost of running up and down (Minetti)."],
        ["Estimated power", "Cycling power from speed, slope and acceleration with a typical rider and bike; no wind, no drafting. Used for the shape of a session only, never against FTP."],
        ["Bout, recovery", "A hard stretch of an interval session and the easier stretch after it."],
      ]),
    },
  ];
}

// Garmin's training effect (Garmin Connect data, not in FIT files).
const TE_SCALE = [
  ["0,0–0,9", "No benefit", "Did not challenge this side of your fitness."],
  ["1,0–1,9", "Minor benefit", "A light stimulus; good for recovery days."],
  ["2,0–2,9", "Maintaining", "Keeps your fitness; most easy training sits here."],
  ["3,0–3,9", "Improving", "Improves fitness when repeated 2–4 times a week with recovery."],
  ["4,0–4,9", "Highly improving", "A strong stimulus; 1–2 a week are enough."],
  ["5,0", "Overreaching", "More than the body turns into fitness right away; fine before a rest, harmful when frequent."],
];
const TE_BENEFITS = [
  ["Recovery", "RECOVERY", "Very light activity that helps recovery.", "Short, very easy session"],
  ["Base", "AEROBIC_BASE", "Aerobic endurance and fat use at a low intensity.", "Easy or long session"],
  ["Tempo", "TEMPO", "Efficiency at a moderate, steady intensity.", "Tempo run, steady ride"],
  ["Threshold", "LACTATE_THRESHOLD", "Long stretches near the lactate threshold.", "Threshold intervals, 10 km race"],
  ["VO2 Max", "VO2MAX", "Repeated efforts near the maximum aerobic capacity.", "3–5 min intervals, 5 km race"],
  ["Anaerobic", "ANAEROBIC_CAPACITY", "Short, very hard efforts above the aerobic maximum.", "30 s – 2 min repeats"],
  ["Sprint", "SPEED", "Sprints of a few seconds at maximum speed or power.", "Strides, 10 s sprints"],
];

function manualEffect() {
  return [
    {
      id: "what", title: "What training effect is", sum: "Garmin's estimate of what a session did",
      body: `<p>Garmin computes it on the watch during the activity from your heart rate (and speed or power) and your fitness profile — VO₂max, maximum heart rate, activity class. It is relative to you: as you get fitter, the same session gives a lower number.</p>
        ${mTiles([
          ["Aerobic, 0–5", "The effect on endurance: how much load the whole session accumulated."],
          ["Anaerobic, 0–5", "The effect on short, very hard efforts: how much of the session was above your aerobic maximum."],
          ["Primary benefit", "The one thing the session trained most: Base, Tempo, Threshold…"],
          ["Source", "Garmin Connect only — not in the activity file. Activities from a folder or a ZIP have it once matched with Connect."],
        ])}`,
    },
    {
      id: "scale", title: "The scale", sum: "No benefit to Overreaching",
      body: `<p>Aerobic and anaerobic use the same scale and the same words.</p>
        ${mTable(["Value", "Garmin says", "What it means"], TE_SCALE.map(([v, w, m]) => [`<b class="man-nowrap">${v}</b>`, w, m]), ["fit", "fit", "*"])}`,
    },
    {
      id: "benefit", title: "Primary benefit", sum: "Seven labels and their codes",
      body: `<p>Garmin picks it from how the effort was spread over the heart rate (and power or speed) zones and from the two numbers. Without heart rate, or for a very short session, there is none (UNKNOWN).</p>
        ${mTable(["Benefit", "Code in the data", "What the session trained", "Typical session"], TE_BENEFITS.map(([b, c, w, t]) => [`<b>${b}</b>`, `<code>${c}</code>`, w, t]), ["fit", "fit", "*", "*"])}`,
    },
    {
      id: "read", title: "How to read it", sum: "Examples and what to compare",
      body: `${mTable(["Reading", "Means"], [
          ["Base · aer 3,1 · an 0,3", "A steady session that improved endurance and did not touch the anaerobic side."],
          ["VO2 Max · aer 4,5 · an 2,8", "Hard intervals: a strong aerobic stimulus with a noticeable anaerobic part."],
          ["Anaerobic · aer 2,4 · an 3,6", "Short repeats with long rests: little endurance, a lot of anaerobic work."],
          ["Threshold · aer 5,0 · an 1,2", "A race or a very long day: overreaching. Plan easy days after it."],
        ].map(([r, m]) => [`<b>${r}</b>`, m]), ["fit", "*"])}
        <p>Compare similar sessions over weeks: when the same session gives a lower aerobic number, you got fitter. A week of a few sessions at 3–4 and the rest around 2 is a common balance.</p>`,
    },
    {
      id: "types", title: "Training effect and training type", sum: "What a session was vs what it did",
      body: `<p>The <button type="button" class="man-link" data-goto-tab="types">training type</button> is what the session was — its structure, worked out by Trailbook from the recording. Training effect is what it did to you, estimated by Garmin. When they disagree both can be right: a long easy ride on a hot day can be Long with an aerobic effect of 4,5.</p>
        ${mTable(["Training type", "Usual primary benefit", "Usual aerobic effect"],
          [["easy", "Recovery, Base", "2–3"], ["long", "Base, Tempo", "3–5"], ["tempo", "Tempo, Threshold", "3–4"],
            ["intervals", "Threshold, VO2 Max, Anaerobic", "3–5, anaerobic 2+"], ["hills", "Tempo, VO2 Max, Anaerobic", "3–4"],
            ["race", "Threshold, VO2 Max", "4–5"], ["commute", "Recovery, Base", "0–2"]].map(([k, b, t]) => [mType(k), b, t]),
          ["fit", "fit", "*"])}`,
    },
    {
      id: "where", title: "Where you see it", sum: "The Effect tile",
      body: "<p>The Effect tile on the activity page shows the primary benefit and the aerobic and anaerobic numbers. Hovering it shows what the scale means and the list of benefits.</p>",
    },
  ];
}

// Weather help: the meter in the segment tables and on the activity map. The weights come
// from HELP_PROFILES (segments.js), the same values the meter is computed with.
function manualWeather() {
  const R = HELP_PROFILES.ride, U = HELP_PROFILES.run;
  // shortest form, real minus: 0,1 · 0,035 · −3
  const d = (v) => `${v < 0 ? "−" : ""}${num(Math.abs(v), (String(Math.abs(v)).split(".")[1] || "").length)}`;
  const runEx = 20 * U.wind - Math.min(U.tempMax, (22 - U.hi) * U.heat);
  return [
    {
      id: "what", title: "What it shows", sum: "Did the weather help or hold back",
      body: mTiles([
        ["Where", "Weather column of the segment tables (per effort, on the segment), and under the weather on an activity's map (whole route)."],
        ["The meter", "From the middle axis: right and green = helped, left and orange to red = held back. A full half is 15 points."],
        ["On hover", "This case's breakdown: wind, wind both ways, temperature, rain, each with its points, and the sum."],
        ["Weather", "Open-Meteo, hourly model values for the area (~10 km) of the activity's start. One set per activity."],
      ]),
    },
    {
      id: "sports", title: "Which activities", sum: "Rides and runs outdoors",
      body: mTable(["Activity", "Meter", "Weather in the table"], [
        ["<b>Rides outdoors</b> — road, gravel, MTB, e-bike…", "Ride weights", "Yes"],
        ["<b>Runs outdoors</b> — road, trail…", "Run weights", "Yes"],
        ["<b>Indoor and virtual</b> — trainer, Zwift, treadmill…", "No", "Empty: outdoor weather does not apply"],
        ["<b>Other sports</b>", "No", "Yes"],
      ], ["fit", "fit", "*"]),
    },
    {
      id: "how", title: "How it is counted", sum: "Four parts, summed",
      body: `<p>Points: 1 point ≈ 1 km/h of tailwind on a bike. W, L, the range and the rest are the sport's ${mLink("weights", "weights")}.</p>
        ${mRows([
          ["Wind along", "Each piece of the line (the segment in the riding direction, ⇄ reversed; or the whole route) counts by its length: tailwind + , headwind − , crosswind 0. Average × wind speed × W. A loop or an out-and-back cancels out by itself."],
          ["Wind both ways", "Headwind parts take longer than tailwind parts save, so a loop is not quite neutral. The share of the line that cancels out × wind speed × L, at most L max."],
          ["Temperature", "Outside the comfortable range: per °C below × cold, per °C above × heat, at most T max."],
          ["Rain or snow", "The worst one: snow, thunderstorm, rain ≥ 3 mm, rain ≥ 0,5 mm."],
        ])}
        ${mPanel("The sum")}${mTable(["Points", "Says", "Meter"], [
          ["≥ 10", "Helped a lot", "Dark green"], ["4 to 10", "Helped", "Green"], ["1,5 to 4", "Helped a little", "Light green"],
          ["−1,5 to 1,5", "About neutral", "Grey"], ["−4 to −1,5", "Held back a little", "Light orange"],
          ["−10 to −4", "Held back", "Orange"], ["≤ −10", "Held back a lot", "Red"]].map(([a, b, c]) => [`<b class="man-nowrap">${a}</b>`, b, c]), ["fit", "fit", "*"])}`,
    },
    {
      id: "weights", title: "Weights per sport", sum: "Ride vs run",
      body: mTable(["", "Ride", "Run", "Why"], [
        ["<b>Wind W</b>", d(R.wind), d(U.wind), "A runner is slower: the same wind changes the drag far less."],
        ["<b>Both ways L / L max</b>", `${d(R.loop)} per km/h / ${d(R.loopMax)}`, `${d(U.loop)} per km/h / ${d(U.loopMax)}`, "Scaled like the wind."],
        ["<b>Comfortable</b>", `${R.lo}–${R.hi} °C`, `${U.lo}–${U.hi} °C`, "Running makes more heat and cools less by airflow."],
        ["<b>Cold / heat per °C</b>", `${d(R.cold)} / ${d(R.heat)}`, `${d(U.cold)} / ${d(U.heat)}`, "Wind chill hurts at bike speed; heat hurts a runner more."],
        ["<b>T max</b>", d(R.tempMax), d(U.tempMax), ""],
        ["<b>Rain ≥ 0,5 / ≥ 3 mm</b>", `${d(R.rain)} / ${d(R.rainHeavy)}`, `${d(U.rain)} / ${d(U.rainHeavy)}`, "Slippery roads and corners on a bike; a runner mostly gets wet."],
        ["<b>Snow / storm</b>", `${d(R.snow)} / ${d(R.storm)}`, `${d(U.snow)} / ${d(U.storm)}`, ""],
      ], ["fit", "fit", "fit", "*"]),
    },
    {
      id: "examples", title: "Examples", sum: "Wind 20 km/h from the south",
      body: mTable(["Case", "Points"], [
        ["Ride, straight north, 18 °C, dry", "+20 · helped a lot"],
        ["The same, ridden south", "−20 · held back a lot"],
        [`Ride, closed loop, 18 °C, dry`, `${signed(-Math.min(R.loopMax, R.loop * 20))} · held back a little`],
        [`Run, straight north, 22 °C, dry`, `+${num(runEx, 1)} · ${runEx >= 4 ? "helped" : "helped a little"}`],
      ].map(([a, b]) => [a, `<b class="man-nowrap">${b}</b>`]), ["fit", "*"]),
    },
    {
      id: "limits", title: "Limits", sum: "A rule of thumb",
      body: mTiles([
        ["Model, not the street", "Trees, buildings and valleys change the wind you feel; gusts are not in it."],
        ["10 m high", "The wind is the model's 10 m value; near the ground it is weaker."],
        ["One hour", "The weather of the start's hour, not the hour of each effort."],
        ["Ranking, not a correction", "The points rank conditions; they are not seconds to add or take away."],
      ]),
    },
  ];
}

// Fitness: training load per activity and the fitness model. The numbers come from the server
// (/api/types: fitness_rules) and from the zones the Fitness charts draw (FORM_ZONES,
// RAMP_ZONES in training.js).
function manualFitness() {
  const R = TYPES?.fitness_rules || {};
  const ctl = R.ctl_days ?? 42, atl = R.atl_days ?? 7;
  const k = (days) => `${num((1 - Math.exp(-1 / days)) * 100, 2)} %`;
  const n = (v) => `${v < 0 ? "−" : ""}${num(Math.abs(v))}`; // real minus
  const range = (lo, hi) => (lo === -Infinity ? `below ${n(hi)}` : hi === Infinity ? `above ${n(lo)}` : `${n(lo)} to ${n(hi)}`);
  const FORM_TEXT = {
    Transition: "Long rest: fitness is falling.",
    Fresh: "Rested. The zone to race in.",
    "Grey zone": "Little stimulus: fitness is kept, not built.",
    Optimal: "Training load that builds fitness.",
    "High risk": "More than you recover from. Plan easy days.",
  };
  const RAMP_TEXT = { "Too fast": "Risk of overload and injury.", Building: "Sustainable growth.", "Losing fitness": "Less training than before." };
  const zone = (name, color) => `<span class="man-zone"><i style="background:${color}"></i><b>${name}</b></span>`;
  return [
    {
      id: "what", title: "What the charts show", sum: "Load, fitness, fatigue, form",
      body: mTiles([
        ["Load", "Per activity, in TSS: one hour at your threshold = 100. An easy hour is about 50, a hard race hour 100+."],
        ["Fitness (CTL)", `Average of the daily load over ~${num(ctl)} days. Grows slowly with steady training.`],
        ["Fatigue (ATL)", `Average of the daily load over ~${num(atl)} days. Jumps after every hard day.`],
        ["Form (TSB)", "Yesterday's fitness − fatigue. Positive = rested, negative = tired."],
      ]),
    },
    {
      id: "load", title: "Load per activity", sum: "Power, running pace or heart rate",
      body: `<p>Every sport counts. Each activity uses the first method from the top it has the data for; hours = moving time.</p>
        ${mTable(["Method", "Load", "Activities"], [
          ["<b>Power</b>", "TSS = hours × IF² × 100, IF = NP ÷ FTP", "A power stream and an FTP: rides (cycling FTP) and runs with running power (running FTP) from the watch; any sport with your FTP."],
          ["<b>Running pace</b>", "The same, IF = average speed ÷ threshold speed", "Outdoor runs, with a threshold pace set by you."],
          ["<b>Heart rate</b>", "TRIMP per second, 1 hour at threshold HR = 100", "Any sport with heart rate; without a stream, the average HR over the moving time."],
          ["<b>No load</b>", "–", "No power and no heart rate (e.g. strength without a strap): in totals, not in fitness."],
        ], ["fit", "fit", "*"])}
        ${mPanel("Heart rate in detail")}
        <p>Each second: HRr = (HR − resting) ÷ (HR max − resting), weight = HRr × 0,64 × e<sup>1,92 × HRr</sup>. The weights are summed and divided by one hour at threshold HR. Hard minutes weigh more than easy ones; at least one minute of heart rate is needed.</p>`,
    },
    {
      id: "model", title: "Fitness, fatigue and form", sum: `${num(ctl)} and ${num(atl)} days, form from yesterday`,
      body: `${mTable(["Value", "Each day", "Reads"], [
          ["<b>Daily load</b>", "Sum of the day's activities (local date); a day without training = 0.", "–"],
          ["<b>Fitness</b>", `Fitness + (daily load − fitness) × ${k(ctl)}`, "The load you are used to."],
          ["<b>Fatigue</b>", `Fatigue + (daily load − fatigue) × ${k(atl)}`, "The load of the last days."],
          ["<b>Form</b>", "Yesterday's fitness − yesterday's fatigue", "How fresh you start the day."],
          ["<b>Ramp rate</b>", "Fitness − fitness 7 days ago", "How fast fitness grows (Summary)."],
        ], ["fit", "fit", "*"])}
        <p>Both averages start at 0 on the first day with a load, so the first ~6 weeks show less fitness than you have. Changing a threshold recomputes every activity.</p>`,
    },
    {
      id: "zones", title: "Form and ramp zones", sum: "Where you are and what it means",
      body: `${mTable(["Form", "Value", "Means"], FORM_ZONES.map(([lo, hi, n, c]) => [zone(n, c), range(lo, hi), FORM_TEXT[n] || ""]), ["fit", "fit", "*"])}
        ${mPanel("Ramp rate")}${mTable(["Ramp", "Fitness per 7 days", "Means"], RAMP_ZONES.map(([lo, hi, n, c]) => [zone(n, c), range(lo, hi), RAMP_TEXT[n] || ""]), ["fit", "fit", "*"])}`,
    },
    {
      id: "thresholds", title: "Thresholds", sum: "Yours, the watch, estimates",
      body: `<p>Each value separately, the first source from the top that has it. Set or correct them with the pencil in Settings › People.</p>
        ${mTable(["Source", "Values", "Rule"], [
          ["<b>Yours</b>", "Any", "Settings › People, valid from a date: older activities keep older values. Replaces the watch."],
          ["<b>The watch</b>", "HR max, threshold HR, FTP, resting HR", `What the watch had set for the activity (FIT file); missing: the nearest activity's. FTP only within the sport (${esc((R.ftp_groups || ["ride", "run"]).map((g) => groupLabel(g)).join(", "))}); one activity's FTP can be corrected in its Edit panel.`],
          ["<b>Estimate</b>", "HR max, resting HR, threshold HR", `HR max = your highest recorded HR (${num(R.hr_max_range?.[0] ?? 100)}–${num(R.hr_max_range?.[1] ?? 230)} bpm); resting HR = ${num(R.default_hr_rest ?? 60)} bpm; threshold HR = ${mPct(R.lthr_share_of_max ?? 0.9)} of HR max.`],
        ], ["fit", "fit", "*"])}
        ${mPanel("The ⚠ next to Fitness")}
        <p>Only when the load can really be off: resting HR is the default or HR max comes from your recordings, not the watch; or a year uses watch values more than ${num(Math.round((R.stale_days ?? 365) / 365))} year away. <i>Use estimate</i> in the editor stops the warning for that value.</p>`,
    },
    {
      id: "terms", title: "Terms", sum: "TSS, CTL, ATL, TSB, NP, IF",
      body: mTerms([
        ["TSS", "Training stress score: load of a session; one hour at threshold = 100."],
        ["CTL, ATL, TSB", "Chronic and acute training load and training stress balance — the usual names of fitness, fatigue and form."],
        ["NP, IF", "Normalized power: the steady power that would cost the same as the actual one. Intensity factor = NP ÷ FTP."],
        ["Threshold HR, FTP", "The heart rate and the power you can hold for about an hour."],
        ["HR max, resting HR", "Your highest and your lowest heart rate; the range the heart rate load is measured in."],
        ["TRIMP", "Training impulse: time weighted by how high the heart rate is."],
      ]),
    },
  ];
}
