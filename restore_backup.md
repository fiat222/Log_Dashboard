# Restore from Backup

Backups live in `/mnt/Logstore_backup` on the host.

PostgreSQL is hosted externally (`postgresql`) — restore is handled by that server's DBA.

This guide covers **ClickHouse only**.

---

## Restore ClickHouse

Backup file: `ch_observability_YYYYMMDD_HHMMSS.tar.gz`

The volume mount maps `/mnt/Logstore_backup` on the host → `/var/lib/clickhouse/user_files/backups/` inside the container. ClickHouse `RESTORE` reads from this path using `File('backups/...')`.

### Step 1 — Extract the archive on the host

```bash
cd /mnt/Logstore_backup
tar -xzf ch_observability_YYYYMMDD_HHMMSS.tar.gz
# Creates: /mnt/Logstore_backup/ch_observability_YYYYMMDD_HHMMSS/
```

### Step 2 — Run RESTORE inside ClickHouse

```bash
docker exec -it clickhouse clickhouse-client \
  --user $CLICKHOUSE_USER --password $CLICKHOUSE_PASSWORD
```

```sql
-- WARNING: drops all current logs before restoring
DROP DATABASE IF EXISTS observability;

RESTORE DATABASE observability
FROM File('backups/ch_observability_YYYYMMDD_HHMMSS/');
```

### Step 3 — Verify

```sql
SELECT count() FROM observability.otel_logs_local;
SELECT min(Timestamp), max(Timestamp) FROM observability.otel_logs_local;
```

### Step 4 — Clean up extracted folder

```bash
rm -rf /mnt/Logstore_backup/ch_observability_YYYYMMDD_HHMMSS/
```

---

## After Restore — Check Services

```bash
# Backend health
curl http://localhost:8000/api/health

# OTel pipeline still writing
docker compose logs otel-gateway --tail=20

# Log count growing
docker exec clickhouse clickhouse-client \
  --query "SELECT count() FROM observability.otel_logs_local"
```
