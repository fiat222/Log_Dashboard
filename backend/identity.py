"""Stable service identity helpers.

These helpers are intentionally pure and dependency-free so they can be tested
without ClickHouse, PostgreSQL, Redis, or Docker.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping


@dataclass(frozen=True)
class ServiceIdentity:
    """Logical workload identity plus runtime instance identity."""

    service_key: str
    instance_key: str | None
    identity_confidence: str


def _clean(value: object) -> str:
    return str(value or "").strip()


def build_service_identity(attributes: Mapping[str, object]) -> ServiceIdentity:
    """Build stable service identity from collector/container metadata.

    Preferred identity:
        host_id + compose_project + compose_service

    Fallback identity:
        host_id + container_name

    The fallback keeps the dashboard usable for non-Compose containers, but marks
    confidence lower because container names are less stable across deployments.
    """

    host_id = _clean(
        attributes.get("host_id")
        or attributes.get("edge_host_id")
        or attributes.get("host.name")
        or "unknown-host"
    )
    compose_project = _clean(
        attributes.get("compose_project")
        or attributes.get("com.docker.compose.project")
        or attributes.get("label.com.docker.compose.project")
    )
    compose_service = _clean(
        attributes.get("compose_service")
        or attributes.get("com.docker.compose.service")
        or attributes.get("label.com.docker.compose.service")
    )
    container_name = _clean(
        attributes.get("container_name")
        or attributes.get("container.name")
        or attributes.get("ContainerName")
    )
    container_id = _clean(
        attributes.get("container_id")
        or attributes.get("container.id")
        or attributes.get("ContainerId")
    )

    if compose_project and compose_service:
        return ServiceIdentity(
            service_key=f"{host_id}/{compose_project}/{compose_service}",
            instance_key=container_id or None,
            identity_confidence="high",
        )

    fallback_name = container_name or container_id or "unknown-container"
    return ServiceIdentity(
        service_key=f"{host_id}/standalone/{fallback_name}",
        instance_key=container_id or None,
        identity_confidence="fallback",
    )

