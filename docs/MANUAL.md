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

## Segments: both directions

A segment counts in both directions (efforts ridden the other way share its leaderboard,
marked ⇄) when Edit › Direction says so:

| Direction | Counted |
|---|---|
| Automatic (default) | both ways when the end is at most 30 m and at most 3 % of the length above or below the start (end altitude − start altitude, the mean of the first and last five samples of the source activity); otherwise one way |
| Both ways | always both ways |
| One way | only the direction it was created in |

Changing it matches the segment again against every activity.

## Segments: match width and one detour

How close an effort must follow the segment (Edit, per segment; changing it matches the
segment again against every activity):

| Setting | Range | Default | Means |
|---|---|---|---|
| Match width | 15–75 m, steps of 5 | 30 m | every checkpoint (one per 25 m of the segment) must have the track within this distance; the start and end lines are 25 m × width / 30 wide (25 m by default) |
| One detour | 0–500 m, steps of 25 | none | once per effort the checkpoints along up to this many metres of the segment may be missed, when the track comes back to the segment within 2 × detour + 200 m of track |

- The travelled distance may be 0,8–1,3 × the segment length + 100 m, plus 2 × the detour.
- Example: a 1 km segment along a street, run on the other side 40 m away: no effort with
  30 m, one with 45 m. A block walked around (150 m of the segment missed, 200 m away from it
  on each side): one effort with a detour of 150 m or more, none with less; two such blocks
  in one effort: none (one detour only).
- A wide corridor can let a parallel road in: keep it as narrow as the place allows.
- A checkpoint counts where the track first enters its corridor. Over a switchback (two lanes
  closer than the corridor) checkpoints of the lane after the turn are caught already on the lane
  before it, so the track falls behind the segment; that lag (segment metres passed minus track
  metres travelled) is added to the 200 m allowed to the next checkpoint. So a wider corridor
  never loses an effort a narrower one found.

## Top speed over 1 minute (rides)

The best mean speed over 60 s, from the distance between samples, counting only seconds the
data can be trusted:

| Check | Limit |
|---|---|
| samples apart | at most 12 s (smart recording writes a sample every 1–10 s) |
| speed | at most 80 km/h |
| change of speed | at most 3 m/s per second (more is a jump of the position) |
| the device's own speed (Doppler or a sensor) | within 1,5 m/s or 15 % |
| next to a doubtful second | 5 s on each side dropped too |
| the minute's distance vs the track's length | within 10 % |

- A GPS jump of 150 m in one second makes the minutes around it count not at all, so it never
  becomes a record. Rides recorded without a distance stream get no top speed.
- Biggest climb: from a low point to its top; a dip on the way is allowed while it is at most
  25 % as long as the rise before it and loses at most a third of the height gained so far;
  at least 20 m. Steepest 1 km: the highest average grade over 1 km of distance.
- Altitude jumps (more than 4 m/s between two samples) are taken out before. A 1 km stretch
  counts only when the height was gained at most 1,5 m/s, its grade is at most 40 % and no 50 m
  of it is steeper than 30 % (the distance jumped, or the barometer drifted while standing).
- Distance within a time: the longest distance covered in 12 min on runs (Cooper test) and in
  1 h on rides, from the distance stream (the end of the window interpolated between samples).
- Indoor rides (virtual, trainer) have records of their own for distances, times, longest
  distance, distance in 1 h and top speed; their power counts with all rides.

## Segments: trend line

The dashed curve on the Trend chart is a robust local regression of the effort times over
the date (LOESS):

- **Local linear fit** around each effort, over the 60 % of efforts nearest in time,
  weighted by distance in days with the tricube kernel `(1 − u³)³`.
- **Robust**: two more passes weight each effort by its residual (bisquare
  `(1 − (e / 6·median|e|)²)²`), so single slow efforts — traffic, a group ride, a bad day —
  barely move it.
- **Over time, not over the effort number**: weeks without riding do not bend it.

Fitness changes over weeks, not from one ride to the next, so the curve shows the level you
are at; the Trend pill is where it ends now. Drawn from 4 efforts on.

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
| Long enough | time | ≥ 10 min |
| Few pauses | elapsed ÷ time | ≤ 1,25 |
| Heart rate at threshold (every sport) | share of the time with HR ≥ 95 % of the sport's threshold HR | ≥ 60 % |
| Rides with power: race intensity | weighted power ÷ FTP | ≥ 0,90 |
| Close to your best | intensity ÷ your best intensity in activities of the family ±25 % as long, within 365 days | ≥ 95 % |
| Above your typical | intensity ÷ your median of the family | ≥ 1,03 |

- **Intensity** = the median power while in motion when the family's history has power, else
  the median speed while in motion (per-activity medians in `workout_stats`).
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
  point at or past each whole kilometre. Time is the timer time (a gap over 30 s is a pause); heart rate, power and cadence are averages weighted by time (gaps count at
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

## Heart rate and power in zones (activity page, Calendar, Activities › Charts)

- From the activity file: Garmin's time in zones (`time_in_zone`), with the zone limits the
  watch used.
- Files without it (virtual rides: training apps write none): counted from the heart rate and
  power lines when the activity is analysed, and kept with the activity, so the zone tiles, the
  heart rate blocks of Calendar and Activities › Charts and the route colours all have them.
  Zone limits = Garmin's of the person's activity of the same sport nearest in time that has
  them in its file (heart rate: else of any sport; power: only the same sport, running and
  cycling power differ; zones counted this way are never borrowed). Each sample lasts until the
  next one; a gap over 10 s (a pause) counts 1 s. Below the first limit = "below zone 1", above
  the last = the top zone. The tile's title says which activity's zones were used.
- No line or no activity with zones yet: no tile.

## Country (activity header)

- The country of the route, from the country outlines the app ships (Natural Earth 1:10m),
  nothing asked of a server: the start point, else the first of ~24 points along the track that
  lies in a country (a start on a beach can fall just outside the simplified outline).
- A route crossing a border shows the start's country.
- Virtual: the country of the app's route (riding at home on a route from New Zealand = New
  Zealand). Apps with a made-up world placed at sea (Zwift): none.
- Without GPS: none.

## Visited tiles (Map › Explorer tiles, everywhere tiles count)

- A tile is visited when the route line passes through it: the tile of every route point and
  every tile on the straight line between two points, also when the line only cuts a corner
  (a walk along the line from one tile edge to the next, `walkTiles` / `explorer.walk_tiles`).
- Where the GPS signal is missing (no position), no line is drawn across the gap.

## New tiles (activity page)

- The tiles of each size (as on Map › Explorer tiles) this activity's route touched before any
  earlier activity of the same person did; virtual routes count, as on the map.
- Counted in the browser from the stored routes (the same simplified lines the map uses), so it
  matches Map › Explorer tiles; only earlier routes that come near the activity are loaded.
- The card shows only when there is a new tile; the Size badge lists only sizes with new
  tiles, the largest first.

## Statistics › Timeline

- **Time of day**: an activity counts once in every hour it spans (start to start + elapsed
  time, local time), so a ride from 17:30 to 19:10 counts at 17, 18 and 19.
- **Day of the week**: the day the activity started (local).
- Tooltip averages: distance and elevation per activity; pace (all activities on foot) or speed
  = total distance / total moving time of the activities with a distance.
- **Avg speed** in the summary the same; **Around the world** = distance / 40 075 km, **To the
  Moon** = distance / 384 400 km; **Steps** = the daily steps of the days in the period.
- **Countries**: the route's country (Manual › Country); without one: Indoor (marked indoor, or
  virtual when they are excluded) or No route.
- **Weather breakdown**: outdoors for sure only — a recorded route, not marked indoor, not
  virtual. Kinds from the hour's WMO weather code: Clear 0–1, Cloudy 2–3, Fog 45–48, Rain 51–67
  and 80–82, Snow 71–77 and 85–86, Thunderstorm 95+. Unknown: the weather is fetched when the
  activity is opened, not yet for this one.
- **Explorer tiles** strip (the tiles of the routes in the period, chosen size): Max square and
  Max cluster as on Map › Explorer tiles; Cluster tiles = tiles whose four neighbours are visited;
  Cluster span = the max cluster's width or height in tiles, the larger; Connected tiles = the
  largest group of visited tiles touching side by side; Longest column / row = the longest
  unbroken vertical / horizontal line of visited tiles; Most visited = the visits of the most
  visited tile; One activity = the most tiles one activity visited.

## Next workout (Calendar › Next workout)

- **Window**: the last 7 days (today included) and the workouts planned for the next 3 days
  (today's only while no activity of its sport is done today). Only the next few days: a plan
  further ahead is an intention, and it would weigh as much as the week already done.
- **Split** by the two thresholds the models are defined by: easy below the aerobic threshold
  (LT1), moderate between it and the lactate threshold (LTHR), hard above LTHR. LTHR is the
  activity's (the watch's, yours, or 90 % of the max HR); Garmin records no aerobic threshold, so
  LT1 = 89 % of LTHR (LTHR 167 → LT1 149 bpm). The time comes from every second of the heart rate.
  Backup, for an activity without a heart rate stream or a threshold: Garmin's time in zones —
  zones 1–2 and below easy, 3–4 moderate, 5 hard. Activities without heart rate do not count.
- A planned step by its target: heart rate by the middle of its range in bpm against the same
  thresholds; pace (read as a zone from your usual speed, as in the workout estimate) and heart
  rate without thresholds by zone 1–2 / 3–4 / 5; power zones 1–2 / 3–4 / 5–7; no target or
  rest = easy.
- **Form**: now, from the training done (planned workouts not counted). Under it the estimated
  form after the planned workouts of the window: the fitness model run on with their estimated
  loads, going into the day after the last one.
- Why not Garmin's zones alone: their zone 4 ends near the lactate threshold, so it is mostly
  between the thresholds (moderate), and most of zone 3 is below the aerobic threshold (easy).
- **Models** (easy / moderate / hard): Polarized 80 / 5 / 15, Pyramidal 75 / 20 / 5, Threshold
  55 / 35 / 10.
- **The next session**, the first rule that fits:
  1. Form below −30: rest.
  2. A hard day (≥ 10 min hard) yesterday or today and form below +5: easy (rest with form below
     −20).
  3. No session of 90 min or more in the 7 days and none planned, form −20 or higher: long.
  4. Hard time short of the model by the most (at least 3 points), form −20 or higher: intervals.
  5. Moderate time short of the model (at least 3 points), form −20 or higher: tempo.
  6. Otherwise easy.
- **Sport**: of the endurance sports done at least twice in the last 4 weeks (run, ride, swim,
  walk, hike, winter, water), the one whose share of the time fell most in this window (plan
  included) against those 4 weeks.
- **Length**: the sport's usual session (median of 4 weeks), long = 1,5 × that and at least
  90 min; to 5 minutes.
- **Plan notes**: when the plan puts an intensity more than 10 points past the model, the
  planned workout with the most of it is named (make it easier, or add hard work when easy is
  too much).

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

## Time of an activity: timer and elapsed

Trailbook uses no moving time. An activity has two times, both from the watch's file:

- **Time** (timer time) — while the watch was running: pauses on the watch left out, standing
  still with the watch running counted. Used everywhere: lists, calendar, weeks, totals,
  targets, pace and speed, load. Files without a timer (GPX, TCX, Strava): the elapsed time.
- **Elapsed time** — from start to finish, pauses included (the activity page, under Time).

The activity charts can also run on the timer time: a gap over 30 s in the samples is a pause
(the watch records nothing while paused) and counts 1 s.

## Planned workouts: estimates and what goes to the watch

Code: `planner.py` (`estimate`, `icu_text`, `RULES`), `icu.py`.

- **Zones** are Garmin's zones of the person's latest activity of the sport: heart rate zones
  1–5 (zone *z* = from its lower limit to the next zone's), power zones 1–7 (from 0 W; an open
  last zone ends 10 % above its start).
- **Usual speed**: the median average speed of the latest 10 activities of the sport longer than
  10 min and 1 km (none: run 2,8 m/s, ride 7 m/s). A step's speed = usual speed × a share by
  zone (heart rate 0,85 / 0,93 / 1,00 / 1,07 / 1,13; power 0,80 … 1,15); a zone range uses its
  middle, a rest step stands still.
- **Time and distance**: a time step's distance = time × speed; a distance step's time =
  distance ÷ speed. Repeats count every time.
- **Load** (as for an activity): per step hours × intensity² × 100, intensity by zone — heart rate 0,55 / 0,70 / 0,82 /
  0,92 / 1,02; power 0,50 / 0,65 / 0,82 / 0,97 / 1,12 / 1,30 / 1,50.
- **Kind**: Intervals — a repeat with an interval step in zone 4 or higher; Tempo — an interval
  step of at least 10 min in zone 3 or higher; Long — at least 90 min; else Easy.
- **Pace targets** (runs) have no Garmin zones: the step's speed (the middle of its range)
  against the usual speed is read as a heart rate zone through the speed shares backwards
  (between two shares in proportion), for the chart, the load and the kind; the step's time /
  distance uses its own pace. Sent as % of intervals.icu's threshold pace (speed ÷ threshold
  speed, rounded to 1 %). A new pace range for a zone: usual speed × the zone's share, ±2 %,
  to 5 s.
- **Steps on the watch**: each step and each repeat counts one (at most 50).
- **Sent to intervals.icu** as text: warm-up and cool-down under their headings, a repeat as
  `Main set Nx`, each step `- cue length target`. Heart rate targets as % of intervals.icu's
  threshold heart rate (LTHR; without it % of its max HR), rounded to 1 %, so the watch gets
  Garmin's limits whatever zones intervals.icu uses; power targets in watts. Digits are left
  out of cues (they would be read as the length).
- A placed workout is sent 1 minute after it was placed or moved; intervals.icu not reachable
  or a server error: again 10 minutes later.

## Fitness: training load, fitness, fatigue, form

Shown in Manual › Fitness; the constants come from `/api/types` (`fitness_rules`), the zones
from `FORM_ZONES` / `RAMP_ZONES` in `training.js`. Code: `analysis.py`.

### Load per activity (no unit, one hour at threshold = 100)

Every sport. The first method the activity has data for; duration = the timer time.

1. **Power** — h × intensity² × 100, intensity = weighted power ÷ FTP (weighted power: 4th-power
   mean of the 30 s rolling power, stops = 0 W). Needs a power stream and an FTP: the watch's per sport (cycling FTP
   for rides, running FTP for runs with running power), or the person's own for any sport,
   or the activity's corrected FTP.
2. **Running pace** — h × intensity² × 100, intensity = average speed ÷ threshold speed. Outdoor runs, only
   with a threshold pace set by the person.
3. **Heart rate** — TRIMP per second: HRr = (HR − rest) ÷ (max − rest), weight =
   HRr × 0,64 × e^(1,92 × HRr), summed per minute and divided by 60 min × the weight at
   threshold HR, × 100. Needs ≥ 60 s of heart rate; without a stream: the average HR over the
   timer time.
4. **None** — no power and no heart rate: in totals, not in fitness.

### Fitness model (daily)

- Daily load = sum of the day's activities (local date); no training = 0.
- Fitness (CTL) += (load − CTL) × (1 − e^(−1/42)) ≈ 2,35 %; Fatigue (ATL) the same with 7 days
  ≈ 13,31 %. Both start at 0 on the first day with a load.
- Form (TSB) = yesterday's CTL − yesterday's ATL. Ramp rate = CTL − CTL 7 days ago.
- Pills on the Fitness chart: **Max fitness** = the highest CTL of the shown period; **Max
  fatigue** = the highest average ATL over 7 days in a row in the shown period (one day's peak
  says little), placed at the last day of that week.
- The activity page's **Load** tile shows the activity's own load (the one the calendar adds up
  and fitness and fatigue are built from), next to Garmin's training load (its own scale) and
  the Body Battery change (both from Garmin Connect, not computed here).
- The model is Banister's impulse-response model (fitness and fatigue as decaying sums of
  training load), in the 42 / 7-day form used by performance-management charts.
- Form zones: Detraining > 25, Fresh 5 to 25, Neutral −10 to 5, Productive −30 to −10,
  Overreaching < −30 (limits after Joe Friel). Ramp: Too fast > 8, Building 0 to 8, Losing fitness < 0.

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

## Record notifications (Home Assistant)

- Only runs and rides. Lists: per person and group, run time over a distance (400 m, 1 km,
  1 mi, 5 km, 10 km, half and full marathon), ride time over a distance (5–100 km), power over
  a duration (all time: 5 s to 5 h; this year: 20 min and 1 h only), the longest distance, the
  top speed over 1 min (rides), and per segment — indoor rides' distances, times and top speed
  on lists of their own; each with its 3 best results of all time and of this calendar year (UTC year
  of the start, like the other year filters). Heart rate is no record. Times: lower is better;
  power, distance and top speed: higher is better; a tie goes to the earlier activity.
- A record needs a result that beat one already on the list: with 2 results on a list a new
  third is no record, a new first or second is. The difference is to the result it pushed down
  at that place; for first place that is the old record.
- One notification per record. It names the all-time place when there is one (adding
  "2026 record" when the year place is better), else the place of this year.
- Only activities started in the last 14 days count, so importing history never notifies.
- Labels use the app's number format: `21:20`, `4:16 /km`, `32,1 km/h`, `310 W`, `12,35 km`,
  differences `20 s`, `0,4 s` (below 10 s), `1:05` (a minute or more), `10 W`.
