# Trailbook — icons and metric colours

Two icon sets, both original vector artwork (`viewBox 0 0 24 24`, `currentColor`, no bitmaps):

| Set | Source package | Served from | Helper |
|---|---|---|---|
| Activity types (123, incl. `other`) | `assets/icons/` | `static/icons/trailbook-icons.{js,css}` | `TrailbookIcons.render(type, {size})` |
| Metrics (86 + `other`) | `assets/metric-icons/` | `static/icons/metric-icons.{js,css}` | `TrailbookMetricIcons.render(key, {size: 20 \| 32})` |

In `preview.js` use `typeIcon(type, size)` and `metricIcon(key, size)`; `metricIcon` adds the
colour class of the metric's group. Unknown keys fall back to `other`.

Activity type icons use the accent colour. Metric icons use the colour of their group below;
a metric not in a coloured group is drawn in `--muted`.

Own drawings (`OWN_ICONS` in `preview.js`, same grid, 2.1 stroke, round joins) take
precedence over the set: `sleep`, `date`, `type`, `name`, and replacements for the weak
`avg_heart_rate`, `timer_time`, `avg_pace`, `total_ascent` and `total_descent`.

Activity types likewise: `OWN_TYPE_ICONS` in `preview.js` replaces weak drawings of the
set, used by `typeIcon` everywhere — so far `treadmill_run` (the `run` runner on a deck
with rollers and a handrail).

Sizes: 18 px in lists and table headers (the same as activity type icons), larger only on
Segments cards. Activity tiles use the standard size.

## Where they are used

- **Activities › List** — table headers (column `icon`, 18 px like the type icons):
  date, type, name, distance, time, pace, avg HR, ascent.
- **Settings › Imported** — FIT files that are not activities (sleep, HRV, monitoring, …) get
  a metric icon in front of their content (`FIT_TYPE_ICON` in `preview.js`).
- Planned: Activity page (stats) and charts, each series in its group colour.

## Colour groups

Tokens live in `preview.css` (`:root` and `[data-theme="dark"]`).

### Agreed

| Group | Token | Light | Dark | Metric keys |
|---|---|---|---|---|
| Power | `--m-power` | `#7c3aed` violet | `#a78bfa` | power, avg_power, max_power, normalized_power, total_work, intensity_factor, training_stress_score, time_in_power_zone |
| Heart (everything from heart rate) | `--m-heart` | `#dc2626` red | `#f87171` | heart_rate, avg/min/max_heart_rate, time_in_hr_zone, rr_intervals, hrv, rmssd, sdrr |
| Sleep | `--m-sleep` | `#ca8a04` yellow | `#facc15` | sleep (own icon) |
| Breathing | `--m-breath` | `#0891b2` light blue | `#22d3ee` | respiration_rate, avg/min/max_respiration_rate |
| Temperature | `--m-temp` | `#ea580c` orange | `#fb923c` | temperature, core_temperature, feels_like |
| Speed & pace | `--accent` | accent | accent | speed, avg/max_speed, pace, avg_pace, best_pace, grade_adjusted_speed/pace |
| Elevation | `--m-elev` | `#16a34a` green | `#4ade80` | altitude, min/max_altitude, total_ascent, total_descent, grade, vertical_speed, vam |
| Cadence & steps | `--m-cadence` | `#0d9488` teal | `#2dd4bf` | cadence, avg/max_cadence, steps, cycles, crank_revolutions, swim_strokes, wheelchair_pushes |
| Energy | `--m-energy` | `#db2777` pink | `#f472b6` | calories, active/resting/metabolic/fat_calories |
| Blood oxygen | `--m-oxygen` | `#4f46e5` indigo | `#818cf8` | spo2, muscle_oxygen, hemoglobin |
| Neutral | `--muted` | | | time, distance, position, date; own `type` and `name`; environment other than temperature (pressure, wind, humidity, weather), training effect, RPE, device |

Yellow is darkened in the light theme so it stays readable on white. Speed follows the
accent the user picks, so it is the main line of most charts.

### Not decided yet

| Group | Note | Metric keys |
|---|---|---|
| Stress / Body Battery | no icons or colour yet (Garmin wellness data) | stress, body_battery |

Open questions: does `feels_like` belong to temperature (yes for now); should training effect
(aerobic/anaerobic) follow heart or stay neutral; icons still missing for stress and
Body Battery.
