# Mini-Project Master Phase Plan

## Purpose

This is the master plan for upgrading the Logs Dashboard into a self-hosted centralized observability and monitoring mini-project.

Use this file to answer:

- What phase is the project in now?
- What must be finished before the next phase?
- What evidence proves the phase is complete?
- What should the agent build next?

The project favors working vertical slices, clear demo evidence, and defendable architecture over many unfinished features.

## Operating Rules

### Plan Before Build

Every meaningful feature starts with a plan before code changes.

Use this order:

1. Read this master phase plan.
2. Read `docs/workflows/project-development-loop.md`.
3. Confirm the feature belongs to the current phase.
4. Write the brief/design/plan for the feature.
5. Build only after the plan is clear.
6. Test and collect evidence before marking a phase complete.

If the goal, scope, architecture, or terminology is unclear, use `grill-with-docs` before implementation. The purpose is to challenge the plan against project docs, not to add ceremony.

### BMAD Review Policy

Use BMAD to reduce user approval burden.

BMAD loop:

```text
Business Need -> Model / Architecture -> Action Plan -> Delivery / Demo
```

Use BMAD for:

- Phase planning.
- Architecture decisions.
- UI/UX direction.
- Central-edge model changes.
- Service identity changes.
- Risk analysis.
- Final report and demo narrative.

Skip BMAD for:

- Small CSS fixes.
- Minor query edits.
- Copy changes.
- Clear bug fixes with known root cause.
- Formatting-only changes.

The agent may proceed without user approval for normal planned work after BMAD/self-review. User approval is still required for phase gates, destructive operations, deployment promotion, data deletion, migrations, auth/security policy changes, or scope changes.

### AI Working Style

- Use Superpowers planning for large multi-step work.
- Use `graphify-out/GRAPH_REPORT.md` before codebase-wide questions.
- Use small vertical slices inspired by Matt Pocock-style implementation discipline: clear boundary, testable outcome, visible value.
- Use Karpathy-style context gathering: read the raw project sources and docs before inventing abstractions.
- Preserve the stable log ingestion path unless there is a documented reason to change it.

## Current Position

Current phase: **Phase 5 - Platform UI Shell, in progress**.

Completed or mostly completed:

- Phase 1: Project Foundation.
- Phase 2: Central Packaging.
- Phase 3: Edge Agent.
- Phase 4: Stable Service Identity.

Active work:

- Finish platform UI shell so the product feels like an observability platform, not only a log viewer.
- Keep existing Logs, Nginx, Analytics, Patterns, and Admin workflows reachable.
- Add clear navigation and placeholder/full modules for Services, Infrastructure, Gateways, Databases, Uptime, Alerts, and Settings as phase scope allows.

Next phase:

- Phase 6: Monitoring Modules.

Current risk:

- The worktree contains many uncommitted mini-project changes. Before large implementation, freeze the current baseline with an intentional commit or at minimum inspect/stage changes carefully.

## Phase Overview

| Phase | Name | Status | Main Gate |
|---:|---|---|---|
| 0 | Baseline Freeze and Repo Hygiene | Needed before major new work | Current work is reviewable and recoverable |
| 1 | Project Foundation | Mostly done | New AI session can understand the project from docs |
| 2 | Central Packaging | Mostly done | Central install path is documented and smoke-testable |
| 3 | Edge Agent | Mostly done | Edge stack renders and has a VM validation plan |
| 4 | Stable Service Identity | Mostly done | Recreated containers map to stable logical services |
| 5 | Platform UI Shell | In progress | UI reads as observability platform, logs preserved |
| 6 | Monitoring Modules | Planned | Demo shows logs plus metrics/health path |
| 7 | CI/CD and Security Evidence | Planned | CI and security story is demonstrable |
| 8 | Final Demo and Defense | Planned | Project can be installed, demoed, and defended |

## Phase 0: Baseline Freeze and Repo Hygiene

Goal:

- Make the current mini-project upgrade safe to continue.

Deliverables:

- Review dirty worktree.
- Separate intentional project files from temporary files.
- Confirm `.gitignore` covers generated/cache artifacts.
- Commit or otherwise preserve the current baseline before large edits.
- Record known active branch/state for future AI sessions.

Exit gate:

- A future agent can run `git status` and understand what is intentional.
- No important mini-project work exists only as unclear untracked files.

Evidence:

- `git status --short` summary.
- Commit hash or written baseline note.
- List of intentionally untracked files, if any remain.

Status:

- Needed before major new implementation.

Next action:

- Inspect current dirty worktree and commit the roadmap/docs/code baseline intentionally.

## Phase 1: Project Foundation

Goal:

- Define what the mini-project is and how future AI sessions should work on it.

Deliverables:

- Project charter.
- Central-edge architecture.
- Stable service identity design.
- AI/BMAD workflow.
- ADR baseline.
- Documentation index.

Exit gate:

- A new AI session can understand project direction from docs.
- Major architecture decisions are recorded.

Evidence:

- `docs/project-charter.md`.
- `docs/architecture/central-edge-platform.md`.
- `docs/architecture/service-identity.md`.
- `docs/workflows/project-development-loop.md`.
- ADR files under `docs/adr/`.

Status:

- Mostly done.

Next action:

- Keep docs updated when later phases change architecture.

## Phase 2: Central Packaging

Goal:

- Make the current root compose understandable as the central stack and define the migration path to `central/`.

Deliverables:

- Central install guide.
- Central environment model.
- Compose profile plan.
- Smoke test checklist.
- Backup and external DB notes.
- `central/` folder as future install surface.

Exit gate:

- Existing root compose is documented as the current central stack.
- Migration path to `central/` is clear and does not break local dev.

Evidence:

- `docs/deployment/install-central.md`.
- `central/README.md`.
- Compose config check output.
- Local smoke test notes.

Status:

- Mostly done.

Next action:

- Do not move runtime services into `central/` until smoke tests prove the current stack still works.

## Phase 3: Edge Agent

Goal:

- Provide an installable monitored-host collector stack.

Deliverables:

- Edge compose skeleton.
- Vector edge config.
- node_exporter.
- cAdvisor.
- Edge install guide.
- Edge host identity rules.

Exit gate:

- Edge compose renders with `.env.example`.
- Vector config contains central endpoint and edge metadata.
- VM validation plan is ready.

Evidence:

- `edge/docker-compose.yml`.
- `edge/vector/vector.toml`.
- `edge/README.md`.
- `docs/deployment/install-edge.md`.
- `docker compose --env-file edge/.env.example -f edge/docker-compose.yml config`.

Status:

- Mostly done.

Next action:

- Validate from a VM edge host during Phase 6 or final evidence collection.

## Phase 4: Stable Service Identity

Goal:

- Group runtime containers under stable logical services so recreated containers keep history and ownership context.

Deliverables:

- Service identity parser.
- Service aggregation query.
- `/api/services` endpoint.
- `/api/overview` endpoint.
- UI service sidebar transition with container fallback.
- Container recreate tests.

Exit gate:

- Recreated containers can be associated with the same logical service.
- Dashboard can show service-level grouping.
- Container fallback still works when service metadata is missing.

Evidence:

- Backend unit/API tests for identity and service query.
- UI evidence of service grouping.
- Recreate test notes or automated test.

Status:

- Mostly done.

Next action:

- Carry service identity into the Platform UI Shell and Monitoring Modules.

## Phase 5: Platform UI Shell

Goal:

- Make the dashboard feel like a centralized observability platform while preserving log-first workflows.

Deliverables:

- Overview module.
- Logs module preserved.
- Services module or service-centric sidebar.
- Infrastructure module shell.
- Gateways module shell.
- Databases module shell.
- Uptime module shell or navigation slot.
- Alerts/settings navigation.
- Light theme default and dark theme toggle.

Exit gate:

- First screen communicates "observability platform", not only "log table".
- Existing log search, filters, live stream, context modal, Nginx, Analytics, Patterns, and Admin flows remain reachable.
- Empty states make incomplete modules look intentional, not broken.

Evidence:

- Screenshots of Overview, Logs, Services/sidebar, and at least one module shell.
- UI smoke test or manual checklist.
- Notes confirming old log workflows still work.

Status:

- In progress.

Next action:

- Finish navigation/module shell and tighten Overview -> Services -> Logs investigation flow.

## Phase 6: Monitoring Modules

Goal:

- Add enough monitoring depth to prove the platform is more than a log dashboard.

Deliverables:

- Host metrics view.
- Container metrics view.
- Database health view.
- Gateway traffic view.
- Basic uptime check design or implementation.
- Logs drill-down from health/metric signals where practical.

Exit gate:

- Demo can show logs plus at least one real metrics or health path.
- Missing optional services degrade gracefully.
- Monitoring modules do not introduce a second confusing query model unless documented.

Evidence:

- Screenshot of host/container metrics or health.
- Backend/API query evidence.
- Local or VM test notes.
- Known limitations for metrics collection.

Status:

- Planned.

Next action:

- Choose first vertical slice: host health, container health, or gateway health.

## Phase 7: CI/CD and Security Evidence

Goal:

- Make quality and security demonstrable for the mini-project defense.

Deliverables:

- Jenkins pipeline baseline.
- Automated backend smoke checks.
- Automated frontend smoke checks.
- Docker Compose config check.
- Gitleaks or equivalent secret scan.
- Trivy or equivalent filesystem/image/config scan.
- Optional SonarQube evidence.

Exit gate:

- CI/CD story is demonstrable.
- Security is represented with evidence, not claims.
- Skipped scanners are explicitly marked as unavailable, not silently ignored.

Evidence:

- Jenkins screenshot or command output.
- Test command output.
- Compose check output.
- Security scan output.

Status:

- Planned, with some CI files already present.

Next action:

- Run and document the current CI scripts after Phase 5/6 stabilize.

## Phase 8: Final Demo and Defense

Goal:

- Package the project into a clear final mini-project story.

Deliverables:

- Final demo script.
- Screenshots.
- Testing evidence.
- User/admin guide.
- Known limitations.
- Future work.
- Final report outline.

Exit gate:

- Project can be explained, installed, demoed, and defended.
- Demo follows a realistic incident/investigation story.
- Limitations are honest and tied to future work.

Evidence:

- Demo script.
- Screenshot folder or report assets.
- Testing evidence log.
- Final report outline.

Status:

- Planned.

Next action:

- Collect evidence continuously from Phase 5 onward so final week is polish, not archaeology.

## Scope Control

Must finish:

- Central/edge model.
- Log-first dashboard.
- Stable service identity.
- Basic monitoring.
- Docs and demo evidence.
- Basic CI/CD and security evidence.

Should finish:

- Service-centric UI shell.
- Host/container metrics.
- Database or gateway health.
- Uptime module shell.
- Alert dashboard shell.

Cut first if time is short:

- Full tracing.
- ML prediction.
- Plugin marketplace.
- Grafana-like dashboard builder.
- Production Authentik integration.
- Kubernetes-native deployment.

## Source of Truth

Use these files in this order:

1. `docs/roadmap/2-month-milestones.md` - master phase plan.
2. `docs/workflows/project-development-loop.md` - feature working loop.
3. `docs/project-charter.md` - project goal and scope.
4. `.codex/project/SESSION_START.md` - fast AI session startup.
5. `.codex/project/AI_CONTEXT.md` - agent context and current direction.
6. `.codex/project/AI_WORKFLOW_PROMPTS.md` - prompt templates, not the master plan.
