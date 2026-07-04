from apps.api.query_guards import apply_container_scope, ensure_select_query


def test_ensure_select_query_accepts_select_only():
    assert ensure_select_query(" select 1 ") == "select 1"


def test_ensure_select_query_rejects_non_select():
    try:
        ensure_select_query("DROP TABLE logs")
    except ValueError as exc:
        assert "Only SELECT" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_apply_container_scope_adds_where_before_order_by():
    query = "SELECT * FROM observability.otel_logs_local ORDER BY Timestamp DESC LIMIT 20"

    scoped = apply_container_scope(query, ["api", "worker"])

    assert "WHERE ContainerName IN ('api','worker')" in scoped
    assert scoped.index("WHERE") < scoped.index("ORDER BY")


def test_apply_container_scope_extends_existing_where_before_limit():
    query = "SELECT * FROM logs WHERE SeverityText = 'error' LIMIT 10"

    scoped = apply_container_scope(query, ["api"])

    assert "WHERE SeverityText = 'error' AND ContainerName IN ('api')" in scoped
    assert scoped.index("ContainerName") < scoped.index("LIMIT")


def test_apply_container_scope_escapes_container_names():
    query = "SELECT * FROM logs"

    scoped = apply_container_scope(query, ["api'one"])

    assert "api''one" in scoped
