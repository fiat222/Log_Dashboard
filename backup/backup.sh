#!/bin/bash
set -e

BACKUP_DIR="/backups"
DATE=$(date +"%Y%m%d_%H%M%S")
PG_FILE="$BACKUP_DIR/pg_logdash_$DATE.sql.gz"

echo "============================================="
echo "[$(date)] Starting Backup Process"
echo "============================================="

# 1. PostgreSQL Backup
echo "-> Backing up PostgreSQL database..."
if PGPASSWORD=$POSTGRES_PASSWORD pg_dump -h postgres -U $POSTGRES_USER -d $POSTGRES_DB | gzip > $PG_FILE; then
    echo "  [OK] Saved PostgreSQL backup to: $PG_FILE"
else
    echo "  [FAIL] PostgreSQL backup failed!"
fi

# 2. ClickHouse Backup
echo "-> Backing up ClickHouse logs..."
CH_BACKUP_NAME="ch_logs_$DATE"
CH_QUERY="BACKUP DATABASE $CLICKHOUSE_DB TO File('$CH_BACKUP_NAME/');"

CH_RESP=$(curl -s -X POST -u "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" \
  "http://clickhouse:8123/" -d "$CH_QUERY")

if echo "$CH_RESP" | grep -qi "Exception\|Error\|failed"; then
    echo "  [FAIL] ClickHouse backup error: $CH_RESP"
else
    # Poll until backup finishes
    echo "  [INFO] Waiting for ClickHouse to finish writing..."
    MAX_WAIT=120
    ELAPSED=0

    while [ $ELAPSED -lt $MAX_WAIT ]; do
        STATUS=$(curl -s -u "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" \
          "http://clickhouse:8123/" \
          --data "SELECT status FROM system.backups ORDER BY start_time DESC LIMIT 1 FORMAT TabSeparated")

        echo "  [INFO] Status: $STATUS (${ELAPSED}s elapsed)"

        if [ "$STATUS" = "BACKUP_CREATED" ]; then
            echo "  [OK] ClickHouse finished writing backup"
            break
        elif echo "$STATUS" | grep -qi "FAILED\|ERROR"; then
            echo "  [FAIL] ClickHouse backup failed: $STATUS"
            exit 1
        fi

        sleep 5
        ELAPSED=$((ELAPSED + 5))
    done

    if [ $ELAPSED -ge $MAX_WAIT ]; then
        echo "  [FAIL] Timed out after ${MAX_WAIT}s"
        exit 1
    fi

    # Compress
    CH_RAW_DIR="/backups/$CH_BACKUP_NAME"
    CH_TGZ="$BACKUP_DIR/$CH_BACKUP_NAME.tar.gz"

    if [ -d "$CH_RAW_DIR" ]; then
        tar -czf "$CH_TGZ" -C "$BACKUP_DIR" "$CH_BACKUP_NAME"
        rm -rf "$CH_RAW_DIR"
        echo "  [OK] Compressed ClickHouse backup to: $CH_TGZ"
    else
        echo "  [FAIL] Cannot find ClickHouse raw backup directory at $CH_RAW_DIR"
    fi
fi

# 3. Cleanup old backups (Disabled as per request)
# echo "-> Cleaning up files older than 7 days..."
# find $BACKUP_DIR -type f -mtime +7 -name "*.gz" -exec rm -f {} \;
# echo "  [OK] Cleanup complete."

echo "============================================="
echo "[$(date)] Backup Process Completed!"
echo "============================================="
