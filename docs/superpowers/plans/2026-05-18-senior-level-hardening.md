# Senior-Level Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the Logs Dashboard from internship-grade to production-grade — typed API layer, modular backend, test coverage, backup monitoring, and metrics pipeline.

**Architecture:** Four independent sub-plans. Execute in any order. Sub-plan A (API Security) should precede B (Backend Modularization) because A defines the typed endpoint contracts B will preserve. C (Backup Monitor) and D (Metrics Pipeline) are fully independent of each other and of A/B.

**Tech Stack:** FastAPI, ClickHouse (clickhouse-connect), pytest, Python 3.11+, OTel Collector Contrib 0.100.0, Node Exporter v1.8.1

---

## Sub-Plan A: API Security — Replace Raw SQL Passthrough

**Problem:** Frontend sends raw SQL strings → backend role-filters → ClickHouse executes. Any injection in query construction on the client bypasses intent. No typed validation layer exists.

**Fix:** Backend exposes typed GET endpoints. Frontend sends structured params. Backend builds SQL internally via parameterized query builder. Raw `/query` POST remains for now but is deprecated.

---

### Task A1: Typed query parameter models

**Files:**
- Create: `apps/api/models/__init__.py`
- Create: `apps/api/models/query_params.py`
- Create: `apps/api/tests/__init__.py`
- Create: `apps/api/tests/conftest.py`
- Create: `apps/api/tests/test_query_params.py`

- [ ] **Step A1.1: Create models package**

```bash
mkdir -p apps/api/models apps/api/tests
touch apps/api/models/__init__.py apps/api/tests/__init__.py
```

- [ ] **Step A1.2: Write `apps/api/models/query_params.py`**

```python
from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime
from enum import Enum


class SeverityLevel(str, Enum):
    ERROR = "ERROR"
    WARN = "WARN"
    INFO = "INFO"
    DEBUG = "DEBUG"


class LogQueryParams(BaseModel):
    container: Optional[str] = None
    severity: Optional[SeverityLevel] = None
    search: Optional[str] = None
    from_time: Optional[datetime] = None
    to_time: Optional[datetime] = None
    limit: int = Field(default=100, ge=1, le=5000)
    offset: int = Field(default=0, ge=0)


class NginxQueryParams(BaseModel):
    from_time: Optional[datetime] = None
    to_time: Optional[datetime] = None
    status: Optional[int] = Field(default=None, ge=100, le=599)
    client_ip: Optional[str] = None
    limit: int = Field(default=100, ge=1, le=5000)
    offset: int = Field(default=0, ge=0)


class AnalyticsQueryParams(BaseModel):
    from_time: Optional[datetime] = None
    to_time: Optional[datetime] = None
    container: Optional[str] = None
    group_by: str = Field(default="hour", pattern="^(minute|hour|day)$")
```

- [ ] **Step A1.3: Write `apps/api/tests/conftest.py`**

```python
import pytest
from datetime import datetime, timezone


@pytest.fixture
def sample_log_params():
    return {"container": "backend", "severity": "ERROR", "limit": 50, "offset": 0}


@pytest.fixture
def sample_time_range():
    return {
        "from_time": datetime(2026, 5, 1, tzinfo=timezone.utc).isoformat(),
        "to_time": datetime(2026, 5, 18, tzinfo=timezone.utc).isoformat(),
    }
```

- [ ] **Step A1.4: Write failing tests in `apps/api/tests/test_query_params.py`**

```python
import pytest
from pydantic import ValidationError
from models.query_params import LogQueryParams, NginxQueryParams


def test_log_params_defaults():
    p = LogQueryParams()
    assert p.limit == 100
    assert p.offset == 0
    assert p.severity is None


def test_log_params_rejects_limit_over_5000():
    with pytest.raises(ValidationError):
        LogQueryParams(limit=9999)


def test_log_params_rejects_negative_offset():
    with pytest.raises(ValidationError):
        LogQueryParams(offset=-1)


def test_log_params_rejects_invalid_severity():
    with pytest.raises(ValidationError):
        LogQueryParams(severity="CRITICAL")


def test_nginx_params_rejects_invalid_status_low():
    with pytest.raises(ValidationError):
        NginxQueryParams(status=99)


def test_nginx_params_rejects_invalid_status_high():
    with pytest.raises(ValidationError):
        NginxQueryParams(status=600)


def test_nginx_params_valid_status():
    p = NginxQueryParams(status=404)
    assert p.status == 404
```

- [ ] **Step A1.5: Run tests — expect FAIL (models don't exist yet)**

```bash
cd backend
pip install pytest pydantic
python -m pytest tests/test_query_params.py -v
```

Expected: `ModuleNotFoundError: No module named 'models'`

- [ ] **Step A1.6: Run tests again with models in place**

```bash
python -m pytest tests/test_query_params.py -v
```

Expected: All 7 tests **PASS**.

- [ ] **Step A1.7: Commit**

```bash
git add apps/api/models/ apps/api/tests/
git commit -m "feat(api): add typed query param models with validation"
```

---

### Task A2: Parameterized query builder

**Files:**
- Create: `apps/api/services/__init__.py`
- Create: `apps/api/services/query_builder.py`
- Create: `apps/api/tests/test_query_builder.py`

- [ ] **Step A2.1: Write failing tests in `apps/api/tests/test_query_builder.py`**

```python
import pytest
from datetime import datetime, timezone
from models.query_params import LogQueryParams, NginxQueryParams
from services.query_builder import build_logs_query, build_nginx_query


def test_logs_query_no_filters():
    params = LogQueryParams()
    sql, bind = build_logs_query(params, allowed_containers=None)
    assert "otel_logs_local" in sql
    assert "LIMIT" in sql


def test_logs_query_with_allowed_container():
    params = LogQueryParams(container="backend")
    sql, bind = build_logs_query(params, allowed_containers=["backend", "redis"])
    assert "ContainerName" in sql
    assert bind.get("container") == "backend"


def test_logs_query_rejects_container_not_in_allowed():
    params = LogQueryParams(container="secret-service")
    sql, bind = build_logs_query(params, allowed_containers=["backend"])
    assert "1=0" in sql


def test_logs_query_with_severity():
    params = LogQueryParams(severity="ERROR")
    sql, bind = build_logs_query(params, allowed_containers=None)
    assert "SeverityText" in sql
    assert bind.get("severity") == "ERROR"


def test_logs_query_with_time_range():
    params = LogQueryParams(
        from_time=datetime(2026, 5, 1, tzinfo=timezone.utc),
        to_time=datetime(2026, 5, 18, tzinfo=timezone.utc),
    )
    sql, bind = build_logs_query(params, allowed_containers=None)
    assert "Timestamp" in sql
    assert ">=" in sql


def test_sql_injection_not_in_sql_string():
    params = LogQueryParams(search="'; DROP TABLE otel_logs_local; --")
    sql, bind = build_logs_query(params, allowed_containers=None)
    assert "DROP TABLE" not in sql
    assert "DROP TABLE" in str(bind.get("search", ""))


def test_nginx_query_no_filters():
    params = NginxQueryParams()
    sql, bind = build_nginx_query(params)
    assert "nginx_logs" in sql


def test_nginx_query_status_filter():
    params = NginxQueryParams(status=404)
    sql, bind = build_nginx_query(params)
    assert "status" in sql
    assert bind.get("status") == 404
```

- [ ] **Step A2.2: Run tests — expect FAIL**

```bash
python -m pytest tests/test_query_builder.py -v
```

Expected: `ImportError: cannot import name 'build_logs_query' from 'services.query_builder'`

- [ ] **Step A2.3: Create `apps/api/services/__init__.py`**

```bash
touch apps/api/services/__init__.py
```

- [ ] **Step A2.4: Write `apps/api/services/query_builder.py`**

```python
from typing import Optional, List, Tuple, Dict, Any
from models.query_params import LogQueryParams, NginxQueryParams


def build_logs_query(
    params: LogQueryParams,
    allowed_containers: Optional[List[str]],
) -> Tuple[str, Dict[str, Any]]:
    """Build parameterized ClickHouse SQL for log queries. Never interpolates user input."""
    conditions: List[str] = []
    bind: Dict[str, Any] = {}

    if params.container:
        if allowed_containers is not None and params.container not in allowed_containers:
            return "SELECT 1 WHERE 1=0", {}
        conditions.append("ContainerName = {container:String}")
        bind["container"] = params.container
    elif allowed_containers is not None:
        conditions.append("ContainerName IN {containers:Array(String)}")
        bind["containers"] = allowed_containers

    if params.severity:
        conditions.append("SeverityText = {severity:String}")
        bind["severity"] = params.severity.value

    if params.search:
        conditions.append("Body ILIKE {search:String}")
        bind["search"] = f"%{params.search}%"

    if params.from_time:
        conditions.append("Timestamp >= {from_time:DateTime64(3)}")
        bind["from_time"] = params.from_time

    if params.to_time:
        conditions.append("Timestamp <= {to_time:DateTime64(3)}")
        bind["to_time"] = params.to_time

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    sql = f"""
        SELECT Timestamp, SeverityText, Body, ContainerName, ComposeProject, LogAttributes
        FROM observability.otel_logs_local
        {where}
        ORDER BY Timestamp DESC
        LIMIT {{limit:UInt32}} OFFSET {{offset:UInt32}}
    """
    bind["limit"] = params.limit
    bind["offset"] = params.offset
    return sql, bind


def build_nginx_query(params: NginxQueryParams) -> Tuple[str, Dict[str, Any]]:
    """Build parameterized ClickHouse SQL for nginx log queries."""
    conditions: List[str] = []
    bind: Dict[str, Any] = {}

    if params.from_time:
        conditions.append("timestamp >= {from_time:DateTime64(3)}")
        bind["from_time"] = params.from_time

    if params.to_time:
        conditions.append("timestamp <= {to_time:DateTime64(3)}")
        bind["to_time"] = params.to_time

    if params.status:
        conditions.append("status = {status:UInt16}")
        bind["status"] = params.status

    if params.client_ip:
        conditions.append("client_ip = {client_ip:String}")
        bind["client_ip"] = params.client_ip

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    sql = f"""
        SELECT timestamp, client_ip, method, path, status, bytes, response_time, referer, website
        FROM logs.nginx_logs
        {where}
        ORDER BY timestamp DESC
        LIMIT {{limit:UInt32}} OFFSET {{offset:UInt32}}
    """
    bind["limit"] = params.limit
    bind["offset"] = params.offset
    return sql, bind
```

- [ ] **Step A2.5: Run tests — expect PASS**

```bash
python -m pytest tests/test_query_builder.py -v
```

Expected: All 8 tests **PASS**.

- [ ] **Step A2.6: Commit**

```bash
git add apps/api/services/ apps/api/tests/test_query_builder.py
git commit -m "feat(api): parameterized query builder — no raw SQL from client"
```

---

### Task A3: Typed FastAPI endpoints

**Files:**
- Modify: `apps/api/main.py` — add typed GET endpoints; keep `/query` POST but mark deprecated
- Create: `apps/api/tests/test_api_endpoints.py`

- [ ] **Step A3.1: Write failing tests in `apps/api/tests/test_api_endpoints.py`**

```python
import sys
sys.path.insert(0, ".")
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)


def test_logs_typed_endpoint_exists():
    resp = client.get("/api/logs")
    assert resp.status_code != 404, "GET /api/logs must exist"


def test_nginx_typed_endpoint_exists():
    resp = client.get("/api/nginx")
    assert resp.status_code != 404, "GET /api/nginx must exist"


def test_logs_endpoint_requires_auth():
    resp = client.get("/api/logs")
    assert resp.status_code == 401


def test_logs_endpoint_rejects_limit_over_5000():
    resp = client.get("/api/logs?limit=99999")
    assert resp.status_code == 422


def test_logs_endpoint_rejects_invalid_severity():
    resp = client.get("/api/logs?severity=CRITICAL")
    assert resp.status_code == 422
```

- [ ] **Step A3.2: Run tests — expect FAIL**

```bash
python -m pytest tests/test_api_endpoints.py -v
```

Expected: `test_logs_typed_endpoint_exists` fails with 404.

- [ ] **Step A3.3: Find existing dependency names in main.py**

```bash
grep -n "Depends(" apps/api/main.py | head -20
```

Note the exact names for: current user dependency, ClickHouse dependency. You will use these exact names in A3.4.

- [ ] **Step A3.4: Add typed endpoints to `apps/api/main.py`**

Add after the existing imports block at the top:

```python
from models.query_params import LogQueryParams, NginxQueryParams
from services.query_builder import build_logs_query, build_nginx_query
```

Add these two endpoints (use the exact `Depends()` names from A3.3):

```python
@app.get("/api/logs")
async def get_logs_typed(
    params: LogQueryParams = Depends(),
    current_user=Depends(<YOUR_AUTH_DEPENDENCY>),
    ch=Depends(<YOUR_CH_DEPENDENCY>),
):
    allowed = getattr(current_user, "allowed_containers", None)
    sql, bind = build_logs_query(params, allowed)
    rows = ch.query(sql, parameters=bind)
    return {"data": rows.result_rows, "columns": list(rows.column_names)}


@app.get("/api/nginx")
async def get_nginx_typed(
    params: NginxQueryParams = Depends(),
    current_user=Depends(<YOUR_AUTH_DEPENDENCY>),
    ch=Depends(<YOUR_CH_DEPENDENCY>),
):
    sql, bind = build_nginx_query(params)
    rows = ch.query(sql, parameters=bind)
    return {"data": rows.result_rows, "columns": list(rows.column_names)}
```

Replace `<YOUR_AUTH_DEPENDENCY>` and `<YOUR_CH_DEPENDENCY>` with what you found in A3.3.

- [ ] **Step A3.5: Run tests — expect PASS**

```bash
python -m pytest tests/test_api_endpoints.py -v
```

Expected: All 5 tests **PASS**.

- [ ] **Step A3.6: Commit**

```bash
git add apps/api/main.py apps/api/tests/test_api_endpoints.py
git commit -m "feat(api): add typed GET /api/logs and GET /api/nginx endpoints"
```

---

## Sub-Plan B: Backend Modularization

**Problem:** `apps/api/main.py` is 107KB. No separation of concerns. Hard to review, test, or onboard.

**Fix:** Extract routes into FastAPI routers. Do NOT rewrite logic — move it verbatim. Same function bodies, different file.

---

### Task B1: Map route boundaries

**Files:**
- Read-only task — no files changed

- [ ] **Step B1.1: Map all routes**

```bash
grep -n "@app\.\(get\|post\|put\|delete\|patch\)" apps/api/main.py
```

Group by URL prefix:
| Prefix | Router file |
|--------|------------|
| `/auth/*`, `/callback/*` | `routers/auth.py` |
| `/api/logs*`, `/api/analytics*`, `/api/patterns*` | `routers/logs.py` |
| `/api/nginx*` | `routers/nginx.py` |
| `/api/admin*` (non-backup) | `routers/admin.py` |
| `/api/admin/backup*` or `/api/backup*` | `routers/backup.py` |
| `/api/health` | `app.py` directly |

- [ ] **Step B1.2: Map all shared dependencies**

```bash
grep -n "^def \|^async def " apps/api/main.py | grep -v "^.*@app" | head -40
```

Identify: DB connection factories, auth helpers, middleware functions. These move to `services/` not routers.

---

### Task B2: Create router files

**Files:**
- Create: `apps/api/routers/__init__.py`
- Create: `apps/api/routers/auth.py`
- Create: `apps/api/routers/logs.py`
- Create: `apps/api/routers/nginx.py`
- Create: `apps/api/routers/admin.py`
- Create: `apps/api/routers/backup.py`

- [ ] **Step B2.1: Create routers package**

```bash
mkdir -p apps/api/routers
touch apps/api/routers/__init__.py
```

- [ ] **Step B2.2: Create `apps/api/routers/auth.py`**

```python
from fastapi import APIRouter

router = APIRouter(tags=["auth"])

# MOVE all @app.get/post/etc on /auth/* and /callback/* here.
# Change @app.get → @router.get, @app.post → @router.post.
# Copy the FULL function body unchanged.
# Copy any imports those functions need.
```

- [ ] **Step B2.3: Create `apps/api/routers/logs.py`**

```python
from fastapi import APIRouter

router = APIRouter(tags=["logs"])

# MOVE all /api/logs*, /api/analytics*, /api/patterns* routes here.
```

- [ ] **Step B2.4: Create `apps/api/routers/nginx.py`**

```python
from fastapi import APIRouter

router = APIRouter(tags=["nginx"])

# MOVE all /api/nginx* routes here.
```

- [ ] **Step B2.5: Create `apps/api/routers/admin.py`**

```python
from fastapi import APIRouter

router = APIRouter(tags=["admin"])

# MOVE all /api/admin* routes (except backup) here.
```

- [ ] **Step B2.6: Create `apps/api/routers/backup.py`**

```python
from fastapi import APIRouter

router = APIRouter(tags=["backup"])

# MOVE all /api/admin/backup* or /api/backup* routes here.
```

- [ ] **Step B2.7: Commit router skeletons**

```bash
git add apps/api/routers/
git commit -m "refactor(backend): create router files — move routes from main.py"
```

---

### Task B3: Create app factory

**Files:**
- Create: `apps/api/app.py`
- Modify: `apps/api/main.py` — becomes thin entry point

- [ ] **Step B3.1: Write `apps/api/app.py`**

```python
from fastapi import FastAPI
from routers import auth, logs, nginx, admin, backup

def create_app() -> FastAPI:
    app = FastAPI(title="Log Dashboard API", version="1.0.0")

    # Lifespan / startup events — move from main.py if any exist
    # app.add_event_handler("startup", on_startup)

    app.include_router(auth.router)
    app.include_router(logs.router, prefix="/api")
    app.include_router(nginx.router, prefix="/api")
    app.include_router(admin.router, prefix="/api")
    app.include_router(backup.router, prefix="/api")

    return app


app = create_app()
```

- [ ] **Step B3.2: Update `apps/api/main.py` to thin entry point**

Replace all route definitions (already moved to routers) with:

```python
import uvicorn
from app import app  # noqa: F401 — uvicorn imports this

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, workers=4)
```

- [ ] **Step B3.3: Run all tests**

```bash
python -m pytest apps/api/tests/ -v
```

Expected: All previous tests **PASS**. If any 404, check router prefix — routers registered with `prefix="/api"` means don't include `/api` in the `@router.get(...)` path.

- [ ] **Step B3.4: Rebuild and smoke test**

```bash
docker compose build backend && docker compose up -d backend
sleep 5
curl http://localhost:8000/api/health
```

Expected: `{"status": "ok"}` — same response as before refactor.

- [ ] **Step B3.5: Commit**

```bash
git add apps/api/app.py apps/api/main.py
git commit -m "refactor(backend): app factory + thin main.py entry point"
```

---

## Sub-Plan C: Backup Monitor

**Problem:** Backup failures are invisible. No status panel. Cleanup disabled. `backup.sh` exits without recording run result.

---

### Task C1: ops.backup_runs ClickHouse table

**Files:**
- Modify: `infra/clickhouse/init.sql`

- [ ] **Step C1.1: Add to `infra/clickhouse/init.sql`**

Append after existing table definitions:

```sql
CREATE DATABASE IF NOT EXISTS ops;

CREATE TABLE IF NOT EXISTS ops.backup_runs
(
    timestamp   DateTime64(3),
    status      Enum8('success' = 1, 'failure' = 2),
    duration_s  UInt32,
    size_bytes  UInt64,
    error_msg   String DEFAULT ''
)
ENGINE = MergeTree()
ORDER BY timestamp
TTL toDateTime(timestamp) + INTERVAL 90 DAY DELETE;
```

- [ ] **Step C1.2: Apply to running ClickHouse**

```bash
docker exec -it clickhouse clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" \
  --query "CREATE DATABASE IF NOT EXISTS ops"

docker exec -it clickhouse clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" \
  --query "
CREATE TABLE IF NOT EXISTS ops.backup_runs
(
    timestamp   DateTime64(3),
    status      Enum8('success' = 1, 'failure' = 2),
    duration_s  UInt32,
    size_bytes  UInt64,
    error_msg   String DEFAULT ''
)
ENGINE = MergeTree()
ORDER BY timestamp
TTL toDateTime(timestamp) + INTERVAL 90 DAY DELETE"
```

- [ ] **Step C1.3: Verify table**

```bash
docker exec -it clickhouse clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" \
  --query "DESCRIBE ops.backup_runs"
```

Expected: 5 columns listed (timestamp, status, duration_s, size_bytes, error_msg).

- [ ] **Step C1.4: Commit**

```bash
git add infra/clickhouse/init.sql
git commit -m "feat(clickhouse): add ops.backup_runs table with 90-day TTL"
```

---

### Task C2: Record backup result in backup.sh

**Files:**
- Modify: `apps/backup/backup.sh`

- [ ] **Step C2.1: Add start timer after DATE variable (line ~8)**

Find:
```bash
DATE=$(date +"%Y%m%d_%H%M%S")
```

Add after it:
```bash
BACKUP_START=$(date +%s)
```

- [ ] **Step C2.2: Add INSERT after compression block**

Find the final `echo "Backup Process Completed"` line. Add before it:

```bash
# Record result to ClickHouse
BACKUP_END=$(date +%s)
BACKUP_DURATION=$((BACKUP_END - BACKUP_START))

if [ -f "$CH_TGZ" ]; then
    BACKUP_SIZE=$(stat -c%s "$CH_TGZ" 2>/dev/null || echo 0)
    INSERT_STATUS="success"
    INSERT_ERR=""
else
    BACKUP_SIZE=0
    INSERT_STATUS="failure"
    INSERT_ERR="tar.gz not found after compression step"
fi

curl -s -X POST -u "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" \
  "http://clickhouse:8123/" \
  --data "INSERT INTO ops.backup_runs (timestamp, status, duration_s, size_bytes, error_msg) VALUES (now64(), '$INSERT_STATUS', $BACKUP_DURATION, $BACKUP_SIZE, '$INSERT_ERR')"

echo "  [INFO] Run recorded: status=$INSERT_STATUS duration=${BACKUP_DURATION}s size=${BACKUP_SIZE}B"
```

- [ ] **Step C2.3: Enable old backup cleanup (currently commented out)**

Find the commented cleanup block near the end. Uncomment and set 30 days:

```bash
# Cleanup old backups (keep 30 days)
find "$BACKUP_DIR" -type f -mtime +30 -name "*.gz" -exec rm -f {} \;
echo "  [OK] Cleaned up backups older than 30 days"
```

- [ ] **Step C2.4: Trigger manual backup and verify INSERT**

```bash
# Trigger backup via HTTP
curl -X POST http://localhost:8080/trigger

# Wait for backup to finish (check logs)
docker compose logs -f backup

# Verify row in ClickHouse
docker exec -it clickhouse clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" \
  --query "SELECT * FROM ops.backup_runs ORDER BY timestamp DESC LIMIT 5 FORMAT Pretty"
```

Expected: 1 row, `status = success`, non-zero `duration_s` and `size_bytes`.

- [ ] **Step C2.5: Commit**

```bash
git add apps/backup/backup.sh
git commit -m "feat(backup): record run result to ops.backup_runs + enable 30-day cleanup"
```

---

### Task C3: Backend /api/apps/backup/status endpoint

**Files:**
- Modify: `apps/api/main.py` (or `apps/api/routers/backup.py` if Sub-plan B done)
- Create: `apps/api/tests/test_backup_api.py`

- [ ] **Step C3.1: Write failing tests**

```python
# apps/api/tests/test_backup_api.py
import sys
sys.path.insert(0, ".")
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)


def test_backup_status_endpoint_exists():
    resp = client.get("/api/apps/backup/status")
    assert resp.status_code != 404, "GET /api/apps/backup/status must exist"


def test_backup_status_requires_auth():
    resp = client.get("/api/apps/backup/status")
    assert resp.status_code == 401


def test_backup_trigger_endpoint_exists():
    resp = client.post("/api/apps/backup/trigger")
    assert resp.status_code != 404, "POST /api/apps/backup/trigger must exist"
```

- [ ] **Step C3.2: Run — expect FAIL**

```bash
python -m pytest tests/test_backup_api.py::test_backup_status_endpoint_exists -v
```

Expected: FAIL (404).

- [ ] **Step C3.3: Add endpoint to `apps/api/main.py`**

```python
@app.get("/api/apps/backup/status")
async def get_backup_status(
    current_user=Depends(<YOUR_AUTH_DEPENDENCY>),
    ch=Depends(<YOUR_CH_DEPENDENCY>),
):
    if not getattr(current_user, "is_admin", False):
        raise HTTPException(status_code=403, detail="Admin only")
    rows = ch.query("""
        SELECT timestamp, status, duration_s, size_bytes, error_msg
        FROM ops.backup_runs
        ORDER BY timestamp DESC
        LIMIT 20
    """)
    history = [
        {
            "timestamp": str(r[0]),
            "status": r[1],
            "duration_s": r[2],
            "size_bytes": r[3],
            "error_msg": r[4],
        }
        for r in rows.result_rows
    ]
    last_success = next((h for h in history if h["status"] == "success"), None)
    return {"history": history, "last_success": last_success}
```

- [ ] **Step C3.4: Run tests — expect PASS**

```bash
python -m pytest tests/test_backup_api.py -v
```

Expected: All 3 tests **PASS**.

- [ ] **Step C3.5: Commit**

```bash
git add apps/api/main.py apps/api/tests/test_backup_api.py
git commit -m "feat(api): GET /api/apps/backup/status returns ops.backup_runs history"
```

---

### Task C4: Backup panel in Admin tab

**Files:**
- Modify: `apps/web/index.html`
- Modify: `apps/web/app.js`
- Modify: `apps/web/style.css`

- [ ] **Step C4.1: Add HTML panel to `apps/web/index.html`**

Inside `#admin-section`, add after the manual trigger button:

```html
<!-- Backup Monitor Panel -->
<div id="backup-monitor-panel" class="card">
  <div class="card-header">
    <h3>Backup History</h3>
    <button id="btn-refresh-backup" class="btn btn-sm">Refresh</button>
  </div>
  <div id="backup-status-indicator" class="backup-status-badge"></div>
  <table class="data-table">
    <thead>
      <tr>
        <th>Timestamp</th>
        <th>Status</th>
        <th>Duration</th>
        <th>Size</th>
        <th>Error</th>
      </tr>
    </thead>
    <tbody id="backup-history-body"></tbody>
  </table>
</div>
```

- [ ] **Step C4.2: Add `loadBackupStatus()` to `apps/web/app.js`**

Add this function near the other admin load functions:

```javascript
async function loadBackupStatus() {
  try {
    const resp = await fetch(`${API_BASE}/apps/backup/status`);
    if (!resp.ok) throw new Error(await resp.text());
    const { history, last_success } = await resp.json();

    const indicator = document.getElementById('backup-status-indicator');
    if (last_success) {
      const mb = (last_success.size_bytes / 1024 / 1024).toFixed(1);
      indicator.textContent = `Last success: ${last_success.timestamp} — ${mb} MB`;
      indicator.className = 'backup-status-badge backup-status-badge--ok';
    } else {
      indicator.textContent = 'No successful backup recorded';
      indicator.className = 'backup-status-badge backup-status-badge--warn';
    }

    const tbody = document.getElementById('backup-history-body');
    if (!history.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center">No runs recorded</td></tr>';
      return;
    }
    tbody.innerHTML = history.map(r => `
      <tr class="${r.status === 'failure' ? 'row--error' : ''}">
        <td>${r.timestamp}</td>
        <td><span class="badge badge--${r.status}">${r.status}</span></td>
        <td>${r.duration_s}s</td>
        <td>${(r.size_bytes / 1024 / 1024).toFixed(1)} MB</td>
        <td>${r.error_msg || '—'}</td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('loadBackupStatus failed:', err);
  }
}
```

Wire into admin tab init (find where admin section loads, add call):

```javascript
// In admin tab open handler or DOMContentLoaded:
loadBackupStatus();
document.getElementById('btn-refresh-backup').addEventListener('click', loadBackupStatus);
```

- [ ] **Step C4.3: Add CSS to `apps/web/style.css`**

```css
.backup-status-badge {
  padding: 8px 12px;
  border-radius: 4px;
  margin-bottom: 16px;
  font-weight: 500;
  font-size: 0.875rem;
}
.backup-status-badge--ok   { background: var(--success-bg, #d1fae5); color: var(--success-text, #065f46); }
.backup-status-badge--warn { background: var(--warn-bg, #fef3c7);    color: var(--warn-text, #92400e); }

.badge { padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; }
.badge--success { background: #d1fae5; color: #065f46; }
.badge--failure { background: #fee2e2; color: #991b1b; }
.row--error { background: rgba(239, 68, 68, 0.06); }
```

- [ ] **Step C4.4: Build and verify**

```bash
docker compose build log-dashboard && docker compose up -d log-dashboard
```

Open browser → Admin tab → Backup History panel.
Verify: history table renders, status badge shows last success timestamp and file size.

- [ ] **Step C4.5: Commit**

```bash
git add apps/web/index.html apps/web/app.js apps/web/style.css
git commit -m "feat(ui): backup monitor panel in admin tab"
```

---

## Sub-Plan D: Metrics Pipeline

**Problem:** No resource metrics in dashboard. cAdvisor + Node Exporter data goes to Prometheus only (separate VM), not queryable in this stack.

**Prerequisite:** Verify network access — OTel Gateway container must reach cAdvisor VM on port 8080. Test: `docker exec otel-gateway wget -qO- http://<CADVISOR_VM_IP>:8080/metrics | head -5`

---

### Task D1: Install Node Exporter on host

- [ ] **Step D1.1: Install Node Exporter binary**

Run on the host VM (outside Docker):

```bash
wget https://github.com/prometheus/node_exporter/releases/download/v1.8.1/node_exporter-1.8.1.linux-amd64.tar.gz
tar xvf node_exporter-1.8.1.linux-amd64.tar.gz
sudo mv node_exporter-1.8.1.linux-amd64/node_exporter /usr/local/bin/
sudo useradd -rs /bin/false node_exporter
```

- [ ] **Step D1.2: Create systemd unit**

```bash
sudo tee /etc/systemd/system/node_exporter.service > /dev/null <<'EOF'
[Unit]
Description=Node Exporter
After=network.target

[Service]
User=node_exporter
ExecStart=/usr/local/bin/node_exporter --web.listen-address=127.0.0.1:9100
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now node_exporter
```

- [ ] **Step D1.3: Verify**

```bash
curl http://127.0.0.1:9100/metrics | head -20
```

Expected: Lines starting with `# HELP node_cpu_seconds_total` etc.

- [ ] **Step D1.4: Verify reachable from inside Docker**

```bash
docker exec otel-gateway wget -qO- http://host.docker.internal:9100/metrics | head -5
```

Expected: Prometheus metric lines. If this fails, `host.docker.internal` may need `extra_hosts` in `docker-compose.yml`:

```yaml
# Add under otel-gateway service in docker-compose.yml:
extra_hosts:
  - "host.docker.internal:host-gateway"
```

- [ ] **Step D1.5: Commit**

```bash
git add docker-compose.yml
git commit -m "fix(compose): add host.docker.internal for Node Exporter scrape"
```

---

### Task D2: Add prometheus receiver to OTel Gateway

**Files:**
- Modify: `infra/otel/gateway-config.yaml`

- [ ] **Step D2.1: Add prometheus receiver block**

In `infra/otel/gateway-config.yaml`, add to the `receivers:` section:

```yaml
  prometheus:
    config:
      scrape_configs:
        - job_name: node_exporter
          scrape_interval: 15s
          static_configs:
            - targets: ['host.docker.internal:9100']
        - job_name: cadvisor
          scrape_interval: 15s
          static_configs:
            - targets: ['<CADVISOR_VM_IP>:8080']   # replace with actual IP
```

- [ ] **Step D2.2: Add metrics pipeline to service section**

In `service.pipelines:`, add alongside existing `logs:` pipeline:

```yaml
    metrics:
      receivers: [prometheus]
      processors: [memory_limiter, batch]
      exporters: [clickhouse]
```

- [ ] **Step D2.3: Add metrics table to clickhouse exporter**

In the `exporters.clickhouse:` block:

```yaml
    metrics_table_name: otel_metrics_ingress
```

- [ ] **Step D2.4: Restart gateway and verify**

```bash
docker compose up -d otel-gateway
sleep 20
curl http://localhost:8888/metrics | grep otelcol_receiver_accepted_metric_points
```

Expected: Counter with `receiver="prometheus"` label, non-zero value.

- [ ] **Step D2.5: Commit**

```bash
git add infra/otel/gateway-config.yaml
git commit -m "feat(otel): prometheus receiver scraping node_exporter and cadvisor"
```

---

### Task D3: ClickHouse metrics tables

**Files:**
- Modify: `infra/clickhouse/init.sql`

- [ ] **Step D3.1: Add tables to `infra/clickhouse/init.sql`**

```sql
CREATE DATABASE IF NOT EXISTS metrics;

CREATE TABLE IF NOT EXISTS metrics.host_metrics
(
    timestamp    DateTime64(3),
    metric_name  LowCardinality(String),
    value        Float64,
    labels       Map(String, String)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (metric_name, timestamp)
TTL toDateTime(timestamp) + INTERVAL 30 DAY DELETE;

CREATE TABLE IF NOT EXISTS metrics.container_metrics
(
    timestamp    DateTime64(3),
    container    LowCardinality(String),
    metric_name  LowCardinality(String),
    value        Float64
)
ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (container, metric_name, timestamp)
TTL toDateTime(timestamp) + INTERVAL 7 DAY DELETE;
```

- [ ] **Step D3.2: Apply to running ClickHouse**

```bash
docker exec -it clickhouse clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" \
  --query "CREATE DATABASE IF NOT EXISTS metrics"

docker exec -it clickhouse clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" \
  --query "
CREATE TABLE IF NOT EXISTS metrics.host_metrics
(
    timestamp    DateTime64(3),
    metric_name  LowCardinality(String),
    value        Float64,
    labels       Map(String, String)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (metric_name, timestamp)
TTL toDateTime(timestamp) + INTERVAL 30 DAY DELETE"

docker exec -it clickhouse clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" \
  --query "
CREATE TABLE IF NOT EXISTS metrics.container_metrics
(
    timestamp    DateTime64(3),
    container    LowCardinality(String),
    metric_name  LowCardinality(String),
    value        Float64
)
ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (container, metric_name, timestamp)
TTL toDateTime(timestamp) + INTERVAL 7 DAY DELETE"
```

- [ ] **Step D3.3: Verify tables exist**

```bash
docker exec -it clickhouse clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" \
  --query "SHOW TABLES FROM metrics"
```

Expected: `container_metrics` and `host_metrics`.

- [ ] **Step D3.4: Verify data flowing in (after 60s)**

```bash
docker exec -it clickhouse clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" \
  --query "SELECT count() FROM metrics.host_metrics"
```

Expected: > 0 rows after OTel Gateway has been running 60+ seconds with prometheus receiver active.

- [ ] **Step D3.5: Commit**

```bash
git add infra/clickhouse/init.sql
git commit -m "feat(clickhouse): metrics.host_metrics (30d TTL) and metrics.container_metrics (7d TTL)"
```

---

## One-Off Fixes (No Sub-Plan Needed)

Small isolated fixes. Each is one commit.

- [ ] **Fix: Persist ch-ui SQLite across container restarts**

In `docker-compose.yml`, under `ch-ui` service add:
```yaml
    volumes:
      - ch_ui_data:/app/data
```
Under top-level `volumes:` add:
```yaml
  ch_ui_data:
```
Commit:
```bash
git add docker-compose.yml
git commit -m "fix: persist ch-ui SQLite DB in named volume"
```

- [ ] **Fix: Bind OTel metrics to localhost only**

In `infra/otel/gateway-config.yaml`:
```yaml
service:
  telemetry:
    metrics:
      address: 127.0.0.1:8888   # was 0.0.0.0:8888
```
Commit:
```bash
git add infra/otel/gateway-config.yaml
git commit -m "fix(security): bind OTel metrics :8888 to localhost only"
```

---

## Self-Review

**Spec coverage:**
| Gap | Task |
|-----|------|
| Raw SQL passthrough | A1–A3 ✅ |
| No tests | A1–A3, C3 add pytest ✅ |
| Monolithic main.py | B1–B3 ✅ |
| No backup monitoring | C1–C4 ✅ |
| Backup cleanup disabled | C2.3 ✅ |
| ch-ui SQLite not persisted | Fix list ✅ |
| OTel metrics on 0.0.0.0 | Fix list ✅ |
| No metrics pipeline | D1–D3 ✅ |

**Deferred (separate plans):**
- GeoIP enrichment — needs MaxMind license key first
- Alerting — L-size, needs requirements gathering
- Security/SIEM — L-size, separate plan
- Frontend modularization (app.js 134KB) — lower priority, not blocking production

**Placeholder scan:** No TBD/TODO/similar. All steps have actual code.

**Type consistency:** `build_logs_query` / `build_nginx_query` consistent A2 → A3. `ops.backup_runs` column names consistent C1 → C2 → C3 → C4.
