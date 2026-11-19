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

from . import db, garmin, jobs

log = logging.getLogger("trailbook.scheduler")

DEFAULT_INTERVAL_MIN = 60
INTERVAL_CHOICES_MIN = (0, 15, 30, 60, 180, 360, 720, 1440)
NOTIFY_RETRY_MIN = 10  # next try when Home Assistant did not take a notification


def interval_min(conn) -> int:
    raw = db.get_setting(conn, "scan_interval_min")
    try:
        value = int(raw) if raw is not None else DEFAULT_INTERVAL_MIN
    except ValueError:
        value = DEFAULT_INTERVAL_MIN
    return max(0, value)


def next_scan_at(conn) -> datetime | None:
    """When the next automatic run is due (folder scan or Garmin download), or None."""
    minutes = interval_min(conn)
    source = db.get_setting(conn, "data_source") or "folder"
    if minutes == 0 or source == "upload":
        return None
    if source == "folder" and not db.get_setting(conn, "root"):
        return None
    if source == "garmin" and not conn.execute("SELECT 1 FROM garmin_accounts").fetchone():
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
        self._notify_retry_at = datetime.min.replace(tzinfo=UTC)

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
                notify_at = garmin.next_ha_notification_at(c)
            if notify_at is not None and notify_at < self._notify_retry_at:
                notify_at = self._notify_retry_at  # Home Assistant did not answer: wait a bit
            # A Home Assistant notification for a refused Garmin key may be due before the
            # next run (or with automatic runs off).
            notify_first = notify_at is not None and (due is None or notify_at < due)
            wake_at = notify_at if notify_first else due
            if wake_at is None:
                timeout = None  # disabled: sleep until settings change
            else:
                timeout = max(0.0, (wake_at - datetime.now(UTC)).total_seconds())
            try:
                await asyncio.wait_for(self._wake.wait(), timeout)
                self._wake.clear()
                continue  # settings changed: recompute
            except TimeoutError:
                pass
            if notify_first:
                self._notify_retry_at = datetime.now(UTC) + timedelta(minutes=NOTIFY_RETRY_MIN)
                await asyncio.to_thread(self._notify)
                await asyncio.sleep(1)
                continue
            if self.job.running():
                await asyncio.sleep(60)
                continue
            log.info("starting scheduled import run")
            self.job.start(trigger="schedule")
            # Wait for the run to finish so the next due time is based on it.
            while self.job.running():
                await asyncio.sleep(5)
            await asyncio.sleep(1)

    def _notify(self) -> None:
        with closing(db.connect(self.db_path, apply_migrations=False)) as c:
            garmin.update_ha_notifications(c)
