"""Home Assistant notifications, only when running as an add-on.

Inside the add-on the Supervisor provides `SUPERVISOR_TOKEN` (with `homeassistant_api: true`
in config.yaml) and proxies Home Assistant's REST API at http://supervisor/core/api. Outside
Home Assistant there is no token and every call is a no-op. Only the standard library.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request

log = logging.getLogger("trailbook.homeassistant")

API_URL = "http://supervisor/core/api"
TIMEOUT_S = 10.0


def available() -> bool:
    return bool(os.environ.get("SUPERVISOR_TOKEN"))


def _call(service: str, data: dict) -> bool:
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        return False
    req = urllib.request.Request(
        f"{API_URL}/services/persistent_notification/{service}",
        data=json.dumps(data).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:  # noqa: S310 (fixed host)
            return 200 <= resp.status < 300
    except (urllib.error.URLError, OSError) as exc:
        log.warning("Home Assistant %s failed: %s", service, exc)
        return False


def notify(notification_id: str, title: str, message: str) -> bool:
    """Create (or replace) a persistent notification. True when Home Assistant accepted it."""
    return _call("create", {"notification_id": notification_id, "title": title, "message": message})


def dismiss(notification_id: str) -> bool:
    """Remove a persistent notification (also fine when it is already gone)."""
    return _call("dismiss", {"notification_id": notification_id})
