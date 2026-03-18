from fastapi import APIRouter

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

    # Apply source filter (external / internal) post-fetch
    if req.source:
        filtered = scout_client.filter_by_source(
            [r.model_dump() for r in results], req.source
        )
        results = [scout_client._to_summary(c) for c in filtered]

    return SearchResponse(results=results, total=len(results), query=req.query)
