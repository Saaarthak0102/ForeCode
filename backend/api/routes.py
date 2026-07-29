"""
API route handlers.

Thin route layer — validates input, delegates to services, returns typed responses.
"""

import logging
from typing import List

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import JSONResponse

from schemas.history import ContestHistoryItem
from schemas.prediction import PredictRequest, PredictionPending, PredictionResult
from services.history_service import get_recent_history
from services.prediction_service import get_prediction

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/user", tags=["user"])


@router.get(
    "/{username}/history",
    response_model=List[ContestHistoryItem],
    summary="Get user contest history",
    description="Fetch the most recent attended contests for a LeetCode user.",
)
async def get_history(username: str, limit: int = 5):
    logger.info(f"GET /history username={username} limit={limit}")
    try:
        return await get_recent_history(username, limit=limit)
    except Exception as e:
        logger.error(f"History fetch failed for user={username}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post(
    "/{username}/predict",
    response_model=PredictionResult,
    responses={
        202: {
            "model": PredictionPending,
            "description": "Prediction not yet available",
        }
    },
    summary="Get rating prediction",
    description="Fetch the predicted rating change for a user's contest.",
)
async def predict(username: str, req: PredictRequest):
    logger.info(
        f"POST /predict username={username} contest={req.contest_slug}"
    )

    result = await get_prediction(
        username=username,
        contest_slug=req.contest_slug,
        contest_title=req.contest_title,
    )

    if result is None:
        logger.info(f"Prediction pending for user={username}")
        return JSONResponse(
            status_code=status.HTTP_202_ACCEPTED,
            content=PredictionPending(
                message="Prediction not yet available"
            ).model_dump(),
        )

    return result
