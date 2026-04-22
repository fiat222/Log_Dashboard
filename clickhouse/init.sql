-- =============================================================================
-- clickhouse/init.sql — Container logs schema
-- Database: logs | Table: container_logs
-- Engine: MergeTree with monthly partitioning and 90-day TTL
-- =============================================================================

CREATE DATABASE IF NOT EXISTS logs;

-- ── Docker log table ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS logs.container_logs
(
    timestamp       DateTime64(3, 'Asia/Bangkok'),
    container_id    LowCardinality(String),
    container_name  LowCardinality(String),
    image_name      LowCardinality(String),
    level           LowCardinality(String),
    stream          LowCardinality(String),
    host            LowCardinality(String),
    message         String,
    labels          String DEFAULT '{}'
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (timestamp, container_id, level)
TTL toDateTime(timestamp) + INTERVAL 90 DAY
SETTINGS
    merge_with_ttl_timeout = 86400;
-- NOTE: async_insert / wait_for_async_insert are session-level settings.
-- They cannot go in CREATE TABLE SETTINGS — use connection params in ingester:
-- http://clickhouse:8123/?async_insert=1&wait_for_async_insert=0

-- ── Materialized view: per-minute error counts ────────────────────────────────
CREATE TABLE IF NOT EXISTS logs.error_counts_mv_target
(
    minute          DateTime,
    container_id    LowCardinality(String),
    level           LowCardinality(String),
    count           UInt64
)
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(minute)
ORDER BY (minute, container_id, level)
TTL minute + INTERVAL 90 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS logs.error_counts_mv
TO logs.error_counts_mv_target
AS
SELECT
    toStartOfMinute(timestamp)  AS minute,
    container_id,
    level,
    count()                     AS count
FROM logs.container_logs
GROUP BY minute, container_id, level;

-- ── Helper: log volume per hour ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS logs.hourly_volume_mv_target
(
    hour            DateTime,
    container_id    LowCardinality(String),
    total           UInt64,
    errors          UInt64,
    warnings        UInt64
)
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (hour, container_id)
TTL hour + INTERVAL 90 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS logs.hourly_volume_mv
TO logs.hourly_volume_mv_target
AS
SELECT
    toStartOfHour(timestamp)                        AS hour,
    container_id,
    count()                                         AS total,
    countIf(level = 'error')                        AS errors,
    countIf(level = 'warn' OR level = 'warning')    AS warnings
FROM logs.container_logs
GROUP BY hour, container_id;

-- ── Nginx access log table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS logs.nginx_logs
(
    timestamp       DateTime64(3, 'Asia/Bangkok'),
    host            LowCardinality(String),
    remote_addr     String,
    method          LowCardinality(String),
    path            String,
    status          UInt16,
    bytes_sent      UInt64,
    request_time    Float32,
    user_agent      String,
    referer         String          DEFAULT '-'
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (timestamp, host, status)
TTL toDateTime(timestamp) + INTERVAL 90 DAY
SETTINGS merge_with_ttl_timeout = 86400;

-- ── Materialized view: per-minute HTTP traffic ────────────────────────────────
CREATE TABLE IF NOT EXISTS logs.nginx_status_mv_target
(
    minute      DateTime,
    status      UInt16,
    count       UInt64
)
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(minute)
ORDER BY (minute, status)
TTL minute + INTERVAL 90 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS logs.nginx_status_mv
TO logs.nginx_status_mv_target
AS
SELECT
    toStartOfMinute(timestamp)  AS minute,
    status,
    count()                     AS count
FROM logs.nginx_logs
GROUP BY minute, status;
-- ── Verify ────────────────────────────────────────────────────────────────────
-- SELECT name, engine, partition_key, sorting_key, ttl FROM system.tables
-- WHERE database = 'logs';