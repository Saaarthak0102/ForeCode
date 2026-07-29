import requests, json

headers = {'User-Agent': 'Mozilla/5.0'}
query = """
query userContestRankingInfo($username: String!) {
  userContestRankingHistory(username: $username) {
    attended
    rating
    contest {
      titleSlug
    }
  }
}
"""
try:
    r = requests.post('https://leetcode.com/graphql/', json={'query': query, 'variables': {'username': 'lee215'}}, headers=headers)
    print(r.status_code)
    data = r.json()
    if 'data' in data and data['data']['userContestRankingHistory']:
        print(f"Got {len(data['data']['userContestRankingHistory'])} records")
        print(data['data']['userContestRankingHistory'][-1])
    else:
        print(data)
except Exception as e:
    print(e)
