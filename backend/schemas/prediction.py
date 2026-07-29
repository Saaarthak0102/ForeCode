from pydantic import BaseModel


class PredictRequest(BaseModel):
    """Request body for the prediction endpoint."""
    contest_slug: str
    contest_title: str


class PredictionResult(BaseModel):
    """Successful prediction response."""
    contest_slug: str
    contest_title: str
    predicted_rating: float
    predicted_delta: float
    status: str  # "pending" (predicted, not yet confirmed by LeetCode)


class PredictionPending(BaseModel):
    """Response when prediction is not yet available."""
    message: str
