-- =============================================================================
-- migration_composproject.sql — Add ComposeProject materialized column
-- Run on live server once. init.sql already includes this for fresh installs.
-- =============================================================================

-- 1. Add column (DEFAULT '' for all existing rows on disk)
ALTER TABLE observability.otel_logs_local
    ADD COLUMN IF NOT EXISTS ComposeProject LowCardinality(String) DEFAULT '';

-- 2. Add skip index (applied to new/merged parts going forward)
ALTER TABLE observability.otel_logs_local
    ADD INDEX IF NOT EXISTS idx_compose_project ComposeProject TYPE set(50) GRANULARITY 4;

-- 3. Drop and recreate MV to populate ComposeProject for all new log ingestion
DROP VIEW IF EXISTS observability.otel_logs_mv;
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

-- 4. Backfill existing rows (async mutation — runs in background, may take minutes)
--    Safe to run while the system is live. New logs use the updated MV immediately.
ALTER TABLE observability.otel_logs_local
    UPDATE ComposeProject = coalesce(ResourceAttributes['container.label.com.docker.compose.project'], '')
    WHERE ComposeProject = '' SETTINGS mutations_sync = 0;

-- Monitor backfill progress:
-- SELECT mutation_id, command, parts_to_do, is_done, latest_fail_reason
-- FROM system.mutations WHERE table = 'otel_logs_local' ORDER BY create_time DESC LIMIT 5;
