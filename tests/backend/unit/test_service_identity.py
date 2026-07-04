from apps.api.identity import build_service_identity


def test_builds_stable_service_key_from_compose_metadata():
    identity = build_service_identity(
        {
            "edge_host_id": "home-server",
            "compose_project": "shop-stack",
            "compose_service": "api",
            "container_id": "abc123",
            "container_name": "shop-stack-api-1",
        }
    )

    assert identity.service_key == "home-server/shop-stack/api"
    assert identity.instance_key == "abc123"
    assert identity.identity_confidence == "high"


def test_recreated_container_keeps_same_service_key():
    old_identity = build_service_identity(
        {
            "edge_host_id": "home-server",
            "compose_project": "shop-stack",
            "compose_service": "api",
            "container_id": "old-container",
        }
    )
    new_identity = build_service_identity(
        {
            "edge_host_id": "home-server",
            "compose_project": "shop-stack",
            "compose_service": "api",
            "container_id": "new-container",
        }
    )

    assert new_identity.service_key == old_identity.service_key
    assert new_identity.instance_key == "new-container"


def test_falls_back_to_container_name_for_non_compose_container():
    identity = build_service_identity(
        {
            "host.name": "test-vm",
            "container.name": "nginx-gateway",
            "container.id": "def456",
        }
    )

    assert identity.service_key == "test-vm/standalone/nginx-gateway"
    assert identity.instance_key == "def456"
    assert identity.identity_confidence == "fallback"

