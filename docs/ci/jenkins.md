# Jenkins workflow

This project keeps Jenkins as a learning-friendly CI runner for the centralized
observability platform. The pipeline is intentionally simple: checkout, backend
tests, UI tests, compose validation, then security checks.

## Start Jenkins

From the repository root:

```powershell
docker compose -f ci/jenkins/docker-compose.yml up -d
```

Open Jenkins at:

```text
http://localhost:8081
```

## Local manual check inside the Jenkins container

The Jenkins compose file mounts this repository at `/workspace`, so you can run
the same CI scripts without starting extra containers:

```powershell
docker exec -it logs-dashboard-jenkins sh
cd /workspace
sh ci/scripts/run-backend-tests.sh
sh ci/scripts/run-ui-tests.sh
sh ci/scripts/check-compose.sh
sh ci/scripts/security-checks.sh
```

## Pipeline stages

1. `Backend Unit and API Tests`
   - Creates `.venv`
   - Installs `backend/requirements-dev.txt`
   - Runs `pytest tests/backend`
   - Writes `reports/backend-pytest.xml`

2. `UI Tests`
   - Runs `npm ci` or `npm install`
   - Installs Chromium for Playwright if missing
   - Runs `npm run test:ui`

3. `Compose Config Checks`
   - Validates central compose config
   - Validates edge compose config
   - Does not start the stack

4. `Security Checks`
   - Runs `gitleaks` if available
   - Runs `trivy fs` if available
   - Skips tools that are not installed yet

## Notes

- Jenkins is not required for normal app runtime.
- The main observability stack should still be run from the root
  `docker-compose.yml`.
- For this project phase, Jenkins is used to make testing repeatable and easy to
  demonstrate during cooperative education review.
