-- =============================================================================
-- migration.sql — Log system overhaul: logs.* → observability.*
-- Run on server AFTER bringing up clickhouse:
--   docker compose exec clickhouse clickhouse-client --multiquery < migration.sql
-- =============================================================================

-- 2.1 Drop old schema (MVs first — they read from source tables)
DROP VIEW  IF EXISTS logs.error_counts_mv;
DROP VIEW  IF EXISTS logs.hourly_volume_mv;
DROP VIEW  IF EXISTS logs.nginx_status_mv;
DROP VIEW  IF EXISTS logs.nginx_top_paths_mv;
DROP VIEW  IF EXISTS logs.nginx_hourly_mv;
-- nginx_top_paths_mv / nginx_hourly_mv may have been created as TABLE in older runs
DROP TABLE IF EXISTS logs.nginx_top_paths_mv;
DROP TABLE IF EXISTS logs.nginx_hourly_mv;

DROP TABLE IF EXISTS logs.error_counts_mv_target;
DROP TABLE IF EXISTS logs.hourly_volume_mv_target;
DROP TABLE IF EXISTS logs.nginx_status_mv_target;
DROP TABLE IF EXISTS logs.nginx_top_paths_mv_target;
DROP TABLE IF EXISTS logs.nginx_hourly_mv_target;

DROP TABLE IF EXISTS logs.container_logs;
DROP TABLE IF EXISTS logs.nginx_logs;

-- 2.2 New database
CREATE DATABASE IF NOT EXISTS observability;

-- 2.3 Null Engine ingress — decouples OTel wire format from storage schema
CREATE TABLE observability.otel_logs_ingress
(
    Timestamp           DateTime64(9),
    TraceId             String,
    SpanId              String,
    TraceFlags          UInt32              DEFAULT 0,
    SeverityText        String,
    SeverityNumber      Int32,
    ServiceName         String,
    Body                String,
    ResourceSchemaUrl   String              DEFAULT '',
    ResourceAttributes  Map(String, String),
    ScopeSchemaUrl      String              DEFAULT '',
    ScopeName           String              DEFAULT '',
    ScopeVersion        String              DEFAULT '',
    ScopeAttributes     Map(String, String) DEFAULT map(),
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
TTL _ttl_date + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- 2.5 Skip indexes
ALTER TABLE observability.otel_logs_local
    ADD INDEX idx_severity   SeverityText    TYPE set(10)                    GRANULARITY 4,
    ADD INDEX idx_container  ContainerName   TYPE set(100)                   GRANULARITY 4,
    ADD INDEX idx_body       Body            TYPE tokenbf_v1(32768, 3, 0)    GRANULARITY 4;

-- 2.6 Materialized view: ingress (Null) → local (MergeTree)
-- Extracts container/host fields from ResourceAttributes on insert
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
    ResourceAttributes['container.name']                              AS ContainerName,
    ResourceAttributes['container.image.name']                        AS ContainerImage,
    ResourceAttributes['container.id']                               AS ContainerId,
    ResourceAttributes['host.name']                                  AS HostName,
    coalesce(ResourceAttributes['deployment.environment'], 'production') AS Environment,
    toDate(Timestamp)                                                AS _ttl_date
FROM observability.otel_logs_ingress;

-- 2.7 Query guardrails (prevents runaway dashboard queries)
CREATE SETTINGS PROFILE IF NOT EXISTS viewer_profile
    SETTINGS max_execution_time = 30,
             max_memory_usage = 2000000000,
             max_rows_to_read = 500000000,
             readonly = 1;

-- 2.8 Assign profile to ClickHouse user
-- ⚠️ REQUIRED: verify username matches CLICKHOUSE_USER in .env before uncommenting
-- Current .env value: CLICKHOUSE_USER=loguser
-- ALTER USER loguser SETTINGS PROFILE 'viewer_profile';
