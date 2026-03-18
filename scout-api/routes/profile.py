from fastapi import APIRouter, HTTPException
from typing import Optional
from ..models import ContactProfile
from .. import scout_client

router = APIRouter()


@router.get("/{identifier}", response_model=ContactProfile)
def get_profile(identifier: str, rubric: Optional[str] = None) -> ContactProfile:
    profile = scout_client.get_profile(identifier, rubric=rubric)
    if profile is None:
        raise HTTPException(status_code=404, detail=f"Contact not found: {identifier}")
    return profile
