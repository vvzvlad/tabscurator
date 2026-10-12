# Makefile — single entry point for every repeated action in this project.
# Run `make` (or `make help`) to list the available targets.
#
# All routine commands (environment setup, tests, run, docker build/push) live
# here so they stay documented, consistent and hard to get wrong. Prefer adding
# a target over writing a one-off command in the shell or in CI.

# --- Configuration -----------------------------------------------------------
VENV   ?= .venv
PY     := $(VENV)/bin/python
PIP    := $(VENV)/bin/pip
PYTEST := $(VENV)/bin/pytest

.DEFAULT_GOAL := help

# --- Help --------------------------------------------------------------------
.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

# --- Environment -------------------------------------------------------------
# The project ALWAYS runs inside a local .venv. Every Python target depends on
# the virtualenv, so it is created automatically on first use and reused after —
# the system Python is never used directly.
.PHONY: venv
venv: $(VENV)/bin/python ## Create the local virtualenv (.venv) if missing

$(VENV)/bin/python:
	python3 -m venv $(VENV)

# Sentinel: dependencies are (re)installed only when a requirements file changes,
# not on every `make test` / `make run`.
$(VENV)/.deps-installed: requirements-dev.txt requirements.txt | $(VENV)/bin/python
	$(PIP) install -r requirements-dev.txt
	touch $@

.PHONY: install
install: $(VENV)/.deps-installed ## Create .venv (if missing) and install dev/test deps

.PHONY: env
env: ## Create .env from the template if it does not exist
	@test -f .env || cp .env.example .env

# --- Develop -----------------------------------------------------------------
.PHONY: test
test: install ## Run the test suite (auto-creates .venv if missing)
	$(PYTEST)

.PHONY: run
run: install ## Run the application (auto-creates .venv if missing)
	$(PY) main.py

# --- Prometheus alert rules (§12) --------------------------------------------
# `check rules` validates the schema (Prometheus and vmalert reject the whole file
# on one unknown field), `test rules` runs the fire/stay-quiet cases in
# deploy/alerts_test.yml. A missing promtool skips with exit 0, except under CI=true,
# where it is a hard failure.
.PHONY: alerts
alerts: ## Validate deploy/alerts.yml (promtool check + test rules)
	@command -v promtool >/dev/null 2>&1 || { \
		echo "promtool not found — alert rules NOT validated."; \
		echo "  install: brew install prometheus   (or use the prometheus/promtool release tarball)"; \
		test "$(CI)" != "true" || { echo "CI=true: refusing to skip."; exit 1; }; \
		exit 0; \
	}; \
	promtool check rules deploy/alerts.yml && \
	promtool test rules deploy/alerts_test.yml

# --- Startpage (Vue 3 + Vite, §10) -------------------------------------------
# Independent Node toolchain under startpage/, built INTO extension/startpage. The
# build MUST precede the gates + vitest (the render smoke test loads the built
# bundle). Kept separate from the Python `test` target.
.PHONY: startpage
startpage: ## Build the startpage, run the §10 build gates, then the vitest suite
	cd startpage && (npm ci || npm install)
	cd startpage && npm run build
	cd startpage && npm run gates
	cd startpage && npm test

# --- Instance generator (§13) ------------------------------------------------
# Two steps; neither carries a token or a service address — both are entered per
# profile in the extension's enrollment UI (§7/§13). See tools/README.md.
#
# 1) Build the ONE universal bundle the whole fleet loads. No signing key: the
#    chrome-extension:// id is the load-path hash and nothing reads it.
#      make bundle OUT=~/dist
.PHONY: bundle
bundle: install ## Build the shared universal bundle (vars: OUT)
	$(PY) -m tools.generate_instance bundle --out "$(OUT)"

# 1a) REBUILD the bundle the browser is already loading, in one command:
#     startpage build + §10 gates + vitest, then the bundle copy on top of it.
#       make dev-bundle            # OUT defaults to dist/ — the dir loaded unpacked
#       make dev-bundle OUT=~/dist
#
#     In place, because the chrome-extension:// id is the hash of the loaded dir's
#     absolute path: a new path means a new origin, empty storage and a re-enrollment.
#     The copy is staged and swapped in (tools/instancegen/core.py: replace_bundle).
#
#     Afterwards press "Reload" on the extension's card at brave://extensions; changed
#     permissions also need confirming there. The card shows the version this target
#     prints (`0.1.<commit-count>.<HHMM>`); a different version means no reload.
#     The tracked extension/manifest.json is never rewritten.
dev-bundle: OUT ?= dist
.PHONY: dev-bundle
dev-bundle: startpage install ## Rebuild the bundle the browser loads, in place (vars: OUT, default dist)
	$(PY) -m tools.generate_instance bundle --out "$(OUT)" --force

# 2) Wrap that shared bundle in a per-instance .app + empty profile. NO extension copy
#    and NO instance.json are written — the launcher's --load-extension points at the
#    shared BUNDLE_DIR, so every instance loads the same dir (one id/origin).
#      make instance INSTANCE_ID=main BUNDLE_DIR=~/dist OUT=~/instances [TITLE="Curator Main"]
#
#    By default the launcher also loads the main Brave profile's store-installed
#    extensions unpacked (real ids, re-read at every launch), without their state:
#    they arrive logged-out. `make instance-state` copies that state once.
#      SYNC_EXTENSIONS=<path>  another profile's Extensions dir
#      NO_SYNC_EXTENSIONS=1    curator bundle only
.PHONY: instance
instance: install ## Generate an instance .app (vars: INSTANCE_ID BUNDLE_DIR OUT [TITLE] [SYNC_EXTENSIONS|NO_SYNC_EXTENSIONS])
	$(PY) -m tools.generate_instance generate \
		--instance-id "$(INSTANCE_ID)" --bundle-dir "$(BUNDLE_DIR)" --out "$(OUT)" \
		$(if $(TITLE),--title "$(TITLE)",) \
		$(if $(SYNC_EXTENSIONS),--sync-extensions "$(SYNC_EXTENSIONS)",) \
		$(if $(NO_SYNC_EXTENSIONS),--no-sync-extensions,)

# 3) Copy the store extensions' STATE from the main profile into ONE instance, so they
#    arrive logged-in instead of logged-out. QUIT BRAVE FIRST — the main browser and every
#    instance .app: these are live LevelDB databases and the target refuses to run while
#    any Brave process is alive (there is no --force).
#      make instance-state INSTANCE_DIR=~/Applications/infra DRY_RUN=1   # look first
#      make instance-state INSTANCE_DIR=~/Applications/infra
#      make instance-state INSTANCE_DIR=~/Applications/infra ONLY=<bitwarden id>
#      FROM=<dir>   another profile's `Default` dir (default: the main Brave profile)
#      DRY_RUN=1    list what WOULD move (ids, sizes, exclusions) and write nothing
#
#    A one-time copy, not a sync (a LevelDB has a single writer); re-run to re-align, it
#    overwrites. It copies encrypted vaults (Bitwarden, MetaMask) into one more profile,
#    and the copied Bitwarden `appId` makes both profiles look like one device.
#
#    Only ids the source profile installed (`Extensions/<id>/<version>/manifest.json`)
#    are copied, and the curator extension is excluded by its derived id, so its
#    install_uuid and enrollment secret never travel. No id is hard-coded.
#
#    INSTANCE_DIR is validated here; ONLY is passed whenever it is defined (even empty)
#    so the CLI rejects an empty --only instead of copying everything.
.PHONY: instance-state
instance-state: install ## Copy extension state into an instance, Brave quit (vars: INSTANCE_DIR [FROM] [ONLY] [DRY_RUN])
	@test -n "$(INSTANCE_DIR)" || { \
		echo "INSTANCE_DIR is required: make instance-state INSTANCE_DIR=~/Applications/<instance>"; \
		echo "  (an instance root generated by \`make instance\` — the dir holding profile/)"; \
		exit 1; \
	}
	$(PY) -m tools.generate_instance copy-state \
		--instance-dir "$(INSTANCE_DIR)" \
		$(if $(FROM),--from "$(FROM)",) \
		$(if $(filter-out undefined,$(origin ONLY)),--only "$(ONLY)",) \
		$(if $(DRY_RUN),--dry-run,)

# --- Housekeeping ------------------------------------------------------------
.PHONY: clean
clean: ## Remove the venv and Python caches
	rm -rf $(VENV) .pytest_cache
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
