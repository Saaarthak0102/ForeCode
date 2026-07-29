import requests
headers = {'User-Agent': 'Mozilla/5.0'}
query = '''
query userContestRankingInfo($username: String!) {
  userContestRankingHistory(username: $username) {
    attended
    rating
    ranking
    contest {
      title
      titleSlug
      startTime
    }
  }
}
'''
try:
    r = requests.post('https://leetcode.com/graphql/', json={'query': query.replace('$','$'), 'variables': {'username': 'lee215'}}, headers=headers)
    data = r.json()
    if 'data' in data and data['data']['userContestRankingHistory']:
        history = data['data']['userContestRankingHistory']
        attended = [c for c in history if c.get('attended')]
        print(f'Got {len(attended)} attended contests')
        for c in attended[-3:]:
            print(c)
    else:
        print(data)
except Exception as e:
    print(e)

