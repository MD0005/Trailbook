"""Updates of the Windows app (trailbook.update) and the frozen exe's job command."""

from __future__ import annotations

import hashlib
import io
import json
import sys
import urllib.error

import pytest

from trailbook import api, jobs, update

PAYLOAD = b"installer bytes" * 100


def release(tag="v9.0.0", payload=PAYLOAD, digest=True):
    return {
        "tag_name": tag,
        "body": "### Added\n- Something new",
        "assets": [
            {"name": "other.zip", "size": 1, "browser_download_url": "https://x/other.zip"},
            {
                "name": f"Trailbook-Setup-{tag.lstrip('v')}.exe",
                "size": len(payload),
                "browser_download_url": "https://x/setup.exe",
                "digest": f"sha256:{hashlib.sha256(payload).hexdigest()}" if digest else None,
            },
        ],
    }


@pytest.fixture
def desktop(monkeypatch):
    monkeypatch.setenv("TRAILBOOK_DESKTOP", "1")
    monkeypatch.setattr(update, "_state", {})
    monkeypatch.setattr(update, "_checked_at", 0.0)


def fake_get(monkeypatch, rel, payload=PAYLOAD):
    calls = []

    def get(url, accept=None):
        calls.append(url)
        if url == update.LATEST_URL:
            if rel is None:
                raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)
            return io.BytesIO(json.dumps(rel).encode())
        return io.BytesIO(payload)

    monkeypatch.setattr(update, "_get", get)
    return calls


def test_newer():
    assert update.newer("0.1.10", "0.1.9")
    assert not update.newer("0.1.9", "0.1.9")
    assert not update.newer("0.1.8", "0.1.9")


def test_disabled_outside_the_windows_app(monkeypatch):
    monkeypatch.delenv("TRAILBOOK_DESKTOP", raising=False)
    assert update.status() == {"enabled": False}


def test_status_newer_release(desktop, monkeypatch):
    calls = fake_get(monkeypatch, release())
    s = update.status()
    assert s["available"] and s["latest"] == "9.0.0" and s["notes"].startswith("### Added")
    assert "url" not in s
    update.status()  # cached: GitHub is asked once a day
    assert calls.count(update.LATEST_URL) == 1


def test_status_no_release_yet(desktop, monkeypatch):
    fake_get(monkeypatch, None)
    s = update.status()
    assert not s["available"] and s["error"] is None


def test_status_offline(desktop, monkeypatch):
    def get(url, accept=None):
        raise OSError("offline")

    monkeypatch.setattr(update, "_get", get)
    s = update.status()
    assert not s["available"] and s["error"] == "offline"


def test_download_checks_the_installer(desktop, monkeypatch, tmp_path):
    fake_get(monkeypatch, release())
    path = update.download(tmp_path)
    assert path.read_bytes() == PAYLOAD and path.name == "Trailbook-Setup-9.0.0.exe"


def test_download_rejects_a_damaged_installer(desktop, monkeypatch, tmp_path):
    fake_get(monkeypatch, release(), payload=PAYLOAD[:-1] + b"X")
    with pytest.raises(update.UpdateError):
        update.download(tmp_path)
    assert not list((tmp_path / "updates").glob("*.exe"))


def test_download_without_update(desktop, monkeypatch, tmp_path):
    fake_get(monkeypatch, release(tag="v0.0.1"))
    with pytest.raises(update.UpdateError):
        update.download(tmp_path)


def test_api_update(desktop, monkeypatch, tmp_path):
    from starlette.testclient import TestClient

    fake_get(monkeypatch, release())
    with TestClient(api.create_app(tmp_path / "t.db")) as client:
        assert client.get("/api/update").json()["available"]
        assert client.get("/api/info").json()["desktop"] is True
        monkeypatch.delenv("TRAILBOOK_DESKTOP")
        assert client.post("/api/update").status_code == 404


def test_frozen_exe_runs_jobs_as_itself(monkeypatch, tmp_path):
    seen = {}

    class Proc:
        def poll(self):
            return None

    def popen(cmd, **kwargs):
        seen["cmd"] = cmd
        return Proc()

    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(jobs.subprocess, "Popen", popen)
    jobs.ImportJob(tmp_path / "t.db").start()
    cmd = seen["cmd"]
    exe = cmd.index(sys.executable)
    assert cmd[exe + 1] == "--db" and "-m" not in cmd
