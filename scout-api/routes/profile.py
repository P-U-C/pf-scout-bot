from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from ..auth import VisibilityTier, apply_visibility_filter, get_visibility_tier
from ..models import ContactProfile, RelatedContact
from .. import scout_client

router = APIRouter()


@router.get("/{identifier}", response_model=ContactProfile)
def get_profile(
    identifier: str,
    rubric: Optional[str] = None,
    requester_wallet: Optional[str] = Query(None, description="XRPL r-address of the requesting wallet"),
) -> ContactProfile:
    profile = scout_client.get_profile(identifier, rubric=rubric)
    if profile is None:
        raise HTTPException(status_code=404, detail=f"Contact not found: {identifier}")

    # Determine caller's visibility tier
    tier = get_visibility_tier(requester_wallet)

    # SUSPENDED wallets may only view their own profile
    if tier == VisibilityTier.SUSPENDED:
        # Check if the identifier matches the requester's own wallet
        own = requester_wallet and (
            identifier == requester_wallet
            or identifier == f"postfiat:{requester_wallet}"
        )
        if not own:
            raise HTTPException(
                status_code=403,
                detail="Profile access restricted. Complete your authorization to view contributor profiles.",
            )

    # Enrich with relationship graph (graceful fallback)
    try:
        import os
        import sys
        project_root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        if project_root not in sys.path:
            sys.path.insert(0, project_root)
        from enrichment.relationships import get_related_contacts  # type: ignore[import]

        related_raw = get_related_contacts(profile.identifier)
        profile.related_contacts = [
            RelatedContact(
                contact_id=r["contact_id"],
                label=r["label"],
                relationship=r["relationship"],
            )
            for r in related_raw
        ]
    except Exception:
        pass

    # Apply visibility filter — strips notes/related_contacts for UNKNOWN/COOLDOWN
    filtered = apply_visibility_filter(profile.model_dump(), tier)
    return ContactProfile(**filtered)
