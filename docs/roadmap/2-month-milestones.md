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

### Lightweight Review Policy

Use small-token self-review to reduce approval burden without adding ceremony.

Use lightweight review for:

- Phase planning.
- Architecture decisions.
- UI/UX direction.
- Central-edge model changes.
- Service identity changes.
- Risk analysis.
- Final report and demo narrative.

Skip extra review for:

- Small CSS fixes.
- Minor query edits.
- Copy changes.
- Clear bug fixes with known root cause.
- Formatting-only changes.

The agent may proceed without user approval for normal planned work after brief self-review. User approval is still required for phase gates, destructive operations, deployment promotion, data deletion, migrations, auth/security policy changes, or scope changes.

### AI Working Style

- Use Superpowers planning for large multi-step work.
- Use `graphify-out/GRAPH_REPORT.md` before codebase-wide questions.
- Use small vertical slices: clear boundary, testable outcome, visible value.
- Use Karpathy-style context gathering: read the raw project sources and docs before inventing abstractions.
- Preserve the stable log ingestion path unless there is a documented reason to change it.

## Current Position

Current phase: **Phase 6.5 - Alerting MVP, awaiting browser verification**.

Completed or mostly completed:

- Phase 1: Project Foundation.
- Phase 2: Central Packaging.
- Phase 3: Edge Agent.
- Phase 4: Stable Service Identity.

Active work:

- Redesign the dashboard experience across Overview, Logs, Platform, Analytics, Network, Patterns, and Admin.
- Remove PSU/EILA-specific wording and links from visible UI, starting with Admin and login-adjacent admin surfaces.
- Continue Phase 6 monitoring modules with the Monitoring Overview as the first post-login surface.
- Keep alerting MVP scoped to custom rule management and test evidence before live evaluation.

Recently completed:

- Phase 5: Platform UI Shell.

Current risk:

- The worktree contains many uncommitted mini-project changes. Before large implementation, freeze the current baseline with an intentional commit or at minimum inspect/stage changes carefully.

## Deferred Discussion Queue

Use this section for ideas that matter but should be discussed after the current plan slice is done.

- 2026-06-30: Geo / bunker / WAF direction for the Network module.
- 2026-06-30: Collector strategy for mixed gateways and proxies such as Nginx, HAProxy, Apache, Caddy, and similar sources.

## Phase Overview

| Phase | Name | Status | Main Gate |
|---:|---|---|---|
| 0 | Baseline Freeze and Repo Hygiene | Complete | Current work is reviewable and recoverable; repository layout has a production migration path |
| 1 | Project Foundation | Mostly done | New AI session can understand the project from docs |
| 2 | Central Packaging | Mostly done | Central install path is documented and smoke-testable |
| 3 | Edge Agent | Mostly done | Edge stack renders and has a VM validation plan |
| 4 | Stable Service Identity | Mostly done | Recreated containers map to stable logical services |
| 5 | Platform UI Shell | Complete | UI reads as observability platform, logs preserved |
| 5.5 | Product UI Redesign and Admin Neutralization | Active | Every page has a stronger production UI and Admin has no PSU-specific surface |
| 6 | Monitoring and Investigation Cockpit | Re-scoped into 6.0-6.6 | Monitoring overview, host/container diagnostics, workload DB monitoring, alerting, and incident evidence |
| 7 | CI/CD and Security Evidence | Planned | CI and security story is demonstrable |
| 8 | Final Demo and Defense | Planned | Project can be installed, demoed, and defended |

## Phase 0: Baseline Freeze and Repo Hygiene

Goal:

- Make the current mini-project upgrade safe to continue.
- Move the repository toward a production-style layout without breaking the working compose stack.

Deliverables:

- Review dirty worktree.
- Separate intentional project files from temporary files.
- Confirm `.gitignore` covers generated/cache artifacts.
- Commit or otherwise preserve the current baseline before large edits.
- Record known active branch/state for future AI sessions.
- Add target layout directories: `apps/`, `infra/`, `deploy/`, `tools/`, and `archive/`.
- Update repository layout docs and cleanup migration order.

Exit gate:

- A future agent can run `git status` and understand what is intentional.
- No important mini-project work exists only as unclear untracked files.
- Root `docker-compose.yml` still works while the production layout migration is staged.
- Runtime moves have matching path updates and validation evidence.

Evidence:

- `git status --short` summary.
- Commit hash or written baseline note.
- List of intentionally untracked files, if any remain.
- `docs/project-structure.md`.
- `docs/development/repo-cleanup-plan.md`.

Status:

- Complete. User verified the rebuilt stack opened successfully after the production layout migration.

Next action:

- Continue with Phase 5.5 Product UI Redesign and Admin Neutralization before starting Phase 6.1 visible metrics.

## Phase 1: Project Foundation

Goal:

- Define what the mini-project is and how future AI sessions should work on it.

Deliverables:

- Project charter.
- Central-edge architecture.
- Stable service identity design.
- AI-assisted workflow.
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

- Complete as of 2026-06-29.

Evidence:

- `docs/evidence/phase5-platform-cockpit.md`.
- `docs/evidence/phase5-running-stack-smoke.md`.
- Screenshots under `docs/evidence/phase5-*.png`.

Next action:

- Carry the Platform shell into Phase 5.5 UI redesign before Phase 6 monitoring modules.

## Phase 5.5: Product UI Redesign and Admin Neutralization

Goal:

- Make the product feel like a production observability tool on every page, not a patched legacy dashboard.
- Remove PSU/EILA-specific visible UI and Admin-facing assumptions so the project can be presented as a generic self-hosted observability platform.

Design direction:

- Audience: operators and developers investigating incidents.
- Tone: dense, calm, technical, and fast to scan.
- Layout: reduce nested card clutter, keep tables and controls compact, and make each page's primary workflow obvious.
- Visual signature: service-path investigation, where Overview, Logs, Platform, Network, Patterns, and Admin share the same operational vocabulary.

Deliverables:

- Redesign Overview, Logs, Platform, Analytics, Network, Patterns, and Admin page surfaces.
- Normalize copy, spacing, buttons, forms, empty states, and drill-down actions.
- Remove PSU/EILA-specific text, URLs, and Admin-facing ownership assumptions from visible UI.
- Replace hardcoded PSU registry ownership matching with configurable generic registry matching or a disabled-by-default state.
- Keep existing workflows reachable while improving layout and clarity.

Exit gate:

- User can open every tab and see a visibly improved, consistent production interface.
- Admin page contains no PSU/EILA-specific wording or links.
- Login and admin-adjacent UI use generic SSO/provider wording.
- Existing log search, network analytics, platform health, backup, ownership, notifications, and clear-database flows still work or degrade cleanly.

Evidence:

- Browser verification for each visible tab.
- Frontend asset tests and login smoke test.
- Backend tests for generic ownership behavior if backend ownership logic changes.
- Known limitations documented before Phase 6.1 starts.

Status:

- Active. First slice: remove PSU/EILA-specific visible UI and Admin-facing assumptions.

Next action:

- Complete Admin neutralization, then redesign the Admin layout as the first full-page UI pass.

## Phase 6: Monitoring and Investigation Cockpit

Goal:

- Turn the dashboard from a log viewer with an overview into a Centralized Monitoring and Investigation Cockpit.
- A user must be able to monitor current health and metrics, then investigate: what is unhealthy, which layer is suspected, what evidence supports it, and where to drill down next.

Primary workflow:

```text
Symptom -> Suspected layer -> Evidence -> Drill-down
```

Phase 6 is split into small visible slices. Do not mark Phase 6 complete just because a panel exists. Each slice must show useful data in the browser and must either drill into evidence or clearly explain which collector/configuration is missing.

### Phase 6.0: Reframe And Clean Current Surface

Deliverables:

- Rename misleading legacy surfaces where needed.
- Remove broken glyph/mojibake UI from visible controls.
- Keep Overview, Logs, Platform, Analytics, Network, Patterns, and Admin reachable.
- Mark current limitations honestly in evidence docs.

Exit gate:

- Browser does not show broken glyphs or Thai-like mojibake from dashboard shell files.
- User can identify which modules are real and which are still shell/health-only.

Status:

- In progress. User verification reported glyph bugs, so this remains unresolved until browser verification passes.

### Phase 6.1: Monitoring Overview Metrics

Deliverables:

- Make the first post-login page a Monitoring Overview.
- Show visible metrics, not only log totals: request rate, error rate, p95 latency, 5xx count, service health, uptime state, ingest freshness, and collector-backed host/container/database placeholders where sources are missing.
- Show status by layer: Host, Container, Application, Gateway, Workload Database, Pipeline, Alerts.
- Add clear empty states that explain how to install or enable missing collectors.
- At least one gateway or service metric drills into Network or Logs with matching filters.

Exit gate:

- User can open the dashboard and immediately see real operational metrics and honest missing-source states.
- The Overview communicates monitoring, not only log search.

Status:

- Active. Gateway metrics exist; host/container/database/pipeline states must be promoted into the Overview next.

### Phase 6.2: Host And Container Diagnostics

Deliverables:

- Show CPU, memory, disk, network, load, and uptime when a host metrics source exists.
- Show running, unhealthy, restarted, OOM-killed, exited, and silent containers/services.
- Use Docker runtime health as fallback when cAdvisor/node_exporter are not available.
- Show collector heartbeat and last telemetry time.

Exit gate:

- User can identify a service that died, restarted, went silent, or likely hit resource pressure and drill into logs/events around that time.

Status:

- Implemented Docker runtime fallback diagnostics for restarted, OOM-killed, exited, and unhealthy containers. CPU/memory/disk collector metrics remain pending.

### Phase 6.3: Gateway, App, And Log Correlation

Deliverables:

- Show request rate, 4xx/5xx, p95 latency, slow paths, and top failing routes from available gateway sources.
- Support mixed gateway direction in docs: Nginx, HAProxy, Apache, Caddy, and future WAF/BunkerWeb discussion.
- Correlate gateway symptom windows with service logs and runtime events.

Exit gate:

- User can start from 503, 404, or slow path metrics and reach the matching logs/network evidence.

Status:

- Gateway/app evidence window implemented on Platform. It correlates 5xx, 4xx, p95 latency, and app error logs for the same one-hour window, with drill actions to Network and Logs. Browser verification pending.

### Phase 6.4: Workload Database Monitoring

Deliverables:

- Distinguish platform databases from workload databases on monitored hosts.
- Add database profile model for PostgreSQL, MySQL/MariaDB, Redis, ClickHouse, and later MongoDB.
- Show availability, connection pressure, memory/disk where available, slow query evidence where configured, and clean `not configured` states.
- Document secure read-only credential or exporter setup.

Exit gate:

- User can tell whether a monitored app database is unavailable, saturated, slow, or not configured for monitoring.

Status:

- Implemented first profile-based workload database slice. `/api/platform/workload-databases` reads `WORKLOAD_DATABASE_PROFILES`, keeps DSNs out of the response, probes PostgreSQL/Redis/ClickHouse lightly, and reports unsupported DBs as exporter/probe-needed. Browser verification pending.

### Phase 6.5: Alerting MVP

Deliverables:

- Add custom alert rule UI with rule name, source, condition, severity, recipients, cooldown, and enabled state.
- Add email recipient capture for simple notifications.
- Add alert history with firing/recovered states and deduplication.
- Add test alert action.

Exit gate:

- User can create one practical alert and see it recorded/sent or cleanly queued with evidence.

Status:

- In progress. Admin surface now supports custom rule create/update/test and reuses notifications for alert history. Live evaluation and recovery flow still pending.

### Phase 6.6: Incident Evidence Timeline And AI Evidence Boundary

Deliverables:

- Create one demo path: Detect -> Correlate -> Investigate -> Alert.
- Add incident evidence timeline for one service/time window.
- Generate a bounded Incident Evidence Bundle for future AI inspection via API key.
- Document what reliability problems this detects versus what it cannot automatically fix.

Exit gate:

- Demo shows a realistic incident investigation, not separate disconnected dashboard pages.
- AI integration boundary is safe: scoped evidence bundle, not raw unrestricted DB access.

Status:

- Implemented slice. Platform view now renders a service-scoped incident evidence timeline, bounded evidence bundle copy action, and explicit detects versus does-not-fix notes. Browser verification still required.

Phase 6 final exit gate:

- Overview is a Monitoring Overview with visible metrics and layer status.
- Host/container diagnostics, gateway/app/log correlation, workload database monitoring, alerting, and incident evidence each have a visible, testable slice.
- At least two signals drill down into exact logs, network rows, runtime events, or timeline evidence behind the signal.
- Missing collectors or unsupported metrics degrade gracefully and are documented.

Evidence required:

- User browser verification for each Phase 6 slice.
- Backend/API query evidence for each metric source.
- Automated checks for dashboard asset wiring and relevant backend contracts.
- Known limitations for collector coverage, especially CPU/memory, workload database signals, and distributed tracing.

Next action:

- Verify Phase 6.4 in the browser, then continue to Phase 6.5 alerting MVP.

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

- In progress. Jenkinsfile and CI helper scripts now emit archiveable compose/security evidence and JUnit output for backend and UI smoke checks; live Jenkins run evidence still pending.

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
