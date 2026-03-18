from fastapi import APIRouter, Query
from typing import Optional, List
from ..models import ContactSummary
from .. import scout_client

router = APIRouter()


@router.get("", response_model=List[ContactSummary])
def list_contacts(
    tier: Optional[str] = Query(None, description="top, mid, low"),
    limit: int = Query(20, ge=1, le=100),
    rubric: Optional[str] = Query(None),
    tags: Optional[List[str]] = Query(None),
    min_score: Optional[float] = Query(None),
) -> List[ContactSummary]:
    return scout_client.search_contacts(
        query="",
        limit=limit,
        tier=tier,
        tags=tags,
        rubric=rubric,
        min_score=min_score,
    )
