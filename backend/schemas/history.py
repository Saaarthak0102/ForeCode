from pydantic import BaseModel
from typing import Optional


class ContestHistoryItem(BaseModel):
    """A single contest entry in the user's history."""
    contest_slug: Optional[str] = None
    contest_title: Optional[str] = None
    actual_rating: Optional[float] = None
    actual_delta: Optional[float] = None
    predicted_rating: Optional[float] = None
    predicted_delta: Optional[float] = None
    status: str  # "confirmed" | "pending"
