# Tools

Local development tools, CI helpers, and one-off operational utilities live here.

```text
tools/
  ci/scripts/       CI validation scripts
  dev/scripts/      local development helpers
```

## Current State

- Former `ci/scripts/` files have moved to `tools/ci/scripts/`.
- Former `scripts/dev/` files have moved to `tools/dev/scripts/`.
- Jenkins job/server files are intentionally outside this repository at `D:/PSU/Jenkins`.

Keep generated reports and machine-local files out of normal source paths.
