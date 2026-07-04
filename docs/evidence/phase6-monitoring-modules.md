# Phase 6 Monitoring Modules Evidence

## Status

Phase 6 is not complete. It has been re-scoped from gateway-only metrics into the Centralized Monitoring and Investigation Cockpit.

Current active target: Phase 6.5 - Alerting MVP browser verification.

## Product Direction Confirmed

The first post-login page should be a Monitoring Overview. It must show metrics and operational risk across multiple layers, not only log totals or gateway traffic.

The investigation pattern is:

```text
Symptom -> Suspected layer -> Evidence -> Drill-down
```

## What Exists Now

- Platform health panel backed by `/api/platform/health`.
- Platform runtime panel backed by `/api/platform/runtime`.
- Network workflow preserved and promoted from the legacy Nginx view.
- Gateway metrics panel with request rate, error rate, p95 latency, 5xx estimate, and top paths.
- Runtime diagnostics for restarted, OOM-killed, exited, and unhealthy containers from Docker inspect fallback.
- Gateway/app correlation panel that compares 5xx, 4xx, slow gateway paths, and app error logs in the same one-hour evidence window.
- Workload database panel separated from platform databases, backed by `/api/platform/workload-databases` and `WORKLOAD_DATABASE_PROFILES`.
- Platform database workflow panel that focuses ClickHouse, PostgreSQL, and Redis platform health cards.
- Platform uptime panel backed by `/api/platform/uptime`.

## Gaps

- Monitoring Overview does not yet show enough host/container/database signals on first view.
- CPU/memory/disk/container resource metrics need real collector source wiring.
- Workload database monitoring has a first profile-based slice. Rich exporter metrics such as slow queries, connection pressure, and replication lag remain pending.
- OOM/restart/root-cause evidence is visible in runtime diagnostics, but not yet connected into the full incident timeline.
- Alerting now has a first admin-facing custom rule surface with name, source, condition, severity, recipients, cooldown, enabled state, and test action.
- Live rule evaluation, recovery transitions, and downstream email delivery are still pending.
- Some visible UI glyph bugs were reported and must be treated as unresolved until browser verification confirms otherwise.

## Revised Phase 6 Slices

1. Phase 6.0 - Reframe and clean current surface.
2. Phase 6.1 - Monitoring Overview metrics.
3. Phase 6.2 - Host and container diagnostics. Done as Docker runtime fallback slice; collector metrics still pending.
4. Phase 6.3 - Gateway, app, and log correlation. Implemented as gateway/app evidence window; browser verification pending.
5. Phase 6.4 - Workload database monitoring. Implemented as profile-based health probe slice; browser verification pending.
6. Phase 6.5 - Alerting MVP. Implemented as admin custom rule + test alert slice; browser verification pending.
7. Phase 6.6 - Incident evidence timeline and AI evidence bundle boundary. Implemented as a Platform incident panel with service-scoped timeline, bounded evidence bundle copy, and visible detects versus does-not-fix notes; browser verification pending.

## Next Browser Verification Target

For Phase 6.6, open Platform, keep one service selected, and verify Incident evidence timeline appears with scope, summary counters, event rows, AI boundary notes, and Detects / Does not fix notes. Click one timeline log event to drill into Logs, one runtime event to jump to runtime diagnostics, and Copy evidence bundle to confirm bounded JSON copies without exposing unrestricted raw DB access.

## Automated Checks So Far

- `python -m pytest tests/frontend/test_dashboard_assets.py tests/backend/api/test_health_contract.py`
- `node --check apps/web/app.js`
- `python -m pytest tests/frontend/test_dashboard_assets.py`
- `python -m pytest tests/backend/api/test_health_contract.py::test_platform_gateway_correlation_links_gateway_and_app_signals`
- `python -m pytest tests/backend/api/test_health_contract.py::test_platform_workload_databases_returns_not_configured`
- `python -m pytest tests/frontend/test_dashboard_assets.py tests/backend/api/test_health_contract.py -q`
- ASCII scan for active frontend shell files.
