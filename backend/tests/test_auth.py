import pytest
from starlette.testclient import TestClient

from trailbook import auth
from trailbook.api import create_app


@pytest.fixture(autouse=True)
def no_delay(monkeypatch):
    monkeypatch.setattr(auth, "FAIL_DELAY_S", 0)


def client(tmp_path):
    return TestClient(create_app(tmp_path / "t.db"), follow_redirects=False)


def test_no_password_no_login(tmp_path, monkeypatch):
    # The add-on (and a plain `trailbook serve`) never sets it: nothing changes.
    monkeypatch.delenv(auth.ENV, raising=False)
    c = client(tmp_path)
    assert c.get("/api/info").status_code == 200
    assert c.get("/").status_code == 200
    assert c.post("/login", data={"password": "x"}).status_code in (404, 405)
    assert not (tmp_path / auth.KEY_FILE).exists()


def test_password_login_logout(tmp_path, monkeypatch):
    monkeypatch.setenv(auth.ENV, "secret")
    c = client(tmp_path)

    r = c.get("/api/info")
    assert r.status_code == 401 and r.json()["login"] is True
    assert c.put("/api/settings", json={}).status_code == 401
    page = c.get("/")
    assert page.status_code == 401 and 'action="login"' in page.text

    r = c.post("/login", data={"password": "wrong"})
    assert r.status_code == 401 and "Wrong password" in r.text
    assert auth.COOKIE not in c.cookies

    r = c.post("/login", data={"password": "secret", "next": "#/activities?person=a"})
    assert r.status_code == 303 and r.headers["location"] == "./#/activities?person=a"
    assert "HttpOnly" in r.headers["set-cookie"] and "Secure" not in r.headers["set-cookie"]
    assert "secret" not in c.cookies[auth.COOKIE]
    assert c.get("/api/info").status_code == 200
    assert c.get("/").status_code == 200

    r = c.get("/logout")
    assert r.status_code == 303 and "Max-Age=0" in r.headers["set-cookie"]
    c.cookies.clear()
    assert c.get("/api/info").status_code == 401


def test_redirect_only_to_app_routes(tmp_path, monkeypatch):
    monkeypatch.setenv(auth.ENV, "secret")
    c = client(tmp_path)
    for bad in ("https://evil.example", "//evil.example", "#x\r\nSet-Cookie: a=b"):
        r = c.post("/login", data={"password": "secret", "next": bad})
        assert r.headers["location"] == "./"


def test_secure_cookie_behind_https_proxy(tmp_path, monkeypatch):
    monkeypatch.setenv(auth.ENV, "secret")
    r = client(tmp_path).post(
        "/login", data={"password": "secret"}, headers={"X-Forwarded-Proto": "https"}
    )
    assert "Secure" in r.headers["set-cookie"]


def test_new_password_ends_sessions(tmp_path, monkeypatch):
    monkeypatch.setenv(auth.ENV, "one")
    c = client(tmp_path)
    c.post("/login", data={"password": "one"})
    old = c.cookies[auth.COOKIE]
    monkeypatch.setenv(auth.ENV, "two")
    c2 = client(tmp_path)
    c2.cookies.set(auth.COOKIE, old)
    assert c2.get("/api/info").status_code == 401
    # The key survives a restart, so the same password keeps its sessions.
    monkeypatch.setenv(auth.ENV, "one")
    c3 = client(tmp_path)
    c3.cookies.set(auth.COOKIE, old)
    assert c3.get("/api/info").status_code == 200
