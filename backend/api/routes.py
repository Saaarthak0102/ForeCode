"""
API route handlers.

Thin route layer — validates input, delegates to services, returns typed responses.
"""

import logging
from typing import List

from fastapi import APIRouter, HTTPException, status, Request
from fastapi.responses import JSONResponse

from schemas.history import ContestHistoryItem, SyncHistoryRequest
from schemas.prediction import PredictRequest, PredictionPending, PredictionResult
from services.history_service import get_recent_history
from services.prediction_service import get_prediction

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/user", tags=["user"])


@router.post(
    "/{username}/history",
    response_model=List[ContestHistoryItem],
    summary="Sync and get user contest history",
    description="Sync the most recent attended contests for a LeetCode user, merging any pending prediction.",
)
async def sync_history(username: str, request: Request, limit: int = 5):
    logger.info(f"POST /history username={username} limit={limit}")
    
    # Read raw body for debugging 422
    body_bytes = await request.body()
    logger.info(f"RAW BODY: {body_bytes.decode('utf-8', errors='ignore')}")
    
    try:
        body_json = await request.json()
    except Exception:
        body_json = {}
        
    try:
        req = SyncHistoryRequest(**body_json)
    except Exception as e:
        logger.error(f"Validation Error: {e}")
        raise HTTPException(status_code=422, detail=str(e))
        
    try:
        return await get_recent_history(
            username=username, 
            limit=limit, 
            latest_attended=req.latest_attended_contest
        )
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
