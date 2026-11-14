"""Background import: run the importer as a separate low-priority process.

The importer is not resident. The API starts it when there is work; it scans, imports and
exits, so its memory is released. Progress is written to the `settings` table under
`import_progress` (JSON) and read by the API.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path

from . import db

PROGRESS_KEY = "import_progress"


class ImportJob:
    """Starts at most one importer process at a time."""

    def __init__(self, db_path: str | Path):
        self.db_path = str(db_path)
        self._proc: subprocess.Popen | None = None
        self._lock = threading.Lock()

    def running(self) -> bool:
        with self._lock:
            return self._proc is not None and self._proc.poll() is None

    def start(self, trigger: str = "api") -> bool:
        """Start scan + import of the stored root folder. False if one is already running."""
        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                return False
            cmd = [
                sys.executable, "-m", "trailbook.cli", "--db", self.db_path,
                "scan", "--low-priority", "--trigger", trigger, "--quiet",
            ]  # fmt: skip
            kwargs: dict = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
            if os.name == "nt":
                kwargs["creationflags"] = subprocess.IDLE_PRIORITY_CLASS
            else:
                ionice = shutil.which("ionice")
                if ionice:
                    cmd = [ionice, "-c3", *cmd]  # idle I/O class
            self._proc = subprocess.Popen(cmd, **kwargs)
            return True

    def wait(self, timeout: float | None = None) -> int | None:
        proc = self._proc
        return proc.wait(timeout) if proc else None


def write_progress(conn, **progress) -> None:
    db.set_setting(conn, PROGRESS_KEY, json.dumps(progress))


def read_progress(conn) -> dict:
    raw = db.get_setting(conn, PROGRESS_KEY)
    return json.loads(raw) if raw else {"state": "idle"}
