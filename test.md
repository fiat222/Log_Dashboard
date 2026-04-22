# Test Guide - Nginx Logs Integration

This document outlines tests for the nginx log pipeline from VM-Nginx → Redis → ClickHouse → Dashboard UI.

## Pre-requisites

- Docker stack running: `docker-compose up -d`
- Backend accessible at `http://localhost/logstore/api`
- ClickHouse accessible at `http://localhost:8123`

---

## Test 1: ClickHouse Schema

**Purpose**: Verify nginx_logs table and materialized views exist.

```sql
-- Login to ClickHouse
docker exec -it clickhouse clickhouse-client --queries-file=/init.sql

-- Check tables
SELECT name, engine FROM system.tables WHERE database = 'logs';
```

**Expected**:
- `logs.nginx_logs` (MergeTree)
- `logs.nginx_status_mv_target` (SummingMergeTree)
- `logs.nginx_top_paths_mv_target` (SummingMergeTree)
- `logs.nginx_hourly_mv_target` (SummingMergeTree)

---

## Test 2: Ingester Nginx Worker

**Purpose**: Verify ingester starts nginx worker and reads from Redis key `nginx`.

```bash
# Check ingester logs
docker logs log-ingester 2>&1 | grep -i nginx
```

**Expected**: Should see "Nginx worker started — key=nginx"

---

## Test 3: Manual Redis Push (Mock Vector)

**Purpose**: Test Redis → ClickHouse pipeline manually.

```bash
# Push a mock nginx log to Redis
docker exec -it redis redis-cli -a '${REDIS_PASSWORD}' RPUSH nginx '{"timestamp":"2026-04-22T10:00:00Z","source_host":"test-vm","remote_addr":"1.2.3.4","method":"GET","path":"/api/test","status":200,"bytes_sent":1234,"request_time":0.025,"user_agent":"Test/1.0"}'
```

Wait ~10 seconds, then query ClickHouse:

```sql
SELECT * FROM logs.nginx_logs ORDER BY timestamp DESC LIMIT 1;
```

**Expected**: Row appears with all fields populated.

---

## Test 4: Backend API (Admin Only)

**Purpose**: Verify nginx logs API endpoints work.

```bash
# Login as super_admin
curl -X POST http://localhost/logstore/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"superadmin","password":"your_password"}' \
  -c cookies.txt

# Test overview endpoint
curl http://localhost/logstore/api/admin/nginx-logs/overview?hours=24 -b cookies.txt
```

**Expected JSON**:
```json
{
  "total_requests": 1234,
  "error_rate": 2.5,
  "avg_response_time": 0.015,
  "p95_response_time": 0.05,
  "total_bytes": 567890
}
```

---

## Test 5: Frontend Nginx Tab

**Purpose**: Verify Nginx tab appears only for admin/super_admin.

1. Login as non-admin user → Nginx tab should be hidden
2. Login as admin → Nginx tab should be visible (after Admin)
3. Click Nginx tab → Table loads with data

**Expected**:
- Tab shows after Admin tab (🛡 Admin → 🌐 Nginx)
- Table columns: Client IP, Timestamp, Method, Path, Status, Bytes, Time
- IP column appears first (not last)
- Filters work: status, method, path search, datetime range
- Pagination works

---

## Test 6: Nginx Filter Validation

**Purpose**: Verify filters return correct results.

| Filter | Test | Expected |
|--------|------|---------|
| Status | Select "404" | All rows status=404 |
| Method | Select "GET" | All rows method=GET |
| Path | Search "/api" | Paths contain /api |
| Sort | Toggle ASC/DESC | Order changes |

---

## Test 7: Vector → Redis (Production)

**Purpose**: Verify Vector ships real nginx logs.

On VM-Nginx (Gateway):

```bash
# Check Vector logs
docker logs vector_nginx 2>&1 | tail -20

# Check Redis for nginx key
docker exec -it redis redis-cli -a '${REDIS_PASSWORD}' LLEN nginx
```

**Expected**: Vector running, nginx key has items.

---

## Test 8: End-to-End Flow

Complete flow test:

1. **Generate log** → Nginx access.log receives request
2. **Vector** → Parses and pushes to Redis (key `nginx`)
3. **Ingester** → BLPOPs from Redis → inserts to ClickHouse
4. **Backend** → API returns data from ClickHouse
5. **Frontend** → Displays in Nginx tab

```bash
# Count logs in each layer
# 1. Redis
docker exec -it redis redis-cli -a '${REDIS_PASSWORD}' LLEN nginx

# 2. ClickHouse
docker exec -it clickhouse clickhouse-client -q "SELECT count() FROM logs.nginx_logs"

# 3. API
curl http://localhost/logstore/api/admin/nginx-logs/overview -b cookies.txt | jq .total_requests
```

**Expected**: All counts should increase over time.

---

## Troubleshooting

| Issue | Check |
|-------|------|
| Nginx logs not appearing | Check Vector logs, Redis key exists |
| API 403 Forbidden | User role not admin/super_admin |
| Table empty | Check datetime filter (default 24h) |
| Sort not working | Backend uses ORDER BY timestamp |