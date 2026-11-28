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
   every chart of a page is exactly as wide as the others. Labels stay short (Avg, Max, Weighted,
   Steepest climb); the tooltip gives the full name and any detail ("Average power",
   "Steepest climb: 3,4 % average over 4,07 km, +140 m"). Hovering a stat highlights
   what makes it on the chart: the point (max, min — also shown on the map), the climbs or
   descents (ascent, descent), or a dashed line at the value (averages).
7. **Exact x value on the x axis** at the vertical line, over the tick labels (white flag):
   full date, exact time or the distance with two decimals. Distance is shown with **two
   decimals everywhere in the app**.
8. **Title and controls**: the card title on the left; controls as badges in the page header
   ("Charts: 5 of 12", "Options" with the X-axis and other chart settings); **Reset** is a refresh pictogram in the top
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
- All charts of the page have one y-axis width (the widest), so the plots start at the same x
  and a moment — cursor, pins, interval lines — is one straight vertical line down the page.
- Structured workouts: the target of each workout step (heart rate, power, speed or cadence
  range, as set in the plan) is drawn on that chart over the step's laps: the high and the
  low limit are two continuous fine dashed lines (42 % of the text colour) that step up or
  down where the target changes (a stretch without a target breaks them), with a light grey
  band between them (3 %, the hovered step 8 %). The same on every chart with a target.
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
  as in the zone tiles); other values in the series colour; the time grey; a cell narrower than ~34 px stays empty. The line in the strip runs on
  unbroken into the plot. A line can be grabbed (a small grip shows on hover, the cursor becomes
  ↔; the line turns 2 px accent in every chart, its strip part too) and dragged between its
  neighbours. Hovering a
  strip shows a red ball with − over every line (click: remove it) and a blue ball with + under
  the pointer elsewhere (click: add a line there). Every change applies to all those charts at
  once and the cells recompute. **Saved** at once per activity (`activities.section_lines`, the
  seconds of the lines and the training type they belong to; kept on reimport): the next visit
  shows them instead of the detection. Edit › **Section lines: Reset lines** (shown only while
  there are saved lines) drops them and the detection is back. Another training type drops them
  too. The route map has an **Intervals** layer
  (Data badge) built from the same lines.
- **Climbs** (MANUAL › Climbs), altitude chart only. **Hills**: the same lines, strip and
  editing as interval sections, at every turning point of the profile; above a climb its gain,
  class, length and time; descents empty; moved lines are saved like interval lines. **Every other activity**: no lines — each climb with a
  class (Hill on foot, Cat 4 … HC) is the altitude line drawn thick (3,5 px, 5 px hovered) in
  the class's colour (Hill green, Cat 4 ochre, Cat 3 orange, Cat 2 red-orange, Cat 1 red, HC
  purple), with a tag above its highest point: gain and class in that colour, length, time.
  Hovering a climb shows a circle at both ends; dragging one changes the range, the tag
  recomputes. Not saved: a new visit shows the detected climbs again.
- **Easy** (training type): on the heart rate chart the stretches at or over the tempo line (90 %
  of the sport's threshold HR, the line the training type detection uses; 30 s or longer, gaps
  under 20 s joined) are drawn thick in one dark red (#b42318; zone colours read badly on the red
  line). The value flag over such a stretch adds "Above tempo · Z4 · 6:12 stretch" (Garmin's zone
  of the value under the cursor, the stretch's time). The side column gets **Above tempo** (share
  of the time with heart rate and the time); hovering it highlights the stretches like every
  other stat (series colour), on the map too.
- Hovering Max/Min draws a large dot with its value in a small label.
- **Stats on the map too**: hovering a stat that marks something on the chart shows it on the
  route map as well — a point (Max, Min) as the map's dot, stretches (Max 20 min / 1 h, Ascent,
  Descent, Steepest and Longest climb, In target, Above tempo) as the amber highlight, the same one
  best efforts and surface kinds use. A stat that is only a value (Avg, Weighted, Steps…) marks nothing,
  nor does a pill with the latest value (Fitness, Fatigue, Form): its point is the end of the
  line, next to the pill.
- **Dark theme:** series colours are mixed 22 % towards the card background and the fills
  under the lines are weaker (× 0,65), on the activity charts and the duration curves alike.
- **Road surface** (from OpenStreetMap, see SPEC): a hatched strip along the bottom of the
  altitude chart (or the first chart) — paved solid grey, gravel dotted, dirt diagonal
  stripes; unknown is not drawn; the y range reaches below the data by the strip's height, so
  the lowest values sit just above it, the x axis stays — and one pill per kind in the side column (share of the
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
  - **X-axis**: Distance | Elapsed time (pauses and stops included) | Timer time (pauses on
    the watch left out: a gap over 30 s counts 1 s) | Percent (Distance when the activity
    has one; fixed default every visit);
  - **Power & cadence avg**: None | 5 s | 10 s | 15 s | 30 s | 1 min | 5 min | 20 min —
    trailing average of the power and cadence lines (one choice for both; stats stay on
    the raw data); default 10 s, the choice is saved per person (`ui_settings` key
    `activity-power-avg`).
- Hovering a best effort (list or a point of a duration curve in the tiles above) highlights
  its stretch on every chart (light band, bold line) and on the route map (amber line).
- Values that clearly belong to a chart (Avg/Max HR, pace, Avg/Weighted/Max power, cadence,
  ascent/descent) live only next to that chart and are never repeated in the tiles above,
  even when the chart is hidden; they are tiles only when the activity has no such chart.
- Hovering a chart shows that moment on the map (a dot on the route); hovering the route
  moves the charts' cursor there.

## Shared activity (two people)

The activity charts of both people, one column each (SPEC §10a), coupled on one clock
(`chartGroup` option `pair`).

- X-axis is always **Time from meeting (h:mm)**: clock time from the first moment together,
  negative before it (`−0:12`), ticks at round minutes. Both columns span the same range, from
  the earlier start to the later end, so one position is one moment on both sides.
- Where that person was together with the other, the x axis of every plot is thicker (in the
  axis colour).
- What is done on one side happens on the other: the cursor (each side its own values), zoom by
  dragging, pins, reset, and the stretch highlighted by hovering a stat or a row of the tiles
  above (best effort, zone, surface) — the same stretch of time.
- Where a person has no sample within 30 s (or three times the usual sample step) of the cursor
  — not started yet, paused, finished — nothing is shown on their side.
- The map shows both people's positions at that moment; hovering either route moves both
  columns there.
- Charts choice, order and smoothing are one for both sides and all pairs.

## Statistics page

- The same charts (frame, axes, grid, crosshair, drag to zoom, pins, card resize and order) with
  several series in one chart (`multi`): no fill, a dot (5 px) per value, gaps where a series
  has no value. Series colours: a fixed pastel list (newest year first; tile sizes large to
  small).
- **Pills** on the right at the height of each series' last value, smaller than elsewhere
  (20 px), label and value inside ("2026 5 664 km"); pushed apart like the Fitness pills.
  Hovering one lights its last dot; a click hides the series on every chart of the page (the
  pill stays, grey) and shows it again.
- **Hover**: the dot nearest to the cursor (in height) is lit (halo and white rim) with a value
  flag beside it; the same series' dot at the same x is lit on every other chart of the page
  (e.g. the cumulative pair), with its flag.
- X-axis: months (Jan … Dec, every month) or weeks (W1 … W53, every 1, 2, 4 or 8 weeks as they
  fit, always counted from W1: W1, W5, W9 … W53; a little room on the right so the last label
  is whole) with half a period of room at both ends; Timeline: the date axis.
- Compare years: on top three column charts side by side (a third of the width each):
  Distance, Activities and Elevation gain per year — a column per year (oldest left) in its
  series colour, split into running (bottom, full colour), cycling and other (top) in three
  shades of it; the total over the column, hovering a part shows that part only (year, kind,
  value, share). The same frame and axes as every chart: the plot framed, a y axis with nice
  steps and a dashed grid, the y title with the unit and the years under the x axis with the
  title Year (plain HTML, not uPlot). Hovering a year dims the other
  columns of all three and fades the other years' lines on every chart below
  (`api.emphasize(label)`); a click on a column keeps its year marked until it is clicked again
  or the page reloads.
  Then one pair of charts (cumulative, then per period), each the full width, one under the
  other, for the metric picked in the **Data** badge at the right of the first chart's head:
  Distance (on entering the tab, kept while on it) | Activities | Elevation gain | Time | Steps
  (daily data, the Type filter does not apply); the titles and icons follow the metric.
  The per-period charts (not the running totals) have a **Max** pill among the year pills, at
  its height (pushed aside like them when they would overlap): the highest week or month of all
  years in that year's colour; hovering it marks the point and the tooltip names the period and
  the year.
  Titles: an icon and "<metric> per week | month", the running totals "…, cumulative"; the
  cumulative charts are 25 % higher (325 px). The current year's running total goes on dashed
  and level from its last week to the end of the year (`extend` on a line). Hovering a dot of a
  running total: the flag lists every year's value at that week or month, newest first, the
  hovered year bold (`tipAll`). X-axis Mixed (default): the per-period charts by month, the
  running totals by week — each chart its own group (its own x values, no shared crosshair); a
  click on a pill hides the series on all of them (`onToggle` / `api.toggleLine`).
- **One left and right edge on a page**: groups built with the same `shared` object take the
  widest y axis and the widest pill column of all of them (`api.realign()` after the last one),
  so every plot starts and ends at the same x.
- Records: the speed and power curves are the activity's duration curve (`curveChart`, same
  frame, fills, dashed comparison) — over the distances for speed (labels 400m, 1k, 1mi, 5k…,
  HM, M; tooltip pace and speed on foot), over the durations for power; the main series is the
  best in the Time filter (or of all time), the all-time best dashed; a click on a point opens
  its activity; a dot per value; the series pills on the right (the series name only — one
  number for a whole curve would mislead —, at the height of the last value, pushed apart when
  they would overlap) in a column of one width (150 px), so the curves end evenly. Hovering a
  point lights its row in the table beside it, and hovering a row shows its point.
  Hover flag, compact: the distance or duration, then one line per series — value, name, date
  (pace only on foot). They fill the height of
  the table tile beside them.

- Gear (both parts): **In use** is a chart of spans (plain HTML, not uPlot): a row per device
  or equipment, its picture
  as the y label (the end of the serial number under it when two share a name), the first used
  on top; the plot framed, dashed lines between the rows; a thick rounded bar (20 px, at least
  4 px wide) over each stretch of use (first and last day whole), a break of 30 days or more
  left empty, in the device's colour — the same as its ring and table dot, given by the order
  of first use over the whole history. Retired devices: the rows below the others, bar and
  picture strongly faded (25 %). X axis: the days of the Time filter (All time: from the
  first day a device was used to today), the date steps and labels of the Fitness page, no axis title.
  The scale's bars are the days weighed. Hovering a row lights the device's card and table row, and the other way round.
  Hovering the plot: a vertical line with the exact date in a flag on the x axis; hovering a
  bar: its dates, then the device, its serial number, first and last date, activities, time and
  distance (the same without the stretch on a picture).
  A joined line (Electronics): one rounded bar per unbroken stretch of its devices, cut where
  one starts or ends; each part in its device's colour, the height shared equally by those in
  use then; the label is the first one's picture and ×n, its tooltip names them with their
  periods. Equipment: the x axis runs from the first day of statistics to today.

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
  line; pills: Fitness and Fatigue at the end of the period, Max fitness (highest in the period)
  and Max fatigue (highest 7-day average, Manual › Fitness) at their heights; hovering Max
  fitness marks its day, hovering Max fatigue draws those 7 days of the fatigue line thick. The pill columns of
  all charts of a group are one width, so the plots end at the same x. No daily load. Under its x axis
  a strip of **activity icons** (type icon on its day; icons closer than ~35 px share one spot (about three a month over a year; more when zoomed in)
  with a count; hovering shades the days the icon stands for on the chart (first to last day)
  and the tooltip sums them up: the days, one line per sport — count and load —, the total
  load with several sports; a click opens a small window under the icon listing its
  activities (type icon, name, day, time, distance, load; a row opens the activity; closes on
  a click outside, Escape or scrolling).
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

## Wellbeing › Movement

- **Dots** (steps, floors): an SVG grid in the same card: the plot framed in `--chart-frame`, a dashed
  grid line through each row, the row labels as the y axis (months need no title), the x axis
  numbered (days 1, 5 … 31 | W1, W5 … W53 | Jan … Dec) with its title; its plot takes the left and
  right edge of the column charts. Each row's average in the side column, left of the stats (the
  column one width for the page). Hovering a stat marks its dots and fades the others; Avg is a
  value only. **Best day / Worst day** mark that weekday's dots; by week or month each dot shows
  that weekday alone.
- **Goal** (columns and lines, not dots): always drawn when set, a faint dashed line (`goal`),
  a bit stronger while its stat is hovered or clicked; the y range includes it.
- **Best day / Worst day** on columns by day mark those columns; by week or month (and on the
  years' lines) the chart shows that weekday alone while hovered (`{ swap }`).
- **Dots | Columns**: a switch of two icons at the right of the chart's header.
- Columns (`bars`, from 0, `barSize` 0,88 of the gap): the hovered column in full colour with a rim
  (no dot); a stat whose mark is `{ ranges }` (Goal met) shows those columns that way and fades the
  rest. The flag under the x axis names the period (`xExact`: "Week 12 2026", "March 2026").
- A click on a stat keeps its marking until it is clicked again (every chart, `pinned`).
- Intensity minutes carry the activity icons under the x axis as Fitness does, but one per column (`marksPerX`: the type done most often that week or month, smaller, with the count); hovering one marks its column (the others fade), a click lists its activities. Icons never touch: columns under 22 px drop the count and the icon shrinks (to 10 px); under 14 px they are dots (columns under 9 px apart share one), and hovering a dot opens the list.
- All charts of the tab are linked by period (a day → its week or month).

## Wellbeing › Body

- **Weight**: the standard chart (date axis, a dot per weigh-in); the trend (orange, solid; the longer
  the period, the smoother) and the goal (grey, dashed) as lines; value pills on the right at their
  height (Weight, Trend, Goal), as on Fitness. 330 px high beside the silhouette card (about a sixth of the width, the
  same height). **Additional series** badge in its header: a line on its own scale with a y axis on
  the right (`lines[].axis: "right"`, its title on the axis), lightly filled.
- **Composition**: an SVG stacked area chart in the card style (framed plot, dashed grid, y axis
  "Share of the weight (%)" over the data's range, month ticks with the year on January), 380 px,
  fat at the bottom (amber), then muscle (teal) and bone (blue-grey); pills on the right
  at the height of their layer's top at the last point, pushed apart when they would overlap. A click on a pill shows that layer alone as a line with dots, on its own range; again:
  all. The fat goal dashed while fat is shown. Hovering shows the values and moves the weight chart's
  cursor (and back). Its plot ends at the weight plot's right edge (also with the right axis).
  Its height changes with the grip on the card's bottom edge like every chart (120–640 px).
- **Tiles** under the silhouette (BMI, VO2 max): together as high as the composition card;
  the latest value large in a colour of its own, a word under it (BMI class; the sport), at the
  bottom a bar from the period's lowest to its highest with the latest value as a ring. VO2 max:
  running and cycling side by side in the Fitness chart's colours (one under another when
  narrow; only the sports that have a value).
