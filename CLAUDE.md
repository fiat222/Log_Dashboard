# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Project Instructions

## Overview
if want to see project overview read README.md

## Workflow

- **Always enter plan mode before implementing any feature or fix.** Use `/plan` or `EnterPlanMode` to outline approach and get user confirmation before writing code.
- **Use Caveman skill**
- **Use Rtk skill**

## Dev Commands

```bash
# Start the full stack
docker compose up -d

# Rebuild a single service after code change
docker compose build backend && docker compose up -d backend
docker compose build log-dashboard && docker compose up -d log-dashboard

# View logs for a service
docker compose logs -f backend
docker compose logs -f log-dashboard

# Rebuild all images and push to registry
./deploy-registry.ps1   # Windows PowerShell
./deploy.sh             # Linux

# Promote a tag to production
./promote.ps1
```

## Architecture

**Data flow (new OTel pipeline):**
`OTel Agent` (Docker logs) → `OTel Gateway` (batch) → `ClickHouse` (`observability.otel_logs_local`)
`Vector` (Nginx logs) → `OTel Gateway` (OTLP/HTTP :4318) → `ClickHouse`

**Auth/query flow:**
Browser → `Traefik` (80/443) → `Nginx` (serves `dashboard/`) → proxies `/logstore/api` → `FastAPI backend` → `ClickHouse` + `PostgreSQL` + `Redis`

## Key Files

| File | Purpose |
|------|---------|
| `dashboard/app.js` | All frontend logic — single JS file, ~2500 lines. State-driven SPA. |
| `dashboard/index.html` | DOM structure — tabs (Logs, Analytics, Nginx, Patterns, Admin), modals |
| `dashboard/style.css` | All styles — CSS vars for light/dark themes, no framework |
| `backend/main.py` | FastAPI app — auth, ClickHouse proxy, role-based filtering, SSE notifications |
| `clickhouse/init.sql` | ClickHouse schema — Null engine ingress + Materialized View + MergeTree storage |
| `otel/agent-config.yaml` | OTel Agent config (reads Docker logs from host) |
| `otel/gateway-config.yaml` | OTel Gateway config (receives, batches, writes to ClickHouse) |
| `docker-compose.yml` | Full stack definition |

## Frontend Architecture (`app.js`)

- **Single state object** `state` drives all views. Update state, then call the appropriate load function.
- **API calls** all go through `${API_BASE}/query` (POST) with raw ClickHouse SQL — the backend filters by user role/container ownership before executing.
- **Modals** (trace context, nginx drill-down) are created dynamically via `document.createElement` and appended to `document.body`. Each modal builds its own overlay `div.modal-overlay > div.ctx-modal`.
- **Time selects** (HH/MM dropdowns) are populated once at init from `populateTimeSelect()` around line 2280. The first `<option value="00">` is the placeholder for HH/MM.
- **Tabs**: `view-tabs` buttons toggle visibility of `#logs-view-wrapper`, `#analytics-section`, `#nginx-view-wrapper`, `#patterns-section`, `#admin-section`.

## ClickHouse Schema

- **Container logs**: `observability.otel_logs_local` (OTel pipeline) — columns: `Timestamp`, `SeverityText`, `Body`, `ResourceAttributes`, `LogAttributes`
- **Nginx logs**: `logs.nginx_logs` — columns: `timestamp`, `client_ip`, `method`, `path`, `status`, `bytes`, `response_time`, `referer`, `website`
- Old schema (`logs.container_logs`) may still exist; backend queries target the OTel table.

## CSS Theming

Light/dark via `[data-theme="dark"]` on `<html>`. All colors use CSS vars (`--bg-base`, `--text`, `--accent`, etc.) defined in `:root`. Toggle handled in `app.js` via `btn-theme` click.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- ALWAYS read graphify-out/GRAPH_REPORT.md before reading any source files, running grep/glob searches, or answering codebase questions. The graph is your primary map of the codebase.
- IF graphify-out/wiki/index.md EXISTS, navigate it instead of reading raw files
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
