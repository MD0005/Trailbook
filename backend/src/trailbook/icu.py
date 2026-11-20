"""intervals.icu: the bridge that sends planned workouts to Garmin Connect and the watch.

Each person pastes their intervals.icu API key (Settings › Workouts); intervals.icu, connected
to their Garmin account with "upload planned workouts" on, puts the workout in the Garmin
calendar on its day. A workout placed in the Trailbook calendar waits SEND_DELAY_S (it may still
be moved or removed), then goes as a WORKOUT event whose description is the workout in
intervals.icu's text syntax (planner.icu_text). Moving it updates the event, removing it
deletes the event.

Only the standard library is used (urllib). Basic auth: user "API_KEY", the key as password;
athlete "0" = the key's own athlete.
"""

from __future__ import annotations

import base64
import json
import logging
import re
import sqlite3
import urllib.error
import urllib.request
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta

from . import __version__, planner
from .importer import now_iso

BASE_URL = "https://intervals.icu/api/v1"
USER_AGENT = f"Mozilla/5.0 (compatible; Trailbook/{__version__})"
SEND_DELAY_S = 60  # a placed workout waits this long for a move or removal
RETRY_S = 600  # intervals.icu not reachable or a server error: try again later

# (method, url, headers, body) -> (status, body)
Transport = Callable[[str, str, dict, bytes | None], tuple[int, bytes]]


class IcuError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status

    @property
    def auth(self) -> bool:
        return self.status in (401, 403)

    @property
    def retry(self) -> bool:
        return self.status is None or self.status == 429 or self.status >= 500


def urllib_transport(method: str, url: str, headers: dict, body: bytes | None) -> tuple:
    req = urllib.request.Request(url, method=method, headers=headers, data=body)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 (fixed https host)
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read() or b""
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise IcuError(f"intervals.icu is not reachable: {exc}") from exc


class Client:
    def __init__(self, api_key: str, transport: Transport | None = None):
        token = base64.b64encode(f"API_KEY:{api_key.strip()}".encode()).decode()
        self.headers = {"Authorization": f"Basic {token}", "User-Agent": USER_AGENT,
                        "Accept": "application/json"}  # fmt: skip
        self.transport = transport or urllib_transport

    def call(self, method: str, path: str, data=None):
        body = None
        headers = dict(self.headers)
        if data is not None:
            body = json.dumps(data).encode()
            headers["Content-Type"] = "application/json"
        status, raw = self.transport(method, BASE_URL + path, headers, body)
        if status in (401, 403):
            raise IcuError("intervals.icu refused the API key", status)
        if status == 404 and method == "DELETE":
            return None
        if status >= 400:
            snippet = re.sub(r"\s+", " ", raw[:160].decode("utf-8", "replace")).strip()
            raise IcuError(f"intervals.icu: HTTP {status}" + (f" {snippet}" if snippet else ""),
                           status)  # fmt: skip
        try:
            return json.loads(raw) if raw else None
        except ValueError:
            return None

    def athlete(self) -> dict:
        return self.call("GET", "/athlete/0") or {}


def athlete_settings(data: dict) -> dict:
    """The parts of intervals.icu's athlete record the text needs: per sport LTHR and max HR."""
    out = {"id": data.get("id"), "name": data.get("name"), "sports": {}}
    for s in data.get("sportSettings") or []:
        types = s.get("types") or []
        for sport, icu_type in planner.SPORTS.items():
            if icu_type in types:
                out["sports"][sport] = {"lthr": s.get("lthr"), "max_hr": s.get("max_hr"),
                                        "ftp": s.get("ftp"),
                                        "threshold_pace": s.get("threshold_pace")}  # fmt: skip
    return out


# ---- accounts ------------------------------------------------------------------------------


def key_hint(key: str) -> str:
    return "…" + key.strip()[-4:] if len(key.strip()) > 8 else "…"


def accounts(conn: sqlite3.Connection) -> dict[str, dict]:
    out = {}
    for r in conn.execute("SELECT * FROM icu_accounts"):
        a = json.loads(r["athlete"]) if r["athlete"] else {}
        out[r["person_id"]] = {"key_hint": r["key_hint"], "status": r["status"],
                               "last_error": r["last_error"], "athlete": a.get("name"),
                               "athlete_id": r["athlete_id"]}  # fmt: skip
    return out


def set_account(conn: sqlite3.Connection, person_id: str, key: str) -> None:
    conn.execute(
        """INSERT INTO icu_accounts (person_id, api_key, key_hint, status, created_at)
           VALUES (?, ?, ?, 'new', ?)
           ON CONFLICT(person_id) DO UPDATE SET api_key = excluded.api_key,
               key_hint = excluded.key_hint, status = 'new', last_error = NULL""",
        (person_id, key.strip(), key_hint(key), now_iso()),
    )
    # workouts waiting for a key (or refused with the old one) go now
    conn.execute(
        """UPDATE planned_workouts SET send_after = ?, sync_error = NULL
           WHERE person_id = ? AND sync_state IN ('pending', 'error')""",
        (now_iso(), person_id),
    )
    conn.execute(
        "UPDATE planned_workouts SET sync_state = 'pending' WHERE person_id = ? "
        "AND sync_state = 'error'",
        (person_id,),
    )


def test_account(conn: sqlite3.Connection, person_id: str, transport=None) -> dict:
    row = conn.execute("SELECT * FROM icu_accounts WHERE person_id = ?", (person_id,)).fetchone()
    if not row:
        return {"ok": False, "error": "no key"}
    try:
        a = athlete_settings(Client(row["api_key"], transport).athlete())
    except IcuError as exc:
        conn.execute(
            "UPDATE icu_accounts SET status = ?, last_error = ?, checked_at = ? "
            "WHERE person_id = ?",
            ("auth_error" if exc.auth else "error", str(exc), now_iso(), person_id),
        )
        return {"ok": False, "error": str(exc)}
    conn.execute(
        """UPDATE icu_accounts SET status = 'ok', last_error = NULL, athlete = ?, athlete_id = ?,
                  checked_at = ? WHERE person_id = ?""",
        (json.dumps(a), a.get("id"), now_iso(), person_id),
    )
    return {"ok": True, "athlete": a.get("name")}


# ---- planned workouts ---------------------------------------------------------------------


def _later(seconds: float) -> str:
    return (datetime.now(UTC) + timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")


def place(conn: sqlite3.Connection, person_id: str, template_id: int, day: str) -> int:
    t = conn.execute(
        "SELECT * FROM workout_templates WHERE id = ? AND person_id = ?", (template_id, person_id)
    ).fetchone()
    if not t:
        raise planner.PlanError("workout not found")
    if day < date.today().isoformat():
        raise planner.PlanError("a workout can be planned for today or later")
    now = now_iso()
    cur = conn.execute(
        """INSERT INTO planned_workouts (person_id, day, template_id, name, sport, target, steps,
                  sync_state, send_after, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)""",
        (person_id, day, template_id, t["name"], t["sport"], t["target"], t["steps"],
         _later(SEND_DELAY_S), now, now),
    )  # fmt: skip
    return cur.lastrowid


def move(conn: sqlite3.Connection, planned_id: int, day: str) -> None:
    if day < date.today().isoformat():
        raise planner.PlanError("a workout can be planned for today or later")
    cur = conn.execute(
        """UPDATE planned_workouts SET day = ?, sync_state = 'pending', sync_error = NULL,
                  send_after = ?, updated_at = ? WHERE id = ? AND sync_state != 'delete'""",
        (day, _later(SEND_DELAY_S), now_iso(), planned_id),
    )
    if not cur.rowcount:
        raise planner.PlanError("planned workout not found")


def update(conn: sqlite3.Connection, planned_id: int, w: dict) -> None:
    """A planned workout changed in the creator: only this entry (its template stays); sent
    again after the delay."""
    w = planner.clean(w)
    cur = conn.execute(
        """UPDATE planned_workouts SET name = ?, sport = ?, target = ?, steps = ?,
                  sync_state = 'pending', sync_error = NULL, send_after = ?, updated_at = ?
           WHERE id = ? AND sync_state != 'delete' AND day >= ?""",
        (w["name"], w["sport"], w["target"], json.dumps(w["steps"]), _later(SEND_DELAY_S),
         now_iso(), planned_id, date.today().isoformat()),
    )  # fmt: skip
    if not cur.rowcount:
        raise planner.PlanError("planned workout not found (or its day is over)")


def remove(conn: sqlite3.Connection, planned_id: int) -> None:
    """Removed here at once; from intervals.icu (and so Garmin) by the next sync."""
    row = conn.execute(
        "SELECT icu_event_id FROM planned_workouts WHERE id = ?", (planned_id,)
    ).fetchone()
    if not row:
        return
    if row["icu_event_id"]:
        conn.execute(
            "UPDATE planned_workouts SET sync_state = 'delete', send_after = ? WHERE id = ?",
            (now_iso(), planned_id),
        )
    else:
        conn.execute("DELETE FROM planned_workouts WHERE id = ?", (planned_id,))


def planned(conn: sqlite3.Connection, person_id: str | None, start: str, end: str) -> list[dict]:
    """Planned workouts of the days (not the removed ones), with the estimate and what keeps
    them from the watch (`sync`: None = fine, else the reason)."""
    where, params = ["day BETWEEN ? AND ?", "sync_state != 'delete'"], [start, end]
    if person_id:
        where.append("p.person_id = ?")
        params.append(person_id)
    rows = conn.execute(
        f"""SELECT p.*, a.status AS account_status FROM planned_workouts p
            LEFT JOIN icu_accounts a ON a.person_id = p.person_id
            WHERE {" AND ".join(where)} ORDER BY day, p.id""",
        params,
    ).fetchall()
    ctxs: dict = {}
    out = []
    for r in rows:
        ctx = ctxs.get(r["person_id"]) or ctxs.setdefault(
            r["person_id"], planner.context(conn, r["person_id"])
        )
        w = {"name": r["name"], "sport": r["sport"], "target": r["target"],
             "steps": json.loads(r["steps"])}  # fmt: skip
        out.append({"id": r["id"], "person_id": r["person_id"], "day": r["day"], **w,
                    "estimate": planner.estimate(w, ctx), "sync": _sync_reason(r)})  # fmt: skip
    return out


def _sync_reason(r: sqlite3.Row) -> str | None:
    if r["sync_state"] == "sent" and not r["sync_error"]:
        return None
    if r["account_status"] is None:
        return "Not sent to the watch: add the intervals.icu API key in Settings › Workouts."
    if r["account_status"] == "auth_error":
        return "Not sent to the watch: intervals.icu refused the API key (Settings › Workouts)."
    if r["sync_error"]:
        return f"Not sent to the watch: {r['sync_error']}"
    return None  # waiting for its minute


# ---- sync ----------------------------------------------------------------------------------


def next_due(conn: sqlite3.Connection) -> str | None:
    """When the next send is due (UTC ISO), None = nothing to send."""
    row = conn.execute(
        """SELECT MIN(p.send_after) FROM planned_workouts p
           JOIN icu_accounts a ON a.person_id = p.person_id AND a.status != 'auth_error'
           WHERE (p.sync_state = 'pending' AND p.day >= ?) OR p.sync_state = 'delete'""",
        (date.today().isoformat(),),
    ).fetchone()
    return row[0] if row else None


def sync_due(conn: sqlite3.Connection, transport: Transport | None = None) -> int:
    """Send what is due: new and moved workouts, removals. Returns the number of changes."""
    now = now_iso()
    rows = conn.execute(
        """SELECT p.*, a.api_key FROM planned_workouts p
           JOIN icu_accounts a ON a.person_id = p.person_id AND a.status != 'auth_error'
           WHERE p.send_after <= ? AND ((p.sync_state = 'pending' AND p.day >= ?)
                 OR p.sync_state = 'delete')
           ORDER BY p.person_id, p.day""",
        (now, date.today().isoformat()),
    ).fetchall()
    done = 0
    athletes: dict = {}
    refused: set = set()
    for r in rows:
        pid = r["person_id"]
        if pid in refused:
            continue
        client = Client(r["api_key"], transport)
        try:
            if r["sync_state"] == "delete":
                client.call("DELETE", f"/athlete/0/events/{r['icu_event_id']}")
                conn.execute("DELETE FROM planned_workouts WHERE id = ?", (r["id"],))
                done += 1
                continue
            if pid not in athletes:
                athletes[pid] = athlete_settings(client.athlete())
                conn.execute(
                    "UPDATE icu_accounts SET athlete = ?, athlete_id = ?, status = 'ok', "
                    "last_error = NULL, checked_at = ? WHERE person_id = ?",
                    (json.dumps(athletes[pid]), athletes[pid].get("id"), now, pid),
                )
            w = {"name": r["name"], "sport": r["sport"], "target": r["target"],
                 "steps": json.loads(r["steps"])}  # fmt: skip
            ctx = planner.context(conn, pid)
            try:
                text = planner.icu_text(w, ctx, athletes[pid]["sports"].get(r["sport"]) or {})
            except planner.PlanError as exc:
                _fail(conn, r["id"], str(exc))
                continue
            event = {
                "category": "WORKOUT",
                "start_date_local": f"{r['day']}T00:00:00",
                "type": planner.SPORTS[r["sport"]],
                "name": r["name"],
                "description": text,
                # intervals.icu's name for the planned duration (its API field)
                "moving_time": planner.estimate(w, ctx)["duration_s"],
                "external_id": f"trailbook-{r['id']}",
            }
            if r["icu_event_id"]:
                res = client.call("PUT", f"/athlete/0/events/{r['icu_event_id']}", event)
            else:
                res = client.call("POST", "/athlete/0/events", event)
            event_id = (res or {}).get("id") or r["icu_event_id"]
            conn.execute(
                """UPDATE planned_workouts SET sync_state = 'sent', sync_error = NULL,
                          icu_event_id = ?, sent_at = ? WHERE id = ?""",
                (str(event_id) if event_id else None, now, r["id"]),
            )
            done += 1
        except IcuError as exc:
            logging.getLogger("trailbook.intervals").log(
                logging.WARNING if exc.retry else logging.ERROR,
                "Planned workout %s of %s not sent to intervals.icu: %s", r["id"], pid, exc,
            )  # fmt: skip
            if exc.auth:
                conn.execute(
                    "UPDATE icu_accounts SET status = 'auth_error', last_error = ? "
                    "WHERE person_id = ?",
                    (str(exc), pid),
                )
                refused.add(pid)
            elif r["sync_state"] == "delete" and not exc.retry:
                conn.execute("DELETE FROM planned_workouts WHERE id = ?", (r["id"],))
            elif exc.retry:
                conn.execute(
                    "UPDATE planned_workouts SET send_after = ?, sync_error = ? WHERE id = ?",
                    (_later(RETRY_S), str(exc), r["id"]),
                )
                if exc.status is None:  # not reachable: everything waits
                    conn.execute(
                        "UPDATE planned_workouts SET send_after = ? WHERE send_after <= ?",
                        (_later(RETRY_S), now),
                    )
                    break
            else:
                _fail(conn, r["id"], str(exc))
    return done


def _fail(conn: sqlite3.Connection, planned_id: int, message: str) -> None:
    conn.execute(
        "UPDATE planned_workouts SET sync_state = 'error', sync_error = ? WHERE id = ?",
        (message, planned_id),
    )
