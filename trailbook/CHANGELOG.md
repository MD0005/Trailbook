# Changelog

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
