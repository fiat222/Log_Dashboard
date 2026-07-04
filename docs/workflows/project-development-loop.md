# Centralized Observability Platform Project Loop

## Purpose

This document defines the working loop for turning the existing centralized log dashboard into a professional self-hosted observability and monitoring platform.

The project must stay practical for a two-month co-op timeline. The existing log ingestion path is treated as a stable core, not something to rewrite casually.

## Project Direction

Build a Docker Compose-based platform with two installation surfaces:

- Central stack: dashboard, API, storage, telemetry gateway, monitoring services.
- Edge stack: lightweight collectors installed on monitored machines.

The platform remains log-first, then expands into metrics, service health, gateway traffic, database monitoring, alerting, CI/CD, and security checks.

## Core Principle

Do not rewrite stable systems unless there is a clear reason.

Use incremental improvement:

```text
Existing stable log dashboard
  v
Package as central platform
  v
Add edge agent bundle
  v
Add stable service identity
  v
Add monitoring modules
  v
Add CI/CD, security, tests, docs
```

## Phase Alignment

Before starting a feature, check `docs/roadmap/2-month-milestones.md` and confirm the work belongs to the current phase.

Current phase: **Phase 6.1 - Visible Metrics Layer, pending browser verification**.

If the work does not support the current phase, treat it as a scope change and write a lightweight decision review before building.

Phase 5.5 rule: UI redesign work must improve every touched page as a real operator workflow, not as decoration. Admin-facing UI must avoid PSU/EILA-specific wording, URLs, and ownership assumptions; use generic provider and registry language instead.

Phase 6 rule: do not close a monitoring slice from backend/API existence alone. The browser must show visible operational value and at least one useful drill-down path when the slice claims to improve incident investigation.
## Standard AI-Assisted Loop

Every meaningful feature follows this loop:

```text
1. Brief
2. Design
3. ADR
4. Plan
5. Implement
6. Test
7. Security Check
8. Docs Update
9. Demo Scenario
10. Review
```

## 1. Brief

Before implementation, write a short feature brief.

```markdown
## Feature Brief

**Feature:**  
Short feature name.

**Problem:**  
What pain or limitation this solves.

**Goal:**  
What should be true after this feature is done.

**Scope:**  
What this loop will implement.

**Out of Scope:**  
What this loop will not implement yet.

**Success Criteria:**  
Concrete checks that prove the work is done.
```

## 2. Design

Answer these before coding:

- Which module owns this feature?
- What data source does it use?
- Which database stores its state?
- Does it affect existing log ingestion?
- What API does the UI need?
- What should happen on error or missing data?
- How will it be tested?
- How will it be explained in the demo?

## 3. ADR

Write an Architecture Decision Record when a decision affects future development.

Use ADRs for decisions such as:

- Vector as edge collector.
- OTel Gateway as central telemetry gateway.
- ClickHouse as log storage.
- PostgreSQL as platform metadata/config storage.
- Stable service identity using `host_id + compose_project + compose_service`.
- Docker Compose as distribution model.

ADR template:

```markdown
# ADR-0000: Decision Title

## Status

Accepted

## Context

Why this decision is needed.

## Decision

What we decided.

## Consequences

Positive and negative effects.
```

## 4. Plan

Break work into small, testable tasks.

Good task shape:

- One focused outcome.
- Clear files touched.
- Clear test command.
- Clear rollback path.
- Small commit.

Example:

```markdown
### Task: Add stable service identity query

- Add query function that groups container instances by service key.
- Add API response model.
- Add regression test for container recreate.
- Update UI to link service row to log view.
```

## 5. Implement

Implementation rules:

- Preserve existing log dashboard behavior.
- Prefer modular extraction over rewrites.
- Keep vertical slices small.
- Commit often.
- Avoid adding infrastructure that cannot be demonstrated.
- Keep default install simple.

Commit examples:

```text
feat: add service identity model
fix: stabilize container ownership lookup
docs: add edge agent install guide
test: add service aggregation regression
```

## 6. Test

Use the three-phase validation path:

```text
Phase 1: Local machine
Phase 2: VM edge host
Phase 3: Another computer on home network
```

Minimum checks per feature:

- Service starts.
- Existing log ingestion still works.
- New API returns expected data.
- UI handles empty/loading/error states.
- Permissions are enforced in backend.
- Docs match actual commands.

## 7. Security Check

Security checklist:

- [ ] No hardcoded secrets.
- [ ] `.env.example` contains safe placeholder values only.
- [ ] Backend enforces RBAC; UI hiding is not security.
- [ ] Only superadmin can manage members.
- [ ] Last superadmin cannot be deleted or demoted.
- [ ] API validates user input.
- [ ] SQL construction is reviewed for injection risk.
- [ ] Docker ports are exposed only when needed.
- [ ] Gitleaks or equivalent secret scan is clean.
- [ ] Trivy or equivalent container scan is reviewed.

## 8. Docs Update

Every completed loop updates at least one relevant doc:

- `docs/project-charter.md`
- `docs/architecture/central-edge-platform.md`
- `docs/architecture/service-identity.md`
- `docs/deployment/install-central.md`
- `docs/deployment/install-edge.md`
- `docs/testing/testing-strategy.md`
- `docs/user-guide/dashboard-guide.md`

## 9. Demo Scenario

Every milestone needs a demo script.

```markdown
## Demo Scenario

**Scenario:**  
Short name.

**Steps:**
1. Open dashboard.
2. Select host.
3. Select service.
4. Trigger event.
5. Verify UI/logs/alert.

**Expected Result:**  
What the evaluator should see.
```

## Phase Boundary Verification

At the end of a phase, use this exact verification flow before starting the next phase:

1. Run docker compose up -d --build.
2. Run docker system prune.
3. Tell the user exactly what to verify in the webpage.
4. Let the user verify the running stack in the browser.\n5. Only after the user approves and says to continue, run docker compose down.

Rules:

- Use this flow at phase boundaries, not for every small edit or inner-loop test.
- Do not run docker compose down before user approval to continue.
- Treat docker system prune as user-approved for this workflow, even though it is broader than image prune.

## 10. Review

End each loop with:

```markdown
## Review

### What worked

### What broke

### What changed from plan

### Next loop
```

## Lightweight Review Policy

Use lightweight self-review for decisions that affect more than one module, more than one phase, or the final demo. Keep the review short: business value, architecture fit, simpler alternative, risks, test evidence.

Use lightweight review for large decisions:

- Project charter.
- Architecture direction.
- UI/UX direction.
- Risk analysis.
- Milestone planning.
- Final report structure.

Avoid extra review for small tasks:

- CSS tweaks.
- Small query changes.
- Renames.
- Config typo fixes.
- Bug fixes with clear root cause.

## Unclear Scope Rule

Use `grill-with-docs` when the goal, architecture, domain language, or implementation boundary is unclear. The output should sharpen the plan against existing project docs before code changes.

## Discussion Backlog

Record ideas here when they are intentionally deferred until the current plan phase is done.

- Compare geo/WAF options such as BunkerWeb and decide whether they belong in this platform.
- Decide which edge agents should collect data from different gateways and servers, including Nginx, HAProxy, Apache, and Bull-based workers.
- Decide how custom alerts should work in the dashboard, including simple email targets and alert rules that reduce MTTD/MTTR.
- Revisit frontend stack choice after cleanup because the current static SPA is becoming hard to evolve for metric-heavy workflows.
- Revisit backend modularization/performance after cleanup; do not rewrite the stable ingestion path unless profiling or product needs justify it.

## Jenkins Boundary

Jenkins server/job files are intentionally outside this repository at `D:/PSU/Jenkins`. This project keeps only the repository-facing `Jenkinsfile` and CI helper scripts under `tools/ci/scripts/`.
## MVP Boundary

### Must Have

- Central stack installable with Docker Compose.
- Edge stack installable with Docker Compose.
- Docker/app logs visible in dashboard.
- Stable service identity across container recreate.
- Host/service/log view that is easy to understand.
- Superadmin-only member management.
- Central and edge install docs.
- Basic CI/CD.
- Basic security scanning.

### Should Have

- Host metrics.
- Container metrics.
- Database health.
- Gateway traffic view.
- Alert dashboard.
- Responsive UI.
- Light and dark theme.

### Could Have

- Tempo tracing.
- Custom dashboard widgets.
- Advanced Jenkins pipeline.
- SonarQube quality gate.
- Optional WAF/CrowdSec module.

### Won't Have in Two Months

- Grafana-level dashboard builder.
- Plugin marketplace.
- Serious ML prediction.
- Multi-tenant SaaS.
- Kubernetes-native deployment.
- Production Authentik integration.



