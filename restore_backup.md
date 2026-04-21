# Postgres
gunzip -c /backups/pg_logdash_YYYYMMDD_HHMMSS.sql.gz > restore.sql

docker exec -i postgres psql -U loguser -d logdash < restore.sql

# Clickhouse
tar -xzf /backups/ch_logs_YYYYMMDD_HHMMSS.tar.gz -C /var/lib/docker/volumes/logdashboard_backup_data/_data/

RESTORE DATABASE logs FROM File('backups/ch_logs_YYYYMMDD_HHMMSS/');

