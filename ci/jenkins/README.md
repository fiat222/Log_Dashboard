# Local Jenkins

This folder runs a local Jenkins controller for learning and CI/CD demos.

It is intentionally separate from the application runtime stack.

## Start

```powershell
docker compose -f ci/jenkins/docker-compose.yml up -d --build
```

Open:

```text
http://localhost:8081
```

Port `8081` is used to avoid colliding with an existing Jenkins installation on `8080`.

## Build Context

The repository has a root `.dockerignore`.

Keep large local folders out of Docker build context:

- `.venv/`
- `node_modules/`
- `reports/`
- `test-results/`
- `playwright-report/`

Without this, Jenkins image builds can look like they are frozen because Docker is sending the whole local workspace to the daemon.

## Playwright Browser Cache

The Jenkins image sets:

```text
PLAYWRIGHT_BROWSERS_PATH=/var/jenkins_home/.cache/ms-playwright
```

That path lives inside the Jenkins home volume, so the first UI test run downloads Chromium and later runs reuse it.

For manual Docker-run checks outside Jenkins, mount a cache volume:

```powershell
docker run --rm --entrypoint sh `
  -v "${PWD}:/workspace" `
  -v logs-dashboard-playwright-cache:/var/jenkins_home/.cache/ms-playwright `
  -w /workspace `
  logs-dashboard-ci-jenkins ci/scripts/run-ui-tests.sh
```

If the cache volume was created as `root` and Playwright cannot write to it, initialize ownership once:

```powershell
docker run --rm --user root --entrypoint sh `
  -v logs-dashboard-playwright-cache:/var/jenkins_home/.cache/ms-playwright `
  logs-dashboard-ci-jenkins `
  -c "mkdir -p /var/jenkins_home/.cache/ms-playwright; chown -R 1000:1000 /var/jenkins_home/.cache/ms-playwright"
```

## Initial Password

```powershell
docker exec -it logs-dashboard-jenkins cat /var/jenkins_home/secrets/initialAdminPassword
```

## Stop

```powershell
docker compose -f ci/jenkins/docker-compose.yml down
```

## Important Security Note

This local Jenkins does not mount Docker socket in CI v1.

It can validate Compose files with the standalone `docker-compose` binary without controlling the host Docker daemon.

If future stages need to build or deploy containers, use isolated Jenkins agents or a restricted runner.
