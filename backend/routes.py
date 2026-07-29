from fastapi import APIRouter, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import httpx

from .crawler import request_user_contest_history

router = APIRouter(prefix="/api/v1/user", tags=["user"])

class PredictRequest(BaseModel):
    contest_slug: str
    contest_title: str

@router.get("/{username}/history")
async def get_history(username: str, limit: int = 5):
    try:
        # Assuming US region as default for extension users, could be made configurable
        history = await request_user_contest_history("US", username)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    
    if history is None:
        return []
    
    # Filter only attended contests
    attended_contests = [c for c in history if c.get("attended")]
    
    if not attended_contests:
        return []
        
    # The leetcode API usually returns oldest to newest.
    recent = attended_contests[-limit:]
    recent.reverse() # newest first
    
    result = []
    for c in recent:
        contest_info = c.get("contest", {})
        contest_slug = contest_info.get("titleSlug")
        contest_title = contest_info.get("title")
        actual_rating = c.get("rating")
        
        # Calculate actual delta. 
        idx = attended_contests.index(c)
        prev_rating = attended_contests[idx - 1].get("rating") if idx > 0 else 1500
        actual_delta = actual_rating - prev_rating if actual_rating is not None and prev_rating is not None else None
        
        result.append({
            "contest_slug": contest_slug,
            "contest_title": contest_title,
            "actual_rating": actual_rating,
            "actual_delta": actual_delta,
            "predicted_rating": None,
            "predicted_delta": None,
            "status": "confirmed"
        })
        
    return result

@router.post("/{username}/predict")
async def predict(username: str, req: PredictRequest):
    contest_slug = req.contest_slug
    contest_title = req.contest_title
    
    url = f"https://api.entranthub.com/api/v1/contests/leetcode/contests/{contest_slug}/rankings"
    params = {
        "limit": 25,
        "offset": 0,
        "userSlug": username
    }
    
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(url, params=params, timeout=10.0)
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            return JSONResponse(
                status_code=status.HTTP_202_ACCEPTED,
                content={"message": "Prediction not yet available"}
            )
            
    items = data.get("items", [])
    if not items:
        return JSONResponse(
            status_code=status.HTTP_202_ACCEPTED,
            content={"message": "Prediction not yet available"}
        )
        
    user_item = items[0]
    
    new_rating = user_item.get("newRating")
    delta_rating = user_item.get("deltaRating")
    
    if new_rating is None or delta_rating is None:
         return JSONResponse(
            status_code=status.HTTP_202_ACCEPTED,
            content={"message": "Prediction not yet available"}
        )

    return {
        "contest_slug": contest_slug,
        "contest_title": contest_title,
        "predicted_rating": new_rating,
        "predicted_delta": delta_rating,
        "status": "pending"
    }
