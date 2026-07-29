import asyncio
from collections import defaultdict, deque
from typing import Any, Dict, List, Optional

import httpx
import logging

logger = logging.getLogger(__name__)

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X x.y; rv:42.0) Gecko/20100101 Firefox/42.0",
}


async def multi_http_request(
    multi_requests: Dict,
    concurrent_num: int = 5,
    retry_num: int = 10,
) -> List[Optional[httpx.Response]]:
    """
    Execute multiple HTTP requests with concurrency control and automatic retries.

    Args:
        multi_requests: Dict mapping request keys to httpx request kwargs.
        concurrent_num: Max concurrent requests per batch.
        retry_num: Max retries per failed request.

    Returns:
        List of httpx.Response objects (or None for permanently failed requests),
        in the same order as the input dict keys.
    """
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
        async with httpx.AsyncClient(headers=DEFAULT_HEADERS, timeout=15.0) as client:
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
