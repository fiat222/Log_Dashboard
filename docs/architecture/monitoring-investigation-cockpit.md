# Architecture: Monitoring and Investigation Cockpit

## Purpose

The dashboard should monitor systems and help investigate incidents. It should not become a generic dashboard builder or a Grafana clone.

The primary workflow is:

```text
Symptom -> Suspected layer -> Evidence -> Drill-down
```

## Monitoring Layers

| Layer | Signals | Evidence source | First visible UI |
|---|---|---|---|
| Host | CPU, memory, disk, network, load, uptime | node_exporter or Vector host metrics | Monitoring Overview + Host detail |
| Container | running state, restart count, OOM, exit code, CPU/memory | cAdvisor, Docker events, Vector logs | Runtime panel + Service detail |
| Application | errors, latency hints, log rate, silence | app logs, OTLP logs, optional traces | Service health + Logs drill-down |
| Gateway | request rate, 4xx/5xx, p95 latency, slow paths | Nginx/HAProxy/Apache/Caddy logs or metrics | Network metrics panel |
| Workload database | availability, connection pressure, slow queries where supported, replication/lag where supported | DB exporters, lightweight probes, logs | Database panel |
| Ingestion pipeline | collector heartbeat, log freshness, row rate, gateway errors | OTel Gateway, ClickHouse, collector metadata | Pipeline health panel |
| Alerting | firing/recovered state, cooldown, recipients | alert rules and notification history | Alerts panel |

## Edge Agent Bundle

The edge bundle should be lightweight and composable. Vector alone is not enough for every signal. The recommended bundle is:

- Vector for logs, Docker events, gateway logs, routing, buffering, and enrichment.
- node_exporter or Vector host metrics for host CPU, memory, disk, network, and load.
- cAdvisor or Docker stats collector for per-container CPU, memory, restart, and OOM context.
- Lightweight HTTP/TCP probe for uptime checks.
- Optional database exporters or probes for workload databases.

## Workload Database Monitoring

A workload database is a database owned by a monitored app on a monitored host. It is different from the platform databases used by this product.

Database support should be profile-based:

- PostgreSQL: availability, connections, slow query logs when configured, replication lag when available.
- MySQL/MariaDB: availability, connections, slow query logs when configured.
- Redis: availability, memory, keyspace, evictions, rejected connections.
- MongoDB: availability, connections, operation latency where exporter exists.
- ClickHouse: availability, query errors, insert freshness, disk usage.

The first version can show health-only or exporter-missing states, but the UI must say that clearly.

## AI Evidence Boundary

Future AI assistance should not receive raw database access by default. The backend should generate an Incident Evidence Bundle for a bounded time window and service scope.

The bundle may include:

- top symptoms and current signal values;
- relevant logs around the incident window;
- host and container metrics before and during the incident;
- restart/OOM/exit events;
- gateway slow paths and errors;
- workload database health or exporter gaps;
- alert history and recent config changes when available.

## Design Rule

Every important signal should either drill into evidence or explain why evidence is unavailable. Empty modules are acceptable only when they guide installation or configuration.
