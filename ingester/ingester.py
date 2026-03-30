"""
ingester/ingester.py — Redis (BLPOP) → ClickHouse bulk insert
=============================================================
Reads JSON events from the "filebeat" Redis list and inserts them in batches
into logs.container_logs. Designed to run as a long-lived Docker service.

Design decisions:
- BLPOP with 2s timeout: blocks until events arrive, CPU-friendly idle.
- Batch of 500 rows: balances latency vs. ClickHouse insert overhead.
- Flush interval: forced flush every 5s even if batch is incomplete,
  so the dashboard never lags more than 5s behind live traffic.
- Retry loop: if ClickHouse is unavailable, events stay in Redis (buffered).
"""

import json
import logging
import os
import time
from datetime import datetime, timezone

import clickhouse_connect
import redis

# ── Config from environment variables ─────────────────────────────────────────
REDIS_HOST       = os.getenv("REDIS_HOST", "redis")
REDIS_PORT       = int(os.getenv("REDIS_PORT", "6379"))
REDIS_KEY        = os.getenv("REDIS_KEY", "filebeat")
CH_HOST          = os.getenv("CLICKHOUSE_HOST", "clickhouse")
CH_PORT          = int(os.getenv("CLICKHOUSE_PORT", "8123"))
CH_DB            = os.getenv("CLICKHOUSE_DB", "logs")
CH_USER          = os.getenv("CLICKHOUSE_USER", "loguser")
CH_PASSWORD      = os.getenv("CLICKHOUSE_PASSWORD", "changeme")
BATCH_SIZE       = int(os.getenv("BATCH_SIZE", "500"))
FLUSH_INTERVAL   = float(os.getenv("FLUSH_INTERVAL", "5"))  # seconds

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [ingester] %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger(__name__)

COLUMNS = [
    "timestamp", "container_id", "container_name",
    "image_name", "level", "stream", "host", "message", "labels",
]


def parse_event(raw: bytes) -> list | None:
    """Parse a Filebeat JSON event into a ClickHouse row tuple."""
    try:
        ev = json.loads(raw)
        ts_str = ev.get("@timestamp") or ev.get("timestamp")
        try:
            ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        except Exception:
            ts = datetime.now(timezone.utc)

        return [
            ts,
            ev.get("container_id",   "unknown")[:64],
            ev.get("container_name", "unknown")[:128],
            ev.get("image_name",     "unknown")[:256],
            ev.get("level",          "info")[:16],
            ev.get("stream",         "stdout")[:8],
            ev.get("host",           "unknown")[:128],
            ev.get("message",        "")[:65536],
            json.dumps(ev.get("labels") or ev.get("docker", {}).get("container", {}).get("labels", {})),
        ]
    except Exception as exc:
        log.warning("Failed to parse event: %s | raw: %s", exc, raw[:200])
        return None


def connect_redis() -> redis.Redis:
    while True:
        try:
            r = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, socket_timeout=5)
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


def flush(ch: clickhouse_connect.driver.Client, batch: list) -> bool:
    """Insert batch into ClickHouse. Returns True on success."""
    if not batch:
        return True
    try:
        ch.insert(
            "container_logs",
            batch,
            column_names=COLUMNS,
            database=CH_DB,
        )
        return True
    except Exception as e:
        log.error("ClickHouse insert failed (%s), will retry next cycle", e)
        return False


def main():
    r  = connect_redis()
    ch = connect_clickhouse()

    batch: list = []
    last_flush   = time.monotonic()

    log.info(
        "Ingester started — batch=%d, flush_interval=%.1fs, key=%s",
        BATCH_SIZE, FLUSH_INTERVAL, REDIS_KEY,
    )

    while True:
        # BLPOP blocks up to 2s waiting for a new log event.
        result = r.blpop(REDIS_KEY, timeout=2)

        if result:
            _, raw = result
            row = parse_event(raw)
            if row:
                batch.append(row)

        now = time.monotonic()
        should_flush = (
            len(batch) >= BATCH_SIZE
            or (batch and now - last_flush >= FLUSH_INTERVAL)
        )

        if should_flush:
            ok = flush(ch, batch)
            if ok:
                log.info("Flushed %d rows to ClickHouse", len(batch))
                batch.clear()
                last_flush = now
            else:
                # Reconnect on persistent failure
                time.sleep(2)
                ch = connect_clickhouse()


if __name__ == "__main__":
    main()
