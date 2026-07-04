# Domain Language

This file records product language resolved during grill-with-docs sessions.

## Language

**Centralized Monitoring and Investigation Cockpit**:
The product surface that combines live operational monitoring with drill-down investigation evidence across hosts, containers, applications, gateways, databases, uptime checks, alerts, and logs.
_Avoid_: Log dashboard, metrics dashboard, Grafana clone

**Monitoring Overview**:
The first screen after login that shows current operational status and key metrics for monitored systems.
_Avoid_: Landing page, homepage, overview-only page

**Signal**:
A measurable symptom or state that may indicate operational risk, such as 5xx rate, p95 latency, disk pressure, restart count, OOM event, ingest freshness, or database availability.
_Avoid_: Widget, random metric

**Evidence**:
A bounded set of logs, metrics, runtime events, and health checks that explain a signal during a specific time window.
_Avoid_: Raw data dump, full database access

**Incident Evidence Bundle**:
A backend-generated package of evidence for one incident window that can be shown to a user or passed to a future AI assistant through an API-key controlled workflow.
_Avoid_: AI reads everything, unrestricted query access

**Monitored Host**:
A server or VM running user workloads and an edge collector bundle.
_Avoid_: Edge server, client server

**Edge Agent Bundle**:
The lightweight collector stack installed on a monitored host to collect logs, host metrics, container metrics, runtime events, uptime checks, and optional database signals.
_Avoid_: Vector-only agent, heavy monitoring suite

**Workload Database**:
A database owned by a monitored application on a monitored host, such as PostgreSQL, MySQL, Redis, MongoDB, or ClickHouse.
_Avoid_: Platform database, internal database
