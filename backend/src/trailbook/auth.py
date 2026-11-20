"""Optional password login, for running outside Home Assistant (e.g. plain Docker).

In the add-on, Home Assistant Ingress already requires a Home Assistant login, so nothing here
is active: the middleware is only installed when `TRAILBOOK_PASSWORD` is set. Then every
request needs a session cookie from the login page; the API answers 401 without it.

The cookie is an HMAC of the password under a random key kept next to the database
(`session.key`): it does not reveal the password, and changing the password logs everyone out.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import html
import json
import os
import secrets
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import parse_qs

ENV = "TRAILBOOK_PASSWORD"
COOKIE = "trailbook_session"
COOKIE_MAX_AGE_S = 400 * 86400  # the longest browsers keep a cookie
KEY_FILE = "session.key"
FAIL_DELAY_S = 1.0  # slows down guessing
MAX_FORM_BYTES = 4096
HTML = "text/html; charset=utf-8"


def password() -> str | None:
    return os.environ.get(ENV) or None


def _key(data_dir: Path) -> bytes:
    path = data_dir / KEY_FILE
    try:
        key = path.read_bytes()
        if len(key) >= 32:
            return key
    except FileNotFoundError:
        pass
    key = secrets.token_bytes(32)
    data_dir.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(key)
    return key


def session_token(pw: str, data_dir: Path) -> str:
    return hmac.new(_key(data_dir), pw.encode(), hashlib.sha256).hexdigest()


LOGIN_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trailbook</title>
<style>
  :root {{ color-scheme: light dark; font-family: system-ui, sans-serif; }}
  body {{ display: grid; place-items: center; min-height: 100vh; margin: 0; }}
  form {{ display: grid; gap: 12px; width: min(320px, calc(100vw - 32px)); }}
  input, button {{ font: inherit; padding: 8px 12px; border-radius: 6px; }}
  input {{ border: 1px solid #8888; }}
  button {{ border: 0; background: #2f6fde; color: #fff; cursor: pointer; }}
  .error {{ color: #d33; margin: 0; }}
</style></head>
<body><form method="post" action="login">
  <h1>Trailbook</h1>
  {error}
  <input type="password" name="password" placeholder="Password" autocomplete="current-password"
    autofocus required>
  <input type="hidden" name="next">
  <button type="submit">Log in</button>
</form>
<script>document.querySelector("[name=next]").value = location.hash;</script>
</body></html>
"""


def _login_page(error: str = "") -> bytes:
    msg = f'<p class="error">{html.escape(error)}</p>' if error else ""
    return LOGIN_PAGE.format(error=msg).encode()


def _header(scope, name: bytes) -> str:
    for k, v in scope.get("headers", []):
        if k == name:
            return v.decode("latin-1")
    return ""


def _cookie(scope) -> str:
    jar = SimpleCookie()
    try:
        jar.load(_header(scope, b"cookie"))
    except Exception:  # noqa: BLE001 - a broken header is just no session
        return ""
    morsel = jar.get(COOKIE)
    return morsel.value if morsel else ""


def _https(scope) -> bool:
    proto = _header(scope, b"x-forwarded-proto").split(",")[0].strip()
    return scope.get("scheme") == "https" or proto == "https"


async def _send(send, status: int, body: bytes, ctype: str, headers=()) -> None:
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", ctype.encode()),
                (b"content-length", str(len(body)).encode()),
                (b"cache-control", b"no-store"),
                *headers,
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


async def _read_form(receive) -> dict[str, str]:
    body = b""
    more = True
    while more:
        msg = await receive()
        body += msg.get("body", b"")
        more = msg.get("more_body", False)
        if len(body) > MAX_FORM_BYTES:
            return {}
    fields = parse_qs(body.decode("utf-8", "replace"))
    return {k: v[0] for k, v in fields.items()}


def _set_cookie(value: str, max_age: int, secure: bool) -> tuple[bytes, bytes]:
    attrs = f"{COOKIE}={value}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax"
    if secure:
        attrs += "; Secure"
    return (b"set-cookie", attrs.encode())


def _redirect_target(next_hash: str) -> str:
    # Back to the page the login interrupted: only a `#` route of the app, nothing else.
    ok = next_hash.startswith("#") and next_hash.isprintable() and len(next_hash) < 2000
    return "./" + (next_hash if ok else "")


class PasswordMiddleware:
    """ASGI middleware: the login page, `POST /login`, `GET /logout`, and a 401 for
    everything else without a valid session cookie."""

    def __init__(self, app, pw: str, data_dir: Path):
        self.app = app
        self.password = pw
        self.token = session_token(pw, data_dir)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        method = scope.get("method", "GET")
        secure = _https(scope)

        if scope["type"] == "http" and path == "/login" and method == "POST":
            form = await _read_form(receive)
            given = form.get("password", "")
            if hmac.compare_digest(given.encode(), self.password.encode()):
                location = _redirect_target(form.get("next", ""))
                headers = [
                    (b"location", location.encode()),
                    _set_cookie(self.token, COOKIE_MAX_AGE_S, secure),
                ]
                return await _send(send, 303, b"", "text/plain", headers)
            await asyncio.sleep(FAIL_DELAY_S)
            return await _send(send, 401, _login_page("Wrong password."), HTML)

        if scope["type"] == "http" and path == "/logout":
            headers = [(b"location", b"./"), _set_cookie("", 0, secure)]
            return await _send(send, 303, b"", "text/plain", headers)

        if hmac.compare_digest(_cookie(scope).encode(), self.token.encode()):
            return await self.app(scope, receive, send)

        if scope["type"] != "http":
            return await send({"type": "websocket.close", "code": 1008})
        if path.startswith("/api/") or method != "GET":
            body = json.dumps({"error": "Log in first.", "login": True}).encode()
            return await _send(send, 401, body, "application/json")
        return await _send(send, 401, _login_page(), HTML)
