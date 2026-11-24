"""Home Assistant dashboard cards (hacards.py, SPEC §12b)."""

import json
import struct

import pytest
from starlette.testclient import TestClient

from trailbook import db, hacards
from trailbook.api import create_app


@pytest.fixture
def client(tmp_path):
    db.connect(tmp_path / "t.db").close()
    return TestClient(create_app(tmp_path / "t.db"))


def test_slug():
    assert hacards.slug("Heatmap MD") == "heatmap-md"
    assert hacards.slug("Łódź – zima 2026!") == "lodz-zima-2026"
    assert hacards.slug("***") == "card"


def test_cards_crud(client):
    assert client.get("/api/ha/cards").json() == []
    r = client.post("/api/ha/cards", json={"name": "Map", "kind": "map", "config": {"height": 400}})
    assert r.status_code == 201
    card = r.json()
    assert card["id"] == "map" and card["kind"] == "map" and card["config"] == {"height": 400}
    # the same name again: its own id
    second = client.post("/api/ha/cards", json={"name": "Map", "kind": "records", "config": {}})
    assert second.json()["id"] == "map-2"
    # renamed and changed: the id stays (the dashboard names it)
    r = client.put("/api/ha/cards/map", json={"name": "Heatmap", "config": {"height": 600}})
    assert r.json()["id"] == "map" and r.json()["name"] == "Heatmap"
    assert client.get("/api/ha/cards/map").json()["config"] == {"height": 600}
    assert [c["id"] for c in client.get("/api/ha/cards").json()] == ["map", "map-2"]
    assert client.delete("/api/ha/cards/map").status_code == 204
    assert client.get("/api/ha/cards/map").status_code == 404
    assert client.delete("/api/ha/cards/map").status_code == 404


@pytest.mark.parametrize(
    "body",
    [
        {"name": "x", "kind": "chart", "config": {}},
        {"name": "", "kind": "map", "config": {}},
        {"name": "x", "kind": "map", "config": []},
        {"name": "x", "kind": "map", "config": {"a": "x" * 30_000}},
    ],
)
def test_cards_invalid(client, body):
    assert client.post("/api/ha/cards", json=body).status_code == 400


def test_setup_outside_home_assistant(client, monkeypatch):
    monkeypatch.delenv("SUPERVISOR_TOKEN", raising=False)
    body = client.get("/api/ha/setup").json()
    assert body["addon"] is False
    assert body["url"].startswith("/local/trailbook/trailbook-card.js?v=")


def test_install_copies_the_card(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERVISOR_TOKEN", raising=False)
    monkeypatch.setenv("TRAILBOOK_HA_CONFIG", str(tmp_path))
    st = hacards.install()
    assert st["file"] == "copied" and st["www_created"] is True and st["resource"] is None
    copied = tmp_path / "www" / "trailbook" / "trailbook-card.js"
    assert copied.read_bytes() == hacards.CARD_JS.read_bytes()
    st = hacards.install()
    assert st["file"] == "current" and st["www_created"] is False


def test_install_without_access(tmp_path, monkeypatch):
    monkeypatch.setenv("TRAILBOOK_HA_CONFIG", str(tmp_path / "missing"))
    assert hacards.install()["file"] == "no_access"


class _FakeSock:
    """Home Assistant's side of the websocket: answers each call from `replies`."""

    def __init__(self, replies):
        self.replies = replies
        self.sent: list[dict] = []
        self.buf = b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n"
        self._push({"type": "auth_required"})

    def _push(self, msg):
        data = json.dumps(msg).encode()
        n = len(data)
        head = bytes([0x81]) + (bytes([n]) if n < 126 else bytes([126]) + struct.pack("!H", n))
        self.buf += head + data

    def recv(self, n):
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def sendall(self, data):
        if data.startswith(b"GET "):
            return
        n = data[1] & 0x7F
        i = 2 + (2 if n == 126 else 8 if n == 127 else 0)
        if n == 126:
            n = struct.unpack("!H", data[2:4])[0]
        mask, payload = data[i : i + 4], data[i + 4 :]
        msg = json.loads(bytes(b ^ mask[k % 4] for k, b in enumerate(payload)))
        self.sent.append(msg)
        if msg["type"] == "auth":
            self._push({"type": "auth_ok"})
        else:
            self._push(
                {
                    "id": msg["id"],
                    "type": "result",
                    "success": True,
                    "result": self.replies.get(msg["type"]),
                }
            )

    def close(self):
        pass


@pytest.mark.parametrize(
    ("existing", "result", "sent"),
    [
        ([], "registered", "lovelace/resources/create"),
        (
            [{"id": "r1", "url": "/local/trailbook/trailbook-card.js?v=old"}],
            "updated",
            "lovelace/resources/update",
        ),
    ],
)
def test_register_resource(monkeypatch, existing, result, sent):
    sock = _FakeSock({"lovelace/resources": existing})
    monkeypatch.setenv("SUPERVISOR_TOKEN", "t")
    monkeypatch.setattr(hacards.socket, "create_connection", lambda *a, **k: sock)
    url = hacards.card_url()
    assert hacards.register_resource(url) == result
    assert sock.sent[0] == {"type": "auth", "access_token": "t"}
    assert sock.sent[-1]["type"] == sent and sock.sent[-1]["url"] == url
    # the current version: nothing changed
    sock = _FakeSock({"lovelace/resources": [{"id": "r1", "url": url}]})
    monkeypatch.setattr(hacards.socket, "create_connection", lambda *a, **k: sock)
    assert hacards.register_resource(url) == "current"
