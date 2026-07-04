# Central Stack

This folder documents the central platform stack while the working Compose entrypoint remains at the repository root.

## Current State

The active central stack is still started from:

```powershell
docker compose up -d
```

Runtime source and config now live in production-style folders:

```text
apps/api/              FastAPI backend
apps/web/              dashboard SPA and Nginx template
apps/backup/           ClickHouse backup worker
infra/clickhouse/      ClickHouse schema and server config
infra/otel/            OTel collector configs
infra/vector/          Vector central collector config
docker-compose.yml     root compatibility entrypoint
```

## Goal

The central stack should provide:

- Dashboard web UI.
- Backend API.
- ClickHouse, PostgreSQL, and Redis.
- OTel Gateway.
- Central Vector collector.
- Optional monitoring/security profiles when they can be demonstrated.

## Migration Rule

Do not move `docker-compose.yml` out of the root until install docs, CI, and smoke checks all use the new path. The root command is the supported operator path for now.

See `docs/deployment/install-central.md` for installation details.
