# ADR-0001: Use Vector as Edge Collector

## Status

Accepted

## Context

The platform needs to collect telemetry from multiple target machines. The most important telemetry type is logs from Docker containers, applications, and gateway servers such as Nginx, Apache, HAProxy, Traefik, or Caddy.

The edge component should be lightweight, Docker Compose-friendly, and easy to configure per host.

## Decision

Use Vector as the primary edge log collector.

Vector runs on each monitored host and collects:

- Docker container logs.
- Application logs.
- Gateway/access logs when configured.
- Host metadata such as `host_id`.

Vector forwards logs to the central telemetry gateway using OTLP/HTTP or another supported protocol when needed.

## Consequences

Benefits:

- Lightweight and suitable for edge deployment.
- Strong log pipeline features.
- Works well in container environments.
- Can transform/enrich events before forwarding.
- Keeps the central platform collector-agnostic enough for future extension.

Trade-offs:

- Each edge host needs a correct Vector config.
- Host identity must be injected consistently.
- Metrics still require separate exporters such as node_exporter and cAdvisor.

## Notes

Vector is not the central gateway. In this architecture, Vector is the edge collector. The central gateway role belongs to OTel Gateway.

