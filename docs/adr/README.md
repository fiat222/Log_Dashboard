# Architecture Decision Records

ADRs record project decisions that should survive across AI sessions, development phases, and final report writing.

## Current ADRs

| ADR | Decision |
|---|---|
| `0001-use-vector-as-edge-collector.md` | Vector is the edge log collector. |
| `0002-use-otel-gateway-as-central-telemetry-gateway.md` | OTel Gateway is the central telemetry gateway. |
| `0003-use-clickhouse-for-log-storage.md` | ClickHouse stores logs and log-like events. |
| `0004-use-postgresql-for-platform-metadata.md` | PostgreSQL stores platform metadata/config. |
| `0005-use-stable-service-identity.md` | `service_key` is stable workload identity. |
| `0006-use-docker-compose-central-edge-distribution.md` | Platform is distributed as central/edge Docker Compose. |

## Template

```markdown
# ADR-0000: Title

## Status

Proposed | Accepted | Superseded

## Context

Why this decision is needed.

## Decision

What was decided.

## Consequences

Benefits, trade-offs, and follow-up work.
```

