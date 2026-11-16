# Trailbook — chart standard

One pattern for every chart in the app (`static/charts.js`, `chartGroup()`), built on uPlot
(`static/vendor/uPlot.*`, MIT) with the Roboto font (`static/vendor/fonts`, Apache 2.0), both
served locally. Local variations are allowed; the base stays the same.

1. **Card and frame** — every chart has its own card (title in the card-title font, with the
   series icon); the card is the chart's outer frame, there is no second frame inside it.
   The plot area is framed on all four sides in the light `--line` colour (the axes included).
2. **Axis titles with units** on both axes, e.g. "Heart rate (bpm)", "Distance (km)", set
   right next to the tick labels (no empty strip).  Numbers use a decimal comma. Hovering a chart title or an axis title shows an explanation of
   the value. Only an obvious axis (months) has no title.
3. **Both axes numbered**, fairly densely (x every ~46 px, y every ~22 px).
4. **Grid**: horizontal only, fine and dashed.
5. **Crosshair**: solid lines. The vertical line runs through all charts of the group; the
   horizontal one only in the hovered chart. Where the vertical line meets a series: an
   animated dot and a flag with the series name and the value (value in the series colour).
6. **Right of the chart** (when the page is wide): a legend only when a chart has several
   series. A single-series chart shows its stats there instead (Avg, Max…): a small label
   above a ribbon in the series colour with the value in white, always in one narrow column
   (never two rows or columns of chips). The side column has one fixed width (112 px), so
   every chart of a page is exactly as wide as the others. Labels stay short (Avg, Max, NP,
   Steepest climb); the tooltip gives the full name and any detail ("Average power",
   "Steepest climb: 3,4 % average over 4,07 km, +140 m"). Hovering a stat highlights
   what makes it on the chart: the point (max, min — also shown on the map), the climbs or
   descents (ascent, descent), or a dashed line at the value (averages).
7. **Exact x value on the x axis** at the vertical line, over the tick labels (white flag):
   full date, exact time or the distance with two decimals. Distance is shown with **two
   decimals everywhere in the app**.
8. **Title and controls**: the card title on the left; controls as badges in the page header
   ("Charts: 5 of 12", "Options" with the X axis and other chart settings); **Reset** is a refresh pictogram in the top
   right corner of the plot area. Dragging a chart card (its title or margin, not the plot)
   changes the order of the charts.
9. **Font**: Roboto.
10. **Colours** (light and dark): grid, frame and pin lines use the theme tokens `--chart-grid`,
    `--chart-frame`, `--chart-pin` (soft in dark mode, pins clearly visible); switching the theme
    rebuilds the charts with the new colours, keeping pins and zoom. Zone bands are a very light
    wash of pastel zone colours.
    **Series**: pastel series colours from the metric groups; a single series is filled with
    the same colour (gradient to transparent). Series have a soft shadow.
11. **Motion and interaction**:
    - the cursor dot pulses;
    - **click** pins a value (dashed line + label with the value on every chart; up to 4;
      click the same point again to remove it), so two points can be compared;
    - **drag** left → right selects an x range and zooms all charts to it;
    - range changes are animated (ease-out ~260 ms); changing the x axis or the chart list fades;
    - **Reset** appears in each chart's top right corner only when there is something to
      reset (pins, zoom) and restores the original state of all charts;
    - a very light grip on the card's bottom edge (right) changes the chart height by dragging
      up / down (120–640 px; this visit only, not saved); the route map has the same grip;
    - tick labels take their decimals from the tick step (0,5 km steps → one decimal);
    - on the route map a change of colouring fades out and in.

## Activity page

Charts sit right below the route map. Every stream the FIT file has can be shown (watch and
activity dependent): heart rate, speed, power, cadence, altitude, respiration, temperature,
running dynamics (ground contact time, step length, vertical oscillation and ratio), pedal
metrics (platform centre offset, smoothness, torque effectiveness, left and right),
performance condition, stamina and potential stamina. Streams without data are not listed.

- **Charts** badge (page header): a checkbox list of the available charts. Visible by default: heart rate,
  speed, altitude; power and cadence on rides. The user's choice is saved per person on the
  server (`ui_settings` key `activity-charts`).
- Chart order: drag a card; saved per person (`ui_settings` key `activity-chart-order`).
- Structured workouts: the target of each workout step (heart rate, power, speed or cadence
  range, as set in the plan) is drawn on that chart over the step's laps: the high and the
  low limit are two continuous fine dashed lines that step up or down where the target
  changes (a stretch without a target breaks them), with a light grey band between them.
  Hovering inside a step darkens its band
  and the value flag also shows the target ("Target 284–405 W", with "below"/"above" when
  the value is outside). An **In target** stat gives the share of the steps' time within the
  range (computed from the stream; the FIT file has no such value); hovering it marks in red
  where the value was outside. Targets given only as a zone number are not shown.
- **Interval sections** (only while the training type is Intervals, detected or chosen; see
  MANUAL › Interval sections): thin grey vertical lines at every work bout's start and end on the
  speed, heart rate, power and cadence charts, and a strip above each of those plots with one
  cell per section (between two lines) — speed: the section's pace (on foot) or speed and its
  time; heart rate: average bpm and the zone; power: average watts and the zone; cadence: the
  average. Heart rate and power: the value and the zone in the zone's colour (Garmin's limits,
  as in the zone tiles); other values in the series colour; the time grey; a cell narrower than ~34 px stays empty. A line can be grabbed
  (a grip shows on hover, the cursor becomes ↔) and dragged between its neighbours. Hovering a
  strip shows a red ball with − over every line (click: remove it) and a blue ball with + under
  the pointer elsewhere (click: add a line there). Every change applies to all those charts at
  once and the cells recompute. Nothing is saved: a new visit, or another training type, starts
  from the detection again (or shows nothing).
- Hovering Max/Min draws a large dot with its value in a small label.
- **Road surface** (from OpenStreetMap, see SPEC): a hatched strip along the bottom of the
  altitude chart (or the first chart) — paved solid grey, gravel dotted, dirt diagonal
  stripes; unknown is not drawn — and one pill per kind in the side column (share of the
  distance, the ribbon in the kind's colour and hatching; hover highlights all its stretches on
  the charts and the map); the value flag names the surface at the cursor. A chart whose side
  column is taller than the plot grows to fit it.
- Stamina and potential stamina are one chart: current stamina filled, the potential (the most it can
  recover to) as a dashed line; legend on top of the side column, then Start / End / Min.
- Options panel rows carry a one-line description under the label (what the choice changes).
- Power stats also include **Max 20 min** and **Max 1 h** (best average power over that
  time, highlighted on hover); cadence includes **Revolutions** (rides) or **Steps** (on
  foot): the cadence integrated over time, pauses skipped.
- **Climbs** (altitude over distance): a climb runs from a low point to its highest point.
  Wiggles under 3 m are ignored. Dips on the way belong to the climb while each dip is at most
  25 % as long as the rise just before it (since the previous dip) and loses at most a third
  of the height gained so far; a longer or deeper dip ends it. A climb needs at least 20 m of
  gain over at least 50 m. Altitude stats: **Steepest climb · length** (the climb at least
  300 m long with the highest average grade) and **Longest climb · +gain** (its length);
  both explain this on hover and highlight their stretch.
- **Options** badge (page header), a panel with:
  - **X axis**: Distance | Elapsed time (pauses and stops included) | Moving time (only while
    moving: gaps over 10 s and standing still left out) | Percent (Distance when the activity
    has one; fixed default every visit);
  - **Power & cadence avg**: None | 5 s | 10 s | 15 s | 30 s | 1 min | 5 min | 20 min —
    trailing average of the power and cadence lines (one choice for both; stats stay on
    the raw data); default 10 s, the choice is saved per person (`ui_settings` key
    `activity-power-avg`).
- Hovering a best effort (list or a point of a duration curve in the tiles above) highlights
  its stretch on every chart (light band, bold line) and on the route map (amber line).
- Values that clearly belong to a chart (Avg/Max HR, pace, Avg/NP/Max power, cadence,
  ascent/descent) live only next to that chart and are never repeated in the tiles above,
  even when the chart is hidden; they are tiles only when the activity has no such chart.
- Hovering a chart shows that moment on the map (a dot on the route); hovering the route
  moves the charts' cursor there.

## Fitness page

One chart group over the days of the Time filter. **Date axis**: even steps chosen by what
fits (a week, 1, 2, 3 or 6 months, a year); month ticks read "Mar", week ticks "3 Mar"; the
first tick and every January carry the year on a second line; no axis title. The x flag
shows the exact date ("14 Apr 2026", no weekday; also on the segment charts). The header toggles Fitness and Form show
or hide one chart without redrawing the others (`api.show`). Order: dragged like on the
activity page (`ui_settings` key `fitness-chart-order`).

**Value pills** on the right instead of stats or a legend (their column is as wide as the
widest pill): each pill sits at the height of
its value, has the series (or zone) colour and is the series label at the same time; pills
that would overlap move apart by the same amount, centred on their values (each gives way
equally); hovering one marks its point. A pinned value shows every series of the chart.

- **Fitness and fatigue** (396 px) — fitness (muted steel blue `#6f8fbf`) filled (or a plain line, Options), fatigue a
  line; pills: Fitness and Fatigue at the end of the period. No daily load. Under its x axis
  a strip of **activity icons** (type icon on its day; icons closer than ~35 px share one spot (about three a month over a year; more when zoomed in)
  with a count; hovering shows name, type, date, moving time and distance of each, a single
  one opens the activity).
- **Options** badge (page header, like Map › Options; saved per person, `ui_settings` key
  `fitness-options`): Activities Shown | Hidden, Fitness Filled | Line, Fatigue Shown |
  Hidden (hidden: the card is titled "Fitness"), Form zones Shown | Hidden (hidden: no bands
  and zone names, the line keeps its zone colours). Defaults: shown, filled, shown, shown.
- **Form** (259 px) — the usual y axis (fresher = higher, the mirror of fatigue; turning it
  made form look like a copy of the fatigue line). Zone bands with the zone
  name in their corner; the grid lines and y labels sit exactly on the zone limits
  (−30, −10, 5, 25); the line takes the colour of its zone. Pills: Form (end of the period),
  Freshest and Most tired, each in the colour of the zone it is in.
- No ramp rate chart: it is the slope of the fitness line, shown as a number in the summary.

`chartGroup` options used here: `kind: "date"`, `lines`, `tags`, `zones`, `invert`,
`yMin` / `yMax`, `ySplits`, `height`, `hidden` + `api.show(key, on)`.
