from datetime import datetime, timedelta, timezone

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


class _FakeGatewayResponse:
    status_code = 200


class _FakeDockerInspectResponse:
    status_code = 200

    def __init__(self, container_id):
        self.container_id = container_id

    def json(self):
        data = {
            'abc123def456': {'RestartCount': 0, 'State': {'OOMKilled': False, 'ExitCode': 0, 'StartedAt': '2026-07-02T12:00:00Z', 'FinishedAt': '0001-01-01T00:00:00Z'}},
            'def456abc123': {'RestartCount': 2, 'State': {'OOMKilled': False, 'ExitCode': 0, 'StartedAt': '2026-07-02T12:01:00Z', 'FinishedAt': '0001-01-01T00:00:00Z'}},
            'badbadbadbad': {'RestartCount': 1, 'State': {'OOMKilled': True, 'ExitCode': 137, 'StartedAt': '2026-07-02T12:02:00Z', 'FinishedAt': '2026-07-02T12:03:00Z'}},
        }
        return data.get(self.container_id, {'RestartCount': 0, 'State': {'OOMKilled': False, 'ExitCode': 0}})

class _FakeDockerContainersResponse:
    status_code = 200

    def json(self):
        return [
            {
                'Id': 'abc123def456',
                'Names': ['/log-backend'],
                'Image': 'logs-dashboard-backend:local',
                'State': 'running',
                'Status': 'Up 2 minutes (healthy)',
            },
            {
                'Id': 'def456abc123',
                'Names': ['/log-dashboard'],
                'Image': 'logs-dashboard-frontend:local',
                'State': 'running',
                'Status': 'Up 2 minutes',
            },
            {
                'Id': 'badbadbadbad',
                'Names': ['/otel-gateway'],
                'Image': 'otel/opentelemetry-collector-contrib:latest',
                'State': 'running',
                'Status': 'Up 2 minutes (unhealthy)',
            },
        ]


class _FakeHttpClient:
    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return None

    async def post(self, *args, **kwargs):
        return _FakeClickHouseResponse()

    async def get(self, *args, **kwargs):
        url = str(args[0]) if args else ''
        if '/containers/json' in url:
            return _FakeDockerContainersResponse()
        if '/containers/' in url and url.endswith('/json'):
            container_id = url.split('/containers/', 1)[1].split('/json', 1)[0]
            return _FakeDockerInspectResponse(container_id)
        return _FakeGatewayResponse()


@pytest.mark.asyncio
async def test_health_returns_ok_when_dependencies_are_available(monkeypatch):
    import apps.api.main as main

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
    import apps.api.main as main

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
    import apps.api.main as main

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


@pytest.mark.asyncio
async def test_platform_health_returns_stack_service_checks(monkeypatch):
    import apps.api.main as main

    monkeypatch.setattr(main, "AsyncSessionLocal", lambda: _FakeDbSession())
    monkeypatch.setattr(main, "redis_client", _FakeRedis())
    monkeypatch.setattr(main.httpx, "AsyncClient", _FakeHttpClient)

    async with AsyncClient(
        transport=ASGITransport(app=main.app),
        base_url="http://testserver",
    ) as client:
        response = await client.get("/api/platform/health")

    body = response.json()
    assert response.status_code == 200
    assert body["status"] == "ok"
    assert body["services"] == [
        {"id": "backend", "label": "Backend API", "status": "ok", "detail": "FastAPI responding"},
        {"id": "clickhouse", "label": "ClickHouse", "status": "ok", "detail": "SELECT 1 passed"},
        {"id": "postgres", "label": "PostgreSQL", "status": "ok", "detail": "SELECT 1 passed"},
        {"id": "redis", "label": "Redis", "status": "ok", "detail": "PING passed"},
        {"id": "otel_gateway", "label": "OTel Gateway", "status": "ok", "detail": "metrics endpoint responding"},
    ]


@pytest.mark.asyncio
async def test_platform_runtime_returns_container_snapshot(monkeypatch):
    import apps.api.main as main

    monkeypatch.setattr(main.httpx, 'AsyncClient', _FakeHttpClient)

    async with AsyncClient(
        transport=ASGITransport(app=main.app),
        base_url='http://testserver',
    ) as client:
        response = await client.get('/api/platform/runtime')

    body = response.json()
    assert response.status_code == 200
    assert body['status'] == 'ok'
    assert body['totals'] == {'total': 3, 'running': 3, 'healthy': 1, 'unhealthy': 1}
    assert body['diagnostics']['restarted'] == 2
    assert body['diagnostics']['oom_killed'] == 1
    assert body['diagnostics']['unhealthy'] == 1
    assert body['containers'][0] == {
        'id': 'abc123def456',
        'short_id': 'abc123def456',
        'name': 'log-backend',
        'image': 'logs-dashboard-backend:local',
        'state': 'running',
        'status': 'Up 2 minutes (healthy)',
        'health': 'healthy',
        'restart_count': 0,
        'oom_killed': False,
        'exit_code': 0,
        'started_at': '2026-07-02T12:00:00Z',
        'finished_at': '0001-01-01T00:00:00Z',
        'diagnostic': 'no restart or OOM signal',
    }
    assert body['containers'][2]['oom_killed'] is True
    assert body['containers'][2]['diagnostic'] == 'OOM killed'


@pytest.mark.asyncio
async def test_platform_uptime_returns_surface_checks(monkeypatch):
    import apps.api.main as main

    monkeypatch.setattr(main.httpx, 'AsyncClient', _FakeHttpClient)

    async with AsyncClient(
        transport=ASGITransport(app=main.app),
        base_url='http://testserver',
    ) as client:
        response = await client.get('/api/platform/uptime')

    body = response.json()
    assert response.status_code == 200
    assert body['status'] == 'ok'
    assert body['services'] == [
        {'id': 'dashboard', 'label': 'Dashboard UI', 'status': 'ok', 'detail': 'login surface responding'},
        {'id': 'backend_api', 'label': 'Backend API', 'status': 'ok', 'detail': 'health endpoint responding'},
        {'id': 'clickhouse_ui', 'label': 'ClickHouse UI', 'status': 'ok', 'detail': 'proxy surface responding'},
    ]


def test_nginx_top_paths_query_includes_latency_fields(monkeypatch):
    import apps.api.main as main

    captured = {}

    class FakeResponse:
        async def __aenter__(self):
            return self
        async def __aexit__(self, exc_type, exc, tb):
            return False
        async def json(self, content_type=None):
            return {"data": []}

    class FakeSession:
        async def __aenter__(self):
            return self
        async def __aexit__(self, exc_type, exc, tb):
            return False
        def post(self, url, data, headers):
            captured['query'] = data
            return FakeResponse()

    monkeypatch.setattr(main.aiohttp, 'ClientSession', lambda: FakeSession())
    main.redis_client = None

    import asyncio
    asyncio.run(main.nginx_top_paths(hours=24, limit=5, user={"role": "super_admin"}))

    assert 'avg_time' in captured['query']
    assert 'p95_time' in captured['query']
    assert 'ORDER BY errors DESC, p95_time DESC, total DESC' in captured['query']


def test_platform_gateway_correlation_links_gateway_and_app_signals(monkeypatch):
    import apps.api.main as main

    async def fake_overview(hours, user):
        return {"total_requests": 100, "error_rate": 5, "p95_response_time": 1.25}

    async def fake_top_paths(hours, limit, user):
        return [{"path": "/api/orders", "errors": 7, "p95_time": 1.5}]

    captured = {}

    async def fake_clickhouse(sql):
        captured["sql"] = sql
        return {"data": [{"errors": 3, "latest_error_ts": "2026-07-02 14:00:00"}]}

    monkeypatch.setattr(main, "nginx_overview", fake_overview)
    monkeypatch.setattr(main, "nginx_top_paths", fake_top_paths)
    monkeypatch.setattr(main, "_clickhouse_json_query", fake_clickhouse)

    import asyncio
    body = asyncio.run(main.platform_gateway_correlation(hours=1, user={"role": "super_admin"}))

    assert body["status"] == "danger"
    assert body["gateway"]["errors_5xx"] == 5
    assert body["gateway"]["errors_4xx"] == 2
    assert body["app"]["errors"] == 3
    assert {item["id"] for item in body["signals"]} >= {"gateway_5xx", "gateway_slow", "app_errors"}
    assert "ServiceName != 'nginx'" in captured["sql"]


def test_platform_workload_databases_returns_not_configured(monkeypatch):
    import apps.api.main as main

    monkeypatch.delenv('WORKLOAD_DATABASE_PROFILES', raising=False)

    import asyncio
    body = asyncio.run(main.platform_workload_databases(user={'role': 'super_admin'}))

    assert body['status'] == 'not_configured'
    assert body['databases'] == []
    assert {'type': 'postgres', 'label': 'PostgreSQL', 'signals': ['availability', 'connection probe']} in body['supported']
    assert 'WORKLOAD_DATABASE_PROFILES' in body['setup_hint']


def test_workload_database_profiles_mask_secret_dsn(monkeypatch):
    import apps.api.main as main

    monkeypatch.setenv('WORKLOAD_DATABASE_PROFILES', '[{"id":"orders","name":"Orders DB","type":"postgres","dsn_env":"ORDERS_DATABASE_URL"}]')
    monkeypatch.setenv('ORDERS_DATABASE_URL', 'postgresql://readonly:secret@orders-db:5432/orders')

    profiles = main._load_workload_database_profiles()

    assert profiles[0]['id'] == 'orders'
    assert profiles[0]['target'] == 'orders-db:5432/orders'
    assert 'secret' not in profiles[0]['target']



class _FakeResult:
    def __init__(self, rows=None, row=None):
        self._rows = rows or []
        self._row = row

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._row


class _FakeAlertDbSession:
    def __init__(self):
        self.rules = {}
        self.notifications = []
        self.next_rule_id = 1
        self.next_notification_id = 1

    async def execute(self, query, params=None):
        sql = str(query)
        params = params or {}
        if 'INSERT INTO alert_rules' in sql:
            now = datetime.now(timezone.utc)
            rule = {
                'id': self.next_rule_id,
                'name': params['name'],
                'source': params['source'],
                'condition': params['condition'],
                'severity': params['severity'],
                'recipients': params['recipients'],
                'cooldown_sec': params['cooldown_sec'],
                'enabled': params['enabled'],
                'last_fired_at': None,
                'created_at': now,
                'updated_at': now,
            }
            self.rules[self.next_rule_id] = rule
            self.next_rule_id += 1
            return _FakeResult(row=self._rule_tuple(rule))
        if 'SELECT id, name, source, condition, severity, recipients, cooldown_sec, enabled,' in sql and 'FROM alert_rules WHERE id = :id' in sql:
            rule = self.rules.get(params['id'])
            return _FakeResult(row=self._rule_tuple(rule) if rule else None)
        if 'SELECT id, name, source, condition, severity, recipients, cooldown_sec, enabled,' in sql and 'FROM alert_rules ORDER BY' in sql:
            rows = [self._rule_tuple(self.rules[rid]) for rid in sorted(self.rules.keys(), reverse=True)]
            return _FakeResult(rows=rows)
        if 'UPDATE alert_rules SET name = :name' in sql:
            rule = self.rules.get(params['id'])
            if not rule:
                return _FakeResult(row=None)
            rule.update({
                'name': params['name'],
                'source': params['source'],
                'condition': params['condition'],
                'severity': params['severity'],
                'recipients': params['recipients'],
                'cooldown_sec': params['cooldown_sec'],
                'enabled': params['enabled'],
                'updated_at': datetime.now(timezone.utc),
            })
            return _FakeResult(row=self._rule_tuple(rule))
        if 'INSERT INTO notifications' in sql and 'RETURNING id, type, severity, title, message' in sql:
            now = datetime.now(timezone.utc)
            notif = {
                'id': self.next_notification_id,
                'type': params['type'],
                'severity': params['severity'],
                'title': params['title'],
                'message': params['message'],
                'container_id': params['container_id'],
                'container_name': params['container_name'],
                'created_at': now,
                'read_at': None,
            }
            self.notifications.append(notif)
            self.next_notification_id += 1
            return _FakeResult(row=self._notification_tuple(notif))
        if 'UPDATE alert_rules SET last_fired_at = now(), updated_at = now()' in sql:
            rule = self.rules.get(params['id'])
            if rule:
                now = datetime.now(timezone.utc)
                rule['last_fired_at'] = now
                rule['updated_at'] = now
            return _FakeResult(row=None)
        raise AssertionError(f'Unexpected SQL: {sql}')

    async def commit(self):
        return None

    @staticmethod
    def _rule_tuple(rule):
        if not rule:
            return None
        return (
            rule['id'], rule['name'], rule['source'], rule['condition'], rule['severity'],
            rule['recipients'], rule['cooldown_sec'], rule['enabled'], rule['last_fired_at'],
            rule['created_at'], rule['updated_at'],
        )

    @staticmethod
    def _notification_tuple(notif):
        return (
            notif['id'], notif['type'], notif['severity'], notif['title'], notif['message'],
            notif['container_id'], notif['container_name'], notif['created_at'], notif['read_at'],
        )


def test_parse_alert_recipients_deduplicates_and_trims():
    import apps.api.main as main

    recipients = main._parse_alert_recipients('ops@example.com, dev@example.com\nops@example.com ; oncall@example.com')

    assert recipients == ['ops@example.com', 'dev@example.com', 'oncall@example.com']


@pytest.mark.asyncio
async def test_admin_alert_rules_create_list_and_test(monkeypatch):
    import apps.api.main as main

    fake_db = _FakeAlertDbSession()
    broadcasted = []

    async def fake_current_user():
        return {'user_id': 1, 'role': 'admin', 'username': 'admin'}

    async def fake_db_dep():
        yield fake_db

    async def fake_broadcast(notification):
        broadcasted.append(notification)

    main.app.dependency_overrides[main.get_current_user] = fake_current_user
    main.app.dependency_overrides[main.get_db] = fake_db_dep
    monkeypatch.setattr(main, 'broadcast_notification', fake_broadcast)

    try:
        async with AsyncClient(
            transport=ASGITransport(app=main.app),
            base_url='http://testserver',
        ) as client:
            create_response = await client.post('/api/admin/alert-rules', json={
                'name': 'High 5xx burst',
                'source': 'gateway',
                'condition': '5xx rate above 5 percent for 5 minutes',
                'severity': 'critical',
                'recipients': 'ops@example.com, dev@example.com',
                'cooldown_sec': 300,
                'enabled': True,
            })
            list_response = await client.get('/api/admin/alert-rules')
            test_response = await client.post('/api/admin/alert-rules/1/test')
    finally:
        main.app.dependency_overrides.clear()

    assert create_response.status_code == 200
    assert create_response.json()['recipients'] == ['ops@example.com', 'dev@example.com']
    assert list_response.status_code == 200
    assert list_response.json()[0]['name'] == 'High 5xx burst'
    assert test_response.status_code == 200
    assert test_response.json()['status'] == 'sent'
    assert test_response.json()['notification']['type'] == 'custom_alert'
    assert broadcasted[0]['title'] == 'High 5xx burst alert test'


@pytest.mark.asyncio
async def test_admin_alert_rule_test_respects_cooldown(monkeypatch):
    import apps.api.main as main

    fake_db = _FakeAlertDbSession()
    now = datetime.now(timezone.utc)
    fake_db.rules[1] = {
        'id': 1,
        'name': 'High latency',
        'source': 'application',
        'condition': 'p95 above 900ms',
        'severity': 'warning',
        'recipients': 'ops@example.com',
        'cooldown_sec': 300,
        'enabled': True,
        'last_fired_at': now - timedelta(seconds=30),
        'created_at': now,
        'updated_at': now,
    }

    async def fake_current_user():
        return {'user_id': 1, 'role': 'admin', 'username': 'admin'}

    async def fake_db_dep():
        yield fake_db

    async def fake_broadcast(notification):
        raise AssertionError('broadcast should not run during cooldown')

    main.app.dependency_overrides[main.get_current_user] = fake_current_user
    main.app.dependency_overrides[main.get_db] = fake_db_dep
    monkeypatch.setattr(main, 'broadcast_notification', fake_broadcast)

    try:
        async with AsyncClient(
            transport=ASGITransport(app=main.app),
            base_url='http://testserver',
        ) as client:
            response = await client.post('/api/admin/alert-rules/1/test')
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()['status'] == 'cooldown'
    assert response.json()['remaining_sec'] > 0



def test_sanitize_visible_text_removes_known_mojibake_prefix():
    import apps.api.main as main

    assert main._sanitize_visible_text('???? Database Deadlock') == 'Database Deadlock'
    assert main._sanitize_visible_text('?????? Backup Failed') == 'Backup Failed'


def test_serialize_notification_row_sanitizes_title_and_message():
    import apps.api.main as main

    row = (
        1,
        'deadlock',
        'critical',
        '???? Database Deadlock',
        '?????? Process blocked',
        'cid',
        'postgres',
        '2026-07-03T21:19:55Z',
        None,
    )

    payload = main._serialize_notification_row(row)

    assert payload['title'] == 'Database Deadlock'
    assert payload['message'] == 'Process blocked'



class _FakeIncidentDbSession:
    async def execute(self, query, params=None):
        sql = str(query)
        if 'FROM notifications WHERE created_at >=' in sql:
            rows = [
                (1, 'container_down', 'critical', 'Container Down', 'backend stopped responding', 'abc123', 'shop-stack-api-1', '2026-07-03T14:11:00Z', None),
            ]
            return _FakeResult(rows=rows)
        raise AssertionError(f'Unexpected SQL: {sql}')


@pytest.mark.asyncio
async def test_platform_incident_timeline_returns_bounded_bundle(monkeypatch):
    import apps.api.main as main

    async def fake_clickhouse_json_query(sql, *, timeout_sec=20):
        if 'count() AS total_logs' in sql:
            return {
                'data': [
                    {
                        'total_logs': 42,
                        'error_logs': 6,
                        'warning_logs': 2,
                        'latest_log_ts': '2026-07-03T14:10:00Z',
                        'sample_container_name': 'shop-stack-api-1',
                    }
                ]
            }
        if 'SELECT Timestamp, ContainerName, SeverityText, Body' in sql:
            return {
                'data': [
                    {
                        'Timestamp': '2026-07-03T14:10:00Z',
                        'ContainerName': 'shop-stack-api-1',
                        'SeverityText': 'ERROR',
                        'Body': 'database timeout while serving request',
                    }
                ]
            }
        raise AssertionError(f'Unexpected ClickHouse SQL: {sql}')

    async def fake_runtime():
        return {
            'status': 'ok',
            'containers': [
                {
                    'name': 'shop-stack-api-1',
                    'oom_killed': False,
                    'restart_count': 2,
                    'state': 'running',
                    'health': 'healthy',
                    'diagnostic': 'restarted 2 times',
                    'started_at': '2026-07-03T14:08:00Z',
                    'finished_at': '2026-07-03T14:09:00Z',
                }
            ],
        }

    async def fake_gateway(hours=1, user=None):
        return {
            'status': 'danger',
            'gateway': {'errors_5xx': 3, 'p95_response_time': 1.2},
            'app': {'errors': 6, 'latest_error_ts': '2026-07-03T14:09:30Z'},
            'signals': [
                {'severity': 'danger', 'label': 'Gateway 5xx', 'detail': '3 server errors in window', 'action': 'network-errors'},
            ],
        }

    async def fake_current_user():
        return {'user_id': 1, 'role': 'admin', 'username': 'admin'}

    async def fake_db_dep():
        yield _FakeIncidentDbSession()

    main.app.dependency_overrides[main.get_current_user] = fake_current_user
    main.app.dependency_overrides[main.get_db] = fake_db_dep
    monkeypatch.setattr(main, '_clickhouse_json_query', fake_clickhouse_json_query)
    monkeypatch.setattr(main, 'platform_runtime', fake_runtime)
    monkeypatch.setattr(main, 'platform_gateway_correlation', fake_gateway)

    try:
        async with AsyncClient(
            transport=ASGITransport(app=main.app),
            base_url='http://testserver',
        ) as client:
            response = await client.get('/api/platform/incidents/timeline?service_key=home-server/shop-stack/api&hours=1')
    finally:
        main.app.dependency_overrides.clear()

    body = response.json()
    assert response.status_code == 200
    assert body['service']['service_key'] == 'home-server/shop-stack/api'
    assert body['summary']['error_logs'] == 6
    assert body['summary']['runtime_signals'] == 1
    assert body['summary']['notifications'] == 1
    assert body['summary']['gateway_5xx'] == 3
    assert body['timeline'][0]['source'] in {'gateway', 'application_log', 'runtime', 'notification'}
    assert body['bundle']['scope']['service_key'] == 'home-server/shop-stack/api'
    assert 'No raw database access' in body['bundle']['ai_boundary']
