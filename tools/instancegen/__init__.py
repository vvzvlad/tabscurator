"""Per-instance browser generator (docs/architecture.md §13).

The fleet loads ONE universal extension bundle and an instance is a thin wrapper
around it. Two commands, in order:

``bundle`` builds that single fleet-wide bundle once:

* a copy of the repo's ``extension/`` (dev cruft skipped). The manifest has no
  ``key`` and only ``<all_urls>`` host permissions, so the extension id is Chromium's
  hash of the load path, which nothing consumes (no origin is checked on ``/ext`` and
  ``/api/*`` CORS accepts any origin);
* no ``instance.json``, token, service URL or ``instanceId``: the bundle carries no
  credential and no address.

``generate`` then wraps that SHARED bundle per instance:

* an empty per-instance profile dir (the ``--user-data-dir``) — deliberately
  empty so the extension mints its own ``install_uuid`` there on first run (§6),
  which is what makes a cloned ``.app`` an un-enrolled install rather than a
  takeover of the original;
* a ``.app`` wrapper (Info.plist + launcher script + icon) whose launcher execs
  the system Brave with ``--user-data-dir`` (the profile above) and
  ``--load-extension`` pointing at the SHARED bundle.

The service address and the per-install secret are not in the build: each profile
receives them through the extension's enrollment settings UI and enrols itself
with the window code the operator opens on ``/admin`` (§6/§13). A code update is a
rebuild of the one shared bundle.

The module is split into a PURE core (`core`, all filesystem/text logic, runs on
Linux/CI) and a thin macOS platform layer (`macos`, the real ``.icns``/``.app``
build that cannot run in CI).
"""
