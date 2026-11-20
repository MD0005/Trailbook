# Changelog

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
