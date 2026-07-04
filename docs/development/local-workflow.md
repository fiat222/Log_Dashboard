# Local Development Workflow

## Goal

Keep development predictable while the project evolves from a log dashboard into an observability platform.

## Before Starting Work

Read:

1. `docs/project-charter.md`
2. `docs/project-structure.md`
3. `docs/architecture/central-edge-platform.md`
4. `docs/architecture/service-identity.md`
5. `docs/workflows/project-development-loop.md`

Then check:

```powershell
git status --short
```

Do not overwrite unrelated user changes.

## Development Loop

Use this loop for meaningful changes:

```text
Brief
  ↓
Design
  ↓
ADR if decision is important
  ↓
Small implementation slice
  ↓
Automated test
  ↓
Docs update
  ↓
Smoke test
  ↓
Review
```

## Runtime Safety Rule

The current root `docker-compose.yml` is the working central stack.

Do not move or rename runtime files until a migration plan is tested.

## Common Commands

Start current central stack for local development:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/dev/scripts/start-local.ps1 -Build
```

Start with mock services that emit Docker logs:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/dev/scripts/start-local.ps1 -WithMockServices
```

Open:

```text
http://localhost:8801/logstore/
```

Login page:

```text
http://localhost:8801/logstore/login
```

Verify local login + Overview API:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/dev/scripts/check-local-overview.ps1
```

The local stack uses `docker-compose.local.yml` to avoid private internship registry images and to run PostgreSQL locally.

Production-like compose without local overrides:

```powershell
docker compose up -d
```

Check services:

```powershell
docker compose ps
```

Backend logs:

```powershell
docker compose logs -f backend
```

Dashboard logs:

```powershell
docker compose logs -f log-dashboard
```

Render edge compose config:

```powershell
docker compose --env-file edge/.env.example -f edge/docker-compose.yml config
```

Jenkins now lives outside this repository at `D:/PSU/Jenkins`. CI v1 should validate tests/config without deployment authority or Docker host control.

## Test Commands

Backend tests:

```powershell
pip install -r apps/api/requirements-dev.txt
python -m pytest tests/backend
```

CI-equivalent:

```bash
sh tools/ci/scripts/run-backend-tests.sh
```

UI tests:

```powershell
npm install
npx playwright install
npm run test:ui
```

CI-equivalent:

```bash
sh tools/ci/scripts/run-ui-tests.sh
```

Compose config check:

```bash
sh tools/ci/scripts/check-compose.sh
```

## Jenkins Local CI

Jenkins server files live outside this repository:

```text
D:/PSU/Jenkins
```

Start Jenkins from that folder:

```powershell
cd D:/PSU/Jenkins
docker compose up -d --build
```

Open:

```text
http://localhost:8081
```

Read:

- `docs/ci/jenkins-from-zero.md`
- `docs/ci/jenkins.md`
- `docs/ci/pipeline-design.md`

## Commit Style

Use small commits:

```text
docs: add central edge architecture notes
test: add service identity unit tests
feat: add service identity helper
ci: add Jenkins test pipeline
```

## What to Avoid

- Rewriting `apps/api/main.py` broadly in one pass.
- Moving compose/config folders without smoke tests.
- Treating container ID as stable identity.
- Adding monitoring tools that cannot be demonstrated.
- Making Authentik production scope before credentials/environment exist.
