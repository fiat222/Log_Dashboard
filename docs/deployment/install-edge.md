# Install Edge Agent Stack

## Purpose

The edge stack runs on each monitored machine. It collects logs and metrics, then sends telemetry back to the central platform.

## Prerequisites

- Docker Engine.
- Docker Compose plugin.
- Network access from edge host to central OTel endpoint.
- Stable host name for `EDGE_HOST_ID`.

## Install

From repository root on the edge machine:

```powershell
cd edge
Copy-Item .env.example .env
```

Edit `.env`:

```env
EDGE_HOST_ID=home-server
EDGE_SITE=home-lab
EDGE_ENV=dev
CENTRAL_OTEL_ENDPOINT=http://192.168.1.10:4318
```

Start:

```powershell
docker compose up -d
```

Check:

```powershell
docker compose ps
docker compose logs vector
```

## Host Identity Rule

`EDGE_HOST_ID` must be stable.

Good:

```text
home-server
test-vm
family-pc
```

Bad:

```text
container_id
random uuid regenerated every start
localhost on every machine
```

## Metrics

The edge stack exposes:

- node_exporter on `9100` by default.
- cAdvisor on `8080` by default.

Central Prometheus can scrape these endpoints after network access is configured.

## Logs

Vector reads Docker logs from the local Docker socket and forwards them to central OTel Gateway.

Events are enriched with:

- `edge_host_id`
- `edge_site`
- `edge_env`
- `compose_project`
- `compose_service`
- `service_key`
- `instance_key`

## Smoke Test

Expected:

- Vector container is running.
- Edge host appears in dashboard after telemetry is received.
- Docker logs from this host are visible.
- Recreated containers remain grouped under the same service when Compose labels exist.

