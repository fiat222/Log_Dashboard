# Log Dashboard

Centralized container log ingestion, search, and analytics stack. OpenTelemetry pipeline → ClickHouse columnar storage → FastAPI role-based query layer → Nginx SPA.

---

## Stack

| Service | Image | Role |
|---------|-------|------|
| `postgres` | postgres:16-alpine | User accounts, roles, settings |
| `redis` | redis:7.2 | Session cache, rate limiting (not log buffer) |
| `clickhouse` | clickhouse-server:24.3-alpine | Log storage + analytics (columnar, MergeTree) |
| `otel-gateway` | otel-collector-contrib:0.100.0 | Receives OTLP, transforms, batches → ClickHouse |
| `vector-containers` | vector:0.54.0-alpine | Reads Docker socket logs → OTLP to gateway |
| `backend` | backend:${TAG} | FastAPI — auth, role-based ClickHouse proxy, SSE |
| `log-dashboard` | dashboard:${TAG} | Nginx serving static SPA |
| `docker-proxy` | docker-socket-proxy:latest | Read-only Docker API proxy (Events + Containers only) |
| `backup` | backup:${TAG} | APScheduler-triggered PostgreSQL + ClickHouse backups |

---

## Architecture

```
INGESTION PIPELINE
──────────────────
Main VM Docker containers
  └─► vector-containers (Docker socket) ──────────────────────►┐
                                                                 │
External VMs (each runs Chores/vector/Docker_logs/)             │
  └─► Vector (Docker socket) → HTTP OTLP → 10.135.4.67:4318 ──►┤
                                                                 ▼
                                                          otel-gateway
                                                    (filter → transform → batch)
                                                                 │
                                                                 ▼
                                                          ClickHouse
                                                   observability.otel_logs_local

QUERY PATH
──────────
Browser ──► Host Nginx (monitor-eila.ac.th/logstore/)
                 │ proxy_pass → localhost:8801
                 ▼
            log-dashboard (Docker Nginx :8801)
                 │ /logstore/api → proxy_pass backend:8000
                 ▼
            backend (FastAPI :8000, 4 workers)
            ├── ClickHouse  (SQL — role-filtered)
            ├── PostgreSQL  (auth / roles)
            └── Redis       (sessions / cache)

Host Nginx also serves Grafana and other services on same domain.
Port 8801 is localhost-only — not directly browser-accessible.

NETWORK
───────
pipeline_network  10.0.1.0/24   all services on single bridge network
```

---

## ClickHouse Schema (3-layer pipeline)

| Table | Engine | Purpose |
|-------|--------|---------|
| `observability.otel_logs_ingress` | Null | Absorbs OTel wire format, zero disk write |
| `observability.otel_logs_mv` | Materialized View | Real-time ETL transform on insert |
| `observability.otel_logs_local` | MergeTree | Queryable storage — partitioned by day, ZSTD |
| `logs.nginx_logs` | MergeTree | Nginx access logs (separate Vector pipeline) |

Key columns on `otel_logs_local`: `Timestamp`, `SeverityText`, `Body`, `ResourceAttributes`, `LogAttributes`

Old schema `logs.container_logs` (Filebeat era) — may still exist, not queried.

---

## Quick Start

```bash
# TAG is required — never omit, never use 'latest' in production
export TAG=v1.2.0

# Start full stack
docker compose up -d

# Verify all services are healthy
docker compose ps

# Tail a service
docker compose logs -f backend
docker compose logs -f otel-gateway
```

---

## Dev Commands

```bash
# Rebuild single service after code change
docker compose build backend && docker compose up -d backend
docker compose build log-dashboard && docker compose up -d log-dashboard

# Rebuild all images and push to registry
./deploy-registry.ps1   # Windows PowerShell
./deploy.sh             # Linux

# Promote tag to production
./promote.ps1

# Check OTel gateway metrics (bound to localhost only)
curl http://localhost:8888/metrics

# Check backend health
curl http://localhost:8000/api/health
```

---

## Environment Variables

Copy `.env.example` → `.env` before first run.

| Variable | Used By |
|----------|---------|
| `TAG` | Image tag — backend, dashboard, backup |
| `REGISTRY_IMAGE_PATH` | Private registry prefix for all images |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | postgres, backend, backup |
| `REDIS_PASSWORD` | redis, backend |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` / `CLICKHOUSE_DB` | clickhouse, otel-gateway, backend, backup |
| `SECRET_KEY` | backend JWT signing (min 32 chars) |

---

## Key Files

| File | Purpose |
|------|---------|
| `dashboard/app.js` | All frontend logic — ~2500 lines, single `state` object drives all views |
| `dashboard/index.html` | DOM: tabs (Logs, Analytics, Nginx, Patterns, Admin), modals |
| `dashboard/style.css` | CSS vars for light/dark theme (`[data-theme="dark"]`), no framework |
| `backend/main.py` | FastAPI — JWT auth, role-based ClickHouse proxy, SSE notifications |
| `clickhouse/init.sql` | Schema — Null engine ingress + MV + MergeTree storage |
| `otel/gateway-config.yaml` | OTel pipeline — receive OTLP, filter blanks, infer severity, batch → ClickHouse |
| `otel/agent-config.yaml` | OTel agent config (reads Docker logs from host) |
| `vector/vector-containers.toml` | Vector source config → OTLP/HTTP sink to gateway |
| `backup/backup.sh` | `pg_dump` + ClickHouse `BACKUP DATABASE` → `/mnt/Logstore_backup` |
| `docker-compose.yml` | Full stack — 3 networks, resource limits, healthchecks |

---

## OTel Gateway Pipeline

```
otlp receiver
    └─► memory_limiter  (1024 MiB hard cap, 256 MiB spike)
         └─► filter      (drop blank log bodies)
              └─► transform  (infer severity, extract container.name from Docker labels)
                   └─► batch  (4096 records / 500ms max wait)
                        └─► clickhouse exporter
                             ├── LZ4 compression on TCP :9000
                             ├── async_insert=1 (non-blocking writes)
                             ├── sending_queue: 10000 slots, 4 consumers
                             └── retry: 5s→30s backoff, 5min max
```

Traces pipeline removed — not in use. Health endpoint exposed on `:13133`.

---

## Monitoring

Prometheus, Grafana, Alertmanager, and cAdvisor run on a **separate VM** and scrape this stack.

| Endpoint | Service | What to watch |
|----------|---------|---------------|
| `localhost:8888/metrics` | otel-gateway | Queue depth, export errors, batch sizes |
| `:8000/api/health` | backend | DB connectivity, version |

Key OTel metrics:
- `otelcol_exporter_queue_size` > 8000 → ingestion lagging behind ClickHouse writes
- `otelcol_exporter_send_failed_log_records` > 0 → export failures, check ClickHouse
- `otelcol_processor_batch_batch_size_trigger_send` → batch hit by size (not timeout) = good throughput

---

## Security

| Control | Detail |
|---------|--------|
| Docker socket isolation | `docker-proxy` exposes only Events + Containers read-only API to backend. Raw socket not mounted in any app container. |
| No public DB ports | ClickHouse, PostgreSQL, Redis have zero exposed ports |
| OTel metrics | Bound to `127.0.0.1:8888` — not reachable from outside host |
| Privilege escalation | All containers: `no-new-privileges:true` |
| Non-root runtime | backend uid `10001`, otel-gateway uid `10001`, otel-gateway filesystem read-only |
| vector-containers | Runs as root — required for Docker socket + host log path access |

> **Recommended next steps:** firewall port 8801 to allow only the Nginx VM's IP (host Nginx is on a separate VM — localhost binding won't work), allowlist OTLP ports 4317/4318 to known agent IPs only, rotate secrets via Docker secrets instead of `.env` file.

---

## External VM Agent Deployment

Each external VM runs a standalone Vector container that ships Docker logs to the gateway.

Config lives in `Chores/vector/Docker_logs/` — copy to target VM and deploy:

```bash
# On each external VM
scp -r Chores/vector/Docker_logs/ user@vm-host:~/vector-agent/
ssh user@vm-host "cd ~/vector-agent && docker compose up -d"
```

Vector sends to `10.135.4.67:4318` (OTLP/HTTP). Update `uri` in `vector.toml` if gateway IP changes.

Resource attributes set per log record: `container.name`, `container.id`, `container.image.name`, `service.name`, `host.name`, `container.label.com.docker.compose.project`

`vector-containers` excluded from its own collection via `exclude_containers`.

---

## Backup & Restore

Backups land in `/mnt/Logstore_backup` on the host (same path ClickHouse uses for its user_files).

```bash
# Trigger manual backup via backend API
curl -X POST http://localhost:8000/api/admin/backup
```

Output files:
- `pg_logdash_YYYYMMDD_HHMMSS.sql.gz` — PostgreSQL full dump
- `ch_observability_YYYYMMDD_HHMMSS.tar.gz` — ClickHouse database backup

See `restore_backup.md` for restore procedure.

---

## Migration from Old Stack (Filebeat Era)

| Layer | Old | New |
|-------|-----|-----|
| Collector | Filebeat 8.13 | OTel Collector Agent (contrib 0.100.0) |
| Buffer | Redis (log pipeline) | OTel Gateway in-memory batch queue |
| Ingester | Python clickhouse-connect service | OTel Gateway ClickHouse exporter |
| Nginx logs | Vector → Redis → Python BLPOP → CH | Vector → OTel Gateway → CH |
| Schema | `logs.container_logs` | `observability.otel_logs_local` |
| Redis role | Log buffer + cache | Cache + rate-limit only |
