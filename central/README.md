# Central Stack

This folder is the target home for the central platform stack.

The current working central stack still lives at the repository root as:

- `docker-compose.yml`
- `.env.example`
- `clickhouse/`
- `otel/`
- `backend/`
- `dashboard/`
- `backup/`

Do not move the working compose file until the migration plan is tested.

## Goal

The central stack should eventually provide:

- Dashboard Web
- Backend API
- ClickHouse
- PostgreSQL
- Redis
- OTel Gateway
- Prometheus
- Optional Tempo
- Optional CI/security profiles

## Migration Plan

1. Keep root `docker-compose.yml` as the working stack.
2. Add central/edge documentation and environment examples.
3. Add edge collector stack and test external ingestion.
4. Add compose profiles to the existing root stack.
5. Move or mirror the central compose into this folder after smoke tests pass.

## Current Install Path

Use the root stack for now:

```powershell
Copy-Item .env.example .env
docker compose up -d
```

See `docs/deployment/install-central.md` for the professional install flow.

