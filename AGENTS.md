# Agent Instructions — tabscurator

Tab curator over several isolated Brave instances (Arc-style Spaces / auto-archive):
a Python service mirrors every instance's tabs over a WSS channel and relocates idle
tabs to their "home" instance by `pattern → instance` rules. The design spec is
`docs/architecture.md`; code comments cite its sections as `§N`.

## Layout
- `src/` — curator-service (Starlette): `ext/` the `/ext` WSS channel, `api/` HTTP API +
  `/admin` console, `curator/` the pass, `rules/` matcher/preview, `db/` SQLite,
  `mcpiface/` MCP over streamable HTTP; `settings.py` is the single config entry point.
- `extension/` — MV3 extension (vitest tests in `extension/test/`).
- `startpage/` — Vue 3 + Vite newtab; builds INTO the tracked `extension/startpage/`.
- `tools/` — instance generator (`tools/README.md`).
- `templates/` — `/admin` console assets shipped in the image.
- `deploy/` — runbook `deploy/DEPLOY.md`, Prometheus rules `alerts.yml` + `alerts_test.yml`,
  `scrape.yml`.
- `tests/` — pytest; `data/` — runtime state (gitignored, a docker volume); `main.py` — entry point.

## Run and test
All routine actions go through the `Makefile` (`make help`). Python always runs in the
local `.venv` that `make` creates.
```bash
make env               # .env from .env.example (METRICS_TOKEN, ADMIN_TOKEN)
make test              # pytest
make run               # python main.py
make alerts            # promtool check + test rules (skips if promtool is missing, fails under CI=true)
make startpage         # build + gates + vitest; commit the rebuilt extension/startpage
make dev-bundle        # rebuild the bundle the browser loads, in place
```
Extension tests: `npm test` in `extension/`.

## CI and deploy
- `.gitea/workflows/tests.yml` — on PRs to `develop`: pytest, alert rules, extension and
  startpage suites, and a check that the committed `extension/startpage` matches a fresh build.
- `.gitea/workflows/image-check-publish.yml` — on push to `develop`/`main`: the same
  suites, then the image build gated on the Python `test` job.
- `develop` is the default branch and publishes
  `gitea.vvzvlad.xyz/projects/tabscurator:develop`, which production auto-updates from.
  `main` (`:latest` + `:<sha>`) is reserved for releases. Keep the shared jobs of the two
  workflows identical.
- `docker-compose.yml` is a reference; the live stack is configured in Portainer.

## Conventions and invariants
- Config comes only from ENV / `.env` via `Settings`; no default credentials, no default
  address for self-hosted services; a missing required var fails startup.
- `METRICS_TOKEN` opens only `/metrics`; `ADMIN_TOKEN` opens `/admin`, `/api/*` and `/mcp`
  and must differ from `METRICS_TOKEN`. Instances authenticate with a per-install secret
  obtained through the enrollment window.
- Wire constants (`CMD_*`, `ERR_*`, timeouts) are duplicated in `extension/src/constants.js`
  and the Python side; tests parse the JS to keep them in sync. The theme tokens are
  copied in `extension/pages/ui.css`, `startpage/index.html` and `templates/app.css`.
- Functions injected via `chrome.scripting` must be top-level and closure-free.
- Tests are required for new code.
- No `EXPOSE` in the Dockerfile (Traefik publishes the service). The container runs as
  `app` (uid 1000): the entrypoint starts as root, fixes `/app/data` ownership and drops
  privileges via gosu — do not add `USER` and do not remove the entrypoint.
- Code comments are in English.

## Limits for agents
- Tests: at most three times the code (`wc -l` of `tests/` against the code). Over the limit,
  still write the test you need, and in the same change go through the old tests: drop or merge
  duplicates and tests of implementation rather than behaviour.
- Comments explain the code as it is and why it is built this way. History ("used to", "after
  the review", "since the incident") goes into the commit message.
- This file stays under ~150 lines: only what an agent would get wrong without it. No decision
  history, incident logs or retelling of the code.
