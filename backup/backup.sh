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
CH_QUERY="BACKUP DATABASE $CLICKHOUSE_DB TO File('ch_logs_$DATE/');"

# Call ClickHouse API to trigger native backup
# Notes: With /mnt/Logstore_backup mounted to /var/lib/clickhouse/user_files/backups
# This writes directly to /mnt/Logstore_backup/ch_logs_$DATE
CH_RESP=$(curl -s -X POST -u "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" "http://clickhouse:8123/" -d "$CH_QUERY")

if echo "$CH_RESP" | grep -qi "Exception\|Error\|failed"; then
    echo "  [FAIL] ClickHouse backup error: $CH_RESP"
else
    echo "  [OK] ClickHouse native backup complete."
    
    # We compress it to save space and keep it as a single file.
    # The 'backup' container mounts /mnt/Logstore_backup to /backups
    sleep 2 # Ensure ClickHouse has fully written the files
    CH_RAW_DIR="$BACKUP_DIR/ch_logs_$DATE"
    CH_TGZ="$BACKUP_DIR/ch_logs_$DATE.tar.gz"
    
    if [ -d "$CH_RAW_DIR" ]; then
        tar -czf "$CH_TGZ" -C "$BACKUP_DIR" "ch_logs_$DATE"
        rm -rf "$CH_RAW_DIR" # Remove uncompressed raw folder
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
