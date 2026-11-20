# Changelog

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
