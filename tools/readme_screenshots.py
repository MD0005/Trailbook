"""README screenshots (docs/screenshots/*.png) from a running Trailbook, with headless Chrome.

Run Trailbook on the demo data first (tools/demo_data.py), never on real data:

    trailbook --db demo/trailbook.db serve --port 8099
    python tools/readme_screenshots.py --chrome "C:/Program Files/Google/Chrome/Application/chrome.exe"

Talks to Chrome over the DevTools protocol with the standard library only (a minimal
WebSocket client), so nothing has to be installed.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import socket
import struct
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

PORT = 9333
OUT = Path(__file__).resolve().parent.parent / "docs" / "screenshots"


class Ws:
    """Just enough of a WebSocket client for the DevTools protocol (text frames)."""

    def __init__(self, url: str):
        host, path = url[len("ws://") :].split("/", 1)
        h, p = host.split(":")
        self.s = socket.create_connection((h, int(p)))
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall(
            f"GET /{path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode()
        )
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.s.recv(4096)
        self.rest = buf.split(b"\r\n\r\n", 1)[1]
        self.n = 0

    def _read(self, n: int) -> bytes:
        while len(self.rest) < n:
            chunk = self.s.recv(1 << 20)
            if not chunk:
                raise ConnectionError("closed")
            self.rest += chunk
        out, self.rest = self.rest[:n], self.rest[n:]
        return out

    def send(self, text: str) -> None:
        data = text.encode()
        mask = os.urandom(4)
        head = bytes([0x81])
        n = len(data)
        head += (
            bytes([0x80 | n])
            if n < 126
            else bytes([0x80 | 126]) + struct.pack(">H", n)
            if n < 65536
            else bytes([0x80 | 127]) + struct.pack(">Q", n)
        )
        self.s.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv(self) -> str:
        parts = b""
        while True:
            b0, b1 = self._read(2)
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            parts += self._read(n)
            if b0 & 0x80:
                return parts.decode()

    def call(self, method: str, **params):
        self.n += 1
        self.send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            msg = json.loads(self.recv())
            if msg.get("id") == self.n:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})


def js(ws: Ws, code: str):
    r = ws.call(
        "Runtime.evaluate",
        expression=f"(async () => {{ {code} }})()",
        awaitPromise=True,
        returnByValue=True,
    )
    return r.get("result", {}).get("value")


# The box around the elements matching a CSS selector (from-th to to-th), plus a margin, as
# [x, y, width, height]: a part of the page without the app header.
CLIP_JS = """
document.querySelectorAll("header, .page-head").forEach((e) => { e.style.visibility = "hidden"; });
const els = [...document.querySelectorAll(%r)].slice(%d, %d);
const r = els.map((e) => e.getBoundingClientRect());
const pad = %d, x = Math.max(0, Math.min(...r.map((b) => b.left)) - pad), y = Math.max(0, Math.min(...r.map((b) => b.top)) - pad);
return [x, y, Math.min(innerWidth, Math.max(...r.map((b) => b.right)) + pad) - x, Math.max(...r.map((b) => b.bottom)) + pad - y];
"""


def shot(ws: Ws, base: str, name: str, hash_: str, height: int, prepare: str = "",
         wait: float = 6, clip: tuple | None = None) -> None:  # fmt: skip
    """`clip`: (selector, first, last, margin px) - only those elements; else the whole window."""
    ws.call("Emulation.setDeviceMetricsOverride", width=1400, height=height,
            deviceScaleFactor=1, mobile=False)  # fmt: skip
    ws.call("Page.navigate", url=f"{base}/{hash_}")
    time.sleep(wait)
    if prepare:
        js(ws, prepare)
        time.sleep(wait)
    params = {"format": "png"}
    if clip:
        x, y, w, h = js(ws, CLIP_JS % clip)
        params["clip"] = {"x": x, "y": y, "width": w, "height": h, "scale": 1}
    data = ws.call("Page.captureScreenshot", **params)["data"]
    (OUT / f"{name}.png").write_bytes(base64.b64decode(data))
    print(name)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--chrome", required=True)
    ap.add_argument("--base", default="http://localhost:8099")
    ap.add_argument("--only", help="comma-separated names, e.g. map,settings")
    a = ap.parse_args()
    profile = tempfile.mkdtemp(prefix="tb-shots-")
    proc = subprocess.Popen([a.chrome, "--headless=new", f"--remote-debugging-port={PORT}", f"--user-data-dir={profile}",
                             "--hide-scrollbars", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
                             "--window-size=1400,900", "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)  # fmt: skip
    try:
        for _ in range(50):
            try:
                pages = json.load(
                    urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list")
                )
                break
            except OSError:
                time.sleep(0.2)
        ws = Ws(next(p for p in pages if p["type"] == "page")["webSocketDebuggerUrl"])
        ws.call("Page.enable")
        b = a.base
        acts = json.load(
            urllib.request.urlopen(f"{b}/api/activities?person=alex&limit=60")
        )
        items = acts.get("items", acts) if isinstance(acts, dict) else acts
        iv = next(x for x in items if x.get("workout") == "intervals")
        zoom = "heat.map.jumpTo({ center: [21.01, 52.232], zoom: 11.7 });"
        # name, page, window height, script before the shot, wait (s), part of the page
        shots = [
            (
                "activity",
                f"#/activity/{iv['id']}",
                1270,
                "",
                8,
                None,
            ),  # the whole app, on top
            ("activities", "#/activities", 1000, "", 6, (".tile", 0, 8, 8)),
            ("map", "#/heatmap", 900, zoom, 8, ("#map", 0, 1, 0)),
            ("fitness", "#/fitness", 1000, "", 7, (".card", 0, 2, 8)),
            (
                "statistics",
                "#/stats",
                1000,
                "",
                7,
                (".year-bars, [data-scharts] > div", 0, 2, 4),
            ),
            (
                "settings",
                "#/settings/data",
                1120,
                "",
                6,
                (".card", 0, 2, 8),
            ),  # demo: Garmin
        ]
        for name, hash_, height, prepare, wait, clip in shots:
            if not a.only or name in a.only.split(","):
                shot(ws, b, name, hash_, height, prepare, wait, clip)
    finally:
        proc.terminate()


if __name__ == "__main__":
    main()
