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
`workout.interval_splits`, computed on each visit (about 15 ms), nothing stored.

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
