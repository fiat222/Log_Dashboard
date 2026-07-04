# Phase 5 Platform Cockpit Evidence

Date: 2026-06-29

## Visible Change

The Platform tab now includes an investigation cockpit above the module cards. It shows the selected or highest-priority service, host, stack, error count, and service count, then gives direct actions back into the log investigation flow.

## Screenshot

- `docs/evidence/phase5-platform-cockpit.png`

## Manual Check

1. Open the dashboard.
2. Click `Platform`.
3. Confirm the cockpit appears above the Services, Infrastructure, Gateways, Databases, Uptime, Alerts, and Settings module cards.
4. Confirm `Open selected service logs` or `Open top service logs` opens Logs with a service selected when service data is available.
5. Confirm `Open all logs` clears service selection and opens Logs.
6. Confirm `Open gateway logs` opens Nginx/Gateway logs when that tab is available.

## Automated Checks

- `rtk python -m pytest tests/frontend/test_dashboard_assets.py -q`
- `rtk proxy node --check dashboard\app.js`

## Phase Status

Phase 5 is closer, but not complete until a full UI smoke pass confirms Overview, Logs, service sidebar, Platform, Analytics, Nginx, Patterns, and Admin remain reachable in the running stack.
