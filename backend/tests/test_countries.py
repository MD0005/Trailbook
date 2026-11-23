"""The country of a route, from the shipped country outlines."""

from __future__ import annotations

from trailbook import countries


def test_country_of_a_point():
    assert countries.country_at(50.06, 19.94) == "POL"
    assert countries.country_at(-41.29, 174.78) == "NZL"
    assert countries.country_at(54.9, 17.0) is None  # the Baltic Sea
    assert countries.names()["NZL"] == "New Zealand"


def test_route_starting_at_sea_takes_the_first_point_on_land():
    lat = [54.9, 54.8, 54.6, 54.5]
    lon = [17.0, 17.2, 17.5, 17.6]
    assert countries.of_route((54.9, 17.0), lat, lon) == "POL"
    assert countries.of_route(None, None, None) is None
