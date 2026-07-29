"""
Entranthub Prediction API client.

Handles communication with the Entranthub API to fetch
predicted contest ratings.
"""

import logging
from typing import Optional, Tuple

import httpx

logger = logging.getLogger(__name__)

_BASE_URL = "https://api.entranthub.com/api/v1/contests/leetcode/contests"


async def get_predicted_rating(
    contest_slug: str,
    username: str,
) -> Optional[Tuple[float, float]]:
    """
    Fetch the predicted new rating for a user in a specific contest.

    Args:
        contest_slug: The LeetCode contest slug (e.g. "weekly-contest-456").
        username: The LeetCode username.

    Returns:
        Tuple of (new_rating, delta_rating) if available, or None if
        the prediction is not yet ready.
    """
    url = f"{_BASE_URL}/{contest_slug}/rankings"
    params = {
        "limit": 25,
        "offset": 0,
        "userSlug": username,
    }

    logger.info(
        f"Fetching prediction for user={username} contest={contest_slug}"
    )

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://entranthub.com",
        "Referer": "https://entranthub.com/",
    }

    async with httpx.AsyncClient(headers=headers) as client:
        try:
            resp = await client.get(url, params=params, timeout=10.0)
            resp.raise_for_status()
            data = resp.json()
        except httpx.TimeoutException:
            logger.warning(f"Entrahub request timed out for contest={contest_slug}")
            return None
        except httpx.HTTPStatusError as e:
            logger.warning(
                f"Entrahub returned status={e.response.status_code} "
                f"for contest={contest_slug}"
            )
            return None
        except Exception as e:
            logger.error(f"Entrahub request failed: {e}")
            return None

    items = data.get("items", [])
    if not items:
        logger.info(f"No prediction items yet for contest={contest_slug}")
        return None

    user_item = next((item for item in items if item.get("userSlug") == username or item.get("username") == username), items[0])
    new_rating = user_item.get("newRating")
    delta_rating = user_item.get("deltaRating")

    if new_rating is None or delta_rating is None:
        logger.info(f"Prediction fields missing for contest={contest_slug}")
        return None

    logger.info(
        f"Prediction found: user={username} contest={contest_slug} "
        f"new_rating={new_rating} delta={delta_rating}"
    )
    return new_rating, delta_rating
