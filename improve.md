# Stack Improvement Plan — Target: 10/10 All Areas

Current scores → target:
| Area | Now | Target |
|------|-----|--------|
| Security | 6/10 | 10/10 |
| Reliability | 7/10 | 10/10 |
| Performance | 6/10 | 10/10 |
| Observability | 8/10 | 10/10 |
| Correctness | 7/10 | 10/10 |

---

## SECURITY (6 → 10)

### SEC-1 — Docker Socket Proxy (replaces raw socket mount on backend)

**Problem:** `backend` mounts `/var/run/docker.sock` directly. Socket = root on host.

**Fix:** Add `tecnativa/docker-socket-proxy` — restricts to Events + Containers read-only API.

```yaml
# docker-compose.yml — new service
docker-proxy:
  image: ${REGISTRY_IMAGE_PATH}/docker-socket-proxy:latest
  container_name: docker-proxy
  restart: unless-stopped
  networks: [pipeline_network]
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock:ro
  environment:
    EVENTS: "1"
    CONTAINERS: "1"
    IMAGES: "0"
    NETWORKS: "0"
    VOLUMES: "0"
    POST: "0"
  security_opt:
    - no-new-privileges:true
  logging: *default-logging

# backend service — remove socket mount, add proxy env
backend:
  # REMOVE: - /var/run/docker.sock:/var/run/docker.sock:ro
  environment:
    DOCKER_HOST: "tcp://docker-proxy:2375"
  depends_on:
    docker-proxy:
      condition: service_started
```

---

### SEC-2 — Drop vector-containers Root User

**Problem:** `user: root` on vector-containers is unnecessary.

**Fix:** Add `docker` group GID (typically 999) so Vector can read the socket without root.

```yaml
vector-containers:
  user: "0:999"   # uid=root-equivalent needed for /proc, gid=docker for socket
  # Better long-term: use group_add instead
  group_add:
    - "999"   # docker group GID — verify with: getent group docker | cut -d: -f3
  user: "10001"
```

If host docker GID differs, set via env:
```yaml
  user: "${VECTOR_UID:-10001}:${DOCKER_GID:-999}"
```

---

### SEC-3 — Restrict OTel OTLP Ports

**Problem:** Ports 4317/4318 open to all — any LAN host can push fake logs.

**Fix:** Bind to loopback or Traefik-internal IP only. Let Traefik terminate and forward.

```yaml
otel-gateway:
  ports:
    - "127.0.0.1:8888:8888"   # Prometheus metrics — localhost only
    # Remove 4317/4318 public binds — route through Traefik or internal network only
```

Add IP allowlist in Traefik middleware for OTLP endpoints if external VMs need to push.

---

### SEC-4 — Network Segmentation (3-tier)

**Problem:** All services share one flat `pipeline_network`. DB compromised = everything accessible.

**Fix:** Split into 3 networks.

```yaml
networks:
  frontend_network:    # Traefik ↔ Nginx ↔ Backend
    driver: bridge
    ipam:
      config: [{subnet: "10.0.1.0/24"}]
  app_network:         # Backend ↔ Redis ↔ PostgreSQL
    driver: bridge
    ipam:
      config: [{subnet: "10.0.2.0/24"}]
  pipeline_network:    # OTel Gateway ↔ ClickHouse ↔ Vector
    driver: bridge
    ipam:
      config: [{subnet: "10.0.3.0/24"}]

# Service network assignments:
# postgres:     [app_network]
# redis:        [app_network]
# clickhouse:   [pipeline_network, app_network]  # backend needs CH too
# otel-gateway: [pipeline_network]
# vector-*:     [pipeline_network]
# backend:      [frontend_network, app_network]
# log-dashboard:[frontend_network]
# docker-proxy: [app_network]
```

---

### SEC-5 — Secrets via Docker Secrets (not env_file)

**Problem:** `.env` file on disk, readable by any process with host access.

**Fix:** Use Docker secrets for passwords.

```yaml
secrets:
  postgres_password:
    file: ./secrets/postgres_password.txt
  redis_password:
    file: ./secrets/redis_password.txt
  clickhouse_password:
    file: ./secrets/clickhouse_password.txt

redis:
  secrets: [redis_password]
  command: >
    redis-server --requirepass $(cat /run/secrets/redis_password) ...
```

Minimum: ensure `.env` has `chmod 600` and is in `.gitignore`.

---

## RELIABILITY (7 → 10)

### REL-1 — Resource Limits on All Services

**Problem:** No limits = ClickHouse query spike OOMs the host → everything dies.

```yaml
# Add to each service under docker-compose.yml:

clickhouse:
  deploy:
    resources:
      limits:
        memory: 4g
        cpus: "2.0"
      reservations:
        memory: 1g

otel-gateway:
  deploy:
    resources:
      limits:
        memory: 1200m
        cpus: "1.0"
      reservations:
        memory: 256m

backend:
  deploy:
    resources:
      limits:
        memory: 512m
        cpus: "1.0"
      reservations:
        memory: 128m

redis:
  deploy:
    resources:
      limits:
        memory: 192m    # headroom above 128mb maxmemory setting
        cpus: "0.5"

vector-containers:
  deploy:
    resources:
      limits:
        memory: 256m
        cpus: "0.5"

log-dashboard:
  deploy:
    resources:
      limits:
        memory: 64m
        cpus: "0.25"

postgres:
  deploy:
    resources:
      limits:
        memory: 512m
        cpus: "0.5"
```

---

### REL-2 — OTel Gateway Healthcheck + Fix Vector Dependency

**Problem:** `vector-containers` starts when gateway is "started" not "healthy" → drops logs on cold boot.

```yaml
otel-gateway:
  healthcheck:
    test: ["CMD", "wget", "-q", "--spider", "http://localhost:8888/metrics"]
    interval: 10s
    timeout: 5s
    retries: 5
    start_period: 15s

vector-containers:
  depends_on:
    otel-gateway:
      condition: service_healthy   # was: service_started
```

---

### REL-3 — Backend Restart Policy + Graceful Shutdown

```yaml
backend:
  restart: unless-stopped
  stop_grace_period: 30s    # allow in-flight requests to complete
```

Add to uvicorn:
```dockerfile
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000",
     "--proxy-headers", "--workers", "4",
     "--timeout-graceful-shutdown", "30"]
```

---

### REL-4 — ClickHouse Healthcheck with Auth

**Problem:** `clickhouse-client --query "SELECT 1"` fails silently if auth required.

```yaml
clickhouse:
  healthcheck:
    test: ["CMD", "clickhouse-client",
           "--user", "${CLICKHOUSE_USER}",
           "--password", "${CLICKHOUSE_PASSWORD}",
           "--query", "SELECT 1"]
    interval: 15s
    timeout: 10s
    retries: 5
    start_period: 30s
```

---

### REL-5 — Redis Persistence Tuning

**Problem:** AOF `everysec` + RDB `save 60 1000` both active = dual fsync on same disk as ClickHouse.

For session/cache-only use: disable RDB, keep AOF only.

```yaml
redis:
  command: >
    redis-server
    --appendonly yes
    --appendfsync everysec
    --no-appendfsync-on-rewrite yes
    --save ""
    --maxmemory 128mb
    --maxmemory-policy allkeys-lru
    --loglevel warning
    --requirepass ${REDIS_PASSWORD}
```

`--save ""` disables RDB. `--no-appendfsync-on-rewrite yes` skips fsync during AOF rewrite to reduce I/O stalls.

---

## PERFORMANCE (6 → 10)

### PERF-1 — Uvicorn Multi-Worker (CRITICAL)

**Problem:** 1 process handles all concurrent requests. Single bottleneck.

```dockerfile
# backend/Dockerfile
CMD ["uvicorn", "main:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--proxy-headers", \
     "--workers", "4", \
     "--timeout-keep-alive", "30"]
```

For CPU-bound workloads, match workers to CPU cores. For I/O-bound (DB queries): 2–4× cores.

Alternative — Gunicorn + Uvicorn workers (better worker lifecycle management):
```dockerfile
CMD ["gunicorn", "main:app", \
     "-w", "4", \
     "-k", "uvicorn.workers.UvicornWorker", \
     "--bind", "0.0.0.0:8000", \
     "--timeout", "60", \
     "--graceful-timeout", "30", \
     "--proxy-protocol"]
```

---

### PERF-2 — Switch Log Driver to `local`

**Problem:** `json-file` driver = raw JSON on disk, higher I/O than necessary.

```yaml
x-logging: &default-logging
  driver: "local"
  options:
    max-size: "10m"
    max-file: "3"
```

`local` driver uses protobuf + gzip internally. Same `docker logs` API. ~30% less disk I/O.

---

### PERF-3 — ClickHouse Query Isolation (reads vs writes)

**Problem:** Ingestion writes and dashboard reads compete on same ClickHouse instance.

**Fix A (config):** Set per-query resource limits in ClickHouse `users.xml`:
```xml
<profiles>
  <dashboard>
    <max_memory_usage>2000000000</max_memory_usage>  <!-- 2GB cap per query -->
    <max_threads>4</max_threads>
    <max_execution_time>30</max_execution_time>
  </dashboard>
  <ingest>
    <max_memory_usage>1000000000</max_memory_usage>
    <max_threads>2</max_threads>
    <async_insert>1</async_insert>
  </ingest>
</profiles>
```

**Fix B (long-term):** Separate ClickHouse instance for reads (replica) — overkill for current scale but the right architecture when log volume grows.

---

### PERF-4 — OTel Gateway Batch Tuning

Current: `send_batch_size: 8192, timeout: 200ms`

At high ingest rate, 200ms introduces latency spikes. Tune based on actual throughput:

```yaml
batch:
  send_batch_size: 4096      # smaller = more frequent flushes, lower latency
  send_batch_max_size: 8192  # cap to prevent oversized batches
  timeout: 500ms             # longer timeout = better batching at low rate
```

Monitor `otelcol_processor_batch_batch_size_trigger_send` metric at `:8888` to tune.

---

### PERF-5 — Nginx Static Asset Caching

```nginx
# dashboard/nginx.conf
location ~* \.(js|css|png|ico|woff2)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
    gzip_static on;
}

location /health {
    access_log off;
    return 200 "ok";
}
```

Cuts repeat JS/CSS loads from ~200ms to ~0ms (browser cache).

---

## OBSERVABILITY (8 → 10)

### OBS-1 — Remove Dead Traces Pipeline

**Problem:** Traces pipeline collects, processes, and discards to `debug` exporter. Wasted CPU.

```yaml
# otel/gateway-config.yaml — DELETE:
processors:
  # batch/traces: REMOVE

service:
  pipelines:
    # traces: REMOVE entire block
```

---

### OBS-2 — Structured Logging in Backend

**Problem:** Default uvicorn logs are unstructured text — hard to parse in ClickHouse.

```python
# backend/main.py — add structured logging
import logging
import json

class JSONFormatter(logging.Formatter):
    def format(self, record):
        return json.dumps({
            "timestamp": self.formatTime(record),
            "level": record.levelname,
            "message": record.getMessage(),
            "module": record.module,
        })
```

Or use `python-json-logger` package. OTel Agent then ingests structured JSON → queryable fields in ClickHouse.

---

### OBS-3 — Health Endpoint Expose More Data

```python
# backend/main.py
@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "clickhouse": await check_clickhouse(),
        "postgres": await check_postgres(),
        "redis": await check_redis(),
        "version": os.getenv("TAG", "unknown"),
    }
```

Enables external monitors (UptimeRobot, Prometheus blackbox) to distinguish DB failures from app failures.

---

### OBS-4 — Add Prometheus Scrape Labels to Services

```yaml
# docker-compose.yml — add labels for Prometheus service discovery
backend:
  labels:
    prometheus.scrape: "true"
    prometheus.port: "8000"
    prometheus.path: "/metrics"

otel-gateway:
  labels:
    prometheus.scrape: "true"
    prometheus.port: "8888"
    prometheus.path: "/metrics"
```

Prometheus on separate VM auto-discovers via Docker label SD (`docker_sd_configs`).

---

### OBS-5 — Log Backup Service Output

```yaml
# backup service — currently no logging anchor applied
backup:
  logging: *default-logging   # was custom duplicate, use anchor
```

---

## CORRECTNESS (7 → 10)

### COR-1 — Remove Phantom ClickHouse Dependency from Dashboard

```yaml
# log-dashboard — clickhouse dep is meaningless, Nginx can't query ClickHouse
log-dashboard:
  depends_on:
    backend:
      condition: service_healthy   # only real dependency
  # REMOVE: - clickhouse
```

---

### COR-2 — Fix Backend Healthcheck Flag Typo

```yaml
# Current (broken flag):
test: ["CMD", "wget", "--no-verbose", "--tries=1", "--q", "http://localhost:8000/api/health"]
#                                                    ^^^
#                                              should be "-q" not "--q"

# Fixed:
test: ["CMD", "wget", "--no-verbose", "--tries=1", "-q", "http://localhost:8000/api/health"]
```

---

### COR-3 — Consolidate Duplicate Backup Mounts

```yaml
# Current — same host path mounted twice:
backup:
  volumes:
    - /mnt/Logstore_backup:/backups
    - /mnt/Logstore_backup:/clickhouse_user_files/backups   # redundant

# Fix — keep both if backup script uses both paths, otherwise consolidate:
# Option A: remove duplicate if only one path used in backup scripts
# Option B: keep both but document why two mount points needed
```

Verify which path `backup` scripts actually reference before removing.

---

### COR-4 — Pin All Image Tags

**Problem:** `${TAG:-latest}` fallback to `latest` — non-deterministic deploys.

```yaml
# Never use :latest in production
backend:
  image: ${REGISTRY_IMAGE_PATH}/backend:${TAG}   # remove :-latest fallback
  # Force TAG to be set explicitly — fail fast if missing

log-dashboard:
  image: ${REGISTRY_IMAGE_PATH}/dashboard:${TAG}

backup:
  image: ${REGISTRY_IMAGE_PATH}/backup:${TAG}
```

Add to `.env.example`:
```bash
TAG=v1.0.0   # required — never leave empty
```

---

## Implementation Order

| Phase | Items | Effort | Impact |
|-------|-------|--------|--------|
| **1 — Quick wins** | PERF-1, COR-2, COR-1, OBS-1, COR-4 | 1h | High |
| **2 — Reliability** | REL-1, REL-2, REL-3, REL-4, REL-5 | 2h | High |
| **3 — Security** | SEC-1, SEC-2, SEC-3, SEC-5 | 3h | Critical |
| **4 — Performance** | PERF-2, PERF-3, PERF-4, PERF-5 | 2h | Medium |
| **5 — Observability** | OBS-2, OBS-3, OBS-4, OBS-5 | 2h | Medium |
| **6 — Architecture** | SEC-4, COR-3 | 3h | Low-Medium |

**Start Phase 1 today — PERF-1 alone fixes the biggest production risk.**
