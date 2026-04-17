import asyncio
import os
import aiohttp
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

POSTGRES_URL = os.getenv("DATABASE_URL", "postgresql+asyncpg://loguser:changeme@postgres:5432/logdash")
CH_HOST = os.getenv("CLICKHOUSE_HOST", "clickhouse")
CH_PORT = os.getenv("CLICKHOUSE_PORT", "8123")
CH_USER = os.getenv("CLICKHOUSE_USER", "loguser")
CH_PASS = os.getenv("CLICKHOUSE_PASSWORD", "changeme")

engine = create_async_engine(POSTGRES_URL)
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

async def trigger():
    sql = (
        "SELECT DISTINCT container_id, image_name "
        "FROM logs.container_logs "
        "WHERE image_name LIKE 'registry.in.psu.ac.th/%' "
        "OR image_name LIKE 'registry.in.psu.ac.th:443/%' "
        "FORMAT JSONCompact"
    )
    url = f"http://{CH_HOST}:{CH_PORT}/"
    async with aiohttp.ClientSession() as session:
        async with session.get(url, params={"query": sql},
                               headers={"X-ClickHouse-User": CH_USER, "X-ClickHouse-Key": CH_PASS}) as resp:
            if resp.status != 200:
                print(f"Error from ClickHouse: {resp.status}")
                return
            body = await resp.json(content_type=None)
            rows = body.get("data", [])

    async with AsyncSessionLocal() as db:
        res = await db.execute(text("SELECT id, username FROM users"))
        users_map = {row[1]: row[0] for row in res.fetchall()}
        count = 0
        for row in rows:
            cid, img = row[0], row[1]
            parts = img.split('/')
            if len(parts) >= 2:
                username = parts[1]
                uid = users_map.get(username)
                if uid:
                    await db.execute(text(
                        "INSERT INTO container_ownership (container_id, user_id) VALUES (:cid, :uid) ON CONFLICT DO NOTHING"
                    ), {"cid": cid, "uid": uid})
                    count += 1
        await db.commit()
    print(f"Triggered mapping for {count} container assignments.")

if __name__ == '__main__':
    asyncio.run(trigger())
