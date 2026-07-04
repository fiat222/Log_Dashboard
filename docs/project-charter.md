# Project Charter: Centralized Monitoring and Investigation Platform

## Summary

This project extends an existing centralized log dashboard into a self-hosted Centralized Monitoring and Investigation Cockpit for containerized services.

The platform is designed for a central server plus lightweight edge agents. Users can clone the project, configure `.env` files, start the central stack with Docker Compose, then install edge collectors on monitored hosts. The product goal is not only to store logs, but to help an operator see current health, detect risk, and investigate where an incident started.

## Problem

Teams running Docker workloads often need logs, service health, host metrics, container metrics, gateway traffic, workload database signals, uptime checks, and alerts in one place. Existing tools such as Grafana, Loki, PMM, and Uptime Kuma are powerful but can feel fragmented or require separate setup flows.

This project aims to provide a focused platform that keeps centralized logs as the core and adds enough monitoring features for practical operations. The central question is: when a service returns 404/503, gets slow, fills disk, restarts, or dies from OOM, can the user see the related server, container, app, gateway, database, and log evidence without hunting across separate tools?

## Goals

- Keep the existing high-throughput log ingestion path stable.
- Package the system as a self-hosted central platform.
- Provide an edge agent bundle for monitored hosts.
- Group recreated containers under stable services.
- Add monitoring for hosts, containers, applications, gateways, workload databases, uptime, and alerts.
- Make the first post-login page a Monitoring Overview with visible metrics and health signals.
- Correlate signals into an incident investigation path: symptom -> suspected layer -> evidence -> drill-down.
- Allow a future AI assistant to inspect a bounded evidence bundle through an API key, not raw unrestricted database access.
- Provide detailed installation documentation, with Docusaurus as an acceptable docs-site surface.
- Provide a clean, responsive dashboard with light and dark themes.
- Add CI/CD, automated tests, and security checks.
- Produce professional documentation suitable for a co-op project.

## Non-Goals

- Rebuild Grafana.
- Rebuild Loki.
- Build a plugin marketplace.
- Build production-grade ML prediction.
- Replace specialist database monitoring suites for every database engine.
- Automatically fix reliability problems without operator-approved actions.
- Build Kubernetes-first deployment.
- Build production Authentik integration during the two-month scope.

## Target Users

- Student/developer running Docker services.
- Small internal team needing centralized logs and basic monitoring.
- Platform-minded developer who wants one self-hosted observability app.
- Evaluator who needs to understand architecture, demo flow, installation, and engineering decisions clearly.

## Product Shape

The project has two installable surfaces:

```text
central/  -> central server stack
edge/     -> monitored host collector stack
docs-site/ or archived Docusaurus site -> detailed product documentation
```

The central stack owns UI, API, databases, telemetry gateway, and monitoring services.

The edge stack collects logs, metrics, runtime events, uptime probe results, and optional workload database signals from each monitored host and forwards them to the central stack.

## Success Criteria

- Fresh clone can start central stack from documented commands.
- Edge stack can be installed on at least one external VM or home-network machine.
- Dashboard shows host, service, metric, and log data from edge host.
- Container recreation does not lose service history.
- Logs remain searchable and useful.
- Basic host, container, gateway, workload database, uptime, and alert signals are visible.
- At least one incident workflow connects symptom, suspected layer, and supporting logs.
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
5. Monitoring overview and investigation cockpit.
6. Host/container/database/alerting slices.
7. Detailed install docs and optional Docusaurus docs site.
8. CI/CD, security, testing evidence, and final demo.
