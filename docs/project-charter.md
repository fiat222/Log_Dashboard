# Project Charter: Centralized Observability and Monitoring Platform

## Summary

This project extends an existing centralized log dashboard into a self-hosted observability and monitoring platform for containerized services.

The platform is designed for a central server plus lightweight edge agents. Users can clone the project, configure `.env` files, start the central stack with Docker Compose, then install edge collectors on target machines.

## Problem

Teams running Docker workloads often need logs, service health, host metrics, container metrics, gateway traffic, and alerts in one place. Existing tools such as Grafana, Loki, PMM, and Uptime Kuma are powerful but can feel fragmented or require separate setup flows.

This project aims to provide a focused, easy-to-use platform that keeps centralized logs as the core and adds enough monitoring features for practical operations.

## Goals

- Keep the existing high-throughput log ingestion path stable.
- Package the system as a self-hosted central platform.
- Provide an edge agent bundle for monitored hosts.
- Group recreated containers under stable services.
- Add monitoring for hosts, containers, gateways, and databases.
- Provide a clean, responsive dashboard with light and dark themes.
- Add CI/CD, automated tests, and security checks.
- Produce professional documentation suitable for a co-op project.

## Non-Goals

- Rebuild Grafana.
- Rebuild Loki.
- Build a plugin marketplace.
- Build production-grade ML prediction.
- Build Kubernetes-first deployment.
- Build production Authentik integration during the two-month scope.

## Target Users

- Student/developer running Docker services.
- Small internal team needing centralized logs and basic monitoring.
- Platform-minded developer who wants one self-hosted observability app.
- Evaluator who needs to understand architecture, demo flow, and engineering decisions clearly.

## Product Shape

The project has two installable surfaces:

```text
central/  → central server stack
edge/     → monitored host collector stack
```

The central stack owns UI, API, databases, telemetry gateway, and monitoring services.

The edge stack collects logs and metrics from each monitored host and forwards them to the central stack.

## Success Criteria

- Fresh clone can start central stack from documented commands.
- Edge stack can be installed on at least one external VM or home-network machine.
- Dashboard shows host, service, and log data from edge host.
- Container recreation does not lose service history.
- Logs remain searchable and useful.
- Basic metrics are visible.
- Superadmin can manage members.
- Security scan and automated tests are represented in CI/CD.
- Final demo can run from documented steps.

## Two-Month Strategy

The project should prioritize a working vertical slice over many incomplete modules.

Recommended order:

1. Documentation and architecture baseline.
2. Central/edge packaging.
3. Stable service identity.
4. Platform UI shell.
5. Core monitoring modules.
6. CI/CD and security.
7. Testing evidence and final demo.

