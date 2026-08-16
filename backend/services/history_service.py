"""
History service.

Business logic for fetching and formatting a user's contest history.
Delegates raw data fetching to the LeetCode client.
"""

import asyncio
import logging
from typing import List, Optional

from clients.leetcode import get_user_contest_history
from schemas.history import ContestHistoryItem, LatestAttendedContest
from services.prediction_service import get_prediction

logger = logging.getLogger(__name__)


async def get_recent_history(
    username: str,
    limit: int = 5,
    latest_attended: Optional[LatestAttendedContest] = None,
    data_region: str = "US",
) -> List[ContestHistoryItem]:
    """
    Fetch and format the user's most recent attended contests.

    Args:
        username: LeetCode username.
        limit: Max number of recent contests to return.
        latest_attended: Optional data about the most recent contest from user session.
        data_region: "US" or "CN".

    Returns:
        List of ContestHistoryItem, newest first.
    """
    logger.info(f"Fetching history for user={username} limit={limit}")

    history = await get_user_contest_history(data_region, username)

    if history is None:
        logger.info(f"No history returned for user={username}")
        history = []

    # Filter only attended contests
    attended_contests = [c for c in history if c.get("attended")]

    result: List[ContestHistoryItem] = []
    
    if attended_contests:
        # The LeetCode API usually returns oldest to newest
        recent = attended_contests[-limit:]
        recent.reverse()  # newest first

        # Fetch predictions for the recent confirmed contests concurrently
        prediction_tasks = [
            get_prediction(
                username=username,
                contest_slug=c.get("contest", {}).get("titleSlug", ""),
                contest_title=c.get("contest", {}).get("title", ""),
            )
            for c in recent
        ]
        
        predictions = await asyncio.gather(*prediction_tasks, return_exceptions=True)

        for i, c in enumerate(recent):
            contest_info = c.get("contest", {})
            actual_rating = c.get("rating")

            # Calculate actual delta
            idx = attended_contests.index(c)
            prev_rating = attended_contests[idx - 1].get("rating") if idx > 0 else 1500
            actual_delta = (
                actual_rating - prev_rating
                if actual_rating is not None and prev_rating is not None
                else None
            )

            # Extract prediction if it exists
            pred = predictions[i]
            predicted_rating = None
            predicted_delta = None
            
            if not isinstance(pred, Exception) and pred is not None:
                predicted_rating = pred.predicted_rating
                predicted_delta = pred.predicted_delta
            elif isinstance(pred, Exception):
                logger.error(f"Error fetching prediction for {contest_info.get('titleSlug')}: {pred}")

            result.append(
                ContestHistoryItem(
                    contest_slug=contest_info.get("titleSlug"),
                    contest_title=contest_info.get("title"),
                    actual_rating=actual_rating,
                    actual_delta=actual_delta,
                    predicted_rating=predicted_rating,
                    predicted_delta=predicted_delta,
                    status="confirmed",
                )
            )

    # Detect pending contest
    if latest_attended and (not result or result[0].contest_slug != latest_attended.titleSlug):
        official_latest = result[0].contest_slug if result else "None"
        latest_slug = latest_attended.titleSlug
        
        logger.info(f"Official latest:\n{official_latest}")
        logger.info(f"Latest attended:\n{latest_slug}")
        logger.info("Pending contest detected")
        logger.info("Searching Entrahub...")
        
        try:
            prediction = await get_prediction(
                username=username,
                contest_slug=latest_slug,
                contest_title=latest_attended.title
            )
            
            if prediction:
                logger.info("Prediction found")
                pending_item = ContestHistoryItem(
                    contest_slug=latest_slug,
                    contest_title=latest_attended.title,
                    predicted_rating=prediction.predicted_rating,
                    predicted_delta=prediction.predicted_delta,
                    ranking=latest_attended.ranking,
                    solved=latest_attended.solved,
                    source="Entrahub",
                    status="pending"
                )
            else:
                logger.info("Prediction not available yet")
                pending_item = ContestHistoryItem(
                    contest_slug=latest_slug,
                    contest_title=latest_attended.title,
                    ranking=latest_attended.ranking,
                    solved=latest_attended.solved,
                    status="prediction_pending"
                )
                
            result.insert(0, pending_item)
            logger.info("Returning merged history")
            
        except Exception as e:
            logger.error(f"Failed to fetch prediction for pending contest: {e}")
            pending_item = ContestHistoryItem(
                contest_slug=latest_slug,
                contest_title=latest_attended.title,
                ranking=latest_attended.ranking,
                solved=latest_attended.solved,
                status="prediction_pending"
            )
            result.insert(0, pending_item)

    logger.info(f"Returning {len(result)} history entries for user={username}")
    return result[:limit] if len(result) > limit else result
