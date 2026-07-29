"""
LeetCode GraphQL API client.

Handles all direct communication with the LeetCode GraphQL endpoints
for both US and CN data regions.
"""

import logging
from typing import Optional, Tuple

from utils.http import multi_http_request

logger = logging.getLogger(__name__)


# ── GraphQL Queries ──────────────────────────────────────────────────────────

_CONTEST_RANKING_QUERY_CN = """
    query userContestRankingInfo($userSlug: String!) {
        userContestRanking(userSlug: $userSlug) {
            attendedContestsCount
            rating
        }
    }
"""

_CONTEST_RANKING_QUERY_US = """
    query getContestRankingData($username: String!) {
        userContestRanking(username: $username) {
            attendedContestsCount
            rating
        }
    }
"""

_CONTEST_HISTORY_QUERY = """
    query userContestRankingHistory($username: String!) {
        userContestRankingHistory(username: $username) {
            attended
            ranking
            rating
            finishTimeInSeconds
            contest {
                title
                titleSlug
                startTime
            }
        }
    }
"""


# ── Public API ───────────────────────────────────────────────────────────────

async def get_user_rating_and_count(
    data_region: str,
    username: str,
) -> Tuple[Optional[float], Optional[int]]:
    """
    Fetch a user's contest rating and attended contest count.

    Returns:
        Tuple of (rating, attended_contests_count). Both may be None
        if the user has no contest history.
    """
    if data_region == "CN":
        url = "https://leetcode.cn/graphql/noj-go/"
        var_key = "userSlug"
        query = _CONTEST_RANKING_QUERY_CN
    else:
        url = "https://leetcode.com/graphql/"
        var_key = "username"
        query = _CONTEST_RANKING_QUERY_US

    logger.info(f"Fetching rating for user={username} region={data_region}")

    req = (
        await multi_http_request(
            {
                (data_region, username): {
                    "url": url,
                    "method": "POST",
                    "json": {
                        "query": query,
                        "variables": {var_key: username},
                    },
                }
            }
        )
    )[0]

    if req is None:
        raise RuntimeError(f"HTTP request failed for {data_region=} {username=}")

    graphql_res = req.json().get("data", {}).get("userContestRanking")
    if graphql_res is None:
        return None, None

    return graphql_res.get("rating"), graphql_res.get("attendedContestsCount")


async def get_user_contest_history(
    data_region: str,
    username: str,
) -> Optional[list[dict]]:
    """
    Fetch the full contest ranking history for a user.

    Returns:
        List of contest history dicts from the GraphQL API, or None if
        the request failed or the user has no history.
    """
    if data_region == "CN":
        url = "https://leetcode.cn/graphql/noj-go/"
        var_key = "userSlug"
    else:
        url = "https://leetcode.com/graphql/"
        var_key = "username"

    logger.info(f"Fetching contest history for user={username} region={data_region}")

    query = _CONTEST_HISTORY_QUERY.replace("$username", f"${var_key}")

    req = (
        await multi_http_request(
            {
                (data_region, username): {
                    "url": url,
                    "method": "POST",
                    "json": {
                        "query": query,
                        "variables": {var_key: username},
                    },
                }
            }
        )
    )[0]

    if req is None:
        raise RuntimeError(f"HTTP request failed for {data_region=} {username=}")

    return req.json().get("data", {}).get("userContestRankingHistory")
