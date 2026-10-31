"""``POST /api/page_notes`` and ``POST /api/transcribe`` — the service half of the page
notes left with Tack (§16 item 26).

The extension injects the Tack toolbar into a page. Its "Send to agent" posts Tack's
Markdown export to ``/api/page_notes``, and Claude reads the stored rows through the MCP
``list_page_notes``. A voice note is recorded by the extension's offscreen document and
posted to ``/api/transcribe``, which hands it to Groq Whisper and returns the text for
Tack to put into the note.

Both callers are the extension's service worker with its instance secret, so an
ADMIN_TOKEN caller gets 403: a note is filed under the instance that sent it
(``page_notes.instance_id`` is NOT NULL), and an admin caller has no instance.
``/api/page_notes`` also carries the ``/api/*`` write guards (degraded schema, stop gate),
the same set as ``/api/quick_links/ops``. ``/api/transcribe`` writes nothing and touches
no browser, so the instance auth is its only guard.
"""

from __future__ import annotations

import base64
import re
import time

import httpx
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse

from src.api.guards import (
    Caller,
    read_force_body,
    require_api_caller,
    require_not_paused,
    require_operational,
)
from src.db import page_notes as notes_db

GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
GROQ_MODEL = "whisper-large-v3-turbo"
# One Groq round trip: the upload of a few-MB recording plus the transcription itself
# (Groq quotes ~200x real time for this model). Past it the extension gets a 502 instead
# of a request that hangs as long as the socket does.
GROQ_TIMEOUT_S = 60.0

# ``audio/webm;codecs=opus`` -> base type ``audio/webm``, subtype ``webm``. Groq lists the
# formats it accepts by file extension (flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm),
# and the subtypes MediaRecorder produces (webm, ogg, mp4) are among them, so the upload
# is named ``note.<subtype>``.
_MEDIA_TYPE = re.compile(r"^[a-z]+/([a-z0-9.+-]+)$")


def _now_ms() -> int:
    return int(time.time() * 1000)


async def _instance_caller(request: Request) -> Caller:
    caller = await require_api_caller(request)
    if caller.kind != "instance":
        raise HTTPException(status_code=403, detail="instance secret required")
    return caller


def _bad(detail: str) -> HTTPException:
    return HTTPException(status_code=400, detail=detail)


# --- POST /api/page_notes ----------------------------------------------------
async def create_page_note(request: Request) -> JSONResponse:
    """Store one Tack export ``{url, title, md, count}`` -> ``201 {id}``."""
    caller = await _instance_caller(request)
    require_operational(request)
    await require_not_paused(request)

    # read_force_body: malformed JSON or a non-object is 400, an absent body is {} and
    # fails the field checks below with the same status.
    body = await read_force_body(request)
    url, title, md, count = (body.get(k) for k in ("url", "title", "md", "count"))
    if not isinstance(url, str) or not url:
        raise _bad("url must be a non-empty string")
    if not isinstance(title, str):
        raise _bad("title must be a string")
    if not isinstance(md, str):
        raise _bad("md must be a string")
    # bool is an int subclass in Python; `true` is not a note count.
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        raise _bad("count must be a non-negative integer")

    now = _now_ms()
    note_id = await request.app.state.db.write(
        lambda c: notes_db.insert_page_note(
            c, caller.instance_id, url, title, md, count, now
        )
    )
    return JSONResponse({"id": note_id}, status_code=201)


# --- POST /api/transcribe ----------------------------------------------------
def _upstream_error(message: str) -> HTTPException:
    # A dict detail renders as a JSON body (src.app._http_exception): the same
    # {ok, error, message} 502 that /api/focus answers when the browser fails.
    return HTTPException(
        status_code=502,
        detail={"ok": False, "error": "transcribe_failed", "message": message},
    )


async def _groq_transcribe(api_key: str, audio: bytes, media_type: str, ext: str) -> str:
    """Send the recording to Groq Whisper and return the text. Any failure is a 502
    carrying Groq's own ``error.message`` when it answered, else what broke on the way.
    No ``language`` field: Whisper detects the language of the recording itself."""
    try:
        async with httpx.AsyncClient(timeout=GROQ_TIMEOUT_S) as client:
            resp = await client.post(
                GROQ_TRANSCRIBE_URL,
                headers={"Authorization": f"Bearer {api_key}"},
                data={"model": GROQ_MODEL, "response_format": "json"},
                files={"file": (f"note.{ext}", audio, media_type)},
            )
    except httpx.TimeoutException:
        raise _upstream_error(f"Groq did not answer within {GROQ_TIMEOUT_S:g} s")
    except (httpx.HTTPError, httpx.InvalidURL) as exc:
        # InvalidURL is not an HTTPError: httpx raises it while building the client
        # from an unparsable proxy environment, before any request leaves.
        raise _upstream_error(f"Groq request failed: {exc}")

    try:
        payload = resp.json()
    except ValueError:
        payload = None
    if resp.is_success:
        text = payload.get("text") if isinstance(payload, dict) else None
        if isinstance(text, str):
            return text
        raise _upstream_error("Groq answered without a transcription text")
    # Groq's error body: {"error": {"message": "...", "type": "..."}}.
    error = payload.get("error") if isinstance(payload, dict) else None
    message = error.get("message") if isinstance(error, dict) else None
    raise _upstream_error(f"Groq {resp.status_code}: {message or resp.text}")


async def transcribe(request: Request) -> JSONResponse:
    """Transcribe ``{audio: <base64>, mime}`` -> ``200 {text}``."""
    await _instance_caller(request)

    body = await read_force_body(request)
    audio, mime = body.get("audio"), body.get("mime")
    media_type = mime.split(";", 1)[0].strip().lower() if isinstance(mime, str) else ""
    match = _MEDIA_TYPE.match(media_type)
    if match is None:
        raise _bad("mime must be a media type such as audio/webm")
    if not isinstance(audio, str) or not audio:
        raise _bad("audio must be a non-empty base64 string")
    try:
        data = base64.b64decode(audio, validate=True)
    except ValueError:  # binascii.Error, or a non-ASCII str
        raise _bad("audio must be base64")

    text = await _groq_transcribe(
        request.app.state.settings.groq_api_key, data, media_type, match.group(1)
    )
    return JSONResponse({"text": text})
