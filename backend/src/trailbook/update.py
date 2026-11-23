"""Updates of the Windows app: a look at the newest GitHub release, one click installs it.

Only in the Windows app (`TRAILBOOK_DESKTOP`); Home Assistant and Docker update themselves.
The release of a version carries the installer `Trailbook-Setup-<version>.exe` (built by CI).
Installing downloads it next to the database, checks its size and SHA-256 (from the release),
starts it silently and stops this process: the installer replaces the program and starts it
again. Only the standard library.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import __version__

log = logging.getLogger("trailbook.update")

REPO = "MD0005/Trailbook"
LATEST_URL = f"https://api.github.com/repos/{REPO}/releases/latest"
ASSET = re.compile(r"^Trailbook-Setup-[\d.]+\.exe$")
CHECK_EVERY_S = 24 * 3600
RETRY_S = 3600  # after a failed look
TIMEOUT_S = 15.0
USER_AGENT = "Trailbook-updater"

_lock = threading.Lock()
_state: dict = {}
_checked_at = 0.0


def enabled() -> bool:
    return os.environ.get("TRAILBOOK_DESKTOP") == "1"


def _parse(version: str) -> tuple[int, ...]:
    return tuple(int(p) for p in re.findall(r"\d+", version)[:3])


def newer(latest: str, current: str) -> bool:
    return _parse(latest) > _parse(current)


def _get(url: str, accept: str = "application/vnd.github+json"):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    return urllib.request.urlopen(req, timeout=TIMEOUT_S)  # noqa: S310 - fixed https URL


def _latest_release() -> dict:
    try:
        with _get(LATEST_URL) as res:
            return json.load(res)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:  # no release yet
            return {}
        raise


def _from_release(release: dict) -> dict:
    latest = (release.get("tag_name") or "").lstrip("v")
    asset = next((a for a in release.get("assets", []) if ASSET.match(a.get("name", ""))), None)
    digest = (asset or {}).get("digest") or ""
    return {
        "current": __version__,
        "latest": latest,
        "available": bool(asset) and newer(latest, __version__),
        "notes": release.get("body") or "",
        "url": asset["browser_download_url"] if asset else None,
        "size": asset["size"] if asset else None,
        "sha256": digest.removeprefix("sha256:") or None,
        "error": None,
    }


def status(force: bool = False) -> dict:
    """The newest release compared to this version; GitHub is asked at most once a day (an
    hour after a failure). Blocking: call from a thread."""
    global _checked_at
    if not enabled():
        return {"enabled": False}
    with _lock:
        wait = RETRY_S if _state.get("error") else CHECK_EVERY_S
        if force or not _state or time.monotonic() - _checked_at > wait:
            try:
                _state.update(_from_release(_latest_release()))
            except (OSError, ValueError, KeyError) as exc:
                log.warning("Looking for an update failed: %s", exc)
                _state.update({"current": __version__, "available": False, "error": str(exc)})
            _checked_at = time.monotonic()
        return {"enabled": True, **{k: v for k, v in _state.items() if k != "url"}}


class UpdateError(Exception):
    pass


def download(data_dir: Path) -> Path:
    """The installer of the newest release, checked; raises UpdateError."""
    info = status()
    if not info.get("available") or not _state.get("url"):
        raise UpdateError("No update available.")
    folder = data_dir / "updates"
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.glob("*.exe"):
        old.unlink(missing_ok=True)
    target = folder / f"Trailbook-Setup-{info['latest']}.exe"
    sha = hashlib.sha256()
    size = 0
    try:
        with _get(_state["url"], accept="application/octet-stream") as res, target.open("wb") as f:
            while chunk := res.read(1 << 16):
                f.write(chunk)
                sha.update(chunk)
                size += len(chunk)
    except OSError as exc:
        target.unlink(missing_ok=True)
        raise UpdateError(f"Download failed: {exc}") from exc
    if size != info["size"] or (info["sha256"] and sha.hexdigest() != info["sha256"]):
        target.unlink(missing_ok=True)
        raise UpdateError("The downloaded installer is damaged; try again.")
    return target


def run_installer(installer: Path) -> None:
    """Start the installer on its own (it outlives this process) and stop this process."""
    flags = 0
    if os.name == "nt":
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    subprocess.Popen(  # noqa: S603 - our own downloaded and checked installer
        [str(installer), "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"],
        creationflags=flags,
        close_fds=True,
    )
    log.info("Installing Trailbook %s; restarting", installer.stem.rsplit("-", 1)[-1])
    # Give the answer to the browser a moment, then leave so the files can be replaced.
    threading.Timer(1.0, before_exit or (lambda: os._exit(0))).start()


# Set by the Windows app: removes the tray icon, then ends the process.
before_exit = None
