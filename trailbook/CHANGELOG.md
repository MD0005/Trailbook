# Changelog

## 0.1.26

### Added
- Compare two people: Activities together shows what they did together as tiles (both routes
  on one map) or a list, with a summary; Options sets the least shared route and the accuracy.
- A shared activity opens in two columns, one per person, with one route map and coupled charts.
- Wellbeing › Movement: best and worst day of the week for steps, floors and active calories.

### Changed
- The person picker has a Compare entry per pair instead of Everyone; with a pair only
  Activities is shown for now.
- Wellbeing › Movement: a set goal is always shown on the charts, as a faint dashed line.
- Wellbeing › Body: the weight shows a trend line (smoother over longer periods) instead of the
  moving average.
- Home Assistant cards: the dark theme uses Home Assistant's neutral dark colours.
- Wellbeing › Body: a VO2 max tile (running and cycling) in place of Fitness age.

### Fixed
- Home Assistant cards: no more occasional "401: Unauthorized".
- Home Assistant cards: no scroll bar in a card or window lower than its content.
- Wellbeing › Movement: the activity icons no longer run into each other over long periods.

## 0.1.25

### Added
- Wellbeing › Body: weigh-ins from Garmin Connect (scale and manual entries), merged with scale files.
- Settings › General: a Buy Me a Coffee button to support Trailbook.

## 0.1.24

### Added
- Wellbeing › Movement: steps and floors as dots (a row per month or year) or columns, intensity
  minutes with the activities under them, active calories; all charts linked by day, week or month.
- Wellbeing › Movement › Options: goals for steps, floors and intensity minutes.
- Wellbeing › Body: a silhouette filled with the last body composition, the weight with its moving
  average and goal, the composition over time, BMI and fitness age; weigh-ins from scale FIT files.
- Wellbeing › Body › Options: weight and body fat goals; the weight chart can show the training load.
- Settings › People: sex, for the Body silhouette and fitness age.
- Time filter: Last 2 years.
- Home Assistant map card: a People button on the map, the base map colours and wider zoom levels.
- Home Assistant activity cards: the base map colours; Activity detailed: the route colour.
- Calendar › Next workout: fatigue against your usual load, with the planned workouts.

### Changed
- Activity page: 3 or 4 small tiles sit in two columns.
- Home Assistant Activity detailed card: tighter top tiles, more room between the charts.
- Charts: a clicked stat keeps its marking; the hovered column is highlighted.

### Fixed
- Home Assistant map card: the routes stay after changing the base map or shading (also on Map).
- Charts: the last date label on the x axis is no longer cut off.

## 0.1.23

### Added
- Activity page: Export as FIT (the whole activity) or GPX (the route only, to send to someone).
- Activity › Edit: Correct altitude (smooths unrealistic spikes) and Correct speed (takes out
  GPS jumps), each after a confirmation.
- Activity › Edit: Exclude from statistics leaves an activity out of statistics, records,
  best efforts and segments (and Include again).
- Home Assistant map card: start over the last activity or a fixed place, and a zoom level.
- Home Assistant map card: buttons on the map to switch the view (heatmap, explorer tiles,
  squares, cluster), the base map and the shading for the moment.
- Home Assistant activity cards: base map and shading, also as buttons on the card's map.

### Changed
- The Home Assistant icon in the header looks like Home Assistant's own.
- Home Assistant › Cards: New card is a button in the page header; making or editing a card
  opens a window with Cancel and Create card / Save (nothing is saved before that).
- Home Assistant Activity card: a clear, readable route map with even margins in both themes.
- Home Assistant Activity detailed card: the small cards line up in rows, more room between
  the charts, no map credits over the scale.

### Fixed
- Home Assistant Activity detailed card: shown in full in a card with a fixed height (it was
  cut off with a dark area below).
- Home Assistant cards: while loading, no header bar and the loader sits on an even background.

## 0.1.22

### Added
- Home Assistant dashboard cards made in Trailbook (Home Assistant › Cards); a change shows on
  the dashboard without editing YAML.
- Fitness: a VO2 max chart under Form, running and cycling.
- Activity page: VO2 max and recovery time from the watch.
- Manual: how Next workout decides.

### Changed
- Activity page: training effect and Garmin's load also for activities imported from files
  (read from the FIT file when Garmin Connect has none).
- Calendar: the Workouts button is called Plan workouts.
- Map › Options: taller, so all three sections show.

### Fixed
- Calendar: nothing flickers any more between the pinned summary and the page header.
- Clearing the Time filter goes back to the page's usual period.

## 0.1.21

### Fixed
- Add-on page: the logo no longer shows a dark "Trailbook" title that was unreadable on the
  dark theme; it is now just the icon.
- Strava import: older activities saved as TCX files (with spaces before the XML header) were
  skipped as damaged; they import now. Upload the export again to bring them in.
- Uploads: files that could not be imported are kept (shown in Settings › Imported) instead
  of being deleted after the import; only copies of activities you already have are deleted.

## 0.1.20

### Added
- Statistics › Records: Walking & hiking best efforts (longest distance, most steps, elevation
  gain, biggest climb, steepest 1 km); segments one row lower.

### Changed
- Maps: colours are chosen for the light and the dark theme apart (defaults: muted in light,
  dusk in dark), instead of Automatic.
- Windows app: Trailbook opens in a window of its own (Microsoft Edge as an app) at
  trailbook.localhost instead of a browser tab.
- Windows app: uninstalling asks whether to delete your Trailbook data too (default: keep it).

### Fixed
- The Trailbook icon in the browser tab and on the taskbar of the Windows app (it was a
  generic globe).
- No more "translate this page?" prompt from the browser.

### Docs
- README: a short tour of every part with captioned screenshot thumbnails, and a clearer
  Installation.

## 0.1.19

### Changed
- Maps: Humanitarian with relief is the default; the colours follow the light or dark theme
  until you pick them (Colours: Automatic).
- Maps: CARTO maps removed, they now need an API key; a map no longer offered falls back to
  the default.
- Uploads: only what was imported is kept. Photos, activities outside the chosen dates,
  copies of activities you already have and files that are no activity are deleted after
  the import.

### Fixed
- Uploading big files (e.g. a Strava export ZIP) through Home Assistant no longer fails with
  "Content Too Large".
- Strava import: exports in Polish (and other languages) now bring titles, dates, sports and
  activities entered by hand.

### Docs
- README: a table of contents and new screenshots.

## 0.1.18

### Added
- Maps: Relief option that shades hills on every map and on the activity tiles.
- Maps: new base maps Humanitarian, CARTO Positron, Voyager and Dark Matter, and a Trails
  option with marked hiking, cycling or MTB routes.
- Strava import: optional From / To dates to import only part of the export.
- Statistics › Compare years: a click on a year column keeps it highlighted.
- Statistics › Timeline: average new tiles per period next to Most.

### Changed
- Statistics › Timeline: every activity type and country gets its own slice; labels hidden
  only under 1 %.
- Statistics › Timeline: time of day and day of the week as columns (default) or pie only.
- Statistics › Timeline: weather from the most common, Unknown last.
- Statistics › Compare years: the cumulative chart comes first in each pair.
- Calendar: the Summary stays on screen while scrolling (not on phones).
- Calendar › Next workout: the thresholds are shown for each sport.
- Export: every file of the archive is included.
- Settings › Data sources: Intervals.icu is marked as a testing phase.

### Fixed
- Statistics › Timeline: the Running and Cycling distance tables line up.

## 0.1.17

### Added
- A Windows app for use without Docker or Home Assistant: an installer on each GitHub release,
  an icon next to the clock, and one-click updates in Settings › General.

## 0.1.16

### Changed
- Statistics › Timeline: Countries lists every country with at least 2 % of the activities
  (up to 20) before Other, and each ring label shows the number of activities next to the share.
- Statistics › Timeline: weather kinds with their sky icons; Running and Cycling as the first
  column head of their distance tables.
- Statistics › Timeline › Distance breakdown: cycling also under 25 km and 25–50 km.
- Statistics › Timeline: time of day and day of the week columns in one colour; rings label only
  slices of at least 3 %; Countries shows the number of countries in its middle, Activity types
  the number of types, the others nothing.
- Calendar › Next workout: no line under the title.

- Calendar › Next workout: easy / moderate / hard by the aerobic and the lactate threshold
  (from the heart rate of each second); Garmin's zones only when there is no heart rate stream.
- Calendar › Next workout: the estimated form after the planned workouts under the current form.

### Fixed
- Statistics › Compare years: week labels in even steps from W1 (no crowded W1, W2 at the
  start) and the last week shown whole.

## 0.1.15

### Fixed
- Explorer tiles and squares: a tile the route line passes through only at a corner now counts
  as visited (the map, max square, new tiles, statistics).

## 0.1.14

### Changed
- Map tiles come in two sizes: Squares (the former large squares) and Explorer tiles; medium
  and small squares are gone.
- Statistics › Compare years: the year columns have a frame, axes and axis titles; hovering a
  part of a column shows that part only.
- Fitness: hovering Max fatigue draws its 7 days of the fatigue line thick instead of a point.
- Statistics › Compare years: Steps also as a running total.
- Statistics › Compare years: a Max pill on the charts per week or month (the best period of all
  years; hovering marks it).
- Statistics › Timeline: time of day and day of the week charts with a frame, axes and axis
  titles and small points; the chart kind is picked with three icons in each card.
- Statistics › Timeline: activity types and countries as a centred ring with a label beside each
  slice.
- Statistics › Timeline: the tile charts switch between Squares and Explorer tiles with icons on
  each card; new tiles per period are columns, the running total a filled line.
- Statistics › Timeline: Distance, Weather and Temperature breakdown as three cards in a row;
  running and cycling distances are separate tables.
- Statistics › Records: hovering a result lights its point on the curve beside it, and hovering
  a point lights its row.
- Statistics › Records: the curve pills show only the series name (All time high), no longer a
  single value that looked like an average.
- Activity route: markers every 1, 5, 10 or 25 km; long routes start with every 10 km (from
  50 km) or every 25 km (from 125 km).
- Calendar: the Next panel is now Next workout, with a title, the Model badge beside it (its list no
  longer cut off), the form explained in words and the suggestion under Next training.
- Calendar › Next workout: the intensity split counts the plan of the next 3 days, not 7.
- After an update that recomputes the analysis (countries, zones, records), it runs right away
  instead of with the next hourly import.

### Added
- Weather is fetched in the background for every outdoor activity, not only the ones opened, so
  Statistics › Timeline › Weather breakdown is complete.

### Fixed
- Road surface: long routes no longer fail on the map server, one failing activity no longer
  blocks the others, and a server failing now and then is left alone longer.
- Top speed over 1 minute: rides recorded in smart mode (a sample every few seconds) now get
  their real best minute instead of a too low one or none.

## 0.1.13

### Added
- Settings › Data sources: **Other sources: Intervals.icu** — a Check switch per person; files it finds wait
  as Download buttons until you take them.
- Activity: a **New tiles** card with the tiles the activity visited for the first time.
- Activity: the country of the route next to the date (for virtual rides the route's country).
- Statistics › Compare years: Distance, Activities and Elevation per year as columns on top,
  split into running, cycling and other.
- Statistics › Compare years: Steps per week or month.
- Statistics › Compare years: the current year's running total goes on as a dashed line to the
  end of the year.
- Statistics › Compare years: hovering a running total lists every year's value.
- Statistics › Timeline: a summary on top, time of day, day of the week, activity types,
  countries, distance and weather breakdowns.
- Statistics › Timeline: Explorer tiles with a size picker, its own summary, the tiles so far and
  new tiles per period.
- Calendar: a **Next** button with a suggested next session: the week's easy, moderate and hard
  time (done and planned) against a training model, the form and what to do next.
- Fitness: Max fitness and Max fatigue (best 7-day average) of the period next to the chart.
- Segments: a segment counted both ways shows how many efforts went each way.

### Changed
- Settings › Data sources: the Strava card is called **Other sources: Strava**.
- Settings: the tabs are called **Data sources** and **Workouts API**.
- Activity: the Power in zones bar is as thick as the heart rate zone bars.
- Statistics › Compare years: all charts line up left and right, the running totals are higher
  and say per week or per month, every chart title has an icon.
- Statistics › Records and Timeline open on All time.
- Fitness: the fitness and form charts end at exactly the same place on the right.
- A new waiting animation: the cyclist sits on the bike properly and pedals.
- Chart options say "X-axis".
- Calendar: the view is called **Weeks**; on phones one day a row with one-line activities.
- Calendar: the summary shows the current month while the weeks ahead are on top.
- Calendar: opening Summary, Next or Workouts scrolls to the top.
- Segments: "Last" is now "Most recent"; values an effort does not have (e.g. cadence) are left
  out instead of showing "–".
- Statistics › Records: a value and its date stay on one line; a period's best that is the
  all-time best shows the laurel instead of the same value twice.

### Fixed
- Virtual rides: heart rate and power zones are counted from the ride, so Power in zones shows
  and Calendar and Activities › Charts draw coloured blocks instead of a grey bar.
- Virtual rides: Gear lists the power meter, trainer and heart rate strap, not only the app.

## 0.1.12

### Fixed
- Changing an activity's type between a ride and a virtual ride (or back) moves its best efforts
  to the right records (outdoor or virtual).

## 0.1.11

### Added
- Phone layout: the page title in the top bar, the tabs in a menu behind the hamburger, the
  filters behind an icon beside the view buttons, so the activity gets most of the screen.
- Best efforts: **top speed over 1 minute** on rides, with GPS jumps left out.
- Best efforts: the longest distance in **12 minutes** on runs (Cooper) and in **1 hour** on rides,
  and the **elevation gain** of the activity.
- Statistics › Records: the **biggest climb** and the **steepest 1 km**, with altitude jumps left out.
- Segments › Edit: **Match width** (e.g. the other side of the street) and **One detour**
  (e.g. around a block); a wider match shows as a shadow around the segment on the map.
- Calendar: hovering an activity shows its values in the middle of its chart.
- Activity: **Power in zones** is a small tile of its own with the zones as one coloured bar.
- Power zones have one set of colours everywhere: grey, blue, green, yellow, red, violet, black.
- Statistics › Compare years: X axis **Mixed** (the default) — per month, running totals per week.

### Changed
- Virtual and indoor rides have their own records for distances, times and top speed; their
  power still counts with all rides.
- Statistics › Records: best efforts tiles beside their curves — running, power, cycling,
  virtual and segments, each record with its date; the 3 best of all time, or with a Time
  filter its best next to the all-time best; a click opens the activity.
- Statistics: the views are Compare years, Timeline and Records, each opening on its own period
  (all time, last 12 months, last 6 months).
- Activity › Best efforts: rows named Distance and Power20m; indoor rides show Best efforts
  virtual.
- Activity › Best efforts: an activity from an earlier year compares with its whole year
  (the column shows the year instead of YTD).
- Statistics: Compare years charts take the full width, one under another.
- Map: a click on a route lists the activities in flat rows with their type icon.
- Road surface is fetched in small batches right after an import and waits longer after the
  map server refuses, so the log no longer fills with server errors.
- Calendar: a larger wind arrow. Target lines on the activity charts are a bit lighter.
- The loading cyclist sits in the middle of the page without a frame on every tab.

### Fixed
- Map: the page header no longer flickers when opening or leaving the map.

## 0.1.10

### Fixed
- After an update the browser or the Home Assistant app could keep showing the old pages
  (e.g. no Settings › Log, the old Statistics); every update now loads the new ones.

## 0.1.9

### Added
- Statistics: **Years** compares years — distance, activities, elevation and time per week or
  month, each with its running total; hovering a dot lights the same one on its pair.
- Statistics: **Timeline** with explorer tiles of every size (large, explorer, medium, small)
  visited over time.
- Statistics: Time, Type and X axis (weeks, months, years) in the header; a click on a series
  pill hides that series.

### Changed
- Statistics: the old Totals view is replaced by Years and Timeline.

## 0.1.8

### Added
- Settings › **Log**: everything the app logs — imports, Garmin sync, intervals.icu, map and
  weather servers, Home Assistant — newest first, info green, warnings yellow, errors red.
  The same lines are in the add-on's log in Home Assistant.
- Fitness: hovering an activity icon under the chart shades the days it stands for; a click
  lists its activities with their load, each one opens the activity.
- Workout creator: two more ready steps per sport (run 6 × 800 m, 2 × 15 min; ride
  4 × 8 min, 2 × 30 min); Delete removes the selected step or repeat.

### Changed
- Fitness: the icon tooltip sums up the activities per sport (count and load).
- Workout creator: Repeat frames the step it is dropped on, or leaves an empty frame to drop
  steps into; long workouts use the whole width; a light background behind the step columns.

## 0.1.7

### Changed
- Activity page: the training load tile is now **Effort**, with the activity's **Load** and
  Garmin's training load in it; shorter tooltip.
- Fitness opens on the last 6 months (All time is one click away in Time).
- Calendar: today shows only the day length and the weather; steps, floors and stress come
  once the day is over.
- Calendar: Summary and Workouts scroll away under the header; only the weekday names stay.
- Calendar: the weekly target bars are twice as thick and longer.

### Fixed
- Virtual rides and runs: no road surface (tile, altitude chart, map layer); their routes are
  no longer sent to the map server.
- Virtual rides: heart rate in zones is shown again — apps write no time in zones, so it is
  counted from the heart rate with the zones of your nearest ride.

### Docs
- README: the records sensor with an example automation, both ways to install (add-on or
  Docker), and when CPU and memory go up.
