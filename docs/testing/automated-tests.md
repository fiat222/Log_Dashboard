# Automated Tests

## Goal

The project should have automated tests for three layers:

- Unit tests for pure logic.
- API tests for FastAPI public behavior.
- UI tests for dashboard/login behavior.

The first target is a reliable smoke suite that can run in CI before deeper integration tests are added.

## Backend Unit Tests

Purpose:

- Test pure functions without Docker, DB, Redis, or ClickHouse.
- Protect critical platform logic such as stable service identity.

Command:

```powershell
python -m pytest tests/backend/unit
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
python -m pytest tests/backend/api
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

- Login page shows SSO path.
- Admin login panel can be opened.
- Username/password fields are visible.

## CI Target

CI and local smoke runs should use the same scripts:

```bash
sh ci/scripts/run-backend-tests.sh
sh ci/scripts/run-ui-tests.sh
sh ci/scripts/check-compose.sh
sh ci/scripts/security-checks.sh
```

## Testing Roadmap

Next tests to add:

1. API auth/login contract.
2. API role enforcement for member management.
3. Developer RBAC filtering for `/api/services`.
4. UI service sidebar behavior with mocked `/api/services`.
5. Compose smoke test for central stack.
6. Integration test with ClickHouse test container or dev compose profile.
