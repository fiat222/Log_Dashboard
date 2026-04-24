# PSU Internship — Log Dashboard: Architecture & Analysis

## Stack Overview

| Layer | Technology |
|---|---|
| Log Collector | Filebeat 8.13 |
| Buffer/Queue | Redis 7.2 |
| Ingester | Python (clickhouse-connect) |
| Analytical Store | ClickHouse 24.3 |
| Relational Store | PostgreSQL 16 |
| Backend API | FastAPI (Python) |
| Frontend | Vanilla JS + Nginx |
| Reverse Proxy | Traefik v3 |
| Backup | Python cron + shell (pg_dump + ClickHouse native backup) |
| Deployment | Docker Compose (single node) |

---

## Architecture Flow

```
Docker containers
      │
      ▼
  Filebeat  ◄── reads /var/lib/docker/containers/*/*.log via Docker socket
      │          enriches: container name, image, labels, level normalization
      │ RPUSH
      ▼
    Redis  ──── acts as decoupled buffer (max 128 MB, LRU eviction)
      │
      │ BLPOP (batch 500, flush every 5s)
      ▼
 Log Ingester (Python)
   ├── Docker worker  → ClickHouse: container_logs table
   └── Nginx worker   → ClickHouse: nginx_logs table

  FastAPI Backend
   ├── Auth (JWT + PostgreSQL)
   ├── Query API (ClickHouse)
   ├── Admin (backup trigger, clear DB)
   ├── SSE notifications stream
   └── Nginx log ingestion endpoint

  Dashboard (Nginx static)
   └── Vanilla JS SPA → calls FastAPI → renders charts, log tables, live logs

  PostgreSQL
   └── users, roles, sessions, notifications

  Backup service
   ├── Scheduled: pg_dump + ClickHouse BACKUP TO Disk
   └── Manual trigger via /api/admin/backup/trigger
```

---

## Pros

### Architecture
- **Simple ops** — single `docker compose up`, no Kubernetes, no external services
- **Decoupled pipeline** — Redis buffer absorbs spikes; if ClickHouse is slow, logs queue in Redis instead of dropping
- **Two databases, right tool per job** — ClickHouse for analytical log queries (columnar, fast aggregation), PostgreSQL for relational data (users, sessions)
- **Batch insert design** — ingester batches 500 rows / 5s flush, matches ClickHouse's preferred insert pattern (avoids small insert performance penalty)
- **Traefik as edge router** — label-based routing, no manual Nginx config for each service

### Observability
- **Full Docker log capture** — Filebeat reads all container logs automatically via Docker socket; zero instrumentation needed per service
- **Nginx access log ingestion** — separate pipeline for HTTP traffic analysis
- **Live log streaming** — SSE endpoint for real-time tail
- **Notification system** — SSE + bell badge for in-app alerts

### Security
- **Role-based access** — super_admin / admin / viewer roles
- **No direct ClickHouse/PostgreSQL exposure** — all queries go through FastAPI backend
- **Auth-gated admin actions** — backup, clear DB require admin role

---

## Cons

### Scale
- **Single node** — no replication, no failover; if the host goes down, everything goes down
- **Redis as buffer has 128 MB cap** — under heavy load (many containers, high log rate), Redis fills up and old events get LRU-evicted = **log loss**
- **No backpressure** — Filebeat drops events if Redis is full; no dead letter queue
- **ClickHouse single instance** — no sharding, no distributed table; vertical scale only

### Pipeline
- **Filebeat is heavyweight** for this use case — Vector or Fluent Bit would use ~10x less memory for the same job
- **Level detection by keyword scan** (message.toLowerCase().indexOf("error")) — fragile; structured logs with JSON level field may get re-classified incorrectly
- **Python ingester** — reasonable for low-medium load but a Go/Rust ingester would handle higher throughput with less memory
- **No schema validation** — malformed events are silently skipped

### Observability gaps
- **No trace/span support** — logs only, no distributed tracing (no correlation IDs)
- **No metrics pipeline** — Prometheus scrapes are external; no unified metrics + logs view
- **No alerting rules engine** — Prometheus alerts exist but not integrated into the dashboard

### Ops
- **Backup stored on same host** — backup volume is a Docker volume on the same machine; host failure = data + backup both lost
- **Manual backup trigger only** — cron schedule exists in backup service but no visibility into last backup time / status in the dashboard
- **No log retention policy enforcement** — no TTL or partition drop automation; disk fills over time
- **No horizontal scale path** — moving to multi-node requires full re-architecture (ClickHouse cluster, Redis Cluster, multiple ingester replicas)

---

## Compared to LINE MAN Wongnai Observability Stack

| | This Project | LINE MAN Wongnai |
|---|---|---|
| Scale target | Dev/small team (~millions rows/day) | 60+ billion records/day |
| Deployment | Single node Docker Compose | Multi-node distributed cluster |
| Log collector | Filebeat | (enterprise-grade, likely Vector/OTel) |
| Storage | ClickHouse single instance | ClickHouse cluster, 10x compression result |
| Buffer | Redis (128 MB) | Large-scale message queue (Kafka-class) |
| Backend | FastAPI Python | Production microservices |
| Goal | Internship project / learning | Production cost optimization |

**Key difference:** This project optimizes for simplicity and learnability. Wongnai optimized for cost at scale (storage 10x reduction via ClickHouse columnar compression + schema design). The core idea — ClickHouse as analytical log store — is the same.
