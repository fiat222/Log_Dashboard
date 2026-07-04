# Repository Cleanup Plan

## Purpose

This plan keeps cleanup safe. The repository contains active runtime files, internship-era reference material, and new platform files. Some old folders may still contain useful configuration or report evidence.

The goal is no longer just "document the messy root." The goal is a production-style repository layout with clear ownership:

- application code under `apps/`,
- runtime infrastructure under `infra/`,
- release automation under `deploy/`,
- development and CI helpers under `tools/`,
- reviewed legacy/reference material under `archive/`.

## Cleanup Policy

Do not delete first.

Classify files before moving or removing them:

```text
active      = used by current stack
new         = part of platform direction
reference   = useful old/internship material
local-only  = personal/AI/session files
candidate   = review before archive/delete
```

## Current Classification

### Active

```text
apps/api/
apps/web/
infra/clickhouse/
infra/otel/
infra/vector/
apps/backup/
docker-compose.yml
.env.example
deploy/deploy.sh
deploy/deploy-registry.ps1
deploy/promote.ps1
```

### New Platform Direction

```text
central/
edge/
docs/
tests/
package.json
playwright.config.js
pytest.ini
```

### Reference / Internship Material

```text
archive/internship/Chores/
archive/legacy/grafana/
archive/legacy/prometheus/
archive/legacy/alertmanager/
archive/legacy/traefik/
archive/legacy/k6/
docs/deployment/restore-backup.md
docs/notes/recommendation.md
docs/notes/examine.md
docs/notes/docusuarus-base.md
archive/legacy/grafana/grafana-link-dashboard.json
archive/reference/FileBeat.zip
```

### Local-Only / Ignored

```text
.codex/
.agents/
.claude/
.superpowers/
.env
```

## Safe Cleanup Steps

### R0: Document Target Layout

Create or update docs before moving anything. This prevents blind path churn.

Status: started. The initial scaffold now exists at `apps/`, `infra/`, `deploy/`, `tools/`, and `archive/`.

### R1: Move Low-Risk Non-Runtime Material

Move only files that do not affect the running stack:

```text
root markdown notes -> docs/notes/ or archive/
CI helper scripts  -> tools/ci/ or docs/ci/
load-test helpers   -> tools/load/ or tests/load/
generated reports   -> archive/generated/reports/
```

Do not move `apps/api/`, `apps/web/`, or root `docker-compose.yml` in this step. `clickhouse/`, `otel/`, and `vector/` have moved to `infra/`.

Completed R1 moves so far:

- `docusuarus-base.md` -> `docs/notes/docusuarus-base.md`
- `grafana-link-dashboard.json` -> `archive/legacy/grafana/grafana-link-dashboard.json`
- `FileBeat.zip` -> `archive/reference/FileBeat.zip`
- `recommendation.md` -> `docs/notes/recommendation.md`
- `examine.md` -> `docs/notes/examine.md`
- `restore_backup.md` -> `docs/deployment/restore-backup.md`
- local machine artifacts -> `archive/local/`

### R2: Add Tests

Make sure smoke tests exist for:

- Backend health.
- Service identity.
- Login UI.
- Compose config.

### R3: Archive Reference Material

After review, move old material into a clear archive path such as:

```text
archive/internship/
```

Only do this after confirming no compose/config path depends on it.

### R4: Migrate App Source

Move app source only with matching path updates:

```text
apps/api/   -> apps/api/
apps/web/ -> apps/web/
```

Required checks:

- backend unit/API tests pass,
- frontend asset tests pass,
- Dockerfiles and compose build contexts are updated,
- docs and README path references are updated.

### R5: Migrate Infra

Move runtime infrastructure only after app source migration is stable:

```text
infra/clickhouse/ <- moved from clickhouse/
infra/otel/       <- moved from otel/
infra/vector/     <- moved from vector/
```

Move root compose into `infra/compose/` or `central/` only after:

- `docker compose config` passes,
- paths are updated,
- install docs are updated,
- smoke tests pass,
- root compatibility command remains documented.

### R6: Remove Dead Files

Delete only when:

- file has no reference in docs/config/scripts,
- backup exists in git history or archive,
- user approves.

## Current Recommendation

Start with R0 and R1 before Phase 6.1 implementation.

The next real code cleanup should then focus on splitting large modules, especially:

- `apps/api/main.py`
- `apps/web/app.js`

Do that through small vertical slices, not one large rewrite.

