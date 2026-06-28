# ADR-0002: Use OTel Gateway as Central Telemetry Gateway

## Status

Accepted

## Context

The central platform needs a single telemetry ingress point. Edge collectors should not write directly into every backend storage system. A central gateway makes routing, batching, enrichment, and future protocol support easier.

## Decision

Use OpenTelemetry Collector in gateway mode as the central telemetry gateway.

The central OTel Gateway receives telemetry from edge collectors and routes it to storage systems:

- Logs to ClickHouse.
- Future traces to Tempo or Jaeger.
- Future telemetry streams to other processors/exporters if needed.

## Consequences

Benefits:

- Centralized telemetry ingress.
- Protocol-friendly architecture.
- Easier to add traces later.
- Keeps edge configuration simpler.
- Reduces coupling between edge collectors and storage backends.

Trade-offs:

- Adds one central service to operate.
- Requires careful configuration for batching, retries, and backpressure.
- Dashboard users may need docs explaining the difference between Vector and OTel Gateway.

## Notes

The platform should describe this clearly:

```text
Vector = edge collector
OTel Gateway = central telemetry gateway
```

