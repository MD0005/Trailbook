"""Daily values from monitoring files (steps, floors, stress) and the Calendar API."""

import struct

from trailbook import analysis, fitfile, importer, weather

# FIT base types: (code, struct format)
U8, U16, S16, U32, ENUM = (0x02, "B"), (0x84, "H"), (0x83, "h"), (0x86, "I"), (0x00, "B")

MIDNIGHT = 1152136800  # FIT time of 2026-07-04T22:00Z = local midnight at UTC+2
WALKING = 6


def fit_file(messages: list[tuple[int, list[tuple[int, tuple, int]]]]) -> bytes:
    """A FIT file of (global message number, [(field number, base type, value)]); each message
    gets its own local definition."""
    body = b""
    for local, (num, fields) in enumerate(messages):
        local %= 16
        body += bytes([0x40 | local, 0, 0]) + struct.pack("<H", num) + bytes([len(fields)])
        body += b"".join(bytes([f, struct.calcsize(t[1]), t[0]]) for f, t, _ in fields)
        body += bytes([local]) + b"".join(struct.pack("<" + t[1], v) for _, t, v in fields)
    header = bytes([14, 0x20]) + struct.pack("<H", 2100) + struct.pack("<I", len(body)) + b".FIT"
    return header + b"\x00\x00" + body + b"\x00\x00"


def monitoring_file(serial: int = 777) -> bytes:
    walk = lambda ts, steps, asc: (  # noqa: E731
        55,
        [(253, U32, ts), (5, ENUM, WALKING), (3, U32, steps), (35, U32, asc)],
    )
    stress = lambda ts, v: (227, [(0, S16, v), (1, U32, ts)])  # noqa: E731
    return fit_file([
        (0, [(0, ENUM, 32), (3, U32, serial), (4, U32, MIDNIGHT - 7200)]),  # monitoring_b
        (103, [(253, U32, MIDNIGHT - 7200), (0, U32, MIDNIGHT)]),  # local = UTC + 2 h
        walk(MIDNIGHT - 3600, 5000, 30480),
        walk(MIDNIGHT, 6000, 45720),  # the day's totals, written at midnight
        walk(MIDNIGHT + 3600, 45, 0),  # the next day
        stress(MIDNIGHT - 120, 20),
        stress(MIDNIGHT - 60, 40),
        stress(MIDNIGHT - 30, -2),  # not valid (activity)
        stress(MIDNIGHT + 60, 30),
    ])  # fmt: skip


def test_parse_monitoring_splits_local_days():
    parts = fitfile.parse_monitoring(monitoring_file())
    assert parts[("2026-07-04", "steps:walking")] == (6000, 1)
    assert parts[("2026-07-04", "ascent_mm")] == (45720, 1)
    assert parts[("2026-07-04", "stress")] == (60, 2)
    assert parts[("2026-07-05", "steps:walking")] == (45, 1)
    assert parts[("2026-07-05", "stress")] == (30, 1)


def test_monitoring_files_give_daily_values(conn, tmp_path):
    root = tmp_path / "root"
    (root / "alice").mkdir(parents=True)
    (root / "alice" / "moni.fit").write_bytes(monitoring_file())
    importer.scan(conn, root)
    importer.run_queue(conn, root)

    row = conn.execute("SELECT status, skip_reason FROM files").fetchone()
    assert (row["status"], row["skip_reason"]) == ("skipped", "monitoring_b")
    days = analysis.daily_values(conn, "alice", "2026-07-01", "2026-07-31")
    assert days["2026-07-04"] == {"steps": 6000, "floors": 15, "ascent_m": 45.7, "stress": 30}
    assert days["2026-07-05"]["steps"] == 45
    assert analysis.daily_values(conn, "bob", "2026-07-01", "2026-07-31") == {}

    # forgetting the file drops its values
    importer.forget_file(conn, conn.execute("SELECT id FROM files").fetchone()[0])
    assert analysis.daily_values(conn, "alice", "2026-07-01", "2026-07-31") == {}


def test_forecast_is_cached(monkeypatch):
    calls = []

    class Resp:
        def __init__(self, body):
            self.body = body

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return self.body

    def fake_urlopen(req, timeout):
        calls.append(req.full_url)
        return Resp(
            b'{"daily": {"time": ["2026-11-18", "2026-11-19"], "weather_code": [3, 61],'
            b' "temperature_2m_max": [6.1, null], "temperature_2m_min": [1.0, 2.0],'
            b' "precipitation_sum": [0, 4.2], "wind_speed_10m_max": [12, 20],'
            b' "wind_direction_10m_dominant": [270, 180]}}'
        )

    monkeypatch.setattr(weather.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(weather, "_forecasts", {})
    days = weather.forecast(50.0612, 19.9383, now=1000)
    assert days == [{"date": "2026-11-18", "code": 3, "temp_min": 1.0, "temp_max": 6.1,
                     "precip": 0, "wind_speed": 12, "wind_dir": 270}]  # fmt: skip
    assert "latitude=50.06" in calls[0] and "longitude=19.94" in calls[0]
    weather.forecast(50.06, 19.94, now=2000)
    assert len(calls) == 1


class FakeDays:
    """Garmin's daily summaries for any range (steps = day of month × 1000)."""

    def __init__(self):
        self.asked: list[tuple[str, str]] = []

    def __call__(self, method, url, headers, timeout):
        import json
        import urllib.parse
        from datetime import date, timedelta

        from trailbook import garmin

        parsed = urllib.parse.urlparse(url)
        if parsed.path == garmin.TOKEN_PATH:
            return 200, {}, b'{"access_token": "tok", "expires_in": 86400}'
        q = urllib.parse.parse_qs(parsed.query)
        a, b = q["startDate"][0], q["endDate"][0]
        self.asked.append((a, b))
        days, d = [], date.fromisoformat(a)
        while d <= date.fromisoformat(b):
            days.append({
                "calendarDate": d.isoformat(), "includesWellnessData": True,
                "movement": {"steps": {"value": d.day * 1000},
                             "floorsAscended": {"value": 4, "distanceInMeters": 12.3}},
                "stress": {"avgLevel": -1 if d.day == 2 else 30},
            })  # fmt: skip
            d += timedelta(days=1)
        return 200, {}, json.dumps({"data": days}).encode()


def test_garmin_days_fill_the_history_and_win_over_files(conn, tmp_path):
    from datetime import date

    from trailbook import garmin

    conn.execute("INSERT INTO persons (id, label) VALUES ('alice', 'Alice')")
    garmin.set_account(conn, "alice", "k" * 32, "2026-05-01")
    fake = FakeDays()
    client = garmin.Client("k" * 32, transport=fake, gap_s=0)
    today = date(2026, 7, 10)

    garmin.fetch_days(conn, client, "alice", today=today)
    # the last 3 days, then 4 history requests of 31 days backwards
    assert fake.asked[0] == ("2026-07-08", "2026-07-10")
    assert fake.asked[1] == ("2026-06-07", "2026-07-07")
    assert fake.asked[2] == ("2026-05-07", "2026-06-06")
    assert fake.asked[3] == ("2026-05-01", "2026-05-06")  # stops at Download from
    assert len(fake.asked) == 4
    acc = conn.execute("SELECT days_from, days_done FROM garmin_accounts").fetchone()
    assert (acc["days_from"], acc["days_done"]) == ("2026-05-01", 1)

    # next run: only the recent days
    garmin.fetch_days(conn, client, "alice", today=today)
    assert fake.asked[4:] == [("2026-07-08", "2026-07-10")]
    # the server was off for 10 days: the gap is asked for too
    garmin.fetch_days(conn, client, "alice", today=date(2026, 7, 20))
    assert fake.asked[5:] == [("2026-07-09", "2026-07-20")]
    # an earlier Download from date: the history goes on back to it
    conn.execute("UPDATE garmin_accounts SET history_from = '2026-04-15'")
    garmin.fetch_days(conn, client, "alice", today=date(2026, 7, 20))
    assert fake.asked[6:] == [("2026-07-18", "2026-07-20"), ("2026-04-15", "2026-04-30")]
    acc = conn.execute("SELECT days_from, days_to, days_done FROM garmin_accounts").fetchone()
    assert tuple(acc) == ("2026-04-15", "2026-07-20", 1)
    today = date(2026, 7, 20)

    # a monitoring file of the same day: Garmin's values win, the file fills the gaps
    root = tmp_path / "root"
    (root / "alice").mkdir(parents=True)
    (root / "alice" / "moni.fit").write_bytes(monitoring_file())
    importer.scan(conn, root)
    importer.run_queue(conn, root)
    days = analysis.daily_values(conn, "alice", "2026-05-01", "2026-07-20")
    assert days["2026-07-04"] == {"steps": 4000, "floors": 4, "ascent_m": 12.3, "stress": 30}
    assert days["2026-07-02"]["stress"] is None  # not measured
    assert len(days) == 81  # 2026-05-01 … 2026-07-20 (also the monitoring file days)
