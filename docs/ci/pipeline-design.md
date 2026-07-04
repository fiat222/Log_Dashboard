# CI Pipeline Design

## Goal

Build a reliable CI loop for the observability platform without touching the runtime deployment path too early.

## Pipeline Version 1

Version 1 validates the project:

```text
Backend tests
UI tests
Compose config
Security checks with explicit unavailable markers
```

It does not deploy.

## Stage Details

### Backend Unit and API Tests

Command:

```bash
sh tools/ci/scripts/run-backend-tests.sh
```

Purpose:

- Protect pure service identity logic.
- Protect API contracts.

### UI Tests

Command:

```bash
sh tools/ci/scripts/run-ui-tests.sh
```

Purpose:

- Verify browser-visible login flow.
- Prepare for dashboard navigation tests later.
- Emit `reports/ui-playwright.xml` for Jenkins test evidence.

### Compose Config Checks

Command:

```bash
sh tools/ci/scripts/check-compose.sh
```

Purpose:

- Catch invalid YAML.
- Catch missing environment variables.
- Validate central and edge install surfaces.
- Save rendered configs under `reports/` for archiveable CI evidence.

### Security Checks

Current behavior:

- Run `tools/ci/scripts/security-checks.sh`.
- Run Gitleaks if installed.
- Run Trivy if installed.
- Skip with clear message if unavailable in the local learning image.
- Save the result to `reports/security-checks.txt` so the absence is explicit in CI artifacts.

Later improvement:

- Install Gitleaks and Trivy in Jenkins image.
- Make scans blocking for all CI environments.
- Promote text output to SARIF or JSON when scanners are installed in Jenkins.

## Future Pipeline Versions

### Version 2: Build Images

Add:

- backend image build.
- dashboard image build.
- backup image build.

### Version 3: Push Registry

Add:

- registry credentials.
- image tags.
- push to registry.

### Version 4: Deploy

Add:

- deploy script.
- approval gate.
- rollback notes.
- explicit Docker host access design if builds/deploys require it.

## Security Note

Jenkins runs outside this repo from `D:/PSU/Jenkins`. CI v1 should not mount the Docker socket.

This keeps the first CI demo safer. It validates Compose files but does not build, run, or deploy containers.

Production direction:

- isolated agents,
- restricted runner,
- explicit approval before any build/deploy stage gains Docker host access.
