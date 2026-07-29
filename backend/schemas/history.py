from pydantic import BaseModel
from typing import Optional, Union


class LatestAttendedContest(BaseModel):
    """Latest attended contest from LeetCode GraphQL."""
    titleSlug: str
    title: str
    ranking: Optional[int] = None
    solved: Optional[int] = None
    totalQuestions: Optional[int] = None
    startTime: Optional[Union[int, str]] = None
    finishTime: Optional[Union[int, str]] = None


class SyncHistoryRequest(BaseModel):
    """Payload for synchronizing and fetching history."""
    latest_attended_contest: Optional[LatestAttendedContest] = None


class ContestHistoryItem(BaseModel):
    """A single contest entry in the user's history."""
    contest_slug: Optional[str] = None
    contest_title: Optional[str] = None
    actual_rating: Optional[float] = None
    actual_delta: Optional[float] = None
    predicted_rating: Optional[float] = None
    predicted_delta: Optional[float] = None
    ranking: Optional[int] = None
    solved: Optional[int] = None
    source: Optional[str] = None
    status: str  # "confirmed" | "pending" | "prediction_pending"
