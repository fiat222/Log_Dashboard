# Apps

First-party application code lives here.

```text
apps/
  api/          FastAPI backend, auth, RBAC, service health, observability APIs
  web/          dashboard SPA, static assets, Nginx template
  backup/       ClickHouse backup worker API and shell entrypoint
```

## Rules

- Keep app code separate from telemetry runtime config.
- New backend modularization belongs under `apps/api/`.
- New frontend work belongs under `apps/web/` until a framework migration is accepted.
- Do not add environment-specific PSU/EILA assumptions to application code.
