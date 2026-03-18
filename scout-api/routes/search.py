from fastapi import APIRouter

from ..auth import VisibilityTier, get_visibility_tier
from ..models import SearchRequest, SearchResponse
from .. import scout_client

router = APIRouter()


@router.post("", response_model=SearchResponse)
def search(req: SearchRequest) -> SearchResponse:
    results = scout_client.search_contacts(
        query=req.query,
        limit=req.limit,
        tier=req.tier,
        tags=req.tags,
        rubric=req.rubric,
        min_score=req.min_score,
    )

    # Apply source filter (external / internal)
    if req.source:
        filtered = scout_client.filter_by_source(
            [r.model_dump() for r in results], req.source
        )
        results = [scout_client._to_summary(c) for c in filtered]

    # Visibility: UNKNOWN/COOLDOWN callers can't search external prospects
    # (those contacts contain private org-scouting data)
    visibility = get_visibility_tier(req.requester_wallet)
    if visibility in (VisibilityTier.UNKNOWN, VisibilityTier.COOLDOWN, VisibilityTier.SUSPENDED):
        results = [
            r for r in results
            if "external-prospect" not in (r.tags or [])
        ]

    return SearchResponse(results=results, total=len(results), query=req.query)
