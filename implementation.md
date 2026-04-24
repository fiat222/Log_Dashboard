# Log System Overhaul — Implementation Plan

> **สำหรับ Claude Code:** scan project ทั้งหมดก่อน แล้ว implement ตาม phase ด้านล่างตามลำดับ
> **Strategy:** Big bang — รื้อ Filebeat + Redis + Python Ingester ออกทั้งหมด แทนด้วย OTel Collector (Agent + Gateway)

---

## Overview

### Architecture เดิม
```
Docker containers
      │
  Filebeat ──── reads /var/lib/docker/containers/*/*.log
      │ RPUSH
    Redis (128MB buffer)
      │ BLPOP
  Python Ingester ──── ClickHouse: container_logs / nginx_logs

Nginx access.log
      │
   Vector ──── FastAPI /api/nginx/ingest ──── ClickHouse: nginx_logs
```

### Architecture ใหม่
```
Docker containers
      │ stdout/stderr
  OTel Agent (filelog receiver)
      │ OTLP gRPC
  OTel Gateway (batch L2 + filter)
      │ ClickHouse exporter (async insert)
  ClickHouse: otel_logs_ingress (Null) → MV → otel_logs_local

Nginx access.log
      │
   Vector (parse + level mapping)
      │ OTLP gRPC  ← เปลี่ยนแค่ sink
  OTel Gateway ──── (pipeline เดียวกัน)

  HyperDX ──── query ──── ClickHouse   [Log + Trace UI]
```

### Services ที่เปลี่ยน

| เดิม | ใหม่ | action |
|---|---|---|
| `filebeat` | `otel-agent` | ลบ → สร้างใหม่ |
| `redis` | — | ลบออก |
| `log-ingester` (Python) | `otel-gateway` | ลบ → สร้างใหม่ |
| Vector → FastAPI endpoint | Vector → OTel Gateway | แก้ sink |
| FastAPI `/api/nginx/ingest` | — | ลบ endpoint |
| Custom JS Dashboard (logs) | `hyperdx` | เพิ่ม |
| ClickHouse: `container_logs`, `nginx_logs` | `otel_logs_local` | drop → สร้างใหม่ |

---

## Phase 1 — ลบของเก่าออก

### 1.1 docker-compose.yml
ลบ services ต่อไปนี้ออกทั้งหมด:
- `filebeat`
- `redis`
- `log-ingester` (หรือชื่ออะไรก็ตามที่เป็น Python ingester)

ลบ volumes ที่เกี่ยวข้อง:
- `redis_data` (ถ้ามี)

### 1.2 ลบไฟล์
```
filebeat.yml  (หรือ filebeat/filebeat.yml)
ingester/     (Python ingester directory ทั้งหมด)
```

### 1.3 FastAPI — ลบ Nginx ingest endpoint
ค้นหาและลบ endpoint ที่รับ Nginx logs เข้ามา (น่าจะเป็น `/api/nginx/ingest` หรือคล้ายๆ)
รวมถึง ClickHouse insert logic ที่ใช้กับ `nginx_logs` table

---

## Phase 2 — ClickHouse Schema ใหม่

> **สำคัญ:** รัน SQL ตามลำดับเป๊ะ — drop ก่อน แล้วค่อย create

### 2.1 Drop ของเก่า
```sql
-- ปรับชื่อ table ให้ตรงกับที่มีอยู่จริงใน project
DROP TABLE IF EXISTS default.container_logs;
DROP TABLE IF EXISTS default.nginx_logs;
-- drop table อื่นๆ ที่เกี่ยวกับ logs ทั้งหมด
```

### 2.2 สร้าง Database
```sql
CREATE DATABASE IF NOT EXISTS observability;
```

### 2.3 Ingress Table (Null Engine)
```sql
-- ไม่เก็บข้อมูลลง disk จริง
-- ทำหน้าที่แยก OTel wire format กับ storage schema
-- evolve storage schema ได้โดยไม่แตะ OTel exporter
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
```

### 2.4 Storage Table
```sql
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
    HostName            LowCardinality(String),
    Environment         LowCardinality(String)                  DEFAULT 'production',
    _ttl_date           Date                                    DEFAULT toDate(Timestamp)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(Timestamp)
ORDER BY (ServiceName, SeverityText, Timestamp)
TTL _ttl_date + INTERVAL 30 DAY
SETTINGS index_granularity = 8192;
```

### 2.5 Secondary Indexes
```sql
ALTER TABLE observability.otel_logs_local
    ADD INDEX idx_trace_id  TraceId         TYPE bloom_filter(0.01)         GRANULARITY 4,
    ADD INDEX idx_severity  SeverityText    TYPE set(10)                    GRANULARITY 4,
    ADD INDEX idx_body      Body            TYPE tokenbf_v1(32768, 3, 0)    GRANULARITY 4;
```

### 2.6 Materialized View (ETL real-time)
```sql
-- ทำงานอัตโนมัติทุกครั้งที่มีข้อมูลเข้า ingress table
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
    ResourceAttributes['container.name']                AS ContainerName,
    ResourceAttributes['container.image.name']          AS ContainerImage,
    ResourceAttributes['host.name']                     AS HostName,
    coalesce(
        ResourceAttributes['deployment.environment'],
        'production'
    )                                                   AS Environment,
    toDate(Timestamp)                                   AS _ttl_date
FROM observability.otel_logs_ingress;
```

### 2.7 Query Guardrails
```sql
CREATE SETTINGS PROFILE IF NOT EXISTS viewer_profile
    SETTINGS
        max_execution_time      = 30,
        max_memory_usage        = 2000000000,
        max_rows_to_read        = 500000000,
        readonly                = 1;

CREATE SETTINGS PROFILE IF NOT EXISTS admin_profile
    SETTINGS
        max_execution_time      = 120,
        max_memory_usage        = 8000000000;
```

---

## Phase 3 — OTel Collector Config Files

> สร้าง directory `otel/` ใน root ของ project

### 3.1 `otel/agent-config.yaml`
```yaml
receivers:
  filelog:
    include:
      - /var/lib/docker/containers/*/*.log
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
      - type: add
        field: resource["host.name"]
        value: EXPR(env("HOSTNAME"))
      - type: add
        field: resource["deployment.environment"]
        value: EXPR(env("ENVIRONMENT"))
      # Level normalization — แก้จุดเสียเรื่อง fragile keyword scan
      - type: severity_parser
        parse_from: attributes.level
        preset: default
        if: 'attributes.level != nil'

  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 256
    spike_limit_mib: 64

  resourcedetection:
    detectors: [docker, env]
    docker:
      use_hostname_if_present: true

  batch:
    send_batch_size: 8192     # Level 1 batching
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
      processors: [memory_limiter, resourcedetection, batch]
      exporters: [otlp]
    traces:
      receivers: [otlp]
      processors: [memory_limiter, resourcedetection, batch]
      exporters: [otlp]
```

### 3.2 `otel/gateway-config.yaml`
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
        bodies: ['^$']          # drop empty body

  transform:
    log_statements:
      - context: log
        statements:
          - set(severity_text, "INFO") where severity_text == ""

  batch:
    send_batch_size: 50000    # Level 2 batching — ใหญ่กว่า agent
    timeout: 5s

exporters:
  clickhouse:
    endpoint: tcp://clickhouse:9000
    database: observability
    logs_table_name: otel_logs_ingress
    traces_table_name: otel_traces_ingress
    compress: zstd
    async_insert: true        # Level 3 — server-side buffering
    retry_on_failure:
      enabled: true
      initial_interval: 5s
      max_interval: 30s
      max_elapsed_time: 300s

service:
  pipelines:
    logs:
      receivers: [otlp]
      processors: [memory_limiter, filter, transform, batch]
      exporters: [clickhouse]
    traces:
      receivers: [otlp]
      processors: [memory_limiter, filter, batch]
      exporters: [clickhouse]
```

---

## Phase 4 — Vector Config (Nginx Logs)

แก้แค่ **sink** — ส่วน source และ transform เก็บไว้เหมือนเดิม

```yaml
# vector.yaml — แก้เฉพาะส่วน transforms และ sinks

transforms:
  parse_nginx:
    type: remap
    inputs: [nginx_logs]      # ชื่อ source เดิมที่มีอยู่
    source: |
      . = parse_nginx_log!(.message, format: "combined")

      .service_name = "nginx"
      .log_type = "nginx_access"

      # Level mapping จาก HTTP status code
      .level = if .status >= 500 {
        "ERROR"
      } else if .status >= 400 {
        "WARN"
      } else {
        "INFO"
      }

sinks:
  # ลบ sink เดิมที่ชี้ไป FastAPI ออก แล้วแทนด้วยนี้
  otel_gateway:
    type: opentelemetry
    inputs: [parse_nginx]
    endpoint: http://otel-gateway:4317
    protocol: grpc
    logs:
      resource:
        service.name: "nginx"
        deployment.environment: "production"
        log.type: "nginx_access"
```

---

## Phase 5 — docker-compose.yml

### 5.1 เพิ่ม services ใหม่
```yaml
services:
  otel-agent:
    image: otel/opentelemetry-collector-contrib:0.100.0
    container_name: otel-agent
    volumes:
      - ./otel/agent-config.yaml:/etc/otel/config.yaml
      - /var/lib/docker/containers:/var/lib/docker/containers:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
    command: ["--config=/etc/otel/config.yaml"]
    environment:
      - HOSTNAME=${HOSTNAME}
      - ENVIRONMENT=production
    depends_on:
      - otel-gateway
    restart: unless-stopped

  otel-gateway:
    image: otel/opentelemetry-collector-contrib:0.100.0
    container_name: otel-gateway
    volumes:
      - ./otel/gateway-config.yaml:/etc/otel/config.yaml
    command: ["--config=/etc/otel/config.yaml"]
    ports:
      - "4317:4317"   # OTLP gRPC — app ส่ง traces มาที่นี่
      - "4318:4318"   # OTLP HTTP
    depends_on:
      - clickhouse
    restart: unless-stopped

  hyperdx:
    image: hyperdx/hyperdx-oss:latest
    container_name: hyperdx
    environment:
      - CLICKHOUSE_HOST=clickhouse
      - CLICKHOUSE_PORT=8123
      - CLICKHOUSE_USER=default
      - CLICKHOUSE_PASSWORD=${CLICKHOUSE_PASSWORD}
    ports:
      - "8080:8080"
    depends_on:
      - clickhouse
    restart: unless-stopped
```

### 5.2 ลบ services เหล่านี้ออก
```
filebeat
redis
log-ingester (python)
```

---

## Phase 6 — FastAPI Backend

### 6.1 Column mapping (schema เปลี่ยน)

| เดิม | ใหม่ |
|---|---|
| `container_logs` / `nginx_logs` | `observability.otel_logs_local` |
| `service` / `container_name` | `ServiceName` |
| `level` / `severity` | `SeverityText` |
| `message` / `log` | `Body` |
| `timestamp` | `Timestamp` |
| `container` | `ContainerName` |

### 6.2 Query pattern ที่ถูกต้อง
```python
# ตัวอย่าง — ปรับใช้กับทุก query ใน codebase
QUERY_LOGS = """
SELECT
    Timestamp,
    ServiceName,
    SeverityText,
    Body,
    ContainerName,
    TraceId
FROM observability.otel_logs_local
WHERE
    ServiceName = {service:String}
    AND Timestamp BETWEEN {start:DateTime64} AND {end:DateTime64}
    AND SeverityText IN {levels:Array(String)}
ORDER BY Timestamp DESC
LIMIT {limit:UInt32}
SETTINGS use_skip_indexes_on_data_read = 1
"""
# ใช้ parameterized query เสมอ — ห้าม f-string / string concat
```

### 6.3 ลบออกจาก FastAPI
- Nginx ingest endpoint ทั้งหมด
- Redis connection / import
- ClickHouse insert logic สำหรับ `nginx_logs` และ `container_logs`

---

## Phase 7 — ลำดับการ Run

```bash
# 1. หยุด services เดิม
docker compose down

# 2. รัน ClickHouse SQL migration
#    (drop เก่า → create ใหม่ → index → MV → guardrails)
docker compose up -d clickhouse
docker compose exec clickhouse clickhouse-client --multiquery < migration.sql

# 3. ตรวจสอบ table สร้างสำเร็จ
docker compose exec clickhouse clickhouse-client \
  --query "SHOW TABLES IN observability"
# ควรเห็น: otel_logs_ingress, otel_logs_local, otel_logs_mv

# 4. รัน services ทั้งหมด
docker compose up -d

# 5. ตรวจสอบ OTel pipeline ทำงาน
docker compose logs -f otel-agent otel-gateway

# 6. ตรวจสอบข้อมูลเข้า ClickHouse (รอ 1-2 นาที)
docker compose exec clickhouse clickhouse-client \
  --query "SELECT ServiceName, count() FROM observability.otel_logs_local GROUP BY ServiceName"
# ควรเห็น container names และ 'nginx' โผล่ขึ้นมา
```

---

## Checklist สำหรับ Claude Code

### Phase 1 — ลบของเก่า
```
[ ] ลบ filebeat service + config file ออกจาก docker-compose.yml
[ ] ลบ redis service ออกจาก docker-compose.yml
[ ] ลบ python ingester service + directory ทั้งหมด
[ ] ลบ FastAPI nginx ingest endpoint
[ ] ลบ Redis import/connection ใน FastAPI
```

### Phase 2 — ClickHouse
```
[ ] Drop table เก่าที่เกี่ยวกับ logs ทั้งหมด
[ ] สร้าง database observability
[ ] สร้าง otel_logs_ingress (Null Engine)
[ ] สร้าง otel_logs_local (MergeTree + TTL + Partition)
[ ] เพิ่ม secondary indexes ทั้ง 3 ตัว
[ ] สร้าง Materialized View
[ ] สร้าง Settings Profile (guardrails)
```

### Phase 3-4 — Configs
```
[ ] สร้าง otel/ directory
[ ] สร้าง otel/agent-config.yaml
[ ] สร้าง otel/gateway-config.yaml
[ ] แก้ vector.yaml — เปลี่ยน sink จาก http → opentelemetry
```

### Phase 5 — docker-compose.yml
```
[ ] เพิ่ม otel-agent service
[ ] เพิ่ม otel-gateway service
[ ] เพิ่ม hyperdx service
```

### Phase 6 — FastAPI
```
[ ] แก้ table name ทุกจุด → observability.otel_logs_local
[ ] แก้ column name ทุกจุดตาม mapping ด้านบน
[ ] ใช้ parameterized query ทุกจุด (ห้าม f-string)
```

### Phase 7 — Verify
```
[ ] docker compose logs otel-agent — ไม่มี error
[ ] docker compose logs otel-gateway — ไม่มี error
[ ] SELECT count() FROM observability.otel_logs_local — มีข้อมูล
[ ] ServiceName 'nginx' โผล่ใน result
[ ] HyperDX เปิดได้ที่ :8080 และ query log ได้
[ ] Backup service ไม่ reference table ชื่อเก่า
```

---

## หมายเหตุสำคัญ

- **Batching 3 ชั้น:** Agent (8,192) → Gateway (50,000) → ClickHouse Async Insert — ห้ามตัดชั้นใดชั้นหนึ่งออก
- **Null Engine ingress table** มีไว้เพื่อ evolve schema ในอนาคตโดยไม่แตะ OTel config
- **Vector ยังอยู่** — แค่เปลี่ยน sink ไม่ได้เปลี่ยน tool
- **PostgreSQL ยังอยู่** — users, sessions, notifications ไม่ได้แตะ
- **Backup service** ต้องตรวจสอบว่า reference table ชื่อเก่าไหม ถ้ามีต้องแก้ด้วย
