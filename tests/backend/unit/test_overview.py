from apps.api.overview import build_overview_summary


def test_build_overview_summary_rolls_up_service_rows():
    overview = build_overview_summary([
        {
            "host_id": "home-server",
            "service_key": "home-server/shop-stack/api",
            "instance_count": 2,
            "active_instance_count": 1,
            "log_count": 100,
            "error_count": 4,
        },
        {
            "host_id": "home-server",
            "service_key": "home-server/shop-stack/nginx",
            "instance_count": 1,
            "active_instance_count": 1,
            "log_count": 50,
            "error_count": 0,
        },
        {
            "host_id": "test-vm",
            "service_key": "test-vm/demo/postgres",
            "instance_count": 1,
            "active_instance_count": 0,
            "log_count": 10,
            "error_count": 2,
        },
    ])

    assert overview["totals"] == {
        "hosts": 2,
        "services": 3,
        "instances": 4,
        "active_instances": 2,
        "logs": 160,
        "errors": 6,
    }
    assert overview["health"]["status"] == "warning"
    assert overview["health"]["services_with_errors"] == 2
    assert overview["health"]["inactive_services"] == 1
    assert overview["top_error_services"][0]["service_key"] == "home-server/shop-stack/api"


def test_build_overview_summary_marks_empty_as_quiet():
    overview = build_overview_summary([])

    assert overview["totals"]["services"] == 0
    assert overview["health"]["status"] == "quiet"
    assert overview["top_error_services"] == []
