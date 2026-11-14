"""Mapping of FIT sport / sub_sport to Trailbook categories."""

from __future__ import annotations

CATEGORIES = ("run", "ride", "swim", "walk", "hike", "ski", "row", "strength", "other")

# Categories whose cadence is stored in steps per minute (FIT stores strides per minute).
ON_FOOT = frozenset({"run", "walk", "hike"})

_SPORT_TO_CATEGORY = {
    "running": "run",
    "cycling": "ride",
    "e_biking": "ride",
    "swimming": "swim",
    "walking": "walk",
    "hiking": "hike",
    "mountaineering": "hike",
    "cross_country_skiing": "ski",
    "alpine_skiing": "ski",
    "snowboarding": "ski",
    "backcountry_skiing": "ski",
    "rowing": "row",
    "paddling": "row",
    "kayaking": "row",
    "stand_up_paddleboarding": "row",
}

_SUB_SPORT_TO_CATEGORY = {
    "strength_training": "strength",
    "cardio_training": "strength",
    "indoor_rowing": "row",
    "indoor_walking": "walk",
    "indoor_running": "run",
    "indoor_cycling": "ride",
    "virtual_activity": None,  # keep the sport's category
}

_INDOOR_SUB_SPORTS = frozenset(
    {
        "treadmill",
        "indoor_cycling",
        "spin",
        "virtual_activity",
        "lap_swimming",
        "indoor_rowing",
        "indoor_walking",
        "indoor_running",
        "indoor_skiing",
        "elliptical",
        "stair_climbing",
    }
)


def categorize(sport: str | int | None, sub_sport: str | int | None) -> tuple[str, bool]:
    """Return (category, indoor) for a FIT sport / sub_sport pair."""
    sport_s = str(sport) if sport is not None else ""
    sub_s = str(sub_sport) if sub_sport is not None else ""

    category = _SUB_SPORT_TO_CATEGORY.get(sub_s) or _SPORT_TO_CATEGORY.get(sport_s, "other")
    indoor = sub_s in _INDOOR_SUB_SPORTS
    return category, indoor
