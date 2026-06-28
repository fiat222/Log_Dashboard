import pytest
from httpx import ASGITransport, AsyncClient


class _FakeDbSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    async def execute(self, query):
        return None


class _FakeRedis:
    async def ping(self):
        return True


class _FakeClickHouseResponse:
    status_code = 200


class _FakeHttpClient:
    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    async def post(self, *args, **kwargs):
        return _FakeClickHouseResponse()


@pytest.mark.asyncio
async def test_health_returns_ok_when_dependencies_are_available(monkeypatch):
    import backend.main as main

    monkeypatch.setattr(main, "AsyncSessionLocal", lambda: _FakeDbSession())
    monkeypatch.setattr(main, "redis_client", _FakeRedis())
    monkeypatch.setattr(main.httpx, "AsyncClient", _FakeHttpClient)

    async with AsyncClient(
        transport=ASGITransport(app=main.app),
        base_url="http://testserver",
    ) as client:
        response = await client.get("/api/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["checks"] == {
        "postgres": "ok",
        "clickhouse": "ok",
        "redis": "ok",
    }


@pytest.mark.asyncio
async def test_services_endpoint_returns_service_summary(monkeypatch):
    import backend.main as main

    async def fake_clickhouse_json_query(sql, *, timeout_sec=20):
        assert "service_key" in sql
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

    async def fake_current_user():
        return {"user_id": 1, "role": "super_admin", "username": "superadmin"}

    async def fake_db():
        yield None

    monkeypatch.setattr(main, "_clickhouse_json_query", fake_clickhouse_json_query)
    main.app.dependency_overrides[main.get_current_user] = fake_current_user
    main.app.dependency_overrides[main.get_db] = fake_db

    try:
        async with AsyncClient(
            transport=ASGITransport(app=main.app),
            base_url="http://testserver",
        ) as client:
            response = await client.get("/api/services?hours=6")
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["rows"] == 1
    assert response.json()["data"][0]["service_key"] == "home-server/shop-stack/api"


@pytest.mark.asyncio
async def test_overview_endpoint_returns_rollup_and_services(monkeypatch):
    import backend.main as main

    async def fake_clickhouse_json_query(sql, *, timeout_sec=20):
        assert "service_key" in sql
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

    async def fake_current_user():
        return {"user_id": 1, "role": "super_admin", "username": "superadmin"}

    async def fake_db():
        yield None

    monkeypatch.setattr(main, "_clickhouse_json_query", fake_clickhouse_json_query)
    main.app.dependency_overrides[main.get_current_user] = fake_current_user
    main.app.dependency_overrides[main.get_db] = fake_db

    try:
        async with AsyncClient(
            transport=ASGITransport(app=main.app),
            base_url="http://testserver",
        ) as client:
            response = await client.get("/api/overview?hours=6")
    finally:
        main.app.dependency_overrides.clear()

    body = response.json()
    assert response.status_code == 200
    assert body["totals"]["services"] == 1
    assert body["totals"]["errors"] == 1
    assert body["services"][0]["service_key"] == "home-server/shop-stack/api"
