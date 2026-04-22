"""
ingester/ingester.py — Redis (BLPOP) → ClickHouse bulk insert
=============================================================
Reads JSON events from Redis and inserts them in batches into ClickHouse.
Runs two parallel workers:
  - Docker worker: BLPOPs from REDIS_KEY ("docker") → container_logs
  - Nginx worker:  BLPOPs from NGINX_REDIS_KEY ("nginx") → nginx_logs

Design decisions:
- BLPOP with 2s timeout: blocks until events arrive, CPU-friendly idle.
- Batch of 500 rows: balances latency vs. ClickHouse insert overhead.
- Flush interval: forced flush every 5s so dashboard never lags > 5s.
- Retry loop: if ClickHouse is unavailable, events stay in Redis (buffered).
- Threading: each worker owns its own ClickHouse connection to avoid contention.
"""

import json
import logging
import os
import threading
import time
from datetime import datetime, timezone

import clickhouse_connect
import redis

# ── Config from environment variables ─────────────────────────────────────────
REDIS_HOST          = os.getenv("REDIS_HOST", "redis")
REDIS_PORT          = int(os.getenv("REDIS_PORT", "6379"))
REDIS_PASSWORD      = os.getenv("REDIS_PASSWORD", None)
REDIS_KEY           = os.getenv("REDIS_KEY", "docker")
NGINX_REDIS_KEY     = os.getenv("NGINX_REDIS_KEY", "nginx")
CH_HOST             = os.getenv("CLICKHOUSE_HOST", "clickhouse")
CH_PORT             = int(os.getenv("CLICKHOUSE_PORT", "8123"))
CH_DB               = os.getenv("CLICKHOUSE_DB", "logs")
CH_USER             = os.getenv("CLICKHOUSE_USER", "loguser")
CH_PASSWORD         = os.getenv("CLICKHOUSE_PASSWORD", "changeme")
BATCH_SIZE          = int(os.getenv("BATCH_SIZE", "500"))
FLUSH_INTERVAL      = float(os.getenv("FLUSH_INTERVAL", "5"))   # seconds

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [ingester] %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger(__name__)

# ── Column definitions ────────────────────────────────────────────────────────
DOCKER_COLUMNS = [
    "timestamp", "container_id", "container_name",
    "image_name", "level", "stream", "host", "message", "labels",
]

NGINX_COLUMNS = [
    "timestamp", "source_host", "remote_addr", "method",
    "path", "path_raw", "status", "bytes_sent",
    "request_time", "user_agent", "referer",
]


# ── Helpers ───────────────────────────────────────────────────────────────────
def _str(val, default: str = "unknown", key: str = "name") -> str:
    """Safely convert any field value to a flat string."""
    if val is None:
        return default
    if isinstance(val, dict):
        return str(val.get(key) or val.get("id") or default)
    return str(val)


def _ts(ev: dict) -> datetime:
    """Parse @timestamp from event, fallback to now()."""
    ts_str = ev.get("@timestamp") or ev.get("timestamp")
    try:
        return datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
    except Exception:
        return datetime.now(timezone.utc)


# ── Parsers ───────────────────────────────────────────────────────────────────
def parse_docker_event(raw: bytes) -> list | None:
    """Parse a Filebeat Docker JSON event into a ClickHouse row."""
    try:
        ev = json.loads(raw)
        docker_meta = ev.get("docker", {}).get("container", {})
        ecs_meta    = ev.get("container", {})
        host_raw    = ev.get("host") or ev.get("host.name") or "unknown"

        return [
            _ts(ev),
            _str(ev.get("container_id") or ecs_meta.get("id") or docker_meta.get("id"),
                 default="unknown")[:64],
            _str(ev.get("container_name") or ecs_meta.get("name") or docker_meta.get("name"),
                 default="unknown")[:128],
            _str(ev.get("image_name") or ecs_meta.get("image", {}).get("name")
                 or docker_meta.get("image", {}).get("name"),
                 default="unknown")[:256],
            _str(ev.get("level"),   default="info")[:16],
            _str(ev.get("stream"),  default="stdout")[:8],
            _str(host_raw,          default="unknown")[:128],
            _str(ev.get("message"), default="")[:65536],
            json.dumps(ev.get("labels") or ecs_meta.get("labels")
                       or docker_meta.get("labels", {})),
        ]
    except Exception as exc:
        log.warning("Failed to parse docker event: %s | raw: %s", exc, raw[:200])
        return None


def parse_nginx_event(raw: bytes) -> list | None:
    """
    Parse a Vector nginx JSON event into a ClickHouse row.

    Vector sends the parsed nginx fields directly as a flat JSON object
    (after the remap transform in vector.toml). Shape expected:
    {
        "timestamp": "2024-01-01T00:00:00Z",  // ISO8601, set by Vector
        "source_host": "vm-nginx",
        "remote_addr": "1.2.3.4",
        "method": "GET",
        "path": "/api/logs",
        "path_raw": "/api/logs?page=1",
        "status": 200,
        "bytes_sent": 1234,
        "request_time": 0.012,
        "user_agent": "Mozilla/5.0 ...",
        "referer": "-"
    }
    """
    try:
        ev = json.loads(raw)

        return [
            _ts(ev),
            _str(ev.get("source_host"),   default="unknown")[:128],
            _str(ev.get("remote_addr"),   default="-")[:45],
            _str(ev.get("method"),        default="GET")[:8],
            _str(ev.get("path"),          default="/")[:2048],
            _str(ev.get("path_raw"),      default="/")[:2048],
            int(ev.get("status", 0)),
            int(ev.get("bytes_sent", 0)),
            float(ev.get("request_time", 0.0)),
            _str(ev.get("user_agent"),    default="-")[:512],
            _str(ev.get("referer"),       default="-")[:2048],
        ]
    except Exception as exc:
        log.warning("Failed to parse nginx event: %s | raw: %s", exc, raw[:200])
        return None


# ── Connection helpers ────────────────────────────────────────────────────────
def connect_redis() -> redis.Redis:
    while True:
        try:
            r = redis.Redis(
                host=REDIS_HOST,
                port=REDIS_PORT,
                password=REDIS_PASSWORD or None,
                socket_timeout=5,
            )
            r.ping()
            log.info("Connected to Redis at %s:%s", REDIS_HOST, REDIS_PORT)
            return r
        except Exception as e:
            log.warning("Redis unavailable (%s), retrying in 5s...", e)
            time.sleep(5)


def connect_clickhouse() -> clickhouse_connect.driver.Client:
    while True:
        try:
            client = clickhouse_connect.get_client(
                host=CH_HOST,
                port=CH_PORT,
                database=CH_DB,
                username=CH_USER,
                password=CH_PASSWORD,
                connect_timeout=10,
            )
            client.ping()
            log.info("Connected to ClickHouse at %s:%s/%s", CH_HOST, CH_PORT, CH_DB)
            return client
        except Exception as e:
            log.warning("ClickHouse unavailable (%s), retrying in 5s...", e)
            time.sleep(5)


# ── Generic flush ─────────────────────────────────────────────────────────────
def flush(
    ch: clickhouse_connect.driver.Client,
    table: str,
    columns: list,
    batch: list,
    label: str = "",
) -> bool:
    """Insert batch into ClickHouse. Returns True on success."""
    if not batch:
        return True
    try:
        ch.insert(table, batch, column_names=columns, database=CH_DB)
        log.info("Flushed %d %s rows → %s", len(batch), label, table)
        return True
    except Exception as e:
        log.error("ClickHouse insert failed [%s] (%s), will retry", table, e)
        return False


# ── Worker: Nginx logs ────────────────────────────────────────────────────────
def run_nginx_worker():
    """
    Separate thread: BLPOPs from NGINX_REDIS_KEY → nginx_logs table.
    Uses its own Redis + ClickHouse connections.
    """
    r  = connect_redis()
    ch = connect_clickhouse()

    batch: list  = []
    last_flush   = time.monotonic()

    log.info("Nginx worker started — key=%s", NGINX_REDIS_KEY)

    while True:
        result = r.blpop(NGINX_REDIS_KEY, timeout=2)

        if result:
            _, raw = result
            row = parse_nginx_event(raw)
            if row:
                batch.append(row)

        now          = time.monotonic()
        should_flush = (
            len(batch) >= BATCH_SIZE
            or (batch and now - last_flush >= FLUSH_INTERVAL)
        )

        if should_flush:
            ok = flush(ch, "nginx_logs", NGINX_COLUMNS, batch, "nginx")
            if ok:
                batch.clear()
                last_flush = time.monotonic()
            else:
                time.sleep(2)
                ch = connect_clickhouse()


# ── Worker: Docker logs (main thread) ────────────────────────────────────────
def run_docker_worker():
    r  = connect_redis()
    ch = connect_clickhouse()

    batch: list  = []
    last_flush   = time.monotonic()

    log.info(
        "Docker worker started — batch=%d, flush_interval=%.1fs, key=%s",
        BATCH_SIZE, FLUSH_INTERVAL, REDIS_KEY,
    )

    while True:
        result = r.blpop(REDIS_KEY, timeout=2)

        if result:
            _, raw = result
            row = parse_docker_event(raw)
            if row:
                batch.append(row)

        now          = time.monotonic()
        should_flush = (
            len(batch) >= BATCH_SIZE
            or (batch and now - last_flush >= FLUSH_INTERVAL)
        )

        if should_flush:
            ok = flush(ch, "container_logs", DOCKER_COLUMNS, batch, "docker")
            if ok:
                batch.clear()
                last_flush = time.monotonic()
            else:
                time.sleep(2)
                ch = connect_clickhouse()


# ── Entry point ───────────────────────────────────────────────────────────────
def main():
    # Nginx worker runs in a daemon thread
    nginx_thread = threading.Thread(
        target=run_nginx_worker,
        name="nginx-worker",
        daemon=True,
    )
    nginx_thread.start()
    log.info("Nginx worker thread started")

    # Docker worker runs on main thread
    run_docker_worker()


if __name__ == "__main__":
    main()