"""Background jobs: run the importer (or export / restore) as a low-priority process.

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
    """Starts at most one background process at a time: import, export or restore."""

    def __init__(self, db_path: str | Path):
        self.db_path = str(db_path)
        self._proc: subprocess.Popen | None = None
        self._kind: str | None = None
        self._lock = threading.Lock()

    def running(self) -> bool:
        with self._lock:
            return self._proc is not None and self._proc.poll() is None

    def running_kind(self) -> str | None:
        """'scan', 'match-segments', 'export' or 'restore' while a process runs, else None."""
        with self._lock:
            alive = self._proc is not None and self._proc.poll() is None
            return self._kind if alive else None

    def start(self, trigger: str = "api") -> bool:
        """Start scan + import of the stored root folder. False if a job is already running."""
        return self._spawn("scan", ["--trigger", trigger])

    def start_segments(self) -> bool:
        """Match new segments / activities only (no scan, no downloads)."""
        return self._spawn("match-segments", [])

    def start_export(self, include_files: bool = True, include_secrets: bool = False) -> bool:
        args = [] if include_files else ["--no-files"]
        if include_secrets:
            args.append("--include-secrets")
        return self._spawn("export", args)

    def start_restore(self, archive: str | Path, delete_archive: bool) -> bool:
        args = [str(archive), "--yes"]
        if delete_archive:
            args.append("--delete-archive")
        return self._spawn("restore", args)

    def _spawn(self, command: str, args: list[str]) -> bool:
        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                return False
            cmd = [
                sys.executable, "-m", "trailbook.cli", "--db", self.db_path,
                command, *args, "--low-priority", "--quiet",
            ]  # fmt: skip
            # stdout stays the server's: the job's log lines reach the add-on's log too
            # (applog); its own crash is logged there already, so no stderr
            kwargs: dict = {"stdout": None, "stderr": subprocess.DEVNULL}
            if os.name == "nt":
                kwargs["creationflags"] = subprocess.IDLE_PRIORITY_CLASS
            else:
                ionice = shutil.which("ionice")
                if ionice:
                    cmd = [ionice, "-c3", *cmd]  # idle I/O class
            self._proc = subprocess.Popen(cmd, **kwargs)
            self._kind = command
            return True

    def wait(self, timeout: float | None = None) -> int | None:
        proc = self._proc
        return proc.wait(timeout) if proc else None


def write_progress(conn, **progress) -> None:
    db.set_setting(conn, PROGRESS_KEY, json.dumps(progress))


def read_progress(conn) -> dict:
    raw = db.get_setting(conn, PROGRESS_KEY)
    return json.loads(raw) if raw else {"state": "idle"}
