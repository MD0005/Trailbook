# Garmin data catalogue

What Trailbook can get from a Garmin watch, as a basis for designing charts and views.
Two sources are compared:

- **FIT** — files written by the watch: activity files (what Trailbook imports today) and,
  in a Garmin bulk export or from the watch itself, wellness files (monitoring, sleep, HRV,
  metrics, weight). Raw, full resolution, but only what the watch itself measured.
- **API** — Garmin Connect services (`personal.connectapi.garmin.com`, see SPEC §3a). Garmin's
  processed results: scores, statuses, values computed on Garmin's servers, manual entries
  and edits made in the Connect app.

An activity downloaded through the API (`download-service/files/activity/{id}`) **is the
original FIT file** — the same file as in a bulk export ZIP, with the same data. "API" in this
document means the extra JSON endpoints (activity list, activity details, weather, wellness
services); their values have to be fetched and stored separately next to the FIT file.

So: files (folder, upload, export) give everything without a marker plus **[FIT only]**; the
Garmin Connect API gives all of that (it downloads the same FIT files) plus **[API only]** —
the most complete set, and the recommended data connection. The one exception are
wellness-only FIT details (e.g. overnight R-R intervals): through the API they need the
wellness FIT download, not yet verified with the personal API key. A bulk export also carries
much of the lifestyle JSON, so it can fill the history once.

Markers:

- no marker — available in both
- **[FIT only]** — not in the API (or only as a picture, not as data)
- **[API only]** — not in FIT files
- *(differs: …)* — in both, but with a difference that matters for charts

Notes that apply to everything:

- Availability depends on the watch model and its settings (e.g. running dynamics need a
  chest strap or RD pod, power needs a power meter or a running-power watch, HRV logging
  must be switched on).
- Edits made in Garmin Connect (activity renamed, type changed, start/end trimmed, weight
  entered by hand) exist only in the API; the FIT file stays as the watch wrote it.
- Activities entered by hand in Connect (no watch) exist only in the API, without a FIT file.
- The Garmin bulk export (account data request) also contains JSON files with many of the
  API values (daily summaries, sleep, metrics, weight, hydration) — a third way to load the
  lifestyle history without calling the API day by day.
- The daily summary (`/usersummary-service/v2/dailysummaries`, steps, floors, stress, resting HR,
  Body Battery, calories, intensity minutes) works with the personal API key and is stored
  (`garmin_days`, SPEC §3a); the other wellness endpoints are not tested yet.
  Fields marked *undocumented* are written by newer watches in FIT, but are not part of the
  public FIT profile; values may change between firmware versions.

---

## 1. Activities

### 1.1 Activity summary (one value per activity)

General

- Sport, sub-sport, indoor / outdoor
- Start time (UTC and local offset), elapsed time, timer time
- *(Moving time: not in the FIT file, not used by Trailbook — time = the timer time)*
- Distance
- Calories (active); **[API only]** BMR calories during the activity
- Steps (walking / running)
- Device (watch model, firmware) and connected sensors with their battery state **[FIT only]**
- Activity name, description, location name **[API only]** (FIT has only a generic sport
  name such as "Run")
- Gear used (shoes, bike) and its total distance **[API only]**
- Event type (race, training, …), favourite, privacy, likes and comments **[API only]**
- Personal records set in this activity **[API only]**
- Multisport: parent activity + child legs and transitions

Heart rate

- Average, maximum, minimum HR
- Time in HR zones *(differs: FIT `time_in_zone` on newer watches, else computed from the
  stream; API `hrTimeInZones` with Garmin's zone limits)*

Speed / pace

- Average and maximum speed / pace
- Average moving speed
- Grade-adjusted pace **[API only]**
- Best pace per km / mile split (computed from the stream)

Elevation

- Total ascent, total descent
- Minimum, maximum altitude
- Average / maximum grade (computed from the stream in FIT)

Power (cycling, running power)

- Average, maximum, normalized power (NP)
- Training Stress Score, Intensity Factor (watch writes them if FTP is set)
- Work (kJ)
- Left / right balance
- Time in power zones *(differs, as for HR zones)*
- Max average power over 20 min and other durations **[API only]** as stored values (in
  FIT computed from the stream, as Trailbook does)

Cadence

- Average and maximum cadence (spm / rpm)
- Average stride length, average stroke length (swim)

Training effect and load

- Aerobic training effect (0–5), anaerobic training effect (0–5)
- Training effect label / primary benefit (base, tempo, threshold, VO2 max, anaerobic,
  sprint, recovery) **[API only]** (*undocumented* in newer FIT)
- Activity training load (Garmin's EPOC load, not Trailbook's load) **[API only]** (*undocumented* in
  newer FIT)
- VO2 max estimate after this activity **[API only]**
- Body Battery impact of the activity (e.g. −12) **[API only]**
- Stamina at start / end, potential **[FIT only]** as a stream; API gives start/end values
  on newer watches
- Recovery time recommended after the activity *(undocumented in FIT; API through training
  status)*
- Performance condition at start / after 6–20 min *(undocumented in FIT; API on some models)*

Running dynamics (summary)

- Average ground contact time, GCT balance (L/R)
- Average vertical oscillation, vertical ratio
- Average stride length

Cycling dynamics (summary)

- Torque effectiveness, pedal smoothness (L/R)
- Platform centre offset, power phase, seated / standing time

Swimming

- Pool length, number of lengths, active lengths
- Average SWOLF, strokes per length, stroke type (freestyle, back, breast, fly, drill, mixed)
- Average / best pace per 100 m
- Open water: distance, stroke rate

Strength / gym

- Sets: exercise (category + name), reps, weight, set duration, rest *(differs: API
  `exerciseSets` includes corrections the user made in Connect; FIT has what the watch
  detected)*
- Total reps, total volume (computed)

Environment

- Temperature from the watch sensor (average, min, max) — biased by body heat
- Weather from a weather station at start (temperature, feels-like, humidity, wind speed and
  direction, conditions) **[API only]**

Respiration and other

- Average / min / max respiration rate during the activity
- Average SpO2 (if Pulse Ox on during activity)
- Sweat loss estimate, fluid intake (if logged) **[API only]**
- Dive data: depth, dive time, gas, surface interval **[FIT only]**

Workout and plan

- Planned workout with steps and targets (pace / HR / power) — FIT `workout` / `workout_step`
- Step compliance (how well each step hit its target) **[API only]**

### 1.2 Laps and splits (one row per lap / split)

- Lap start, elapsed time, timer time, distance
- Average / max HR, speed, power, cadence per lap
- Ascent / descent per lap
- Lap trigger (manual, distance, time, position) and intensity (warm-up, active, rest,
  cool-down)
- Running dynamics and cycling dynamics per lap
- Swim lengths with stroke type, strokes, SWOLF per length *(differs: per-length detail is
  fuller in FIT)*
- Automatic split summaries: run / walk / stand segments, climb segments (ski runs, MTB
  climbs) **[API only]**

### 1.3 Streams (one value per second or per recording interval)

*(differs: FIT has every recorded sample, usually 1 s; the API `details` endpoint returns
a downsampled series — a set number of points — and fewer channels.)*

- Time, distance
- GPS position (lat, lon)
- Altitude (barometric / GPS)
- Heart rate
- Speed / pace
- Power, left/right balance
- Cadence, fractional cadence
- Temperature
- Grade (computed)
- Respiration rate (newer watches)
- Stamina, potential **[FIT only]**
- Performance condition *(undocumented in FIT)*
- Running dynamics per second: ground contact time, GCT balance, vertical oscillation,
  vertical ratio, stride length **[FIT only]**
- Cycling dynamics per second: torque effectiveness, pedal smoothness, platform centre
  offset, power phase **[FIT only]**
- Beat-to-beat R-R intervals (HRV during the activity) **[FIT only]**
- SpO2 during the activity (if enabled)
- Gear changes (electronic shifting), radar alerts, events (start, pause, lap button,
  alerts) **[FIT only]**
- Core body temperature (CORE sensor) **[FIT only]**

---

## 2. Lifestyle (wellness)

In FIT these come from wellness files (monitoring, sleep, HRV status, metrics), which
Trailbook skips today; they are available in a Garmin bulk export or from the watch, not
through the activity download.

### 2.1 Daily activity

- Steps: daily total, daily goal, distance; steps per 15 min interval
- Floors climbed / descended, floor goal
- Intensity minutes: moderate, vigorous (counted ×2), weekly goal
- Calories: total, active, resting (BMR)
- Activity type during the day: sedentary, active, walking, running (monitoring samples;
  API as Move IQ events)
- Move bar / inactivity alerts **[API only]** as a daily value
- Daily goals and streaks, badges, challenges **[API only]**

### 2.2 Heart rate

- All-day heart rate samples (every 1–2 min, more often during activity)
- Resting heart rate per day *(differs: API value is Garmin's official RHR; FIT monitoring
  has a resting HR field on newer watches)*
- 7-day average resting HR **[API only]**
- Daily min / max HR
- High / low HR alerts **[API only]**

### 2.3 Stress and Body Battery

- All-day stress level (0–100, every 3 min; −1/−2 = activity or not measurable)
- Daily average and maximum stress, time in rest / low / medium / high stress *(API gives
  them directly; from FIT computed from the samples)*
- Body Battery level over the day (5–100) **[API only]** (*undocumented* in newer FIT
  monitoring)
- Body Battery charged / drained per day, highest / lowest, value at wake-up **[API only]**
- Body Battery events: sleep, activity, stress, recovery, naps — each with its impact
  **[API only]**

### 2.4 Sleep

- Sleep start and end, total sleep time
- Sleep stages over the night: deep, light, REM, awake (timeline)
- Time in each stage per night
- Sleep score (0–100) and sub-scores (duration, quality, deep, light, REM, awake time,
  awakenings, restlessness, interruptions, recovery) *(differs: FIT `sleep_assessment` only
  on newer watches; API always)*
- Sleep feedback / insight text ("restorative", "short but deep") **[API only]**
- Sleep need (tonight's recommended sleep) and its factors **[API only]**
- Naps **[API only]**
- Restless moments, awakenings count
- Average HR, respiration, SpO2 (lowest / average) and stress during sleep
- Body Battery gained during sleep **[API only]**
- Skin temperature change vs baseline (newer watches)

### 2.5 HRV

- Nightly HRV average (ms)
- 5-minute HRV readings through the night
- 7-day average, baseline range (balanced low / upper), HRV status (balanced, unbalanced,
  low, poor) *(differs: FIT `hrv_status_summary` on newer watches; API always, with
  feedback text)*
- Highest 5-minute HRV of the night
- Beat-to-beat R-R intervals over the night **[FIT only]** (only with HRV logging on)

### 2.6 Respiration and Pulse Ox

- All-day respiration rate (breaths/min), waking and sleep averages, min / max
- SpO2 readings (spot checks, during sleep, or all-day), daily average and lowest
- Altitude acclimation info with SpO2 **[API only]**

### 2.7 Body measurements

- Weight, BMI
- Body composition (Index scale or manual): body fat %, body water %, muscle mass, bone
  mass, visceral fat, metabolic age, physique rating *(differs: FIT `weight_scale` only from
  Garmin Index scale files; API includes every source and manual entries)*
- Blood pressure (systolic, diastolic, pulse) from Index BPM or manual entry *(differs:
  manual entries API only)*
- Height, age, sex — from the user profile

### 2.8 Training state (Garmin's computed metrics)

All **[API only]** unless noted (newer watches write some to a metrics FIT file, which is
*undocumented*).

- VO2 max — running and cycling, history with dates, fitness age
- Training status (productive, maintaining, recovery, peaking, unproductive,
  overreaching, detraining, strained)
- Acute load (7-day), chronic load, load ratio
- Load focus: low aerobic / high aerobic / anaerobic, monthly totals vs target ranges
- Training readiness score (0–100) and its factors: sleep score, recovery time, HRV status,
  acute load, sleep history, stress history
- Recovery time (hours until fully recovered)
- Heat acclimation %, altitude acclimation %
- Endurance score, hill score (strength, endurance)
- Race predictions: 5 km, 10 km, half marathon, marathon (history)
- Lactate threshold: HR and pace (auto-detected, with history)
- FTP (auto-detected, with history), power-to-weight
- Personal records (fastest 1 km, 5 km, longest run, most steps in a day, …)
- Heart rate zones, max HR, resting HR used by Garmin — also in each activity FIT file
  (`zones_target`, `user_profile`), so both
- Health Status: overnight HR, HRV, respiration, SpO2, skin temperature against personal
  baseline

### 2.9 Logs and other **[API only]**

- Hydration: intake, daily goal, sweat loss
- Menstrual cycle and pregnancy tracking
- Lifestyle logging (caffeine, alcohol, late meals, … — user-defined habits)
- Nutrition (calories eaten, if logged in Connect)
- Jet lag advisor, women's health predictions
