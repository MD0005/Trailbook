"""Home Assistant dashboard cards (SPEC §12b).

A card is made in Trailbook (Home Assistant › Cards) and stored here; the dashboard only names
it (`type: custom:trailbook-card`, `card: <id>`). The Lovelace card (static/ha/trailbook-card.js)
opens an Ingress session and shows the card's page (`#/embed/<id>`) in a frame, so a change
made in Trailbook shows on the dashboard without editing YAML.

In the add-on the card file is copied to Home Assistant's `www/trailbook/` (config.yaml maps
`homeassistant_config`) and registered as a dashboard resource over Home Assistant's websocket
API (Supervisor proxy). Only the standard library.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import socket
import sqlite3
import struct
import unicodedata
from pathlib import Path

from . import importer

log = logging.getLogger("trailbook.hacards")

KINDS = ("map", "activity", "detail", "records", "calendar")
MAX_CONFIG = 20_000  # bytes of JSON
CARD_JS = Path(__file__).parent / "static" / "ha" / "trailbook-card.js"
LOCAL_PATH = "/local/trailbook/trailbook-card.js"
WS_HOST, WS_PATH = "supervisor", "/core/websocket"
TIMEOUT_S = 10.0

# What the last install found (GET /api/ha/setup); None until it ran.
STATUS: dict | None = None


# ---- cards ------------------------------------------------------------------------------


def _row(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "name": r["name"],
        "kind": r["kind"],
        "config": json.loads(r["config"]),
        "updated_at": r["updated_at"],
    }


def list_cards(c: sqlite3.Connection) -> list[dict]:
    rows = c.execute("SELECT * FROM ha_cards ORDER BY position, created_at").fetchall()
    return [_row(r) for r in rows]


def get_card(c: sqlite3.Connection, card_id: str) -> dict | None:
    r = c.execute("SELECT * FROM ha_cards WHERE id = ?", (card_id,)).fetchone()
    return _row(r) if r else None


def slug(name: str) -> str:
    """The id of a new card from its name: ASCII letters, digits and dashes."""
    text = unicodedata.normalize("NFKD", name.replace("ł", "l").replace("Ł", "L"))
    text = text.encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")[:40].strip("-") or "card"


def check(kind: str | None, config, name: str | None = None) -> None:
    """ValueError when a card's fields are not valid."""
    if kind is not None and kind not in KINDS:
        raise ValueError(f"kind must be one of {', '.join(KINDS)}")
    if config is not None:
        if not isinstance(config, dict):
            raise ValueError("config must be an object")
        if len(json.dumps(config)) > MAX_CONFIG:
            raise ValueError("config too large")
    if name is not None and not (isinstance(name, str) and 0 < len(name.strip()) <= 60):
        raise ValueError("name must be 1-60 characters")


def create_card(c: sqlite3.Connection, name: str, kind: str, config: dict) -> dict:
    check(kind, config, name)
    base = slug(name)
    card_id, n = base, 2
    while c.execute("SELECT 1 FROM ha_cards WHERE id = ?", (card_id,)).fetchone():
        card_id, n = f"{base}-{n}", n + 1
    now = importer.now_iso()
    pos = c.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM ha_cards").fetchone()[0]
    c.execute(
        """INSERT INTO ha_cards (id, name, kind, config, position, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (card_id, name.strip(), kind, json.dumps(config), pos, now, now),
    )
    return get_card(c, card_id)


def update_card(c: sqlite3.Connection, card_id: str, body: dict) -> dict | None:
    """Change the name, kind and / or config; the id stays (the dashboard names it)."""
    card = get_card(c, card_id)
    if not card:
        return None
    name, kind, config = body.get("name"), body.get("kind"), body.get("config")
    check(kind, config, name)
    c.execute(
        "UPDATE ha_cards SET name = ?, kind = ?, config = ?, updated_at = ? WHERE id = ?",
        (
            (name or card["name"]).strip(),
            kind or card["kind"],
            json.dumps(card["config"] if config is None else config),
            importer.now_iso(),
            card_id,
        ),
    )
    return get_card(c, card_id)


def delete_card(c: sqlite3.Connection, card_id: str) -> bool:
    return c.execute("DELETE FROM ha_cards WHERE id = ?", (card_id,)).rowcount > 0


# ---- the card file in Home Assistant ----------------------------------------------------


def ha_config_dir() -> Path:
    return Path(os.environ.get("TRAILBOOK_HA_CONFIG", "/homeassistant"))


def card_url() -> str:
    """The resource URL; `v` changes with the file, so browsers load a new version."""
    digest = hashlib.sha256(CARD_JS.read_bytes()).hexdigest()[:10]
    return f"{LOCAL_PATH}?v={digest}"


def install() -> dict:
    """Copy the card file into Home Assistant and register it as a dashboard resource.

    Returns (and keeps in STATUS) what happened: `file` copied / current / no_access, whether
    the `www` folder was new (Home Assistant serves /local only after a restart then) and
    `resource` registered / updated / current / failed (then added by hand: `url`)."""
    global STATUS
    status = {"file": "no_access", "www_created": False, "resource": None, "url": card_url()}
    root = ha_config_dir()
    if root.is_dir():
        www = root / "www"
        status["www_created"] = not www.exists()
        dest = www / "trailbook" / CARD_JS.name
        data = CARD_JS.read_bytes()
        try:
            if dest.is_file() and dest.read_bytes() == data:
                status["file"] = "current"
            else:
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(data)
                status["file"] = "copied"
        except OSError as exc:
            log.warning("Copying the dashboard card failed: %s", exc)
            status["file"] = "no_access"
    if status["file"] != "no_access" and os.environ.get("SUPERVISOR_TOKEN"):
        try:
            status["resource"] = register_resource(status["url"])
        except (OSError, ValueError) as exc:
            log.warning("Registering the dashboard card failed: %s", exc)
            status["resource"] = "failed"
    STATUS = status
    return status


def register_resource(url: str) -> str:
    """Add (or point to the new version) the card's dashboard resource. Fails (ValueError)
    when the dashboards are in YAML mode: then the resource is added by hand."""
    with Ws() as ws:
        found = ws.call({"type": "lovelace/resources"})
        mine = [r for r in found if str(r.get("url", "")).split("?")[0] == LOCAL_PATH]
        if mine and mine[0]["url"] == url:
            return "current"
        if mine:
            ws.call(
                {
                    "type": "lovelace/resources/update",
                    "resource_id": mine[0]["id"],
                    "res_type": "module",
                    "url": url,
                }
            )
            return "updated"
        ws.call({"type": "lovelace/resources/create", "res_type": "module", "url": url})
        return "registered"


class Ws:
    """A minimal websocket client for Home Assistant's API through the Supervisor (text
    frames only, one call at a time)."""

    def __enter__(self) -> Ws:
        token = os.environ.get("SUPERVISOR_TOKEN") or ""
        self.sock = socket.create_connection((WS_HOST, 80), timeout=TIMEOUT_S)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(
            (
                f"GET {WS_PATH} HTTP/1.1\r\nHost: {WS_HOST}\r\nUpgrade: websocket\r\n"
                f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                f"Sec-WebSocket-Version: 13\r\nAuthorization: Bearer {token}\r\n\r\n"
            ).encode()
        )
        head = b""
        while not head.endswith(b"\r\n\r\n"):
            byte = self.sock.recv(1)
            if not byte or len(head) > 8192:
                raise ValueError("no websocket handshake")
            head += byte
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise ValueError("websocket refused: " + head.split(b"\r\n", 1)[0].decode())
        if self.recv().get("type") != "auth_required":
            raise ValueError("unexpected websocket greeting")
        self.send({"type": "auth", "access_token": token})
        if self.recv().get("type") != "auth_ok":
            raise ValueError("websocket authentication failed")
        self.next_id = 1
        return self

    def __exit__(self, *exc) -> None:
        self.sock.close()

    def call(self, msg: dict):
        msg = {"id": self.next_id, **msg}
        self.next_id += 1
        self.send(msg)
        while True:
            reply = self.recv()
            if reply.get("id") == msg["id"] and reply.get("type") == "result":
                if not reply.get("success"):
                    raise ValueError(str((reply.get("error") or {}).get("message") or reply))
                return reply.get("result")

    def send(self, msg: dict, opcode: int = 0x1) -> None:
        self._frame(json.dumps(msg).encode(), opcode)

    def _frame(self, payload: bytes, opcode: int) -> None:
        n = len(payload)
        head = bytes([0x80 | opcode])
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 1 << 16:
            head += bytes([0x80 | 126]) + struct.pack("!H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack("!Q", n)
        mask = os.urandom(4)
        self.sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def _exact(self, n: int) -> bytes:
        out = b""
        while len(out) < n:
            chunk = self.sock.recv(n - len(out))
            if not chunk:
                raise ValueError("websocket closed")
            out += chunk
        return out

    def recv(self) -> dict:
        data = b""
        while True:
            b0, b1 = self._exact(2)
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._exact(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._exact(8))[0]
            mask = self._exact(4) if b1 & 0x80 else None
            payload = self._exact(n)
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            opcode = b0 & 0x0F
            if opcode == 0x8:
                raise ValueError("websocket closed")
            if opcode == 0x9:  # ping
                self._frame(payload, 0xA)
                continue
            if opcode in (0x1, 0x0):
                data += payload
                if b0 & 0x80:
                    return json.loads(data)
