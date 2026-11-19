# Trailbook — manual

How the numbers Trailbook works out are computed: what goes in, the formulas and the
limits. The specification (`SPEC.md`) says what is shown where; this manual says how it is
calculated.

## Weather help

Did the weather help or hold back a ride or a run? A small meter answers it:

- in the **Weather** column of the effort tables (segment page: Top 10 and All efforts;
  segment card on an activity: Last, Best, Best · last 12 months) — for that effort on that
  segment;
- on an **activity's route map**, under the weather widget, without a background — for the
  whole route.

The meter grows from its middle axis: to the right (green) when the weather helped, to the
left (orange to red) when it held back; a full half is 15 points. Hovering it shows the
breakdown for that case: each part with its points and the sum.

### Where the meter appears

| Activity | Meter | Weather shown |
|---|---|---|
| Rides outdoors (road, gravel, MTB, e-bike…) | yes, ride weights | yes |
| Runs outdoors (road, trail…) | yes, run weights | yes |
| Indoor or virtual (trainer, spinning, Zwift, treadmill, indoor run…) | no | no (the cell stays empty): the model weather is not theirs, and virtual routes have positions in a game world |
| Other sports (walking, hiking, swimming, skiing…) | no | yes |

### Inputs

- **Weather of the activity** (Open-Meteo, see `weather.py`): hourly model values for the
  area (~10 km) of the start (for long routes also the middle and the end): temperature,
  wind speed (km/h, 10 m above ground) and the direction it comes from, rain or
  precipitation (mm), the WMO weather code. One set per activity: on a long activity the
  wind on the segment may differ from the hour of the start.
- **The line**: the segment's line in the riding direction (reversed for efforts ridden the
  other way, ⇄), or the activity's whole route.
- **The sport profile** (below).

### Formula

Points: 1 point ≈ 1 km/h of tailwind on a bike.

1. **Wind along the line.** For every piece *i* of the line (length *lᵢ*, direction
   *dᵢ*) and the direction the wind blows to (*u*, opposite to where it comes from):

   ```
   along = Σ lᵢ · cos(dᵢ, u)          (signed: + with the wind, − against it)
   both  = Σ lᵢ · |cos(dᵢ, u)|
   tail  = wind_speed · along / Σ lᵢ   (km/h; + tailwind, − headwind)
   wind  = tail · W                    (W: the sport's wind weight)
   ```

   Each piece counts by its length, so a loop or an out-and-back line cancels out by
   itself; crosswind pieces count zero.
2. **Wind both ways.** A loop is not quite neutral: the headwind parts take longer than the
   tailwind parts save (more time is spent in them, and drag grows with the square of the
   air speed). The share of the line where tail and head parts cancel out costs a little:

   ```
   mixed = 1 − |along| / both          (0: all one way to the wind, 1: a full loop)
   loop  = −min(L_max, L · wind_speed · mixed)
   ```
3. **Temperature** outside the sport's comfortable range [lo, hi]:

   ```
   temp = −min(T_max, (lo − t) · C)    below lo
   temp = −min(T_max, (t − hi) · H)    above hi
   temp = 0                            inside
   ```
4. **Rain or snow** (one value, the worst applies): snow (WMO 71–77, 85, 86), thunderstorm
   (WMO ≥ 95), rain ≥ 3 mm, rain ≥ 0,5 mm; else 0.
5. **Sum** `score = wind + loop + temp + wet` and the level:

   | Score | Level | Meter |
   |---|---|---|
   | ≥ 10 | helped a lot | dark green |
   | ≥ 4 | helped | green |
   | ≥ 1,5 | helped a little | light green |
   | −1,5 … 1,5 | about neutral | grey |
   | > −4 | held back a little | light orange |
   | > −10 | held back | orange |
   | ≤ −10 | held back a lot | red |

### Sport profiles

| Parameter | Ride | Run | Why it differs |
|---|---|---|---|
| Wind weight W | 1 | 0,35 | Runners are slower: the wind changes their air speed and drag far less in relative terms than at 25–35 km/h. |
| Wind both ways L / L_max | 0,1 per km/h / 3 | 0,035 per km/h / 1 | Scaled like W. |
| Comfortable range lo–hi | 12–24 °C | 8–18 °C | Running makes more heat per minute and cools less by airflow, so cooler is better. |
| Cold C (per °C below lo) | 0,5 | 0,3 | Cold hurts a cyclist more (wind chill at speed). |
| Heat H (per °C above hi) | 0,6 | 0,8 | Heat hurts a runner more. |
| Temperature cap T_max | 8 | 10 | |
| Rain ≥ 0,5 mm / ≥ 3 mm | −3 / −5 | −1 / −2 | Rain makes roads slippery and corners slow on a bike; a runner mostly gets wet. |
| Snow / thunderstorm | −5 / −4 | −3 / −2 | |

### Examples

- Ride, segment straight north, wind 20 km/h from the south, 18 °C, dry: tail +20, mixed 0
  → **+20, helped a lot**.
- The same segment ridden south: **−20, held back a lot**.
- Ride, a closed loop, same wind and weather: tail 0, mixed 1 → loop −2 → **−2, held back
  a little**.
- Ride, 4 °C, 0,5 mm of rain, tailwind 3 km/h along the segment: +3 − 4 − 3 → **−4, held
  back**.
- Run, the straight segment north with the 20 km/h tailwind, 22 °C: wind +7, temperature
  −(22 − 18) · 0,8 = −3,2 → **+3,8, helped a little**.

### Limits

- Model weather for the hour and the area, not the street: trees, buildings and valleys
  change the wind a rider feels; gusts are not in it.
- Wind is taken 10 m above ground; near the ground it is weaker.
- One weather set per activity (the start's hour), not per segment effort.
- The points are a rule of thumb for ranking conditions, not a physical time correction.

## Interval sections (lines on the activity charts)

Shown only while the activity's training type is **Intervals** (detected or chosen in Edit).
`workout.interval_splits`, computed on each visit (about 15 ms) while the person has not moved
any line; moved lines are saved per activity and shown instead (Edit › Reset lines drops them).

1. **Signal**: runs use their speed (what the runner sees as pace; running power drops on a
   fast downhill); other sports their interval channel (power → speed → power estimated from
   speed and grade → heart rate as a share of threshold HR; pool swims: speed from the laps).
   Gaps carry the last value.
2. **Bins**: means over `step` s = a quarter of the channel's shortest bout or recovery
   (power 5 s, speed 6 s, estimated power 7 s, heart rate 11 s, pool 2 s).
3. **Levels**: the split between the two levels of the activity (Otsu on the bins). Needs a
   contrast: high level ≥ 1.1 × the low one (heart rate: 7 % of threshold HR apart).
4. **Pieces**: the bins cut into pieces of steady level — the cut that minimises the squared
   error plus a penalty per piece (optimal partitioning, PELT). Each piece is at least 4 bins
   long; the penalty = 4 × (0.35 × (high − low))² / 2, so a step of a third of the contrast
   held for 4 bins is always a cut.
5. **Work or recovery**: a piece whose mean is above the split is work; neighbours of the same
   kind join. Work shorter than the channel's shortest bout (power and speed 20–25 s, heart
   rate 60 s) is dropped; a dip shorter than half the shortest recovery stays inside the bout.
   Needs 2 bouts.
6. **Edges**: each start and end moves to the sharpest step of the signal (3 s mean) within
   `step` + 5 s: the mean of the next k s against the previous k s, k = a quarter of the bout,
   3–15 s.
7. **30 s minimum**: no detected section is shorter than 30 s — shorter bouts are dropped,
   shorter recoveries join the bouts around them, a warm-up or cool-down under 30 s becomes
   part of the first (last) bout (no line there). Lines the person adds or moves are free.
8. **Lines**: every bout's start and end. When
   nothing is found, the bouts stored by the training type detection are used.

Section values on the strip above each chart: time-weighted averages of the samples between
two lines (power and cadence without the chart's smoothing). Pace / speed of a section =
distance / time where there is distance. Zone = Garmin's zone limits from the FIT file.

## Training type Race

`workout.classify`, thresholds in `workout.RULES`; Help › Training types prints the same values.
Checked after Intervals, before Hills, Long, Tempo. All conditions must hold:

| Condition | Formula | Value |
|---|---|---|
| Long enough | moving time | ≥ 10 min |
| Few stops | elapsed ÷ moving time | ≤ 1,25 |
| Heart rate at threshold (every sport) | share of moving time with HR ≥ 95 % of the sport's threshold HR | ≥ 60 % |
| Rides with power: race intensity | IF = NP ÷ FTP | ≥ 0,90 |
| Close to your best | intensity ÷ your best intensity in activities of the family ±25 % as long, within 365 days | ≥ 95 % |
| Above your typical | intensity ÷ your median of the family | ≥ 1,03 |

- **Intensity** = the median moving power when the family's history has power, else the median
  moving speed (per-activity medians in `workout_stats`).
- **Threshold HR of the sport** = threshold HR (watch, else 90 % of max HR) × the sport's share
  (cycling 0,95, running 1,0; Help › Training types › Sports).
- Without heart rate an activity is never a Race. The heart rate condition keeps hard group
  rides and solo efforts with high power but a moderate heart rate out (they become Tempo or
  Long); a hot treadmill run has the heart rate of a race but not the intensity.

## Easy on the charts (above the tempo line)

**Limit** = the tempo line of the training type detection: 90 % of the sport's threshold HR
(threshold HR from the watch, else 90 % of max HR; × the sport's share, e.g. cycling 0,95). The
same line decides Tempo, so the stat and the training type never disagree. Garmin's zones are not
used here: they are often set from % of max HR, and their zone 2 ends far lower (e.g. 136 bpm
with max HR 191, while the tempo line at threshold HR 173 is 156 bpm), so an easy run would show
"90 % above Z2".

**Above tempo** = time with heart rate ≥ the limit ÷ time with heart rate (samples weighted by
the time to the previous one, at most 30 s). Drawn thick: stretches at or over the limit at least
30 s long, gaps under 20 s joined.

## Climbs (lines on the altitude chart)

Computed in the page from the altitude line of the charts (`climbSections`, `climbCategory` in
`preview.js`). Moved Hills lines are saved per activity like interval lines; the thick climbs
of other activities are not saved.

**Categories** — the cycling scale (Tour de France, Strava): score = length (m) × average grade
(%), which is simply the gain × 100, so the category is set by the metres climbed; the climb
must average at least 3 % over at least 500 m. Every sport uses it. On foot (run, walk, hike)
there is one more class below Cat 4, because Cat 4 is rare on a run.

| Class | Gain | Also needs | Example |
|---|---|---|---|
| Hill (on foot only) | ≥ 30 m | ≥ 5 % average, ≥ 200 m | 300 m × 10 %, 600 m × 5 % |
| Cat 4 (easiest) | ≥ 80 m | ≥ 3 %, ≥ 500 m | 2 km × 4 % |
| Cat 3 | ≥ 160 m | | 4 km × 4 % |
| Cat 2 | ≥ 320 m | | 5 km × 6,4 % |
| Cat 1 | ≥ 640 m | | 8 km × 8 % |
| HC (hors catégorie, hardest) | ≥ 800 m | | 10 km × 8 % |

**What a climb is** (`chartClimbs`): from a low point to its highest point; wiggles under 3 m
ignored; a dip on the way stays part of the climb while it is at most a quarter as long as the
rise just before it and loses at most a third of the height gained so far.

**Every activity except Hills**: no lines. The climbs that have a class are drawn thick on
the altitude line in the class's colour, with their values in a small tag above the climb's
highest point. Hovering a climb shows a circle at its start and its end; dragging one moves that
end along the line and the values (the class too) recompute. Not saved.

**Hills**: lines at the turning points of the profile — a top or a foot counts once the
altitude has moved away from it by 12 % of the activity's altitude range, at least 15 m (a
500 m range: 60 m); smaller wiggles stay inside a climb or a descent. No turning point inside
the activity: the hill repeat bouts the training type detection stored. Every climb gets
values, with its class when it has one.

**Values of a climb** (in the strip on Hills, in the tag elsewhere): the gain and the class
(both in the class's colour; without a class the gain in the altitude colour), the length and
the time (elapsed, pauses included). On Hills descents stay empty, and the lines can be moved,
added and removed like interval lines.

## Laps (table on the activity page)

Rows of 1, 2, 5 or 10 km. They are built from 1 km laps:

- **Device auto-laps** when every lap but the last is 1 km long (± 25 m): their own values.
- **Otherwise cut from the streams** (the 1 500 points the page loads): a lap ends at the first
  point at or past each whole kilometre. Time is the moving time (gaps over 10 s and standing
  still left out); heart rate, power and cadence are averages weighted by time (gaps count at
  most 30 s; power zeros count, heart rate and cadence zeros do not); a last piece under 50 m
  is dropped.

Grouped rows: distance and time are sums, speed is distance ÷ time, the averages are weighted
by time. Device laps of another kind (manual laps, workout steps) are the choice *Device laps*.

## Activity charts (Activities › Charts)

Shown in Manual › Activity charts; the numbers come from `/api/types` (`tile_chart_rules`) and
`TILE_CLIMB` in `preview.js`. Code: `tilechart.py`, drawn by `tileChart()` in `preview.js`.

One small chart per tile, chosen by the training type; the first one the activity has the data
for, else speed over time:

- **Intervals** — heart rate blocks over the interval sections (the person's saved lines, else
  the detected ones); none: the phases.
- **Easy, Tempo, Race** (1/12 of the time), **Long** (1/20), **games** (1/12) — heart rate
  blocks over the phases, each at least that share of the time and at least 60 s.
- **Hills** — the altitude profile (80 points along the distance), climbs darker: a rise
  between turning points of at least 5 m and 12 % of the profile's height.
- **Commute, no type** — the route alone (~160 points, north up), each piece in the heart rate
  zone there; no route: heart rate blocks.

Blocks: width = time, height = average heart rate between resting HR and HR max (the top of
Garmin's zones, else the activity's max), colour = the zone of that average; a dashed line at
the activity's average. Averages are weighted by time, gaps count at most 30 s. Without heart
rate the same from power: 0 W to the top of Garmin's power zones (an open last zone ends 10 %
above its start).

Phases: 15 s means of the heart rate; the zone changes only 3 bpm past a limit (power: 3 % of
the scale); neighbours in one zone are joined; the shortest block under the minimum joins the
neighbour closer in heart rate, until none is shorter.

## Calendar: steps, floors, stress, day length

Code: `fitfile.parse_monitoring`, `analysis.daily_values`, `dayLength()` in `training.js`,
`weather.forecast`.

The day values are for the whole day, not only the activities. They come from Garmin
Connect's daily summary (fetched with the Garmin downloads: steps, floors ascended, average
stress as Garmin shows them). Days Garmin has no summary for take them from the watch's
monitoring files (export folder or uploads), computed like this:

- **Steps** — the watch keeps a running total per kind (walking, running) that starts again
  at local midnight; the day's value is the largest total of each kind, added up.
- **Floors** — the day's ascent (an undocumented running total in mm, also reset at midnight)
  ÷ 3.048 m (10 ft), rounded down. No floors but an ascent: the ascent in metres.
- **Stress** — the average of the day's readings (one a minute, 0–100); readings the watch
  marks as not valid (during activities, off the wrist) are left out.
- A total written exactly at midnight belongs to the day that ends. Local days use the file's
  own time zone. Several files of one day: running totals take the largest value, stress
  readings are pooled.

From today on, days without these values show:

- **Day length** — sunrise to sunset at the latitude of the latest activity's start: the sun's
  declination of the day, −23.44° × cos(360°/365 × (day of year + 10)), and the sun 0.833°
  below the horizon (refraction and its radius). Within a few minutes of the published times.
- **Forecast** — Open-Meteo daily forecast (16 days) at the same start, rounded to 0.01°:
  sky of the day, lowest–highest temperature, rain, strongest wind and its main direction.
  Kept for 3 hours.

Month summary: sums of the month's activities; steps and floors as totals with the average of
the days that have them; stress as the average of the days' averages.

## Fitness: training load, fitness, fatigue, form

Shown in Manual › Fitness; the constants come from `/api/types` (`fitness_rules`), the zones
from `FORM_ZONES` / `RAMP_ZONES` in `training.js`. Code: `analysis.py`.

### Load per activity (TSS, one hour at threshold = 100)

Every sport. The first method the activity has data for; duration = moving time.

1. **Power** — TSS = h × IF² × 100, IF = NP ÷ FTP (NP: 4th-power mean of the 30 s rolling
   power, stops = 0 W). Needs a power stream and an FTP: the watch's per sport (cycling FTP
   for rides, running FTP for runs with running power), or the person's own for any sport,
   or the activity's corrected FTP.
2. **Running pace** — h × IF² × 100, IF = average speed ÷ threshold speed. Outdoor runs, only
   with a threshold pace set by the person.
3. **Heart rate** — TRIMP per second: HRr = (HR − rest) ÷ (max − rest), weight =
   HRr × 0,64 × e^(1,92 × HRr), summed per minute and divided by 60 min × the weight at
   threshold HR, × 100. Needs ≥ 60 s of heart rate; without a stream: the average HR over the
   moving time.
4. **None** — no power and no heart rate: in totals, not in fitness.

### Fitness model (daily)

- Daily load = sum of the day's activities (local date); no training = 0.
- Fitness (CTL) += (load − CTL) × (1 − e^(−1/42)) ≈ 2,35 %; Fatigue (ATL) the same with 7 days
  ≈ 13,31 %. Both start at 0 on the first day with a load.
- Form (TSB) = yesterday's CTL − yesterday's ATL. Ramp rate = CTL − CTL 7 days ago.
- The activity page's **Load** tile shows Fatigue (ATL) at the end of the activity's day and
  how much that day raised it (ATL − the day before's ATL), next to Garmin's training load and
  the Body Battery change (both from Garmin Connect, not computed here).
- The model is Banister's impulse-response model (fitness and fatigue as decaying sums of
  training load), in the 42 / 7-day form used by performance-management charts.
- Form zones: Transition > 25, Fresh 5 to 25, Grey zone −10 to 5, Optimal −30 to −10,
  High risk < −30. Ramp: Too fast > 8, Building 0 to 8, Losing fitness < 0.

### Thresholds, per value

1. The person's own (Settings › People, pencil; rows with a *valid from* date).
2. The watch's, from the activity's FIT file; missing: the nearest activity's (latest before,
   else first after). FTP only within the sport (rides, runs).
3. Estimate: HR max = highest recorded max HR (100–230 bpm), resting HR = 60 bpm, threshold
   HR = 90 % of HR max.

A changed threshold recomputes all of the person's activities. The ⚠ on the Fitness page:
resting HR default or HR max from the recordings (not accepted with *Use estimate*), or a
year using watch values more than 365 days away.

## Imported files without a time zone (GPX, TCX, Strava)

FIT files say how far local time is from UTC; GPX, TCX and Strava's `activities.csv` give UTC
only. Trailbook picks the offset in this order:

1. The person's activity nearest in time that has an offset, if it is at most 120 days away
   and in the same summer-time season (EU rule: last Sunday of March to last Sunday of
   October, 01:00 UTC).
2. From the start position: `round(longitude / 15)` hours, plus one hour in the summer-time
   season when the longitude is between −25° and 45° (Europe).
3. No position (manual Strava activity): the nearest activity's offset, shifted by one hour
   when the seasons differ.
4. Nothing known: UTC.

Example: a run in Warsaw (21° E) on 1 June with no Garmin activity nearby → 1 h + 1 h summer
time = UTC+2.

Limits: countries without summer time or with other rules east of 45° get the plain
longitude estimate; places far from their time zone's meridian (e.g. Spain) can be an hour
off. The time can be corrected only by editing the file today.

## Explorer tiles in a country or region (Map › Summary)

- **All tiles** of a country or region: every tile of the chosen size whose **centre** lies
  inside its boundary (holes such as enclaves are left out). Counted row by row in the browser.
- **Visited**: those of them that are among your visited tiles (same filters as the map).
- **Share** = visited ÷ all × 100, two decimals below 10 %, one above; below 0,01 % it shows
  "< 0,01 %".
- Boundaries: Natural Earth 1:10m, simplified to about 0,5 km. Along a border a tile can fall
  on either side, so the count of all tiles can differ from an exact boundary by about 1 %
  (more in small regions with long borders). Example: Poland has about 139 000 explorer tiles
  (zoom 14).
