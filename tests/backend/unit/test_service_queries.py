from backend.service_queries import build_services_summary_query


def test_services_summary_query_groups_by_stable_service_key():
    sql = build_services_summary_query(hours=6)

    assert "concat(host_id, '/', compose_project, '/', compose_service) AS service_key" in sql
    assert "GROUP BY" in sql
    assert "service_key" in sql
    assert "uniqExact(ContainerId) AS instance_count" in sql
    assert "Timestamp >= now() - INTERVAL 6 HOUR" in sql


def test_services_summary_query_reads_compose_service_from_resource_attributes():
    sql = build_services_summary_query()

    assert "ResourceAttributes['container.label.com.docker.compose.service']" in sql
    assert "ContainerName" in sql


def test_services_summary_query_can_filter_host_safely():
    sql = build_services_summary_query(host_id="home-server' OR 1=1 --")

    assert "HostName = 'home-server'' OR 1=1 --'" in sql
    assert "OR 1=1 --" in sql


def test_services_summary_query_can_filter_owned_containers():
    sql = build_services_summary_query(container_names=["api-1", "worker'2"])

    assert "ContainerName IN ('api-1', 'worker''2')" in sql


def test_services_summary_query_empty_container_filter_returns_no_rows():
    sql = build_services_summary_query(container_names=[])

    assert "WHERE Timestamp >= now() - INTERVAL 24 HOUR AND 0" in sql
