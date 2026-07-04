import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from apps.api.routers.observability import create_observability_router


@pytest.mark.asyncio
async def test_observability_router_exposes_services_and_overview():
    async def fake_current_user():
        return {"user_id": 1, "role": "super_admin", "username": "superadmin"}

    async def fake_db():
        yield object()

    async def fake_rate_limit():
        return None

    async def fake_fetch_summary(*, hours, host_id, user, db):
        assert hours == 6
        assert host_id == "home-server"
        assert user["role"] == "super_admin"
        return {
            "data": [
                {
                    "service_key": "home-server/shop-stack/api",
                    "host_id": "home-server",
                    "compose_project": "shop-stack",
                    "compose_service": "api",
                    "instance_count": 2,
                    "active_instance_count": 1,
                    "log_count": 42,
                    "error_count": 1,
                    "sample_container_name": "shop-stack-api-1",
                }
            ],
            "rows": 1,
        }

    app = FastAPI()
    app.include_router(
        create_observability_router(
            get_current_user=fake_current_user,
            get_db=fake_db,
            rate_limit_api=fake_rate_limit,
            fetch_service_summary=fake_fetch_summary,
        )
    )

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as client:
        services = await client.get("/api/services?hours=6&host_id=home-server")
        overview = await client.get("/api/overview?hours=6&host_id=home-server")

    assert services.status_code == 200
    assert services.json()["data"][0]["service_key"] == "home-server/shop-stack/api"
    assert overview.status_code == 200
    assert overview.json()["totals"]["services"] == 1
    assert overview.json()["services"][0]["compose_service"] == "api"
