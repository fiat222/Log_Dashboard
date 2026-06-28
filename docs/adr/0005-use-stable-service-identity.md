# ADR-0005: Use Stable Service Identity

## Status

Accepted

## Context

Docker container IDs change when containers are recreated. Container names can collide across hosts or Compose projects. If the platform uses container ID or container name as the main identity, dashboard history, alert rules, and ownership can break after normal deployment operations.

## Decision

Use a two-layer identity model:

```text
service_key  = host_id + compose_project + compose_service
instance_key = container_id
```

The service key represents the logical workload. The instance key represents one runtime container instance.

## Consequences

Benefits:

- Container recreate does not destroy service history.
- UI can show service-level health by default.
- Alert rules and ownership remain stable.
- Users can still drill down into raw container instances when needed.

Trade-offs:

- Edge collectors must provide stable `host_id`.
- Missing Compose labels require fallback logic.
- Existing container-based queries need migration or compatibility layers.

## Notes

Long-lived configuration attaches to `service_key`.

Runtime facts attach to `instance_key`.

See `docs/architecture/service-identity.md` for the full model.

