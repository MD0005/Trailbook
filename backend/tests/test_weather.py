"""Weather from Open-Meteo: picking the activity's hour (no network)."""

from datetime import UTC, datetime

from trailbook import weather


def test_the_hour_nearest_to_the_moment_is_used():
    data = {"hourly": {
        "time": ["2026-07-04T15:00", "2026-07-04T16:00", "2026-07-04T17:00"],
        "temperature_2m": [20.0, 21.0, 22.0], "wind_speed_10m": [5, 6, 7],
        "wind_direction_10m": [90, 180, 270], "rain": [0, 0.4, 0], "precipitation": [0, 0.4, 0],
        "weather_code": [1, 61, 2],
    }}  # fmt: skip
    got = weather._hour(data, datetime(2026, 7, 4, 15, 40, tzinfo=UTC))
    assert got["temperature_2m"] == 21.0 and got["weather_code"] == 61
    assert weather._hour(data, datetime(2026, 7, 4, 15, 10, tzinfo=UTC))["temperature_2m"] == 20.0
    assert weather._hour(data, datetime(2026, 7, 5, 9, 0, tzinfo=UTC)) is None
