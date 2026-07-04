# Deploy

Deployment, promotion, and release automation lives here.

```text
deploy/
  deploy.sh              remote rollout helper
  deploy-registry.ps1    image build/push helper
  promote.ps1            promotion helper
```

Restore documentation moved to `docs/deployment/restore-backup.md` because it is an operator procedure, not a deploy script.

## Rules

- Keep root compatibility commands until the final compose path is stable.
- Do not mix deployment scripts with app source or telemetry config.
- Jenkins job/server files are intentionally outside this repository at `D:/PSU/Jenkins`.
