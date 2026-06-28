# Repository Cleanup Plan

## Purpose

This plan keeps cleanup safe. The repository contains active runtime files, internship-era reference material, and new platform files. Some old folders may still contain useful configuration or report evidence.

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
backend/
dashboard/
clickhouse/
otel/
backup/
docker-compose.yml
.env.example
deploy.sh
deploy-registry.ps1
promote.ps1
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
Chores/
grafana/
prometheus/
alertmanager/
traefik/
k6/
restore_backup.md
recommendation.md
examine.md
docusuarus-base.md
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

### Step 1: Document

Create or update docs before moving anything.

### Step 2: Add Tests

Make sure smoke tests exist for:

- Backend health.
- Service identity.
- Login UI.
- Compose config.

### Step 3: Archive Reference Material

After review, move old material into a clear archive path such as:

```text
archive/internship/
```

Only do this after confirming no compose/config path depends on it.

### Step 4: Migrate Central Stack

Move root compose into `central/` only after:

- `docker compose config` passes.
- paths are updated.
- install docs are updated.
- smoke tests pass.

### Step 5: Remove Dead Files

Delete only when:

- file has no reference in docs/config/scripts,
- backup exists in git history or archive,
- user approves.

## Current Recommendation

For now, keep files in place and use documentation/indexing to make the repository understandable.

The next real code cleanup should focus on splitting large modules, especially:

- `backend/main.py`
- `dashboard/app.js`

Do that through small vertical slices, not one large rewrite.

