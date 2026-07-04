# Jenkins From Zero

## What Jenkins Does

Jenkins runs repeatable checks for the project:

```text
checkout code
  -> backend tests
  -> UI tests
  -> compose config checks
  -> security checks
```

Later it can build images or deploy, but that is out of scope for CI v1.

## Current Jenkins Folder

Jenkins has been moved out of this repository:

```text
D:/PSU/Jenkins
```

Expected files there:

```text
docker-compose.yml
Dockerfile
README.md
```

## Check Existing Jenkins

```powershell
docker ps -a --filter name=jenkins
```

Current local URL:

```text
http://localhost:8081
```

## Start Local Jenkins

```powershell
cd D:/PSU/Jenkins
docker compose up -d --build
```

Get initial password:

```powershell
docker exec -it jenkins cat /var/jenkins_home/secrets/initialAdminPassword
```

Then create a Pipeline job pointing to this repository and `Jenkinsfile`.

## Recommended Job

```text
New Item -> logs-dashboard-ci -> Pipeline
Definition: Pipeline script from SCM
SCM: Git
Repository URL: <your repo URL>
Branch: main or working branch
Script Path: Jenkinsfile
```

## Pipeline Stages

- Checkout.
- Workspace Info.
- Backend Unit and API Tests.
- UI Tests.
- Compose Config Checks.
- Security Checks.

## Common Problems

### Jenkins is not running

Start it from `D:/PSU/Jenkins` and re-check port `8081`.

### Docker socket dependency

CI v1 should avoid Docker host control. Compose config validation does not require deploy access. Add Docker socket only for a later build/deploy phase with explicit approval.

### Python or Node missing

Rebuild the Jenkins image from `D:/PSU/Jenkins`. The Dockerfile installs Python, Node, npm, and standalone Docker Compose.

### UI test downloads Chromium slowly

The image sets:

```text
PLAYWRIGHT_BROWSERS_PATH=/var/jenkins_home/.cache/ms-playwright
```

The Jenkins home volume keeps the browser cache between runs.

## What Not To Do Yet

Do not deploy from Jenkins until test and scanner evidence are stable.
