# Architecture: Central and Edge Platform

## Overview

The platform uses a central-edge architecture.

Central server runs the product. Edge hosts run lightweight collectors. The central server stores, processes, and displays telemetry from all connected hosts.

```text
Edge Host
  ├─ Vector
  ├─ node_exporter
  ├─ cAdvisor
  └─ edge metadata / heartbeat
        ↓
Central Server
  ├─ Dashboard Web
  ├─ Backend API
  ├─ OTel Gateway
  ├─ ClickHouse
  ├─ PostgreSQL
  ├─ Redis
  └─ Prometheus
```

## Central Stack

The central stack should be installable with Docker Compose.

Core services:

- Dashboard Web: serves the UI.
- Backend API: auth, RBAC, query APIs, notifications, platform metadata.
- OTel Gateway: central telemetry ingress for logs and future traces.
- ClickHouse: primary log/event storage.
- PostgreSQL: users, roles, settings, service identity, module config.
- Redis: cache/realtime queue where useful.
- Prometheus: metrics collection and querying.

Optional services:

- Tempo for traces.
- Jenkins for CI/CD learning and demo.
- SonarQube for code quality demo.
- Security scanners in CI.

## Edge Stack

The edge stack should also be installable with Docker Compose.

Core edge services:

- Vector: Docker logs, app logs, gateway logs.
- node_exporter: host metrics.
- cAdvisor: container metrics.
- Edge metadata helper: stable `host_id`, heartbeat, inventory; optional at first.

The user configures edge through `.env`.

Example:

```env
EDGE_HOST_ID=home-server
EDGE_SITE=home-lab
CENTRAL_OTEL_ENDPOINT=http://192.168.1.10:4318
CENTRAL_API_ENDPOINT=http://192.168.1.10:8000
EDGE_AUTH_TOKEN=change-me
```

## Data Flow

### Logs

```text
Docker / app / gateway logs
  → Vector edge collector
  → Central OTel Gateway
  → ClickHouse
  → Backend API
  → Dashboard
```

### Metrics

```text
node_exporter / cAdvisor
  → Prometheus scrape
  → Backend API or dashboard query layer
  → Dashboard
```

### Platform Metadata

```text
Dashboard / Backend
  → PostgreSQL
```

Metadata includes:

- Users.
- Roles.
- Member management.
- Service ownership.
- Stable service identity.
- Module visibility.
- Dashboard preferences.
- Agent registration state.

## Installation UX

Central install:

```bash
git clone <repo>
cd <repo>/central
cp .env.example .env
docker compose up -d
```

Edge install:

```bash
cd <repo>/edge
cp .env.example .env
docker compose up -d
```

The exact paths may change during implementation, but the product should keep this mental model.

## Compose Profiles

Use profiles to keep the default install manageable.

Recommended profiles:

- `core`: dashboard, backend, redis.
- `local-db`: ClickHouse and PostgreSQL.
- `metrics`: Prometheus and exporters.
- `tracing`: Tempo.
- `ci`: Jenkins and SonarQube.
- `security`: local security tooling.
- `demo`: sample apps and generated logs.

## Design Constraints

- Central install must be understandable.
- Edge install must be repeatable.
- Logs remain first-class.
- Existing ingestion path should not be broken.
- External databases should be configurable later.
- Features should degrade gracefully when optional services are disabled.

