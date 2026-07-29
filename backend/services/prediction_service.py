"""
Prediction service.

Business logic for fetching contest rating predictions.
Delegates raw data fetching to the Entranthub client.
"""

import logging
from typing import Optional

from ..clients.entranthub import get_predicted_rating
from ..schemas.prediction import PredictionResult

logger = logging.getLogger(__name__)


async def get_prediction(
    username: str,
    contest_slug: str,
    contest_title: str,
) -> Optional[PredictionResult]:
    """
    Attempt to fetch a prediction for a user's contest performance.

    Args:
        username: LeetCode username.
        contest_slug: The contest slug (e.g. "weekly-contest-456").
        contest_title: Human-readable contest title.

    Returns:
        PredictionResult if available, None if prediction is not yet ready.
    """
    logger.info(
        f"Requesting prediction for user={username} contest={contest_slug}"
    )

    result = await get_predicted_rating(contest_slug, username)

    if result is None:
        logger.info(
            f"Prediction not yet available for user={username} "
            f"contest={contest_slug}"
        )
        return None

    new_rating, delta_rating = result

    logger.info(
        f"Prediction resolved for user={username} contest={contest_slug}: "
        f"rating={new_rating} delta={delta_rating}"
    )

    return PredictionResult(
        contest_slug=contest_slug,
        contest_title=contest_title,
        predicted_rating=new_rating,
        predicted_delta=delta_rating,
        status="pending",
    )
