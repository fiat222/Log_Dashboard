# Log System Overhaul — Senior-Level Implementation Plan

> **Context:** Dev on local Windows machine → build images → push to PSU GitLab Registry → server (`monitor-eila.psu.ac.th`) pulls + runs via `docker compose pull && up -d`. Server already has Grafana + Prometheus + cAdvisor + node-exporter for host/container metrics. Remote backup mounted from another VM.
>
> **Strategy:** Replace log pipeline with OTel Collector. Wire existing Prometheus stack into dashboard notifications (no new tracing infrastructure). Formalize build-push-pull workflow. Production hardening throughout.

---

## What's Already Good (Don't Touch)

| Layer | Status | Why Leave Alone |
|---|---|---|
| Grafana + Prometheus + cAdvisor + node-exporter | ✅ Working | Host/container metrics already covered |
| Backup to external VM mount | ✅ Working | Off-host backup requirement already met |
| GitLab Registry + `deploy-registry.ps1` | ✅ Working | No runners available — local push is the accepted pattern |
| Traefik, PostgreSQL, Redis (cache/rate-limit role) | ✅ Working | Not in scope |
| Role-based auth, SSO, notifications bell | ✅ Working | Foundation for Phase 9 integration |

---

## What Changes

| Layer | Before | After |
|---|---|---|
| Log collector | Filebeat 8.13 | OTel Collector Agent |
| Log ingester | Python (BLPOP loop) | OTel Gateway ClickHouse exporter |
| Redis in log path | Buffer (128 MB cap) | Removed from log path (kept for cache/rate-limit) |
| Nginx log sink | Vector → Redis → FastAPI BLPOP | Vector → OTel Gateway → ClickHouse |
| Log storage | `logs.container_logs`, `logs.nginx_logs` | `observability.otel_logs_local` |
| Level detection | JS keyword scan in Filebeat | OTel `severity_parser` on structured `level` field |
| Alert surface | Prometheus rules exist, not wired to UI | Alertmanager → FastAPI webhook → existing notifications bell |
| Logs + Metrics unified view | None | Grafana ClickHouse datasource — same dashboard shows metric spike + related logs |
| CI/CD | Manual `deploy-registry.ps1` | `Makefile` + versioned tags + compose pull workflow |

---

# Phase 1 — Code Changes (FastAPI + backup.sh)

Do this BEFORE touching docker-compose. Stack still runs on old pipeline during this phase.

### 1.1 FastAPI — delete nginx BLPOP task

In `backend/main.py`:
- Delete `_nginx_ingester_task` coroutine (around line 1694)
- Delete its start/stop in lifespan
- Delete `NGINX_REDIS_KEY` env read

**Keep all Redis cache/rate-limit code untouched.** Only the log-pipeline role of Redis is removed.

### 1.2 backup.sh — update schema references

Update any hardcoded DB/table names:
- `logs.container_logs` / `logs.nginx_logs` → `observability.otel_logs_local`
- ClickHouse `BACKUP TABLE logs.* TO Disk('backups', ...)` → `BACKUP DATABASE observability TO Disk('backups', ...)`

---

# Phase 2 — ClickHouse Schema

Senior note: partition by day is standard for log workloads, but `ORDER BY (ServiceName, SeverityText, Timestamp)` is the real performance win — it co-locates rows that will be queried together. ZSTD(3) is the right codec for log text (beats LZ4 by ~20% size for logs, CPU overhead negligible at insert).

```sql
-- 2.1 Drop old
DROP TABLE IF EXISTS logs.container_logs;
DROP TABLE IF EXISTS logs.nginx_logs;
DROP TABLE IF EXISTS logs.nginx_status_mv;
DROP TABLE IF EXISTS logs.nginx_top_paths_mv;
DROP TABLE IF EXISTS logs.nginx_hourly_mv;

-- 2.2 New database
CREATE DATABASE IF NOT EXISTS observability;

-- 2.3 Null Engine ingress (decouples OTel wire format from storage)
CREATE TABLE observability.otel_logs_ingress
(
    Timestamp           DateTime64(9),
    TraceId             String,
    SpanId              String,
    SeverityText        String,
    SeverityNumber      Int32,
    ServiceName         String,
    Body                String,
    ResourceAttributes  Map(String, String),
    LogAttributes       Map(String, String)
)
ENGINE = Null;

-- 2.4 Storage table
CREATE TABLE observability.otel_logs_local
(
    Timestamp           DateTime64(9)                           CODEC(Delta, ZSTD(3)),
    ServiceName         LowCardinality(String),
    SeverityText        LowCardinality(String),
    SeverityNumber      Int32,
    Body                String                                  CODEC(ZSTD(3)),
    TraceId             String                                  CODEC(ZSTD(1)),
    SpanId              String                                  CODEC(ZSTD(1)),
    ResourceAttributes  Map(LowCardinality(String), String)     CODEC(ZSTD(3)),
    LogAttributes       Map(LowCardinality(String), String)     CODEC(ZSTD(3)),
    ContainerName       LowCardinality(String),
    ContainerImage      LowCardinality(String),
    ContainerId         String                                  CODEC(ZSTD(1)),
    HostName            LowCardinality(String),
    Environment         LowCardinality(String)                  DEFAULT 'production',
    _ttl_date           Date                                    DEFAULT toDate(Timestamp)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(Timestamp)
ORDER BY (ServiceName, SeverityText, Timestamp)
TTL _ttl_date + INTERVAL 30 DAY
SETTINGS index_granularity = 8192;

-- 2.5 Indexes
ALTER TABLE observability.otel_logs_local
    ADD INDEX idx_severity   SeverityText    TYPE set(10)                    GRANULARITY 4,
    ADD INDEX idx_container  ContainerName   TYPE set(100)                   GRANULARITY 4,
    ADD INDEX idx_body       Body            TYPE tokenbf_v1(32768, 3, 0)    GRANULARITY 4;

-- 2.6 Materialized View
CREATE MATERIALIZED VIEW observability.otel_logs_mv
TO observability.otel_logs_local
AS SELECT
    Timestamp,
    ServiceName,
    SeverityText,
    SeverityNumber,
    Body,
    TraceId,
    SpanId,
    ResourceAttributes,
    LogAttributes,
    ResourceAttributes['container.name']                 AS ContainerName,
    ResourceAttributes['container.image.name']           AS ContainerImage,
    ResourceAttributes['container.id']                   AS ContainerId,
    ResourceAttributes['host.name']                      AS HostName,
    coalesce(ResourceAttributes['deployment.environment'], 'production') AS Environment,
    toDate(Timestamp)                                    AS _ttl_date
FROM observability.otel_logs_ingress;

-- 2.7 Query guardrails (prevents runaway queries)
CREATE SETTINGS PROFILE IF NOT EXISTS viewer_profile
    SETTINGS max_execution_time = 30,
             max_memory_usage = 2000000000,
             max_rows_to_read = 500000000,
             readonly = 1;

-- 2.8 Assign profile to ClickHouse user
-- ⚠️ REQUIRED: check actual username in .env (CLICKHOUSE_USER=...) and replace below
-- before running migration. Leaving this commented prevents silent migration failure.
-- ALTER USER <CLICKHOUSE_USER from .env> SETTINGS PROFILE 'viewer_profile';
```

Senior note: `TraceId` and `SpanId` columns stay even though we're not adding tracing now. Zero cost when empty (compressed to near-zero bytes), and leaves room for future instrumentation without a schema migration.

---

# Phase 3 — OTel Collector Configs

Create `otel/` directory in project root.

### `otel/agent-config.yaml`
```yaml
receivers:
  filelog:
    # Docker names container dirs by 64-char container ID, not name —
    # glob on name won't match. Self-exclude is done at processor level (see below).
    include: ["/var/lib/docker/containers/*/*.log"]
    include_file_path: true
    operators:
      - type: json_parser
        timestamp:
          parse_from: attributes.time
          layout: '%Y-%m-%dT%H:%M:%S.%LZ'
      - type: move
        from: attributes.log
        to: body
      - type: move
        from: attributes.stream
        to: attributes["log.iostream"]
      - type: severity_parser
        parse_from: attributes.level
        preset: default
        if: 'attributes.level != nil'

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 256
    spike_limit_mib: 64

  resourcedetection:
    detectors: [docker, env]
    docker:
      use_hostname_if_present: true

  # Drop DEBUG logs to save storage (senior: use filter, not probabilistic_sampler —
  # probabilistic_sampler is trace-only; logs need explicit filtering)
  # ⚠️ INCIDENT: to temporarily see DEBUG logs, remove filter/drop_debug from
  # the pipeline processors list below + docker compose restart otel-agent
  # (no config file change needed — just edit the service: pipelines: logs: processors: list)
  filter/drop_debug:
    logs:
      exclude:
        match_type: strict
        severity_texts: ["DEBUG"]

  # Self-exclude: prevent feedback loop. Must run AFTER resourcedetection
  # so container.name attribute is populated.
  filter/exclude_self:
    logs:
      exclude:
        match_type: strict
        resource_attributes:
          - key: container.name
            value: otel-agent

  batch:
    send_batch_size: 8192
    timeout: 3s

exporters:
  otlp:
    endpoint: otel-gateway:4317
    tls:
      insecure: true
    compression: zstd

service:
  pipelines:
    logs:
      receivers: [filelog]
      processors: [memory_limiter, resourcedetection, filter/exclude_self, filter/drop_debug, batch]
      exporters: [otlp]
  telemetry:
    logs:
      level: warn
```

### `otel/gateway-config.yaml`
```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 512
    spike_limit_mib: 128

  filter:
    logs:
      exclude:
        match_type: regexp
        bodies: ['^\s*$']    # drop whitespace-only bodies

  transform:
    log_statements:
      - context: log
        statements:
          - set(severity_text, "INFO") where severity_text == ""

  batch:
    send_batch_size: 50000
    timeout: 5s

exporters:
  clickhouse:
    endpoint: tcp://clickhouse:9000
    database: observability
    logs_table_name: otel_logs_ingress
    compress: zstd
    async_insert: true
    retry_on_failure:
      enabled: true
      initial_interval: 5s
      max_interval: 30s
      max_elapsed_time: 300s
    # Senior addition — sending queue with persistent storage survives restart
    sending_queue:
      enabled: true
      num_consumers: 4
      queue_size: 10000

service:
  pipelines:
    logs:
      receivers: [otlp]
      processors: [memory_limiter, filter, transform, batch]
      exporters: [clickhouse]
  telemetry:
    metrics:
      # Exposes OTel Gateway's own metrics to Prometheus (meta-monitoring)
      address: 0.0.0.0:8888
    logs:
      level: warn
```

Senior note: `telemetry.metrics.address: 0.0.0.0:8888` exposes the Gateway's own Prometheus metrics. Add this as a scrape target so you can alert on the observability stack itself (queue depth, dropped logs, exporter errors). Meta-monitoring is a senior signal.

---

# Phase 4 — Vector Sink

Change only the sink in `vector/vector.toml`. Source and transforms stay identical.

```toml
# Delete [sinks.redis_vm_log_dashboard] entirely
# Add:
[sinks.otel_gateway]
type = "opentelemetry"
inputs = ["filter_noise"]
endpoint = "http://otel-gateway:4317"
protocol = "grpc"

  [sinks.otel_gateway.resource]
  "service.name" = "nginx"
  "deployment.environment" = "production"
  "log.type" = "nginx_access"
```

---

# Phase 5 — docker-compose.yml

### 5.1 Remove
- `filebeat` service + `filebeat.yml`
- `log-ingester` service + `ingester/` directory

Keep `redis` (still used for cache + rate-limit).

### 5.2 Add
```yaml
  otel-agent:
    image: ${REGISTRY_IMAGE_PATH}/otel-collector-contrib:0.100.0
    container_name: otel-agent
    restart: unless-stopped
    read_only: true                          # Senior hardening
    user: "10001:10001"                      # Non-root
    networks: [pipeline_network]
    tmpfs:
      - /tmp                                 # OTel needs /tmp at runtime
    volumes:
      - ./otel/agent-config.yaml:/etc/otel/config.yaml:ro
      - /var/lib/docker/containers:/var/lib/docker/containers:ro
      - otel_agent_checkpoint:/var/lib/otelcol  # filelog checkpoint dir — survives restart
    command: ["--config=/etc/otel/config.yaml"]
    environment:
      - HOSTNAME=${HOSTNAME}
      - ENVIRONMENT=production
    depends_on:
      otel-gateway:
        condition: service_started
    logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }

  otel-gateway:
    image: ${REGISTRY_IMAGE_PATH}/otel-collector-contrib:0.100.0
    container_name: otel-gateway
    restart: unless-stopped
    read_only: true
    user: "10001:10001"
    networks: [pipeline_network]
    volumes:
      - ./otel/gateway-config.yaml:/etc/otel/config.yaml:ro
    command: ["--config=/etc/otel/config.yaml"]
    depends_on:
      clickhouse:
        condition: service_healthy
    # No external port — only Vector + OTel Agent (internal network) talk to it
    logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }

  alertmanager:
    image: ${REGISTRY_IMAGE_PATH}/alertmanager:v0.27.0
    container_name: alertmanager
    restart: unless-stopped
    networks: [pipeline_network]
    volumes:
      - ./alertmanager/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro
      - alertmanager_data:/alertmanager
    command:
      - '--config.file=/etc/alertmanager/alertmanager.yml'
      - '--storage.path=/alertmanager'
    logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }

volumes:
  alertmanager_data:
  otel_agent_checkpoint:    # filelog receiver checkpoint — persists read position across restarts
```

Senior note: `otel-gateway` has **no ports section** — it only accepts traffic from inside `pipeline_network`. Zero external attack surface.

---

# Phase 6 — FastAPI Column Migration

### Column mapping
| Old | New |
|---|---|
| `container_logs` / `nginx_logs` | `observability.otel_logs_local` |
| `container_name` | `ContainerName` |
| `container_id` | `ContainerId` |
| `level` | `SeverityText` |
| `message` | `Body` |
| `timestamp` | `Timestamp` |
| `image_name` | `ContainerImage` |
| `host` | `HostName` |

### Query pattern (parameterized, always)
```python
QUERY_LOGS = """
SELECT Timestamp, ServiceName, SeverityText, Body,
       ContainerName, ContainerId, HostName
FROM observability.otel_logs_local
WHERE Timestamp BETWEEN {start:DateTime64} AND {end:DateTime64}
  AND SeverityText IN {levels:Array(String)}
  AND ContainerName IN {containers:Array(String)}
ORDER BY Timestamp DESC
LIMIT {limit:UInt32}
SETTINGS use_skip_indexes_on_data_read = 1
"""
```

### Must update
- All container log query endpoints (table + columns)
- `/api/logs/stream` SSE endpoint (filter by `ServiceName != 'nginx'`)
- `/api/nginx/stream` SSE endpoint (filter by `ServiceName = 'nginx'`)
- All 6 `/api/admin/nginx-logs/*` endpoints (add `ServiceName = 'nginx'` filter)
- Container ownership filter: use `ContainerName` OR `ContainerId` (whichever is stable — prefer `ContainerName` for human readability)

---

# Phase 7 — Verify OTel Pipeline

```bash
# On dev: rebuild images, push to registry
make build push TAG=$(git rev-parse --short HEAD)

# On server: pull + bring up clickhouse first for migration
docker compose pull
docker compose up -d clickhouse
docker compose exec clickhouse clickhouse-client --multiquery < migration.sql

docker compose exec clickhouse clickhouse-client \
  --query "SHOW TABLES IN observability"
# Expect: otel_logs_ingress, otel_logs_local, otel_logs_mv

docker compose up -d
docker compose logs -f otel-agent otel-gateway   # no errors

sleep 30
docker compose exec clickhouse clickhouse-client \
  --query "SELECT ServiceName, count() FROM observability.otel_logs_local
           GROUP BY ServiceName ORDER BY count() DESC"

# ── REQUIRED: verify nginx field layout BEFORE implementing Phase 6 nginx endpoints ──
# Vector may place HTTP fields in Body, LogAttributes, or both — depends on sink config.
# Inspect one row to confirm where each field lives:
docker compose exec clickhouse clickhouse-client \
  --query "SELECT Body, LogAttributes, ResourceAttributes
           FROM observability.otel_logs_local
           WHERE ServiceName = 'nginx' LIMIT 1 FORMAT Vertical"

# Expected: one of these layouts — pick query pattern based on what you see
#   A) fields in LogAttributes:   LogAttributes['status'], LogAttributes['path'], ...
#   B) fields in Body (JSON):     JSONExtractString(Body, 'status'), ...
#   C) top-level columns:         (unlikely — Vector OTLP sink flattens to LogAttributes by default)
# Only implement Phase 6 nginx endpoints AFTER this verification.
```

---

# Phase 8 — Grafana: Logs + Metrics Unified View

Senior move: you already have Grafana. Don't build another dashboard. Make Grafana the single pane of glass.

### 8.1 Install ClickHouse datasource plugin
Pin version — plugin has had breaking changes between major versions.
```yaml
grafana:
  environment:
    # Pin to 4.x — latest stable with stable query builder API
    - GF_INSTALL_PLUGINS=grafana-clickhouse-datasource 4.5.1
```

### 8.2 Add datasource (Grafana UI or provisioning file)
`grafana/provisioning/datasources/clickhouse.yaml`:
```yaml
apiVersion: 1
datasources:
  - name: ClickHouse-Logs
    type: grafana-clickhouse-datasource
    access: proxy
    url: clickhouse:9000
    jsonData:
      defaultDatabase: observability
      protocol: native
      username: loguser
    secureJsonData:
      password: ${CLICKHOUSE_PASSWORD}
```

### 8.3 Build unified dashboard panel
In the existing container metrics dashboard (which shows cAdvisor CPU/mem by container), add a logs panel below:
```sql
SELECT Timestamp, SeverityText, Body
FROM observability.otel_logs_local
WHERE ContainerName = '$container'       -- Grafana variable from cAdvisor panel
  AND $__timeFilter(Timestamp)
ORDER BY Timestamp DESC
LIMIT 500
```

Click a CPU spike at 14:32 → logs panel filters to that container at that time. **This is what "log-to-metric correlation" actually means in practice** — no distributed tracing needed.

---

# Phase 9 — Prometheus Alerts Explained + Wired Into Dashboard

### Concept: What is a Prometheus alert?

Prometheus continuously scrapes metrics from all services every 15s. An **alert rule** is a PromQL expression evaluated on that data. When the expression returns any result for longer than `for:` duration, the alert **fires**.

```yaml
# Example rule in prometheus-alerts.yml
groups:
  - name: container_health
    rules:
      - alert: ContainerHighCPU
        expr: rate(container_cpu_usage_seconds_total[5m]) > 0.8
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Container {{ $labels.name }} CPU > 80% for 5 min"
```

Translation: "if CPU rate over last 5 min > 80%, and it stays that way for 5 min, fire an alert tagged `warning` with that message."

### Where alerts go

Prometheus doesn't send alerts anywhere by itself — it forwards fired alerts to **Alertmanager**. Alertmanager handles:
- **Deduplication** (same alert from multiple nodes → one notification)
- **Grouping** (many alerts from same cause → one digest)
- **Routing** (warning → Slack, critical → PagerDuty, etc.)
- **Silencing** (pause alerts during maintenance)

### 9.1 Add Alertmanager to docker-compose
(Done in Phase 5.2 above.)

### 9.2 Point Prometheus to Alertmanager
`prometheus.yml`:
```yaml
alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']
```

### 9.3 Configure Alertmanager webhook → FastAPI
`alertmanager/alertmanager.yml`:
```yaml
route:
  receiver: logstore-webhook
  group_by: ['alertname', 'container']
  group_wait: 10s
  group_interval: 30s
  repeat_interval: 4h

receivers:
  - name: logstore-webhook
    webhook_configs:
      - url: http://backend:8000/logstore/api/alerts/webhook
        send_resolved: true
```

### 9.4 FastAPI receives alerts, writes to notifications

Add endpoint in `backend/main.py`:
```python
@app.post("/api/alerts/webhook")
async def alertmanager_webhook(payload: dict):
    # Alertmanager sends batches in standard format:
    # { "alerts": [{ "status": "firing", "labels": {...}, "annotations": {...} }] }
    for alert in payload.get("alerts", []):
        severity = alert["labels"].get("severity", "info")
        summary = alert["annotations"].get("summary", alert["labels"].get("alertname"))
        status = alert["status"]  # "firing" or "resolved"
        notif_type = "error" if severity == "critical" else "warning" if severity == "warning" else "info"

        await insert_notification({
            "type": notif_type,
            "source": "prometheus",
            "message": f"[{status.upper()}] {summary}",
            "metadata": alert["labels"]
        })
    return {"ok": True}
```

Key insight: you already have notifications infrastructure (PostgreSQL table + SSE stream + bell icon). Alertmanager just becomes another source that writes into it. Alerts now surface in the same place users already look.

### 9.5 Example useful alerts for this stack

`prometheus-alerts.yml`:
```yaml
groups:
  - name: observability_self
    rules:
      # OTel Gateway is dropping logs (meta-monitoring)
      - alert: OtelGatewayExporterFailure
        expr: rate(otelcol_exporter_send_failed_log_records_total[5m]) > 0
        for: 2m
        labels: { severity: critical }
        annotations:
          summary: "OTel Gateway exporter dropping logs"

      # ClickHouse part count too high (async_insert queue backup)
      - alert: ClickHousePartsExplosion
        expr: ClickHouseAsyncMetrics_MaxPartCountForPartition > 300
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: "ClickHouse parts not merging fast enough"

      # A container stopped producing logs for 10 min
      - alert: ContainerLogsStopped
        expr: rate(otelcol_receiver_accepted_log_records_total[10m]) == 0
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: "No logs received from OTel pipeline for 10 min"
```

Senior note: the last alert is self-monitoring — your observability stack tells you when it's blind.

---

# Phase 10 — CI/CD: Local Build → Registry → Server Pull

Formalize the existing `deploy-registry.ps1` flow.

### 10.1 Versioning strategy

Tag images with **git short SHA** — gives you immutable reproducibility plus fast rollback.
```
registry.psu.ac.th/project/backend:a1b2c3d
registry.psu.ac.th/project/backend:latest    (also pushed, for convenience)
```

### 10.2 Makefile (cross-platform alternative to .ps1)

`Makefile`:
```makefile
REGISTRY ?= ${REGISTRY_IMAGE_PATH}
TAG      ?= $(shell git rev-parse --short HEAD)
SERVICES := backend dashboard backup

.PHONY: build push deploy rollback

build:
	@for svc in $(SERVICES); do \
		docker build -t $(REGISTRY)/$$svc:$(TAG) -t $(REGISTRY)/$$svc:latest ./$$svc || exit 1; \
	done

push: build
	@for svc in $(SERVICES); do \
		docker push $(REGISTRY)/$$svc:$(TAG); \
		docker push $(REGISTRY)/$$svc:latest; \
	done

deploy:
	@echo "Run on server: docker compose pull && docker compose up -d"

# Roll back to a specific SHA
rollback:
	@test -n "$(TAG)" || (echo "Usage: make rollback TAG=<sha>" && exit 1)
	@echo "On server: TAG=$(TAG) docker compose up -d"
```

Keep `deploy-registry.ps1` for Windows; `Makefile` works from WSL / CI.

### 10.3 docker-compose.yml — pin tags

```yaml
services:
  backend:
    image: ${REGISTRY_IMAGE_PATH}/backend:${TAG:-latest}
  dashboard:
    image: ${REGISTRY_IMAGE_PATH}/dashboard:${TAG:-latest}
  otel-agent:
    image: ${REGISTRY_IMAGE_PATH}/otel-collector-contrib:0.100.0
```

Senior note: pin third-party images to exact versions (`0.100.0`), never `latest`. Third-party `latest` changing under you is how production breaks at 3am.

### 10.4 Server-side deploy script

`deploy.sh` on server:
```bash
#!/bin/bash
set -euo pipefail
TAG="${1:-latest}"
cd /opt/logdashboard

# Capture currently-running tag BEFORE pulling new images (for rollback)
PREVIOUS_TAG=$(docker inspect --format='{{index .Config.Image}}' \
  $(docker compose ps -q backend) 2>/dev/null | cut -d: -f2 || echo "latest")
echo "Current running tag: $PREVIOUS_TAG"

echo "Pulling tag: $TAG"
TAG=$TAG docker compose pull backend dashboard

echo "Rolling backend + dashboard..."
TAG=$TAG docker compose up -d --no-deps backend dashboard

echo "Health check..."
for i in {1..30}; do
    if curl -fsS http://localhost/logstore/api/auth/me >/dev/null 2>&1; then
        echo "Deploy OK — tag $TAG live"
        exit 0
    fi
    sleep 2
done

echo "FAIL — rolling back to $PREVIOUS_TAG"
TAG=$PREVIOUS_TAG docker compose up -d --no-deps backend dashboard
exit 1
```

Usage: `./deploy.sh a1b2c3d` — pulls that SHA tag, rolls, health-checks, auto-reverts to previous tag on fail.

### 10.5 Workflow

```
Local:              On server:
git commit          ./deploy.sh a1b2c3d
make push TAG=…     (pulls that tag, rolls, health-checks, auto-rollback)
```

Senior note: zero CI runners needed. Atomic rollback by re-running `deploy.sh` with previous SHA. Immutable tags = reproducible builds.

---

# Phase 11 — Production Hardening Checklist

These are small, high-impact changes scattered throughout the stack. Do during cleanup after Phase 7.

### Security
- [ ] All Dockerfiles — `USER 10001:10001` (non-root)
- [ ] OTel Agent/Gateway containers — `read_only: true` + tmpfs for `/tmp`
- [ ] Pin third-party images to exact tags (no `latest`)
- [ ] `.env` file chmod 600 on server
- [ ] Traefik — `tls.options.default.minVersion: VersionTLS12`
- [ ] Add `no-new-privileges: true` security_opt to all services

### Resilience
- [ ] FastAPI `/health` endpoint actually probes CH + PG + Redis, returns 503 if any down
- [ ] FastAPI graceful shutdown — drain SSE connections, flush in-flight writes
- [ ] ClickHouse healthcheck uses `clickhouse-client --query "SELECT 1"` (current is OK, verify)
- [ ] Add `restart_policy: unless-stopped` everywhere (mostly done, audit)

### Observability of observability (meta-monitoring)
- [ ] OTel Gateway `telemetry.metrics` exposed to Prometheus
- [ ] Prometheus scrapes `otel-gateway:8888` for exporter queue depth, drops
- [ ] Alertmanager alerts when OTel pipeline dies (Phase 9.5)

### Data
- [ ] ClickHouse TTL verified (Phase 2.4)
- [ ] PostgreSQL `pg_dump` in backup.sh verified
- [ ] Backup verification: monthly `pg_restore --list | head` sanity-check on a backup file

### Deployment
- [ ] Image tags pinned to SHA in `docker-compose.yml`
- [ ] Server `deploy.sh` with health check + auto-rollback
- [ ] README includes architecture diagram + deploy workflow (when ready, per user "later")

---

# Run Order Summary

```
Phase 1  — Edit FastAPI (delete nginx ingester task) + backup.sh          [no restart needed]
Phase 2  — Write migration.sql                                            [no restart needed]
Phase 3  — Write otel/agent-config.yaml + gateway-config.yaml             [files only]
Phase 4  — Edit vector/vector.toml sink                                   [files only]
Phase 5  — Edit docker-compose.yml (remove filebeat/ingester, add otel)   [files only]
Phase 6  — Edit FastAPI queries + SSE endpoints for new schema            [no restart needed]
Phase 7  — Deploy: clickhouse first, run migration, bring up full stack   [EXECUTES]
Phase 8  — Install Grafana ClickHouse plugin + unified dashboard          [Grafana only]
Phase 9  — Add Alertmanager + FastAPI webhook endpoint + alert rules      [partial restart]
Phase 10 — Makefile + deploy.sh + pinned image tags                       [files only]
Phase 11 — Hardening checklist                                            [scattered]
Phase 12 — Surrounding context feature                                    [FastAPI + UI]
Phase 13 — Log-to-log correlation via TraceId                             [FastAPI instrument + UI]
Phase 14 — Log pattern clustering tab                                     [FastAPI + UI]
```

---

# Phase 12 — Surrounding Context

> Dependency: Phase 7 done (new schema live). No other dependency.

Single endpoint — given a log's timestamp + container, return logs ±30s around it.

```python
@app.get("/api/logs/context")
async def logs_context(
    container: str,
    ts: str,           # ISO timestamp of the anchor log
    window_sec: int = 30,
    user=Depends(require_auth)
):
    rows = await ch.query("""
        SELECT Timestamp, SeverityText, Body
        FROM observability.otel_logs_local
        WHERE ContainerName = {container:String}
          AND Timestamp BETWEEN {ts:DateTime64} - INTERVAL {window:UInt32} SECOND
                            AND {ts:DateTime64} + INTERVAL {window:UInt32} SECOND
        ORDER BY Timestamp ASC
        SETTINGS use_skip_indexes_on_data_read = 1
    """, {"container": container, "ts": ts, "window": window_sec})
    return rows
```

UI: add "Context" button on each log row in dashboard table. Click → modal shows ±30s window, anchor row highlighted.

---

# Phase 13 — Log-to-Log Correlation via TraceId

> Dependency: Phase 7 done + FastAPI OTel instrumentation below.

### 13.1 Instrument FastAPI (~20 lines)

```python
# backend/main.py — add at startup
from opentelemetry import trace
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

_provider = TracerProvider()
_provider.add_span_processor(
    BatchSpanProcessor(
        OTLPSpanExporter(endpoint="http://otel-gateway:4317", insecure=True)
    )
)
trace.set_tracer_provider(_provider)
FastAPIInstrumentor.instrument_app(app)
```

Every FastAPI request now auto-generates a TraceId. OTel SDK injects it into log context — any `logging.info(...)` call inside that request will carry the same TraceId into `otel_logs_local`.

Add to `backend/requirements.txt`:
```
opentelemetry-sdk
opentelemetry-instrumentation-fastapi
opentelemetry-exporter-otlp-proto-grpc
```

### 13.2 Correlation endpoint

```python
@app.get("/api/logs/trace/{trace_id}")
async def logs_by_trace(trace_id: str, user=Depends(require_auth)):
    rows = await ch.query("""
        SELECT Timestamp, ServiceName, SeverityText, Body, ContainerName
        FROM observability.otel_logs_local
        WHERE TraceId = {trace_id:String}
        ORDER BY Timestamp ASC
        LIMIT 500
    """, {"trace_id": trace_id})
    return rows
```

UI: if a log row has non-empty `TraceId`, show clickable badge → opens modal with all logs sharing that TraceId across all containers. This is cross-container log correlation with zero extra infrastructure.

---

# Phase 14 — Log Pattern Clustering

> Dependency: Phase 7 done. No other dependency.

### 14.1 Backend endpoint

```python
@app.get("/api/logs/patterns")
async def log_patterns(
    minutes: int = 60,
    container: str = None,
    user=Depends(require_auth)
):
    container_filter = "AND ContainerName = {container:String}" if container else ""
    rows = await ch.query(f"""
        SELECT
            replaceRegexpAll(Body, '[0-9a-f-]{{8,}}|\\\\d+', '?') AS pattern,
            count()                                                  AS frequency,
            min(Timestamp)                                           AS first_seen,
            max(Timestamp)                                           AS last_seen,
            any(SeverityText)                                        AS severity
        FROM observability.otel_logs_local
        WHERE Timestamp > now() - INTERVAL {{minutes:UInt32}} MINUTE
          AND SeverityText != 'DEBUG'
          {container_filter}
        GROUP BY pattern
        ORDER BY frequency DESC
        LIMIT 50
    """, {"minutes": minutes, "container": container or ""})
    return rows
```

### 14.2 UI

Add "Patterns" tab (or section inside Logs view). Table columns: Pattern | Count | Severity | First Seen | Last Seen. Click pattern → filters main log table to `Body LIKE` that pattern.

Not as smart as HyperDX's drain algorithm but catches 80% of recurring error patterns. Zero extra infrastructure.

---

# Why This Is Senior-Level

| Pattern | Junior Approach | Senior Approach (this plan) |
|---|---|---|
| Log pipeline | Write custom ingester | Use OTel standard; schema-decoupled via Null Engine |
| Alerts | Build custom alert UI | Wire Alertmanager into existing notification bell |
| CI/CD | GitHub Actions from day 1 | Formalize existing flow (Makefile + pinned SHA tags + server health-check rollback) |
| Metrics/logs correlation | Add distributed tracing | Grafana dashboard variable on `ContainerName` unifies existing metrics + new logs |
| Meta-monitoring | Monitor only apps | Monitor the observability stack itself (OTel Gateway drops, CH parts) |
| Security | "Add TLS later" | Non-root, read_only, no-new-privileges, no exposed ports for internal services |
| Deployment safety | `docker compose up -d` | Tagged rollback target, health-check validation, automatic revert on fail |

The key senior trait demonstrated: **do less, correctly**. Every choice reuses existing infrastructure (Grafana, Prometheus, notification bell, registry) rather than adding new moving parts.
