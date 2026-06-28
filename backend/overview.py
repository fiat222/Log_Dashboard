def _to_int(value) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def build_overview_summary(service_rows: list[dict]) -> dict:
    hosts = {row.get("host_id") or "unknown" for row in service_rows}
    services = {row.get("service_key") for row in service_rows if row.get("service_key")}
    total_instances = sum(_to_int(row.get("instance_count")) for row in service_rows)
    active_instances = sum(_to_int(row.get("active_instance_count")) for row in service_rows)
    total_logs = sum(_to_int(row.get("log_count")) for row in service_rows)
    total_errors = sum(_to_int(row.get("error_count")) for row in service_rows)

    services_with_errors = sum(1 for row in service_rows if _to_int(row.get("error_count")) > 0)
    inactive_services = sum(
        1
        for row in service_rows
        if _to_int(row.get("instance_count")) > 0
        and _to_int(row.get("active_instance_count")) == 0
    )

    if not service_rows:
        status = "quiet"
    elif inactive_services or services_with_errors:
        status = "warning"
    else:
        status = "healthy"

    top_error_services = sorted(
        (row for row in service_rows if _to_int(row.get("error_count")) > 0),
        key=lambda row: (_to_int(row.get("error_count")), _to_int(row.get("log_count"))),
        reverse=True,
    )[:5]

    recent_services = sorted(
        service_rows,
        key=lambda row: _to_int(row.get("log_count")),
        reverse=True,
    )[:8]

    return {
        "totals": {
            "hosts": len(hosts) if service_rows else 0,
            "services": len(services),
            "instances": total_instances,
            "active_instances": active_instances,
            "logs": total_logs,
            "errors": total_errors,
        },
        "health": {
            "status": status,
            "services_with_errors": services_with_errors,
            "inactive_services": inactive_services,
        },
        "top_error_services": top_error_services,
        "recent_services": recent_services,
    }
