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

### 9.6 Proposed config for `eila-monitor` Prometheus server — ⚠️ NEEDS SENIOR VERIFICATION

Existing prometheus runs on `eila-monitor:/data/monitor` with `network_mode: host`, lifecycle reload enabled, scrapes node-exporter + cadvisor across many hosts (Gateway, Subsystem1-3, DB, Windows, Postgre, LMS). No alert rules wired yet.

**Open questions for senior:**
- Where should Alertmanager run? Same `eila-monitor` host, or co-located with log-dashboard backend?
- Webhook target hostname/IP for `backend:8000/api/alerts/webhook` from monitor server perspective?
- Notification channels beyond webhook (email/Slack/Teams)? PSU SMTP relay available?
- Acceptable thresholds — current draft uses 90% CPU / 90% mem / 90% disk. Too tight/loose?
- Per-host severity overrides needed (e.g. Postgre disk fills faster, LMS-DB more critical)?
- Should OTel gateway + ClickHouse metrics be scraped by this prometheus, or run separate prometheus on log-dashboard host?

**Draft additions to `conf/prometheus.yml`:**
```yaml
rule_files:
  - /conf/alerts.yml

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['127.0.0.1:9093']    # assumes alertmanager same host
```

**Draft `conf/alerts.yml`:**
```yaml
groups:
  - name: infra
    rules:
      - alert: NodeExporterDown
        expr: up{job=~"node-exporter-.*"} == 0
        for: 2m
        labels: { severity: critical }
        annotations:
          summary: "node-exporter down on {{ $labels.job }} ({{ $labels.instance }})"

      - alert: CadvisorDown
        expr: up{job=~"cadvisor-.*"} == 0
        for: 2m
        labels: { severity: critical }
        annotations:
          summary: "cadvisor down on {{ $labels.job }}"

      - alert: HostHighCPU
        expr: 100 - (avg by(instance,job) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100) > 90
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: "CPU > 90% on {{ $labels.job }}"

      - alert: HostHighMemory
        expr: (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) > 0.90
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: "Memory > 90% on {{ $labels.job }}"

      - alert: HostDiskFull
        expr: (1 - node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"} / node_filesystem_size_bytes) > 0.90
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: "Disk > 90% full on {{ $labels.instance }} ({{ $labels.mountpoint }})"

      - alert: ContainerHighMemory
        expr: container_memory_usage_bytes{name!=""} / container_spec_memory_limit_bytes{name!=""} > 0.85
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "Container {{ $labels.name }} mem > 85% limit"

      - alert: ContainerRestarting
        expr: rate(container_start_time_seconds[10m]) > 0
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "Container {{ $labels.name }} restart loop"
```

**Draft Alertmanager service (add to `eila-monitor` compose):**
```yaml
  alertmanager:
    image: prom/alertmanager:latest
    restart: always
    network_mode: host
    container_name: alertmanager
    environment:
      - TZ=Asia/Bangkok
    volumes:
      - ./conf/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro
      - ./alertmanager_data:/alertmanager
    command:
      - --config.file=/etc/alertmanager/alertmanager.yml
      - --storage.path=/alertmanager
```

**Validate + reload sequence:**
```bash
docker run --rm -v $(pwd)/conf:/conf prom/prometheus promtool check config /conf/prometheus.yml
docker run --rm -v $(pwd)/conf:/conf prom/prometheus promtool check rules /conf/alerts.yml
mkdir -p alertmanager_data && chown -R 65534:65534 alertmanager_data
docker compose up -d alertmanager
curl -X POST http://127.0.0.1:9090/-/reload
```

**Verify endpoints:**
- `http://eila-monitor:9090/rules` — rules loaded
- `http://eila-monitor:9090/alerts` — state inactive
- `http://eila-monitor:9093` — alertmanager UI

**Status:** drafted 2026-04-29. Do NOT apply until senior reviews thresholds, alertmanager placement, webhook reachability, and notification routing.

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

### 10.6 Tag discipline + promotion workflow (current)

Project does NOT use git-SHA tags. Restricted allowlist:

| Tag         | Meaning                          | How to push                                    |
|-------------|----------------------------------|------------------------------------------------|
| `otel-test` | Test/dev builds                  | `.\deploy-registry.ps1` (default)              |
| `latest`    | Stable, verified, in production  | `.\promote.ps1` (no rebuild) — preferred       |
| `latest`    | Stable via direct rebuild        | `.\deploy-registry.ps1 -Stable` — emergency only |

Anything else rejected by `deploy-registry.ps1`.

**Why:** test build never overwrites stable. Promotion = retag proven image, no rebuild risk.

**Standard flow (test → promote → deploy):**
```
# Local: build + push test image
.\deploy-registry.ps1

# Server: pull + roll + health check
./deploy.sh otel-test

# After verify on server: promote remote tag (no rebuild)
.\promote.ps1                    # otel-test → latest

# Server: pull stable
./deploy.sh latest
```

**Hotfix flow (skip otel-test):**
```
.\deploy-registry.ps1 -Stable    # builds + pushes :latest direct
./deploy.sh latest                # on server
```

**Files involved:**
- `deploy-registry.ps1` — restricted builder (tag `otel-test` default, `-Stable` for `latest`, single-tag push, no auto `:latest`)
- `promote.ps1` — pull `:otel-test` → tag `:latest` → push. Custom services only (third-party pinned to versions in `docker-compose.yml`)
- `deploy.sh` — server-side pull/roll/health-check/auto-rollback (unchanged)
- `docker-compose.yml` — custom services use `${TAG:-latest}`; third-party pinned to exact versions

**Senior note:** `:latest` floats by design (it's the "current stable" pointer). Rollback by deploying the previous `otel-test` image SHA, OR keep one `:prev` retag step in `promote.ps1` before overwriting. Add later if rollback frequency justifies it.

---

# Phase 11 — Production Hardening Checklist

These are small, high-impact changes scattered throughout the stack. Do during cleanup after Phase 7.

### Security
- [x] All Dockerfiles — `USER 10001:10001` (non-root)  *(backend, dashboard via nginx-unprivileged, backup — done 2026-04-29)*
- [x] OTel Agent/Gateway containers — `read_only: true` + tmpfs for `/tmp`  *(compose:121-125, 145-149)*
- [x] Pin third-party images to exact tags (no `latest`)  *(compose all third-party pinned)*
- [ ] `.env` file chmod 600 on server  *(server-side manual step, not in repo)*
- [ ] Traefik — `tls.options.default.minVersion: VersionTLS12`  *(SKIP — TLS cert not yet provisioned)*
- [x] Add `no-new-privileges: true` security_opt to all services  *(all 9 services — done 2026-04-29)*

### Resilience
- [x] FastAPI `/health` endpoint actually probes CH + PG + Redis, returns 503 if any down  *(main.py:2065 — done 2026-04-29)*
- [ ] FastAPI graceful shutdown — drain SSE connections, flush in-flight writes  *(SKIP — low value, hard to test, lifespan already shuts scheduler+redis)*
- [x] ClickHouse healthcheck uses `clickhouse-client --query "SELECT 1"`  *(compose:109)*
- [x] Add `restart_policy: unless-stopped` everywhere  *(all services audited)*

### Observability of observability (meta-monitoring)
- [x] OTel Gateway `telemetry.metrics` exposed to Prometheus  *(gateway-config.yaml:60-64, port 8888)*
- [x] Prometheus scrapes `otel-gateway:8888` for exporter queue depth, drops  *(eila-monitor server config — user added)*
- [ ] Alertmanager alerts when OTel pipeline dies  *(Phase 9.6 drafted, awaits senior verification)*

### Data
- [x] ClickHouse TTL verified  *(init.sql:52, 30 day TTL on otel_logs_local)*
- [x] PostgreSQL `pg_dump` in backup.sh verified  *(backup.sh:14)*
- [ ] Backup verification: monthly `pg_restore --list | head` sanity-check on a backup file  *(process — add to ops runbook later)*

### Deployment
- [ ] Image tags pinned to SHA in `docker-compose.yml`  *(SUPERSEDED by Phase 10.6 — using restricted tag scheme `otel-test`/`latest`/`stable` instead of SHA)*
- [x] Server `deploy.sh` with health check + auto-rollback  *(Phase 10 done)*
- [ ] README includes architecture diagram + deploy workflow  *(per user "later")*

**Phase 11 status (2026-04-29):**
- 14 of 19 items done or intentionally skipped
- Remaining: `.env` chmod (server task), TLS (no cert), SSE drain (skipped low-value), Alertmanager alerts (Phase 9.6 senior pending), backup verify runbook, README — all deferred or owned by other phases

**Backup container changes (couples with Phase 15 spec):**
- Cron removed from `backup/Dockerfile` + `start.sh`. Schedule now lives in backend APScheduler (Phase 15). Container is HTTP-triggered worker only.
- `USER 10001:10001` enforced — works because cron eliminated.

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

# Phase 12 — Surrounding Context ✅ DONE 2026-04-29

> Dependency: Phase 7 done (new schema live). No other dependency.

Single endpoint — given a log's timestamp + container, return logs ±30s around it.

**Backend (`backend/main.py` after `/api/export`, ~50 lines):**
```python
@app.get("/api/logs/context")
async def logs_context(
    container: str = Query(..., min_length=1, max_length=200),
    ts: str = Query(..., min_length=1, max_length=64),
    window_sec: int = Query(default=30, ge=1, le=300),
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Validate ts (ISO 8601), enforce developer ownership, query CH ±window_sec.
    # Returns {anchor_ts, container, window_sec, rows: [[ts, cname, level, body], ...]}
```

Returns `JSONCompact` rows shaped same as main table (4 cols: Timestamp, ContainerName, SeverityText, Body) for easy reuse.

Auth: `get_current_user` (cookie). Developer role restricted to owned containers (consistent with `/api/export`).

**Frontend (`dashboard/app.js` + `index.html` + `style.css`):**
- New 5th column `Context` with `<button class="btn-ctx" data-ts data-cname>±30s</button>` per row
- `openContextModal(container, ts, windowSec)` opens overlay with sticky header + scrollable body
- Window toggles ±30/60/120s via buttons in modal header
- **Anchor row highlighted** (`.row-anchor` blue-tinted background + 3px left border + bold) — selected as row with smallest `|ts - anchor_ts|` after fetch
- Modal auto-scrolls anchor into center
- Severity badges + row-error/row-warn classes reused from main table

**Acceptance verified:**
- `/api/logs/context?container=X&ts=...&window_sec=30` returns rows + anchor metadata
- Click "±30s" button → modal opens, anchor highlighted, scrolls into view
- Window toggle re-queries and re-highlights
- Empty result shows "No surrounding logs in window."
- Developer without ownership → 403
- Bad ISO ts → 400

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

---

# Phase 15 — 5-Day Backup + Auto-Clear with Lock

> Dependency: Phase 7 done. Existing backup container + `auto_backup_and_purge` scheduler + `/api/admin/backup/trigger` + `/api/admin/purge` endpoints.

Replace daily backup-only schedule with: every 5 days run backup → on success TRUNCATE `otel_logs_local` → release lock. Manual trigger same flow. Clear button disabled while lock held, button text shows the reason.

### 15.1 Decisions

| # | Decision |
|---|----------|
| Schedule | Every 5 days at 03:00 (`cron: hour=3, minute=0, day="*/5"`) |
| Clear scope | `TRUNCATE TABLE observability.otel_logs_local` (full wipe; backup proven success first) |
| UI | Two buttons: "Backup Now" + "Clear Database". Clear button text changes to show lock reason ("Backup in progress — wait", "Clearing...", or default "Clear Database") |
| Lock storage | Postgres `backup_runs` table (durable, audit trail) + Redis key for fast UI poll |
| Failure handling | If backup fails → clear skipped, lock released, notification fired with reason |
| Existing `/api/admin/purge` | Keep for partial purges (per-container, per-date). New flow uses dedicated `/api/admin/clear-all` endpoint |

### 15.2 Schema

```sql
-- Postgres: durable backup state
CREATE TABLE IF NOT EXISTS backup_runs (
    id           SERIAL PRIMARY KEY,
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ,
    status       TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
    triggered_by TEXT NOT NULL,            -- 'schedule' or user id
    backup_file  TEXT,                      -- pg + ch backup paths
    cleared_rows BIGINT,                    -- rows wiped after backup
    error_message TEXT,
    notes        TEXT
);
CREATE INDEX idx_backup_runs_started ON backup_runs(started_at DESC);
```

Redis cache key (TTL 1 hour, refreshed by job):
```
backup:state = {"running": true|false, "since": <iso>, "run_id": <pg id>}
```

### 15.3 Backend changes (`backend/main.py`)

**Replace `auto_backup_and_purge` scheduler call:**
```python
# OLD: scheduler.add_job(auto_backup_and_purge, "cron", hour=3, minute=0, ...)
scheduler.add_job(
    auto_backup_and_clear,
    "cron",
    hour=3, minute=0, day="*/5",
    id="auto_backup_clear"
)
```

**New `auto_backup_and_clear` (replaces `auto_backup_and_purge`):**
```python
async def auto_backup_and_clear(triggered_by: str = "schedule"):
    run_id = await _start_backup_run(triggered_by)        # INSERT row, set Redis lock
    try:
        ok = await _run_backup_script()                    # docker exec backup ...
        if not ok:
            await _finish_backup_run(run_id, "failed", error="backup script failed")
            await _notify_backup_fail()
            return
        rows_cleared = await _truncate_clickhouse()        # TRUNCATE otel_logs_local
        await _finish_backup_run(run_id, "success", cleared_rows=rows_cleared)
        await _notify_backup_success(rows_cleared)
    except Exception as e:
        await _finish_backup_run(run_id, "failed", error=str(e))
        log.exception("auto_backup_and_clear")
    finally:
        await _release_lock()                              # delete Redis key
```

**Lock helpers:**
```python
async def _start_backup_run(triggered_by: str) -> int:
    # Acquire lock atomically — fail if already held
    acquired = await redis_client.set("backup:state", "running", nx=True, ex=3600)
    if not acquired:
        raise HTTPException(409, "Backup already in progress")
    async with AsyncSessionLocal() as db:
        row = await db.execute(
            text("INSERT INTO backup_runs (status, triggered_by) VALUES ('running', :by) RETURNING id"),
            {"by": triggered_by}
        )
        run_id = row.scalar()
        await db.commit()
    await redis_client.set("backup:state", json.dumps({"running": True, "run_id": run_id, "since": datetime.utcnow().isoformat()}), ex=3600)
    return run_id

async def _release_lock():
    await redis_client.delete("backup:state")

async def _truncate_clickhouse() -> int:
    # Count first for audit, then truncate
    n = await ch.query_scalar("SELECT count() FROM observability.otel_logs_local")
    await ch.execute("TRUNCATE TABLE observability.otel_logs_local")
    return n
```

**Modified manual trigger:**
```python
@app.post("/api/admin/backup/trigger")
async def trigger_backup(user=Depends(require_role("super_admin", "admin"))):
    asyncio.create_task(auto_backup_and_clear(triggered_by=user.id))
    return {"status": "started"}
```

**New status endpoint (UI poll):**
```python
@app.get("/api/admin/backup/status")
async def backup_status(user=Depends(require_role("super_admin", "admin"))):
    state = await redis_client.get("backup:state")
    if not state:
        async with AsyncSessionLocal() as db:
            row = await db.execute(text(
                "SELECT id, started_at, finished_at, status, cleared_rows "
                "FROM backup_runs ORDER BY started_at DESC LIMIT 1"
            ))
            last = row.mappings().first()
        return {"running": False, "last_run": dict(last) if last else None}
    return {"running": True, **json.loads(state)}
```

**New clear-all (gated by lock):**
```python
@app.post("/api/admin/clear-all", dependencies=[Depends(require_role("super_admin"))])
async def clear_all_logs():
    if await redis_client.get("backup:state"):
        raise HTTPException(409, "Backup running — clear locked until backup finishes")
    # Force a fresh backup before destructive clear
    raise HTTPException(400, "Use /api/admin/backup/trigger — clear runs automatically after backup")
```

Note: standalone clear without backup intentionally not allowed. Clear always chained after backup.

### 15.4 Frontend changes (`dashboard/app.js`)

**Poll loop after backup click:**
```js
async function triggerBackup() {
  const btn = document.getElementById('btn-backup');
  const clearBtn = document.getElementById('btn-clear');
  btn.disabled = true; btn.textContent = 'Starting…';

  await fetch('/api/admin/backup/trigger', { method: 'POST' });

  // Poll every 3s
  const poll = setInterval(async () => {
    const r = await fetch('/api/admin/backup/status').then(x => x.json());
    if (r.running) {
      btn.textContent = `Backup running… (${elapsed(r.since)})`;
      clearBtn.disabled = true;
      clearBtn.textContent = 'Backup in progress — wait';
    } else {
      clearInterval(poll);
      btn.disabled = false; btn.textContent = 'Backup Now';
      clearBtn.disabled = false;
      clearBtn.textContent = r.last_run?.status === 'success'
        ? `Cleared ${r.last_run.cleared_rows.toLocaleString()} rows`
        : 'Clear Database';
      showToast(r.last_run);
    }
  }, 3000);
}
```

**On page load — check existing lock:**
```js
async function refreshBackupState() {
  const r = await fetch('/api/admin/backup/status').then(x => x.json());
  const clearBtn = document.getElementById('btn-clear');
  if (r.running) {
    clearBtn.disabled = true;
    clearBtn.textContent = 'Backup in progress — wait';
  } else {
    clearBtn.disabled = false;
    clearBtn.textContent = 'Clear Database';
  }
}
```

### 15.5 Migration notes

- Drop daily 03:00 schedule; replace with 5-day.
- Existing `auto_backup_and_purge` left in place for one release as `_legacy_auto_backup_and_purge` to be removed Phase 15.1.
- `backup_runs` table: add via Alembic or one-off SQL on deploy.
- Redis key prefix `backup:` reserved.

### 15.6 Acceptance

- [ ] Schedule fires every 5 days at 03:00
- [ ] Successful backup → CH row count drops to 0 → notification "Backup + Cleared N rows"
- [ ] Failed backup → CH untouched → notification with error message
- [ ] Manual trigger from UI shows live status; clear button reflects state via text
- [ ] Concurrent backup attempt returns HTTP 409
- [ ] Lock auto-expires after 1h Redis TTL (safety against orphaned lock if process killed)
- [ ] `backup_runs` history viewable via `GET /api/admin/backup/history` (optional, can skip)

### 15.7 Senior note

`TRUNCATE` is destructive. Backup verification is the single line of defense. Two safeguards:
1. Backup script returns non-zero on any failure path (`set -e` in `backup.sh`).
2. `_run_backup_script` checks both exit code AND that backup file exists + has size > 0.

If senior wants extra safety: run `pg_restore --list | head` on the new dump file before TRUNCATE — fail-safe verification before destructive op.

---

# Phase 16 — Nginx Tab Drill-Down (Trace from Chart + IP)

> Dependency: Phase 7 done, existing `/api/admin/nginx-logs/*` endpoints (overview, traffic, top-paths, top-ips, logs).

Purpose: turn the nginx analytics tab from "summary screen" into "investigation tool". Click anywhere on a chart point or IP → see the underlying log rows that produced it, in a modal.

### 16.1 Interactions

**A. Click on traffic chart point** (`nginx-chart-traffic`, line chart, 2xx/4xx/5xx by minute):
- Chart's `onClick` resolves to a minute label + dataset (status bucket).
- Open modal showing nginx logs from `[minute, minute+60s)`. If specific dataset clicked (e.g. 5xx legend point), pre-filter by `status>=500`.
- Window expandable to ±2min, ±5min via toggle in modal.

**B. Click on IP row** in `nginx-top-ips-list`:
- Opens modal showing all nginx logs for that `remote_addr` over current `nginxAnalyticsHours` window.
- Sorted by Timestamp DESC by default; toggle ASC.
- Shows mini-summary at top: total requests, error rate, top 3 paths, first/last seen.

### 16.2 Backend (no changes needed)

Reuse existing `/api/admin/nginx-logs/logs` (`backend/main.py:2035`) — already supports:
- `from_time` / `to_time` (ISO) — for minute-window slicing
- `remote_addr` — for IP filter
- `status` — for dataset pre-filter
- pagination (`page`, `page_size`)

Single optional add (recommended): `/api/admin/nginx-logs/ip-summary?remote_addr=X&hours=H` returning `{total, errors, error_rate, first_seen, last_seen, top_paths: [{path, count}]}`. Saves 4 round-trips for the IP modal header.

### 16.3 Frontend (`dashboard/app.js`)

**Chart click handler (extends `loadNginxTraffic`):**
```js
nginxChartTraffic = new Chart(el("nginx-chart-traffic"), {
  ...
  options: {
    onClick: (evt, elements) => {
      if (!elements.length) return;
      const idx = elements[0].index;
      const datasetIdx = elements[0].datasetIndex;
      const minuteKey = keys[idx];
      const statusBucket = ["2xx", "4xx", "5xx"][datasetIdx];
      openNginxTraceModal({ mode: "time", minute: minuteKey, statusBucket });
    },
    onHover: (evt, elements) => { evt.native.target.style.cursor = elements.length ? "pointer" : "default"; },
    ...
  }
});
```

**IP row click (extends `loadNginxTopIPs`):**
```js
// In rendered row HTML, wrap entire row in clickable element
container.innerHTML = rows.map(r => `
  <div class="nginx-ip-row" data-ip="${escHtml(r.remote_addr)}" style="cursor:pointer;">
    ...existing markup...
  </div>
`).join("");
container.querySelectorAll(".nginx-ip-row").forEach(div => {
  div.addEventListener("click", () => {
    openNginxTraceModal({ mode: "ip", remote_addr: div.dataset.ip });
  });
});
```

**Unified modal `openNginxTraceModal({mode, ...})`:**
- Mode `"time"`: header shows minute + status bucket; body fetches `/api/admin/nginx-logs/logs?from_time=...&to_time=...&status=...&page=1&page_size=200`
- Mode `"ip"`: header shows IP + summary stats; body fetches `/api/admin/nginx-logs/logs?remote_addr=X&hours=H&page=1&page_size=200`
- Body table columns: Timestamp, Method, Path, Status, Bytes, Time, IP (drop IP column when mode=ip — redundant)
- Pagination buttons (reuse main nginx pagination pattern)
- "Open in main table" button = applies the filter and closes modal (deep-link by setting nginx tab filter state)

**HTML changes:** none — modal injected dynamically like Phase 12 context modal.

**CSS:** reuse `.modal-overlay`/`.modal` + new `.nginx-ip-row:hover { background: rgba(59,130,246,0.05); }`.

### 16.4 Recommendations — ALL ACCEPTED 2026-04-29

| # | Status | Recommendation | Rationale |
|---|--------|----------------|-----------|
| R1 | ✅ accepted | **Top Paths drill-down** (symmetric with Top IPs) | Click row → modal of logs for that path. Same modal scaffold. |
| R2 | ✅ accepted | **`/nginx-logs/ip-summary` endpoint** | Avoids 4-query waterfall in modal header. |
| R3 | ✅ accepted | **Click error-rate metric card** → modal of 4xx+5xx in window | First thing investigators want. |
| R4 | ✅ accepted | **Highlight clicked chart point** while modal open | Visual continuity via Chart.js annotation. |
| R5 | ✅ accepted | **"Apply filter to nginx tab" button** | One-click handoff to full table view. |
| R6 | ✅ accepted | **Default modal sort** = DESC for IP, ASC for time-window | Matches investigation intent per mode. |
| R7 | ✅ accepted | **Cache `nginx-top-ips` 60s** | Reduces repeat fetch on tab refocus. |
| R8 | ✅ accepted | **User-agent column in IP-mode modal** | Bot vs browser at a glance. |
| R9 | ✅ accepted | **Skip status pre-filter for 2xx clicks** | 2xx click = "show traffic", not "show only 200s". |

**Implication for backend (additions beyond 16.2):**
- New endpoint `/api/admin/nginx-logs/path-summary?path=X&hours=H` for Top Paths modal header (mirror of ip-summary)
- Existing `/logs` endpoint already supports `path_contains` for path drill-down
- Existing `/logs` endpoint already returns user_agent in `LogAttributes['user_agent']` — no change

**Implication for frontend:**
- `.nginx-ip-row`, `.nginx-path-row`, error-rate `metric-card` all clickable
- `openNginxTraceModal({mode})` modes: `"time"`, `"ip"`, `"path"`, `"errors"`
- Chart.js plugin `chartjs-plugin-annotation` (or manual rect overlay) for R4 highlight

### 16.5 Acceptance

- [ ] Click any point on traffic chart → modal with logs from that minute, pre-filtered by status bucket
- [ ] Click any IP row → modal with all logs for that IP in current window + summary stats header
- [ ] Modal pagination works
- [ ] Window toggle (±2/5 min) on time-mode modal re-queries
- [ ] "Apply to main table" button populates nginx tab filters and closes modal
- [ ] Cursor changes to pointer on hover over chart/IP row
- [ ] Empty result → "No matching nginx logs in window/for IP"
- [ ] Non-admin role → modal returns 403 (existing endpoint already gated)

### 16.6 Status

Drafted 2026-04-29. **All R1-R9 accepted.** Implementation pending — execute after Phase 12 verified on server.

### 16.7 Final scope (locked)

**Modes:** `time`, `ip`, `path`, `errors`. All four use unified `openNginxTraceModal({mode, ...})` modal.

**Backend additions:**
- `GET /api/admin/nginx-logs/ip-summary?remote_addr=X&hours=H` → `{total, errors, error_rate, first_seen, last_seen, top_paths}`
- `GET /api/admin/nginx-logs/path-summary?path=X&hours=H` → same shape, with `top_ips` instead of `top_paths`

**Frontend additions:**
- Chart click → time-mode modal (R9: 2xx = no status filter, 4xx/5xx = pre-filter)
- IP row click → ip-mode modal (with user-agent col, R8; DESC sort, R6)
- Path row click → path-mode modal
- Error-rate metric card click → errors-mode modal (status>=400 in window)
- Chart highlight while modal open (R4)
- "Apply filter to nginx tab" button (R5) — sets nginx tab filter state, closes modal
- 60s cache on `top-ips` + `top-paths` (R7)
