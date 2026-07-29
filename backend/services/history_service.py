"""
History service.

Business logic for fetching and formatting a user's contest history.
Delegates raw data fetching to the LeetCode client.
"""

import logging
from typing import List

from clients.leetcode import get_user_contest_history
from schemas.history import ContestHistoryItem

logger = logging.getLogger(__name__)


async def get_recent_history(
    username: str,
    limit: int = 5,
    data_region: str = "US",
) -> List[ContestHistoryItem]:
    """
    Fetch and format the user's most recent attended contests.

    Args:
        username: LeetCode username.
        limit: Max number of recent contests to return.
        data_region: "US" or "CN".

    Returns:
        List of ContestHistoryItem, newest first.
    """
    logger.info(f"Fetching history for user={username} limit={limit}")

    history = await get_user_contest_history(data_region, username)

    if history is None:
        logger.info(f"No history returned for user={username}")
        return []

    # Filter only attended contests
    attended_contests = [c for c in history if c.get("attended")]

    if not attended_contests:
        logger.info(f"User={username} has no attended contests")
        return []

    # The LeetCode API usually returns oldest to newest
    recent = attended_contests[-limit:]
    recent.reverse()  # newest first

    result: List[ContestHistoryItem] = []
    for c in recent:
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

        result.append(
            ContestHistoryItem(
                contest_slug=contest_info.get("titleSlug"),
                contest_title=contest_info.get("title"),
                actual_rating=actual_rating,
                actual_delta=actual_delta,
                predicted_rating=None,
                predicted_delta=None,
                status="confirmed",
            )
        )

    logger.info(f"Returning {len(result)} history entries for user={username}")
    return result
