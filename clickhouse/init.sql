-- =============================================================================
-- clickhouse/init.sql — OTel observability schema
-- Runs automatically on first container start (docker-entrypoint-initdb.d).
-- For live server upgrades from the old logs.* schema, run migration.sql instead.
-- =============================================================================

CREATE DATABASE IF NOT EXISTS observability;

-- Null Engine ingress — decouples OTel wire format from storage schema
CREATE TABLE IF NOT EXISTS observability.otel_logs_ingress
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

-- Storage table: Delta+ZSTD codec, day partition, 90-day TTL (matches settings default)
CREATE TABLE IF NOT EXISTS observability.otel_logs_local
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
    ComposeProject      LowCardinality(String)                  DEFAULT '',
    _ttl_date           Date                                    DEFAULT toDate(Timestamp)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(Timestamp)
ORDER BY (ServiceName, SeverityText, Timestamp)
TTL _ttl_date + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- Skip indexes
ALTER TABLE observability.otel_logs_local
    ADD INDEX IF NOT EXISTS idx_severity       SeverityText    TYPE set(10)                    GRANULARITY 4,
    ADD INDEX IF NOT EXISTS idx_container      ContainerName   TYPE set(100)                   GRANULARITY 4,
    ADD INDEX IF NOT EXISTS idx_body           Body            TYPE tokenbf_v1(32768, 3, 0)    GRANULARITY 4,
    ADD INDEX IF NOT EXISTS idx_compose_project ComposeProject TYPE set(50)                    GRANULARITY 4;

-- Materialized view: ingress (Null) → local (MergeTree)
CREATE MATERIALIZED VIEW IF NOT EXISTS observability.otel_logs_mv
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
    ResourceAttributes['container.name']                                    AS ContainerName,
    ResourceAttributes['container.image.name']                              AS ContainerImage,
    ResourceAttributes['container.id']                                     AS ContainerId,
    ResourceAttributes['host.name']                                        AS HostName,
    coalesce(ResourceAttributes['deployment.environment'], 'production')   AS Environment,
    coalesce(ResourceAttributes['container.label.com.docker.compose.project'], '') AS ComposeProject,
    toDate(Timestamp)                                                      AS _ttl_date
FROM observability.otel_logs_ingress;

-- Query guardrails
CREATE SETTINGS PROFILE IF NOT EXISTS viewer_profile
    SETTINGS max_execution_time = 30,
             max_memory_usage = 2000000000,
             max_rows_to_read = 500000000,
             readonly = 1,
             session_timezone = 'Asia/Bangkok';

-- Assign query guardrails to loguser
ALTER USER IF EXISTS loguser SETTINGS PROFILE 'viewer_profile';

-- Timezone: run manually after first start if loguser exists:
-- ALTER USER loguser SETTINGS session_timezone = 'Asia/Bangkok';

-- Verify:
-- SELECT name, engine, partition_key, sorting_key, ttl FROM system.tables
-- WHERE database = 'observability';
