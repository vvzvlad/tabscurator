"""``/admin`` HTML console.

This is the presentation layer over the ``/admin/*`` JSON API. It serves, via EXPLICIT
handlers (never ``StaticFiles`` — that would not let us set the CSP header), the console
page, the login form, and their ``.js`` / ``.css`` assets, plus the cookie-session
login/logout endpoints. The page renders instances and the enrollment window entirely
through SAME-ORIGIN ``fetch`` calls against the JSON API, so no
data is templated into the HTML — the assets are static and contain NO secrets, hence they
are served WITHOUT the auth guard.

The single exception is the build revision (:func:`_console_html`): one process-constant,
already public on ``/healthz``, substituted into ``admin.html`` at serve time so the
console can state which code it is running without a request that could itself fail.

Security posture:

* **CSP by explicit header** (:data:`_CSP`) on every HTML/asset response: ``default-src
  'none'`` with ``script-src 'self'`` — so there is NO inline ``<script>``; the page logic
  lives in the separately-served ``/admin/app.js``. This is why ``StaticFiles`` is unusable
  here: it cannot attach the policy.
* **Session cookie = a signed expiry, never the ADMIN_TOKEN** (see :mod:`src.api.admin_session`).
  ``HttpOnly`` + ``Secure`` (UNCONDITIONAL — TLS terminates at Traefik, so the app sees
  ``http`` and deriving ``Secure`` from the request scheme would silently drop it in prod) +
  ``SameSite=Strict`` + ``Path=/admin``.
* **``GET /admin`` is behind the auth guard** (:func:`src.api.admin.require_admin`) — an
  unauthenticated hit never receives the console, only a 303 to the public login form
  (acc 1); the JSON API keeps answering a flat 401. The login/asset routes are public.
"""

from __future__ import annotations

import html
import secrets
from functools import lru_cache
from pathlib import Path

from starlette.datastructures import MutableHeaders
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse, Response

from src.api import admin_session
from src.api.admin import require_admin
from src.api.auth_metrics import auth_rejections
from src.api.guards import (
    MAX_UNAUTHENTICATED_BODY_BYTES,
    _bearer_token,
    read_bounded_body,
    require_same_origin,
)

# Explicit Content-Security-Policy for every /admin HTML/asset response. `default-src
# 'none'` denies everything by default; `script-src 'self'` / `style-src 'self'` permit only
# same-origin assets (so NO inline <script>/<style>); `connect-src 'self'` scopes the page's
# fetch() to this origin; `base-uri 'none'` / `form-action 'self'` blunt base-tag and form
# hijacks; `img-src 'self'` bars remote pixels. `frame-ancestors 'none'` forbids ANY site
# from framing the console — it does NOT inherit from default-src, so it must be stated
# explicitly; without it a same-site Traefik neighbor could iframe the authenticated console
# and clickjack the operator into same-origin (thus CSRF-passing) revoke fetches.
# One string, applied identically everywhere.
_CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self'; "
    "connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; "
    "frame-ancestors 'none'"
)

# templates/ ships inside the image (Dockerfile copies it). This module is src/api/…, so the
# repo root — and templates/ under it — is two parents up. Resolved once.
_TEMPLATES_DIR = Path(__file__).resolve().parents[2] / "templates"

# The ``curator_auth_rejections_total{reason}`` label for a FAILED ADMIN_TOKEN login — the
# brute-force signal, kept apart from the ambient ``admin_session`` (see login_submit).
# deploy/alerts.yml keys ``curator-admin-token-bruteforce`` on this exact string.
ADMIN_BAD_TOKEN_REASON = "admin_bad_token"


class AdminSecurityHeadersMiddleware:
    """Stamp ``X-Content-Type-Options: nosniff`` and ``Cache-Control: no-store`` on EVERY
    ``/admin`` response.

    Two cross-cutting headers covering both the HTML/asset responses and the JSON API
    responses. Implemented as a pure-ASGI middleware so it adds ONLY headers and never
    touches the JSON bodies or status codes. Frame defenses (CSP ``frame-ancestors`` +
    ``X-Frame-Options``) stay on the HTML/asset responses themselves, where framing is the
    threat.

    * ``nosniff`` — a browser MIME-sniffing a JSON body into active HTML must not be
      possible, whatever field a body carries.
    * ``no-store`` — ``GET /admin/enroll/window`` returns the LIVE window code, the whole
      permission to enrol; without a directive a browser or intermediary may write it to
      disk cache. ``no-cache`` would still permit a stored copy.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        if scope["type"] != "http" or not (path == "/admin" or path.startswith("/admin/")):
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                # setdefault: never duplicate a header an inner response already set.
                headers = MutableHeaders(scope=message)
                headers.setdefault("x-content-type-options", "nosniff")
                headers.setdefault("cache-control", "no-store")
            await send(message)

        await self.app(scope, receive, send_wrapper)


@lru_cache(maxsize=None)
def _asset_bytes(name: str) -> bytes:
    """Read a template asset once and cache it (the files are immutable at runtime)."""
    return (_TEMPLATES_DIR / name).read_bytes()


def _asset_response(name: str, media_type: str, content: bytes | None = None) -> Response:
    """A static asset/HTML response carrying the framing-defense headers. NOT auth-gated
    (no secrets). ``X-Frame-Options: DENY`` backs up ``frame-ancestors 'none'`` for any
    client that predates CSP framing directives — belt-and-suspenders against clickjacking.
    ``X-Content-Type-Options: nosniff`` is added for every /admin response (JSON included) by
    :class:`AdminSecurityHeadersMiddleware`, so it is not repeated here.

    ``content`` overrides the file bytes for the one template that is not served verbatim
    (:func:`_console_html`); ``name`` still names the source file so the two stay tied.
    """
    return Response(
        content=_asset_bytes(name) if content is None else content,
        media_type=media_type,
        headers={
            "Content-Security-Policy": _CSP,
            "X-Frame-Options": "DENY",
        },
    )


# The single placeholder in templates/admin.html, replaced at serve time by the running
# build revision. Deliberately NOT a templating engine and NOT data-from-the-DB: the
# console keeps its "the HTML holds no data, it fetches everything" property (see the
# module docstring), and this one substitution is a process-CONSTANT that is already public
# on /healthz.
_REVISION_PLACEHOLDER = b"__BUILD_REVISION__"


@lru_cache(maxsize=1)
def _console_html(revision: str) -> bytes:
    """``templates/admin.html`` with the build revision substituted in.

    Server-side substitution rather than a ``fetch`` from ``app.js``, so the revision is on
    screen even when the JSON API behind this console is refusing every call.

    ``html.escape`` because the value comes from an environment variable and lands inside
    an element. Cached (``maxsize=1``): the revision never changes within a process.
    """
    escaped = html.escape(revision, quote=False).encode("utf-8")
    return _asset_bytes("admin.html").replace(_REVISION_PLACEHOLDER, escaped)


def _cookie_ttl_seconds(request: Request) -> int:
    return request.app.state.settings.admin_session_ttl_min * 60


def _set_session_cookie(response: Response, session_id: str, max_age: int) -> None:
    """Set the session cookie with the fixed hardening flags (see module docstring).

    ``Secure`` is UNCONDITIONAL on purpose: the app sees ``http`` behind Traefik, so
    deriving it from the request scheme would silently drop it in production.
    """
    response.set_cookie(
        key=admin_session.COOKIE_NAME,
        value=session_id,
        max_age=max_age,
        path="/admin",
        httponly=True,
        secure=True,
        samesite="strict",
    )


# Where a browser that failed the guard on GET /admin is sent. It is the PUBLIC route
# (`login_page` below, no `require_admin`), which is what makes the redirect terminal: the
# target cannot refuse and bounce back here, so no loop is constructible.
_LOGIN_PATH = "/admin/login"


# --- HTML pages --------------------------------------------------------------
async def admin_page(request: Request) -> Response:
    """``GET /admin`` — the console page (auth-gated read; degraded-OK).

    Requires a valid cookie OR Bearer ADMIN_TOKEN via :func:`require_admin`. No
    ``require_operational`` — the console must render (reads) even in degraded mode (acc 8).
    The HTML itself holds no data: it fetches the JSON API on load.

    **An unauthenticated hit is redirected to the login form, not answered 401** (acc 1).
    The console body is still served ONLY to an authenticated caller; only the refusal
    differs, because this is the only ``/admin`` surface a human reaches by typing an
    address. The redirect is deliberately narrow:

    * **HTML route only.** Every ``/admin/*`` JSON route keeps its flat 401 (:func:`
      require_admin` is unchanged). Redirecting an API call would swap a machine-readable
      refusal for an HTML page — a client that follows redirects by default (``fetch``
      does) would parse the login form as its payload.
    * **No-credential branch only.** A request that DID present ``Authorization: Bearer``
      and was rejected keeps the 401: that caller is curl/MCP/the agent, not a browser, and
      an instance secret probing ``/admin`` gets the same 401 as an unknown token (acc 6).
    * **401 only.** A 503 (degraded resolve) or 403 (CSRF) propagates untouched; sending a
      DB outage to a login form would hide it.

    ``303 See Other``: a temporary, GET-only substitution that a client must not remember
    (unlike 301/308). ``Cache-Control: no-store`` covers the redirect too.

    The rejection is still counted by ``require_admin`` under ``admin_session``, the
    ambient label with no alert rule (tests/test_deploy_alerts.py); only a wrong token
    POSTed to ``login_submit`` counts as ``admin_bad_token``.
    """
    try:
        await require_admin(request)
    except HTTPException as exc:
        if exc.status_code != 401 or _bearer_token(request) is not None:
            raise
        return RedirectResponse(_LOGIN_PATH, status_code=303)
    revision = request.app.state.settings.build_revision
    return _asset_response(
        "admin.html", "text/html; charset=utf-8", _console_html(revision)
    )


async def login_page(request: Request) -> Response:
    """``GET /admin/login`` — the login form. PUBLIC (holds no secret) + CSP."""
    return _asset_response("login.html", "text/html; charset=utf-8")


# --- static assets (public, CSP) ---------------------------------------------
async def app_js(request: Request) -> Response:
    return _asset_response("app.js", "text/javascript; charset=utf-8")


async def app_css(request: Request) -> Response:
    return _asset_response("app.css", "text/css; charset=utf-8")


async def login_js(request: Request) -> Response:
    return _asset_response("login.js", "text/javascript; charset=utf-8")


# --- login / logout ----------------------------------------------------------
async def _submitted_token(request: Request) -> str:
    """Read the token from a form POST (the login form) or a JSON body (curl/tests).

    The body is read through :func:`read_bounded_body` FIRST (413 past
    :data:`MAX_UNAUTHENTICATED_BODY_BYTES`). This is the service's only pre-auth body:
    ``login_submit`` is deliberately not behind ``require_admin`` — it is how one
    authenticates — so an anonymous peer decides how much this endpoint buffers. The cap
    runs before the JSON/form parser, which is what makes it a cap and not a post-mortem.
    """
    await read_bounded_body(request, MAX_UNAUTHENTICATED_BODY_BYTES)
    ctype = request.headers.get("content-type", "")
    if "application/json" in ctype:
        try:
            data = await request.json()
        except Exception:
            return ""
        token = data.get("token") if isinstance(data, dict) else None
        return token if isinstance(token, str) else ""
    try:
        form = await request.form()
    except Exception:
        # A malformed/undecodable form body is simply "no token" — never a 500 on a
        # surface anybody may POST to.
        return ""
    token = form.get("token")
    return token if isinstance(token, str) else ""


async def login_submit(request: Request) -> Response:
    """``POST /admin/login`` — verify ADMIN_TOKEN → mint a cookie session (acc 2).

    The submitted token is compared CONSTANT-TIME against ``settings.admin_token``; on a
    match a signed session cookie is minted (NEVER the token) and set as the hardened
    cookie, and the endpoint answers 200. A wrong/empty token is a flat 401. Not behind
    ``require_admin`` (this is how you AUTHENTICATE) and not behind ``require_operational``
    (you may log in to read while degraded); it touches no DB.

    A failure is counted under its OWN reason, :data:`ADMIN_BAD_TOKEN_REASON`, not the
    ambient ``admin_session`` that ticks on every console open before login, so
    ``curator-admin-token-bruteforce`` (deploy/alerts.yml) can key on real guesses.
    """
    submitted = await _submitted_token(request)
    expected = request.app.state.settings.admin_token
    if not secrets.compare_digest(
        submitted.encode("utf-8", "ignore"), expected.encode("utf-8")
    ):
        auth_rejections.incr(ADMIN_BAD_TOKEN_REASON)
        raise HTTPException(status_code=401, detail="invalid admin token")

    session_id = admin_session.create(request.app)
    response = JSONResponse({"ok": True})
    _set_session_cookie(response, session_id, _cookie_ttl_seconds(request))
    return response


async def logout_submit(request: Request) -> Response:
    """``POST /admin/logout`` — end the presented session + clear the cookie (acc 5).

    Clears the browser's cookie (a client-side logout, see :mod:`src.api.admin_session`).
    It is not behind ``require_admin`` (harmless), but it IS a cookie-path MUTATING verb, so it takes the SAME same-origin
    CSRF gate: a same-site neighbor must not be able to force a logout (forced-logout DoS)
    with the ambient cookie.
    """
    require_same_origin(request)
    session_id = request.cookies.get(admin_session.COOKIE_NAME)
    admin_session.delete(request.app, session_id)
    response = JSONResponse({"ok": True})
    response.delete_cookie(key=admin_session.COOKIE_NAME, path="/admin")
    return response
