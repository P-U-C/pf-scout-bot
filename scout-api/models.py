from pydantic import BaseModel
from typing import Optional, List, Any


class SearchRequest(BaseModel):
    query: str
    limit: int = 10
    tier: Optional[str] = None
    tags: Optional[List[str]] = None
    rubric: Optional[str] = None
    source: Optional[str] = None
    min_score: Optional[float] = None


class ContactSummary(BaseModel):
    identifier: str
    display_name: Optional[str] = None
    tier: Optional[str] = None
    score: Optional[float] = None
    tags: List[str] = []
    sources: List[str] = []
    last_updated: Optional[str] = None
    bio: Optional[str] = None


class ContactProfile(BaseModel):
    identifier: str
    display_name: Optional[str] = None
    all_identifiers: List[str] = []
    tier: Optional[str] = None
    score: Optional[float] = None
    rubric_used: Optional[str] = None
    tags: List[str] = []
    sources: List[str] = []
    notes: List[str] = []
    bio: Optional[str] = None
    location: Optional[str] = None
    skills: List[str] = []
    github_stats: Optional[dict] = None
    postfiat_stats: Optional[dict] = None
    last_updated: Optional[str] = None
    snapshot_history: List[dict] = []


class SearchResponse(BaseModel):
    results: List[ContactSummary]
    total: int
    query: str


class HealthResponse(BaseModel):
    status: str
    db_path: str
    contact_count: int
    version: str
