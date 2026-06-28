# Architecture: Stable Service Identity

## Problem

Docker container identity is unstable.

Container IDs change when containers are recreated. Container names may collide across stacks or hosts. If the dashboard treats each container ID as the main identity, history, ownership, alerts, and UI grouping become fragile.

## Decision

Use two layers of identity:

```text
service_key  = host_id + compose_project + compose_service
instance_key = container_id
```

## Meaning

`service_key` represents the logical workload.

Example:

```text
home-server/shop-stack/api
```

`instance_key` represents one runtime container instance.

Example:

```text
container_id=abc123
container_id=def456
```

If the API container is recreated, the new container ID changes, but the service key remains the same.

## UI Behavior

Default view should show services, not raw container IDs.

```text
home-server
  shop-stack
    api             running, 2 instances
    nginx-gateway   running, 1 instance
```

When user clicks a service:

- Show combined logs for that service.
- Show active and previous instances.
- Show restart/recreate timeline.
- Preserve alert and ownership context.
- Allow filtering by instance only when needed.

## Current UI Transition

The dashboard sidebar now attempts to load service summaries from:

```http
GET /logstore/api/services?hours=24
```

If the service API returns rows, the sidebar switches to service mode:

```text
host › compose_project
  service
```

If the service API is unavailable or returns no rows, the dashboard falls back to the existing container-list query. This keeps the current log dashboard usable while service-centric observability is introduced.

## Data Ownership

Attach long-lived configuration to `service_key`:

- Ownership.
- Display name.
- Alert rules.
- Saved filters.
- Service notes.
- Team mapping.

Attach runtime facts to `instance_key`:

- Container ID.
- Start time.
- Stop time.
- Image ID.
- Runtime status.
- Last seen timestamp.

## Required Metadata

Each log/event should ideally contain:

- `host_id`
- `compose_project`
- `compose_service`
- `container_id`
- `container_name`
- `image`
- `timestamp`

If `compose_service` is missing, fallback can use container name, but the UI should mark identity confidence as lower.

## Current Storage Note

The current ClickHouse table stores `ComposeProject` as a physical column, but `compose_service` is still read from `ResourceAttributes['container.label.com.docker.compose.service']`.

This avoids an immediate schema migration while the platform structure is being introduced.

Future migration candidate:

- Add `ComposeService` column to `observability.otel_logs_local`.
- Update materialized view to extract `ResourceAttributes['container.label.com.docker.compose.service']`.
- Update service queries to use the physical column.

## Edge Requirements

Each edge host must define a stable `EDGE_HOST_ID`.

Rules:

- Human-readable.
- Unique within the central platform.
- Does not change across restarts.
- Stored in `.env` or generated once and persisted.

Examples:

```text
home-server
test-vm
family-pc
prod-node-01
```

## Alert Behavior

Container down detection should evaluate service state, not only container ID.

Example:

```text
Old container stopped
New container started under same service_key
→ service remains healthy or briefly restarting
```

Only alert when:

- No active instance exists after grace period.
- Last seen exceeds threshold.
- Error rate or restart count crosses configured rule.

## Migration Strategy

Do not remove existing container views immediately.

Recommended transition:

1. Add service identity parser.
2. Add service aggregation query.
3. Add `/services` API.
4. Update UI sidebar to group by host → stack → service.
5. Keep instance/container drill-down for detailed logs.
6. Move ownership and alert config to service key.
