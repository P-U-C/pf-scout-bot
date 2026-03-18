from fastapi import APIRouter
from ..models import HealthResponse
from .. import scout_client
from ..config import settings

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        db_path=settings.pf_scout_db,
        contact_count=scout_client.get_contact_count(),
        version="0.1.0",
    )
