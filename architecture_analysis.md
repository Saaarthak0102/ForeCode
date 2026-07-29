# LeetCode Rating Predictor: Architectural Analysis

This document provides a comprehensive technical breakdown of the LeetCode Rating Predictor ecosystem. The system is split across a Chrome Extension frontend, a Python backend, and dynamic DOM injection mechanisms that interface with LeetCode's Single Page Application (SPA).

---

## 1. Frontend Architecture (Chrome Extension)

The frontend is a Manifest V3 Chrome Extension designed for high performance and minimal intrusiveness.

### A. The Service Worker (`background.js`)
- **Role**: The centralized data and state manager.
- **Why it's needed**: Content scripts are restricted by CORS policies and cannot easily make cross-origin requests to your backend without complex configuration. The Background script circumvents this.
- **Caching Layer**: Implements a `Map`-based in-memory cache (`predictionCache`). Since users often navigate back and forth through leaderboard pages, this cache guarantees that any given username is only fetched from the backend *once* per session, drastically reducing server load.

### B. The Popup Interface (`popup/`)
- **Role**: The user-facing dashboard.
- **Design System**: Strictly adheres to the LeetCode design language. It utilizes standard LC variables (`--lc-bg-layer-1`, `--lc-text-primary`, `--lc-accent` which maps to `#ffa116`) to ensure a seamless visual experience.
- **Data Flow**: On `DOMContentLoaded`, it fires a `fetchUserContestHistory` message to the background script, awaiting a JSON array to dynamically populate the DOM with "Actual vs Predicted" cards.

---

## 2. LeetCode Text Injection Mechanism (`content.js`)

Injecting data into a modern React application like LeetCode presents unique challenges. The leaderboard is not a static HTML table; it renders dynamically on the client side, and pagination occurs without a page reload.

### The `MutationObserver` Pattern
To solve the dynamic rendering issue, the extension uses a `MutationObserver`.
1. **Observation**: It attaches to `document.body` and listens for `childList` and `subtree` changes.
2. **Debouncing**: Because React renders components in many small bursts, a naive observer would trigger thousands of times a second. A `setTimeout` debounce (500ms) ensures the DOM parsing only runs *after* the DOM has settled.
3. **Extraction**: It scans for table rows (`tr`) and targets anchor tags containing usernames (e.g., `a[href^="/"]`). It extracts the username by stripping the forward slashes.
4. **Queueing**: Usernames are queued and sent in a single batched message (`fetchPredictions`) to the background script.

### The Injection Phase
Once the background script returns the calculated deltas, the content script maps them back to the DOM nodes. 
- It creates a sterile `span` element (`.lc-predictor-badge`).
- It applies inline styling using semantic colors (`#2cbb5d` for positive delta, `#ef4743` for negative) and appends it as a sibling to the username node.
- **Safety**: By only appending native DOM nodes as siblings (and never modifying React's virtual DOM structure or `innerHTML`), it avoids crashing LeetCode's internal React reconciliation engine.

---

## 3. Backend Architecture (`repos/lccn_predictor`)

While the JS extension *could* calculate ratings locally, fetching 30,000 users from LeetCode during a live contest is incredibly slow and will result in IP rate limits. Thus, the heavy lifting is offloaded to the Python backend.

### Tech Stack
- **Framework**: Python FastAPI for high-throughput, asynchronous API routing.
- **Database**: MongoDB (`app/db/mongodb.py`) to persistently store user histories and contest snapshots.
- **Workers**: `app/schedulers.py` and `app/crawler` are designed to periodically scrape LeetCode's APIs independently of user requests. They process the massive leaderboards asynchronously.
- **API Endpoints**: The extension simply queries these endpoints with a list of usernames, and the API returns the pre-computed deltas in milliseconds.

---

## 4. The Core Prediction Algorithm

Whether running in `scripts/predictor.js` or the Python backend, the math is based on a modified Elo rating system.

1. **Expected Win Rate**: Calculates the probability of User A beating User B using a logistic curve: 
   `1 / (1 + Math.pow(10, (ratingB - ratingA) / 400))`
2. **Expected Rank**: By summing the expected win rates of a user against *every other participant* in the contest, the algorithm derives an expected rank.
3. **Geometric Mean**: It calculates the geometric mean of the user's *Expected Rank* and their *Actual Rank*.
4. **Binary Search Reversal**: It runs a binary search (`binarySearchExpectedRating`) between rating bounds (0 to 4000) to find the exact rating that would have naturally resulted in that geometric mean rank.
5. **Delta & Decay**: The raw difference between the old rating and the newly found rating is multiplied by a decay coefficient (`getDeltaCoefficient`). New users (under 100 contests) experience much higher volatility (faster rating changes) than veteran users, ensuring they quickly reach their true rating bracket.
