# Testing Strategy

## Goal

Prove that the platform works in realistic deployment conditions, not only inside the developer machine.

Testing is split into three phases:

```text
Phase 1: Local machine
Phase 2: VM edge host
Phase 3: Another computer on home network
```

## Phase 1: Local Machine

Purpose: verify the development stack quickly.

Setup:

```text
central stack + sample containers on same machine
```

Checks:

- Central stack starts.
- Dashboard loads.
- Login or mock login works.
- Backend API is reachable.
- ClickHouse receives logs.
- Logs are visible in dashboard.
- Existing log filters still work.
- Prometheus is reachable when metrics profile is enabled.
- UI handles loading, empty, and error states.

Expected result:

The platform works as a single-machine demo.

## Phase 2: VM Edge Host

Purpose: verify central-edge behavior.

Setup:

```text
host machine = central
VM = edge
```

Checks:

- Edge stack starts.
- Edge host has stable `EDGE_HOST_ID`.
- Vector sends Docker logs to central.
- Metrics are scraped or forwarded.
- Dashboard shows VM as separate host.
- Container recreate keeps same service identity.
- Container down/restart event is visible.

Expected result:

The platform can monitor an external machine.

## Phase 3: Home Network Machine

Purpose: verify practical installation from another physical computer.

Setup:

```text
main machine = central
another home computer = edge
```

Checks:

- Edge can reach central endpoint.
- Firewall/port requirements are documented.
- Edge install docs can be followed.
- Dashboard separates hosts correctly.
- Logs and metrics continue after reboot/restart.

Expected result:

The platform is usable outside local-only development.

## Automated Test Layers

### Backend Tests

Focus:

- Auth/RBAC.
- Query filtering.
- Service identity parsing.
- Member management permissions.
- Alert state transitions.

Initial test entrypoint:

- `tests/backend/unit/`
- `tests/backend/api/`

### Frontend Tests

Focus:

- Login/mock login flow.
- Navigation.
- Logs view.
- Service tree behavior.
- Theme switch.
- Responsive layout.

Initial test entrypoint:

- `tests/ui/`

### Integration Tests

Focus:

- Backend can query ClickHouse.
- Backend can read/write PostgreSQL.
- Log ingestion path writes expected records.
- Service aggregation returns stable grouping.

### Compose Smoke Tests

Focus:

- `docker compose config` passes.
- Required services start.
- Health endpoints respond.
- Dashboard and API are reachable.

## Security Tests

Minimum CI security checks:

- Secret scan with Gitleaks or equivalent.
- Container scan with Trivy or equivalent.
- Dependency/code quality scan with SonarQube or equivalent.
- Optional OWASP ZAP baseline scan for web routes.

## Evidence to Collect

For final report:

- Screenshots of each test phase.
- Command outputs for stack startup.
- Screenshot of edge host appearing in dashboard.
- Screenshot of service surviving container recreate.
- CI/CD pipeline screenshot.
- Security scan summary.
- Known limitations list.
