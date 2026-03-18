from typing import Optional

from fastapi import APIRouter, HTTPException

from ..models import ContactProfile, RelatedContact
from .. import scout_client

router = APIRouter()


@router.get("/{identifier}", response_model=ContactProfile)
def get_profile(identifier: str, rubric: Optional[str] = None) -> ContactProfile:
    profile = scout_client.get_profile(identifier, rubric=rubric)
    if profile is None:
        raise HTTPException(status_code=404, detail=f"Contact not found: {identifier}")

    # Enrich with relationship graph (graceful fallback if enrichment not installed)
    try:
        import sys
        import os
        # Add project root to path so enrichment module is importable
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
        pass  # enrichment layer not available — skip silently

    return profile
