# Install Monitoring Platform

## Purpose

This is the detailed installation path for the Centralized Monitoring and Investigation Cockpit. It combines central stack setup, edge agent setup, collector verification, and optional docs-site setup.

## 1. Prepare Central Server

Prerequisites:

- Docker Engine.
- Docker Compose plugin.
- Disk space for ClickHouse data.
- Network access from monitored hosts to central ports.

Recommended exposed ports:

| Purpose | Port |
|---|---:|
| Dashboard | `8801` |
| Backend API | internal through dashboard proxy |
| OTel HTTP | `4318` |
| OTel gRPC | `4317` |
| Prometheus, if exposed | project-defined |

Install:

```powershell
Copy-Item .env.example .env
docker compose up -d
```

Configure `.env` before production-like use:

- `JWT_SECRET_KEY`
- `REDIS_PASSWORD`
- `CLICKHOUSE_PASSWORD`
- `POSTGRES_PASSWORD`
- dashboard base URL and cookie mode
- collector/auth token once edge auth is implemented

Verify:

```powershell
docker compose ps
docker compose logs backend
docker compose logs otel-gateway
```

Expected:

- Dashboard opens.
- Backend health responds.
- ClickHouse is healthy.
- OTel Gateway listens on `4318`.
- Monitoring Overview renders, even if some collectors are not configured yet.

## 2. Prepare Monitored Host

The monitored host runs the Edge Agent Bundle.

```powershell
cd edge
Copy-Item .env.example .env
```

Set stable identity:

```env
EDGE_HOST_ID=home-server
EDGE_SITE=home-lab
EDGE_ENV=dev
CENTRAL_OTEL_ENDPOINT=http://CENTRAL_IP:4318
CENTRAL_API_ENDPOINT=http://CENTRAL_IP:8000
```

Start:

```powershell
docker compose up -d
```

Verify:

```powershell
docker compose ps
docker compose logs vector
```

Expected:

- Vector is running.
- node_exporter or host metrics source is running when enabled.
- cAdvisor or container metrics source is running when enabled.
- Monitored host appears in the central UI after telemetry arrives.

## 3. Configure Workload Database Monitoring

Workload databases are databases owned by apps on the monitored host. They are not the platform PostgreSQL or ClickHouse unless the platform itself is being monitored.

Recommended first profiles:

- PostgreSQL profile.
- MySQL/MariaDB profile.
- Redis profile.
- ClickHouse profile.

Each profile should define:

- display name;
- host and port;
- database type;
- read-only credentials or exporter endpoint;
- enabled metrics;
- scrape interval;
- timeout;
- labels such as service, environment, and host.

Until a profile is implemented, the UI should show `Not configured` instead of fake metrics.

## 4. Optional Docusaurus Documentation Site

Docusaurus is acceptable for detailed install and operator documentation. A legacy Docusaurus site already exists under `archive/legacy/docs-site` and can be revived later as `docs-site/` after the product docs stabilize.

Recommended docs-site content:

- Central install.
- Edge install.
- Collector matrix.
- Workload database profiles.
- Alerting setup.
- Incident investigation demo.
- Troubleshooting.
- Security and token model.

Do not make Docusaurus block Phase 6 implementation. Treat it as a Phase 8 presentation/documentation surface unless installation docs become the highest risk.


## Workload Database Profiles

Workload databases are configured separately from platform databases. Set `WORKLOAD_DATABASE_PROFILES` to a JSON array and prefer `dsn_env` so credentials stay in environment variables.

Example:

```env
WORKLOAD_DATABASE_PROFILES=[{"id":"orders-db","name":"Orders PostgreSQL","type":"postgres","dsn_env":"ORDERS_DATABASE_URL"}]
ORDERS_DATABASE_URL=postgresql://readonly:change_me@orders-db:5432/orders
```

Supported first-slice probes: PostgreSQL, Redis, ClickHouse. MySQL/MariaDB and MongoDB appear as exporter/probe-needed until their probes are added.
