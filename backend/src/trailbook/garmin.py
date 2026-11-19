"""Garmin Connect personal API: download each person's activities as original FIT files.

Every person connects their own Garmin account with a *personal API key* (self-service in
Garmin Connect; it expires after 30 days to 1 year). The key is exchanged for an access
token (valid 24 h, no refresh tokens: a new one is requested when needed).

Activities that are already here (imported from a folder) are matched by their start time
and not downloaded again: only their list entry (title, training effect, body battery…) is
kept. Activity details (body battery, grade adjusted speed, Garmin's elevation) are fetched
once per activity, one request each, within the same budget.

Downloads are slow on purpose: one request every few seconds, a limited number of
downloads per run (the history is filled in over several runs) and a full stop on any
refusal or server error, so the next scheduled run tries again later. Downloaded files are
stored like uploads (`uploads/<person>/garmin-<id>.zip`) and queued for the normal
importer, so activities that already came from a folder are recognised by their FIT id
and never imported twice.

Only the standard library is used (urllib), no extra dependencies.
"""

from __future__ import annotations

import bisect
import json
import re
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from . import __version__, analysis, db, homeassistant, importer, streams

BASE_URL = "https://personal.connectapi.garmin.com"
TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token"
SEARCH_PATH = "/activitylist-service/activities/search/activities"
DETAILS_PATH = "/activity-service/activity/{id}/details"
DOWNLOAD_PATH = "/download-service/files/activity/{id}"
PROFILE_PATH = "/userprofile-service/userprofile/settings"
DAYS_PATH = "/usersummary-service/v2/dailysummaries"
DAYS_RECENT = 3  # today and the 2 days before are asked for again on every run
DAYS_CHUNK = 31  # days per request when filling the history
DAYS_CHUNKS_PER_RUN = 4  # history requests per run (~4 months)
DAYS_DEFAULT_BACK = 365  # history start without activities or a Download from date
USER_AGENT = f"Trailbook/{__version__} (self-hosted training log)"

PAGE_SIZE = 50
REQUEST_GAP_S = 3.0  # pause between two requests to Garmin
MAX_DOWNLOADS_PER_RUN = 60  # the history is completed over several runs
BACKFILL_OVERLAP = 10  # re-read a few rows when resuming the history, nothing is missed
TOKEN_FALLBACK_S = 23 * 3600

# (method, url, headers, timeout) -> (status, headers, body)
Transport = Callable[[str, str, dict, float], tuple[int, dict, bytes]]
ProgressFn = Callable[..., None]


class GarminError(Exception):
    """A request failed. `stop_run` = stop all downloads now and retry on the next run."""

    def __init__(self, message: str, status: int | None = None, stop_run: bool = False):
        super().__init__(message)
        self.status = status
        self.stop_run = stop_run


class AuthError(GarminError):
    """The key was refused (wrong, revoked or expired). Needs the person's action."""


def urllib_transport(method: str, url: str, headers: dict, timeout: float) -> tuple:
    req = urllib.request.Request(
        url, method=method, headers=headers, data=b"" if method == "POST" else None
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (fixed https host)
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers or {}), exc.read() or b""
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise GarminError(f"Garmin is not reachable: {exc}", stop_run=True) from exc


def _parse_token(body: bytes) -> tuple[str, int]:
    """Token response → (token, lifetime in s). Accepts JSON (OAuth2 style) or plain text."""
    text = body.decode("utf-8", "replace").strip()
    try:
        data = json.loads(text)
    except ValueError:
        data = text
    if isinstance(data, str):
        return data.strip('"'), TOKEN_FALLBACK_S
    if isinstance(data, dict):
        token = data.get("access_token") or data.get("accessToken") or data.get("token")
        life = data.get("expires_in") or data.get("expiresIn")
        if token:
            try:
                life = int(life) if life else TOKEN_FALLBACK_S
            except (TypeError, ValueError):
                life = TOKEN_FALLBACK_S
            return str(token), max(60, life - 300)  # renew 5 min early
    raise GarminError("Garmin returned an unexpected token response")


def _message(status: int, body: bytes) -> str:
    snippet = re.sub(r"\s+", " ", body[:200].decode("utf-8", "replace")).strip()
    return f"HTTP {status}" + (f": {snippet}" if snippet else "")


class Client:
    def __init__(
        self,
        api_key: str,
        *,
        token: str | None = None,
        token_expires: datetime | None = None,
        transport: Transport | None = None,
        base_url: str = BASE_URL,
        gap_s: float = REQUEST_GAP_S,
        sleep: Callable[[float], None] = time.sleep,
        timeout: float = 60.0,
    ):
        self.api_key = api_key.strip()
        self.token = token
        self.token_expires = token_expires
        self.transport = transport or urllib_transport
        self.base_url = base_url.rstrip("/")
        self.gap_s = gap_s
        self.sleep = sleep
        self.timeout = timeout
        self._last = 0.0
        self.requests = 0

    def _pace(self) -> None:
        wait = self._last + self.gap_s - time.monotonic()
        if self.requests and wait > 0:
            self.sleep(wait)
        self._last = time.monotonic()
        self.requests += 1

    def _send(self, method: str, url: str, headers: dict) -> tuple[int, dict, bytes]:
        self._pace()
        headers = {"User-Agent": USER_AGENT, **headers}
        return self.transport(method, url, headers, self.timeout)

    def fetch_token(self) -> str:
        status, _, body = self._send(
            "POST", self.base_url + TOKEN_PATH, {"Authorization": f"ApiKey {self.api_key}"}
        )
        if status in (400, 401, 403):
            raise AuthError("Garmin refused the API key (wrong, deleted or expired)", status)
        if status != 200:
            raise GarminError(f"Token request failed, {_message(status, body)}", status, True)
        self.token, life = _parse_token(body)
        self.token_expires = datetime.now(UTC) + timedelta(seconds=life)
        return self.token

    def _valid_token(self) -> str:
        if not self.token or not self.token_expires or self.token_expires <= datetime.now(UTC):
            return self.fetch_token()
        return self.token

    def get(self, path: str, params: dict | None = None) -> bytes:
        url = self.base_url + path
        if params:
            url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        for attempt in range(2):
            token = self._valid_token()
            status, headers, body = self._send("GET", url, {"Authorization": f"Bearer {token}"})
            if status == 200:
                return body
            if status == 401 and attempt == 0:
                self.token = None  # expired early: get a new token once
                continue
            if status in (401, 403):
                raise AuthError(f"Garmin refused access, {_message(status, body)}", status)
            if status == 429 or status >= 500:
                retry = headers.get("Retry-After") or headers.get("retry-after")
                hint = f" (retry after {retry} s)" if retry else ""
                raise GarminError(
                    f"Garmin asked to slow down, {_message(status, body)}{hint}", status, True
                )
            raise GarminError(_message(status, body), status)
        raise GarminError("Garmin refused access")  # pragma: no cover

    def search(
        self, start: int, limit: int = PAGE_SIZE, start_date: str | None = None
    ) -> list[dict]:
        body = self.get(
            SEARCH_PATH,
            {"start": start, "limit": limit, "sortOrder": "desc", "startDate": start_date},
        )
        data = json.loads(body or b"[]")
        if not isinstance(data, list):
            raise GarminError("Garmin returned an unexpected activity list")
        return data

    def download(self, activity_id: int) -> bytes:
        return self.get(DOWNLOAD_PATH.format(id=int(activity_id)))


# ---- accounts ----------------------------------------------------------------------------


def key_hint(api_key: str) -> str:
    key = api_key.strip()
    return "…" + key[-4:] if len(key) > 8 else "…"


def set_account(
    conn: sqlite3.Connection, person_id: str, api_key: str, history_from: str | None
) -> None:
    """Store (or replace) a person's key. A new key resets the token and the error state."""
    conn.execute(
        """INSERT INTO garmin_accounts
               (person_id, api_key, key_hint, history_from, status, created_at)
           VALUES (?, ?, ?, ?, 'new', ?)
           ON CONFLICT(person_id) DO UPDATE SET api_key = excluded.api_key,
               key_hint = excluded.key_hint, history_from = excluded.history_from,
               token = NULL, token_expires = NULL, status = 'new', last_error = NULL,
               auth_error_since = NULL, auth_checked_at = NULL,
               backfill_offset = 0, backfill_done = 0""",
        (person_id, api_key.strip(), key_hint(api_key), history_from, importer.now_iso()),
    )


def client_for(row: sqlite3.Row, **kwargs) -> Client:
    expires = None
    if row["token_expires"]:
        expires = datetime.strptime(row["token_expires"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    return Client(row["api_key"], token=row["token"], token_expires=expires, **kwargs)


def _save_token(conn: sqlite3.Connection, person_id: str, client: Client) -> None:
    expires = client.token_expires.strftime("%Y-%m-%dT%H:%M:%SZ") if client.token_expires else None
    conn.execute(
        "UPDATE garmin_accounts SET token = ?, token_expires = ? WHERE person_id = ?",
        (client.token, expires, person_id),
    )


def test_account(conn: sqlite3.Connection, person_id: str, **kwargs) -> dict:
    """Get a token and read the newest activity. Updates the account status."""
    row = conn.execute("SELECT * FROM garmin_accounts WHERE person_id = ?", (person_id,)).fetchone()
    if row is None:
        raise GarminError("no API key stored for this person")
    client = client_for(row, **{"gap_s": 0.0, **kwargs})
    try:
        client.fetch_token()
        latest = client.search(0, 1)
    except GarminError as exc:
        _set_status(
            conn, person_id, "auth_error" if isinstance(exc, AuthError) else "error", str(exc)
        )
        raise
    _save_token(conn, person_id, client)
    _set_status(conn, person_id, "ok", None)
    item = latest[0] if latest else None
    return {
        "ok": True,
        "latest": {
            "name": item.get("activityName"),
            "start": item.get("startTimeLocal"),
        }
        if item
        else None,
    }


def _set_status(conn: sqlite3.Connection, person_id: str, status: str, error: str | None) -> None:
    """A refusal keeps the time of the first one (`auth_error_since`) and notes this try;
    any other outcome clears both. `error` (e.g. a server error) does not touch them."""
    if status == "auth_error":
        now = importer.now_iso()
        conn.execute(
            """UPDATE garmin_accounts SET status = ?, last_error = ?,
                   auth_error_since = COALESCE(auth_error_since, ?), auth_checked_at = ?
               WHERE person_id = ?""",
            (status, error, now, now, person_id),
        )
    elif status == "ok":
        conn.execute(
            """UPDATE garmin_accounts SET status = ?, last_error = ?, auth_error_since = NULL,
                   auth_checked_at = NULL WHERE person_id = ?""",
            (status, error, person_id),
        )
    else:
        conn.execute(
            "UPDATE garmin_accounts SET status = ?, last_error = ? WHERE person_id = ?",
            (status, error, person_id),
        )


# ---- sync --------------------------------------------------------------------------------


@dataclass
class SyncResult:
    downloaded: int = 0
    matched: int = 0  # already here (e.g. from a folder): list data and title only
    queued_files: int = 0
    errors: int = 0
    stopped: str | None = None  # reason the whole run stopped early
    persons: list[str] = field(default_factory=list)


# Fields of the activity list entry kept with the activity (FIT files do not have them).
SUMMARY_FIELDS = (
    "activityName", "locationName", "aerobicTrainingEffect", "anaerobicTrainingEffect",
    "aerobicTrainingEffectMessage", "anaerobicTrainingEffectMessage", "trainingEffectLabel",
    "activityTrainingLoad", "differenceBodyBattery", "elevationCorrected", "bmrCalories",
    "moderateIntensityMinutes", "vigorousIntensityMinutes", "waterEstimated", "pr",
)  # fmt: skip
# Activity detail metrics → stream channels stored in `connect_streams`.
DETAIL_CHANNELS = {"directBodyBattery": "body_battery", "directGradeAdjustedSpeed": "gap_speed",
                   "directElevation": "altitude_connect"}  # fmt: skip
# A local activity starting this close to a Connect one is the same activity.
MATCH_S = importer.SAME_START_S


def _summary(item: dict) -> str:
    return json.dumps({k: item.get(k) for k in SUMMARY_FIELDS if item.get(k) is not None})


def _match_local(conn: sqlite3.Connection, person_id: str, item: dict) -> int | None:
    """The local activity with the same start (± MATCH_S), e.g. imported from a folder.

    Only activities recorded in a FIT file match: a GPX/TCX or manual copy (e.g. from a
    Strava export) is not, so the FIT is downloaded and replaces it on import.
    """
    start = item.get("startTimeGMT")
    if not start:
        return None
    row = conn.execute(
        f"""SELECT id FROM activities WHERE person_id = ? AND NOT {importer.COPY_UID_SQL}
               AND ABS(CAST(strftime('%s', start_time_utc) AS INTEGER)
                       - CAST(strftime('%s', ?) AS INTEGER)) <= ?
           ORDER BY ABS(CAST(strftime('%s', start_time_utc) AS INTEGER)
                        - CAST(strftime('%s', ?) AS INTEGER)) LIMIT 1""",
        (person_id, start, MATCH_S, start),
    ).fetchone()
    return row[0] if row else None


def _store_matched(conn: sqlite3.Connection, person_id: str, item: dict, local_id: int) -> None:
    """A Connect activity we already have: keep its list data and its title, no download."""
    conn.execute(
        """INSERT OR REPLACE INTO garmin_activities
               (person_id, activity_id, start_gmt, name, type_key, status, error, fetched_at,
                summary, trailbook_id)
           VALUES (?, ?, ?, ?, ?, 'matched', NULL, ?, ?, ?)""",
        (
            person_id, int(item["activityId"]), item.get("startTimeGMT"), item.get("activityName"),
            (item.get("activityType") or {}).get("typeKey"), importer.now_iso(), _summary(item),
            local_id,
        ),
    )  # fmt: skip
    importer.apply_connect_title(conn, local_id)


def store_details(conn: sqlite3.Connection, local_id: int, details: dict) -> list[str]:
    """Extra streams from Garmin's activity details, aligned to the activity's own samples
    (nearest detail point within 5 s). Corrected elevation only when Garmin corrected it."""
    a = conn.execute("SELECT start_time_utc FROM activities WHERE id = ?", (local_id,)).fetchone()
    trow = conn.execute(
        "SELECT encoding, data FROM streams WHERE activity_id = ? AND channel = 'time'",
        (local_id,),
    ).fetchone()
    if not a or not trow:
        return []
    start = datetime.strptime(a[0], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC).timestamp()
    times = streams.decode(trow[0], trow[1])
    desc = {d.get("key"): d.get("metricsIndex") for d in details.get("metricDescriptors") or []}
    ts_i = desc.get("directTimestamp")
    rows = [m.get("metrics") or [] for m in details.get("activityDetailMetrics") or []]
    if ts_i is None or not rows:
        return []
    pts = sorted((r[ts_i] / 1000 - start, r) for r in rows if len(r) > ts_i and r[ts_i] is not None)
    keys = [p[0] for p in pts]
    stored = []
    for key, channel in DETAIL_CHANNELS.items():
        idx = desc.get(key)
        if idx is None:
            continue
        values: list[float | None] = []
        for t in times:
            if t is None:
                values.append(None)
                continue
            k = bisect.bisect_left(keys, t)
            best = min(
                (j for j in (k - 1, k) if 0 <= j < len(keys)),
                key=lambda j: abs(keys[j] - t),
                default=None,
            )
            v = pts[best][1][idx] if best is not None and abs(keys[best] - t) <= 5 else None
            values.append(float(v) if isinstance(v, (int, float)) else None)
        if not any(v is not None for v in values):
            continue
        encoding, blob = streams.encode(values, "f32")
        conn.execute(
            """INSERT OR REPLACE INTO connect_streams (activity_id, channel, encoding, length, data)
               VALUES (?, ?, ?, ?, ?)""",
            (local_id, channel, encoding, len(values), blob),
        )
        stored.append(channel)
    return stored


def _known(conn: sqlite3.Connection, person_id: str, ids: list[int]) -> set[int]:
    if not ids:
        return set()
    marks = ",".join("?" * len(ids))
    rows = conn.execute(
        f"""SELECT activity_id FROM garmin_activities
            WHERE person_id = ? AND activity_id IN ({marks})""",
        (person_id, *ids),
    )
    return {r[0] for r in rows}


def _store_download(
    conn: sqlite3.Connection, uploads_dir: Path, person_id: str, item: dict, data: bytes
) -> int:
    activity_id = int(item["activityId"])
    suffix = ".zip" if data[:2] == b"PK" else ".fit"
    folder = uploads_dir / re.sub(r"[^A-Za-z0-9._-]+", "_", person_id)
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"garmin-{activity_id}{suffix}"
    target.write_bytes(data)
    try:
        queued = importer.register_upload(conn, uploads_dir, person_id, target)
    except zipfile.BadZipFile:
        target.unlink(missing_ok=True)
        raise GarminError(f"activity {activity_id}: download is not a valid ZIP") from None
    conn.execute(
        """INSERT OR REPLACE INTO garmin_activities
               (person_id, activity_id, start_gmt, name, type_key, status, file_rel, error,
                fetched_at, summary)
           VALUES (?, ?, ?, ?, ?, 'downloaded', ?, NULL, ?, ?)""",
        (
            person_id, activity_id, item.get("startTimeGMT"), item.get("activityName"),
            (item.get("activityType") or {}).get("typeKey"),
            importer.UPLOADS_PREFIX + target.relative_to(uploads_dir).as_posix(),
            importer.now_iso(), _summary(item),
        ),
    )  # fmt: skip
    return queued


def _mark_failed(conn: sqlite3.Connection, person_id: str, item: dict, error: str) -> None:
    conn.execute(
        """INSERT OR REPLACE INTO garmin_activities
               (person_id, activity_id, start_gmt, name, type_key, status, error, fetched_at)
           VALUES (?, ?, ?, ?, ?, 'error', ?, ?)""",
        (
            person_id, int(item["activityId"]), item.get("startTimeGMT"), item.get("activityName"),
            (item.get("activityType") or {}).get("typeKey"), error, importer.now_iso(),
        ),
    )  # fmt: skip


def sync_person(
    conn: sqlite3.Connection,
    row: sqlite3.Row,
    uploads_dir: Path,
    result: SyncResult,
    budget: int,
    progress: ProgressFn | None = None,
    **client_kwargs,
) -> int:
    """Download new activities of one person, then continue the history. Returns downloads."""
    pid = row["person_id"]
    client = client_for(row, **client_kwargs)
    done = 0
    if row["status"] == "auth_error":
        # A refused key is tried again with one token request; it stays refused until that works.
        try:
            client.fetch_token()
        except AuthError as exc:
            _set_status(conn, pid, "auth_error", str(exc))
            result.errors += 1
            return 0
        except GarminError as exc:
            conn.execute(
                "UPDATE garmin_accounts SET auth_checked_at = ? WHERE person_id = ?",
                (importer.now_iso(), pid),
            )
            if exc.stop_run:
                result.stopped = str(exc)
            result.errors += 1
            return 0

    def fetch(items: list[dict]) -> bool:
        """Download unknown items; False once the budget is used up."""
        nonlocal done
        unknown = [i for i in items if i.get("activityId") is not None]
        known = _known(conn, pid, [int(i["activityId"]) for i in unknown])
        for item in unknown:
            if int(item["activityId"]) in known:
                continue
            local = _match_local(conn, pid, item)
            if local is not None:  # already here (e.g. from a folder): list data only
                _store_matched(conn, pid, item, local)
                result.matched += 1
                continue
            if done >= budget:
                return False
            try:
                data = client.download(int(item["activityId"]))
            except AuthError:
                raise
            except GarminError as exc:
                if exc.stop_run:
                    raise
                _mark_failed(conn, pid, item, str(exc))
                result.errors += 1
                continue
            result.queued_files += _store_download(conn, uploads_dir, pid, item, data)
            done += 1
            result.downloaded += 1
            if progress:
                progress(person=pid, downloaded=result.downloaded, name=item.get("activityName"))
        return True

    try:
        # 1) newest first until we reach activities we already have
        start = 0
        while True:
            page = client.search(start, PAGE_SIZE, row["history_from"])
            ids = [int(i["activityId"]) for i in page if i.get("activityId") is not None]
            had_known = bool(_known(conn, pid, ids))
            if not fetch(page):
                break
            if not page or len(page) < PAGE_SIZE or had_known or not row["backfill_done"]:
                # During the first history pass the backfill below continues from its offset.
                break
            start += len(page)

        # 2) the history, resumed where the last run stopped
        if not row["backfill_done"] and done < budget:
            offset = max(0, row["backfill_offset"] - BACKFILL_OVERLAP)
            while done < budget:
                page = client.search(offset, PAGE_SIZE, row["history_from"])
                complete = fetch(page)
                if not complete:
                    break
                offset += len(page)
                conn.execute(
                    "UPDATE garmin_accounts SET backfill_offset = ? WHERE person_id = ?",
                    (offset, pid),
                )
                if len(page) < PAGE_SIZE:
                    conn.execute(
                        "UPDATE garmin_accounts SET backfill_done = 1 WHERE person_id = ?", (pid,)
                    )
                    break
    except AuthError as exc:
        _save_token(conn, pid, client)
        _set_status(conn, pid, "auth_error", str(exc))
        result.errors += 1
        return done
    except GarminError as exc:
        _save_token(conn, pid, client)
        _set_status(conn, pid, "error", str(exc))
        if exc.stop_run:
            result.stopped = str(exc)
        result.errors += 1
        return done
    try:
        done += _fetch_details(conn, client, pid, budget - done)
        fetch_days(conn, client, pid)
    except GarminError as exc:
        _save_token(conn, pid, client)
        _set_status(conn, pid, "error", str(exc))
        result.errors += 1
        return done
    _save_token(conn, pid, client)
    conn.execute(
        """UPDATE garmin_accounts SET status = 'ok', last_error = NULL, last_sync_at = ?,
               auth_error_since = NULL, auth_checked_at = NULL
           WHERE person_id = ?""",
        (importer.now_iso(), pid),
    )
    return done


def _fetch_details(conn: sqlite3.Connection, client: Client, pid: str, budget: int) -> int:
    """Activity details (body battery, grade adjusted speed, Garmin's elevation) for linked
    activities that do not have them yet, newest first, one request each."""
    # downloads get their local id once imported (same file)
    conn.execute(
        """UPDATE garmin_activities SET trailbook_id = (
               SELECT f.activity_id FROM files f
               WHERE f.person_id = garmin_activities.person_id
                 AND f.rel_path = garmin_activities.file_rel)
           WHERE person_id = ? AND trailbook_id IS NULL AND file_rel IS NOT NULL""",
        (pid,),
    )
    todo = conn.execute(
        """SELECT activity_id, trailbook_id FROM garmin_activities
           WHERE person_id = ? AND trailbook_id IS NOT NULL AND details_at IS NULL
           ORDER BY start_gmt DESC LIMIT ?""",
        (pid, max(0, budget)),
    ).fetchall()
    n = 0
    for gid, local in todo:
        try:
            body = client.get(DETAILS_PATH.format(id=gid), {"maxChartSize": 4000})
            store_details(conn, local, json.loads(body or b"{}"))
        except GarminError as exc:
            if exc.stop_run:
                raise
        conn.execute(
            "UPDATE garmin_activities SET details_at = ? WHERE person_id = ? AND activity_id = ?",
            (importer.now_iso(), pid, gid),
        )
        n += 1
    return n


# ---- daily summaries (steps, floors, stress… of each day) ------------------------------------


def _store_days(conn: sqlite3.Connection, pid: str, body: bytes) -> int:
    """Store the days of a daily summaries answer that have wellness data; returns how many."""
    data = json.loads(body or b"{}")
    items = data.get("data") if isinstance(data, dict) else data
    now = importer.now_iso()
    n = 0
    for item in items if isinstance(items, list) else []:
        day = item.get("calendarDate") if isinstance(item, dict) else None
        if not day or not item.get("includesWellnessData"):
            continue
        conn.execute(
            """INSERT INTO garmin_days (person_id, day, summary, fetched_at) VALUES (?, ?, ?, ?)
               ON CONFLICT(person_id, day) DO UPDATE SET
                   summary = excluded.summary, fetched_at = excluded.fetched_at""",
            (pid, day, json.dumps(item, separators=(",", ":")), now),
        )
        n += 1
    return n


def fetch_days(
    conn: sqlite3.Connection, client: Client, pid: str, today: date | None = None
) -> None:
    """Garmin's daily summary of each day (one request covers many days): every run asks for
    the last DAYS_RECENT days again (today is still counting) and for any days since the
    previous run (`days_to`), then fills the history backwards (`days_from`), DAYS_CHUNK days
    a request and DAYS_CHUNKS_PER_RUN requests a run, down to the *Download from* date or the
    person's first activity (else a year back). A stored day is replaced when asked again. An
    answer the key is not allowed to get is skipped quietly; refusals and server errors stop
    the run."""
    today = today or date.today()
    row = conn.execute(
        "SELECT history_from, days_from, days_to FROM garmin_accounts WHERE person_id = ?",
        (pid,),
    ).fetchone()
    first = conn.execute(
        f"SELECT MIN({analysis.LOCAL_DAY_SQL}) FROM activities WHERE person_id = ?", (pid,)
    ).fetchone()[0]
    floor = row["history_from"] or first or (today - timedelta(days=DAYS_DEFAULT_BACK)).isoformat()

    def ask(start: date, end: date) -> int | None:
        try:
            body = client.get(
                DAYS_PATH, {"startDate": start.isoformat(), "endDate": end.isoformat()}
            )
        except AuthError:
            raise
        except GarminError as exc:
            if exc.stop_run:
                raise
            return None  # e.g. not available with this key
        return _store_days(conn, pid, body)

    # 1) forward to today: the recent days, and also every day since the last run's newest
    #    day (the server was off, no gap stays); a long gap in chunks, finished by later runs
    recent = today - timedelta(days=DAYS_RECENT - 1)
    start = recent
    if row["days_to"]:
        start = min(recent, date.fromisoformat(row["days_to"]) - timedelta(days=1))
    first_start = start
    for _ in range(DAYS_CHUNKS_PER_RUN + 1):
        if start > today:
            break
        end = min(today, start + timedelta(days=DAYS_CHUNK - 1))
        if ask(start, end) is None:
            return
        conn.execute(
            "UPDATE garmin_accounts SET days_to = ? WHERE person_id = ?", (end.isoformat(), pid)
        )
        start = end + timedelta(days=1)
    if start <= today:
        return  # the gap is not closed yet: the next run goes on

    # 2) the history backwards, down to the floor (which may move back later: a new
    #    Download from date, older activities imported)
    stop = date.fromisoformat(floor)
    end = (
        date.fromisoformat(row["days_from"]) - timedelta(days=1)
        if row["days_from"]
        else first_start - timedelta(days=1)
    )
    for _ in range(DAYS_CHUNKS_PER_RUN):
        if end < stop:
            break
        start = max(stop, end - timedelta(days=DAYS_CHUNK - 1))
        if ask(start, end) is None:
            return
        conn.execute(
            "UPDATE garmin_accounts SET days_from = ? WHERE person_id = ?", (start.isoformat(), pid)
        )
        end = start - timedelta(days=1)
    conn.execute(
        "UPDATE garmin_accounts SET days_done = ? WHERE person_id = ?", (int(end < stop), pid)
    )


def sync_all(
    conn: sqlite3.Connection,
    uploads_dir: Path,
    progress: ProgressFn | None = None,
    max_downloads: int = MAX_DOWNLOADS_PER_RUN,
    **client_kwargs,
) -> SyncResult:
    """One run over every connected person; stops early on refusals or server errors.

    A refused key is tried again at most every AUTH_RETRY_H hours (a key without a value,
    e.g. after restoring an export without keys, never)."""
    result = SyncResult()
    retry_before = _iso(datetime.now(UTC) - timedelta(hours=AUTH_RETRY_H))
    rows = conn.execute(
        """SELECT g.* FROM garmin_accounts g JOIN persons p ON p.id = g.person_id
           WHERE g.status != 'auth_error'
              OR (g.api_key != '' AND COALESCE(g.auth_checked_at, '') <= ?)
           ORDER BY p.sort_order, p.id""",
        (retry_before,),
    ).fetchall()
    for row in rows:
        budget = max_downloads - result.downloaded
        if budget <= 0 or result.stopped:
            break
        result.persons.append(row["person_id"])
        sync_person(conn, row, uploads_dir, result, budget, progress, **client_kwargs)
    update_ha_notifications(conn)
    return result


# ---- refused keys: banner and Home Assistant notification --------------------------------

AUTH_RETRY_H = 3  # a refused key is tried again this often (one token request)
BANNER_AFTER_H = 12  # the app shows a banner once a key has been refused this long
HA_NOTIFY_AFTER_H = 24  # … and Home Assistant gets a notification
HA_NOTIFIED_SETTING = "garmin_ha_notified"  # person ids with an open HA notification


def _iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def _refused(conn: sqlite3.Connection, hours: float, now: datetime | None = None) -> list:
    """Accounts refused for at least `hours` (person id, label, since)."""
    before = _iso((now or datetime.now(UTC)) - timedelta(hours=hours))
    return conn.execute(
        """SELECT g.person_id, p.label, g.auth_error_since FROM garmin_accounts g
           JOIN persons p ON p.id = g.person_id
           WHERE g.status = 'auth_error' AND COALESCE(g.auth_error_since, '') <= ?
           ORDER BY p.sort_order, p.id""",
        (before,),
    ).fetchall()


def key_alerts(conn: sqlite3.Connection) -> list[dict]:
    """People whose key has been refused for BANNER_AFTER_H hours or more (for the banner)."""
    return [
        {"person_id": r["person_id"], "label": r["label"], "since": r["auth_error_since"]}
        for r in _refused(conn, BANNER_AFTER_H)
    ]


def next_ha_notification_at(conn: sqlite3.Connection) -> datetime | None:
    """When a refused key reaches HA_NOTIFY_AFTER_H hours and still has no notification."""
    if not homeassistant.available():
        return None
    notified = set(_notified(conn))
    first = None
    for r in conn.execute(
        """SELECT person_id, auth_error_since FROM garmin_accounts
           WHERE status = 'auth_error' AND auth_error_since IS NOT NULL"""
    ):
        if r["person_id"] in notified:
            continue
        since = datetime.strptime(r["auth_error_since"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
        due = since + timedelta(hours=HA_NOTIFY_AFTER_H)
        first = due if first is None or due < first else first
    return first


def _notified(conn: sqlite3.Connection) -> list[str]:
    try:
        return list(json.loads(db.get_setting(conn, HA_NOTIFIED_SETTING) or "[]"))
    except ValueError:
        return []


def update_ha_notifications(conn: sqlite3.Connection) -> None:
    """Create a Home Assistant notification for every key refused for HA_NOTIFY_AFTER_H hours,
    dismiss the ones that are fixed (or whose account is gone). Nothing outside the add-on."""
    if not homeassistant.available():
        return
    due = {r["person_id"]: r["label"] for r in _refused(conn, HA_NOTIFY_AFTER_H)}
    notified = _notified(conn)
    kept = []
    for pid in notified:
        if pid in due or not homeassistant.dismiss(_ha_id(pid)):
            kept.append(pid)
    for pid, label in due.items():
        if pid in kept:
            continue
        if homeassistant.notify(
            _ha_id(pid),
            "Trailbook: Garmin key stopped working",
            f"Garmin has refused the personal API key of {label} for over "
            f"{HA_NOTIFY_AFTER_H} hours, so new activities are not downloaded. Create a new "
            "key in Garmin Connect and paste it in Trailbook › Settings.",
        ):
            kept.append(pid)
    if sorted(kept) != sorted(notified):
        db.set_setting(conn, HA_NOTIFIED_SETTING, json.dumps(sorted(kept)) if kept else None)


def _ha_id(person_id: str) -> str:
    return "trailbook_garmin_key_" + re.sub(r"[^a-z0-9_]", "_", person_id.lower())


# History estimate: without real data assume 5 years with an activity every 3 days.
TYPICAL_HISTORY_DAYS = 5 * 365
TYPICAL_DAYS_PER_ACTIVITY = 3
# One run: every download and a few list pages, one request every REQUEST_GAP_S.
RUN_S = (MAX_DOWNLOADS_PER_RUN + 5) * REQUEST_GAP_S


def _day(value: str | None):
    try:
        return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None


def _remaining(conn: sqlite3.Connection, row: sqlite3.Row | None, today) -> tuple[int, str]:
    """(activities still to download, basis) for one account, or a new one when row is None.

    The pace is measured from what was downloaded once it covers at least 30 days and 10
    activities; otherwise one activity every 3 days. The history ends at *Download from* or,
    when that is empty, 5 years back.
    """
    if row is not None and row["backfill_done"]:
        return 0, "measured"
    start = (_day(row["history_from"]) if row is not None else None) or (
        today - timedelta(days=TYPICAL_HISTORY_DAYS)
    )
    rate, basis, oldest = 1 / TYPICAL_DAYS_PER_ACTIVITY, "typical", today
    if row is not None:
        got = conn.execute(
            """SELECT COUNT(*) AS n, MIN(start_gmt) AS oldest FROM garmin_activities
               WHERE person_id = ? AND status = 'downloaded'""",
            (row["person_id"],),
        ).fetchone()
        first = _day(got["oldest"])
        if first is not None:
            oldest = min(first, today)
            span = (today - oldest).days
            if span >= 30 and got["n"] >= 10:
                rate, basis = got["n"] / span, "measured"
    return max(0, round((oldest - start).days * rate)), basis


def history_estimate(conn: sqlite3.Connection, interval_min: int) -> dict:
    """Rough time until the history of every connected person is downloaded.

    The budget of MAX_DOWNLOADS_PER_RUN downloads per run is shared by all people; runs follow
    each other `interval_min` after the end of the previous one (0 = only *Download now*).
    `typical` is the same estimate for a person who has not connected yet.
    """
    today = datetime.now(UTC).date()

    def timing(remaining: int) -> dict:
        runs = -(-remaining // MAX_DOWNLOADS_PER_RUN)
        seconds = runs * RUN_S + max(0, runs - 1) * interval_min * 60 if interval_min else None
        return {"remaining": remaining, "runs": runs, "seconds": seconds}

    persons = {}
    for row in conn.execute("SELECT * FROM garmin_accounts WHERE status != 'auth_error'"):
        remaining, basis = _remaining(conn, row, today)
        persons[row["person_id"]] = {"remaining": remaining, "basis": basis}
    total = sum(p["remaining"] for p in persons.values())
    typical, _ = _remaining(conn, None, today)
    return {
        **timing(total),
        "persons": persons,
        "typical": timing(typical),
        "per_run": MAX_DOWNLOADS_PER_RUN,
        "request_gap_s": REQUEST_GAP_S,
        "interval_min": interval_min,
    }


def accounts(conn: sqlite3.Connection) -> dict[str, dict]:
    """Public account state per person (never the key or the token)."""
    out = {}
    for r in conn.execute(
        """SELECT g.person_id, g.key_hint, g.history_from, g.status, g.last_error, g.last_sync_at,
                  g.backfill_done, g.created_at,
                  (SELECT COUNT(*) FROM garmin_activities a
                    WHERE a.person_id = g.person_id AND a.status = 'downloaded') AS downloaded,
                  (SELECT COUNT(*) FROM garmin_activities a
                    WHERE a.person_id = g.person_id AND a.status = 'error') AS failed
           FROM garmin_accounts g"""
    ):
        out[r["person_id"]] = {**dict(r), "backfill_done": bool(r["backfill_done"])}
    return out
