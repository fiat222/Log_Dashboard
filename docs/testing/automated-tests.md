# Automated Tests

## Goal

The project should have automated tests for three layers:

- Unit tests for pure logic.
- API tests for FastAPI public behavior.
- UI tests for apps/web/login behavior.

The first target is a reliable smoke suite that can run in CI before deeper integration tests are added.

## Backend Unit Tests

Purpose:

- Test pure functions without Docker, DB, Redis, or ClickHouse.
- Protect critical platform logic such as stable service identity.

Command:

```powershell
python -m pytest tests/apps/api/unit
```

Current coverage:

- `backend.identity.build_service_identity`
- `backend.service_queries.build_services_summary_query`

## Backend API Tests

Purpose:

- Test public API behavior through ASGI.
- Mock external dependencies when the test is a contract/smoke test.

Command:

```powershell
python -m pytest tests/apps/api/api
```

Current coverage:

- `/api/health` returns healthy response when dependencies are available.
- `/api/services` returns service-level summary using mocked ClickHouse.

## UI Tests

Purpose:

- Test important user flows from the browser perspective.
- Start with static login page behavior.
- Expand later to dashboard navigation using a running dev server.

Install:

```powershell
npm install
npx playwright install
```

Command:

```powershell
npm run test:ui
```

Current coverage:

- Login page exposes the standard username/password sign-in flow.
- Legacy SSO and "Login as Admin" shortcuts stay absent.
- Normal UI text does not regress into obvious mojibake placeholders.

## CI Target

CI and local smoke runs should use the same scripts:

These helper scripts now handle the common Jenkins/Linux path and the local Windows Git Bash style path for Python and npm resolution.

```bash
sh tools/ci/scripts/run-backend-tests.sh
sh tools/ci/scripts/run-ui-tests.sh
sh tools/ci/scripts/check-compose.sh
sh tools/ci/scripts/security-checks.sh
```

Expected CI artifacts now include:

- `reports/backend-pytest.xml`
- `reports/ui-playwright.xml`
- `reports/compose-central.yml`
- `reports/compose-edge.yml`
- `reports/compose-check.txt`
- `reports/security-checks.txt`

## Testing Roadmap

Next tests to add:

1. API auth/login contract.
2. API role enforcement for member management.
3. Developer RBAC filtering for `/api/services`.
4. UI service sidebar behavior with mocked `/api/services`.
5. Compose smoke test for central stack.
6. Integration test with ClickHouse test container or dev compose profile.
