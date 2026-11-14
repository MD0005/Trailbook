"""Activity types and groups, mapped from FIT `sport` / `sub_sport`.

Two levels:
- **group** (stored as `activities.category`) — broad bucket for totals and filters
  (run, ride, swim, …).
- **type** (stored as `activities.activity_type`) — specific activity for analysis
  (trail_run, gravel_ride, yoga, padel, …).

Resolution order for a FIT (sport, sub_sport) pair:
1. exact pair in `_EXACT`,
2. `sub_sport` that means the same thing under any sport (`_BY_SUB_SPORT`, e.g. yoga),
3. `sport` default (`_BY_SPORT`),
4. `other`.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ActivityType:
    key: str
    group: str
    en: str
    pl: str
    indoor: bool = False


GROUPS: dict[str, tuple[str, str]] = {
    "run": ("Running", "Bieganie"),
    "ride": ("Cycling", "Kolarstwo"),
    "swim": ("Swimming", "Pływanie"),
    "walk": ("Walking", "Chodzenie"),
    "hike": ("Hiking", "Turystyka"),
    "winter": ("Winter sports", "Sporty zimowe"),
    "water": ("Water sports", "Sporty wodne"),
    "fitness": ("Fitness & gym", "Fitness i siłownia"),
    "mind_body": ("Mind & body", "Ciało i umysł"),
    "climbing": ("Climbing", "Wspinaczka"),
    "racket": ("Racket sports", "Sporty rakietowe"),
    "team": ("Team sports", "Sporty drużynowe"),
    "combat": ("Combat sports", "Sporty walki"),
    "multisport": ("Multisport", "Multisport"),
    "other": ("Other", "Inne"),
}

_T = ActivityType
_TYPE_LIST = [
    # run
    _T("run", "run", "Run", "Bieg"),
    _T("trail_run", "run", "Trail run", "Bieg terenowy"),
    _T("treadmill_run", "run", "Treadmill run", "Bieżnia mechaniczna", indoor=True),
    _T("indoor_run", "run", "Indoor run", "Bieg w hali", indoor=True),
    _T("track_run", "run", "Track run", "Bieg na stadionie"),
    _T("virtual_run", "run", "Virtual run", "Bieg wirtualny", indoor=True),
    _T("ultra_run", "run", "Ultra run", "Bieg ultra"),
    _T("obstacle_run", "run", "Obstacle run", "Bieg z przeszkodami"),
    _T("wheelchair_run", "run", "Wheelchair push run", "Wózek – bieg"),
    # ride
    _T("ride", "ride", "Ride", "Jazda na rowerze"),
    _T("road_ride", "ride", "Road ride", "Kolarstwo szosowe"),
    _T("mtb_ride", "ride", "Mountain bike", "Rower górski (MTB)"),
    _T("gravel_ride", "ride", "Gravel ride", "Gravel"),
    _T("cyclocross", "ride", "Cyclocross", "Przełaj"),
    _T("downhill_ride", "ride", "Downhill", "Downhill"),
    _T("enduro_ride", "ride", "Enduro", "Enduro"),
    _T("indoor_ride", "ride", "Indoor ride", "Trenażer", indoor=True),
    _T("spin", "ride", "Spin class", "Spinning", indoor=True),
    _T("virtual_ride", "ride", "Virtual ride", "Jazda wirtualna", indoor=True),
    _T("ebike_ride", "ride", "E-bike ride", "Rower elektryczny"),
    _T("emtb_ride", "ride", "E-mountain bike", "Elektryczny MTB"),
    _T("commute_ride", "ride", "Bike commute", "Dojazd rowerem"),
    _T("track_ride", "ride", "Track cycling", "Kolarstwo torowe"),
    _T("bmx", "ride", "BMX", "BMX"),
    _T("handcycle", "ride", "Handcycle", "Handbike"),
    _T("recumbent", "ride", "Recumbent", "Rower poziomy"),
    # swim
    _T("swim", "swim", "Swim", "Pływanie"),
    _T("pool_swim", "swim", "Pool swim", "Basen", indoor=True),
    _T("open_water_swim", "swim", "Open water swim", "Wody otwarte"),
    # walk
    _T("walk", "walk", "Walk", "Spacer"),
    _T("speed_walk", "walk", "Speed walk", "Szybki marsz"),
    _T("indoor_walk", "walk", "Indoor walk", "Chód w pomieszczeniu", indoor=True),
    _T("rucking", "walk", "Rucking", "Marsz z obciążeniem"),
    _T("wheelchair_walk", "walk", "Wheelchair push", "Wózek – spacer"),
    # hike
    _T("hike", "hike", "Hike", "Wędrówka"),
    _T("mountaineering", "hike", "Mountaineering", "Alpinizm"),
    # winter
    _T("ski_alpine", "winter", "Alpine ski", "Narciarstwo zjazdowe"),
    _T("ski_backcountry", "winter", "Backcountry ski", "Skitury"),
    _T("ski_xc", "winter", "Cross-country ski", "Narciarstwo biegowe"),
    _T("ski_skate", "winter", "Skate ski", "Biegówki – łyżwa"),
    _T("ski_indoor", "winter", "Indoor ski", "Narty w hali / ergometr", indoor=True),
    _T("snowboard", "winter", "Snowboard", "Snowboard"),
    _T("snowshoe", "winter", "Snowshoe", "Rakiety śnieżne"),
    _T("ice_skate", "winter", "Ice skating", "Łyżwy"),
    _T("winter_other", "winter", "Winter sport", "Sport zimowy"),
    # water
    _T("row", "water", "Rowing", "Wioślarstwo"),
    _T("kayak", "water", "Kayaking", "Kajak"),
    _T("canoe", "water", "Canoeing", "Kanadyjka"),
    _T("paddle", "water", "Paddling", "Wiosłowanie"),
    _T("sup", "water", "Stand up paddle", "SUP"),
    _T("surf", "water", "Surfing", "Surfing"),
    _T("windsurf", "water", "Windsurfing", "Windsurfing"),
    _T("kitesurf", "water", "Kitesurfing", "Kitesurfing"),
    _T("sail", "water", "Sailing", "Żeglarstwo"),
    _T("rafting", "water", "Rafting", "Rafting"),
    _T("wakeboard", "water", "Wakeboarding", "Wakeboard"),
    _T("wakesurf", "water", "Wakesurfing", "Wakesurfing"),
    _T("water_ski", "water", "Water skiing", "Narty wodne"),
    _T("snorkel", "water", "Snorkeling", "Snorkeling"),
    _T("dive", "water", "Diving", "Nurkowanie"),
    _T("apnea", "water", "Freediving", "Freediving"),
    _T("boating", "water", "Boating", "Pływanie łodzią"),
    _T("water_other", "water", "Water sport", "Sport wodny"),
    # fitness
    _T("strength", "fitness", "Strength training", "Trening siłowy"),
    _T("hiit", "fitness", "HIIT", "HIIT"),
    _T("cardio", "fitness", "Cardio", "Cardio"),
    _T("training", "fitness", "Training", "Trening"),
    _T("gym_equipment", "fitness", "Gym equipment", "Sprzęt fitness", indoor=True),
    _T("elliptical", "fitness", "Elliptical", "Orbitrek", indoor=True),
    _T("stair_stepper", "fitness", "Stair stepper", "Stepper / schody", indoor=True),
    _T("indoor_row", "fitness", "Indoor rowing", "Ergometr wioślarski", indoor=True),
    _T("floor_climb", "fitness", "Floor climbing", "Wchodzenie po schodach"),
    _T("jump_rope", "fitness", "Jump rope", "Skakanka"),
    _T("dance", "fitness", "Dance", "Taniec"),
    _T("warm_up", "fitness", "Warm-up", "Rozgrzewka"),
    # mind & body
    _T("yoga", "mind_body", "Yoga", "Joga"),
    _T("pilates", "mind_body", "Pilates", "Pilates"),
    _T("stretching", "mind_body", "Stretching", "Rozciąganie"),
    _T("mobility", "mind_body", "Mobility", "Mobilność"),
    _T("meditation", "mind_body", "Meditation", "Medytacja"),
    _T("breathwork", "mind_body", "Breathwork", "Ćwiczenia oddechowe"),
    # climbing
    _T("climb", "climbing", "Rock climbing", "Wspinaczka skałkowa"),
    _T("indoor_climb", "climbing", "Indoor climbing", "Ścianka", indoor=True),
    _T("bouldering", "climbing", "Bouldering", "Bouldering"),
    # racket
    _T("tennis", "racket", "Tennis", "Tenis"),
    _T("padel", "racket", "Padel", "Padel"),
    _T("pickleball", "racket", "Pickleball", "Pickleball"),
    _T("squash", "racket", "Squash", "Squash"),
    _T("badminton", "racket", "Badminton", "Badminton"),
    _T("table_tennis", "racket", "Table tennis", "Tenis stołowy"),
    _T("racquetball", "racket", "Racquetball", "Racquetball"),
    _T("racket", "racket", "Racket sport", "Sport rakietowy"),
    # team
    _T("soccer", "team", "Soccer", "Piłka nożna"),
    _T("basketball", "team", "Basketball", "Koszykówka"),
    _T("volleyball", "team", "Volleyball", "Siatkówka"),
    _T("hockey", "team", "Hockey", "Hokej"),
    _T("rugby", "team", "Rugby", "Rugby"),
    _T("american_football", "team", "American football", "Futbol amerykański"),
    _T("baseball", "team", "Baseball", "Baseball"),
    _T("cricket", "team", "Cricket", "Krykiet"),
    _T("lacrosse", "team", "Lacrosse", "Lacrosse"),
    _T("ultimate", "team", "Ultimate", "Ultimate frisbee"),
    _T("team_sport", "team", "Team sport", "Sport drużynowy"),
    # combat
    _T("boxing", "combat", "Boxing", "Boks"),
    _T("mma", "combat", "Mixed martial arts", "MMA"),
    # multisport
    _T("multisport", "multisport", "Multisport", "Multisport"),
    _T("triathlon", "multisport", "Triathlon", "Triathlon"),
    _T("duathlon", "multisport", "Duathlon", "Duathlon"),
    _T("swimrun", "multisport", "Swimrun", "Swimrun"),
    _T("transition", "multisport", "Transition", "Strefa zmian"),
    # other
    _T("golf", "other", "Golf", "Golf"),
    _T("disc_golf", "other", "Disc golf", "Disc golf"),
    _T("horse_riding", "other", "Horse riding", "Jazda konna"),
    _T("inline_skate", "other", "Inline skating", "Rolki"),
    _T("motor", "other", "Motor sports", "Sporty motorowe"),
    _T("flying", "other", "Flying", "Latanie"),
    _T("fishing", "other", "Fishing", "Wędkarstwo"),
    _T("hunting", "other", "Hunting", "Myślistwo"),
    _T("archery", "other", "Archery", "Łucznictwo"),
    _T("shooting", "other", "Shooting", "Strzelectwo"),
    _T("geocaching", "other", "Geocaching", "Geocaching"),
    _T("esports", "other", "Esports", "E-sport", indoor=True),
    _T("other", "other", "Other", "Inne"),
]

TYPES: dict[str, ActivityType] = {t.key: t for t in _TYPE_LIST}

# Cadence of these types is stored in steps per minute (FIT stores strides per minute).
ON_FOOT_GROUPS = frozenset({"run", "walk", "hike"})

_EXACT: dict[tuple[str, str], str] = {
    ("running", "trail"): "trail_run",
    ("running", "treadmill"): "treadmill_run",
    ("running", "indoor_running"): "indoor_run",
    ("running", "track"): "track_run",
    ("running", "virtual_activity"): "virtual_run",
    ("running", "ultra"): "ultra_run",
    ("running", "obstacle"): "obstacle_run",
    ("running", "street"): "run",
    ("cycling", "road"): "road_ride",
    ("cycling", "mountain"): "mtb_ride",
    ("cycling", "gravel_cycling"): "gravel_ride",
    ("cycling", "mixed_surface"): "gravel_ride",
    ("cycling", "cyclocross"): "cyclocross",
    ("cycling", "downhill"): "downhill_ride",
    ("cycling", "enduro"): "enduro_ride",
    ("cycling", "indoor_cycling"): "indoor_ride",
    ("cycling", "spin"): "spin",
    ("cycling", "virtual_activity"): "virtual_ride",
    ("cycling", "commuting"): "commute_ride",
    ("cycling", "track_cycling"): "track_ride",
    ("cycling", "bmx"): "bmx",
    ("cycling", "hand_cycling"): "handcycle",
    ("cycling", "indoor_hand_cycling"): "handcycle",
    ("cycling", "recumbent"): "recumbent",
    ("cycling", "e_bike_fitness"): "ebike_ride",
    ("cycling", "e_bike_mountain"): "emtb_ride",
    ("cycling", "e_bike_enduro"): "emtb_ride",
    ("e_biking", "e_bike_mountain"): "emtb_ride",
    ("e_biking", "e_bike_enduro"): "emtb_ride",
    ("fitness_equipment", "indoor_cycling"): "indoor_ride",
    ("fitness_equipment", "indoor_running"): "indoor_run",
    ("fitness_equipment", "indoor_walking"): "indoor_walk",
    ("fitness_equipment", "indoor_skiing"): "ski_indoor",
    ("swimming", "lap_swimming"): "pool_swim",
    ("swimming", "open_water"): "open_water_swim",
    ("walking", "casual_walking"): "walk",
    ("walking", "speed_walking"): "speed_walk",
    ("walking", "indoor_walking"): "indoor_walk",
    ("walking", "rucking"): "rucking",
    ("hiking", "rucking"): "rucking",
    ("cross_country_skiing", "skate_skiing"): "ski_skate",
    ("cross_country_skiing", "indoor_skiing"): "ski_indoor",
    ("cross_country_skiing", "backcountry"): "ski_backcountry",
    ("alpine_skiing", "backcountry"): "ski_backcountry",
    ("alpine_skiing", "resort"): "ski_alpine",
    ("snowboarding", "backcountry"): "snowboard",
    ("paddling", "whitewater"): "kayak",
    ("rowing", "indoor_rowing"): "indoor_row",
    ("diving", "apnea_diving"): "apnea",
    ("diving", "apnea_hunting"): "apnea",
    ("diving", "dynamic_apnea"): "apnea",
    ("team_sport", "ultimate"): "ultimate",
    ("multisport", "swim_run"): "swimrun",
    ("multisport", "brick"): "multisport",
}

# Sub-sports that identify the activity regardless of the sport they come with.
_BY_SUB_SPORT: dict[str, str] = {
    "treadmill": "treadmill_run",
    "lap_swimming": "pool_swim",
    "open_water": "open_water_swim",
    "strength_training": "strength",
    "cardio_training": "cardio",
    "flexibility_training": "stretching",
    "yoga": "yoga",
    "pilates": "pilates",
    "breathing": "breathwork",
    "hiit": "hiit",
    "amrap": "hiit",
    "emom": "hiit",
    "tabata": "hiit",
    "warm_up": "warm_up",
    "elliptical": "elliptical",
    "stair_climbing": "stair_stepper",
    "indoor_rowing": "indoor_row",
    "indoor_climbing": "indoor_climb",
    "bouldering": "bouldering",
    "badminton": "badminton",
    "squash": "squash",
    "padel": "padel",
    "pickleball": "pickleball",
    "table_tennis": "table_tennis",
    "racquetball": "racquetball",
    "triathlon": "triathlon",
    "pool_triathlon": "triathlon",
    "duathlon": "duathlon",
    "swim_run": "swimrun",
    "esport": "esports",
}

_BY_SPORT: dict[str, str] = {
    "running": "run",
    "cycling": "ride",
    "e_biking": "ebike_ride",
    "swimming": "swim",
    "pool_apnea": "apnea",
    "walking": "walk",
    "wheelchair_push_walk": "wheelchair_walk",
    "wheelchair_push_run": "wheelchair_run",
    "hiking": "hike",
    "mountaineering": "mountaineering",
    "cross_country_skiing": "ski_xc",
    "alpine_skiing": "ski_alpine",
    "snowboarding": "snowboard",
    "snowshoeing": "snowshoe",
    "ice_skating": "ice_skate",
    "winter_sport": "winter_other",
    "rowing": "row",
    "kayaking": "kayak",
    "canoeing": "canoe",
    "paddling": "paddle",
    "stand_up_paddleboarding": "sup",
    "surfing": "surf",
    "windsurfing": "windsurf",
    "kitesurfing": "kitesurf",
    "sailing": "sail",
    "grinding": "sail",
    "rafting": "rafting",
    "wakeboarding": "wakeboard",
    "wakesurfing": "wakesurf",
    "water_skiing": "water_ski",
    "water_tubing": "water_other",
    "water_sport": "water_other",
    "snorkeling": "snorkel",
    "diving": "dive",
    "boating": "boating",
    "training": "training",
    "fitness_equipment": "gym_equipment",
    "hiit": "hiit",
    "floor_climbing": "floor_climb",
    "jump_rope": "jump_rope",
    "dance": "dance",
    "meditation": "meditation",
    "mobility": "mobility",
    "rock_climbing": "climb",
    "tennis": "tennis",
    "racket": "racket",
    "soccer": "soccer",
    "basketball": "basketball",
    "volleyball": "volleyball",
    "hockey": "hockey",
    "rugby": "rugby",
    "american_football": "american_football",
    "baseball": "baseball",
    "cricket": "cricket",
    "lacrosse": "lacrosse",
    "team_sport": "team_sport",
    "boxing": "boxing",
    "mixed_martial_arts": "mma",
    "multisport": "multisport",
    "transition": "transition",
    "golf": "golf",
    "disc_golf": "disc_golf",
    "horseback_riding": "horse_riding",
    "inline_skating": "inline_skate",
    "motorcycling": "motor",
    "motor_sports": "motor",
    "driving": "motor",
    "snowmobiling": "motor",
    "flying": "flying",
    "hang_gliding": "flying",
    "sky_diving": "flying",
    "jumpmaster": "flying",
    "fishing": "fishing",
    "hunting": "hunting",
    "archery": "archery",
    "shooting": "shooting",
    "geocaching": "geocaching",
    "video_gaming": "esports",
}

# Sub-sports that make any activity indoor, even if its type usually is not.
_INDOOR_SUB_SPORTS = frozenset(
    {
        "treadmill",
        "indoor_cycling",
        "indoor_hand_cycling",
        "spin",
        "virtual_activity",
        "lap_swimming",
        "pool_triathlon",
        "indoor_rowing",
        "indoor_running",
        "indoor_walking",
        "indoor_skiing",
        "indoor_climbing",
        "indoor_wheelchair_run",
        "indoor_wheelchair_walk",
        "elliptical",
        "stair_climbing",
    }
)


def resolve_type(sport: str | int | None, sub_sport: str | int | None) -> ActivityType:
    sport_s = str(sport) if sport is not None else ""
    sub_s = str(sub_sport) if sub_sport is not None else ""
    key = (
        _EXACT.get((sport_s, sub_s))
        or _BY_SUB_SPORT.get(sub_s)
        or _BY_SPORT.get(sport_s)
        or "other"
    )
    return TYPES[key]


def classify(sport: str | int | None, sub_sport: str | int | None) -> tuple[str, str, bool]:
    """Return (group, type, indoor) for a FIT sport / sub_sport pair."""
    t = resolve_type(sport, sub_sport)
    indoor = t.indoor or (str(sub_sport) in _INDOOR_SUB_SPORTS if sub_sport else False)
    return t.group, t.key, indoor
