"""GPX / TCX files and Strava exports (synthetic files, no personal data)."""

import gzip
import zipfile
from datetime import UTC, datetime

from trailbook import importer, strava, trackfile

START = datetime(2019, 6, 1, 6, 0, 0, tzinfo=UTC)


def gpx(n=60, sport="running", name="Morning Run", start="2019-06-01T06:00:00Z") -> bytes:
    base = datetime.fromisoformat(start.replace("Z", "+00:00")).timestamp()
    pts = []
    for i in range(n):
        t = datetime.fromtimestamp(base + i * 2, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        pts.append(
            f'<trkpt lat="{52.0 + i * 0.00005:.6f}" lon="21.0"><ele>{100 + i * 0.5}</ele>'
            f"<time>{t}</time><extensions><gpxtpx:TrackPointExtension>"
            f"<gpxtpx:hr>{140 + i % 5}</gpxtpx:hr><gpxtpx:cad>85</gpxtpx:cad>"
            f"<gpxtpx:atemp>18</gpxtpx:atemp></gpxtpx:TrackPointExtension>"
            f"<power>{200 + i}</power></extensions></trkpt>"
        )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<gpx creator="StravaGPX" version="1.1" xmlns="http://www.topografix.com/GPX/1/1" '
        'xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">'
        f"<metadata><time>{start}</time></metadata>"
        f"<trk><name>{name}</name><type>{sport}</type><trkseg>{''.join(pts)}</trkseg></trk></gpx>"
    ).encode()


def tcx() -> bytes:
    pts = []
    for i in range(30):
        t = datetime.fromtimestamp(START.timestamp() + 3600 + i * 5, UTC)
        pts.append(
            f"<Trackpoint><Time>{t.strftime('%Y-%m-%dT%H:%M:%SZ')}</Time>"
            "<Position><LatitudeDegrees>52.1</LatitudeDegrees>"
            f"<LongitudeDegrees>{21.0 + i * 0.0003:.5f}</LongitudeDegrees></Position>"
            f"<AltitudeMeters>{120 - i}</AltitudeMeters><DistanceMeters>{i * 30}</DistanceMeters>"
            f"<HeartRateBpm><Value>{130 + i}</Value></HeartRateBpm><Cadence>90</Cadence>"
            f"<Extensions><TPX><Speed>6.0</Speed><Watts>{180 + i}</Watts></TPX></Extensions>"
            "</Trackpoint>"
        )
    return (
        '<?xml version="1.0"?><TrainingCenterDatabase '
        'xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">'
        '<Activities><Activity Sport="Biking"><Id>2019-06-01T07:00:00Z</Id>'
        '<Lap StartTime="2019-06-01T07:00:00Z"><TotalTimeSeconds>145</TotalTimeSeconds>'
        "<DistanceMeters>870</DistanceMeters><Calories>40</Calories>"
        "<AverageHeartRateBpm><Value>144</Value></AverageHeartRateBpm>"
        f"<Intensity>Active</Intensity><Track>{''.join(pts)}</Track></Lap>"
        "</Activity></Activities></TrainingCenterDatabase>"
    ).encode()


CSV = (
    "Activity ID,Activity Date,Activity Name,Activity Type,Activity Description,"
    "Elapsed Time,Distance,Max Heart Rate,Relative Effort,Commute,Activity Gear,Filename,"
    "Elapsed Time,Moving Time,Distance,Elevation Gain,Calories\n"
    '1,"Jun 1, 2019, 6:00:00 AM",Park loop,Run,"Easy one\nwith friends",'
    "118,0.33,,,false,,activities/1.gpx.gz,118,118,330.5,29,250\n"
    '2,"Jun 1, 2019, 7:00:00 AM",Bike to work,Ride,,145,0.87,,,true,,activities/2.tcx,'
    "145,145,870,0,\n"
    '3,"Jun 2, 2019, 5:30:00 PM",Gym,Weight Training,Legs,3600,0,,,false,,,3600,3600,0,,300\n'
)


def strava_zip(path):
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("activities.csv", CSV)
        zf.writestr("activities/1.gpx.gz", gzip.compress(gpx()))
        zf.writestr("activities/2.tcx", tcx())
        zf.writestr("media/photo.jpg", b"not an activity")
    return path


def add_person(conn, pid="alice"):
    conn.execute("INSERT INTO persons (id, label) VALUES (?, ?)", (pid, pid.title()))


def import_upload(conn, tmp_path, name, data, person="alice"):
    uploads = tmp_path / "uploads"
    target = uploads / person / name
    target.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, bytes):
        target.write_bytes(data)
    queued = importer.register_upload(conn, uploads, person, target)
    result = importer.run_queue(conn, None, uploads_dir=uploads)
    return queued, result


def test_gpx_streams_and_summary():
    p = trackfile.parse(gpx())
    assert p.activity_type == "run" and p.title == "Morning Run"
    assert p.start_time == START
    for channel in ("time", "distance", "lat", "lon", "altitude", "hr", "cadence", "power",
                    "temperature", "speed"):  # fmt: skip
        assert channel in p.streams, channel
    assert p.streams["cadence"][0] == 170  # per foot in the file, both feet stored
    assert 300 < p.summary["distance_m"] < 340
    assert p.summary["ascent_m"] > 25 and p.summary["has_gps"] == 1
    assert p.summary["avg_hr"] == 142 and p.summary["max_power"] == 259


def test_tcx_laps_and_totals():
    p = trackfile.parse(tcx())
    assert p.activity_type == "ride"
    assert p.summary["distance_m"] == 870 and p.summary["calories"] == 40
    assert len(p.laps) == 1 and p.laps[0].avg_hr == 144 and p.laps[0].intensity == "active"
    assert p.streams["speed"][0] == 6.0 and p.streams["power"][-1] == 209


def test_gunzip_and_kind():
    assert trackfile.kind(trackfile.gunzip(gzip.compress(gpx()))) == "gpx"
    assert trackfile.kind(b"hello") is None


def test_strava_csv_rows():
    rows = strava.parse_csv(CSV)
    assert rows["activities/1.gpx.gz"].title == "Park loop"
    assert rows["activities/1.gpx.gz"].values["distance_m"] == 330.5  # the metre column
    assert rows["activities/1.gpx.gz"].description == "Easy one\nwith friends"
    manual = rows["activities.csv#3"]
    assert manual.kind == "Weight Training" and manual.start == datetime(
        2019, 6, 2, 17, 30, tzinfo=UTC
    )


def test_strava_export_zip(conn, tmp_path):
    add_person(conn)
    path = tmp_path / "uploads" / "alice" / "export.zip"
    path.parent.mkdir(parents=True, exist_ok=True)
    strava_zip(path)
    queued, result = import_upload(conn, tmp_path, "export.zip", None)
    assert queued == 3 and result.imported == 3 and result.errors == 0
    acts = {
        r["name"]: r
        for r in conn.execute("SELECT * FROM activities WHERE person_id = 'alice'").fetchall()
    }
    assert set(acts) == {"Park loop", "Bike to work", "Gym"}
    assert acts["Park loop"]["description"] == "Easy one\nwith friends"
    assert acts["Park loop"]["calories"] == 250  # from the CSV, the GPX has none
    assert acts["Gym"]["activity_type"] == "strength" and acts["Gym"]["moving_s"] == 3600
    assert acts["Gym"]["has_gps"] == 0
    # Warsaw in June: UTC+2 from the longitude and EU summer time
    assert acts["Park loop"]["utc_offset_s"] == 7200

    # The same export again: nothing new.
    again = tmp_path / "uploads" / "alice" / "export2.zip"
    strava_zip(again)
    queued, result = import_upload(conn, tmp_path, "export2.zip", None)
    assert result.imported == 0 and result.duplicates == 3


def test_copy_of_existing_activity_is_duplicate(conn, tmp_path):
    add_person(conn)
    _, first = import_upload(conn, tmp_path, "a.gpx", gpx())
    # Another recording of the same run (e.g. a Strava copy), a few seconds later.
    _, second = import_upload(conn, tmp_path, "b.gpx", gpx(n=50, start="2019-06-01T06:00:20Z"))
    assert first.imported == 1 and second.duplicates == 1


def test_damaged_files_are_skipped(conn, tmp_path):
    add_person(conn)
    _, r = import_upload(conn, tmp_path, "bad.gpx", b"<gpx><trk></trk></gpx>")
    assert r.skipped == 1
    row = conn.execute("SELECT skip_reason FROM files").fetchone()
    assert "no track points" in row["skip_reason"]


def test_eu_summer():
    assert importer.eu_summer(datetime(2024, 3, 31, 0, 59, tzinfo=UTC)) == 0
    assert importer.eu_summer(datetime(2024, 3, 31, 1, 0, tzinfo=UTC)) == 1
    assert importer.eu_summer(datetime(2024, 10, 27, 1, 0, tzinfo=UTC)) == 0
