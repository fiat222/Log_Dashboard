from typing import Awaitable, Callable, Optional

from fastapi import APIRouter, Depends, Query

try:
    from overview import build_overview_summary
except ImportError:  # pragma: no cover - used when imported as apps.api package
    from apps.api.overview import build_overview_summary


FetchServiceSummary = Callable[..., Awaitable[dict]]


def create_observability_router(
    *,
    get_current_user,
    get_db,
    rate_limit_api,
    fetch_service_summary: FetchServiceSummary,
) -> APIRouter:
    """Create service/overview routes with dependencies injected from main app.

    The backend is being migrated out of the old monolithic main.py. Injecting
    dependencies keeps this router independent while still reusing the current
    auth, database session, rate-limit, and ClickHouse query helpers.
    """

    router = APIRouter()

    @router.get("/api/services", dependencies=[Depends(rate_limit_api)])
    async def list_services(
        hours: int = Query(default=24, ge=1, le=168),
        host_id: Optional[str] = Query(default=None),
        user=Depends(get_current_user),
        db=Depends(get_db),
    ):
        """Return service-level summary grouped by stable service identity."""

        result = await fetch_service_summary(
            hours=hours,
            host_id=host_id,
            user=user,
            db=db,
        )
        return {
            "data": result.get("data", []),
            "rows": result.get("rows", len(result.get("data", []))),
        }

    @router.get("/api/overview", dependencies=[Depends(rate_limit_api)])
    async def get_overview(
        hours: int = Query(default=24, ge=1, le=168),
        host_id: Optional[str] = Query(default=None),
        user=Depends(get_current_user),
        db=Depends(get_db),
    ):
        """Return overview rollups for the dashboard landing page."""

        result = await fetch_service_summary(
            hours=hours,
            host_id=host_id,
            user=user,
            db=db,
        )
        services = result.get("data", [])
        overview = build_overview_summary(services)
        return {
            **overview,
            "services": services,
            "rows": result.get("rows", len(services)),
            "window_hours": hours,
        }

    return router
