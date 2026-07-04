"""ClickHouse query builders for service-level observability views."""

from __future__ import annotations


DEFAULT_LOG_TABLE = "observability.otel_logs_local"


def _quote(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "''") + "'"


def build_services_summary_query(
    *,
    table: str = DEFAULT_LOG_TABLE,
    hours: int = 24,
    host_id: str | None = None,
    container_names: list[str] | None = None,
) -> str:
    """Build a ClickHouse query that groups container instances into services.

    The current storage schema has `ComposeProject` as a physical column but not
    `ComposeService`. Until a schema migration adds a dedicated column, the
    service name is read from `ResourceAttributes`.
    """

    filters = [f"Timestamp >= now() - INTERVAL {int(hours)} HOUR"]
    if host_id:
        filters.append(f"HostName = {_quote(host_id)}")
    if container_names is not None:
        if not container_names:
            filters.append("0")
        else:
            safe_names = ", ".join(_quote(name) for name in container_names)
            filters.append(f"ContainerName IN ({safe_names})")

    where_clause = " AND ".join(filters)

    return f"""
WITH
    if(HostName != '', HostName, 'unknown-host') AS host_id,
    if(ComposeProject != '', ComposeProject, 'standalone') AS compose_project,
    if(
        ResourceAttributes['container.label.com.docker.compose.service'] != '',
        ResourceAttributes['container.label.com.docker.compose.service'],
        ContainerName
    ) AS compose_service,
    concat(host_id, '/', compose_project, '/', compose_service) AS service_key
SELECT
    service_key,
    host_id,
    compose_project,
    compose_service,
    max(Timestamp) AS last_seen,
    uniqExact(ContainerId) AS instance_count,
    uniqExactIf(ContainerId, Timestamp >= now() - INTERVAL 5 MINUTE) AS active_instance_count,
    count() AS log_count,
    countIf(lower(SeverityText) IN ('error', 'fatal')) AS error_count,
    anyLast(ContainerName) AS sample_container_name
FROM {table}
WHERE {where_clause}
GROUP BY
    service_key,
    host_id,
    compose_project,
    compose_service
ORDER BY last_seen DESC
LIMIT 500
""".strip()
