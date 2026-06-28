# BMAD Usage Guide

## Purpose

BMAD should help with high-level thinking without consuming unnecessary token budget.

This project uses BMAD for decisions that shape the product, architecture, or final report. It should not be used for every small code edit.

## Use BMAD For

- Project charter.
- Architecture options.
- Central-edge distribution model.
- UI/UX direction.
- Service identity design.
- Milestone planning.
- Risk analysis.
- Final report outline.
- Demo narrative.

## Avoid BMAD For

- Small CSS changes.
- Minor query edits.
- Variable renaming.
- Small config fixes.
- Bug fixes with clear root cause.
- Formatting.

## BMAD Loop

```text
Business Need
  ↓
Model / Architecture
  ↓
Action Plan
  ↓
Delivery / Demo
```

## Prompt Template

```markdown
## BMAD Request

**Context:**  
Current project state.

**Business Need:**  
Why this matters for the co-op project or user.

**Model / Architecture Question:**  
What needs to be decided.

**Constraints:**  
Time, existing system, tools, deployment limits.

**Expected Output:**  
Decision, trade-offs, risks, next actions.
```

## Token Budget Rule

Use BMAD only when the answer affects more than one module or more than one week of work.

If the task can be finished and tested in one short coding session, skip BMAD and use the normal project loop.

