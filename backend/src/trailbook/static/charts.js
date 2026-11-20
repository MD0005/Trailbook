// Trailbook chart standard (docs/CHARTS.md), built on uPlot (static/vendor).
// One pattern for the whole app: a framed plot area (frame + axes on all four sides), axis
// titles with units (HTML, with an explanation on hover), dense ticks on both axes, a fine
// dashed horizontal grid, solid crosshair lines (the vertical one through all charts of a
// group, the horizontal one only in the hovered chart) with an animated point and a value
// flag, the exact x value on the x axis, pins on click, drag to zoom with an animated range
// change. Pastel series colours; a single series is filled. Stats of the series on the right.

const CHART_FONT = "11px Roboto, system-ui, sans-serif";
const CHART_H = 240;
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const withAlpha = (hex, a) => `${hex}${Math.round(a * 255).toString(16).padStart(2, "0")}`;
const dark = () => document.documentElement.dataset.theme === "dark";
// Dark theme: series colours a little calmer - mixed 22 % towards the card background.
const DARK_MUTE = 0.22;
function muteDark(hex) {
  if (!dark() || !/^#[0-9a-f]{6}$/i.test(hex || "")) return hex;
  const bg = (cssVar("--surface") || "#171a21").replace("#", "");
  const ch = (h, i) => parseInt(h.slice(i, i + 2), 16);
  const b = hex.slice(1);
  return "#" + [0, 2, 4].map((i) => Math.round(ch(b, i) + (ch(bg, i) - ch(b, i)) * DARK_MUTE).toString(16).padStart(2, "0")).join("");
}
// Fill strength under a line: weaker on the dark background.
const fillAlpha = (a) => (dark() ? a * 0.65 : a);

// A group of synced charts over the same x values.
//   x: { distance: [km] | null, time: [s], percent: [%], date: [unix s] },
//   kind: "distance" | "time" | "percent" | "date" (days; no axis title, as months are obvious)
//   series: [{ key, label, unit, values, dec, color, icon | iconHtml, tip, stats: [[label, value, mark, tip]],
//              targets: [{ i0, i1, lo, hi }], title (card title, default label), yTitle,
//              lines: [{ label, values, color }]  more series in the same chart (legend instead of stats),
//              zones: [{ lo, hi, color, label }]  bands behind the line; the line takes the zone colour,
//              bands: false (zones colour the line only, no bands behind it),
//              invert: true (higher values lower), yMin / yMax: values the y range always includes,
//              ySplits: [v] (y grid and labels exactly there, e.g. at the zone limits), height (px),
//              fmt: (v) => text (values on the y axis, the flag, pins), points: true (a dot per value),
//              tags: [{ label, value, color, mark }]  value pills on the right at the height of their
//              value (instead of stats / legend), pushed apart so they never overlap }]
//   marks: [{ x, icon, tip, href }] icons in a strip under the x axis (marksHidden: start hidden)
//   hidden: [key] charts built but not shown (api.show(key, on) toggles one without a rebuild)
//   mark: what hovering the stat highlights - "max" | "min" (a point), "up" | "down" (the climbs or
//   descents), { ranges: [[i0, i1]] }, a number (a line at that value, e.g. an average)
//   targets: workout step targets (sample index range, low and high value), drawn dashed
//   onHover(i | null): the hovered sample index (for the map), onRanges([[i0, i1]] | null): the
//   stretches a hovered stat marks (for the map), onState(): pins/zoom changed,
//   onOrder([key]): the charts were reordered by dragging a card
//   climbs on a series: s.climbs = { items: [{ i0, i1 }], label(i0, i1) => { lines, color },
//               onChange(), edit: false (only drawn thick: no circles), lines [] = no tag,
//               colorAt(v) (each value its own colour instead of one per stretch),
//               tip(i0, i1, i) => html (a line in the value flag while the cursor is in a stretch) }  the stretch drawn thick in its colour, a tag of values above it,
//               circles at both ends on hover to change the range
//   sections: { keys: [key], at: [sample index], label(key, i0, i1) => [[text, colour | null]],
//               lines (text rows in the strip, default 2), onChange([index]) }, or a list of
//               them (each chart in at most one set)  interval sections and climbs: thin lines at `at` on the charts in
//               `keys` and a strip above each with the values of every section (label). A line
//               can be dragged; on the strip a ball with − over a line removes it, a ball with +
//               elsewhere adds one. Changes apply to all those charts.
function chartGroup(root, { x, kind, series, hidden = [], sections = null, onHover = () => {}, onRanges = () => {}, onState = () => {}, onOrder = () => {} }) {
  const g = { kind, plots: [], pins: [], range: null, hoverIdx: null, dragged: false, mark: null, hidden: new Set(hidden), secs: [].concat(sections || []) };
  const syncKey = "tb-" + Math.random().toString(36).slice(2);
  const xs = () => x[g.kind];
  const X_TITLE = { distance: ["Distance (km)", "Distance from the start."], time: ["Elapsed time (h:mm)", "Time from the start, pauses and stops included."],
                    timer: ["Timer time (h:mm)", "Time with the watch running: pauses left out."],
                    percent: ["Progress (%)", "Share of the whole activity: distance, or time when there is no distance."] };
  const fmtTime = (s, sec = false) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60);
    return `${h}:${String(m).padStart(2, "0")}${sec ? ":" + String(ss).padStart(2, "0") : ""}`;
  };
  const stepDec = (incr) => Math.min(2, Math.max(0, -Math.floor(Math.log10(incr) + 1e-9)));
  const fmtDate = (v) => new Date(v * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  // Date axis: even steps - a week, 1, 2, 3 or 6 months, a year - as many as fit (~56 px each).
  // Month ticks show "Mar"; the first tick and every January carry the year below.
  const MONTHS_3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DATE_STEPS = [["w", 1], ["m", 1], ["m", 2], ["m", 3], ["m", 6], ["y", 1], ["y", 2], ["y", 5]];
  const dateSplits = (u, ai, min, max) => {
    const days = (max - min) / 86400, fit = Math.max(2, Math.floor(u.bbox.width / (devicePixelRatio || 1) / 56));
    const [unit, n] = DATE_STEPS.find(([un, k]) => days / (un === "w" ? 7 * k : un === "m" ? 30.4 * k : 365 * k) <= fit) || ["y", 10];
    u._dateUnit = unit;
    const out = [], d = new Date(min * 1000);
    if (unit === "w") { // Mondays
      d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7));
      for (; d.getTime() / 1000 <= max; d.setUTCDate(d.getUTCDate() + 7)) out.push(d.getTime() / 1000);
      return out;
    }
    const step = unit === "y" ? 12 * n : n;
    let m = d.getUTCFullYear() * 12 + d.getUTCMonth();
    m = Math.ceil((m + (d.getUTCDate() > 1 ? 1 : 0)) / step) * step; // first month boundary on the step
    for (let t; (t = Date.UTC(Math.floor(m / 12), m % 12, 1) / 1000) <= max; m += step) if (t >= min) out.push(t);
    return out;
  };
  const dateLabels = (u, vals) => vals.map((v, k) => {
    const d = new Date(v * 1000), y = d.getUTCFullYear(), mo = d.getUTCMonth();
    if (u._dateUnit === "y") return String(y);
    const head = u._dateUnit === "w" ? `${d.getUTCDate()} ${MONTHS_3[mo]}` : MONTHS_3[mo];
    const prev = k ? new Date(vals[k - 1] * 1000).getUTCFullYear() : null;
    return k === 0 || prev !== y ? `${head}\n${y}` : head;
  });
  const fmtX = (v, exact = false, incr = 1) => (v == null ? "" : g.kind === "date" ? fmtDate(v) : g.kind === "distance" ? (exact ? `${num(v, 2)} km` : num(v, stepDec(incr)))
    : g.kind === "percent" ? `${num(v, exact ? 1 : 0)}${exact ? " %" : ""}` : fmtTime(v, exact));
  const fmtY = (s, v) => (v == null ? "–" : s.fmt ? s.fmt(v) : `${num(v, s.dec)}${s.unit ? " " + s.unit : ""}`);
  const zoneOf = (s, v) => (v == null ? null : s.zones?.find((z) => v >= z.lo && v < z.hi) || null);
  const colorAt = (s, v) => zoneOf(s, v)?.color || s.color;

  function block(s) {
    const el = document.createElement("div");
    el.className = "card chart-block";
    el.dataset.key = s.key;
    const xt = X_TITLE[g.kind];
    const side = s.tags ? s.tags.map((t, k) => `<div class="chart-stat chart-tag" data-tag="${k}"${t.tip ? ` data-tip="${esc(t.tip)}"` : ""}><span class="chart-stat-label">${t.label}</span><span class="chart-ribbon" style="--c:${t.color}">${t.text}</span></div>`).join("")
      : (s.lines?.length && s.legend !== false ? [{ label: s.label, color: s.color }, ...s.lines].map((l) => `<div class="chart-legend-item"><i style="background:${l.color}${l.dash ? ";opacity:.9" : ""}" class="${l.dash ? "dash" : ""}"></i>${l.label}</div>`).join("") : "")
      + (s.stats || []).map(([l, v, , tip], k) => (v == null || v === "–" ? "" :
        `<div class="chart-stat" data-stat="${k}" data-tip="${esc(tip || statTip(l, s))}"><span class="chart-stat-label">${l}</span><span class="chart-ribbon" style="--c:${s.color}">${v}</span></div>`)).join("");
    el.innerHTML = `<div class="card-head"><h3 class="chart-title" data-tip="${esc(s.tip)}">${s.iconHtml || (s.icon ? metricIcon(s.icon, 18) : "")}<span>${s.title || s.label}</span></h3></div>
      <div class="chart-row">
        <div class="chart-frame">
          ${hasSec(s) ? `<div class="chart-sections" style="height:${18 + 14 * (secOf(s).lines || 2)}px"><div class="sec-cells"></div><span class="sec-ball sec-add" hidden>+</span></div>` : ""}
          <div class="chart-ylabel" data-tip="${esc(s.tip)}"><span>${s.yTitle || s.label}${s.unit ? ` (${s.unit})` : ""}</span></div>
          <div class="chart-plot"></div>
          ${s.marks ? `<div class="chart-marks"${s.marksHidden ? " hidden" : ""}></div>` : ""}
          ${xt ? `<div class="chart-xlabel" data-tip="${esc(xt[1])}">${xt[0]}</div>` : ""}
        </div>
        <div class="chart-stats${s.tags ? " chart-tags" : ""}">${side}</div>
      </div>`;
    el.hidden = g.hidden.has(s.key);
    return el;
  }

  function opts(s, width) {
    // Theme colours, read when the chart is built (rebuilt when the theme changes).
    const muted = cssVar("--muted"), line = cssVar("--chart-grid") || cssVar("--line"), axis = cssVar("--chart-frame") || line;
    const grad = (u) => {
      const c = u.ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height);
      c.addColorStop(0, withAlpha(s.color, fillAlpha(0.45))); c.addColorStop(1, withAlpha(s.color, 0.04));
      return c;
    };
    // Zones: the line takes the colour of the zone it is in (hard stops at the zone limits).
    const zoneStroke = (u) => {
      const { top, height } = u.bbox, c = u.ctx.createLinearGradient(0, top, 0, top + height);
      const at = (v) => Math.min(1, Math.max(0, (u.valToPos(v, "y", true) - top) / height));
      const stops = [];
      for (const z of s.zones) {
        const a = at(Math.max(z.lo, u.scales.y.min)), b = at(Math.min(z.hi, u.scales.y.max));
        if (a !== b) stops.push([Math.min(a, b), Math.max(a, b), z.color]);
      }
      stops.sort((p, q) => p[0] - q[0]).forEach(([a, b, col]) => { c.addColorStop(a, col); c.addColorStop(b, col); });
      return stops.length ? c : s.color;
    };
    const multi = Boolean(s.lines?.length);
    const extra = (s.lines || []).map((l) => ({ label: l.label, stroke: l.color, width: 2, dash: l.dash, points: { show: false }, spanGaps: true }));
    const yRange = (u, mn, mx) => {
      const lo = Math.min(mn ?? 0, s.yMin ?? Infinity), hi = Math.max(mx ?? 1, s.yMax ?? -Infinity);
      const pad = (hi - lo) * 0.06 || 1;
      return [lo === s.yMin ? lo : lo - pad, hi === s.yMax ? hi : hi + pad];
    };
    // The chart with the road surface strip: the y range reaches below the data by the strip's
    // height, so the lowest values sit just above the strip instead of under it.
    const liftForSurface = (u, [lo, hi]) => {
      if (g.surface?.key !== s.key || s.invert) return [lo, hi];
      const ph = u.bbox?.height ? u.bbox.height / (devicePixelRatio || 1) : (s.height || CHART_H) - 26;
      const strip = SURFACE_STRIP_PX + 3; // the strip and a small gap
      return ph > strip * 2 ? [lo - ((hi - lo) * strip) / (ph - strip), hi] : [lo, hi];
    };
    const date = g.kind === "date";
    return {
      width, height: s.height || CHART_H, padding: [8, 2, 0, 0],
      scales: { x: { time: g.kind === "date", range: (u, mn, mx) => (g.range || [mn, mx]) },
                y: { dir: s.invert ? -1 : 1,
                     range: (u, mn, mx) => liftForSurface(u, s.yMin != null || s.yMax != null ? yRange(u, mn, mx) : uPlot.rangeNum(mn ?? 0, mx ?? 1, 0.1, true)) } },
      legend: { show: false },
      cursor: {
        sync: { key: syncKey, scales: ["x", null] },
        drag: { x: true, y: false, setScale: false },
        points: { size: 10, width: 2, stroke: cssVar("--surface") || "#fff",
                  fill: (u, si) => (si === 1 ? colorAt(s, s.values[u.cursor.idx]) : s.lines[si - 2].color) },
      },
      series: [{}, { label: s.label, stroke: s.zones ? zoneStroke : s.color, width: s.zones ? 2.4 : 2, fill: (s.fill ?? !(multi || s.zones)) ? grad : undefined, points: s.points ? { show: true, size: 6, width: 0, fill: s.color } : { show: false }, spanGaps: true }, ...extra],
      axes: [
        { font: CHART_FONT, stroke: muted, space: 46, size: date ? 32 : 18, gap: 2, border: { show: true, stroke: axis, width: 1 },
          grid: { show: false }, ticks: { stroke: axis, size: 3, width: 1 },
          ...(date ? { splits: dateSplits, values: dateLabels } : { values: (u, vals, ax, space, incr) => vals.map((v) => fmtX(v, false, incr)) }) },
        { font: CHART_FONT, stroke: muted, space: 22, gap: 2, border: { show: true, stroke: axis, width: 1 },
          ...(s.ySplits ? { splits: (u) => s.ySplits.filter((v) => v >= u.scales.y.min && v <= u.scales.y.max) } : {}),
          // one width for the y axis of every chart in the group: the plots start at the same x,
          // so a moment (cursor, pins, interval lines) is one straight line down the page
          size: (u, vals) => {
            g.yw[s.key] = vals ? Math.max(...vals.map((v) => String(v).length)) * 6.4 + 8 : 24;
            return Math.max(...Object.values(g.yw));
          },
          grid: { stroke: line, width: 0.6, dash: [2, 3] }, ticks: { stroke: axis, size: 3, width: 1 },
          values: (u, vals, ax, space, incr) => vals.map((v) => (s.fmt ? s.fmt(v) : num(v, s.ySplits ? 0 : stepDec(incr)))) },
      ],
      hooks: {
        // soft shadow under the series line
        drawClear: [(u) => drawZones(u, s)],
        drawAxes: [(u) => { u.ctx.save(); u.ctx.shadowColor = s.zones ? "rgba(0,0,0,.18)" : withAlpha(s.color, 0.55); u.ctx.shadowBlur = 6; u.ctx.shadowOffsetY = 2; }],
        draw: [(u) => { u.ctx.restore(); drawSurface(u, s); drawTargets(u, s); drawClimbs(u, s); drawExt(u, s); drawSections(u, s); drawMark(u, s); drawFrame(u, axis); placeSections(u, s); placeClimbs(u, s); drawPins(u); placeTags(u, s); placeMarks(u, s); }],
        setCursor: [(u) => cursorMoved(u, s)],
        setSelect: [(u) => {
          if (u.select.width < 4) return;
          const a = u.posToVal(u.select.left, "x"), b = u.posToVal(u.select.left + u.select.width, "x");
          g.dragged = true;
          u.setSelect({ left: 0, width: 0 }, false);
          zoomTo([a, b]);
        }],
      },
    };
  }
  function color(name, alpha) {
    const v = cssVar(name);
    return v.startsWith("#") && v.length === 7 ? withAlpha(v, alpha) : v;
  }

  // The plot area framed on all four sides (axes on the left and bottom, lines top and right).
  function drawFrame(u, stroke) {
    const { left, top, width, height } = u.bbox, ctx = u.ctx, dpr = devicePixelRatio || 1;
    ctx.save(); ctx.strokeStyle = stroke; ctx.lineWidth = dpr;
    ctx.strokeRect(Math.round(left) + 0.5, Math.round(top) + 0.5, Math.round(width) - 1, Math.round(height) - 1);
    ctx.restore();
  }

  // Zone bands behind the series (light fill in the zone colour).
  function drawZones(u, s) {
    if (!s.zones?.length || s.bands === false || u.scales.y.min == null) return;
    const ctx = u.ctx, { left, top, width, height } = u.bbox;
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
    const dpr = devicePixelRatio || 1;
    ctx.font = `500 ${10 * dpr}px Roboto, system-ui, sans-serif`; ctx.textAlign = "left"; ctx.textBaseline = "top";
    for (const z of s.zones) {
      if (z.lo > u.scales.y.max || z.hi < u.scales.y.min) continue;
      const a = u.valToPos(Math.max(z.lo, u.scales.y.min), "y", true), b = u.valToPos(Math.min(z.hi, u.scales.y.max), "y", true);
      const y0 = Math.min(a, b), h = Math.abs(b - a);
      ctx.fillStyle = withAlpha(z.color, dark() ? 0.07 : 0.05);
      ctx.fillRect(left, y0, width, h);
      // the zone name in its top left corner (when the band is tall enough)
      if (z.label && h > 14 * dpr) { ctx.fillStyle = withAlpha(z.color, 0.7); ctx.fillText(z.label, left + 6 * dpr, y0 + 3 * dpr); }
    }
    ctx.restore();
  }

  // Value pills on the right: each at the height of its value, pushed apart (no overlap).
  // Icons along the x axis (e.g. activities on a date axis): one per ~35 px, the others of the
  // same spot are counted on it. Tooltip: `s.marksTip(items)` (else their tips listed); hovering
  // shades the stretch of the axis the icon stands for (`s.markSpan` seconds after the last
  // one); a click calls `s.onMarks(items, el)` (else a single one links to its page). The
  // strip is rewritten only when it changes, so the hovered icon stays.
  function placeMarks(u, s) {
    const box = u._tb?.marks;
    if (!box || !s.marks || box.hidden) return;
    const left = u.over.offsetLeft, w = u.over.clientWidth, groups = [];
    for (const m of s.marks) {
      const px = u.valToPos(m.x, "x");
      if (px < -2 || px > w + 2) continue;
      const g0 = groups[groups.length - 1];
      if (g0 && px - g0.px < 35) g0.items.push(m); else groups.push({ px, items: [m] });
    }
    u._tb.markGroups = groups;
    const html = groups.map(({ px, items }, k) => {
      const tip = s.marksTip ? s.marksTip(items)
        : items.slice(0, 8).map((m) => m.tip).join("\n\n") + (items.length > 8 ? `\n\n+${items.length - 8} more` : "");
      const tag = !s.onMarks && items.length === 1 && items[0].href ? "a" : "span";
      return `<${tag} class="chart-mark${s.onMarks ? " click" : ""}" data-mark-group="${k}" style="left:${left + px}px" data-tip="${esc(tip)}"${tag === "a" ? ` href="${items[0].href}"` : ""}>${items[0].icon}${items.length > 1 ? `<b>${items.length}</b>` : ""}</${tag}>`;
    }).join("");
    if (html !== box._html) { box.innerHTML = html; box._html = html; }
  }
  function bindMarks(u, s) {
    const box = u._tb?.marks;
    if (!box) return;
    const groupOf = (e) => { const el = e.target.closest?.("[data-mark-group]"); return el ? [el, u._tb.markGroups?.[+el.dataset.markGroup]] : [null, null]; };
    box.addEventListener("mouseover", (e) => {
      const [, grp] = groupOf(e);
      if (!grp) return;
      const xs = grp.items.map((m) => m.x);
      g.mark = { band: [Math.min(...xs), Math.max(...xs) + (s.markSpan || 0)], u };
      u.redraw(false);
    });
    box.addEventListener("mouseout", (e) => {
      if (!e.target.closest?.("[data-mark-group]") || e.relatedTarget?.closest?.("[data-mark-group]")) return;
      if (g.mark?.band) { g.mark = null; u.redraw(false); }
    });
    box.addEventListener("click", (e) => {
      const [el, grp] = groupOf(e);
      if (!grp || !s.onMarks) return;
      e.preventDefault();
      s.onMarks(grp.items, el);
    });
  }

  function placeTags(u, s) {
    const box = u._tb?.tags;
    if (!box || !s.tags) return;
    const items = [...box.querySelectorAll("[data-tag]")];
    // the column is as wide as the widest pill (no empty strip on the right)
    box.style.width = `${Math.ceil(Math.max(0, ...items.map((el) => el.offsetWidth)))}px`;
    const off = u.over.getBoundingClientRect().top - box.getBoundingClientRect().top;
    const h = 32, step = h + 3, lo = 0, hi = box.clientHeight - h;
    const want = items.map((el, k) => {
      const v = s.tags[k].value;
      const y = v == null ? 0 : off + u.valToPos(Math.min(u.scales.y.max, Math.max(u.scales.y.min, v)), "y") - h + 8; // ribbon centre on the value
      return { el, y };
    }).sort((p, q) => p.y - q.y);
    // Pills that would overlap form a cluster centred on their wanted heights: each gives
    // way by the same amount. Clusters that then touch merge; a cluster stays inside the box.
    let clusters = [];
    for (const p of want) {
      clusters.push({ items: [p] });
      for (;;) {
        const c = clusters[clusters.length - 1];
        c.top = c.items.reduce((a, q, k) => a + q.y - k * step, 0) / c.items.length;
        c.top = Math.max(lo, Math.min(hi - (c.items.length - 1) * step, c.top));
        const prev = clusters[clusters.length - 2];
        if (!prev || prev.top + prev.items.length * step <= c.top) break;
        prev.items.push(...c.items); clusters.pop();
      }
    }
    for (const c of clusters) c.items.forEach(({ el }, k) => { el.style.transform = `translateY(${c.top + k * step}px)`; });
  }

  // Sections (interval lines, climbs): each set in g.secs has its own lines (sample indices
  // in `at`) on the charts of its `keys`, and the strip of values above those plots.
  const secOf = (s) => g.secs.find((c) => c.keys.includes(s.key)) || null;
  function hasSec(s) { return Boolean(secOf(s)); }
  const secBounds = (c) => [0, ...c.at, xs().length - 1];
  const isHot = (c, k) => g.secHot?.c === c && g.secHot.k === k;
  // the sample nearest to an x value (x values never decrease)
  const nearestIdx = (v) => {
    const a = xs();
    let lo = 0, hi = a.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; }
    return lo > 0 && Math.abs(a[lo - 1] - v) <= Math.abs(a[lo] - v) ? lo - 1 : lo;
  };
  function drawSections(u, s) {
    const c = secOf(s);
    if (!c) return;
    const ctx = u.ctx, { left, top, width, height } = u.bbox, dpr = devicePixelRatio || 1;
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
    ctx.strokeStyle = cssVar("--muted") || "#8a8f98"; ctx.globalAlpha = 0.6; ctx.lineWidth = dpr;
    for (const i of c.at) {
      const px = Math.round(u.valToPos(xs()[i], "x", true)) + 0.5;
      ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, top + height); ctx.stroke();
    }
    ctx.restore();
  }
  function placeSections(u, s) {
    const b = u._tb?.sec, c = secOf(s);
    if (!b || !c) return;
    const ci = g.secs.indexOf(c);
    const w = u.over.clientWidth, off = u.over.offsetLeft, px = (i) => u.valToPos(xs()[i], "x");
    // the centre of the canvas line (drawn at a whole device pixel + 0.5) in CSS px of the plot
    const dpr = devicePixelRatio || 1;
    const lx = (i) => (Math.round(u.valToPos(xs()[i], "x", true)) + 0.5 - u.bbox.left) / dpr;
    const bd = secBounds(c);
    const ext = Math.max(0, u.over.getBoundingClientRect().top - b.strip.getBoundingClientRect().bottom);
    b.cells.innerHTML = bd.slice(1).map((i1, k) => {
      const i0 = bd[k], x0 = Math.max(0, px(i0)), x1 = Math.min(w, px(i1));
      if (x1 - x0 < 1) return "";
      const lines = x1 - x0 >= 34 ? c.label(s.key, i0, i1) : [];
      return `<div class="sec-cell" style="left:${off + x0}px;width:${x1 - x0}px">${lines.map(([t, col]) =>
        `<span${col ? ` style="color:${col}"` : ` class="sub"`}>${t}</span>`).join("")}</div>`;
    }).join("") + c.at.map((i, k) => {
      const x0 = lx(i);
      // the line in the strip runs on down to the plot's top edge (one unbroken line)
      return x0 < 0 || x0 > w ? "" : `<span class="sec-line${isHot(c, k) ? " hot" : ""}" data-c="${ci}" data-k="${k}" style="left:${off + x0}px;bottom:${-ext}px"></span>
        <span class="sec-ball sec-del" data-k="${k}" style="left:${off + x0}px">−</span>`;
    }).join("");
    // grab handles over the lines (kept while dragging: only moved)
    const hs = b.handles;
    if (hs.children.length !== c.at.length) hs.innerHTML = c.at.map((_, k) => `<div class="sec-handle" data-c="${ci}" data-k="${k}"><i></i></div>`).join("");
    [...hs.children].forEach((h, k) => { const x0 = lx(c.at[k]); h.style.left = `${x0}px`; h.hidden = x0 < 0 || x0 > w; });
  }
  const redrawSections = () => g.plots.forEach(({ u }) => u.redraw(false));
  const sectionsChanged = (c) => { redrawSections(); c.onChange?.([...c.at]); };
  function bindSections(u, el, c) {
    const strip = el.querySelector(".chart-sections"), add = strip.querySelector(".sec-add");
    const handles = Object.assign(document.createElement("div"), { className: "sec-handles" });
    const ci = g.secs.indexOf(c);
    u.over.appendChild(handles);
    u._tb.sec = { cells: strip.querySelector(".sec-cells"), handles, strip };
    // the hovered (or dragged) line lights up in every chart of its set, its strip part too
    const hot = (k) => {
      g.secHot = k == null ? null : { c, k };
      const on = (x) => k != null && Number(x.dataset.c) === ci && Number(x.dataset.k) === k;
      root.querySelectorAll(".sec-line").forEach((l) => l.classList.toggle("hot", on(l)));
      root.querySelectorAll(".sec-handle").forEach((h) => h.classList.toggle("hot", on(h)));
    };
    handles.addEventListener("mouseover", (e) => { const h = e.target.closest(".sec-handle"); if (h) hot(Number(h.dataset.k)); });
    handles.addEventListener("mouseout", (e) => { if (e.target.closest(".sec-handle") && !root.classList.contains("sec-dragging")) hot(null); });
    // a line is dragged, not a zoom or a pin
    handles.addEventListener("mousedown", (e) => e.stopPropagation());
    handles.addEventListener("click", (e) => e.stopPropagation());
    handles.addEventListener("pointerdown", (e) => {
      const h = e.target.closest(".sec-handle");
      if (!h) return;
      e.preventDefault(); e.stopPropagation();
      const k = Number(h.dataset.k);
      h.setPointerCapture(e.pointerId);
      h.classList.add("drag"); root.classList.add("sec-dragging");
      const move = (ev) => {
        const r = u.over.getBoundingClientRect();
        const lo = (c.at[k - 1] ?? 0) + 1, hi = (c.at[k + 1] ?? xs().length - 1) - 1;
        const i = Math.max(lo, Math.min(hi, nearestIdx(u.posToVal(ev.clientX - r.left, "x"))));
        if (i !== c.at[k]) { c.at[k] = i; redrawSections(); }
      };
      const up = () => {
        h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", up); h.removeEventListener("pointercancel", up);
        h.classList.remove("drag"); root.classList.remove("sec-dragging");
        if (!h.matches(":hover")) hot(null);
        sectionsChanged(c);
      };
      h.addEventListener("pointermove", move); h.addEventListener("pointerup", up); h.addEventListener("pointercancel", up);
    });
    // the strip: − over each line, + under the pointer elsewhere
    let addAt = null;
    strip.addEventListener("mousemove", (e) => {
      const r = u.over.getBoundingClientRect(), px = e.clientX - r.left;
      const near = c.at.some((i) => Math.abs(u.valToPos(xs()[i], "x") - px) < 12);
      const i = nearestIdx(u.posToVal(px, "x"));
      addAt = !near && px >= 0 && px <= u.over.clientWidth && i > 0 && i < xs().length - 1 ? i : null;
      add.hidden = addAt == null;
      if (addAt != null) add.style.left = `${u.over.offsetLeft + px}px`;
    });
    strip.addEventListener("mouseleave", () => { add.hidden = true; addAt = null; });
    strip.addEventListener("click", (e) => {
      const del = e.target.closest(".sec-del");
      if (del) c.at.splice(Number(del.dataset.k), 1);
      else if (addAt != null && !c.at.includes(addAt)) { c.at.push(addAt); c.at.sort((p, q) => p - q); }
      else return;
      add.hidden = true; addAt = null;
      sectionsChanged(c);
    });
  }

  // Climbs on a chart (s.climbs = { items: [{ i0, i1 }], label(i0, i1) => { lines: [[text, colour |
  // null]], color }, onChange() }): the stretch of the line drawn thicker in the climb's colour,
  // its values in a small tag above it. Hovering a climb shows a circle at its start and end;
  // dragging one changes the climb's range (the tag recomputes).
  function drawClimbs(u, s) {
    if (!s.climbs?.items.length) return;
    const ctx = u.ctx, { left, top, width, height } = u.bbox, dpr = devicePixelRatio || 1;
    const X = (i) => u.valToPos(xs()[i], "x", true), Y = (v) => u.valToPos(v, "y", true);
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    for (const c of s.climbs.items) {
      const base = s.climbs.label(c.i0, c.i1).color || s.color, colorAt = s.climbs.colorAt;
      ctx.lineWidth = (g.climbHot?.c === c ? 5 : 3.5) * dpr;
      // one path per run of the same colour (colorAt: each value its own colour, e.g. its zone)
      let col = null, prev = null;
      for (let i = c.i0; i <= c.i1; i++) {
        const v = s.values[i];
        if (v == null) continue;
        const ci = colorAt ? colorAt(v) || base : base;
        if (ci !== col) {
          if (col) ctx.stroke();
          ctx.strokeStyle = col = ci; ctx.beginPath();
          if (prev != null) ctx.moveTo(X(prev), Y(s.values[prev]));
        }
        ctx.lineTo(X(i), Y(v));
        prev = i;
      }
      if (col) ctx.stroke();
    }
    ctx.restore();
  }
  function placeClimbs(u, s) {
    const b = u._tb?.climbs;
    if (!b) return;
    const w = u.over.clientWidth, X = (i) => u.valToPos(xs()[i], "x"), Y = (v) => u.valToPos(v, "y");
    b.tags.innerHTML = s.climbs.items.map((c) => {
      const x0 = X(c.i0), x1 = X(c.i1), xc = (x0 + x1) / 2;
      if (x1 < 0 || x0 > w) return "";
      let hi = -Infinity;
      for (let i = c.i0; i <= c.i1; i++) if (s.values[i] != null && s.values[i] > hi) hi = s.values[i];
      const { lines } = s.climbs.label(c.i0, c.i1);
      if (!lines.length) return ""; // a stretch only drawn thick, no values
      // above the climb's highest point; kept inside the plot at the top
      const y = Math.max(14 * lines.length + 6, Y(hi) - 6);
      return `<div class="climb-tag" style="left:${Math.min(w - 4, Math.max(4, xc))}px;top:${y}px">${lines.map(([t, col]) =>
        `<span${col ? ` style="color:${col}"` : ` class="sub"`}>${t}</span>`).join("")}</div>`;
    }).join("");
    const hot = g.climbHot?.u === u ? g.climbHot.c : null;
    b.ends.forEach((h, k) => {
      h.classList.toggle("on", Boolean(hot));
      if (!hot) return;
      const i = k ? hot.i1 : hot.i0;
      h.style.left = `${X(i)}px`; h.style.top = `${Y(s.values[i] ?? 0)}px`;
      h.style.setProperty("--c", s.climbs.label(hot.i0, hot.i1).color || s.color);
    });
  }
  // the climb under the pointer (10 px of slack at both ends), or null
  function climbAt(u, s, i) {
    if (i == null || !s.climbs) return null;
    const px = u.valToPos(xs()[i], "x"), X = (j) => u.valToPos(xs()[j], "x");
    return s.climbs.items.find((c) => px >= X(c.i0) - 10 && px <= X(c.i1) + 10) || null;
  }
  function hoverClimb(u, s, i) {
    if (!s.climbs || s.climbs.edit === false || g.climbDrag) return;
    // only the chart under the pointer (the others move with it through the cursor sync)
    if (!u.over.matches(":hover")) { if (g.climbHot?.u === u) { g.climbHot = null; g.plots.forEach(({ u: p }) => p.redraw(false)); } return; }
    const c = climbAt(u, s, i);
    if (g.climbHot?.u === u && g.climbHot.c === c) return;
    g.climbHot = c ? { u, c } : null;
    g.plots.forEach(({ u: p }) => p.redraw(false)); // a shared stretch thickens on every chart
  }
  function bindClimbs(u, s) {
    const layer = Object.assign(document.createElement("div"), { className: "climb-layer" });
    const tags = Object.assign(document.createElement("div"), { className: "climb-tags" });
    const ends = [0, 1].map(() => Object.assign(document.createElement("div"), { className: "climb-end" }));
    layer.append(tags, ...ends);
    u.over.appendChild(layer);
    u._tb.climbs = { tags, ends };
    ends.forEach((h, k) => {
      h.addEventListener("mousedown", (e) => e.stopPropagation()); // not a zoom
      h.addEventListener("click", (e) => e.stopPropagation()); // not a pin
      h.addEventListener("pointerdown", (e) => {
        const c = g.climbHot?.c;
        if (!c) return;
        e.preventDefault(); e.stopPropagation();
        h.setPointerCapture(e.pointerId);
        g.climbDrag = true; h.classList.add("drag");
        const items = s.climbs.items, n = xs().length;
        const prev = items.filter((x) => x !== c && x.i1 <= c.i0).reduce((m, x) => Math.max(m, x.i1), 0);
        const next = items.filter((x) => x !== c && x.i0 >= c.i1).reduce((m, x) => Math.min(m, x.i0), n - 1);
        const move = (ev) => {
          const i = nearestIdx(u.posToVal(ev.clientX - u.over.getBoundingClientRect().left, "x"));
          if (k === 0) c.i0 = Math.max(prev, Math.min(c.i1 - 2, i));
          else c.i1 = Math.min(next, Math.max(c.i0 + 2, i));
          g.plots.forEach(({ u: p }) => p.redraw(false)); // a stretch shared by charts moves on all

        };
        const up = () => {
          h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", up); h.removeEventListener("pointercancel", up);
          g.climbDrag = false; h.classList.remove("drag");
          s.climbs.onChange?.();
        };
        h.addEventListener("pointermove", move); h.addEventListener("pointerup", up); h.addEventListener("pointercancel", up);
      });
    });
    u.over.addEventListener("mouseleave", () => { if (!g.climbDrag && g.climbHot?.u === u) { g.climbHot = null; u.redraw(false); } });
  }

  // Road surface (from map data) as a hatched strip along the bottom of one chart.
  function drawSurface(u, s) {
    const sf = g.surface;
    if (!sf || s.key !== sf.key) return;
    const ctx = u.ctx, { left, top, width, height } = u.bbox, dpr = devicePixelRatio || 1, h = SURFACE_STRIP_PX * dpr;
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
    for (const [a, b, kind] of sf.ranges) { // unknown is filtered out in surface()
      const x0 = u.valToPos(xs()[a], "x", true), x1 = u.valToPos(xs()[b], "x", true);
      ctx.fillStyle = surfacePattern(ctx, kind, dpr);
      ctx.fillRect(x0, top + height - h, Math.max(1, x1 - x0), h);
    }
    ctx.strokeStyle = cssVar("--line"); ctx.lineWidth = dpr;
    ctx.beginPath(); ctx.moveTo(left, top + height - h - 0.5); ctx.lineTo(left + width, top + height - h - 0.5); ctx.stroke();
    ctx.restore();
  }
  const surfaceAt = (s, i) => (g.surface && s.key === g.surface.key ? g.surface.ranges.find(([a, b]) => i >= a && i <= b)?.[2] : null);
  // Stretches highlighted from outside the charts (a best effort, a surface kind): band + bold line.
  function drawExt(u, s) {
    if (!g.ext?.length) return;
    const ctx = u.ctx, { left, top, width, height } = u.bbox, dpr = devicePixelRatio || 1;
    const X = (i) => u.valToPos(xs()[i], "x", true), Y = (v) => u.valToPos(v, "y", true);
    const c = cssVar("--accent") || "#2563eb";
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
    for (const [a, b] of g.ext) {
      ctx.fillStyle = c; ctx.globalAlpha = 0.13;
      ctx.fillRect(X(a), top, Math.max(2 * dpr, X(b) - X(a)), height);
      ctx.globalAlpha = 1; ctx.strokeStyle = s.color; ctx.lineWidth = 3.5 * dpr;
      ctx.beginPath();
      for (let i = a; i <= b; i++) if (s.values[i] != null) ctx.lineTo(X(i), Y(s.values[i]));
      ctx.stroke();
    }
    ctx.restore();
  }
  // Workout step targets: a light band between the low and high value, dashed edges.
  function drawTargets(u, s) {
    if (!s.targets?.length) return;
    const ctx = u.ctx, { left, top, width, height } = u.bbox, dpr = devicePixelRatio || 1;
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
    const fg = cssVar("--fg") || "#1b1e25";
    const X = (i) => Math.round(u.valToPos(xs()[i], "x", true)) + 0.5, Y = (v) => Math.round(u.valToPos(v, "y", true)) + 0.5;
    const ts = [...s.targets].sort((p, q) => p.i0 - q.i0);
    for (const t of ts) { // light band per step, the hovered one darker
      ctx.fillStyle = fg; ctx.globalAlpha = u._tgt === t ? 0.1 : 0.04;
      ctx.fillRect(X(t.i0), Y(t.hi), X(t.i1) - X(t.i0), Y(t.lo) - Y(t.hi));
    }
    // The high and the low limit as two continuous lines that step up or down between
    // adjacent steps (a gap without a target breaks them).
    ctx.globalAlpha = 0.6; ctx.strokeStyle = fg; ctx.lineWidth = dpr; ctx.setLineDash([3 * dpr, 2.5 * dpr]);
    for (const key of ["hi", "lo"]) {
      ctx.beginPath();
      ts.forEach((t, k) => {
        const prev = ts[k - 1];
        if (prev && t.i0 - prev.i1 <= 3) ctx.lineTo(X(t.i0), Y(t[key]));
        else ctx.moveTo(X(t.i0), Y(t[key]));
        ctx.lineTo(X(t.i1), Y(t[key]));
      });
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }
  // Hovered stat: the point (max/min), the climbs/descents, or a line at the value (average).
  function drawMark(u, s) {
    const m = g.mark;
    if (!m || m.u !== u) return;
    if (m.s) s = m.s; // a pill's own colour and series
    const ctx = u.ctx, { left, top, width, height } = u.bbox, dpr = devicePixelRatio || 1;
    const X = (i) => u.valToPos(xs()[i], "x", true), Y = (v) => u.valToPos(v, "y", true);
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
    ctx.strokeStyle = ctx.fillStyle = s.color;
    if (m.band) { // a stretch of the x axis (the days an activity icon stands for)
      const c = cssVar("--accent") || s.color;
      const x0 = u.valToPos(m.band[0], "x", true), x1 = Math.max(x0 + 2 * dpr, u.valToPos(m.band[1], "x", true));
      ctx.fillStyle = withAlpha(c, 0.14);
      ctx.fillRect(x0, top, x1 - x0, height);
      ctx.fillStyle = withAlpha(c, 0.6);
      ctx.fillRect(x0, top, dpr, height);
      ctx.fillRect(x1 - dpr, top, dpr, height);
    }
    else if (m.ranges) {
      const c = m.color || s.color;
      for (const [a, b] of m.ranges) {
        ctx.fillStyle = withAlpha(c, 0.2);
        ctx.fillRect(X(a), top, Math.max(2 * dpr, X(b) - X(a)), height);
        ctx.beginPath(); ctx.lineWidth = 3.5 * dpr; ctx.strokeStyle = c;
        for (let i = a; i <= b; i++) if (s.values[i] != null) ctx.lineTo(X(i), Y(s.values[i]));
        ctx.stroke();
      }
    }
    else if (m.y != null) {
      const y = Math.round(Y(m.y)) + 0.5;
      ctx.lineWidth = 1.5 * dpr; ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + width, y); ctx.stroke();
    }
    else if (m.i != null) {
      const x = X(m.i), y = Y(s.values[m.i]);
      ctx.lineWidth = dpr; ctx.setLineDash([3 * dpr, 3 * dpr]); ctx.strokeStyle = withAlpha(s.color, 0.8);
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + height); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(x, y, 12 * dpr, 0, 2 * Math.PI); ctx.fillStyle = withAlpha(s.color, 0.25); ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, 6.5 * dpr, 0, 2 * Math.PI);
      ctx.fillStyle = s.color; ctx.fill(); ctx.lineWidth = 2.5 * dpr; ctx.strokeStyle = cssVar("--surface") || "#fff"; ctx.stroke();
      // the value in a small white label beside the point
      const txt = fmtY(s, s.values[m.i]);
      ctx.font = `600 ${12 * dpr}px Roboto, system-ui, sans-serif`;
      const w = ctx.measureText(txt).width + 12 * dpr, h = 20 * dpr;
      const lx = x + 16 * dpr + w > left + width ? x - 16 * dpr - w : x + 16 * dpr, ly = Math.max(top + 2 * dpr, Math.min(y - h / 2, top + height - h - 2 * dpr));
      ctx.fillStyle = cssVar("--surface") || "#fff"; ctx.shadowColor = "rgba(0,0,0,.18)"; ctx.shadowBlur = 6 * dpr;
      ctx.beginPath(); ctx.roundRect(lx, ly, w, h, 5 * dpr); ctx.fill(); ctx.shadowBlur = 0;
      ctx.fillStyle = s.color; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText(txt, lx + 6 * dpr, ly + h / 2);
    }
    ctx.restore();
  }
  // What a stat refers to, from its mark.
  function markFor(s, mark) {
    const v = s.values;
    if (typeof mark === "number") return { y: mark };
    if (mark?.ranges) return mark;
    if (mark === "max" || mark === "min") {
      let best = null;
      for (let i = 0; i < v.length; i++) if (v[i] != null && (best == null || (mark === "max" ? v[i] > v[best] : v[i] < v[best]))) best = i;
      return { i: best };
    }
    if (mark === "up" || mark === "down") return { ranges: chartSlopes(v, mark === "up" ? 1 : -1) };
    return null;
  }

  function drawPins(u) {
    if (!g.pins.length) return;
    const ctx = u.ctx, { top, height } = u.bbox, dpr = devicePixelRatio || 1;
    ctx.save();
    ctx.strokeStyle = cssVar("--chart-pin") || cssVar("--fg"); ctx.lineWidth = 1.25 * dpr; ctx.setLineDash([4 * dpr, 3 * dpr]);
    for (const p of g.pins) {
      const px = Math.round(u.valToPos(xs()[p], "x", true));
      if (px < u.bbox.left || px > u.bbox.left + u.bbox.width) continue;
      ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, top + height); ctx.stroke();
    }
    ctx.restore();
  }

  // Value flag next to the point, exact x on the x axis, map sync.
  function cursorMoved(u, s) {
    const i = u.cursor.idx, b = u._tb;
    const show = i != null && u.cursor.left >= 0;
    hoverClimb(u, s, show ? i : null);
    b.tip.hidden = b.xflag.hidden = !show;
    if (!show && u._tgt) { u._tgt = null; u.redraw(false); }
    if (!show) {
      if (u === g.plots[0]?.u) { g.hoverIdx = null; onHover(null); }
      return;
    }
    const v = s.values[i];
    const t = s.targets?.find((x) => i >= x.i0 && i <= x.i1) || null;
    const z = zoneOf(s, v);
    b.tip.innerHTML = s.lines?.length
      ? [{ label: s.label, color: s.color, values: s.values }, ...s.lines].map((l) => `<div><span class="chart-tip-name">${l.label}</span> <b style="color:${l.color}">${fmtY(s, l.values[i])}</b></div>`).join("")
      : `<span class="chart-tip-name">${s.label}</span> <b style="color:${colorAt(s, v)}">${fmtY(s, v)}</b>${z?.label ? ` <span class="chart-tip-name">· ${z.label}</span>` : ""}${surfaceAt(s, i) ? `<div class="chart-tip-target"><span class="surface-swatch s-${surfaceAt(s, i)}"></span>${SURFACE_LABEL[surfaceAt(s, i)]}</div>` : ""}${t ? `<div class="chart-tip-target"><span class="chart-tip-swatch"></span>Target ${num(t.lo, s.dec)}–${num(t.hi, s.dec)}${s.unit ? " " + s.unit : ""}${v != null && (v < t.lo || v > t.hi) ? ` <span class="chart-tip-out">${v < t.lo ? "below" : "above"}</span>` : ""}</div>` : ""}`;
    // a stretch under the cursor (s.climbs.tip): its line in the value flag
    const st = s.climbs?.tip && s.climbs.items.find((c) => i >= c.i0 && i <= c.i1);
    if (st) b.tip.insertAdjacentHTML("beforeend", `<div class="chart-tip-target">${s.climbs.tip(st.i0, st.i1, i)}</div>`);
    if (u._tgt !== t) { u._tgt = t; u.redraw(false); }
    const top = v == null ? 0 : u.valToPos(v, "y");
    const left = u.cursor.left, w = u.over.clientWidth;
    b.tip.style.transform = `translate(${left + 12 + 150 > w ? left - 12 - b.tip.offsetWidth : left + 12}px, ${Math.max(0, top - 22)}px)`;
    b.xflag.textContent = fmtX(xs()[i], true);
    b.xflag.style.left = `${u.over.offsetLeft + left}px`;
    b.xflag.style.top = `${u.over.offsetTop + u.over.offsetHeight + 1}px`;
    if (u === g.plots[0]?.u && g.hoverIdx !== i) { g.hoverIdx = i; onHover(i); }
  }

  function addPin(i) {
    if (i == null) return;
    g.pins = g.pins.includes(i) ? g.pins.filter((p) => p !== i) : [...g.pins, i].slice(-4);
    renderPins();
    g.plots.forEach(({ u }) => u.redraw(false));
    showReset(g.pins.length > 0 || g.range != null);
    onState();
  }
  // Pinned values: a small label per chart above each pinned line.
  function renderPins() {
    for (const { u, s } of g.plots) {
      u._tb.pins.innerHTML = g.pins.map((p) => {
        const px = u.valToPos(xs()[p], "x");
        if (px < 0 || px > u.over.clientWidth) return "";
        const vals = [{ color: colorAt(s, s.values[p]), values: s.values }, ...(s.lines || [])]
          .map((l) => `<b style="color:${l.color}">${fmtY(s, l.values[p])}</b>`).join("");
        return `<div class="chart-pin" style="left:${u.over.offsetLeft + px}px"><span>${fmtX(xs()[p], true)}</span>${vals}</div>`;
      }).join("");
    }
  }

  // Animated range change (ease-out, 260 ms) on all charts of the group.
  let anim = null;
  function zoomTo(to) {
    const u0 = g.plots[0]?.u;
    if (!u0) return;
    const from = [u0.scales.x.min, u0.scales.x.max];
    const target = to || [xs()[0], xs()[xs().length - 1]];
    cancelAnimationFrame(anim);
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 260), e = 1 - (1 - k) ** 3;
      g.range = [from[0] + (target[0] - from[0]) * e, from[1] + (target[1] - from[1]) * e];
      g.plots.forEach(({ u }) => u.setScale("x", { min: g.range[0], max: g.range[1] }));
      renderPins();
      if (k < 1) anim = requestAnimationFrame(step);
      else { g.range = to ? target : null; showReset(g.pins.length > 0 || g.range != null); onState(); }
    };
    anim = requestAnimationFrame(step);
  }

  function build() {
    g.plots.forEach(({ u }) => u.destroy());
    g.plots = [];
    g.yw = {};
    root.innerHTML = "";
    for (const s of series) {
      // colours for the current theme, always from the original ones (theme switches rebuild)
      s._color ??= s.color; s.color = muteDark(s._color);
      (s.lines || []).forEach((l) => { l._color ??= l.color; l.color = muteDark(l._color); });
      (s.zones || []).forEach((z) => { z._color ??= z.color; z.color = muteDark(z._color); });
      const el = block(s);
      root.appendChild(el);
      const holder = el.querySelector(".chart-plot");
      const u = new uPlot(opts(s, holder.clientWidth || 600), [xs(), s.values, ...(s.lines || []).map((l) => l.values)], holder);
      const tip = Object.assign(document.createElement("div"), { className: "chart-tip", hidden: true });
      const xflag = Object.assign(document.createElement("div"), { className: "chart-xflag", hidden: true });
      const pins = Object.assign(document.createElement("div"), { className: "chart-pins" });
      u.over.appendChild(tip);
      u.root.appendChild(xflag); u.root.appendChild(pins);
      u._tb = { tip, xflag, pins, tags: s.tags ? el.querySelector(".chart-tags") : null, marks: el.querySelector(".chart-marks") };
      if (s.marks) bindMarks(u, s);
      if (hasSec(s)) { bindSections(u, el, secOf(s)); placeSections(u, s); }
      if (s.climbs) { bindClimbs(u, s); placeClimbs(u, s); }
      // Reset: a refresh pictogram in the plot's top right corner, only when needed.
      const reset = Object.assign(document.createElement("button"), { className: "chart-reset", hidden: true, title: "Reset zoom and pins" });
      reset.dataset.chartReset = "";
      reset.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>`;
      u.root.appendChild(reset);
      draggable(el);
      // Grip on the card's bottom edge: drag up / down to change the chart height (this visit).
      cardResize(el, () => u.height, (h) => { s.height = h; u.setSize({ width: u.width, height: h }); renderPins(); placeTags(u, s); }, 120, 640);
      // The horizontal crosshair line only in the hovered chart.
      u.over.addEventListener("mouseenter", () => holder.classList.add("hot"));
      u.over.addEventListener("mouseleave", () => holder.classList.remove("hot"));
      u.over.addEventListener("click", () => { if (g.dragged) { g.dragged = false; return; } addPin(u.cursor.idx); });
      reset.onclick = () => api.reset();
      el.querySelectorAll("[data-stat]").forEach((st) => {
        st.onmouseenter = () => {
          const m = markFor(s, s.stats[st.dataset.stat][2]);
          if (!m) return;
          const prev = g.mark?.u;
          g.mark = { ...m, u }; st.classList.add("on"); u.redraw(false);
          if (prev && prev !== u) prev.redraw(false);
          if (m.i != null) onHover(m.i); // a point is shown on the map too
          if (m.ranges?.length) onRanges(m.ranges); // and stretches (best 20 min, climbs, above Z2…)
        };
        st.onmouseleave = () => { g.mark = null; st.classList.remove("on"); u.redraw(false); onHover(null); onRanges(null); };
      });
      // A value pill highlights its point (current value, max, min) in its own colour.
      el.querySelectorAll("[data-tag]").forEach((st) => {
        const t = s.tags[st.dataset.tag];
        st.onmouseenter = () => {
          if (t.i == null || t.mark === false) return; // a latest value: its point is the line's end, next to the pill
          const vals = t.values || s.values;
          g.mark = { i: t.i, u, s: { ...s, color: t.color, values: vals } }; st.classList.add("on"); u.redraw(false);
        };
        st.onmouseleave = () => { g.mark = null; st.classList.remove("on"); u.redraw(false); };
      });
      g.plots.push({ u, s, el });
      placeTags(u, s);
      ro.observe(holder); // the plot area changes when the pill column takes its width
    }
    if (g.range) g.plots.forEach(({ u }) => u.setScale("x", { min: g.range[0], max: g.range[1] }));
    renderPins();
    fitSide();
    alignAxes();
  }
  // Charts built before the widest y axis was known take its width now.
  function alignAxes() {
    const w = Math.max(0, ...Object.values(g.yw));
    g.plots.forEach(({ u }) => { if (Math.abs((u.axes[1]._size || 0) - w) > 0.5) u.setSize({ width: u.width, height: u.height }); });
  }
  // The side column of every chart in the group is as wide as the widest stat or legend
  // (one width for all, so the charts stay equally wide, without empty space beside the pills).
  function fitSide() {
    let w = 0;
    root.querySelectorAll(".chart-stats:not(.chart-tags)").forEach((st) => {
      for (const c of st.children) w = Math.max(w, c.getBoundingClientRect().width);
    });
    if (w) root.style.setProperty("--side-w", `${Math.ceil(w) + 2}px`);
    requestAnimationFrame(() => {
      g.plots.forEach(fit); // plots take the freed width
      // a chart with many stats grows so its pills never stick out of the card
      g.plots.forEach(({ u, s, el }) => {
        const st = el.querySelector(".chart-stats:not(.chart-tags)"), fr = el.querySelector(".chart-frame");
        if (!st || !fr || getComputedStyle(st).flexDirection === "row") return;
        const extra = st.scrollHeight - fr.offsetHeight;
        if (extra > 0) { s.height = u.height + extra; u.setSize({ width: u.width, height: s.height }); renderPins(); }
      });
    });
  }

  const fit = ({ u, s, el }) => {
    const w = el.querySelector(".chart-plot").clientWidth;
    if (w && Math.abs(w - u.width) > 2) {
      u.setSize({ width: w, height: s.height || CHART_H }); renderPins();
    }
  };
  const ro = new ResizeObserver(() => g.plots.forEach(fit));
  // Light / dark switched: build again with the new colours (pins and zoom are kept).
  const themeWatch = new MutationObserver(() => {
    if (!root.isConnected) { themeWatch.disconnect(); return; }
    build();
    requestAnimationFrame(renderPins); // pin labels need the new plots laid out
  });
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  ro.observe(root);
  build();

  const api = {
    get changed() { return g.pins.length > 0 || g.range != null; },
    setKind(k) { if (k === g.kind) return; g.kind = k; g.range = null; g.pins = []; fade(build); },
    setSeries(list) { series = list; fade(build); },
    // Show or hide the icon strip of the charts that have one.
    showMarks(on) { g.plots.forEach(({ u, s, el }) => { const m = el.querySelector(".chart-marks"); if (m) { m.hidden = !on; s.marksHidden = !on; placeMarks(u, s); } }); },
    // Show or hide one chart; the others stay as they are (no rebuild, no fade).
    show(key, on) {
      if (on) g.hidden.delete(key); else g.hidden.add(key);
      const p = g.plots.find((x) => x.s.key === key);
      if (!p) return;
      p.el.hidden = !on;
      if (on) { fit(p); p.u.redraw(false); placeTags(p.u, p.s); }
    },
    reset() { g.pins = []; renderPins(); g.plots.forEach(({ u }) => u.redraw(false)); zoomTo(null); showReset(false); },
    // Highlight samples i0..i1 on all charts (null clears).
    // Highlight stretches [[i0, i1], …] on all charts (null clears).
    highlight(ranges) { g.ext = ranges; g.plots.forEach(({ u }) => u.redraw(false)); },
    // Road surface on the chart `key` (falls back to the first chart): ranges [[i0, i1, kind]].
    // Unknown stretches are not drawn. The kinds are pills in the side column (share of the
    // distance); hovering one calls onKind(kind | null) to highlight it on the charts and map.
    surface(key, ranges, shares = {}, onKind = () => {}) {
      const p = g.plots.find((x) => x.s.key === key) || g.plots[0];
      if (!p) return;
      g.surface = { key: p.s.key, ranges: ranges.filter((r) => r[2] !== "unknown") };
      p.el.querySelectorAll(".surface-stat").forEach((x) => x.remove());
      const total = Object.values(shares).reduce((x, y) => x + y, 0) || 1;
      const kinds = SURFACE_KINDS.filter((k) => k !== "unknown" && shares[k]);
      p.el.querySelector(".chart-stats").insertAdjacentHTML("beforeend", kinds.map((k) =>
        `<div class="chart-stat surface-stat" data-surface="${k}" data-tip="${SURFACE_LABEL[k]} road (OpenStreetMap): ${num(shares[k] / 1000, 2)} km">
          <span class="chart-stat-label">${SURFACE_LABEL[k]}</span><span class="chart-ribbon s-${k}" style="--c:${SURFACE_COLOR[k]}">${num((shares[k] / total) * 100)}%</span></div>`).join(""));
      p.el.querySelectorAll(".surface-stat").forEach((el) => {
        el.onmouseenter = () => { el.classList.add("on"); onKind(el.dataset.surface); };
        el.onmouseleave = () => { el.classList.remove("on"); onKind(null); };
      });
      fitSide();
      p.u.setData(p.u.data); // y range again: room for the strip under the line (x keeps g.range)
    },
    // Show sample i on all charts (e.g. hovered on the map); null hides it.
    hover(i) {
      const p = g.plots[0];
      if (!p) return;
      p.u.setCursor(i == null ? { left: -10, top: -10 } : { left: p.u.valToPos(xs()[i], "x"), top: -10 });
    },
    destroy() { ro.disconnect(); themeWatch.disconnect(); g.plots.forEach(({ u }) => u.destroy()); },
  };
  return api;
  // Drag a chart card (anywhere but the plot and its stats) to change the order of the charts.
  function draggable(el) {
    el.addEventListener("mousedown", (e) => { el.draggable = !e.target.closest(".u-over, .chart-stat, button"); });
    el.addEventListener("dragstart", (e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", el.dataset.key); root._drag = el; el.classList.add("dragging"); });
    el.addEventListener("dragend", () => {
      el.classList.remove("dragging"); el.draggable = false; root._drag = null;
      const order = [...root.querySelectorAll(".chart-block")].map((b) => b.dataset.key);
      series = order.map((k) => series.find((x) => x.key === k)).filter(Boolean);
      onOrder(order);
    });
    el.addEventListener("dragover", (e) => {
      const d = root._drag;
      if (!d || d === el) return;
      e.preventDefault();
      const r = el.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
      if (after ? el.nextElementSibling !== d : el.previousElementSibling !== d) el.parentNode.insertBefore(d, after ? el.nextElementSibling : el);
    });
  }
  // Reset sits in each chart's top right corner, only when there is something to reset.
  function showReset(on) { root.querySelectorAll("[data-chart-reset]").forEach((b) => { b.hidden = !on; }); }
  function fade(fn) { root.classList.add("chart-fade"); setTimeout(() => { fn(); root.classList.remove("chart-fade"); onState(); }, 150); }
}

const SURFACE_STRIP_PX = 9; // height of the road surface strip at the bottom of a chart
// Road surface kinds: the same hatching on the chart strip, the legend and the shares bar.
const SURFACE_KINDS = ["paved", "gravel", "dirt", "unknown"];
const SURFACE_LABEL = { paved: "Paved", gravel: "Gravel", dirt: "Dirt", unknown: "Unknown" };
const SURFACE_COLOR = { paved: "#6b7280", gravel: "#c08a2e", dirt: "#8b5a2b", unknown: "#b8bec7" }; // pills, map
const surfacePatterns = {};
function surfacePattern(ctx, kind, dpr) {
  const key = `${kind}:${dpr}`;
  if (surfacePatterns[key]) return surfacePatterns[key];
  const n = Math.round(6 * dpr), c = Object.assign(document.createElement("canvas"), { width: n, height: n }), x = c.getContext("2d");
  const fill = { paved: "#6b7280", gravel: "#f1e4c8", dirt: "#ecdcc8", unknown: "#dfe2e7" }[kind] || "#dfe2e7";
  x.fillStyle = fill; x.fillRect(0, 0, n, n);
  if (kind === "gravel") { x.fillStyle = "#a8782a"; x.beginPath(); x.arc(n / 2, n / 2, 1.1 * dpr, 0, 7); x.fill(); }
  if (kind === "dirt") { x.strokeStyle = "#8b5a2b"; x.lineWidth = 1.3 * dpr; x.beginPath(); x.moveTo(0, n); x.lineTo(n, 0); x.moveTo(-1, 1); x.lineTo(1, -1); x.moveTo(n - 1, n + 1); x.lineTo(n + 1, n - 1); x.stroke(); }
  return (surfacePatterns[key] = ctx.createPattern(c, "repeat"));
}

// A very light grip on a card's bottom edge (right side): dragging it up or down changes the
// height of the card's content - get() the current height, set(h) applies it.
function cardResize(card, get, set, min, max) {
  const grip = Object.assign(document.createElement("div"), { className: "card-resize", title: "Drag to change the height" });
  card.appendChild(grip);
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault(); e.stopPropagation();
    const y0 = e.clientY, h0 = get();
    grip.setPointerCapture(e.pointerId);
    card.classList.add("resizing");
    const move = (ev) => set(Math.round(Math.min(max, Math.max(min, h0 + ev.clientY - y0))));
    const up = () => { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); card.classList.remove("resizing"); };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });
  grip.addEventListener("mousedown", (e) => e.stopPropagation()); // not a card drag (reorder)
}

// Full name of a short stat label for its tooltip: "Avg" on the power chart → "Average power".
const STAT_WORDS = { Avg: "Average", Max: "Maximum", Min: "Minimum" };
const statTip = (label, s) => (STAT_WORDS[label] ? `${STAT_WORDS[label]} ${s.label.toLowerCase()}` : label);

// Duration curve (best average over 5 s … 1 h) as a chart of the standard: framed plot,
// axis titles, dense ticks, dashed grid, crosshair with a value flag, filled series (this
// activity and the comparison). points: [{ key (s), value, compare, compareDate, start_s, end_s }].
// onHover(point | null) for the charts and the map.
function curveChart(root, { points, color, unit, label, compareLabel, onHover = () => {} }) {
  const pts = points.filter((p) => p.value != null).sort((p, q) => p.key - q.key);
  if (pts.length < 2) return null;
  color = muteDark(color); // dark theme: calmer colour and weaker fills, like the activity charts
  const dl = (s) => (s < 60 ? `${s}s` : s < 3600 ? `${s / 60}m` : `${num(s / 3600, s % 3600 ? 1 : 0)}h`);
  const full = (s) => (s < 60 ? `${s} s` : s < 3600 ? `${s / 60} min` : `${num(s / 3600, s % 3600 ? 1 : 0)} h`);
  root.innerHTML = `<div class="chart-frame curve-frame">
      <div class="chart-ylabel"><span>${label} (${unit})</span></div><div class="chart-plot"></div>
      <div class="chart-xlabel" data-tip="How long the average was held.">Duration</div></div>`;
  const holder = root.querySelector(".chart-plot");
  const muted = cssVar("--muted"), line = cssVar("--line"), grey = muted || "#8a8f98";
  const grad = (c, a0) => (u) => {
    const gr = u.ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height);
    gr.addColorStop(0, withAlpha(c, fillAlpha(a0))); gr.addColorStop(1, withAlpha(c, 0.03));
    return gr;
  };
  const tip = Object.assign(document.createElement("div"), { className: "chart-tip", hidden: true });
  const u = new uPlot({
    width: holder.clientWidth || 300, height: Math.max(140, holder.clientHeight || 150), padding: [8, 6, 0, 0], legend: { show: false },
    scales: { x: { time: false, range: (uu, mn, mx) => [mn, mx] } }, // durations evenly spaced, each labelled
    cursor: { drag: { x: false, y: false }, points: { size: 9, width: 2, stroke: cssVar("--surface") || "#fff", fill: (uu, si) => (si === 1 ? color : grey) } },
    series: [{},
      { label: "This activity", stroke: color, width: 2.2, fill: grad(color, 0.42), points: { show: false } },
      { label: compareLabel, stroke: withAlpha(grey.startsWith("#") ? grey : "#8a8f98", 0.9), width: 1.4, dash: [5, 4], fill: grad(grey.startsWith("#") ? grey : "#8a8f98", 0.16), points: { show: false }, spanGaps: true }],
    axes: [
      { font: CHART_FONT, stroke: muted, size: 18, gap: 2, splits: () => pts.map((p, k) => k),
        values: (uu, vals) => vals.map((v) => (pts[v] ? dl(pts[v].key) : "")), border: { show: true, stroke: line, width: 1 }, grid: { show: false }, ticks: { stroke: line, size: 3, width: 1 } },
      { font: CHART_FONT, stroke: muted, space: 20, gap: 2, size: (uu, vals) => (vals ? Math.max(...vals.map((v) => String(v).length)) * 6.4 + 8 : 24),
        border: { show: true, stroke: line, width: 1 }, grid: { stroke: line, width: 0.6, dash: [2, 3] }, ticks: { stroke: line, size: 3, width: 1 },
        values: (uu, vals) => vals.map((v) => num(v)) },
    ],
    hooks: {
      draw: [(uu) => { // frame on all four sides
        const { left, top, width, height } = uu.bbox, dpr = devicePixelRatio || 1;
        uu.ctx.save(); uu.ctx.setLineDash([]); uu.ctx.strokeStyle = line; uu.ctx.lineWidth = dpr;
        uu.ctx.strokeRect(Math.round(left) + 0.5, Math.round(top) + 0.5, Math.round(width) - 1, Math.round(height) - 1); uu.ctx.restore();
      }],
      setCursor: [(uu) => {
        const i = uu.cursor.idx, show = i != null && uu.cursor.left >= 0;
        tip.hidden = !show;
        onHover(show ? pts[i] : null);
        if (!show) return;
        const p = pts[i];
        tip.innerHTML = `<div class="chart-tip-name">Best ${full(p.key)}</div><div><b style="color:${color}">${num(p.value)} ${unit}</b> <span class="chart-tip-name">this activity</span></div>
          ${p.compare != null ? `<div><b>${num(p.compare)} ${unit}</b> <span class="chart-tip-name">${compareLabel.toLowerCase()}</span></div>` : ""}
          ${p.compare != null && p.compareDate ? `<div class="chart-tip-name">${p.compareDate}</div>` : ""}`;
        const left = uu.cursor.left, w = uu.over.clientWidth;
        tip.style.transform = `translate(${left + 12 + 140 > w ? left - 12 - tip.offsetWidth : left + 12}px, 4px)`;
      }],
    },
  }, [pts.map((p, k) => k), pts.map((p) => p.value), pts.map((p) => p.compare ?? null)], holder);
  u.over.appendChild(tip);
  holder.addEventListener("mouseenter", () => holder.classList.add("hot"));
  holder.addEventListener("mouseleave", () => holder.classList.remove("hot"));
  // The chart fills its box (the tile's height comes from the tiles beside it).
  const ro = new ResizeObserver(() => {
    const w = holder.clientWidth, h = Math.max(140, holder.clientHeight);
    if (w && (Math.abs(w - u.width) > 2 || Math.abs(h - u.height) > 2)) u.setSize({ width: w, height: h });
  });
  ro.observe(holder);
  return { destroy() { ro.disconnect(); u.destroy(); } };
}

// Turning points of a series, ignoring wiggles under th units (3 m of altitude).
function chartPivots(v, th = 3) {
  const idx = v.map((x, i) => (x == null ? -1 : i)).filter((i) => i >= 0);
  if (idx.length < 2) return [];
  const piv = [idx[0]];
  let trend = 0, ext = idx[0];
  for (const i of idx) {
    if (trend === 0) { if (Math.abs(v[i] - v[ext]) >= th) { trend = Math.sign(v[i] - v[ext]); ext = i; } }
    else if (trend * (v[i] - v[ext]) >= 0) ext = i;
    else if (trend * (v[ext] - v[i]) >= th) { piv.push(ext); trend = -trend; ext = i; }
  }
  piv.push(ext);
  return piv;
}

// Climbs of an altitude series over distance d (km): [{ i0, i1, len (km), gain (m), grade (%) }].
// A climb runs from a low point to its highest point. Dips on the way are part of it while
// each dip is at most 25 % as long as the rise just before it (since the previous dip) and
// loses at most a third of the height gained so far; a longer or deeper dip ends the climb.
// Kept: at least 20 m of gain over at least 50 m.
function chartClimbs(v, d, { dipShare = 0.25, dipDrop = 1 / 3, minGain = 20, minLen = 0.05 } = {}) {
  const piv = chartPivots(v), out = [];
  let cur = null;
  const close = () => {
    if (!cur) return;
    const len = d[cur.i1] - d[cur.i0], gain = v[cur.i1] - v[cur.i0];
    if (gain >= minGain && len >= minLen) out.push({ i0: cur.i0, i1: cur.i1, len, gain, grade: (gain / (len * 1000)) * 100 });
    cur = null;
  };
  for (let k = 1; k < piv.length; k++) {
    const a = piv[k - 1], b = piv[k], len = d[b] - d[a];
    if (v[b] > v[a]) {
      if (!cur) cur = { i0: a, i1: b, rise: len };
      else { cur.rise = len; if (v[b] > v[cur.i1]) cur.i1 = b; }
    }
    else if (!cur || len > dipShare * cur.rise || v[a] - v[b] > dipDrop * (v[cur.i1] - v[cur.i0])) close();
  }
  close();
  return out;
}

// Climbs (dir 1) or descents (-1) of a series: [i0, i1] runs between turning points,
// ignoring wiggles under th units (3 m of altitude).
function chartSlopes(v, dir, th = 3) {
  const piv = chartPivots(v, th);
  const out = [];
  for (let k = 1; k < piv.length; k++) if (dir * (v[piv[k]] - v[piv[k - 1]]) > 0) out.push([piv[k - 1], piv[k]]);
  return out;
}

// Explanations on hover for any element with data-tip (chart titles, axis titles…).
(() => {
  const tip = Object.assign(document.createElement("div"), { className: "tb-tip", hidden: true });
  document.addEventListener("DOMContentLoaded", () => document.body.appendChild(tip));
  document.addEventListener("mouseover", (e) => {
    const t = e.target.closest?.("[data-tip], [data-tip-html]");
    if (!t || !(t.dataset.tip || t.dataset.tipHtml)) { tip.hidden = true; return; }
    // data-tip: plain text; data-tip-html: built by the app (bold parts), never user text
    if (t.dataset.tipHtml) tip.innerHTML = t.dataset.tipHtml; else tip.textContent = t.dataset.tip;
    tip.hidden = false;
    const r = t.getBoundingClientRect();
    tip.style.left = `${Math.min(innerWidth - 290, Math.max(8, r.left))}px`;
    tip.style.top = `${r.bottom + 6}px`;
  });
})();
