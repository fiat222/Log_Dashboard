# Log Dashboard

Centralized container log ingestion, search, and analytics stack. OpenTelemetry pipeline → ClickHouse columnar storage → FastAPI role-based query layer → Nginx SPA.

> Project direction: this repository is being organized into a self-hosted centralized observability platform with a central stack and edge agent stack. Start with `docs/README.md`, `docs/project-charter.md`, and `docs/project-structure.md` for the current roadmap and repository layout.

---

## Stack

| Service | Image | Role |
|---------|-------|------|
| `redis` | redis:7.2 | Session cache, rate limiting |
| `clickhouse` | clickhouse-server:24.3-alpine | Log storage + analytics (columnar, MergeTree) |
| `otel-gateway` | otel-collector-contrib:0.100.0 | Receives OTLP, transforms, batches → ClickHouse |
| `vector` | vector:0.54.0-alpine | Reads Docker socket and Nginx Logs → OTLP to gateway |
| `backend` | logs-dashboard-backend:${TAG:-local} | FastAPI — auth, role-based ClickHouse proxy, SSE notifications |
| `log-dashboard` | dashboard:${TAG:-local} | Docker Nginx — serves SPA + proxies /logstore/api → backend |
| `ch-ui` | nginxinc/nginx-unprivileged:1.25 | ClickHouse UI proxy surface at /logstore/clickhouse/ |
| `docker-proxy` | docker-socket-proxy:latest | Read-only Docker API proxy (Events + Containers only) |
| `backup` | logs-dashboard-backup:${TAG:-local} | APScheduler-triggered ClickHouse backups |

| `postgres` | postgres:16-alpine | Local platform metadata DB for auth, roles, ownership |

---

## Architecture

```
INGESTION PIPELINE
──────────────────
Main VM Docker containers
  └─► vector (Docker socket + Nginx logs) ────────────────────────►┐
                                                                    │
External VMs (each runs archive/internship/Chores/vector/Docker_logs/)                │
  └─► Vector (Docker socket) → HTTP OTLP → 192.168.116.156:4318 ──►┤
                                                                    ▼
                                                             otel-gateway
                                                       (filter → transform → batch)
                                                                    │
                                                                    ▼
                                                             ClickHouse
                                                      observability.otel_logs_local

QUERY / ACCESS PATH
────────────────────
Browser
  │
  ▼
Browser
  │
  ▼
log-dashboard Docker Nginx (:8801)
  │  /logstore/api/*         → backend:8000/api/
  │  /logstore/auth/*        → backend:8000/auth/
  │  /logstore/ch-api/*      → clickhouse:8123  (raw HTTP API for ch-ui)
  │  /logstore/clickhouse/*  → ch-ui:3488       (ClickHouse UI SPA)
  │  /logstore/*             → static SPA files
  │
  ▼
backend (FastAPI :8000, 4 workers)
  ├── ClickHouse  (SQL queries — role-filtered per user)
  ├── PostgreSQL  (auth / roles / ownership) — local `postgres` service
  └── Redis       (sessions / cache)
```

> **Critical:** Docker Nginx only receives requests prefixed with `/logstore/`.
> Root-absolute paths (`/api/`, `/assets/`) hit Host Nginx directly — never reach Docker Nginx.
> Never add `location /api/` to `nginx.conf.template` — it is unreachable dead code.

---

## ch-ui Sub-path Routing

ch-ui SPA is served at `/logstore/clickhouse/` but internally makes root-absolute requests (`/api/auth/session`, `/assets/logo.png`). These would hit Host Nginx (→ Grafana → 404) instead of ch-ui.

**Two-layer fix in `apps/web/nginx.conf.template`:**

1. **`sub_filter`** — rewrites string literals in HTML/JS/CSS at proxy time:
   - `/assets/` → `/logstore/clickhouse/assets/`
   - `/api/` → `/logstore/clickhouse/api/`
   - `/connect` → `/logstore/clickhouse/connect`

2. **JS fetch interceptor** — injected into ch-ui `<head>` via `sub_filter </head>`. Catches dynamic runtime `fetch()` and `XMLHttpRequest` calls that sub_filter misses. Rewrites `/api/` and `/assets/` to the correct sub-path before the request leaves the browser.

**ch-ui env vars:**

| Var | Purpose | Note |
|-----|---------|------|
| `CLICKHOUSE_URL` | Server-side ClickHouse URL for embedded agent | Must be `http://clickhouse:8123` |
| `CLICKHOUSE_USER` | ClickHouse username | Runtime — read by Go server |
| `CLICKHOUSE_PASSWORD` | ClickHouse password | Runtime — read by Go server |
| `VITE_CLICKHOUSE_URL` | Frontend default URL | **Build-time only** — has no effect on pre-built image |
| `VITE_CLICKHOUSE_USER` | Frontend default username | **Build-time only** — ignore |
| `VITE_CLICKHOUSE_PASS` | Frontend default password | **Build-time only** — ignore |

**ch-ui auth database:**
ch-ui stores its own user accounts in `/app/data/ch-ui.db` (SQLite). This path is **not mounted as a Docker volume** — accounts are lost if the container is recreated. On first run, create an admin account at `/logstore/clickhouse/`. Login credentials are ch-ui's own account, separate from ClickHouse credentials.

> **TODO:** Mount `/app/data` as a named volume in `docker-compose.yml` to persist ch-ui accounts across container recreations.

---

## ClickHouse Schema (3-layer pipeline)

| Table | Engine | Purpose |
|-------|--------|---------|
| `observability.otel_logs_ingress` | Null | Absorbs OTel wire format — **always shows 0 rows** (by design) |
| `observability.otel_logs_mv` | Materialized View | ETL transform — **always shows 0 rows** (by design) |
| `observability.otel_logs_local` | MergeTree | Actual queryable storage — partitioned by day, ZSTD |
| `logs.nginx_logs` | MergeTree | Nginx access logs (Vector pipeline) |

> `otel_logs_ingress` uses Null engine — data passes through instantly to the MV and is never stored. Both showing 0 rows in ch-ui is **normal and expected**. Check `otel_logs_local` for actual log counts.

Key columns on `otel_logs_local`: `Timestamp`, `SeverityText`, `Body`, `ResourceAttributes`, `LogAttributes`, `ContainerName`, `ComposeProject`, `_ttl_date`

Old schema `logs.container_logs` (Filebeat era) — may still exist on the server, not queried.

---

## Key Files

| File | Purpose |
|------|---------|
| `apps/web/app.js` | All frontend logic — ~2500 lines, single `state` object drives all views |
| `apps/web/index.html` | DOM: tabs (Logs, Analytics, Nginx, Patterns, Admin), modals |
| `apps/web/style.css` | CSS vars for light/dark theme (`[data-theme="dark"]`), no framework |
| `apps/web/nginx.conf.template` | Docker Nginx config — sub_filter path rewriting for ch-ui, all proxy rules |
| `apps/api/main.py` | FastAPI — JWT auth, role-based ClickHouse proxy, SSE notifications |
| `infra/clickhouse/init.sql` | Schema — Null engine ingress + MV + MergeTree storage + viewer_profile |
| `infra/otel/gateway-config.yaml` | OTel pipeline — receive OTLP, filter blanks, infer severity, batch → ClickHouse |
| `archive/internship/Chores/vector/Docker_logs/vector.toml` | Vector source config to scrape container logs → OTLP/HTTP sink to gateway |
| `archive/internship/Chores/vector/vector.toml` | Vector source config to scrape nginx Gateway metrics → OTLP/HTTP sink to gateway |
| `docker-compose.yml` | Full stack — 1 bridge network, resource limits, healthchecks |
| `apps/backup/backup.sh` | ClickHouse `BACKUP DATABASE` → `/mnt/Logstore_backup` |

---

## Frontend Architecture (`app.js`)

- **Single state object** `state` drives all views. Update state, call the load function for that view.
- **API calls** go through `API_BASE = "/logstore/api"`. Backend filters by user role/container ownership.
- **Auth**: Redis session cookie via `/logstore/api/auth/me`. Redirects to `/logstore/login` on 401.
- **SSO**: PSU Authentik OAuth2 — configured and working in production. Callback: `/logstore/callback/login`.
- **Tabs**: `view-tabs` buttons toggle `#logs-view-wrapper`, `#analytics-section`, `#nginx-view-wrapper`, `#patterns-section`, `#admin-section`.
- **SSE**: Live log streaming via `EventSource` at `/logstore/api/logs/stream`.

---

## Dev Commands

```bash
# Start the full stack
docker compose up -d

# Rebuild a single service after code change
docker compose build backend && docker compose up -d backend
docker compose build log-dashboard && docker compose up -d log-dashboard

# Restart ch-ui after env var change (no rebuild needed)
docker compose up -d ch-ui

# View logs for a service
docker compose logs -f backend
docker compose logs -f log-dashboard
docker compose logs -f ch-ui

# Rebuild all images and push to registry
./deploy/deploy-registry.ps1 <tag>  # build and push to gitlab

./deploy/deploy.sh <tag>            # deploy with tag

# Check OTel gateway metrics
curl http://localhost:8888/metrics

# Check backend health
curl http://localhost:8000/api/health

# Check log count in ClickHouse
docker exec -it clickhouse clickhouse-client \
  --query "SELECT count() FROM observability.otel_logs_local"
```

---

## Environment Variables

Copy `.env.example` → `.env` before first run.

| Variable | Used By |
|----------|---------|
| `TAG` | Image tag — backend, dashboard, backup |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` / `CLICKHOUSE_DB` | clickhouse, otel-gateway, backend, backup, ch-ui |
| `REDIS_PASSWORD` | redis, backend |
| `JWT_SECRET_KEY` | backend — min 32 chars, generate with `openssl rand -hex 32` |
| `COOKIE_SECURE` | backend — must be `true` in production (HTTPS) |
| `SESSION_TTL_DAYS` | backend — sliding session window in days |
| `SUPER_ADMIN_USERNAME` / `SUPER_ADMIN_PASSWORD` | backend — emergency local login (not via SSO) |
| `AUTHENTIK_BASE_URL` / `AUTHENTIK_CLIENT_ID` / `AUTHENTIK_CLIENT_SECRET` | backend — optional SSO OAuth2 |
| `AUTHENTIK_REDIRECT_URI` | backend — must match Authentik application config |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | postgres, backend — local metadata DB |
| `APP_BASE_PATH` | backend — must be `/logstore` |

---

## OTel Gateway Pipeline

```
otlp receiver (HTTP :4318, gRPC :4317)
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

Key OTel metrics (scrape `:8888/metrics`):
- `otelcol_exporter_queue_size` > 8000 → ingestion lagging behind ClickHouse writes
- `otelcol_exporter_send_failed_log_records` > 0 → export failures, check ClickHouse
- `otelcol_processor_batch_batch_size_trigger_send` → batch hit by size = healthy throughput

---

## Security

| Control | Detail |
|---------|--------|
| Docker socket isolation | `docker-proxy` exposes only Events + Containers read-only to backend |
| No public DB ports | ClickHouse, Redis have zero exposed ports |
| OTel metrics | Bound to `0.0.0.0:8888` — firewall to localhost only |
| log-dashboard port | `:8801` — firewall to Host Nginx IP only |
| Privilege escalation | All containers: `no-new-privileges:true` |
| Non-root runtime | backend uid `10001`, otel-gateway uid `10001`, otel-gateway filesystem read-only |
| vector | Runs as root — required for Docker socket + host log path access |
| ClickHouse loguser | `viewer_profile` limits max_execution_time=30s, max_memory=2GB, max_rows=500M per query |

---

## External VM Agent Deployment

Each external VM runs a standalone Vector container that ships Docker logs to the gateway.

Config lives in `archive/internship/Chores/vector/Docker_logs/` — copy to target VM:

```bash
scp -r archive/internship/Chores/vector/Docker_logs/ user@vm-host:~/vector-agent/
ssh user@vm-host "cd ~/vector-agent && docker compose up -d"
```

Vector sends to `192.168.116.156:4318` (OTLP/HTTP). Update `uri` in `vector.toml` if gateway IP changes.

---

## Backup & Restore

Automatic backup runs every 5 days at the hour configured in Admin → Settings (default 20:00 UTC). Trigger manually from Admin tab or:

```bash
curl -X POST http://localhost:8000/api/admin/backup
```

Backup files land in `/mnt/Logstore_backup` on the host:
- `ch_observability_YYYYMMDD_HHMMSS.tar.gz` — ClickHouse database backup

PostgreSQL data is stored in the `postgres_data` Docker volume and is managed by the local Compose stack.

See `docs/deployment/restore-backup.md` for ClickHouse restore procedure.

---

## Monitoring

Prometheus, Grafana, Alertmanager, and cAdvisor run on the same VM as Host Nginx and scrape this stack.

| Endpoint | Service | What to watch |
|----------|---------|---------------|
| `localhost:8888/metrics` | otel-gateway | Queue depth, export errors, batch sizes |
| `:8000/api/health` | backend | DB connectivity, version |

---

## Maintenance

### Fix Retention TTL on existing deployments

The Settings UI → Retention Days runs `ALTER TABLE observability.otel_logs_local MODIFY TTL`. New deployments get the fixed `viewer_profile` from `init.sql` automatically. Existing deployments must run once inside ClickHouse:

```bash
docker exec -it clickhouse clickhouse-client \
  --user $CLICKHOUSE_USER --password $CLICKHOUSE_PASSWORD
```

```sql
ALTER SETTINGS PROFILE viewer_profile SETTINGS readonly = 0;
```

Verify TTL after changing Retention Days in Settings:
```sql
SELECT name, ttl FROM system.tables WHERE database = 'observability';
```

### Persist ch-ui accounts across restarts

Add to `docker-compose.yml` under `ch-ui`:
```yaml
volumes:
  - ch_ui_data:/app/data

# and under top-level volumes:
volumes:
  ch_ui_data:
```

Without this, ch-ui's SQLite auth database is lost on every container recreate.

---

## Migration from Old Stack (Filebeat Era)

| Layer | Old | New |
|-------|-----|-----|
| Collector | Filebeat 8.13 | Vector Agent |
| Buffer | Redis (log pipeline) | OTel Gateway in-memory batch queue |
| Ingester | Python clickhouse-connect service | OTel Gateway ClickHouse exporter |
| Nginx logs | Vector → Redis → Python BLPOP → CH | Vector → OTel Gateway → CH |
| Schema | `logs.container_logs` | `observability.otel_logs_local` |
| Redis role | Log buffer + cache | Cache + rate-limit only |
