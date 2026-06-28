# Install Central Stack

## Purpose

The central stack is the main observability platform. It runs the dashboard, backend, databases, telemetry gateway, and monitoring services.

## Current Status

The working central stack currently lives at the repository root.

Use:

- `docker-compose.yml`
- `.env.example`

The `central/` folder documents the future install surface and should be migrated after smoke tests pass.

## Prerequisites

- Docker Engine.
- Docker Compose plugin.
- Enough disk space for ClickHouse data.
- Open inbound ports for dashboard and telemetry ingress.

Recommended starting ports:

| Purpose | Port |
|---|---:|
| Dashboard | `8801` |
| OTel HTTP | `4318` |
| OTel gRPC | `4317` |
| OTel metrics | `8888` |

## Install

From repository root:

```powershell
Copy-Item .env.example .env
```

Edit `.env`:

- Set strong `JWT_SECRET_KEY`.
- Set strong `REDIS_PASSWORD`.
- Set strong `CLICKHOUSE_PASSWORD`.
- Set local/dev cookie mode if using HTTP.
- Configure database URL.
- Configure app base path/domain.

Start:

```powershell
docker compose up -d
```

Check:

```powershell
docker compose ps
docker compose logs backend
docker compose logs otel-gateway
```

## First Login

Use the local superadmin account configured in `.env`.

Authentik is mock/future integration for the co-op scope unless a real SSO environment is available.

## Add Edge Host

After central is reachable, install the edge stack on another machine.

See `docs/deployment/install-edge.md`.

## Smoke Test

Expected:

- Dashboard opens.
- Backend health endpoint responds.
- ClickHouse is healthy.
- OTel Gateway listens on `4318`.
- Logs appear after edge or local collector sends telemetry.

## Known Migration Note

The current root compose includes central services and a local Vector container collector. The future direction is:

```text
central/ = central platform
edge/    = external host collector
```

Do not remove the existing local collector until the edge stack is validated.

