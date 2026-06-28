"""Query guard helpers for ClickHouse proxy endpoints.

These helpers are intentionally pure so the risky parts of `/api/query`
can be tested without a running ClickHouse/PostgreSQL/Redis stack.
"""


def ensure_select_query(sql: str) -> str:
    """Return stripped SQL when it is a SELECT query, else raise ValueError."""

    stripped = sql.strip()
    if not stripped.upper().startswith("SELECT"):
        raise ValueError("Only SELECT queries allowed on this endpoint")
    return stripped


def quote_clickhouse_string(value: str) -> str:
    """Quote a simple ClickHouse string literal."""

    return "'" + str(value).replace("'", "''") + "'"


def apply_container_scope(sql: str, container_names: list[str]) -> str:
    """Inject a ContainerName filter before GROUP/ORDER/LIMIT/FORMAT clauses."""

    if not container_names:
        return sql

    cname_list = ",".join(quote_clickhouse_string(name) for name in container_names)
    filter_clause = f"ContainerName IN ({cname_list})"

    upper_sql = sql.upper()
    keywords = [" GROUP BY ", " ORDER BY ", " LIMIT ", " FORMAT "]
    insert_pos = len(sql)
    for keyword in keywords:
        pos = upper_sql.find(keyword)
        if pos != -1 and pos < insert_pos:
            insert_pos = pos

    prefix = sql[:insert_pos].strip()
    suffix = sql[insert_pos:]

    if " WHERE " in prefix.upper():
        return prefix + " AND " + filter_clause + suffix
    return prefix + " WHERE " + filter_clause + suffix
