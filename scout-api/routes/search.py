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
    return SearchResponse(results=results, total=len(results), query=req.query)
