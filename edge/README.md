# Edge Agent Stack

The edge stack runs on monitored machines and sends telemetry back to the central platform.

## Goal

Install one small Docker Compose stack per monitored host.

The edge stack should collect:

- Docker container logs via Vector.
- Host metrics via node_exporter.
- Container metrics via cAdvisor.
- Host identity metadata via environment variables.

## Required Configuration

Copy `.env.example` to `.env` and set:

- `EDGE_HOST_ID`
- `CENTRAL_OTEL_ENDPOINT`
- `CENTRAL_PROMETHEUS_SCRAPE_HINT`
- `EDGE_AUTH_TOKEN`

`EDGE_HOST_ID` must be stable. Do not use container ID or random values.

Good examples:

- `home-server`
- `test-vm`
- `family-pc`
- `prod-node-01`

## Start

```powershell
Copy-Item .env.example .env
docker compose up -d
```

## Current Status

This edge stack is the planned distribution surface. Validate config against the current central OTel Gateway before using it for final demo.

