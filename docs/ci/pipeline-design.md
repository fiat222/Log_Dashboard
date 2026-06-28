# CI Pipeline Design

## Goal

Build a reliable CI loop for the observability platform without touching the runtime deployment path too early.

## Pipeline Version 1

Version 1 validates the project:

```text
Backend tests
UI tests
Compose config
Security scan placeholder
```

It does not deploy.

## Stage Details

### Backend Unit and API Tests

Command:

```bash
sh ci/scripts/run-backend-tests.sh
```

Purpose:

- Protect pure service identity logic.
- Protect API contracts.

### UI Tests

Command:

```bash
sh ci/scripts/run-ui-tests.sh
```

Purpose:

- Verify browser-visible login flow.
- Prepare for dashboard navigation tests later.

### Compose Config Checks

Command:

```bash
sh ci/scripts/check-compose.sh
```

Purpose:

- Catch invalid YAML.
- Catch missing environment variables.
- Validate central and edge install surfaces.

### Security Checks

Current behavior:

- Run `ci/scripts/security-checks.sh`.
- Run Gitleaks if installed.
- Run Trivy if installed.
- Skip with clear message if unavailable in the local learning image.

Later improvement:

- Install Gitleaks and Trivy in Jenkins image.
- Make scans blocking.
- Archive reports.

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

## Security Note

The local Jenkins CI v1 setup does not mount Docker socket.

This keeps the first CI demo safer. It validates Compose files but does not build, run, or deploy containers.

Production direction:

- isolated agents,
- restricted runner,
- explicit approval before any build/deploy stage gains Docker host access.
