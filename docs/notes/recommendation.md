# Recommendation Triage for Current Project

This note preserves the old improvement roadmap, but current project constraints change what is worth building now.

## Current Project Fit

Worth using now:
- Keep one coherent query path: OTel Gateway -> ClickHouse -> backend -> dashboard.
- Build Phase 6 around host metrics, container metrics, gateway health, database health, and backup status.
- Store demo evidence in docs/evidence after each visible slice.
- Keep Jenkins as CI evidence only: tests, compose checks, security checks.

Change before implementation:
- Avoid any core dependency on an external Prometheus/Grafana/Alertmanager VM. Phase 6 should work from the local compose stack first.
- Prefer ClickHouse-backed health and metrics views over proxying a second frontend query model.
- Use Docker Compose services for demo dependencies where practical.

Not worth now:
- Rust backend rewrite before backend modularization. High risk and low demo value.
- Full GeoIP, SIEM, tracing, and advanced alerting before basic metrics/health are visible.
- Jenkins deploy/build pipeline with Docker socket. Keep Docker host access out of CI v1.

Recommended next Phase 6 slice:
1. Add a visible health/metrics module that can run from the local compose stack.
2. Show gateway/database/service health in the Platform UI.
3. Link unhealthy signals back to logs where possible.
4. Capture screenshot plus command evidence.

---
# Centralized Monitor Dashboard — Improvement Roadmap

## What Currently Exists

### Data Pipeline
| Component | Role | Status |
|-----------|------|--------|
| OTel Gateway | Receives OTLP/HTTP (:4318) + gRPC (:4317) from agents | ✅ Running |
| Vector (containers) | Collects Docker logs from host → OTel Gateway | ✅ Running |
| ClickHouse | Main log storage (`observability.otel_logs_local`, `logs.nginx_logs`) | ✅ Running |
| Redis | Session cache, rate limiting | ✅ Running |

### Backend & Auth
| Component | Role | Status |
|-----------|------|--------|
| FastAPI backend | Auth, role-based ClickHouse proxy, SSE notifications | ✅ Running |
| PostgreSQL | User/role storage | ✅ Running |
| Docker socket proxy | Read-only Events + Containers API (no POST) | ✅ Running |

### Dashboard (SPA)
| Tab | Content | Status |
|-----|---------|--------|
| Logs | Container logs via OTel pipeline | ✅ Done |
| Nginx | Nginx access logs (client_ip, method, path, status, response_time) | ✅ Done |
| Analytics | Aggregated log analytics | ✅ Done |
| Patterns | Log pattern detection | ✅ Done |
| Admin | User/role management | ✅ Done |

### Backup
| Component | Detail | Status |
|-----------|--------|--------|
| Backup service | Cron-based ClickHouse `BACKUP DATABASE` → `/mnt/Logstore_backup` | ✅ Running |
| Trigger API | HTTP POST `/trigger` on :8080 → runs backup.sh manually | ✅ Running |
| Compression | tar.gz after ClickHouse writes raw backup dir | ✅ Running |
| **Monitoring panel** | Backup job status, last success/fail, history in dashboard | ❌ Missing |

### External (Separate VM — Not in compose)
- Prometheus, Grafana, Alertmanager, cAdvisor running on separate VM
- OTel Gateway exposes Prometheus metrics at :8888

---

## Architecture Principles

**Unified query pattern** — all data flows through OTel Gateway → ClickHouse → backend → frontend. No second query path (e.g. Prometheus API proxy) — it splits frontend data handling, adds an external VM as dashboard dependency, and breaks correlation across systems.

**Backend write access** — current backend is read-only against ClickHouse. Phase 2–3 features (`alerts.events`, `security.events`, `metrics.health_checks`) require write access. Grant a separate write-capable CH user scoped to those databases only. Do not reuse the read user.

**Metrics TTL** — logs and metrics have different retention needs. Set short TTL on metrics tables (metrics churn fast, logs need longer audit trail):
```sql
-- metrics tables: 7-30 days
TTL timestamp + INTERVAL 7 DAY DELETE   -- container metrics (high cardinality)
TTL timestamp + INTERVAL 30 DAY DELETE  -- host metrics
-- log tables: keep existing retention (90d or per policy)
```

---

## Build Order

```
Resources → Infra Metrics → Network/GeoIP → Alerting → Security/SIEM → Backup Monitor → Tracing → Service Monitor
```

Each phase depends on the previous. Build left to right.

---
## Phase 0 (Extra) - Refactor FastAPI with Rust for performance optimization.
**Reason:** - now this system is require a lot of resource because of Backend query per user. need to modified it.
**backend.py** - centralized backend.py to handles everything isn't a good idae for production. need to refactor it to multi-backend system. then if need to refactor then plan seperate scripts first. before migrate to rust.
**Phase 0 (Extra)** - if done need to seperate app.py and fix Dockerfile and docker-compose.yml.

## Phase 1 — Foundation (Build First)

### Container Resources `[M]`
**What:** Per-container CPU, memory, network I/O, disk I/O metrics
**Already:** cAdvisor runs on separate VM, scraped by Prometheus
**Gap:** No resource panel in dashboard
**Architecture decision:** OTel Gateway adds `prometheusreceiver` → scrapes cAdvisor directly → writes to ClickHouse `metrics.container_metrics`. Do NOT proxy Prometheus API from backend — that makes the separate Prometheus VM a dashboard dependency and creates a second query path frontend must handle.

> **Network note:** OTel Gateway must reach cAdvisor VM on port 8080. Verify firewall rules before implementation.

```yaml
# infra/otel/gateway-config.yaml addition
receivers:
  prometheus:
    config:
      scrape_configs:
        - job_name: cadvisor
          scrape_interval: 15s
          static_configs:
            - targets: ['<cadvisor-vm-ip>:8080']
```
```sql
CREATE TABLE metrics.container_metrics (
    timestamp   DateTime64(3),
    container   LowCardinality(String),
    metric_name LowCardinality(String),
    value       Float64
) ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (container, metric_name, timestamp)
TTL timestamp + INTERVAL 7 DAY DELETE;
```
**Plan:**
- Add prometheus receiver to OTel Gateway config, target cAdvisor VM
- Create `metrics.container_metrics` table with 7-day TTL
- New "Resources" tab: CPU/memory sparklines per container, top-N by usage (same ClickHouse query pattern as Logs/Nginx)

---

### Infra Metrics `[M]`
**What:** Host-level CPU, memory, disk, load average
**Already:** OTel Gateway exposes own metrics at :8888
**Gap:** No VM-level metrics in dashboard
**Architecture decision:** Same pipeline as Resources — Node Exporter on host → OTel Gateway scrapes → ClickHouse `metrics.host_metrics`. Node Exporter runs on the same host as the compose stack, reachable via `host.docker.internal:9100`.

```yaml
# infra/otel/gateway-config.yaml — add to existing prometheus receiver scrape_configs
- job_name: node-exporter
  scrape_interval: 15s
  static_configs:
    - targets: ['host.docker.internal:9100']
```
```sql
CREATE TABLE metrics.host_metrics (
    timestamp   DateTime64(3),
    metric_name LowCardinality(String),
    value       Float64,
    labels      Map(String, String)
) ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (metric_name, timestamp)
TTL timestamp + INTERVAL 30 DAY DELETE;
```
**Plan:**
- Install Node Exporter on host as systemd service (single binary, no Docker — avoids container namespace confusion for host metrics)
- Add scrape target to OTel Gateway prometheus receiver
- Create `metrics.host_metrics` table with 30-day TTL
- "Infra" panel: host CPU/mem/disk gauges + OTel Gateway self-metrics from `:8888`

---

## Phase 2 — Core Observability

### Network / GeoIP `[S]`

> **Prerequisite:** Register at maxmind.com (free) → get license key → download `GeoLite2-City.mmdb`. Required before any pipeline work. Existing `nginx_logs` rows will NOT be retroactively enriched — GeoIP columns apply to new ingests only.

**What:** Request origin — country, city, ASN, IP reputation
**Already:** `client_ip` column exists in `logs.nginx_logs`
**Gap:** No GeoIP enrichment at ingest; no map panel; no ASN breakdown
**Plan:**
- Mount `GeoLite2-City.mmdb` into Vector container
- Add `geoip` transform in Vector pipeline (in-process MMDB lookup, microsecond latency — never call external API per log line)
- Add columns `country`, `city`, `asn` to `logs.nginx_logs` schema
- Map panel + top-N origin table in Nginx tab

```toml
[transforms.geoip]
type = "geoip"
inputs = ["nginx_logs"]
database = "/etc/vector/GeoLite2-City.mmdb"
source = "client_ip"
```

---

### Alerting `[L]`
**What:** Threshold-based + anomaly alerts with notification delivery
**Already:** SSE notification system in backend; Alertmanager on separate VM
**Gap:** No in-dashboard alert rule config; no alert history; no webhook/email trigger
**Plan:**
- Alert rules table in Admin tab (rule name, metric, condition, cooldown)
- Backend evaluates rules on schedule → triggers SSE + external webhook
- Alert history stored in ClickHouse `alerts.events`

#### Anomaly Detection vs Fixed Threshold
Fixed threshold = false alarms on deploys. Use rolling average instead:
```sql
WHERE error_count > (
  SELECT avg(error_count) * 2
  FROM metrics
  WHERE timestamp > now() - INTERVAL 1 HOUR
)
```

#### Deduplication
One crashed container → 10,000 identical errors/second → flood.
- Fingerprint = hash of `(service, error_type, rule_id)`
- Fire once → suppress for N minutes → refire only if still active
- Show "fired 8,432 times" not 8,432 notifications

---

## Phase 3 — Security & Reliability

### Security / SIEM `[L]`
**What:** Threat detection — brute force, port scan, anomaly, suspicious patterns
**Already:** All raw data in ClickHouse; `client_ip`, `status`, `path` in nginx logs; `SeverityText` in container logs
**Gap:** No correlation rules; no threat timeline; no alert chain
**Plan:**
- Define rules as ClickHouse sliding-window queries (e.g. `N 401s from same IP in 60s`)
- Backend evaluates rules on interval → writes hits to `security.events` table
- New "Security" tab: threat timeline, top attackers, rule status
- Feeds into Alerting for notification delivery

> **Performance:** Do NOT run raw `SELECT COUNT(*) FROM nginx_logs` scans per rule interval — will hammer ClickHouse on production volume. Use a pre-aggregation materialized view:
> ```sql
> CREATE MATERIALIZED VIEW security.ip_error_counts_mv
> ENGINE = SummingMergeTree
> ORDER BY (client_ip, toStartOfMinute(timestamp))
> POPULATE AS
> SELECT client_ip, toStartOfMinute(timestamp) AS minute, countIf(status >= 400) AS error_count
> FROM logs.nginx_logs
> GROUP BY client_ip, minute;
> ```
> Rules query this MV instead of raw table. Orders-of-magnitude cheaper.

#### Event Schema
Store raw evidence with every security event:
```sql
-- security.events
raw_log    String,   -- exact log line that fired the rule
rule_query String,   -- SQL rule that matched
```
Dashboard "Security" tab: click event → see raw evidence immediately.

---

### Backup Monitor `[S]`
**What:** Visibility into backup job health — last run, success/fail, duration, file size
**Already:** Backup service running with cron + HTTP trigger API; POST `/trigger` on :8080 exists; backup service already has ClickHouse access (runs `BACKUP DATABASE`)
**Gap:** No status panel; backup logs not surfaced; no failure alert
**Architecture decision:** Backup service writes run results directly to ClickHouse `ops.backup_runs` — NOT a JSON status file. JSON file is fragile (lost on container restart, not queryable, no history). ClickHouse write is one INSERT after each backup.sh execution; backup service already has the connection.

```sql
CREATE TABLE ops.backup_runs (
    timestamp  DateTime64(3),
    status     Enum8('success'=1, 'failure'=2),
    duration_s UInt32,
    size_bytes UInt64,
    error_msg  String
) ENGINE = MergeTree()
ORDER BY timestamp
TTL timestamp + INTERVAL 90 DAY DELETE;
```
**Plan:**
- Add ClickHouse INSERT to backup.sh after each run (1 row, status + duration + size)
- Backend `/api/backup/status` reads last N rows from `ops.backup_runs`
- Admin tab: backup history table, last success timestamp, file size, manual trigger button (POST `/trigger` already exists)

---

## Phase 4 — Depth (Stretch Goals)

### Distributed Tracing `[XL]`
**What:** End-to-end request traces with span breakdown
**Already:** OTel Gateway fully wired; OTLP receiver ready
**Gap:** No trace/span ingestion schema; no trace viewer
**Plan:**
- Add `observability.otel_traces_local` table in ClickHouse
- Instrument backend + services with OTel SDK
- Trace waterfall viewer in new "Traces" tab

> **Sampling strategy:** 100% sampling = ClickHouse bloat. Use tail sampling in OTel Gateway:
> ```yaml
> processors:
>   tail_sampling:
>     policies:
>       - name: errors, type: status_code, status_code: {status_codes: [ERROR]}
>       - name: slow, type: latency, latency: {threshold_ms: 500}
>       - name: probabilistic, type: probabilistic, probabilistic: {sampling_percentage: 10}
> ```
> Errors and slow spans: 100% captured. Normal traffic: 10% sampled.

---

### Service Monitor `[S]`
**What:** Uptime %, health check history, service status board
**Already:** Backend `/api/health` exists; all services have Docker healthchecks
**Gap:** No periodic health check poller; no uptime history
**Plan:**
- Backend polls each service endpoint on interval → stores results in ClickHouse
- "Status" panel: uptime % + last N checks per service

---

## Cross-Cutting Notes

### Log Redaction (Compliance)
Passwords, tokens, card numbers can appear in container logs. Add at pipeline level in Vector — never rely on app code alone:
```toml
[transforms.redact]
type = "remap"
inputs = ["source"]
source = '''
.message = replace(.message, r'(?i)(password|token|secret)=\S+', "${1}=REDACTED")
.message = replace(.message, r'\b\d{13,16}\b', "CARD-REDACTED")
'''
```

### Self-Monitoring

> **External dependency warning:** This relies on Prometheus running on a separate VM outside this compose stack. If that VM is unavailable, self-monitoring silently stops. Verify network access and document the dependency before relying on it for alerting.

- Prometheus (separate VM) scrapes `/health` endpoints of this stack
- Targets: `backend:8000/api/health`, `otel-gateway:8888/metrics`, `clickhouse:8123/ping`
- Alert via Alertmanager if scrape fails → notification before users notice

---

## Skip / Defer

| Item | Reason |
|------|--------|
| Synthetic & RUM | Requires external agent or browser instrumentation — out of scope |
| Cost & Resource Optimization | No cloud billing API; zombie resource detection needs inventory system |
| Dependency & Vulnerability Monitoring | CVE scanning is separate pipeline (Trivy/Grype) — out of scope |

---

## Effort Summary

| Feature | Size | Phase |
|---------|------|-------|
| Container Resources | M | 1 |
| Infra Metrics | M | 1 |
| Network / GeoIP | S | 2 |
| Alerting | L | 2 |
| Security / SIEM | L | 3 |
| Backup Monitor | S | 3 |
| Distributed Tracing | XL | 4 |
| Service Monitor | S | 4 |

S = 1-2 days · M = 3-5 days · L = 1-2 weeks · XL = 2+ weeks
