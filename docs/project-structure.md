# Project Structure

This document explains how the repository is organized during the transition from centralized log dashboard to centralized observability platform.

## Current Rule

Do not move working runtime files until the migration is tested.

The existing stack is stable, so this repository currently keeps the old working layout and adds the new central/edge platform layout beside it.

## Top-Level Folders

| Path | Status | Purpose |
|---|---|---|
| `backend/` | active | FastAPI backend, auth, RBAC, queries, notifications. |
| `dashboard/` | active | Static SPA dashboard served by Nginx. |
| `clickhouse/` | active | ClickHouse schema/config for log storage. |
| `otel/` | active | Central OTel Gateway config. |
| `backup/` | active | ClickHouse backup service. |
| `docker-compose.yml` | active | Current working central stack. |
| `central/` | target | Future home of central stack packaging/docs. |
| `edge/` | new | Edge agent stack for monitored hosts. |
| `tests/` | new | Automated unit/API/UI tests. |
| `docs/` | new | Project architecture, ADRs, deployment, testing, roadmap. |
| `Chores/` | legacy/reference | Internship-era configs and experiments. Keep as reference until migrated. |
| `grafana/`, `prometheus/`, `alertmanager/`, `traefik/`, `k6/` | legacy/reference | Prior monitoring/deployment experiments. Review before reusing. |
| `docs-site/` | optional | Documentation site experiment. Not required for MVP. |

## Active Runtime Files

These files are part of the current working stack:

```text
docker-compose.yml
.env.example
backend/main.py
dashboard/index.html
dashboard/app.js
dashboard/style.css
dashboard/nginx.conf.template
clickhouse/init.sql
otel/gateway-config.yaml
backup/
```

Treat these carefully. Changes here can affect the live/demo stack.

## New Platform Files

These files define the new platform direction:

```text
central/
edge/
docs/project-charter.md
docs/architecture/
docs/adr/
docs/deployment/
docs/diagrams/
docs/roadmap/
docs/testing/
docs/workflows/
tests/
```

These can evolve faster because they do not immediately replace the working stack.

## Local AI Files

AI/session-only files live under:

```text
.codex/project/
```

They are ignored by git and should not be treated as official project documentation.

Official decisions must move into:

```text
docs/adr/
docs/architecture/
docs/workflows/
```

## Migration Direction

The repository should move gradually toward:

```text
central/      # central platform install surface
edge/         # monitored host agent install surface
backend/      # backend source
dashboard/    # frontend source
tests/        # automated tests
docs/         # official project docs
```

Do not move the root compose file until:

1. Edge stack is validated.
2. Central install guide is tested.
3. Compose profiles are defined.
4. Smoke tests pass.
5. README is updated with the new install path.

## Cleanup Candidates

Review later, not now:

- `Chores/`
- `grafana/`
- `prometheus/`
- `alertmanager/`
- `traefik/`
- `k6/`
- `docs-site/`
- old root markdown notes

These may contain useful internship evidence, so do not delete them without review.

