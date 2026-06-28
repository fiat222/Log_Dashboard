# ADR-0003: Use ClickHouse for Log Storage

## Status

Accepted

## Context

The existing system already uses ClickHouse for centralized logs and has shown good ingestion performance. Logs are the core value of the project, so the storage backend must support high-volume writes and analytical queries.

## Decision

Use ClickHouse as the primary storage engine for logs and log-like events.

ClickHouse stores:

- Docker/container logs.
- Application logs.
- Gateway/access logs.
- Operational events where analytical querying is useful.

## Consequences

Benefits:

- Strong write throughput.
- Good analytical query performance.
- Fits log search and aggregation use cases.
- Preserves the project’s existing stable foundation.

Trade-offs:

- Requires schema and query discipline.
- Role-based filtering must be enforced carefully by the backend.
- Not ideal as the source of truth for mutable platform metadata.

## Notes

ClickHouse should not store long-lived platform configuration such as users, roles, dashboard preferences, or service ownership. PostgreSQL should own those records.

