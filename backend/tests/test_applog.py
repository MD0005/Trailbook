"""The app log: the same lines in the file (Settings › Log) as on the console."""

import logging

from trailbook import applog


def test_log_lines_are_read_back_newest_first(tmp_path):
    db_path = tmp_path / "trailbook.db"
    applog.setup(db_path, console=False)
    try:
        log = logging.getLogger("trailbook.garmin")
        log.info("Garmin: 3 activities downloaded")
        log.debug("not kept")
        try:
            raise ValueError("bad summary")
        except ValueError:
            log.exception("Import run failed")
        logging.getLogger("uvicorn.error").warning("from a library")
        logging.getLogger("other").info("library info is not kept")
    finally:
        applog.setup(db_path, console=False)  # closes the file
        for h in list(applog._handlers):
            logging.getLogger().removeHandler(h)
            h.close()
        applog._handlers.clear()
    entries = applog.read(db_path)
    assert [(e["level"], e["area"]) for e in entries] == [
        ("WARNING", "uvicorn.error"),
        ("ERROR", "garmin"),
        ("INFO", "garmin"),
    ]
    assert entries[1]["message"].startswith("Import run failed\nTraceback")
    assert "ValueError: bad summary" in entries[1]["message"]
    assert entries[2]["time"].endswith("Z")
    assert applog.read(tmp_path / "missing" / "x.db") == []
