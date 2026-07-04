# Project Structure

This document explains how the repository is organized during the transition from centralized log dashboard to centralized observability platform.

## Current Rule

The current root layout is not the desired production layout.

However, runtime paths are referenced by compose, Dockerfiles, tests, docs, and shell scripts. Move them in staged batches, not as one broad rename.

Root `docker-compose.yml` remains the compatibility entrypoint until every migrated path passes compose validation and smoke tests.

## Target Production Layout

```text
apps/
  api/                 # FastAPI backend package
  web/                 # Dashboard frontend app
infra/
  compose/             # central compose files and overrides
  clickhouse/          # ClickHouse schema/config
  otel/                # OTel collector configs
  vector/              # Vector configs
  nginx/               # proxy templates
deploy/                # release, promotion, backup automation
tools/                 # CI/dev/load-test helpers
archive/               # reviewed legacy/reference material
docs/                  # official project documentation
tests/                 # automated test suites
edge/                  # monitored-host install surface
central/               # central install documentation while root compose remains active
```

## Migration Order

1. Add target directories and document the layout.
2. Move documentation-only and tooling-only material first.
3. Move `apps/web/` to `apps/web/` when frontend migration starts.
4. Move `apps/api/` to `apps/api/` when backend modularization starts.
5. Move telemetry config into `infra/` after compose config and smoke tests are green.
6. Keep root compatibility wrappers until final install docs and CI use the new paths.

## Top-Level Folders

| Path | Status | Purpose |
|---|---|---|
| `apps/api/` | active | FastAPI backend, auth, RBAC, queries, notifications. |
| `apps/web/` | active | Static SPA dashboard served by Nginx. |
| `infra/clickhouse/` | active | ClickHouse schema/config for log storage. |
| `infra/otel/` | active | Central OTel Gateway config. |
| `apps/backup/` | active | ClickHouse backup service. |
| `infra/vector/` | active | Central Vector collector config. |
| `docker-compose.yml` | active | Current working central stack. |
| `apps/` | target | Future home for first-party app source. |
| `infra/` | target | Future home for compose and observability runtime config. |
| `deploy/` | target | Future home for release/promotion/backup automation. |
| `tools/` | target | Future home for CI, dev, load-test, and reporting helpers. |
| `archive/` | target | Future home for reviewed legacy/reference material. |
| `central/` | target | Future home of central stack packaging/docs. |
| `edge/` | new | Edge agent stack for monitored hosts. |
| `tests/` | new | Automated unit/API/UI tests. |
| `docs/` | new | Project architecture, ADRs, deployment, testing, roadmap. |
| `archive/internship/Chores/` | legacy/reference | Internship-era configs and experiments. Keep as reference until migrated. |
| `archive/legacy/grafana/`, `archive/legacy/prometheus/`, `archive/legacy/alertmanager/`, `archive/legacy/traefik/`, `archive/legacy/k6/` | legacy/reference | Prior monitoring/deployment experiments. Review before reusing. |
| `archive/legacy/docs-site/` | optional | Documentation site experiment. Not required for MVP. |

## Active Runtime Files

These files are part of the current working stack:

```text
docker-compose.yml
.env.example
apps/api/main.py
apps/web/index.html
apps/web/app.js
apps/web/style.css
apps/web/nginx.conf.template
infra/clickhouse/init.sql
infra/otel/gateway-config.yaml
apps/backup/
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

## Legacy Migration Direction

The old direction was:

```text
central/      # central platform install surface
edge/         # monitored host agent install surface
apps/api/      # backend source
apps/web/    # frontend source
tests/        # automated tests
docs/         # official project docs
```

The updated production direction is:

```text
apps/api/          # backend source
apps/web/          # frontend source
infra/             # compose and telemetry config
deploy/            # release automation
tools/             # dev and CI tooling
archive/           # reviewed reference material
```

Do not move the root compose file until:

1. Edge stack is validated.
2. Central install guide is tested.
3. Compose profiles are defined.
4. Smoke tests pass.
5. README is updated with the new install path.

## Cleanup Candidates

Review later, not now:

- `archive/internship/Chores/`
- `archive/legacy/grafana/`
- `archive/legacy/prometheus/`
- `archive/legacy/alertmanager/`
- `archive/legacy/traefik/`
- `archive/legacy/k6/`
- `archive/legacy/docs-site/`
- old root markdown notes

Already moved out of root:

- `docs/notes/docusuarus-base.md`
- `archive/legacy/grafana/grafana-link-dashboard.json`
- `archive/reference/FileBeat.zip`
- `docs/notes/recommendation.md`
- `docs/notes/examine.md`
- `docs/deployment/restore-backup.md`
- `archive/local/` for ignored machine-local notes and artifacts

These may contain useful internship evidence, so do not delete them without review.

