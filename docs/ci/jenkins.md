# Jenkins workflow

Jenkins is a separate local CI server for this project. It is not part of the application runtime stack.

## Current Location

```text
D:/PSU/Jenkins
```

The running container is named `jenkins` and is served at:

```text
http://localhost:8081
```

## Start Jenkins

From `D:/PSU/Jenkins`:

```powershell
docker compose up -d --build
```

Check it from any shell:

```powershell
docker ps -a --filter name=jenkins
```

Get first setup password:

```powershell
docker exec -it jenkins cat /var/jenkins_home/secrets/initialAdminPassword
```

## Pipeline Scope

Current Jenkins scope is evidence and repeatability only:

1. Backend tests.
2. UI tests.
3. Compose config checks.
4. Security checks when tools are available.

Do not deploy from Jenkins yet. Do not add image push or production deployment until tests and scanner evidence are stable.

## Repository Job

Use a Pipeline job that points to this repository and `Jenkinsfile`. The `Jenkinsfile` still lives in the Log Dashboard repo, while the Jenkins server files live in `D:/PSU/Jenkins`.

## Docker Socket Rule

CI v1 should not need Docker host control. It can run tests and validate compose files without deploying. If a later stage needs Docker builds, use a restricted agent or make the Docker socket mount an explicit, documented exception.
