#!/bin/bash
# =============================================================================
# Backup Script for ClickHouse
# =============================================================================

BACKUP_DIR="/backups"
DATE=$(date +"%Y%m%d_%H%M%S")

echo "============================================="
echo "[$(date)] Starting Backup Process"
echo "============================================="

# ตรวจสอบว่ามีสิทธิ์เขียนในโฟลเดอร์ backup หรือไม่
if [ ! -w "$BACKUP_DIR" ]; then
    echo "  [ERROR] Cannot write to $BACKUP_DIR. Check permissions."
    exit 1
fi

# 1. ClickHouse Backup
echo "-> Backing up ClickHouse logs..."
CH_BACKUP_NAME="ch_observability_$DATE"
# หมายเหตุ: ClickHouse จะสร้างไฟล์ในโฟลเดอร์ที่ถูก Mount ไว้ (เช่น /var/lib/clickhouse/backups/)
CH_QUERY="BACKUP DATABASE $CLICKHOUSE_DB TO File('$CH_BACKUP_NAME/');"

CH_RESP=$(curl -s -X POST -u "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" \
  "http://clickhouse:8123/" -d "$CH_QUERY")

if echo "$CH_RESP" | grep -qi "Exception\|Error\|failed"; then
    echo "  [FAIL] ClickHouse backup error: $CH_RESP"
else
    # Poll until backup finishes
    echo "  [INFO] Waiting for ClickHouse to finish writing..."
    MAX_WAIT=300 # เพิ่มเวลาเป็น 5 นาทีสำหรับข้อมูลขนาดใหญ่
    ELAPSED=0

    while [ $ELAPSED -lt $MAX_WAIT ]; do
        STATUS=$(curl -s -u "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" \
          "http://clickhouse:8123/" \
          --data "SELECT status FROM system.backups WHERE name = 'File(\'$CH_BACKUP_NAME/\')' ORDER BY start_time DESC LIMIT 1 FORMAT TabSeparated")

        # ถ้าสถานะว่างเปล่า ให้ลองดึงตัวล่าสุดมาดู
        if [ -z "$STATUS" ]; then
             STATUS=$(curl -s -u "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" \
               "http://clickhouse:8123/" \
               --data "SELECT status FROM system.backups ORDER BY start_time DESC LIMIT 1 FORMAT TabSeparated")
        fi

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
        echo "  [FAIL] ClickHouse Backup Timed out after ${MAX_WAIT}s"
        exit 1
    fi

    # 2. Compress ClickHouse Raw Data
    echo "-> Compressing ClickHouse backup..."
    CH_TGZ="$BACKUP_DIR/$CH_BACKUP_NAME.tar.gz"

    # ค้นหาโฟลเดอร์ที่ ClickHouse สร้างขึ้น (ป้องกันเรื่อง Path ซ้อน)
    ACTUAL_DIR=$(find "$BACKUP_DIR" -maxdepth 1 -name "$CH_BACKUP_NAME*" -type d | head -n 1)

    if [ -n "$ACTUAL_DIR" ] && [ -d "$ACTUAL_DIR" ]; then
        tar -czf "$CH_TGZ" -C "$BACKUP_DIR" "$(basename "$ACTUAL_DIR")"
        if [ $? -ne 0 ]; then
            echo "  [FAIL] tar compression failed — raw dir preserved at $ACTUAL_DIR"
            exit 1
        fi
        rm -rf "$ACTUAL_DIR"
        echo "  [OK] Compressed ClickHouse backup to: $CH_TGZ"
    else
        echo "  [FAIL] Cannot find ClickHouse raw backup directory at $BACKUP_DIR/$CH_BACKUP_NAME"
        ls -l "$BACKUP_DIR"
        exit 1
    fi
fi

# 3. Cleanup old backups (Optional - ปิดไว้ตามที่แจ้ง)
# echo "-> Cleaning up files older than 7 days..."
# find "$BACKUP_DIR" -type f -mtime +7 -name "*.gz" -exec rm -f {} \;
# echo "  [OK] Cleanup complete."

echo "============================================="
echo "[$(date)] Backup Process Completed!"
echo "============================================="
