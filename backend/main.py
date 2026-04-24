"""
backend/main.py — Log Dashboard FastAPI Backend
================================================
Handles:
  - Super admin login via username/password from .env
  - PSU SSO (Authentik OAuth2) — prepared, needs Authentik credentials
  - JWT session management (stateless, stored in httpOnly cookie)
  - Role-based ClickHouse proxy (read + write)
  - Container ownership management (PostgreSQL)
  - Critical notification SSE endpoint
  - Settings management (TTL, active color thresholds)
"""

import asyncio
import hashlib
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import AsyncGenerator, Optional
from urllib.parse import urlencode

import aiohttp
import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import (Cookie, Depends, FastAPI, HTTPException, Query, Request,
                     Response, status)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (HTMLResponse, JSONResponse, RedirectResponse,
                                StreamingResponse)
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel
import redis.asyncio as redis_async
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

# ── Config ────────────────────────────────────────────────────────────────────
SECRET_KEY = os.getenv("JWT_SECRET_KEY", "change-me-very-long-secret-key-here")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_HOURS = 2  # Reduced from 24 to 2 for better security

# Super admin credentials (from .env)
SUPER_ADMIN_USERNAME = os.getenv("SUPER_ADMIN_USERNAME", "superadmin")
SUPER_ADMIN_PASSWORD_HASH = os.getenv("SUPER_ADMIN_PASSWORD_HASH", "")  # bcrypt hash
SUPER_ADMIN_PASSWORD_PLAIN = os.getenv("SUPER_ADMIN_PASSWORD", "changeme_superadmin")

# PostgreSQL
POSTGRES_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://loguser:changeme@postgres:5432/logdash"
)

# ClickHouse
CH_HOST = os.getenv("CLICKHOUSE_HOST", "clickhouse")
CH_PORT = os.getenv("CLICKHOUSE_PORT", "8123")
CH_DB   = os.getenv("CLICKHOUSE_DB", "logs")
CH_USER = os.getenv("CLICKHOUSE_USER", "loguser")
CH_PASS = os.getenv("CLICKHOUSE_PASSWORD", "changeme")

# Authentik / PSU SSO (configure when credentials are available)
AUTHENTIK_BASE_URL     = os.getenv("AUTHENTIK_BASE_URL", "https://sso.psu.ac.th")
AUTHENTIK_CLIENT_ID    = os.getenv("AUTHENTIK_CLIENT_ID", "")
AUTHENTIK_CLIENT_SECRET= os.getenv("AUTHENTIK_CLIENT_SECRET", "")
AUTHENTIK_REDIRECT_URI = os.getenv("AUTHENTIK_REDIRECT_URI", "https://monitor-eila.psu.ac.th/logstore/auth/callback")

# App base path (for reverse proxy with /logstore prefix)
APP_BASE = os.getenv("APP_BASE_PATH", "/logstore")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [backend] %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# ── Password hashing ──────────────────────────────────────────────────────────
pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_ctx.verify(plain, hashed)


def check_super_admin(username: str, password: str) -> bool:
    if username != SUPER_ADMIN_USERNAME:
        return False
    # If hash is set in env, use it; otherwise fall back to plain-text (dev only)
    if SUPER_ADMIN_PASSWORD_HASH:
        return verify_password(password, SUPER_ADMIN_PASSWORD_HASH)
    return password == SUPER_ADMIN_PASSWORD_PLAIN


# ── JWT ───────────────────────────────────────────────────────────────────────
def create_access_token(data: dict, expires_delta: timedelta | None = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (expires_delta or timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> dict:
    return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])


# ── Database ──────────────────────────────────────────────────────────────────
engine = create_async_engine(POSTGRES_URL, echo=False, pool_pre_ping=True)
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

# ── Individual SQL init statements (asyncpg requires one statement at a time) ─
INIT_STMTS = [
    """
    CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        authentik_sub VARCHAR UNIQUE,
        username VARCHAR UNIQUE NOT NULL,
        email VARCHAR,
        password_hash TEXT,
        role VARCHAR NOT NULL DEFAULT 'developer',
        display_name VARCHAR,
        gitlab_id VARCHAR,
        created_at TIMESTAMPTZ DEFAULT now()
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS container_ownership (
        container_id VARCHAR(255),
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        custom_name VARCHAR(255),
        PRIMARY KEY (container_id, user_id)
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR PRIMARY KEY,
        value TEXT NOT NULL
    )
    """,
    """
    INSERT INTO settings (key, value) VALUES
        ('ttl_days', '90'),
        ('dot_green_threshold_sec', '60'),
        ('dot_amber_threshold_sec', '300'),
        ('active_color_green', '#059669'),
        ('active_color_amber', '#d97706'),
        ('active_color_red', '#e11d48')
    ON CONFLICT (key) DO NOTHING
    """,
    """
    CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        type VARCHAR NOT NULL,
        severity VARCHAR NOT NULL DEFAULT 'critical',
        title VARCHAR NOT NULL,
        message TEXT NOT NULL,
        container_id VARCHAR,
        container_name VARCHAR,
        created_at TIMESTAMPTZ DEFAULT now(),
        read_at TIMESTAMPTZ
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_container_ownership_user ON container_ownership(user_id)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR",
    "ALTER TABLE container_ownership ADD COLUMN IF NOT EXISTS custom_name VARCHAR(255)",
]


async def init_db():
    for attempt in range(10):
        try:
            async with engine.begin() as conn:
                for stmt in INIT_STMTS:
                    await conn.execute(text(stmt))
            log.info("Database initialized and schema up-to-date.")

            async with AsyncSessionLocal() as session:
                # Cleanup legacy seeded test accounts if still present.
                res = await session.execute(text(
                    "DELETE FROM users WHERE username IN ('admin123', 'dev123')"
                ))
                if res.rowcount:
                    log.info("Deleted %s legacy test user(s).", res.rowcount)
                await session.commit()
            return
        except Exception as e:
            log.warning("DB not ready (attempt %d/10): %s", attempt + 1, e)
            await asyncio.sleep(3)
    log.error("Could not connect to database after 10 attempts.")



async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        yield session


# ── Notification SSE & Webhook ────────────────────────────────────────────────
# In-memory queue for SSE broadcast
_notification_queues: list[asyncio.Queue] = []
WEBHOOK_URL = os.getenv("WEBHOOK_URL", "")


async def send_webhook(notif: dict):
    if not WEBHOOK_URL:
        return
    try:
        async with httpx.AsyncClient() as client:
            payload = {
                "text": f"*{notif['title']}*\nContainer: {notif.get('container_name', notif.get('container_id'))}\nReason: {notif['message']}"
            }
            await client.post(WEBHOOK_URL, json=payload, timeout=5.0)
    except Exception as e:
        log.warning("Failed to send webhook: %s", e)


async def broadcast_notification(notif: dict):
    """Push a notification to all connected SSE clients and optionally trigger Webhook."""
    for q in list(_notification_queues):
        try:
            q.put_nowait(notif)
        except asyncio.QueueFull:
            pass
    if WEBHOOK_URL:
        asyncio.create_task(send_webhook(notif))


# ── Critical Pattern Checker (background task) ────────────────────────────────
CRITICAL_PATTERNS = [
    ("ddos",           r"(ddos|denial.of.service|rate.limit.exceeded|too.many.connections)", "DDoS / Rate Limit"),
    ("deadlock",       r"(deadlock|dead.lock)",                                              "Database Deadlock"),
    ("race_condition", r"(race.condition|concurrent.modification)",                           "Race Condition"),
    ("nginx_error",    r"(upstream.timed.out|upstream.connect.error|502.bad.gateway)",        "Nginx Upstream Error"),
    ("db_error",       r"(database.connection.refused|cannot.connect.to.database|too.many.clients)", "Database Connection Error"),
    ("oom",            r"(out.of.memory|oom.killer|killed.process|cannot.allocate.memory)",  "Out of Memory"),
    ("crash",          r"(segmentation.fault|segfault|panic:|fatal.error|unhandled.exception)", "Application Crash"),
    ("disk_full",      r"(no.space.left|disk.full|filesystem.*full)",                         "Disk Full"),
]

import re as _re
_compiled_patterns = [
    (key, _re.compile(pat, _re.IGNORECASE), label)
    for key, pat, label in CRITICAL_PATTERNS
]

_last_notif_time: dict[str, float] = {}   # key → timestamp, throttle 60s per type
NOTIF_COOLDOWN_SEC = 60
_active_spam_alerts: set[str] = set()
_active_down_alerts: set[str] = set()
_pending_phase2: dict[str, float] = {}
SPAM_REQ_PER_SEC_THRESHOLD = 8.0
SPAM_COUNT_THRESHOLD = 240
SPAM_DDOS_HIT_THRESHOLD = 6
REQUEST_SPAM_THRESHOLD_PER_MIN = int(os.getenv("REQUEST_SPAM_THRESHOLD_PER_MIN", "120"))
REQUEST_SPAM_ALERT_COOLDOWN_SEC = int(os.getenv("REQUEST_SPAM_ALERT_COOLDOWN_SEC", "120"))


async def check_critical_logs():
    """Query ClickHouse for critical logs in last 2 minutes, broadcast if found."""
    try:
        sql = (
            "SELECT container_id, container_name, level, message, timestamp "
            "FROM logs.container_logs "
            "WHERE timestamp > now() - INTERVAL 2 MINUTE "
            "AND (level = 'error' OR lower(message) LIKE '%error%' OR lower(message) LIKE '%fatal%') "
            "ORDER BY timestamp DESC LIMIT 200 "
            "FORMAT JSONCompact"
        )
        url = f"http://{CH_HOST}:{CH_PORT}/"
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params={"query": sql},
                                   headers={"X-ClickHouse-User": CH_USER,
                                            "X-ClickHouse-Key": CH_PASS},
                                   timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status != 200:
                    return
                body = await resp.json(content_type=None)
                rows = body.get("data", [])

        now = time.time()
        for row in rows:
            cid, cname, level, message, ts = row[0], row[1], row[2], row[3], row[4]
            for key, pattern, label in _compiled_patterns:
                if pattern.search(message):
                    last = _last_notif_time.get(key, 0)
                    if now - last < NOTIF_COOLDOWN_SEC:
                        continue
                    _last_notif_time[key] = now
                    
                    notif = {
                        "id": int(now * 1000),
                        "type": key,
                        "severity": "critical",
                        "title": f"🚨 {label}",
                        "message": message[:200],
                        "container_id": cid,
                        "container_name": cname,
                        "timestamp": ts,
                    }
                    
                    # Persist to DB
                    try:
                        async with AsyncSessionLocal() as db:
                            await db.execute(text(
                                "INSERT INTO notifications (type, severity, title, message, container_id, container_name) "
                                "VALUES (:type, :severity, :title, :message, :cid, :cname)"
                            ), {"type": key, "severity": "critical", "title": notif["title"],
                                "message": notif["message"], "cid": cid, "cname": cname})
                            await db.commit()
                    except Exception as e:
                        log.warning("Failed to persist notification: %s", e)
                    
                    await broadcast_notification(notif)
                    break  # one notif per row
    except Exception as e:
        log.debug("check_critical_logs error: %s", e)

async def check_log_spam_anomalies():
    """Detect sustained spam/flood patterns with de-duplicated alerts."""
    try:
        # Normalize message text and group per container to detect sustained floods.
        # We require either:
        # - very high request rate, or
        # - high repeated volume with network/DDOS keywords.
        sql = (
            "SELECT "
            "container_id, "
            "any(container_name) as container_name, "
            "max(message) as sample_msg, "
            "count() as cnt, "
            "round(count() / 60.0, 2) as req_per_sec, "
            "sum(match(lower(message), '(ddos|denial.of.service|flood|rate.limit|too.many.requests|429|syn)')) as ddos_hits, "
            "substr(replaceRegexpAll(lower(message), '[0-9\\:\\\.\\+\\-]+', ''), 1, 60) as grp "
            "FROM logs.container_logs "
            "WHERE timestamp > now() - INTERVAL 1 MINUTE "
            "GROUP BY container_id, grp "
            f"HAVING req_per_sec >= {SPAM_REQ_PER_SEC_THRESHOLD} "
            f"OR (cnt >= {SPAM_COUNT_THRESHOLD} AND ddos_hits >= {SPAM_DDOS_HIT_THRESHOLD}) "
            "ORDER BY cnt DESC "
            "FORMAT JSONCompact"
        )
        url = f"http://{CH_HOST}:{CH_PORT}/"
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params={"query": sql},
                                   headers={"X-ClickHouse-User": CH_USER, "X-ClickHouse-Key": CH_PASS},
                                   timeout=10) as resp:
                if resp.status != 200:
                    log.debug("Spam check ClickHouse responded %s", resp.status)
                    return
                body = await resp.json(content_type=None)
                rows = body.get("data", [])
        log.debug("check_log_spam_anomalies found %d candidate groups", len(rows))

        current_spam_keys: set[str] = set()
        async with AsyncSessionLocal() as db:
            for row in rows:
                cid, cname, sample_msg, count, req_sec, ddos_hits, grp = row
                notif_key = f"spam_{cid}_{grp}"
                current_spam_keys.add(notif_key)

                # Alert once per active anomaly group; recover/reset when anomaly disappears.
                if notif_key in _active_spam_alerts:
                    continue

                now = time.time()
                if now - _last_notif_time.get(notif_key, 0) < NOTIF_COOLDOWN_SEC:
                    continue
                _last_notif_time[notif_key] = now
                _active_spam_alerts.add(notif_key)

                ddos_note = "Likely DDOS/flood pattern." if int(ddos_hits or 0) > 0 else "Repeated spam pattern."
                title = "🚨 Spam / DDOS Pattern Detected"
                msg = (
                    f"Container '{cname or cid}' is emitting abnormal volume: {req_sec} req/sec "
                    f"({count}/min). {ddos_note} Sample: {str(sample_msg)[:120]}..."
                )

                await db.execute(text(
                    "INSERT INTO notifications (type, severity, title, message, container_id, container_name) "
                    "VALUES ('log_spam', 'critical', :title, :msg, :cid, :cname)"
                ), {"title": title, "msg": msg, "cid": cid, "cname": cname})
                await db.commit()

                await broadcast_notification({
                    "type": "log_spam", "severity": "critical",
                    "title": title, "message": msg, "container_id": cid, "container_name": cname,
                    "timestamp": datetime.now(timezone.utc).isoformat()
                })
                log.info("Emitted log_spam for container=%s(%s) grp=%s count=%d", cname, cid, grp, count)

        # Reset state for groups that have recovered (so they can alert again later).
        _active_spam_alerts.difference_update(_active_spam_alerts - current_spam_keys)
    except Exception as e:
        log.warning("check_log_spam_anomalies error: %s", e)

async def _is_container_running(container_name: str) -> bool:
    """
    Run `docker exec <container_name> true`.
    Returns False only when daemon explicitly says container is not running.
    Returns True on success OR any inconclusive result (timeout, no docker, etc.)
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "docker", "exec", container_name, "true",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=10)
        stderr_text = stderr.decode(errors="replace").lower()
        if "is not running" in stderr_text or "no such container" in stderr_text:
            return False
        return True
    except asyncio.TimeoutError:
        log.warning("docker exec timed out for container=%s", container_name)
        return True  # inconclusive — don't false-alarm
    except FileNotFoundError:
        log.debug("docker binary not found, skipping exec check")
        return True
    except Exception as e:
        log.debug("docker exec check error for %s: %s", container_name, e)
        return True  # inconclusive


# ── State tracking ────────────────────────────────────────────────────────────
# _active_down_alerts  : containers currently in DOWN state (already notified)
# _pending_phase2      : containers that looked silent in phase-1 but not yet
#                        confirmed down — maps cid → timestamp of phase-1 check
_active_down_alerts: set[str] = set()
_pending_phase2: dict[str, float] = {}

async def check_container_downtime():
    """
    State-change-only notification logic:

      UNKNOWN / UP  →  silent > 5 min  →  docker exec confirms NOT running
                    →  transition to DOWN, notify once

      DOWN          →  logs resume OR docker exec confirms running again
                    →  transition to UP, notify once

    Phase-2 exists only to avoid false-positives from log lag:
      After silence is detected, docker exec is run immediately (phase-1).
      If it says the container is not running → DOWN alert is sent right away.
      5 minutes later a phase-2 exec runs to check for recovery.
      No duplicate alerts are ever sent while the state has not changed.
    """
    try:
        sql = (
            "SELECT container_id, any(container_name) as container_name, max(timestamp) as last_seen "
            "FROM logs.container_logs "
            "WHERE timestamp > now() - INTERVAL 1 HOUR "
            "GROUP BY container_id "
            "FORMAT JSONCompact"
        )
        url = f"http://{CH_HOST}:{CH_PORT}/"
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params={"query": sql},
                                   headers={"X-ClickHouse-User": CH_USER,
                                            "X-ClickHouse-Key": CH_PASS},
                                   timeout=10) as resp:
                if resp.status != 200:
                    return
                body = await resp.json(content_type=None)
                rows = body.get("data", [])

        now = time.time()
        down_threshold = datetime.now(timezone.utc) - timedelta(minutes=5)

        async with AsyncSessionLocal() as db:
            for row in rows:
                cid, cname, last_seen = row
                display = cname or cid

                # ── Parse timestamp ───────────────────────────────────────
                if isinstance(last_seen, datetime):
                    last_seen_dt = last_seen if last_seen.tzinfo else last_seen.replace(tzinfo=timezone.utc)
                else:
                    txt = str(last_seen).strip().replace("Z", "+00:00").replace(" ", "T")
                    try:
                        last_seen_dt = datetime.fromisoformat(txt)
                        if last_seen_dt.tzinfo is None:
                            last_seen_dt = last_seen_dt.replace(tzinfo=timezone.utc)
                    except ValueError:
                        log.debug("Invalid last_seen for container=%s: %s", cid, last_seen)
                        continue

                is_silent = last_seen_dt < down_threshold
                is_currently_down = cid in _active_down_alerts

                # ═══════════════════════════════════════════════════════════
                # Case A: logs are flowing — container looks healthy
                # ═══════════════════════════════════════════════════════════
                if not is_silent:
                    if is_currently_down:
                        # State change: DOWN → UP
                        # Confirm with docker exec before celebrating
                        if await _is_container_running(display):
                            _active_down_alerts.discard(cid)
                            _pending_phase2.pop(cid, None)
                            await _notify_recovered(db, cid, cname, last_seen)
                        # else: logs resumed but exec says still down — rare edge
                        # case, leave state as DOWN, will re-evaluate next tick
                    else:
                        # Normal active container — clear any stale phase-2 entry
                        _pending_phase2.pop(cid, None)
                    continue

                # ═══════════════════════════════════════════════════════════
                # Case B: silent container — run through the two-phase check
                # ═══════════════════════════════════════════════════════════

                # Already confirmed DOWN — just run phase-2 recovery check
                if is_currently_down:
                    phase1_ts = _pending_phase2.get(cid)
                    if phase1_ts and (now - phase1_ts) >= 300:
                        _pending_phase2.pop(cid)
                        if await _is_container_running(display):
                            # Recovered between phase-1 and phase-2
                            _active_down_alerts.discard(cid)
                            await _notify_recovered(db, cid, cname, last_seen)
                        # else: still down, state unchanged — no notification
                    continue

                # Waiting for phase-2 but not yet DOWN-notified — shouldn't
                # normally happen, but guard against it
                if cid in _pending_phase2:
                    continue

                # ── Phase 1: first time we see silence — docker exec check ─
                log.info("Silence detected for container=%s, running phase-1 docker exec", display)
                if await _is_container_running(display):
                    # Container is running fine — just not emitting logs
                    # Don't alert, don't set pending; re-evaluate next tick
                    log.debug("container=%s is running but silent — skipping alert", display)
                    continue

                # Confirmed NOT running → transition to DOWN
                _active_down_alerts.add(cid)
                _pending_phase2[cid] = now  # schedule phase-2 in ~5 min

                title = "⚠️ Container Down"
                msg = (
                    f"Container '{display}' has stopped running "
                    f"(confirmed via docker exec). Last log: {last_seen}."
                )
                log.info("DOWN alert: container=%s(%s)", display, cid)
                await db.execute(text(
                    "INSERT INTO notifications "
                    "(type, severity, title, message, container_id, container_name) "
                    "VALUES ('container_down', 'critical', :title, :msg, :cid, :cname)"
                ), {"title": title, "msg": msg, "cid": cid, "cname": cname})
                await db.commit()
                await broadcast_notification({
                    "type": "container_down", "severity": "critical",
                    "title": title, "message": msg,
                    "container_id": cid, "container_name": cname,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })

    except Exception as e:
        log.warning("check_container_downtime error: %s", e)

async def _notify_recovered(db, cid: str, cname: str, last_seen):
    """Send a single RECOVERED notification. Extracted to avoid duplication."""
    display = cname or cid
    title = "✅ Container Recovered"
    msg = f"Container '{display}' is running again. Last log: {last_seen}."
    log.info("RECOVERED alert: container=%s(%s)", display, cid)
    await db.execute(text(
        "INSERT INTO notifications "
        "(type, severity, title, message, container_id, container_name) "
        "VALUES ('container_recovered', 'info', :title, :msg, :cid, :cname)"
    ), {"title": title, "msg": msg, "cid": cid, "cname": cname})
    await db.commit()
    await broadcast_notification({
        "type": "container_recovered", "severity": "info",
        "title": title, "message": msg,
        "container_id": cid, "container_name": cname,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })

async def check_and_assign_containers():
    """Auto-map PSU registry containers to users based on image_name parsing."""
    try:
        sql = (
            "SELECT DISTINCT container_name, image_name "
            "FROM logs.container_logs "
            "WHERE timestamp > now() - INTERVAL 1 HOUR "
            "AND (image_name LIKE 'registry.in.psu.ac.th:443/%' OR image_name LIKE 'registry.in.psu.ac.th/%') "
            "FORMAT JSONCompact"
        )
        url = f"http://{CH_HOST}:{CH_PORT}/"
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params={"query": sql},
                                   headers={"X-ClickHouse-User": CH_USER, "X-ClickHouse-Key": CH_PASS},
                                   timeout=15) as resp:
                if resp.status != 200: return
                body = await resp.json(content_type=None)
                rows = body.get("data", [])

        # Parts: ["registry.in.psu.ac.th:443", "<username>", "<project>"]
        async with AsyncSessionLocal() as db:
            res = await db.execute(text("SELECT id, username FROM users"))
            users_map = {}
            for uid, uname in res.fetchall():
                if not uname:
                    continue
                uname_norm = str(uname).strip().lower()
                if not uname_norm:
                    continue
                # Support both full SSO username (e.g. student@email.psu.ac.th)
                # and registry segment format (e.g. student) for auto-assignment.
                users_map.setdefault(uname_norm, uid)
                if "@" in uname_norm:
                    users_map.setdefault(uname_norm.split("@", 1)[0], uid)
            
            for row in rows:
                cname, image_name = row[0], row[1]
                parts = image_name.split('/')
                if len(parts) >= 3:
                    username = parts[1].strip().lower()
                    uid = users_map.get(username)
                    if uid:
                        await db.execute(text(
                            "INSERT INTO container_ownership (container_id, user_id) "
                            "VALUES (:cname, :uid) "
                            "ON CONFLICT DO NOTHING"
                        ), {"cname": cname, "uid": uid})
            await db.commit()
    except Exception as e:
        log.warning("check_and_assign_containers error: %s", e)

# ── Global State for Circuit Breaker & Caching ────────────────────────────────
class CircuitBreaker:
    def __init__(self, failure_threshold=3, recover_time=30):
        self.failures = 0
        self.threshold = failure_threshold
        self.recover_time = recover_time
        self.last_failure_time = 0
        self.state = "CLOSED"  # CLOSED, OPEN

    def is_available(self):
        if self.state == "OPEN":
            if time.time() - self.last_failure_time > self.recover_time:
                self.state = "CLOSED"
                self.failures = 0
                return True
            return False
        return True

    def record_failure(self):
        self.failures += 1
        self.last_failure_time = time.time()
        if self.failures >= self.threshold:
            self.state = "OPEN"
            log.warning("Circuit Breaker OPEN after %d failures. ClickHouse is struggling.", self.failures)

    def record_success(self):
        self.failures = 0
        self.state = "CLOSED"

ch_circuit = CircuitBreaker()

# ── App Lifecycle & Rate Limiting ─────────────────────────────────────────────
scheduler = AsyncIOScheduler()
redis_client: redis_async.Redis = None
_nginx_ingester_task: asyncio.Task = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global redis_client, _nginx_ingester_task
    redis_host = os.getenv("REDIS_HOST", "redis")
    redis_client = redis_async.Redis(host=redis_host, port=6379, decode_responses=True)

    await init_db()
    # ตรวจจับ Error จากคำใน Log (Regex)
    scheduler.add_job(check_critical_logs, "interval", seconds=30, id="critical_checker")
    # ตรวจจับความผิดปกติเนื้อหาซ้ำซ้อน (Log Spam/DDoS IP)
    scheduler.add_job(check_log_spam_anomalies, "interval", seconds=30, id="spam_checker")
    # ตรวจจับ Container ดับ (Silence/Down timeout)
    scheduler.add_job(check_container_downtime, "interval", seconds=60, id="downtime_checker")
    # แม็พ Container จาก Registry เข้ากับ SSO Users แบบอัตโนมัติ
    scheduler.add_job(check_and_assign_containers, "interval", minutes=2, id="auto_assign_checker")

    scheduler.start()
    log.info("Scheduler started — checking logs and container health")
    yield
    scheduler.shutdown(wait=False)
    if redis_client:
        await redis_client.aclose()


async def rate_limit_login(request: Request):
    """Limit login attempts to 10 per minute per IP to prevent brute force."""
    if not redis_client: return
    forwarded = request.headers.get("X-Forwarded-For")
    ip = forwarded.split(",")[0] if forwarded else request.client.host
    key = f"rl:login:{ip}"
    current = await redis_client.incr(key)
    if current == 1:
        await redis_client.expire(key, 60)
    if current > 10:
        raise HTTPException(status_code=429, detail="Too many login attempts. Try again later.")

async def rate_limit_api(request: Request):
    """Limit general API requests to 100 per minute per IP."""
    if not redis_client: return
    forwarded = request.headers.get("X-Forwarded-For")
    ip = forwarded.split(",")[0] if forwarded else request.client.host
    key = f"rl:api:{ip}"
    current = await redis_client.incr(key)
    if current == 1:
        await redis_client.expire(key, 60)

    # Request-volume based spam detection (independent from log-content pattern detection).
    if current >= REQUEST_SPAM_THRESHOLD_PER_MIN:
        notif_key = f"request_spam:{ip}"
        now = time.time()
        last = _last_notif_time.get(notif_key, 0)
        if now - last >= REQUEST_SPAM_ALERT_COOLDOWN_SEC:
            _last_notif_time[notif_key] = now
            title = "🚨 Request Spam Detected"
            msg = (
                f"High request volume from IP {ip}: {current} requests/min. "
                f"Latest path: {request.url.path}"
            )
            try:
                async with AsyncSessionLocal() as db:
                    await db.execute(text(
                        "INSERT INTO notifications (type, severity, title, message, container_id, container_name) "
                        "VALUES ('log_spam', 'critical', :title, :msg, :cid, :cname)"
                    ), {"title": title, "msg": msg, "cid": "backend", "cname": "backend"})
                    await db.commit()
                await broadcast_notification({
                    "type": "log_spam",
                    "severity": "critical",
                    "title": title,
                    "message": msg,
                    "container_id": "backend",
                    "container_name": "backend",
                    "timestamp": datetime.now(timezone.utc).isoformat()
                })
            except Exception as e:
                log.warning("request spam notification error: %s", e)

    if current > 100:
        raise HTTPException(status_code=429, detail="Too many API requests.")


async def rate_limit_purge(request: Request):
    """Specific rate limit for purge endpoint: 1 request per 10 seconds per Admin."""
    if not redis_client: return
    forwarded = request.headers.get("X-Forwarded-For")
    ip = forwarded.split(",")[0] if forwarded else request.client.host
    key = f"rl:purge:{ip}"
    current = await redis_client.incr(key)
    if current == 1:
        await redis_client.expire(key, 10)
    if current > 1:
        raise HTTPException(status_code=429, detail="Please wait before performing another purge.")


app = FastAPI(title="Log Dashboard API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://monitor-eila.psu.ac.th",
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


# ── Auth dependency ───────────────────────────────────────────────────────────
def get_current_user(access_token: Optional[str] = Cookie(default=None)):
    if not access_token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = decode_token(access_token)
        return payload  # {"sub": username, "role": role, "user_id": id}
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


def require_role(*roles: str):
    def dep(user=Depends(get_current_user)):
        if user.get("role") not in roles:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return user
    return dep

# ── Nginx Hepler ───────────────────────────────────────────────────────────
def require_nginx_access():
    """Allow only admin and super_admin to access nginx logs."""
    return require_role("super_admin", "admin")


# ── Pydantic models ───────────────────────────────────────────────────────────
class LoginRequest(BaseModel):
    username: str
    password: str


class AssignContainerRequest(BaseModel):
    container_name: str
    user_id: int


class SettingsUpdateRequest(BaseModel):
    key: str
    value: str


class RoleUpdateRequest(BaseModel):
    user_id: int
    role: str


# ── Routes: Auth ──────────────────────────────────────────────────────────────
@app.post("/api/auth/login", dependencies=[Depends(rate_limit_login)])
async def login(req: LoginRequest, response: Response, db: AsyncSession = Depends(get_db)):
    """Login with Super Admin (.env) or Database Users."""
    # 1. Check Super Admin
    if check_super_admin(req.username, req.password):
        username = req.username
        role = "super_admin"
        user_id = 0
        display_name = req.username
    else:
        # 2. Check Database Users
        res = await db.execute(text(
            "SELECT id, username, password_hash, role, display_name FROM users WHERE username = :u"
        ), {"u": req.username})
        user = res.fetchone()
        
        if not user or not user[2] or not verify_password(req.password, user[2]):
            raise HTTPException(status_code=401, detail="Invalid credentials")
        
        user_id, username, _, role, display_name = user
        if not display_name: display_name = username

    token = create_access_token({
        "sub": username,
        "role": role,
        "user_id": user_id,
        "display_name": display_name,
    })
    response.set_cookie(
        key="access_token",
        value=token,
        httponly=True,
        samesite="lax",
        secure=False,
        max_age=ACCESS_TOKEN_EXPIRE_HOURS * 3600,
        path="/"
    )
    return {"ok": True, "role": role, "username": username}


@app.post("/api/auth/logout")
async def logout(response: Response):
    response.delete_cookie("access_token", path="/")
    return {"ok": True}


@app.get("/api/auth/me")
async def me(user=Depends(get_current_user)):
    return {
        "username": user.get("sub"),
        "role": user.get("role"),
        "user_id": user.get("user_id"),
        "display_name": user.get("display_name", user.get("sub")),
    }


# ── PSU SSO (Authentik) ───────────────────────────────────────────────────────
@app.get("/auth/sso")
async def sso_redirect():
    """Redirect to Authentik for PSU Passport login."""
    if not AUTHENTIK_CLIENT_ID:
        return HTMLResponse(
            "<h2>PSU SSO not configured yet.</h2>"
            "<p>Authentik credentials not set. Contact administrator.</p>"
            "<a href='/logstore/login'>← Back</a>",
            status_code=503,
        )
    AUTHENTIK_SCOPES = os.getenv("AUTHENTIK_SCOPES", "openid profile email descope.claims descope.custom_claims")
    params = urlencode({
        "client_id":     AUTHENTIK_CLIENT_ID,
        "response_type": "code",
        "scope":         AUTHENTIK_SCOPES,
        "redirect_uri":  AUTHENTIK_REDIRECT_URI,
    })
    return RedirectResponse(f"{AUTHENTIK_BASE_URL}/application/o/authorize/?{params}")


@app.get("/auth/callback")
async def sso_callback(code: str = Query(...), response: Response = None, db: AsyncSession = Depends(get_db)):
    """Handle Authentik callback, create/update user, issue JWT."""
    if not AUTHENTIK_CLIENT_ID:
        raise HTTPException(503, "PSU SSO not configured")

    # Exchange code for tokens
    token_url = f"{AUTHENTIK_BASE_URL}/application/o/token/"
    async with httpx.AsyncClient() as client:
        token_resp = await client.post(token_url, data={
            "grant_type":    "authorization_code",
            "code":          code,
            "redirect_uri":  AUTHENTIK_REDIRECT_URI,
            "client_id":     AUTHENTIK_CLIENT_ID,
            "client_secret": AUTHENTIK_CLIENT_SECRET,
        })
        if token_resp.status_code != 200:
            raise HTTPException(400, f"Token exchange failed: {token_resp.text}")
        tokens = token_resp.json()

        # Get user info
        userinfo_resp = await client.get(
            f"{AUTHENTIK_BASE_URL}/application/o/userinfo/",
            headers={"Authorization": f"Bearer {tokens['access_token']}"}
        )
        userinfo = userinfo_resp.json()

    sub = userinfo.get("sub")
    raw_name = userinfo.get("preferred_username") or userinfo.get("name") or sub
    username = str(raw_name).split("@")[0]
    email = userinfo.get("email", "")
    # Prefer display_name from SSO, fallback to cleaned username
    display_name = userinfo.get("display_name") or userinfo.get("name") or username

    # Upsert user (role = developer by default for new SSO users)
    # We now also save and update the display_name from SSO
    result = await db.execute(text(
        "INSERT INTO users (authentik_sub, username, email, display_name, role) "
        "VALUES (:sub, :username, :email, :display_name, 'developer') "
        "ON CONFLICT (authentik_sub) DO UPDATE "
        "SET username=EXCLUDED.username, email=EXCLUDED.email, display_name=EXCLUDED.display_name "
        "RETURNING id, role, display_name"
    ), {"sub": sub, "username": username, "email": email, "display_name": display_name})
    row = result.fetchone()
    await db.commit()
    user_id, role, final_display_name = row[0], row[1], row[2]

    access_token = create_access_token({
        "sub": username,
        "role": role,
        "user_id": user_id,
        "display_name": final_display_name,
    })
    resp = RedirectResponse(url="/logstore/", status_code=302)
    resp.set_cookie("access_token", access_token, httponly=True, samesite="lax", max_age=ACCESS_TOKEN_EXPIRE_HOURS * 3600, path="/")
    return resp


# ── Routes: ClickHouse Proxy ──────────────────────────────────────────────────
@app.get("/api/query", dependencies=[Depends(rate_limit_api)])
async def ch_query(q: str = Query(...), user=Depends(get_current_user),
                   db: AsyncSession = Depends(get_db)):
    """Proxy SELECT queries to ClickHouse with role-based container filtering and caching."""
    # 0. Circuit Breaker Check
    if not ch_circuit.is_available():
        # Check if we have any cached data to serve as fallback
        log.warning("Circuit Breaker is OPEN. Skipping ClickHouse query.")
        raise HTTPException(503, "Database temporarily unavailable (Circuit Breaker active)")

    # 1. Basic sanity: only allow SELECT
    stripped = q.strip().upper()
    if not stripped.startswith("SELECT"):
        raise HTTPException(400, "Only SELECT queries allowed on this endpoint")

    # 2. Developer role: inject container filter
    modified_q = q
    is_global = True  # Used for cache keying
    if user.get("role") == "developer":
        is_global = False
        result = await db.execute(text(
            "SELECT container_id FROM container_ownership WHERE user_id = :uid"
        ), {"uid": user.get("user_id")})
        owned = [row[0] for row in result.fetchall()]
        if not owned:
            return {"data": [], "rows": 0}
        
        cname_list = ",".join(f"'{c}'" for c in owned)
        filter_clause = f" container_name IN ({cname_list})"

        upper_q = q.upper()
        keywords = [" GROUP BY ", " ORDER BY ", " LIMIT ", " FORMAT "]
        insert_pos = len(q)
        for keyword in keywords:
            pos = upper_q.find(keyword)
            if pos != -1 and pos < insert_pos:
                insert_pos = pos
        
        prefix = q[:insert_pos].strip()
        suffix = q[insert_pos:]
        
        if " WHERE " in prefix.upper():
            modified_q = prefix + " AND " + filter_clause + suffix
        else:
            modified_q = prefix + " WHERE " + filter_clause + suffix
        
        log.info("Modified Query for Developer: %s", modified_q)

    # 3. Cache Check
    q_hash = hashlib.md5(modified_q.encode()).hexdigest()
    cache_key = f"cache:query:global:{q_hash}" if is_global else f"cache:query:user:{user.get('user_id')}:{q_hash}"
    ttl = 60 if is_global else 30

    if redis_client:
        cached = await redis_client.get(cache_key)
        if cached:
            log.info("Cache HIT for %s", cache_key)
            return JSONResponse(content=json.loads(cached))

    # 4. Perform Query
    url = f"http://{CH_HOST}:{CH_PORT}/"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url,
                                   params={"query": modified_q, "database": CH_DB,
                                           "default_format": "JSONCompact"},
                                   headers={"X-ClickHouse-User": CH_USER,
                                            "X-ClickHouse-Key": CH_PASS},
                                   timeout=aiohttp.ClientTimeout(total=20)) as resp:
                body = await resp.text()
                if resp.status != 200:
                    ch_circuit.record_failure()
                    log.error("ClickHouse Error (%d): %s", resp.status, body)
                    raise HTTPException(resp.status, f"ClickHouse error: {body[:300]}")
                
                ch_circuit.record_success()
                data = json.loads(body)
                
                # 5. Cache result
                if redis_client:
                    await redis_client.setex(cache_key, ttl, body)
                    
                return JSONResponse(content=data)
    except (aiohttp.ClientError, asyncio.TimeoutError) as e:
        ch_circuit.record_failure()
        log.error("ClickHouse connection/timeout error: %s", e)
        raise HTTPException(503, f"Failed to connect to database: {str(e)}")


@app.post("/api/exec")
async def ch_exec(request: Request, user=Depends(require_role("super_admin"))):
    """Proxy DDL/DML to ClickHouse — super_admin only."""
    sql = (await request.body()).decode("utf-8")
    stripped = sql.strip().upper()
    allowed_prefixes = ("TRUNCATE", "ALTER TABLE", "DROP PARTITION")
    if not any(stripped.startswith(p) for p in allowed_prefixes):
        raise HTTPException(400, "Only TRUNCATE / ALTER TABLE / DROP PARTITION allowed")

    url = f"http://{CH_HOST}:{CH_PORT}/"
    async with aiohttp.ClientSession() as session:
        async with session.post(url, data=sql,
                                params={"database": CH_DB},
                                headers={"X-ClickHouse-User": CH_USER,
                                         "X-ClickHouse-Key": CH_PASS,
                                         "Content-Type": "text/plain; charset=utf-8"},
                                timeout=aiohttp.ClientTimeout(total=120)) as resp:
            body = await resp.text()
            if resp.status != 200:
                raise HTTPException(resp.status, f"ClickHouse error: {body[:300]}")
            return {"ok": True}


# ── Routes: Export ────────────────────────────────────────────────────────────
@app.get("/api/export")
async def export_logs(
    container_names: str = Query(default=""),
    from_ts: Optional[str] = Query(default=None),
    to_ts:   Optional[str] = Query(default=None),
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Build list of container names to filter
    cnames = [c.strip() for c in container_names.split(",") if c.strip()] if container_names else []

    # Developer: restrict to owned containers
    if user.get("role") == "developer":
        result = await db.execute(text(
            "SELECT container_id FROM container_ownership WHERE user_id = :uid"
        ), {"uid": user.get("user_id")})
        owned = {row[0] for row in result.fetchall()}
        cnames = [c for c in cnames if c in owned] if cnames else list(owned)
        if not cnames:
            return StreamingResponse(iter([]), media_type="application/x-ndjson")

    parts = []
    if cnames:
        safe = ",".join(f"'{c}'" for c in cnames)
        parts.append(f"container_name IN ({safe})")
    if from_ts:
        parts.append(f"timestamp >= '{from_ts}'")
    if to_ts:
        parts.append(f"timestamp <= '{to_ts}'")

    where = ("WHERE " + " AND ".join(parts)) if parts else ""
    sql = (
        f"SELECT timestamp, container_id, container_name, image_name, level, stream, host, message, labels "
        f"FROM logs.container_logs {where} "
        f"ORDER BY timestamp ASC "
        f"FORMAT JSONEachRow"
    )

    url = f"http://{CH_HOST}:{CH_PORT}/"

    async def stream_rows():
        async with aiohttp.ClientSession() as session:
            async with session.get(url,
                                   params={"query": sql, "database": CH_DB},
                                   headers={"X-ClickHouse-User": CH_USER,
                                            "X-ClickHouse-Key": CH_PASS},
                                   timeout=aiohttp.ClientTimeout(total=300)) as resp:
                async for chunk in resp.content.iter_chunked(65536):
                    yield chunk

    filename = f"logs_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.jsv"
    return StreamingResponse(
        stream_rows(),
        media_type="application/x-ndjson",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Accel-Buffering": "no"
        },
    )


@app.get("/api/alerts/spam")
async def list_spam_alerts(
    limit: int = Query(default=50, ge=1, le=500),
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return recent `log_spam` notifications for UI review.

    Authenticated users can call this; developers will only see containers they own
    via the client-side filter if needed. Returns recent rows from `notifications`.
    """
    result = await db.execute(text(
        "SELECT id, title, message, container_id, container_name, created_at "
        "FROM notifications "
        "WHERE type = 'log_spam' "
        "ORDER BY created_at DESC LIMIT :lim"
    ), {"lim": limit})
    rows = result.fetchall()
    # If developer, restrict results to containers owned by the user
    if user.get("role") == "developer":
        res = await db.execute(text(
            "SELECT container_id FROM container_ownership WHERE user_id = :uid"
        ), {"uid": user.get("user_id")})
        owned = {row[0] for row in res.fetchall()}
        if not owned:
            return []
        rows = [r for r in rows if r[3] in owned]

    return [
        {
            "id": r[0],
            "title": r[1],
            "message": r[2],
            "container_id": r[3],
            "container_name": r[4],
            "created_at": str(r[5]),
        }
        for r in rows
    ]


@app.get("/api/debug/spam-scan")
async def debug_spam_scan(user=Depends(require_role("super_admin", "admin")), db: AsyncSession = Depends(get_db)):
    """Run the spam-detection SQL on-demand and return raw groups for debugging.

    Admins can use this to validate whether ClickHouse returns candidate groups
    after a stress run.
    """
    sql = (
        "SELECT "
        "container_id, "
        "any(container_name) as container_name, "
        "max(message) as sample_msg, "
        "count() as cnt, "
        "round(count() / 60.0, 2) as req_per_sec, "
        "sum(match(lower(message), '(ddos|denial.of.service|flood|rate.limit|too.many.requests|429|syn)')) as ddos_hits, "
        "substr(replaceRegexpAll(lower(message), '[0-9\\:\\\.\\+\\-]+', ''), 1, 60) as grp "
        "FROM logs.container_logs "
        "WHERE timestamp > now() - INTERVAL 1 MINUTE "
        "GROUP BY container_id, grp "
        f"HAVING req_per_sec >= {SPAM_REQ_PER_SEC_THRESHOLD} "
        f"OR (cnt >= {SPAM_COUNT_THRESHOLD} AND ddos_hits >= {SPAM_DDOS_HIT_THRESHOLD}) "
        "ORDER BY cnt DESC "
        "FORMAT JSONCompact"
    )
    url = f"http://{CH_HOST}:{CH_PORT}/"
    async with aiohttp.ClientSession() as session:
        async with session.get(url, params={"query": sql},
                               headers={"X-ClickHouse-User": CH_USER, "X-ClickHouse-Key": CH_PASS},
                               timeout=10) as resp:
            body = await resp.json(content_type=None) if resp.status == 200 else {"data": []}
            rows = body.get("data", [])
    # Return compact info for inspection
    return [{
        "container_id": r[0],
        "container_name": r[1],
        "sample": r[2][:200],
        "count": r[3],
        "req_per_sec": r[4],
        "ddos_hits": r[5],
        "grp": r[6]
    } for r in rows]


# ── Routes: Users & Roles ─────────────────────────────────────────────────────
@app.get("/api/admin/users")
async def list_users(
    q: str = Query(default=""),
    user=Depends(require_role("super_admin", "admin")),
    db: AsyncSession = Depends(get_db),
):
    """List/search users."""
    if q:
        result = await db.execute(text(
            "SELECT id, username, email, role, gitlab_id, created_at FROM users "
            "WHERE username ILIKE :q OR email ILIKE :q ORDER BY username LIMIT 50"
        ), {"q": f"%{q}%"})
    else:
        result = await db.execute(text(
            "SELECT id, username, email, role, gitlab_id, created_at FROM users ORDER BY username LIMIT 100"
        ))
    rows = result.fetchall()
    return [{"id": r[0], "username": r[1], "email": r[2], "role": r[3],
             "gitlab_id": r[4], "created_at": str(r[5])} for r in rows]


@app.post("/api/admin/users/role")
async def update_user_role(
    req: RoleUpdateRequest,
    user=Depends(require_role("super_admin")),   # only super_admin can change roles
    db: AsyncSession = Depends(get_db),
):
    valid_roles = {"developer", "admin"}
    if req.role not in valid_roles:
        raise HTTPException(400, f"Role must be one of: {valid_roles}")
    await db.execute(text(
        "UPDATE users SET role = :role WHERE id = :uid"
    ), {"role": req.role, "uid": req.user_id})
    await db.commit()
    return {"ok": True}


# ── Routes: Container Ownership & Aliases ─────────────────────────────────────
@app.get("/api/user/containers")
async def get_user_containers(user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Get the current user's containers and their custom names."""
    result = await db.execute(text(
        "SELECT container_id, custom_name "
        "FROM container_ownership WHERE user_id = :uid"
    ), {"uid": user.get("user_id")})
    rows = result.fetchall()
    return [{"container_name": r[0], "custom_name": r[1]} for r in rows]


class RenameContainerRequest(BaseModel):
    container_name: str
    custom_name: str


@app.post("/api/user/containers/rename")
async def rename_container(
    req: RenameContainerRequest, 
    user=Depends(get_current_user), 
    db: AsyncSession = Depends(get_db)
):
    """Rename a container for the current user."""
    # First check if they own it or are an admin
    if user.get("role") == "developer":
        res = await db.execute(text(
            "SELECT container_id FROM container_ownership WHERE user_id = :uid AND container_id = :cname"
        ), {"uid": user.get("user_id"), "cname": req.container_name})
        if not res.fetchone():
            raise HTTPException(status_code=403, detail="You do not own this container.")
        
    await db.execute(text(
        "INSERT INTO container_ownership (container_id, user_id, custom_name) VALUES (:cname, :uid, :custom) "
        "ON CONFLICT (container_id, user_id) DO UPDATE SET custom_name = EXCLUDED.custom_name"
    ), {"custom": req.custom_name, "uid": user.get("user_id"), "cname": req.container_name})
    await db.commit()
    return {"ok": True}


# ── Routes: Container Ownership ───────────────────────────────────────────────
@app.get("/api/admin/containers/ownership")
async def get_ownership(user=Depends(require_role("super_admin", "admin")),
                         db: AsyncSession = Depends(get_db)):
    result = await db.execute(text(
        "SELECT co.container_id, u.id, u.username, u.role, co.custom_name "
        "FROM container_ownership co JOIN users u ON co.user_id = u.id "
        "ORDER BY co.container_id"
    ))
    rows = result.fetchall()
    return [{"container_id": r[0], "container_name": r[0], "user_id": r[1], "username": r[2], "role": r[3], "custom_name": r[4]} for r in rows]


@app.post("/api/admin/containers/assign")
async def assign_container(
    req: AssignContainerRequest,
    user=Depends(require_role("super_admin", "admin")),
    db: AsyncSession = Depends(get_db),
):
    await db.execute(text(
        "INSERT INTO container_ownership (container_id, user_id) VALUES (:cname, :uid) "
        "ON CONFLICT DO NOTHING"
    ), {"cname": req.container_name, "uid": req.user_id})
    await db.commit()
    return {"ok": True}


@app.delete("/api/admin/containers/assign")
async def remove_container_assignment(
    container_name: str = Query(...),
    user_id: int = Query(...),
    user=Depends(require_role("super_admin", "admin")),
    db: AsyncSession = Depends(get_db),
):
    await db.execute(text(
        "DELETE FROM container_ownership WHERE container_id = :cname AND user_id = :uid"
    ), {"cname": container_name, "uid": user_id})
    await db.commit()
    return {"ok": True}


class PurgeRequest(BaseModel):
    type: str  # "container" | "stack"
    name: str

@app.post("/api/admin/purge", dependencies=[Depends(require_role("super_admin", "admin")), Depends(rate_limit_purge)])
async def purge_data(req: PurgeRequest):
    """Permanently delete logs for a container or stack (Heavyweight Mutation)."""
    if req.type == "container":
        where = f"container_name = '{req.name.replace("'", "''")}'"
    elif req.type == "stack":
        # Supports both com.docker.compose.project and com_docker_compose_project
        where = (
            f"JSONExtractString(labels, 'com.docker.compose.project') = '{req.name.replace("'", "''")}' "
            f"OR JSONExtractString(labels, 'com_docker_compose_project') = '{req.name.replace("'", "''")}'"
        )
    else:
        raise HTTPException(400, "Invalid purge type")

    sql = f"ALTER TABLE logs.container_logs DELETE WHERE {where} SETTINGS mutations_sync = 0"
    
    url = f"http://{CH_HOST}:{CH_PORT}/"
    async with aiohttp.ClientSession() as session:
        async with session.post(url, data=sql,
                                params={"database": CH_DB},
                                headers={"X-ClickHouse-User": CH_USER,
                                         "X-ClickHouse-Key": CH_PASS,
                                         "Content-Type": "text/plain; charset=utf-8"},
                                timeout=aiohttp.ClientTimeout(total=60)) as resp:
            body = await resp.text()
            if resp.status != 200:
                log.error("Purge Error (%d): %s", resp.status, body)
                raise HTTPException(resp.status, f"ClickHouse error: {body[:300]}")
            
            # Clear cache for this container/stack to reflect changes
            if redis_client:
                # We don't know the exact keys, so we rely on cache expiration or we could do a pattern delete
                # but pattern delete in Redis is slow. Clear common prefixes if needed.
                pass

            return {"ok": True, "message": "Purge mutation started asynchronously."}


# ── Routes: Settings ──────────────────────────────────────────────────────────
@app.get("/api/settings")
async def get_settings(user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    try:
        result = await db.execute(text("SELECT key, value FROM settings"))
        return {r[0]: r[1] for r in result.fetchall()}
    except Exception as e:
        log.exception("get_settings error: %s", e)
        raise HTTPException(status_code=500, detail="Failed to load settings")


@app.post("/api/settings")
async def update_setting(
    req: SettingsUpdateRequest,
    user=Depends(require_role("super_admin", "admin")),
    db: AsyncSession = Depends(get_db),
):
    await db.execute(text(
        "INSERT INTO settings (key, value) VALUES (:key, :value) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
    ), {"key": req.key, "value": req.value})
    await db.commit()
    return {"ok": True}


# ── Routes: Notifications ─────────────────────────────────────────────────────
@app.get("/api/notifications")
async def get_notifications(
    type: Optional[str] = Query(default=None),
    user=Depends(get_current_user), 
    db: AsyncSession = Depends(get_db)
):
    try:
        where = ""
        params = {}
        if type:
            where = "AND type = :type"
            params["type"] = type

        sql = f"SELECT id, type, severity, title, message, container_id, container_name, created_at, read_at FROM notifications WHERE 1=1 {where} ORDER BY created_at DESC LIMIT 200"
        result = await db.execute(text(sql), params)
        rows = result.fetchall()

        # If developer, restrict results to containers owned by the user
        if user.get("role") == "developer":
            res = await db.execute(text(
                "SELECT container_id FROM container_ownership WHERE user_id = :uid"
            ), {"uid": user.get("user_id")})
            owned = {row[0] for row in res.fetchall()}
            if not owned:
                return []
            rows = [r for r in rows if r[5] in owned]

        return [
            {
                "id": r[0], "type": r[1], "severity": r[2], "title": r[3],
                "message": r[4], "container_id": r[5], "container_name": r[6],
                "created_at": str(r[7]), "read": r[8] is not None
            } for r in rows]
    except Exception as e:
        log.exception("get_notifications error: %s", e)
        raise HTTPException(status_code=500, detail="Failed to load notifications")


@app.delete("/api/notifications/{notif_id}")
async def delete_notification(
    notif_id: int,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Delete a single notification."""
    await db.execute(text("DELETE FROM notifications WHERE id = :id"), {"id": notif_id})
    await db.commit()
    return {"ok": True}


@app.post("/api/notifications/clear")
async def clear_notifications(user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Mark all notifications as read or delete them (depending on UI preference)."""
    # For now, let's keep the 'Mark all read' logic but add a real delete all if you want
    await db.execute(text("UPDATE notifications SET read_at = now() WHERE read_at IS NULL"))
    await db.commit()
    return {"ok": True}


@app.get("/api/debug/db")
async def debug_db(user=Depends(require_role("super_admin", "admin")), db: AsyncSession = Depends(get_db)):
    """Admin-only DB health/check endpoint. Returns some quick diagnostics."""
    try:
        res = await db.execute(text("SELECT now()"))
        now_row = res.fetchone()
        res2 = await db.execute(text("SELECT count(*) FROM notifications"))
        cnt = res2.fetchone()[0]
        return {"now": str(now_row[0]), "notifications_count": int(cnt)}
    except Exception as e:
        log.exception("debug_db error: %s", e)
        raise HTTPException(status_code=500, detail="DB diagnostic failed")


@app.post("/api/debug/init-db")
async def debug_init_db(user=Depends(require_role("super_admin", "admin"))):
    """Admin-only: run the DB initialization SQL (creates missing tables/indexes and seeds users).

    Use this when the app started before the database was ready and migrations did not run.
    """
    try:
        await init_db()
        return {"ok": True, "message": "init_db executed"}
    except Exception as e:
        log.exception("debug_init_db error: %s", e)
        raise HTTPException(status_code=500, detail="init_db failed")


@app.post("/api/notifications/read")
async def mark_all_read(user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await db.execute(text(
        "UPDATE notifications SET read_at = now() WHERE read_at IS NULL"
    ))
    await db.commit()
    return {"ok": True}


@app.get("/api/notifications/stream")
async def notifications_stream(request: Request, user=Depends(get_current_user)):
    """Server-Sent Events endpoint for real-time critical notifications."""
    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    _notification_queues.append(q)

    async def event_generator():
        try:
            # Send heartbeat every 20s to keep connection alive
            while True:
                if await request.is_disconnected():
                    break
                try:
                    notif = q.get_nowait()
                    yield f"data: {json.dumps(notif)}\n\n"
                except asyncio.QueueEmpty:
                    yield ": heartbeat\n\n"
                    await asyncio.sleep(20)
        finally:
            _notification_queues.remove(q)

    return StreamingResponse(event_generator(), media_type="text/event-stream",
                              headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Routes: Real-time Log SSE Streams ─────────────────────────────────────────
@app.get("/api/logs/stream")
async def logs_stream(
    request: Request,
    container_names: str = Query(default=""),
    level: str = Query(default=""),
    search: str = Query(default=""),
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """SSE: push new container log rows every 3s."""
    cnames = [c.strip() for c in container_names.split(",") if c.strip()] if container_names else []

    if user.get("role") == "developer":
        result = await db.execute(text(
            "SELECT container_id FROM container_ownership WHERE user_id = :uid"
        ), {"uid": user.get("user_id")})
        owned = {row[0] for row in result.fetchall()}
        cnames = [c for c in cnames if c in owned] if cnames else list(owned)
    await db.close()

    last_ts = (datetime.now(timezone.utc) - timedelta(seconds=15)).strftime("%Y-%m-%d %H:%M:%S")

    async def event_generator():
        nonlocal last_ts
        url = f"http://{CH_HOST}:{CH_PORT}/"
        headers = {"X-ClickHouse-User": CH_USER, "X-ClickHouse-Key": CH_PASS}
        try:
            async with aiohttp.ClientSession() as s:
                while True:
                    if await request.is_disconnected():
                        break

                    parts = [f"timestamp > toDateTime64('{last_ts}', 3, 'UTC')"]
                    if cnames:
                        safe = ",".join(f"'{c}'" for c in cnames)
                        parts.append(f"container_name IN ({safe})")
                    if level:
                        parts.append(f"level = '{level.replace(chr(39), '')}'")
                    if search:
                        esc_s = search.replace("'", "''").replace("%", "\\%").replace("_", "\\_")
                        parts.append(f"message ILIKE '%{esc_s}%'")

                    sql = (
                        f"SELECT timestamp, container_name, level, message, "
                        f"formatDateTime(timestamp, '%Y-%m-%d %H:%i:%S', 'UTC') AS ts_utc "
                        f"FROM container_logs WHERE {' AND '.join(parts)} "
                        f"ORDER BY timestamp ASC LIMIT 100 FORMAT JSONCompact"
                    )
                    try:
                        async with s.get(url,
                                         params={"query": sql, "database": CH_DB},
                                         headers=headers,
                                         timeout=aiohttp.ClientTimeout(total=10)) as resp:
                            if resp.status == 200:
                                rows = json.loads(await resp.text()).get("data", [])
                                if rows:
                                    last_ts = max(r[4] for r in rows)
                                    out_rows = [r[:4] for r in rows]
                                    yield f"data: {json.dumps({'rows': out_rows})}\n\n"
                                else:
                                    yield ": heartbeat\n\n"
                            else:
                                body = await resp.text()
                                log.warning("logs/stream CH error %s: %s", resp.status, body[:200])
                                yield f"data: {json.dumps({'error': f'CH {resp.status}'})}\n\n"
                    except Exception as exc:
                        log.warning("logs/stream exception: %s", exc)
                        yield ": heartbeat\n\n"

                    await asyncio.sleep(2)
        except asyncio.CancelledError:
            pass

    return StreamingResponse(event_generator(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/nginx/stream")
async def nginx_stream(
    request: Request,
    user=Depends(require_role("super_admin", "admin")),
):
    """SSE: push new nginx log rows every 2s. Admin/super_admin only."""
    last_ts = (datetime.now(timezone.utc) - timedelta(seconds=15)).strftime("%Y-%m-%d %H:%M:%S")

    async def event_generator():
        nonlocal last_ts
        url = f"http://{CH_HOST}:{CH_PORT}/"
        headers = {"X-ClickHouse-User": CH_USER, "X-ClickHouse-Key": CH_PASS}
        try:
            async with aiohttp.ClientSession() as s:
                while True:
                    if await request.is_disconnected():
                        break

                    sql = (
                        f"SELECT timestamp, remote_addr, method, referer, path, status, bytes_sent, request_time, "
                        f"formatDateTime(timestamp, '%Y-%m-%d %H:%i:%S', 'UTC') AS ts_utc "
                        f"FROM nginx_logs WHERE timestamp > toDateTime64('{last_ts}', 3, 'UTC') "
                        f"ORDER BY timestamp ASC LIMIT 100 FORMAT JSONCompact"
                    )
                    try:
                        async with s.get(url,
                                         params={"query": sql, "database": CH_DB},
                                         headers=headers,
                                         timeout=aiohttp.ClientTimeout(total=10)) as resp:
                            if resp.status == 200:
                                rows = json.loads(await resp.text()).get("data", [])
                                if rows:
                                    last_ts = max(r[8] for r in rows)
                                    out_rows = [r[:8] for r in rows]
                                    yield f"data: {json.dumps({'rows': out_rows})}\n\n"
                                else:
                                    yield ": heartbeat\n\n"
                            else:
                                body = await resp.text()
                                log.warning("nginx/stream CH error %s: %s", resp.status, body[:200])
                                yield f"data: {json.dumps({'error': f'CH {resp.status}'})}\n\n"
                    except Exception as exc:
                        log.warning("nginx/stream exception: %s", exc)
                        yield ": heartbeat\n\n"

                    await asyncio.sleep(2)
        except asyncio.CancelledError:
            pass

    return StreamingResponse(event_generator(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/admin/backup/trigger")
async def trigger_backup(user=Depends(require_role("super_admin", "admin"))):
    """Admin-only: Trigger a manual backup by calling the backup service API."""
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post("http://backup:8080/trigger", timeout=10.0)
            if resp.status_code == 200:
                return resp.json()
            else:
                log.error("Backup service responded with status: %d body: %s", resp.status_code, resp.text)
                raise HTTPException(status_code=502, detail=f"Backup service error: {resp.text}")
    except httpx.ConnectError:
        log.error("Failed to connect to backup service at http://backup:8080")
        raise HTTPException(status_code=503, detail="Backup service is not available")
    except Exception as e:
        log.exception("trigger_backup error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))

# ── Nginx Ingester ────────────────────────────────────────────────────────────
NGINX_REDIS_KEY    = "nginx"
NGINX_BATCH_SIZE   = 200
NGINX_FLUSH_SECS   = 5


def _fmt_ts(ts_val) -> str:
    """Format any timestamp value to ClickHouse DateTime64 string."""
    try:
        if isinstance(ts_val, str):
            dt = datetime.fromisoformat(ts_val.replace("Z", "+00:00"))
        elif isinstance(ts_val, (int, float)):
            dt = datetime.fromtimestamp(ts_val, tz=timezone.utc)
        else:
            dt = datetime.now(timezone.utc)
    except Exception:
        dt = datetime.now(timezone.utc)
    return dt.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


async def nginx_log_ingester():
    """BLPOP nginx events from Redis and batch-insert into ClickHouse."""
    await ensure_nginx_tables()
    url     = f"http://{CH_HOST}:{CH_PORT}/"
    headers = {"X-ClickHouse-User": CH_USER, "X-ClickHouse-Key": CH_PASS}

    while True:
        batch: list[dict] = []
        deadline = asyncio.get_event_loop().time() + NGINX_FLUSH_SECS

        while len(batch) < NGINX_BATCH_SIZE:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                break
            try:
                result = await redis_client.blpop(NGINX_REDIS_KEY, timeout=max(1, int(remaining)))
            except Exception as e:
                log.debug("nginx_ingester redis error: %s", e)
                await asyncio.sleep(2)
                break
            if result is None:
                break
            try:
                batch.append(json.loads(result[1]))
            except Exception:
                continue

        if not batch:
            continue

        payload = "\n".join(
            json.dumps({
                "timestamp":    _fmt_ts(e.get("timestamp")),
                "source_host":  str(e.get("source_host", ""))[:128],
                "remote_addr":  str(e.get("remote_addr", ""))[:45],
                "method":       str(e.get("method", ""))[:10],
                "path":         str(e.get("path", ""))[:2048],
                "path_raw":     str(e.get("path_raw", e.get("path", "")))[:4096],
                "status":       int(e.get("status", 0)),
                "bytes_sent":   int(e.get("bytes_sent", 0)),
                "request_time": float(e.get("request_time", 0.0)),
                "user_agent":   str(e.get("user_agent", ""))[:512],
                "referer":      str(e.get("referer", "-"))[:512],
            })
            for e in batch
        )

        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(
                    url,
                    params={"query": "INSERT INTO logs.nginx_logs FORMAT JSONEachRow", "database": "logs"},
                    data=payload.encode(),
                    headers={**headers, "Content-Type": "application/x-ndjson"},
                    timeout=aiohttp.ClientTimeout(total=30),
                ) as resp:
                    if resp.status != 200:
                        body = await resp.text()
                        log.error("nginx_ingester insert error (%d): %s", resp.status, body[:300])
                    else:
                        log.debug("nginx_ingester: inserted %d rows", len(batch))
        except Exception as e:
            log.warning("nginx_ingester insert failed: %s", e)


# ── Nginx Tables Helper ───────────────────────────────────────────────────────────
_nginx_tables_created = False

async def ensure_nginx_tables():
    """Auto-create nginx tables if not exist."""
    global _nginx_tables_created
    if _nginx_tables_created:
        return

    queries = [
        """
        CREATE TABLE IF NOT EXISTS logs.nginx_logs
        (
            timestamp       DateTime64(3, 'Asia/Bangkok'),
            source_host     LowCardinality(String),
            remote_addr     String,
            method          LowCardinality(String),
            path            String,
            path_raw        String,
            status          UInt16,
            bytes_sent      UInt64,
            request_time    Float32,
            user_agent      String,
            referer         String          DEFAULT '-'
        )
        ENGINE = MergeTree()
        PARTITION BY toYYYYMM(timestamp)
        ORDER BY (timestamp, source_host, status)
        TTL toDateTime(timestamp) + INTERVAL 90 DAY
        SETTINGS merge_with_ttl_timeout = 86400
        """,
        "ALTER TABLE logs.nginx_logs ADD COLUMN IF NOT EXISTS source_host LowCardinality(String) DEFAULT ''",
        "ALTER TABLE logs.nginx_logs ADD COLUMN IF NOT EXISTS path_raw String DEFAULT ''",
        """
        CREATE TABLE IF NOT EXISTS logs.nginx_status_mv_target
        (
            minute      DateTime,
            status      UInt16,
            count       UInt64
        )
        ENGINE = SummingMergeTree()
        PARTITION BY toYYYYMM(minute)
        ORDER BY (minute, status)
        TTL minute + INTERVAL 90 DAY
        """,
        """
        CREATE MATERIALIZED VIEW IF NOT EXISTS logs.nginx_status_mv
        TO logs.nginx_status_mv_target
        AS
        SELECT toStartOfMinute(timestamp) AS minute, status, count() AS count
        FROM logs.nginx_logs GROUP BY minute, status
        """,
        """
        CREATE TABLE IF NOT EXISTS logs.nginx_top_paths_mv_target
        (
            hour        DateTime,
            path       String,
            total      UInt64,
            avg_time   Float32,
            error_count UInt64
        )
        ENGINE = SummingMergeTree()
        PARTITION BY toYYYYMM(hour)
        ORDER BY (hour, path)
        TTL hour + INTERVAL 90 DAY
        """,
        """
        CREATE MATERIALIZED VIEW IF NOT EXISTS logs.nginx_top_paths_mv
        TO logs.nginx_top_paths_mv_target
        AS
        SELECT toStartOfHour(timestamp) AS hour, path, count() AS total,
               avg(request_time) AS avg_time, countIf(status >= 400) AS error_count
        FROM logs.nginx_logs GROUP BY hour, path
        """,
        """
        CREATE TABLE IF NOT EXISTS logs.nginx_hourly_mv_target
        (
            hour          DateTime,
            total        UInt64,
            errors       UInt64,
            client_err   UInt64,
            bytes_total UInt64,
            avg_time    Float32
        )
        ENGINE = SummingMergeTree()
        PARTITION BY toYYYYMM(hour)
        ORDER BY hour
        TTL hour + INTERVAL 90 DAY
        """,
        """
        CREATE MATERIALIZED VIEW IF NOT EXISTS logs.nginx_hourly_mv
        TO logs.nginx_hourly_mv_target
        AS
        SELECT toStartOfHour(timestamp) AS hour, count() AS total,
               countIf(status >= 500) AS errors,
               countIf(status >= 400 AND status < 500) AS client_err,
               sum(bytes_sent) AS bytes_total,
               avg(request_time) AS avg_time
        FROM logs.nginx_logs GROUP BY hour
        """
    ]

    url = f"http://{CH_HOST}:{CH_PORT}/"
    headers = {"X-ClickHouse-User": CH_USER, "X-ClickHouse-Key": CH_PASS}

    async with aiohttp.ClientSession() as s:
        for q in queries:
            try:
                async with s.post(url, data=q, headers=headers) as resp:
                    await resp.text()
            except Exception:
                pass

    _nginx_tables_created = True


@app.post("/api/admin/nginx-logs/setup")
async def nginx_logs_setup(user=Depends(require_role("super_admin", "admin"))):
    """Create nginx_logs table and materialized views (manual trigger)."""
    global _nginx_tables_created
    _nginx_tables_created = False
    await ensure_nginx_tables()
    return {"message": "Nginx tables created successfully"}


# ── Routes: Nginx Logs (admin / super_admin only) ─────────────────────────────

@app.get("/api/admin/nginx-logs/overview")
async def nginx_overview(
    hours: int = Query(default=24, ge=1, le=168),
    user=Depends(require_role("super_admin", "admin")),
):
    await ensure_nginx_tables()
    cache_key = f"nginx:overview:{hours}"
    if redis_client:
        cached = await redis_client.get(cache_key)
        if cached:
            return json.loads(cached)

    query = f"""
        SELECT count() AS total,
               countIf(status >= 500) / count() * 100 AS error_rate,
               avg(request_time)          AS avg_time,
               quantile(0.95)(request_time) AS p95_time,
               sum(bytes_sent)            AS total_bytes
        FROM logs.nginx_logs
        WHERE timestamp >= now() - INTERVAL {int(hours)} HOUR
        FORMAT JSON
    """
    url = f"http://{CH_HOST}:{CH_PORT}/"
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(url, data=query,
                              headers={"X-ClickHouse-User": CH_USER,
                                       "X-ClickHouse-Key": CH_PASS}) as resp:
                data = (await resp.json(content_type=None)).get("data", [])
                row = data[0] if data else {}
    except Exception:
        row = {"total": 0, "error_rate": 0, "avg_time": 0, "p95_time": 0, "total_bytes": 0}

    result = {
        "total_requests":    int(row.get("total", 0)),
        "error_rate":        round(float(row.get("error_rate", 0)), 2),
        "avg_response_time": round(float(row.get("avg_time", 0)), 4),
        "p95_response_time": round(float(row.get("p95_time", 0)), 4),
        "total_bytes":       int(row.get("total_bytes", 0)),
    }
    if redis_client:
        await redis_client.setex(cache_key, 30, json.dumps(result))
    return result


@app.get("/api/admin/nginx-logs/traffic")
async def nginx_traffic(
    hours: int = Query(default=6, ge=1, le=48),
    user=Depends(require_role("super_admin", "admin")),
):
    await ensure_nginx_tables()
    cache_key = f"nginx:traffic:{hours}"
    if redis_client:
        cached = await redis_client.get(cache_key)
        if cached:
            return json.loads(cached)

    query = f"""
        SELECT minute, status, sum(count) AS count
        FROM logs.nginx_status_mv_target
        WHERE minute >= now() - INTERVAL {int(hours)} HOUR
        GROUP BY minute, status
        ORDER BY minute ASC
        FORMAT JSON
    """
    url = f"http://{CH_HOST}:{CH_PORT}/"
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(url, data=query,
                              headers={"X-ClickHouse-User": CH_USER,
                                       "X-ClickHouse-Key": CH_PASS}) as resp:
                data = (await resp.json(content_type=None)).get("data", [])
                result = data if data else []
    except Exception:
        result = []

    if redis_client:
        await redis_client.setex(cache_key, 60, json.dumps(result, default=str))
    return result


@app.get("/api/admin/nginx-logs/top-paths")
async def nginx_top_paths(
    hours: int = Query(default=24, ge=1, le=168),
    limit: int = Query(default=20, ge=1, le=100),
    user=Depends(require_role("super_admin", "admin")),
):
    await ensure_nginx_tables()
    cache_key = f"nginx:top_paths:{hours}:{limit}"
    if redis_client:
        cached = await redis_client.get(cache_key)
        if cached:
            return json.loads(cached)

    query = f"""
        SELECT referer, path, count() AS total,
               countIf(status >= 400) AS errors
        FROM logs.nginx_logs
        WHERE timestamp >= now() - INTERVAL {int(hours)} HOUR
        GROUP BY referer, path ORDER BY total DESC
        LIMIT {int(limit)}
        FORMAT JSON
    """
    url = f"http://{CH_HOST}:{CH_PORT}/"
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(url, data=query,
                              headers={"X-ClickHouse-User": CH_USER,
                                       "X-ClickHouse-Key": CH_PASS}) as resp:
                data = (await resp.json(content_type=None)).get("data", [])
                result = data if data else []
    except Exception:
        result = []

    if redis_client:
        await redis_client.setex(cache_key, 60, json.dumps(result, default=str))
    return result


@app.get("/api/admin/nginx-logs/top-ips")
async def nginx_top_ips(
    hours: int = Query(default=24, ge=1, le=168),
    limit: int = Query(default=20, ge=1, le=100),
    user=Depends(require_role("super_admin", "admin")),
):
    await ensure_nginx_tables()
    cache_key = f"nginx:top_ips:{hours}:{limit}"
    if redis_client:
        cached = await redis_client.get(cache_key)
        if cached:
            return json.loads(cached)

    query = f"""
        SELECT remote_addr, count() AS total,
               countIf(status >= 400) AS errors,
               avg(request_time) AS avg_time,
               max(timestamp) AS last_seen
        FROM logs.nginx_logs
        WHERE timestamp >= now() - INTERVAL {int(hours)} HOUR
        GROUP BY remote_addr ORDER BY total DESC
        LIMIT {int(limit)}
        FORMAT JSON
    """
    url = f"http://{CH_HOST}:{CH_PORT}/"
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(url, data=query,
                              headers={"X-ClickHouse-User": CH_USER,
                                       "X-ClickHouse-Key": CH_PASS}) as resp:
                data = (await resp.json(content_type=None)).get("data", [])
                result = data if data else []
    except Exception:
        result = []

    if redis_client:
        await redis_client.setex(cache_key, 60, json.dumps(result, default=str))
    return result


@app.get("/api/admin/nginx-logs/hourly")
async def nginx_hourly(
    days: int = Query(default=7, ge=1, le=30),
    user=Depends(require_role("super_admin", "admin")),
):
    await ensure_nginx_tables()
    cache_key = f"nginx:hourly:{days}"
    if redis_client:
        cached = await redis_client.get(cache_key)
        if cached:
            return json.loads(cached)

    query = f"""
        SELECT hour, sum(total) AS total, sum(errors) AS errors,
               sum(client_err) AS client_err, sum(bytes_total) AS bytes_total,
               avg(avg_time) AS avg_time
        FROM logs.nginx_hourly_mv_target
        WHERE hour >= now() - INTERVAL {int(days)} DAY
        GROUP BY hour ORDER BY hour ASC
        FORMAT JSON
    """
    url = f"http://{CH_HOST}:{CH_PORT}/"
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(url, data=query,
                              headers={"X-ClickHouse-User": CH_USER,
                                       "X-ClickHouse-Key": CH_PASS}) as resp:
                data = (await resp.json(content_type=None)).get("data", [])
                result = data if data else []
    except Exception:
        result = []

    if redis_client:
        await redis_client.setex(cache_key, 300, json.dumps(result, default=str))
    return result


@app.get("/api/admin/nginx-logs/logs")
async def nginx_logs_query(
    hours: int              = Query(default=24, ge=1, le=168),
    status_code: Optional[int]   = Query(default=None, alias="status"),
    method: Optional[str]        = Query(default=None),
    path_contains: Optional[str] = Query(default=None),
    remote_addr: Optional[str]   = Query(default=None),
    min_response_time: Optional[float] = Query(default=None),
    from_time: Optional[str]   = Query(default=None),
    to_time: Optional[str]     = Query(default=None),
    page: int               = Query(default=1, ge=1),
    page_size: int          = Query(default=50, ge=1, le=500),
    order: str              = Query(default="desc"),
    user=Depends(require_role("super_admin", "admin")),
):
    await ensure_nginx_tables()

    conditions = [f"timestamp >= now() - INTERVAL {int(hours)} HOUR"]
    if status_code is not None:
        conditions.append(f"status = {int(status_code)}")
    if method:
        conditions.append(f"method = '{method.upper().replace(chr(39), '')}'")
    if path_contains:
        conditions.append(f"path LIKE '%{path_contains.replace(chr(39), chr(39)*2)}%'")
    if remote_addr:
        conditions.append(f"remote_addr = '{remote_addr.replace(chr(39), '')}'")
    if min_response_time is not None:
        conditions.append(f"request_time >= {float(min_response_time)}")
    if from_time:
        conditions.append(f"timestamp >= toDateTime('{from_time}', 'Asia/Bangkok')")
    if to_time:
        conditions.append(f"timestamp <= toDateTime('{to_time}', 'Asia/Bangkok')")

    where     = " AND ".join(conditions)
    offset    = (page - 1) * page_size
    order_dir = "DESC" if order == "desc" else "ASC"
    url       = f"http://{CH_HOST}:{CH_PORT}/"
    headers   = {"X-ClickHouse-User": CH_USER, "X-ClickHouse-Key": CH_PASS}

    async with aiohttp.ClientSession() as s:
        try:
            async with s.post(url,
                              data=f"SELECT count() AS c FROM logs.nginx_logs WHERE {where} FORMAT JSON",
                              headers=headers) as resp:
                body = await resp.text()
                data = json.loads(body).get("data", []) if body else []
                total = int(data[0]["c"]) if data else 0
        except Exception:
            total = 0

        rows = []
        try:
            async with s.post(url, headers=headers, data=f"""
                SELECT timestamp, remote_addr, method,
                       referer, path, status, bytes_sent, request_time
                FROM logs.nginx_logs
                WHERE {where}
                ORDER BY timestamp {order_dir}
                LIMIT {int(page_size)} OFFSET {int(offset)}
                FORMAT JSONCompact
            """) as resp:
                body = await resp.text()
                rows = json.loads(body).get("data", []) if body else []
        except Exception:
            rows = []

    return {
        "data":      rows,
        "total":     total,
        "page":      page,
        "page_size": page_size,
        "pages":     (total + page_size - 1) // page_size,
    }

# ── Health check ──────────────────────────────────────────────────────────────
@app.get("/api/health", dependencies=[Depends(rate_limit_api)])
async def health():
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}
