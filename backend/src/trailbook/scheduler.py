"""Periodic folder scan inside the API process.

One asyncio task that sleeps until the next scan is due; it costs no CPU while waiting.
The interval comes from the `scan_interval_min` setting (0 = off) and is counted from
the end of the last import run, so restarting the server does not trigger extra scans.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import closing
from datetime import UTC, datetime, timedelta

from . import db, jobs

log = logging.getLogger("trailbook.scheduler")

DEFAULT_INTERVAL_MIN = 60
INTERVAL_CHOICES_MIN = (0, 15, 30, 60, 180, 360, 720, 1440)


def interval_min(conn) -> int:
    raw = db.get_setting(conn, "scan_interval_min")
    try:
        value = int(raw) if raw is not None else DEFAULT_INTERVAL_MIN
    except ValueError:
        value = DEFAULT_INTERVAL_MIN
    return max(0, value)


def next_scan_at(conn) -> datetime | None:
    """When the next automatic scan is due, or None if disabled / no folder configured."""
    minutes = interval_min(conn)
    if minutes == 0 or not db.get_setting(conn, "root"):
        return None
    row = conn.execute(
        "SELECT finished_at FROM import_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if row is None:
        return datetime.now(UTC)
    last = datetime.strptime(row["finished_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    return last + timedelta(minutes=minutes)


class Scheduler:
    def __init__(self, db_path: str, job: jobs.ImportJob):
        self.db_path = db_path
        self.job = job
        self._wake = asyncio.Event()
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="trailbook-scheduler")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    def settings_changed(self) -> None:
        """Re-read the interval now (called after the user saves settings)."""
        self._wake.set()

    async def _run(self) -> None:
        while True:
            with closing(db.connect(self.db_path, apply_migrations=False)) as c:
                due = next_scan_at(c)
            if due is None:
                timeout = None  # disabled: sleep until settings change
            else:
                timeout = max(0.0, (due - datetime.now(UTC)).total_seconds())
            try:
                await asyncio.wait_for(self._wake.wait(), timeout)
                self._wake.clear()
                continue  # settings changed: recompute
            except TimeoutError:
                pass
            if self.job.running():
                await asyncio.sleep(60)
                continue
            log.info("starting scheduled folder scan")
            self.job.start(trigger="schedule")
            # Wait for the run to finish so the next due time is based on it.
            while self.job.running():
                await asyncio.sleep(5)
            await asyncio.sleep(1)
