"""POST /api/page_notes and POST /api/transcribe (§16 item 26): only an instance secret
calls them, a note is filed under that instance, a malformed body is 400, and every Groq
failure is a 502. Groq is mocked with respx for the whole file: an unmocked outbound
request raises instead of reaching the network."""

import base64
import sqlite3

import httpx
import pytest
import respx
from conftest import (
    GROQ_API_KEY,
    admin_headers,
    approve_instance,
    instance_headers,
    make_settings,
    secret_for,
)
from starlette.testclient import TestClient

from src.api.page_notes import GROQ_MODEL, GROQ_TRANSCRIBE_URL
from src.app import create_app

HEADERS = instance_headers(secret_for("main"))
NOTE = {"url": "https://app.test/x", "title": "X", "md": "# Notes\n- fix it", "count": 1}
AUDIO = b"\x1aE\xdf\xa3 fake webm"
CLIP = {"audio": base64.b64encode(AUDIO).decode(), "mime": "audio/webm;codecs=opus"}


@pytest.fixture
def groq(monkeypatch):
    # httpx builds its proxy map from the environment, and a developer shell can carry a
    # NO_PROXY that httpx 0.28 fails to parse (IPv6 CIDR entries such as `fd00::/8`), so the client
    # under test is built from an environment without proxy variables.
    for var in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"):
        monkeypatch.delenv(var, raising=False)
        monkeypatch.delenv(var.lower(), raising=False)
    with respx.mock(assert_all_called=False) as router:
        yield router.post(GROQ_TRANSCRIBE_URL)


@pytest.fixture
def client(tmp_path, groq):
    with TestClient(create_app(make_settings(tmp_path))) as c:
        approve_instance(tmp_path / "curator.db", "main")
        yield c


def _rows(tmp_path):
    conn = sqlite3.connect(tmp_path / "curator.db")
    try:
        return conn.execute(
            "SELECT id, instance_id, url, title, md, count, created_at, done_at "
            "FROM page_notes ORDER BY id"
        ).fetchall()
    finally:
        conn.close()


@pytest.mark.parametrize("path,body", [("/api/page_notes", NOTE), ("/api/transcribe", CLIP)])
def test_only_an_instance_secret_opens_them(client, groq, path, body):
    assert client.post(path, json=body).status_code == 401
    # ADMIN_TOKEN authenticates but has no instance to file a note under.
    assert client.post(path, json=body, headers=admin_headers()).status_code == 403
    assert not groq.called


def test_page_note_is_stored_under_the_sending_instance(client, tmp_path):
    first = client.post("/api/page_notes", json=NOTE, headers=HEADERS)
    second = client.post("/api/page_notes", json={**NOTE, "count": 3}, headers=HEADERS)
    assert first.status_code == second.status_code == 201
    assert second.json()["id"] == first.json()["id"] + 1
    (row_id, instance_id, url, title, md, count, created_at, done_at), _ = _rows(tmp_path)
    assert (row_id, instance_id, url, title, md, count, done_at) == (
        first.json()["id"], "main", NOTE["url"], "X", NOTE["md"], 1, None)
    assert created_at > 0


def test_page_note_obeys_the_degraded_and_stop_gates(client, tmp_path):
    assert client.post("/api/pause", headers=admin_headers()).status_code == 200
    r = client.post("/api/page_notes", json=NOTE, headers=HEADERS)
    assert r.status_code == 423 and r.json()["error"] == "stopped"
    client.app.state.degraded = True
    assert client.post("/api/page_notes", json=NOTE, headers=HEADERS).status_code == 503
    assert _rows(tmp_path) == []


@pytest.mark.parametrize("path,body", [
    ("/api/page_notes", "not json"),
    ("/api/page_notes", []),
    ("/api/page_notes", {}),
    ("/api/page_notes", {**NOTE, "url": ""}),
    ("/api/page_notes", {**NOTE, "title": 5}),
    ("/api/page_notes", {**NOTE, "md": None}),
    ("/api/page_notes", {**NOTE, "count": True}),
    ("/api/page_notes", {**NOTE, "count": -1}),
    ("/api/transcribe", {"audio": CLIP["audio"]}),
    ("/api/transcribe", {**CLIP, "mime": "webm"}),
    ("/api/transcribe", {**CLIP, "audio": ""}),
    ("/api/transcribe", {**CLIP, "audio": "not base64!"}),
    ("/api/transcribe", {**CLIP, "audio": "data:audio/webm;base64," + CLIP["audio"]}),
])
def test_malformed_body_is_400(client, groq, tmp_path, path, body):
    if isinstance(body, str):
        r = client.post(path, content=body, headers=HEADERS)
    else:
        r = client.post(path, json=body, headers=HEADERS)
    assert r.status_code == 400, r.text
    assert _rows(tmp_path) == [] and not groq.called


def test_transcribe_posts_the_recording_to_groq_and_returns_its_text(client, groq):
    groq.mock(return_value=httpx.Response(200, json={"text": "поправь кнопку"}))
    r = client.post("/api/transcribe", json=CLIP, headers=HEADERS)
    assert r.status_code == 200 and r.json() == {"text": "поправь кнопку"}

    sent = groq.calls.last.request
    assert sent.headers["authorization"] == f"Bearer {GROQ_API_KEY}"
    body = sent.content
    assert f'name="model"\r\n\r\n{GROQ_MODEL}\r\n'.encode() in body
    assert b'name="response_format"\r\n\r\njson\r\n' in body
    assert b'name="file"; filename="note.webm"\r\nContent-Type: audio/webm\r\n' in body
    assert AUDIO in body
    assert b'name="language"' not in body  # Whisper detects the language


@pytest.mark.parametrize("answer,message", [
    (httpx.Response(401, json={"error": {"message": "Invalid API Key",
                                         "type": "invalid_request_error"}}),
     "Groq 401: Invalid API Key"),
    (httpx.Response(503, text="upstream down"), "Groq 503: upstream down"),
    (httpx.Response(200, json={}), "Groq answered without a transcription text"),
    (httpx.ConnectTimeout("slow"), "Groq did not answer within 60 s"),
    (httpx.ConnectError("refused"), "Groq request failed: refused"),
])
def test_groq_failure_is_a_502_with_its_message(client, groq, answer, message):
    if isinstance(answer, Exception):
        groq.mock(side_effect=answer)
    else:
        groq.mock(return_value=answer)
    r = client.post("/api/transcribe", json=CLIP, headers=HEADERS)
    assert r.status_code == 502
    assert r.json() == {"ok": False, "error": "transcribe_failed", "message": message}


def test_unparsable_proxy_environment_is_a_502_not_a_500(client, groq, monkeypatch):
    # httpx raises InvalidURL (not an HTTPError) while building the client from this
    # NO_PROXY, before any request leaves.
    monkeypatch.setenv("NO_PROXY", "localhost,fd00::/8")
    r = client.post("/api/transcribe", json=CLIP, headers=HEADERS)
    assert r.status_code == 502
    assert r.json()["message"].startswith("Groq request failed:")
    assert not groq.called
