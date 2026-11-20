"""The app log: one line format for the add-on log (stdout) and Settings › Log (a file).

Every process (the server and the background jobs it starts) logs through the root logger:
- stdout — what Home Assistant shows as the add-on's log;
- `<data>/trailbook.log` (rotated at 1 MB, two older files kept) — read by `GET /api/log`.
Both get exactly the same lines. Trailbook's own loggers (`trailbook.*`) log from INFO up;
other libraries (uvicorn, asyncio) only warnings and errors. Times are UTC.
"""

from __future__ import annotations

import logging
import logging.handlers
import re
import sys
import time
from pathlib import Path

LOG_FILE = "trailbook.log"
MAX_BYTES = 1_000_000
BACKUPS = 2
DATEFMT = "%Y-%m-%dT%H:%M:%SZ"
# 2026-11-20T08:15:02Z WARNING garmin: Garmin sync of anna failed: …
LINE_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) (INFO|WARNING|ERROR|CRITICAL|DEBUG) ([\w.-]+): ?(.*)$"
)

_handlers: list[logging.Handler] = []


class _Area(logging.Filter):
    """`area`: the logger name without `trailbook.` (garmin, import, uvicorn.error…)."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.area = record.name.removeprefix("trailbook.") or "trailbook"
        return True


def _formatter() -> logging.Formatter:
    f = logging.Formatter("%(asctime)s %(levelname)s %(area)s: %(message)s", DATEFMT)
    f.converter = time.gmtime
    return f


def log_path(db_path: str | Path) -> Path:
    return Path(db_path).resolve().parent / LOG_FILE


def setup(db_path: str | Path, console: bool = True) -> None:
    """Log to `<data>/trailbook.log` and (with `console`) to stdout. Once per process."""
    root = logging.getLogger()
    for h in _handlers:
        root.removeHandler(h)
        h.close()
    _handlers.clear()
    fmt = _formatter()
    path = log_path(db_path)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fh = logging.handlers.RotatingFileHandler(
            path, maxBytes=MAX_BYTES, backupCount=BACKUPS, encoding="utf-8", delay=True
        )
        _handlers.append(fh)
    except OSError:
        pass  # a read-only place: the console still has it
    if console:
        _handlers.append(logging.StreamHandler(sys.stdout))
    for h in _handlers:
        h.setFormatter(fmt)
        h.addFilter(_Area())
        root.addHandler(h)
    root.setLevel(logging.WARNING)
    logging.getLogger("trailbook").setLevel(logging.INFO)
    logging.captureWarnings(True)


def read(db_path: str | Path, limit: int = 1000) -> list[dict]:
    """The latest `limit` entries, newest first: {time, level, area, message}. A traceback or
    any other line without a time belongs to the entry above it."""
    path = log_path(db_path)
    files = [path.with_name(f"{LOG_FILE}.{i}") for i in range(BACKUPS, 0, -1)] + [path]
    entries: list[dict] = []
    for f in files:
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for line in text.splitlines():
            m = LINE_RE.match(line)
            if m:
                entries.append({"time": m[1], "level": m[2], "area": m[3], "message": m[4]})
            elif entries and line.strip():
                entries[-1]["message"] += "\n" + line
    return entries[::-1][:limit]
