"""CORS for ``/api/*`` — ANY origin is allowed, deliberately.

The startpage lives inside each extension and calls ``/api/*`` cross-origin; its
``Authorization: Bearer`` header forces a CORS preflight (§12), so the browser only
issues the real request if this middleware answers that preflight.

``Access-Control-Allow-Origin: *`` is deliberate — do not add an origin allow-list:

* every ``/api/*`` route is already behind ``require_api_caller`` — an ``ADMIN_TOKEN`` or
  an enrolled instance's secret. CORS is not the lock on that door;
* ``allow_credentials=False`` — nothing ambient (cookie, TLS client cert, HTTP auth) is
  ever sent cross-origin, so there is no ambient session for a foreign page to ride and
  no classic CSRF to prevent. That is exactly the condition under which ``*`` is the
  standard, safe answer;
* CORS is enforced by BROWSERS ONLY, so a list would stop only a page without a credential;
* the only unauthenticated readable route is ``/healthz``, and the service is required to
  be unreachable from the public internet (``deploy/DEPLOY.md`` §3).

Invariant: ``allow_credentials=False``. It is what
makes ``*`` safe, and Starlette refuses to combine credentials with a wildcard anyway.
"""

from __future__ import annotations

from starlette.datastructures import Headers
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import Response

from src.api.auth_metrics import auth_rejections

# Headers the browser sends on a cross-origin /api/* call and must be allow-listed
# for the preflight to pass: Authorization (the Bearer token, forces the preflight),
# Content-Type (JSON bodies), Idempotency-Key (the quick-links offline flush, §10).
_ALLOW_HEADERS = ["authorization", "content-type", "idempotency-key"]
# The verbs actually registered under /api/* in src/app.py (GET/POST/PUT/DELETE) plus
# OPTIONS for the preflight itself. Deliberately NOT "*": keep it to the real surface.
_ALLOW_METHODS = ["GET", "POST", "OPTIONS", "PUT", "DELETE"]
# Methods and headers stay EXPLICIT: not a security boundary, but the declared shape of
# /api/*. A mismatch with what the startpage sends is a code bug that fails silently (§12
# «бесшумный отказ»): the socket stays up and only the fetch dies at the preflight, which
# the counter below makes visible.


class CountingCORSMiddleware(CORSMiddleware):
    """``CORSMiddleware`` that also counts REJECTED preflights (§12).

    With ``allow_origins=["*"]``, a rejection means the ``Access-Control-Request-Method``
    is outside ``_ALLOW_METHODS`` or ``Access-Control-Request-Headers`` names something
    outside ``_ALLOW_HEADERS`` — a code bug that otherwise fails silently (websocket up,
    instance green, newtab on stale cache). Only the failure branch is touched; the happy
    path is Starlette's.
    """

    def preflight_response(self, request_headers: Headers) -> Response:
        response = super().preflight_response(request_headers)
        # Starlette returns 400 for a disallowed preflight (bad method / header) and 200
        # when it passes. Count only the rejections.
        if response.status_code != 200:
            auth_rejections.incr("cors_preflight")
        return response


def cors_kwargs() -> dict:
    """Build the ``CORSMiddleware`` kwargs: any origin, credentials off.

    Takes no configuration (see the module docstring). ``allow_origin_regex`` is never set: with ``allow_origins=["*"]`` Starlette sets ``allow_all_origins`` and emits
    a literal ``Access-Control-Allow-Origin: *``, which is well-defined only because
    credentials are off.
    """
    return {
        "allow_origins": ["*"],        # any origin; the lock on /api/* is the token
        "allow_methods": _ALLOW_METHODS,
        "allow_headers": _ALLOW_HEADERS,
        "allow_credentials": False,    # Bearer header, not a cookie — what makes '*' safe
    }
