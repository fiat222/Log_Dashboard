# Phase 7 CI And Security Evidence

## Scope

This slice hardens the repository-side CI baseline without touching the external Jenkins server files in `D:/PSU/Jenkins`.

Implemented in this slice:

- backend pytest JUnit output archived under `reports/backend-pytest.xml`;
- Playwright JUnit output archived under `reports/ui-playwright.xml`;
- compose config artifacts archived under `reports/compose-central.yml`, `reports/compose-edge.yml`, and `reports/compose-check.txt`;
- security check artifact archived under `reports/security-checks.txt`;
- Windows local shell compatibility improvements for `sh`-based CI helper scripts.

## Repository Changes

- `Jenkinsfile` now archives all `reports/**` artifacts and imports Playwright JUnit results.
- `tools/ci/scripts/run-backend-tests.sh` now works with `py -3` and Windows virtualenv activation.
- `tools/ci/scripts/run-ui-tests.sh` now uses `cmd.exe //c npm` and `cmd.exe //c npx` when running from Windows Git Bash style shells.
- `tools/ci/scripts/check-compose.sh` now writes archiveable compose outputs under `reports/`.
- `tools/ci/scripts/security-checks.sh` now writes explicit scanner availability results to `reports/security-checks.txt`.

## Local Verification On 2026-07-04

Commands executed:

```text
sh tools/ci/scripts/run-backend-tests.sh
sh tools/ci/scripts/check-compose.sh
sh tools/ci/scripts/security-checks.sh
sh tools/ci/scripts/run-ui-tests.sh
```

Results:

- Backend CI smoke: passed, `34 passed`, JUnit file created.
- Compose config check: passed, central and edge rendered outputs created.
- Security checks: completed with explicit unavailable markers for `gitleaks` and `trivy` on this machine.
- UI smoke: passed, `1 passed`, JUnit file created.

## Remaining Work

- Run the same pipeline from the real Jenkins server at `D:/PSU/Jenkins` and capture job output.
- Install `gitleaks` and `trivy` in the Jenkins environment if Phase 7 should become blocking instead of evidence-only.
- Extend UI smoke coverage from login-only into dashboard navigation and operational paths.
