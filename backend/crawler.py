import asyncio
from collections import defaultdict, deque
from typing import Any, Dict, List, Optional, Tuple

import httpx
import logging

logger = logging.getLogger(__name__)

headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X x.y; rv:42.0) Gecko/20100101 Firefox/42.0",
}

async def multi_http_request(
    multi_requests: Dict,
    concurrent_num: int = 5,
    retry_num: int = 10,
) -> List[Optional[httpx.Response]]:
    response_mapper: Dict[Any, int | httpx.Response] = defaultdict(int)
    crawler_queue = deque(multi_requests.items())
    
    wait_time = 0
    while crawler_queue:
        requests_list = list()
        while len(requests_list) < concurrent_num and crawler_queue:
            key, request = crawler_queue.popleft()
            if response_mapper[key] >= retry_num:
                logger.error(
                    f"request reached max retry_num. {key=}, req={multi_requests[key]}"
                )
                continue
            requests_list.append((key, request))
        if not requests_list:
            break
        
        await asyncio.sleep(wait_time)
        async with httpx.AsyncClient(headers=headers, timeout=15.0) as client:
            tasks = [client.request(**request) for key, request in requests_list]
            response_list = await asyncio.gather(*tasks, return_exceptions=True)
            wait_time = 0
            for response, (key, request) in zip(response_list, requests_list):
                if isinstance(response, httpx.Response) and response.status_code == 200:
                    response_mapper[key] = response
                else:
                    logger.warning(
                        f"multi_http_request error: {request=} "
                        f"response.status_code: "
                        f"{response.status_code if isinstance(response, httpx.Response) else response}"
                    )
                    response_mapper[key] += 1
                    wait_time += 1
                    crawler_queue.append((key, request))
                    
    return [
        None if isinstance(response, int) else response
        for key, response in response_mapper.items()
    ]


async def request_user_rating_and_attended_contests_count(
    data_region: str,
    username: str,
) -> Tuple[Optional[float], Optional[int]]:
    if data_region == "CN":
        req = (
            await multi_http_request(
                {
                    (data_region, username): {
                        "url": "https://leetcode.cn/graphql/noj-go/",
                        "method": "POST",
                        "json": {
                            "query": """
                                 query userContestRankingInfo($userSlug: String!) {
                                        userContestRanking(userSlug: $userSlug) {
                                            attendedContestsCount
                                            rating
                                        }
                                    }
                                 """,
                            "variables": {"userSlug": username},
                        },
                    }
                }
            )
        )[0]
    else:
        req = (
            await multi_http_request(
                {
                    (data_region, username): {
                        "url": "https://leetcode.com/graphql/",
                        "method": "POST",
                        "json": {
                            "query": """
                                 query getContestRankingData($username: String!) {
                                    userContestRanking(username: $username) {
                                        attendedContestsCount
                                        rating
                                    }
                                 }
                                 """,
                            "variables": {"username": username},
                        },
                    }
                }
            )
        )[0]
    if req is None:
        raise RuntimeError(f"HTTP request failed for {data_region=} {username=}")
    if (graphql_res := req.json().get("data", {}).get("userContestRanking")) is None:
        return None, None
    else:
        return graphql_res.get("rating"), graphql_res.get("attendedContestsCount")


async def request_user_contest_history(
    data_region: str,
    username: str,
) -> Optional[list[dict]]:
    if data_region == "CN":
        url = "https://leetcode.cn/graphql/noj-go/"
        var_key = "userSlug"
    else:
        url = "https://leetcode.com/graphql/"
        var_key = "username"

    req = (
        await multi_http_request(
            {
                (data_region, username): {
                    "url": url,
                    "method": "POST",
                    "json": {
                        "query": """
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
                        """.replace("$username", f"${var_key}"),
                        "variables": {var_key: username},
                    },
                }
            }
        )
    )[0]

    if req is None:
        raise RuntimeError(f"HTTP request failed for {data_region=} {username=}")
    
    graphql_res = req.json().get("data", {}).get("userContestRankingHistory")
    return graphql_res
