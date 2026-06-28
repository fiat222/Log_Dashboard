# Jenkins From Zero

## What Jenkins Does

Jenkins runs repeatable workflows for the project.

For this project, Jenkins should run:

```text
checkout code
  ↓
backend tests
  ↓
UI tests
  ↓
compose config checks
  ↓
security checks
```

Later it can build images, push registry tags, and deploy.

## Check Existing Jenkins

On Windows, check service:

```powershell
Get-Service -Name '*jenkins*' -ErrorAction SilentlyContinue
```

Check Docker containers:

```powershell
docker ps -a --filter "name=jenkins"
```

If another Jenkins already uses port `8080`, this project uses `8081`.

## Start Local Jenkins

```powershell
docker compose -f ci/jenkins/docker-compose.yml up -d --build
```

Open:

```text
http://localhost:8081
```

Get initial password:

```powershell
docker exec -it logs-dashboard-jenkins cat /var/jenkins_home/secrets/initialAdminPassword
```

Then:

1. Install suggested plugins.
2. Create admin user.
3. Create a Pipeline job.
4. Point the job to this repository and `Jenkinsfile`.

## First Pipeline Job

In Jenkins:

```text
New Item
  → logs-dashboard-ci
  → Pipeline
```

Recommended setup:

```text
Definition: Pipeline script from SCM
SCM: Git
Repository URL: <your repo URL>
Branch: main or your working branch
Script Path: Jenkinsfile
```

If the repository is not pushed to Git yet, use a temporary pipeline script and run local shell checks manually.

## Pipeline Stages

The current `Jenkinsfile` has these stages:

| Stage | Purpose |
|---|---|
| Checkout | Clone code. |
| Workspace Info | Print branch/commit and workspace files. |
| Backend Unit and API Tests | Run pytest backend suite. |
| UI Tests | Run Playwright login UI test. |
| Compose Config Checks | Validate central and edge compose configuration. |
| Security Checks | Run Gitleaks/Trivy if installed. |

## Common Problems

### Docker is not running

Symptom:

```text
failed to connect to the docker API
```

Fix:

- Start Docker Desktop.
- Re-run the Jenkins compose command.

Note:

The Jenkins CI v1 pipeline validates Compose files with standalone `docker-compose`, so the pipeline itself does not need Docker socket access.

### Docker config permission warning

Symptom:

```text
Error loading config file: C:\\Users\\...\\.docker\\config.json: Access is denied
```

Fix:

- For local checks, start Docker Desktop normally.
- If using Jenkins in Docker, avoid relying on host user Docker config.

### Python or Node missing

The local Jenkins image in `ci/jenkins/Dockerfile` installs:

- Python 3
- pip
- venv
- Node.js
- npm
- standalone Docker Compose v2 binary

Rebuild Jenkins image if dependencies are missing:

```powershell
docker compose -f ci/jenkins/docker-compose.yml up -d --build
```

### Jenkins image build looks frozen

Symptom:

```text
docker build runs for a long time with little useful output
```

Most common cause:

- Docker is sending a huge build context.
- Local folders such as `.venv/`, `node_modules/`, `reports/`, or Playwright artifacts are not ignored.

Fix:

- Keep the root `.dockerignore` file.
- Re-run the Jenkins compose build.

### UI test downloads Chromium slowly

The first Playwright run downloads Chromium.

The Jenkins image stores it under:

```text
/var/jenkins_home/.cache/ms-playwright
```

Because Jenkins home is a Docker volume, later runs should reuse the browser cache.

If Docker Desktop restarts during the first download, start Docker again and rerun the same pipeline. It is safe to retry.

## What Not To Do Yet

Do not deploy from Jenkins until tests are stable.

Initial Jenkins scope:

- test
- validate config
- scan security

Later scope:

- build image
- push registry
- deploy central stack
