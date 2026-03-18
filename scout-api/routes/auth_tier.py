from fastapi import APIRouter, Query
from pydantic import BaseModel

from ..auth import VisibilityTier, get_visibility_tier

router = APIRouter()


class TierResponse(BaseModel):
    wallet: str
    tier: str


@router.get("/tier", response_model=TierResponse)
def get_tier(wallet: str = Query(..., description="XRPL r-address")) -> TierResponse:
    """Return the visibility tier for a given wallet. Used by the bot for rate limiting."""
    tier = get_visibility_tier(wallet)
    return TierResponse(wallet=wallet, tier=tier.value)
