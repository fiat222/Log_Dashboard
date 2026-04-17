import asyncio
import os
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from passlib.context import CryptContext

pwd_ctx = CryptContext(schemes=['bcrypt'], deprecated='auto')
password_hash = pwd_ctx.hash('password123')
database_url = os.getenv('DATABASE_URL', 'postgresql+asyncpg://loguser:changeme@postgres:5432/logdash')

async def run():
    engine = create_async_engine(database_url)
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE users SET password_hash = :h WHERE username IN ('6510210495', '6710210419', 'admin123', 'dev123')"),
            {'h': password_hash}
        )
    print("Passwords updated successfully for all 4 users.")

if __name__ == '__main__':
    asyncio.run(run())
