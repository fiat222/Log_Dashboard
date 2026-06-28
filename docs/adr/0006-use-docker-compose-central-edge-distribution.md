# ADR-0006: Use Docker Compose Central/Edge Distribution

## Status

Accepted

## Context

The project should be easy to install, demo, and understand within a two-month co-op timeline. The target users are likely to run Docker workloads and should be able to clone the repository, edit `.env`, and start the stack.

## Decision

Distribute the platform using Docker Compose with two surfaces:

- Central stack: dashboard, backend, storage, telemetry gateway, monitoring services.
- Edge stack: collectors and exporters installed on monitored machines.

The long-term repository direction is:

```text
central/
edge/
docs/
```

## Consequences

Benefits:

- Easy local demo.
- Easy VM/home-network testing.
- Clear mental model for users.
- Matches the project timeline.
- Avoids Kubernetes complexity during the initial scope.

Trade-offs:

- Not Kubernetes-native.
- Multi-node production deployment needs extra documentation later.
- Compose profiles must be managed carefully to avoid confusing users.

## Notes

Compose profiles should be used for optional modules such as tracing, CI, security tools, and demo workloads.

