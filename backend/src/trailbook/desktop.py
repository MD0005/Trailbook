"""The Windows app: Trailbook without Docker or Home Assistant.

`Trailbook.exe` without arguments starts the server on this computer only (127.0.0.1), puts
an icon in the notification area (Open / Quit) and opens the browser. With arguments it is the
command-line interface (`trailbook.cli`): the background import, export and restore jobs run
the same exe. The data lives in %LOCALAPPDATA%\\Trailbook, apart from the program, so an
update or a reinstall keeps it.

`--background` (Windows start-up, after an update) starts without opening the browser.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

PORT = 8099
HOST = "127.0.0.1"


def data_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "Trailbook"


def _quiet_streams() -> None:
    # A windowed exe has no console: print() and the console log would fail without this.
    for name in ("stdout", "stderr"):
        if getattr(sys, name) is None:
            setattr(sys, name, open(os.devnull, "w", encoding="utf-8"))  # noqa: SIM115


def _message(text: str) -> None:
    if os.name == "nt":
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, text, "Trailbook", 0x10)
    else:
        print(text, file=sys.stderr)


def _running_trailbook(port: int) -> bool:
    """True when this port already answers as Trailbook (the app was started twice)."""
    try:
        with urllib.request.urlopen(f"http://{HOST}:{port}/api/info", timeout=2) as res:
            return "version" in json.load(res)
    except (OSError, ValueError):
        return False


def _port_free(port: int) -> bool:
    with socket.socket() as s:
        try:
            s.bind((HOST, port))
        except OSError:
            return False
    return True


def _free_port() -> int:
    with socket.socket() as s:
        s.bind((HOST, 0))
        return s.getsockname()[1]


def _icon_image():
    from PIL import Image

    # bundled by windows/trailbook.spec; from a checkout the add-on's icon
    for candidate in (
        Path(getattr(sys, "_MEIPASS", "")) / "icon.png",
        Path(__file__).parents[3] / "trailbook" / "icon.png",
    ):
        if candidate.is_file():
            return Image.open(candidate)
    return Image.new("RGB", (64, 64), (14, 116, 144))


def run_app(open_browser: bool = True) -> int:
    folder = data_dir()
    folder.mkdir(parents=True, exist_ok=True)
    os.environ["TRAILBOOK_DESKTOP"] = "1"
    db_path = str(folder / "trailbook.db")

    port = int(os.environ.get("TRAILBOOK_PORT") or PORT)
    if _running_trailbook(port):
        if open_browser:
            webbrowser.open(f"http://localhost:{port}/")
        return 0
    if not _port_free(port):
        port = _free_port()
    url = f"http://localhost:{port}/"

    import logging

    import uvicorn

    from . import __version__, applog, db, update
    from .api import create_app

    applog.setup(db_path, console=False)
    db.connect(db_path).close()
    app = create_app(db_path)
    logging.getLogger("trailbook.server").info("Trailbook %s started (Windows app)", __version__)
    config = uvicorn.Config(
        app, host=HOST, port=port, workers=1, log_level="warning", access_log=False,
        log_config=None,
    )  # fmt: skip
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, name="trailbook-server", daemon=True)
    thread.start()
    for _ in range(300):  # up to 30 s for migrations on a large database
        if server.started or not thread.is_alive():
            break
        time.sleep(0.1)
    if not server.started:
        _message(f"Trailbook could not start. See the log in {folder}.")
        return 1
    if open_browser:
        webbrowser.open(url)

    import pystray

    def quit_app(icon, _item=None):
        server.should_exit = True
        icon.stop()

    icon = pystray.Icon(
        "Trailbook",
        _icon_image(),
        f"Trailbook {__version__}",
        menu=pystray.Menu(
            pystray.MenuItem("Open Trailbook", lambda: webbrowser.open(url), default=True),
            pystray.MenuItem("Quit", quit_app),
        ),
    )

    def before_exit():
        icon.stop()
        os._exit(0)

    update.before_exit = before_exit
    icon.run()  # until Quit
    thread.join(timeout=10)
    return 0


def main() -> int:
    _quiet_streams()
    args = sys.argv[1:]
    if args and args != ["--background"]:
        from . import cli

        if "--db" not in args:
            args = ["--db", str(data_dir() / "trailbook.db"), *args]
        os.environ["TRAILBOOK_DESKTOP"] = "1"
        return cli.main(args)
    return run_app(open_browser=not args)


if __name__ == "__main__":
    raise SystemExit(main())
