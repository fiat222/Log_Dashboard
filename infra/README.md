# Infra

Target home for infrastructure and telemetry runtime configuration.

Planned layout:

```text
infra/
  compose/          # central compose entrypoints and compose overrides
  clickhouse/       # ClickHouse schema and server config
  otel/             # OpenTelemetry collector configs
  vector/           # Vector configs for central and edge collectors
  nginx/            # Nginx/proxy templates
  monitoring/       # Prometheus, Grafana, Alertmanager when reused
```

Current state:

- Active runtime config now lives here: `infra/clickhouse/`, `infra/otel/`, and `infra/vector/`. Root `docker-compose.yml` remains the compatibility entrypoint for now.
- Move root compose only when install docs, CI, and stack smoke checks use the new layout.
