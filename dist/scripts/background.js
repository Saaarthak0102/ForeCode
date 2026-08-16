(() => {
  // src/scripts/lib/messageTypes.js
  var MessageType = {
    /** Prediction data was updated or newly available */
    PREDICTION_UPDATED: "PREDICTION_UPDATED",
    /** Contest history was refreshed or modified */
    HISTORY_UPDATED: "HISTORY_UPDATED",
    /** User login state changed (logged in / out / different user) */
    LOGIN_CHANGED: "LOGIN_CHANGED",
    /** An error occurred that the UI should display */
    ERROR_OCCURRED: "ERROR_OCCURRED"
  };
  function createMessage(type, payload = {}) {
    return { type, payload, timestamp: Date.now() };
  }

  // src/scripts/lib/storage.js
  var CACHE_TTL_MS = 24 * 60 * 60 * 1e3;
  var INITIAL_BACKOFF_MS = 20 * 60 * 1e3;
  var MAX_BACKOFF_MS = 6 * 60 * 60 * 1e3;
  var Storage = {
    // ── History ─────────────────────────────────────────────────────────────
    /**
     * Get contest history for a user, checking cache freshness.
     * @param {string} username
     * @returns {Promise<{ data: Array, updatedAt: number, isStale: boolean }>}
     */
    async getHistory(username) {
      const key = `history_${username}`;
      return new Promise((resolve) => {
        chrome.storage.local.get([key], (result) => {
          const entry = result[key];
          if (!entry || !entry.updatedAt) {
            resolve({ data: [], updatedAt: 0, isStale: true });
            return;
          }
          const isStale = Date.now() - entry.updatedAt > CACHE_TTL_MS;
          resolve({ data: entry.data || [], updatedAt: entry.updatedAt, isStale });
        });
      });
    },
    /**
     * Save contest history with a fresh timestamp.
     * @param {string} username
     * @param {Array} data
     * @returns {Promise<void>}
     */
    async saveHistory(username, data) {
      const key = `history_${username}`;
      return new Promise((resolve) => {
        chrome.storage.local.set(
          { [key]: { data, updatedAt: Date.now() } },
          resolve
        );
      });
    },
    /**
     * Check if a history cache entry is stale (>24h).
     * @param {{ updatedAt: number }} entry
     * @returns {boolean}
     */
    isHistoryStale(entry) {
      if (!entry || !entry.updatedAt) return true;
      return Date.now() - entry.updatedAt > CACHE_TTL_MS;
    },
    // ── Prediction Status (Exponential Backoff) ─────────────────────────────
    /**
     * Get the current prediction polling status.
     * @returns {Promise<object|null>}
     */
    async getPredictionStatus() {
      return new Promise((resolve) => {
        chrome.storage.local.get(["prediction_status"], (result) => {
          resolve(result.prediction_status || null);
        });
      });
    },
    /**
     * Save prediction polling status with backoff state.
     * @param {object} status - { contestSlug, status, lastChecked, retryCount, nextRetryAt }
     * @returns {Promise<void>}
     */
    async savePredictionStatus(status) {
      return new Promise((resolve) => {
        chrome.storage.local.set({ prediction_status: status }, resolve);
      });
    },
    /**
     * Clear prediction status (prediction resolved or confirmed).
     * @returns {Promise<void>}
     */
    async clearPredictionStatus() {
      return new Promise((resolve) => {
        chrome.storage.local.remove("prediction_status", resolve);
      });
    },
    /**
     * Calculate the next retry timestamp using exponential backoff.
     * Schedule: 20m → 40m → 80m → 160m → 320m → 360m (cap)
     * @param {number} retryCount - Current retry count (0-indexed).
     * @returns {number} Timestamp (ms) for next allowed retry.
     */
    calculateNextRetry(retryCount) {
      const delayMs = Math.min(
        INITIAL_BACKOFF_MS * Math.pow(2, retryCount),
        MAX_BACKOFF_MS
      );
      return Date.now() + delayMs;
    },
    // ── Username ────────────────────────────────────────────────────────────
    /**
     * Get the stored LeetCode username.
     * @returns {Promise<string|null>}
     */
    async getUsername() {
      return new Promise((resolve) => {
        chrome.storage.local.get(["lc_username"], (result) => {
          resolve(result.lc_username || null);
        });
      });
    },
    /**
     * Save the LeetCode username.
     * @param {string} username
     * @returns {Promise<void>}
     */
    async setUsername(username) {
      return new Promise((resolve) => {
        chrome.storage.local.set({ lc_username: username }, resolve);
      });
    },
    // ── Last Error ──────────────────────────────────────────────────────────
    /**
     * Save the last error state for UI display.
     * @param {object|null} error - Error object from createError(), or null to clear.
     * @returns {Promise<void>}
     */
    async setLastError(error) {
      return new Promise((resolve) => {
        if (error === null) {
          chrome.storage.local.remove("last_error", resolve);
        } else {
          chrome.storage.local.set({ last_error: error }, resolve);
        }
      });
    },
    /**
     * Get the last stored error.
     * @returns {Promise<object|null>}
     */
    async getLastError() {
      return new Promise((resolve) => {
        chrome.storage.local.get(["last_error"], (result) => {
          resolve(result.last_error || null);
        });
      });
    }
  };

  // src/scripts/lib/errors.js
  var ErrorCode = {
    /** Network request failed (no connectivity, DNS, timeout) */
    NETWORK_ERROR: "NETWORK_ERROR",
    /** LeetCode GraphQL API returned an error or unexpected shape */
    GRAPHQL_FAILED: "GRAPHQL_FAILED",
    /** Prediction is not yet available — still being calculated */
    PREDICTION_PENDING: "PREDICTION_PENDING",
    /** The requested user was not found on LeetCode */
    USER_NOT_FOUND: "USER_NOT_FOUND",
    /** Too many requests — being rate limited */
    RATE_LIMITED: "RATE_LIMITED",
    /** Catch-all for unexpected errors */
    UNKNOWN_ERROR: "UNKNOWN_ERROR"
  };
  var ErrorMessages = {
    [ErrorCode.NETWORK_ERROR]: "Network error \u2014 will retry automatically.",
    [ErrorCode.GRAPHQL_FAILED]: "Failed to reach LeetCode \u2014 will retry.",
    [ErrorCode.PREDICTION_PENDING]: "Prediction is still being calculated\u2026",
    [ErrorCode.USER_NOT_FOUND]: "LeetCode user not found.",
    [ErrorCode.RATE_LIMITED]: "Too many requests \u2014 slowing down.",
    [ErrorCode.UNKNOWN_ERROR]: "Something went wrong."
  };
  function createError(code, detail) {
    return {
      code,
      message: ErrorMessages[code] || ErrorMessages[ErrorCode.UNKNOWN_ERROR],
      ...detail ? { detail } : {},
      timestamp: Date.now()
    };
  }

  // src/scripts/lib/logger.js
  var Logger = {
    /**
     * @param {string} context - Module name (e.g., "Background", "Popup").
     * @param {string} message - Log message.
     * @param {object} [data] - Optional structured data.
     */
    info(context, message, data) {
      const entry = Logger._format("INFO", context, message, data);
      console.log(entry);
    },
    warn(context, message, data) {
      const entry = Logger._format("WARN", context, message, data);
      console.warn(entry);
    },
    error(context, message, data) {
      const entry = Logger._format("ERROR", context, message, data);
      console.error(entry);
    },
    /**
     * Format a structured log entry.
     * @private
     */
    _format(level, context, message, data) {
      const timestamp = (/* @__PURE__ */ new Date()).toISOString();
      const base = `[${timestamp}] [${level}] [${context}] ${message}`;
      if (data !== void 0 && data !== null) {
        return `${base} | ${JSON.stringify(data)}`;
      }
      return base;
    }
  };

  // src/scripts/background.js
  var API_URL = "https://fore-code.vercel.app/api/v1";
  var LOG_CTX = "Background";
  var predictionCache = /* @__PURE__ */ new Map();
  async function getLeetCodeUsername() {
    try {
      const res = await fetch("https://leetcode.com/graphql", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "query globalData { userStatus { username } }"
        })
      });
      const data = await res.json();
      return data?.data?.userStatus?.username || null;
    } catch (e) {
      Logger.error(LOG_CTX, "Failed to detect LeetCode username", { error: e.message });
      return null;
    }
  }
  async function fetchLatestAttendedContest() {
    try {
      const gqlRes = await fetch("https://leetcode.com/graphql", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `query contestV2MyContests($skip: Int!, $limit: Int!, $isVirtual: Boolean) {
          contestV2MyContests(skip: $skip, limit: $limit, isVirtual: $isVirtual) {
            contests {
              titleSlug
              title
              startTime
              finishTime
              solved
              ranking
              totalQuestions
            }
          }
        }`,
          variables: { skip: 0, limit: 1, isVirtual: false }
        })
      });
      if (gqlRes.ok) {
        const gqlData = await gqlRes.json();
        const contests = gqlData?.data?.contestV2MyContests?.contests || [];
        if (contests.length > 0) {
          return contests[0];
        }
      }
    } catch (err) {
      Logger.warn(LOG_CTX, "Failed to fetch latest attended contest", { error: err.message });
    }
    return null;
  }
  async function refreshHistory(username) {
    Logger.info(LOG_CTX, "Refreshing history from backend", { username });
    try {
      const latestContest = await fetchLatestAttendedContest();
      const res = await fetch(`${API_URL}/user/${username}/history`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          latest_attended_contest: latestContest
        })
      });
      if (res.ok) {
        const history = await res.json();
        const mappedHistory = history.map((record) => ({
          name: record.contest_title,
          actualRating: record.actual_rating,
          predictedRating: record.predicted_rating || "-",
          delta: record.actual_delta !== null && record.actual_delta !== void 0 ? record.actual_delta : record.predicted_delta !== null && record.predicted_delta !== void 0 ? record.predicted_delta : null,
          status: record.status
        }));
        await Storage.saveHistory(username, mappedHistory);
        await Storage.setLastError(null);
        const pendingItem = mappedHistory.find((r) => r.status === "prediction_pending");
        if (pendingItem) {
          await Storage.setLastError(createError(ErrorCode.PREDICTION_PENDING));
        }
        Logger.info(LOG_CTX, "History refreshed successfully", {
          username,
          count: mappedHistory.length
        });
        broadcast(createMessage(MessageType.HISTORY_UPDATED, { username }));
      } else {
        throw new Error(`Backend returned ${res.status}`);
      }
    } catch (err) {
      const error = createError(ErrorCode.NETWORK_ERROR, err.message);
      await Storage.setLastError(error);
      Logger.error(LOG_CTX, "Failed to refresh history", { username, error: err.message });
    }
  }
  function broadcast(message) {
    chrome.runtime.sendMessage(message).catch(() => {
    });
    chrome.tabs.query({ url: "*://leetcode.com/*" }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {
        });
      }
    });
  }
  chrome.runtime.onStartup.addListener(() => {
    Logger.info(LOG_CTX, "Extension startup \u2014 creating alarm");
    chrome.alarms.create("checkPendingPrediction", { periodInMinutes: 20 });
  });
  chrome.runtime.onInstalled.addListener(async (details) => {
    chrome.alarms.create("checkPendingPrediction", { periodInMinutes: 20 });
    if (details.reason === "install") {
      Logger.info(LOG_CTX, "Extension installed \u2014 detecting user");
      const username = await getLeetCodeUsername();
      if (username) {
        await Storage.setUsername(username);
        Logger.info(LOG_CTX, "User detected", { username });
        try {
          await fetch(`${API_URL}/user/${username}/register`, { method: "POST" });
        } catch (_) {
        }
        await refreshHistory(username);
        broadcast(createMessage(MessageType.LOGIN_CHANGED, { username }));
      } else {
        Logger.warn(LOG_CTX, "No LeetCode user detected during install");
      }
    }
  });
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== "checkPendingPrediction") return;
    const username = await Storage.getUsername();
    if (!username) return;
    Logger.info(LOG_CTX, "Alarm fired \u2014 checking predictions", { username });
    try {
      const cachedHistory = await Storage.getHistory(username);
      if (cachedHistory.isStale) {
        Logger.info(LOG_CTX, "History cache is stale \u2014 refreshing", { username });
        await refreshHistory(username);
        return;
      }
      await refreshHistory(username);
    } catch (err) {
      const errorCode = err.message && err.message.includes("NetworkError") ? ErrorCode.NETWORK_ERROR : ErrorCode.UNKNOWN_ERROR;
      const error = createError(errorCode, err.message);
      await Storage.setLastError(error);
      Logger.error(LOG_CTX, "Alarm handler failed", { error: err.message });
      broadcast(createMessage(MessageType.ERROR_OCCURRED, { error }));
    }
  });
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "fetchPredictions") {
      handleFetchPredictions(request.usernames).then((data) => sendResponse({ data })).catch((err) => {
        Logger.error(LOG_CTX, "Prediction fetch failed", { error: err.message });
        sendResponse({ data: null, error: err.message });
      });
      return true;
    }
    if (request.action === "fetchUserContestHistory") {
      handleFetchUserContestHistory(request.username).then((data) => sendResponse({ data })).catch((err) => {
        Logger.error(LOG_CTX, "History fetch failed", { error: err.message });
        sendResponse({ data: null, error: err.message });
      });
      return true;
    }
  });
  async function handleFetchUserContestHistory(username) {
    const { data } = await Storage.getHistory(username);
    return data;
  }
  async function handleFetchPredictions(usernames) {
    const results = {};
    const usersToFetch = [];
    for (const username of usernames) {
      if (predictionCache.has(username)) {
        results[username] = predictionCache.get(username);
      } else {
        usersToFetch.push(username);
      }
    }
    if (usersToFetch.length === 0) {
      return results;
    }
    try {
      for (const username of usersToFetch) {
        const mockDelta = Math.random() * 100 - 50;
        const data = {
          delta: mockDelta,
          newRating: 1800 + mockDelta
        };
        predictionCache.set(username, data);
        results[username] = data;
      }
    } catch (error) {
      Logger.warn(LOG_CTX, "Failed to fetch from backend, using mock data", {
        error: error.message
      });
    }
    return results;
  }
})();
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL3NjcmlwdHMvbGliL21lc3NhZ2VUeXBlcy5qcyIsICIuLi8uLi9zcmMvc2NyaXB0cy9saWIvc3RvcmFnZS5qcyIsICIuLi8uLi9zcmMvc2NyaXB0cy9saWIvZXJyb3JzLmpzIiwgIi4uLy4uL3NyYy9zY3JpcHRzL2xpYi9sb2dnZXIuanMiLCAiLi4vLi4vc3JjL3NjcmlwdHMvYmFja2dyb3VuZC5qcyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXHJcbiAqIFR5cGVkIGJyb2FkY2FzdCBtZXNzYWdlIGNvbnN0YW50cyBhbmQgZmFjdG9yeS5cclxuICpcclxuICogQWxsIGludGVyLWNvbXBvbmVudCBtZXNzYWdpbmcgKGJhY2tncm91bmQgXHUyMTk0IHBvcHVwIFx1MjE5NCBjb250ZW50IHNjcmlwdHMpXHJcbiAqIHVzZXMgdGhlc2UgdHlwZXMgdG8gZW5zdXJlIGNvbnNpc3RlbmN5IGFuZCBmdXR1cmUtcHJvb2ZpbmcuXHJcbiAqL1xyXG5cclxuZXhwb3J0IGNvbnN0IE1lc3NhZ2VUeXBlID0ge1xyXG4gIC8qKiBQcmVkaWN0aW9uIGRhdGEgd2FzIHVwZGF0ZWQgb3IgbmV3bHkgYXZhaWxhYmxlICovXHJcbiAgUFJFRElDVElPTl9VUERBVEVEOiBcIlBSRURJQ1RJT05fVVBEQVRFRFwiLFxyXG4gIC8qKiBDb250ZXN0IGhpc3Rvcnkgd2FzIHJlZnJlc2hlZCBvciBtb2RpZmllZCAqL1xyXG4gIEhJU1RPUllfVVBEQVRFRDogXCJISVNUT1JZX1VQREFURURcIixcclxuICAvKiogVXNlciBsb2dpbiBzdGF0ZSBjaGFuZ2VkIChsb2dnZWQgaW4gLyBvdXQgLyBkaWZmZXJlbnQgdXNlcikgKi9cclxuICBMT0dJTl9DSEFOR0VEOiBcIkxPR0lOX0NIQU5HRURcIixcclxuICAvKiogQW4gZXJyb3Igb2NjdXJyZWQgdGhhdCB0aGUgVUkgc2hvdWxkIGRpc3BsYXkgKi9cclxuICBFUlJPUl9PQ0NVUlJFRDogXCJFUlJPUl9PQ0NVUlJFRFwiLFxyXG59O1xyXG5cclxuLyoqXHJcbiAqIENyZWF0ZSBhIHR5cGVkIG1lc3NhZ2UgZW52ZWxvcGUuXHJcbiAqIEBwYXJhbSB7c3RyaW5nfSB0eXBlIC0gT25lIG9mIE1lc3NhZ2VUeXBlIHZhbHVlcy5cclxuICogQHBhcmFtIHtvYmplY3R9IFtwYXlsb2FkPXt9XSAtIEFyYml0cmFyeSBwYXlsb2FkIGRhdGEuXHJcbiAqIEByZXR1cm5zIHt7IHR5cGU6IHN0cmluZywgcGF5bG9hZDogb2JqZWN0LCB0aW1lc3RhbXA6IG51bWJlciB9fVxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZU1lc3NhZ2UodHlwZSwgcGF5bG9hZCA9IHt9KSB7XHJcbiAgcmV0dXJuIHsgdHlwZSwgcGF5bG9hZCwgdGltZXN0YW1wOiBEYXRlLm5vdygpIH07XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBDZW50cmFsIENocm9tZSBTdG9yYWdlIE1hbmFnZXIuXHJcbiAqXHJcbiAqIFdyYXBzIGFsbCBjaHJvbWUuc3RvcmFnZS5sb2NhbCBvcGVyYXRpb25zIGJlaGluZCBhIGNsZWFuIEFQSS5cclxuICogSGFuZGxlcyBjYWNoZSBleHBpcmF0aW9uIChTdWdnZXN0aW9uIDEpIGFuZCBwcmVkaWN0aW9uIGJhY2tvZmYgc3RhdGUgKFN1Z2dlc3Rpb24gMikuXHJcbiAqL1xyXG5cclxuLyoqIENhY2hlIFRUTDogMjQgaG91cnMgaW4gbWlsbGlzZWNvbmRzICovXHJcbmNvbnN0IENBQ0hFX1RUTF9NUyA9IDI0ICogNjAgKiA2MCAqIDEwMDA7XHJcblxyXG4vKiogSW5pdGlhbCBiYWNrb2ZmIGludGVydmFsOiAyMCBtaW51dGVzIGluIG1pbGxpc2Vjb25kcyAqL1xyXG5jb25zdCBJTklUSUFMX0JBQ0tPRkZfTVMgPSAyMCAqIDYwICogMTAwMDtcclxuXHJcbi8qKiBNYXhpbXVtIGJhY2tvZmYgaW50ZXJ2YWw6IDYgaG91cnMgaW4gbWlsbGlzZWNvbmRzICovXHJcbmNvbnN0IE1BWF9CQUNLT0ZGX01TID0gNiAqIDYwICogNjAgKiAxMDAwO1xyXG5cclxuZXhwb3J0IGNvbnN0IFN0b3JhZ2UgPSB7XHJcbiAgLy8gXHUyNTAwXHUyNTAwIEhpc3RvcnkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHJcblxyXG4gIC8qKlxyXG4gICAqIEdldCBjb250ZXN0IGhpc3RvcnkgZm9yIGEgdXNlciwgY2hlY2tpbmcgY2FjaGUgZnJlc2huZXNzLlxyXG4gICAqIEBwYXJhbSB7c3RyaW5nfSB1c2VybmFtZVxyXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPHsgZGF0YTogQXJyYXksIHVwZGF0ZWRBdDogbnVtYmVyLCBpc1N0YWxlOiBib29sZWFuIH0+fVxyXG4gICAqL1xyXG4gIGFzeW5jIGdldEhpc3RvcnkodXNlcm5hbWUpIHtcclxuICAgIGNvbnN0IGtleSA9IGBoaXN0b3J5XyR7dXNlcm5hbWV9YDtcclxuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xyXG4gICAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoW2tleV0sIChyZXN1bHQpID0+IHtcclxuICAgICAgICBjb25zdCBlbnRyeSA9IHJlc3VsdFtrZXldO1xyXG4gICAgICAgIGlmICghZW50cnkgfHwgIWVudHJ5LnVwZGF0ZWRBdCkge1xyXG4gICAgICAgICAgcmVzb2x2ZSh7IGRhdGE6IFtdLCB1cGRhdGVkQXQ6IDAsIGlzU3RhbGU6IHRydWUgfSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGlzU3RhbGUgPSBEYXRlLm5vdygpIC0gZW50cnkudXBkYXRlZEF0ID4gQ0FDSEVfVFRMX01TO1xyXG4gICAgICAgIHJlc29sdmUoeyBkYXRhOiBlbnRyeS5kYXRhIHx8IFtdLCB1cGRhdGVkQXQ6IGVudHJ5LnVwZGF0ZWRBdCwgaXNTdGFsZSB9KTtcclxuICAgICAgfSk7XHJcbiAgICB9KTtcclxuICB9LFxyXG5cclxuICAvKipcclxuICAgKiBTYXZlIGNvbnRlc3QgaGlzdG9yeSB3aXRoIGEgZnJlc2ggdGltZXN0YW1wLlxyXG4gICAqIEBwYXJhbSB7c3RyaW5nfSB1c2VybmFtZVxyXG4gICAqIEBwYXJhbSB7QXJyYXl9IGRhdGFcclxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTx2b2lkPn1cclxuICAgKi9cclxuICBhc3luYyBzYXZlSGlzdG9yeSh1c2VybmFtZSwgZGF0YSkge1xyXG4gICAgY29uc3Qga2V5ID0gYGhpc3RvcnlfJHt1c2VybmFtZX1gO1xyXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XHJcbiAgICAgIGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldChcclxuICAgICAgICB7IFtrZXldOiB7IGRhdGEsIHVwZGF0ZWRBdDogRGF0ZS5ub3coKSB9IH0sXHJcbiAgICAgICAgcmVzb2x2ZVxyXG4gICAgICApO1xyXG4gICAgfSk7XHJcbiAgfSxcclxuXHJcbiAgLyoqXHJcbiAgICogQ2hlY2sgaWYgYSBoaXN0b3J5IGNhY2hlIGVudHJ5IGlzIHN0YWxlICg+MjRoKS5cclxuICAgKiBAcGFyYW0ge3sgdXBkYXRlZEF0OiBudW1iZXIgfX0gZW50cnlcclxuICAgKiBAcmV0dXJucyB7Ym9vbGVhbn1cclxuICAgKi9cclxuICBpc0hpc3RvcnlTdGFsZShlbnRyeSkge1xyXG4gICAgaWYgKCFlbnRyeSB8fCAhZW50cnkudXBkYXRlZEF0KSByZXR1cm4gdHJ1ZTtcclxuICAgIHJldHVybiBEYXRlLm5vdygpIC0gZW50cnkudXBkYXRlZEF0ID4gQ0FDSEVfVFRMX01TO1xyXG4gIH0sXHJcblxyXG4gIC8vIFx1MjUwMFx1MjUwMCBQcmVkaWN0aW9uIFN0YXR1cyAoRXhwb25lbnRpYWwgQmFja29mZikgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHJcblxyXG4gIC8qKlxyXG4gICAqIEdldCB0aGUgY3VycmVudCBwcmVkaWN0aW9uIHBvbGxpbmcgc3RhdHVzLlxyXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPG9iamVjdHxudWxsPn1cclxuICAgKi9cclxuICBhc3luYyBnZXRQcmVkaWN0aW9uU3RhdHVzKCkge1xyXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XHJcbiAgICAgIGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChbXCJwcmVkaWN0aW9uX3N0YXR1c1wiXSwgKHJlc3VsdCkgPT4ge1xyXG4gICAgICAgIHJlc29sdmUocmVzdWx0LnByZWRpY3Rpb25fc3RhdHVzIHx8IG51bGwpO1xyXG4gICAgICB9KTtcclxuICAgIH0pO1xyXG4gIH0sXHJcblxyXG4gIC8qKlxyXG4gICAqIFNhdmUgcHJlZGljdGlvbiBwb2xsaW5nIHN0YXR1cyB3aXRoIGJhY2tvZmYgc3RhdGUuXHJcbiAgICogQHBhcmFtIHtvYmplY3R9IHN0YXR1cyAtIHsgY29udGVzdFNsdWcsIHN0YXR1cywgbGFzdENoZWNrZWQsIHJldHJ5Q291bnQsIG5leHRSZXRyeUF0IH1cclxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTx2b2lkPn1cclxuICAgKi9cclxuICBhc3luYyBzYXZlUHJlZGljdGlvblN0YXR1cyhzdGF0dXMpIHtcclxuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xyXG4gICAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBwcmVkaWN0aW9uX3N0YXR1czogc3RhdHVzIH0sIHJlc29sdmUpO1xyXG4gICAgfSk7XHJcbiAgfSxcclxuXHJcbiAgLyoqXHJcbiAgICogQ2xlYXIgcHJlZGljdGlvbiBzdGF0dXMgKHByZWRpY3Rpb24gcmVzb2x2ZWQgb3IgY29uZmlybWVkKS5cclxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTx2b2lkPn1cclxuICAgKi9cclxuICBhc3luYyBjbGVhclByZWRpY3Rpb25TdGF0dXMoKSB7XHJcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcclxuICAgICAgY2hyb21lLnN0b3JhZ2UubG9jYWwucmVtb3ZlKFwicHJlZGljdGlvbl9zdGF0dXNcIiwgcmVzb2x2ZSk7XHJcbiAgICB9KTtcclxuICB9LFxyXG5cclxuICAvKipcclxuICAgKiBDYWxjdWxhdGUgdGhlIG5leHQgcmV0cnkgdGltZXN0YW1wIHVzaW5nIGV4cG9uZW50aWFsIGJhY2tvZmYuXHJcbiAgICogU2NoZWR1bGU6IDIwbSBcdTIxOTIgNDBtIFx1MjE5MiA4MG0gXHUyMTkyIDE2MG0gXHUyMTkyIDMyMG0gXHUyMTkyIDM2MG0gKGNhcClcclxuICAgKiBAcGFyYW0ge251bWJlcn0gcmV0cnlDb3VudCAtIEN1cnJlbnQgcmV0cnkgY291bnQgKDAtaW5kZXhlZCkuXHJcbiAgICogQHJldHVybnMge251bWJlcn0gVGltZXN0YW1wIChtcykgZm9yIG5leHQgYWxsb3dlZCByZXRyeS5cclxuICAgKi9cclxuICBjYWxjdWxhdGVOZXh0UmV0cnkocmV0cnlDb3VudCkge1xyXG4gICAgY29uc3QgZGVsYXlNcyA9IE1hdGgubWluKFxyXG4gICAgICBJTklUSUFMX0JBQ0tPRkZfTVMgKiBNYXRoLnBvdygyLCByZXRyeUNvdW50KSxcclxuICAgICAgTUFYX0JBQ0tPRkZfTVNcclxuICAgICk7XHJcbiAgICByZXR1cm4gRGF0ZS5ub3coKSArIGRlbGF5TXM7XHJcbiAgfSxcclxuXHJcbiAgLy8gXHUyNTAwXHUyNTAwIFVzZXJuYW1lIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxyXG5cclxuICAvKipcclxuICAgKiBHZXQgdGhlIHN0b3JlZCBMZWV0Q29kZSB1c2VybmFtZS5cclxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTxzdHJpbmd8bnVsbD59XHJcbiAgICovXHJcbiAgYXN5bmMgZ2V0VXNlcm5hbWUoKSB7XHJcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcclxuICAgICAgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFtcImxjX3VzZXJuYW1lXCJdLCAocmVzdWx0KSA9PiB7XHJcbiAgICAgICAgcmVzb2x2ZShyZXN1bHQubGNfdXNlcm5hbWUgfHwgbnVsbCk7XHJcbiAgICAgIH0pO1xyXG4gICAgfSk7XHJcbiAgfSxcclxuXHJcbiAgLyoqXHJcbiAgICogU2F2ZSB0aGUgTGVldENvZGUgdXNlcm5hbWUuXHJcbiAgICogQHBhcmFtIHtzdHJpbmd9IHVzZXJuYW1lXHJcbiAgICogQHJldHVybnMge1Byb21pc2U8dm9pZD59XHJcbiAgICovXHJcbiAgYXN5bmMgc2V0VXNlcm5hbWUodXNlcm5hbWUpIHtcclxuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xyXG4gICAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBsY191c2VybmFtZTogdXNlcm5hbWUgfSwgcmVzb2x2ZSk7XHJcbiAgICB9KTtcclxuICB9LFxyXG5cclxuICAvLyBcdTI1MDBcdTI1MDAgTGFzdCBFcnJvciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcclxuXHJcbiAgLyoqXHJcbiAgICogU2F2ZSB0aGUgbGFzdCBlcnJvciBzdGF0ZSBmb3IgVUkgZGlzcGxheS5cclxuICAgKiBAcGFyYW0ge29iamVjdHxudWxsfSBlcnJvciAtIEVycm9yIG9iamVjdCBmcm9tIGNyZWF0ZUVycm9yKCksIG9yIG51bGwgdG8gY2xlYXIuXHJcbiAgICogQHJldHVybnMge1Byb21pc2U8dm9pZD59XHJcbiAgICovXHJcbiAgYXN5bmMgc2V0TGFzdEVycm9yKGVycm9yKSB7XHJcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcclxuICAgICAgaWYgKGVycm9yID09PSBudWxsKSB7XHJcbiAgICAgICAgY2hyb21lLnN0b3JhZ2UubG9jYWwucmVtb3ZlKFwibGFzdF9lcnJvclwiLCByZXNvbHZlKTtcclxuICAgICAgfSBlbHNlIHtcclxuICAgICAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBsYXN0X2Vycm9yOiBlcnJvciB9LCByZXNvbHZlKTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgfSxcclxuXHJcbiAgLyoqXHJcbiAgICogR2V0IHRoZSBsYXN0IHN0b3JlZCBlcnJvci5cclxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTxvYmplY3R8bnVsbD59XHJcbiAgICovXHJcbiAgYXN5bmMgZ2V0TGFzdEVycm9yKCkge1xyXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XHJcbiAgICAgIGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChbXCJsYXN0X2Vycm9yXCJdLCAocmVzdWx0KSA9PiB7XHJcbiAgICAgICAgcmVzb2x2ZShyZXN1bHQubGFzdF9lcnJvciB8fCBudWxsKTtcclxuICAgICAgfSk7XHJcbiAgICB9KTtcclxuICB9LFxyXG59O1xyXG4iLCAiLyoqXHJcbiAqIFN0cnVjdHVyZWQgZXJyb3IgY29kZXMgZm9yIHRoZSBleHRlbnNpb24uXHJcbiAqXHJcbiAqIFRoZXNlIGNvZGVzIGFsbG93IHRoZSBwb3B1cCBhbmQgY29udGVudCBzY3JpcHRzIHRvIGRpc3BsYXlcclxuICogbWVhbmluZ2Z1bCwgdXNlci1mcmllbmRseSBzdGF0dXMgbWVzc2FnZXMgaW5zdGVhZCBvZiBnZW5lcmljIGVycm9ycy5cclxuICovXHJcblxyXG5leHBvcnQgY29uc3QgRXJyb3JDb2RlID0ge1xyXG4gIC8qKiBOZXR3b3JrIHJlcXVlc3QgZmFpbGVkIChubyBjb25uZWN0aXZpdHksIEROUywgdGltZW91dCkgKi9cclxuICBORVRXT1JLX0VSUk9SOiBcIk5FVFdPUktfRVJST1JcIixcclxuICAvKiogTGVldENvZGUgR3JhcGhRTCBBUEkgcmV0dXJuZWQgYW4gZXJyb3Igb3IgdW5leHBlY3RlZCBzaGFwZSAqL1xyXG4gIEdSQVBIUUxfRkFJTEVEOiBcIkdSQVBIUUxfRkFJTEVEXCIsXHJcbiAgLyoqIFByZWRpY3Rpb24gaXMgbm90IHlldCBhdmFpbGFibGUgXHUyMDE0IHN0aWxsIGJlaW5nIGNhbGN1bGF0ZWQgKi9cclxuICBQUkVESUNUSU9OX1BFTkRJTkc6IFwiUFJFRElDVElPTl9QRU5ESU5HXCIsXHJcbiAgLyoqIFRoZSByZXF1ZXN0ZWQgdXNlciB3YXMgbm90IGZvdW5kIG9uIExlZXRDb2RlICovXHJcbiAgVVNFUl9OT1RfRk9VTkQ6IFwiVVNFUl9OT1RfRk9VTkRcIixcclxuICAvKiogVG9vIG1hbnkgcmVxdWVzdHMgXHUyMDE0IGJlaW5nIHJhdGUgbGltaXRlZCAqL1xyXG4gIFJBVEVfTElNSVRFRDogXCJSQVRFX0xJTUlURURcIixcclxuICAvKiogQ2F0Y2gtYWxsIGZvciB1bmV4cGVjdGVkIGVycm9ycyAqL1xyXG4gIFVOS05PV05fRVJST1I6IFwiVU5LTk9XTl9FUlJPUlwiLFxyXG59O1xyXG5cclxuLyoqXHJcbiAqIFVzZXItZnJpZW5kbHkgZXJyb3IgbWVzc2FnZXMgZm9yIGVhY2ggY29kZS5cclxuICovXHJcbmNvbnN0IEVycm9yTWVzc2FnZXMgPSB7XHJcbiAgW0Vycm9yQ29kZS5ORVRXT1JLX0VSUk9SXTogXCJOZXR3b3JrIGVycm9yIFx1MjAxNCB3aWxsIHJldHJ5IGF1dG9tYXRpY2FsbHkuXCIsXHJcbiAgW0Vycm9yQ29kZS5HUkFQSFFMX0ZBSUxFRF06IFwiRmFpbGVkIHRvIHJlYWNoIExlZXRDb2RlIFx1MjAxNCB3aWxsIHJldHJ5LlwiLFxyXG4gIFtFcnJvckNvZGUuUFJFRElDVElPTl9QRU5ESU5HXTogXCJQcmVkaWN0aW9uIGlzIHN0aWxsIGJlaW5nIGNhbGN1bGF0ZWRcdTIwMjZcIixcclxuICBbRXJyb3JDb2RlLlVTRVJfTk9UX0ZPVU5EXTogXCJMZWV0Q29kZSB1c2VyIG5vdCBmb3VuZC5cIixcclxuICBbRXJyb3JDb2RlLlJBVEVfTElNSVRFRF06IFwiVG9vIG1hbnkgcmVxdWVzdHMgXHUyMDE0IHNsb3dpbmcgZG93bi5cIixcclxuICBbRXJyb3JDb2RlLlVOS05PV05fRVJST1JdOiBcIlNvbWV0aGluZyB3ZW50IHdyb25nLlwiLFxyXG59O1xyXG5cclxuLyoqXHJcbiAqIENyZWF0ZSBhIHN0cnVjdHVyZWQgZXJyb3Igb2JqZWN0LlxyXG4gKiBAcGFyYW0ge3N0cmluZ30gY29kZSAtIE9uZSBvZiBFcnJvckNvZGUgdmFsdWVzLlxyXG4gKiBAcGFyYW0ge3N0cmluZ30gW2RldGFpbF0gLSBPcHRpb25hbCB0ZWNobmljYWwgZGV0YWlsIGZvciBsb2dnaW5nLlxyXG4gKiBAcmV0dXJucyB7eyBjb2RlOiBzdHJpbmcsIG1lc3NhZ2U6IHN0cmluZywgZGV0YWlsPzogc3RyaW5nLCB0aW1lc3RhbXA6IG51bWJlciB9fVxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUVycm9yKGNvZGUsIGRldGFpbCkge1xyXG4gIHJldHVybiB7XHJcbiAgICBjb2RlLFxyXG4gICAgbWVzc2FnZTogRXJyb3JNZXNzYWdlc1tjb2RlXSB8fCBFcnJvck1lc3NhZ2VzW0Vycm9yQ29kZS5VTktOT1dOX0VSUk9SXSxcclxuICAgIC4uLihkZXRhaWwgPyB7IGRldGFpbCB9IDoge30pLFxyXG4gICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxyXG4gIH07XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBTdHJ1Y3R1cmVkIGxvZ2dlciBmb3IgdGhlIENocm9tZSBleHRlbnNpb24uXHJcbiAqXHJcbiAqIFJlcGxhY2VzIHJhdyBjb25zb2xlLmxvZy9lcnJvci93YXJuIGNhbGxzIHdpdGggc3RydWN0dXJlZCBvdXRwdXRcclxuICogdGhhdCBpbmNsdWRlcyB0aW1lc3RhbXBzLCBjb250ZXh0IG1vZHVsZXMsIGFuZCByZWxldmFudCBkYXRhLlxyXG4gKi9cclxuXHJcbmV4cG9ydCBjb25zdCBMb2dnZXIgPSB7XHJcbiAgLyoqXHJcbiAgICogQHBhcmFtIHtzdHJpbmd9IGNvbnRleHQgLSBNb2R1bGUgbmFtZSAoZS5nLiwgXCJCYWNrZ3JvdW5kXCIsIFwiUG9wdXBcIikuXHJcbiAgICogQHBhcmFtIHtzdHJpbmd9IG1lc3NhZ2UgLSBMb2cgbWVzc2FnZS5cclxuICAgKiBAcGFyYW0ge29iamVjdH0gW2RhdGFdIC0gT3B0aW9uYWwgc3RydWN0dXJlZCBkYXRhLlxyXG4gICAqL1xyXG4gIGluZm8oY29udGV4dCwgbWVzc2FnZSwgZGF0YSkge1xyXG4gICAgY29uc3QgZW50cnkgPSBMb2dnZXIuX2Zvcm1hdChcIklORk9cIiwgY29udGV4dCwgbWVzc2FnZSwgZGF0YSk7XHJcbiAgICBjb25zb2xlLmxvZyhlbnRyeSk7XHJcbiAgfSxcclxuXHJcbiAgd2Fybihjb250ZXh0LCBtZXNzYWdlLCBkYXRhKSB7XHJcbiAgICBjb25zdCBlbnRyeSA9IExvZ2dlci5fZm9ybWF0KFwiV0FSTlwiLCBjb250ZXh0LCBtZXNzYWdlLCBkYXRhKTtcclxuICAgIGNvbnNvbGUud2FybihlbnRyeSk7XHJcbiAgfSxcclxuXHJcbiAgZXJyb3IoY29udGV4dCwgbWVzc2FnZSwgZGF0YSkge1xyXG4gICAgY29uc3QgZW50cnkgPSBMb2dnZXIuX2Zvcm1hdChcIkVSUk9SXCIsIGNvbnRleHQsIG1lc3NhZ2UsIGRhdGEpO1xyXG4gICAgY29uc29sZS5lcnJvcihlbnRyeSk7XHJcbiAgfSxcclxuXHJcbiAgLyoqXHJcbiAgICogRm9ybWF0IGEgc3RydWN0dXJlZCBsb2cgZW50cnkuXHJcbiAgICogQHByaXZhdGVcclxuICAgKi9cclxuICBfZm9ybWF0KGxldmVsLCBjb250ZXh0LCBtZXNzYWdlLCBkYXRhKSB7XHJcbiAgICBjb25zdCB0aW1lc3RhbXAgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XHJcbiAgICBjb25zdCBiYXNlID0gYFske3RpbWVzdGFtcH1dIFske2xldmVsfV0gWyR7Y29udGV4dH1dICR7bWVzc2FnZX1gO1xyXG4gICAgaWYgKGRhdGEgIT09IHVuZGVmaW5lZCAmJiBkYXRhICE9PSBudWxsKSB7XHJcbiAgICAgIC8vIEtlZXAgaXQgcmVhZGFibGUgaW4gdGhlIGNvbnNvbGVcclxuICAgICAgcmV0dXJuIGAke2Jhc2V9IHwgJHtKU09OLnN0cmluZ2lmeShkYXRhKX1gO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGJhc2U7XHJcbiAgfSxcclxufTtcclxuIiwgIi8qKlxyXG4gKiBCYWNrZ3JvdW5kIFNlcnZpY2UgV29ya2VyXHJcbiAqXHJcbiAqIFJlc3BvbnNpYmlsaXRpZXM6XHJcbiAqIC0gVXNlciBkZXRlY3Rpb24gKExlZXRDb2RlIEdyYXBoUUwpXHJcbiAqIC0gQWxhcm0tYmFzZWQgcG9sbGluZyB3aXRoIGV4cG9uZW50aWFsIGJhY2tvZmZcclxuICogLSBDaHJvbWUgU3RvcmFnZSBtYW5hZ2VtZW50ICh2aWEgU3RvcmFnZSBoZWxwZXIpXHJcbiAqIC0gQVBJIGNvbW11bmljYXRpb24gd2l0aCB0aGUgYmFja2VuZCBwcm94eVxyXG4gKiAtIEJyb2FkY2FzdGluZyB0eXBlZCBtZXNzYWdlcyB0byBwb3B1cCAmIGNvbnRlbnQgc2NyaXB0c1xyXG4gKi9cclxuXHJcbi8vIFx1MjUwMFx1MjUwMCBTaGFyZWQgbW9kdWxlcyAoaW5saW5lZCBieSBidWlsZC5janMpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxyXG5pbXBvcnQgeyBNZXNzYWdlVHlwZSwgY3JlYXRlTWVzc2FnZSB9IGZyb20gXCIuL2xpYi9tZXNzYWdlVHlwZXMuanNcIjtcclxuaW1wb3J0IHsgU3RvcmFnZSB9IGZyb20gXCIuL2xpYi9zdG9yYWdlLmpzXCI7XHJcbmltcG9ydCB7IEVycm9yQ29kZSwgY3JlYXRlRXJyb3IgfSBmcm9tIFwiLi9saWIvZXJyb3JzLmpzXCI7XHJcbmltcG9ydCB7IExvZ2dlciB9IGZyb20gXCIuL2xpYi9sb2dnZXIuanNcIjtcclxuXHJcbi8vIFx1MjUwMFx1MjUwMCBDb25zdGFudHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHJcblxyXG5jb25zdCBBUElfVVJMID0gXCJodHRwczovL2ZvcmUtY29kZS52ZXJjZWwuYXBwL2FwaS92MVwiOyAvLyBDaGFuZ2UgdG8geW91ciBob3N0ZWQgYmFja2VuZCBVUkxcclxuXHJcbmNvbnN0IExPR19DVFggPSBcIkJhY2tncm91bmRcIjtcclxuXHJcbi8vIFNpbXBsZSBpbi1tZW1vcnkgY2FjaGUgZm9yIGxlYWRlcmJvYXJkIHByZWRpY3Rpb24gbG9va3Vwc1xyXG5jb25zdCBwcmVkaWN0aW9uQ2FjaGUgPSBuZXcgTWFwKCk7XHJcblxyXG4vLyBcdTI1MDBcdTI1MDAgVXNlcm5hbWUgRGV0ZWN0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxyXG5cclxuYXN5bmMgZnVuY3Rpb24gZ2V0TGVldENvZGVVc2VybmFtZSgpIHtcclxuICB0cnkge1xyXG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goXCJodHRwczovL2xlZXRjb2RlLmNvbS9ncmFwaHFsXCIsIHtcclxuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcclxuICAgICAgY3JlZGVudGlhbHM6IFwiaW5jbHVkZVwiLFxyXG4gICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXHJcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICBxdWVyeTogXCJxdWVyeSBnbG9iYWxEYXRhIHsgdXNlclN0YXR1cyB7IHVzZXJuYW1lIH0gfVwiLFxyXG4gICAgICB9KSxcclxuICAgIH0pO1xyXG4gICAgY29uc3QgZGF0YSA9IGF3YWl0IHJlcy5qc29uKCk7XHJcbiAgICByZXR1cm4gZGF0YT8uZGF0YT8udXNlclN0YXR1cz8udXNlcm5hbWUgfHwgbnVsbDtcclxuICB9IGNhdGNoIChlKSB7XHJcbiAgICBMb2dnZXIuZXJyb3IoTE9HX0NUWCwgXCJGYWlsZWQgdG8gZGV0ZWN0IExlZXRDb2RlIHVzZXJuYW1lXCIsIHsgZXJyb3I6IGUubWVzc2FnZSB9KTtcclxuICAgIHJldHVybiBudWxsO1xyXG4gIH1cclxufVxyXG5cclxuLy8gXHUyNTAwXHUyNTAwIEhpc3RvcnkgTWFuYWdlbWVudCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcclxuXHJcbi8qKlxyXG4gKiBGZXRjaCBsYXRlc3QgYXR0ZW5kZWQgY29udGVzdCBmcm9tIExlZXRDb2RlLlxyXG4gKi9cclxuYXN5bmMgZnVuY3Rpb24gZmV0Y2hMYXRlc3RBdHRlbmRlZENvbnRlc3QoKSB7XHJcbiAgdHJ5IHtcclxuICAgIGNvbnN0IGdxbFJlcyA9IGF3YWl0IGZldGNoKFwiaHR0cHM6Ly9sZWV0Y29kZS5jb20vZ3JhcGhxbFwiLCB7XHJcbiAgICAgIG1ldGhvZDogXCJQT1NUXCIsXHJcbiAgICAgIGNyZWRlbnRpYWxzOiBcImluY2x1ZGVcIixcclxuICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxyXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgcXVlcnk6IGBxdWVyeSBjb250ZXN0VjJNeUNvbnRlc3RzKCRza2lwOiBJbnQhLCAkbGltaXQ6IEludCEsICRpc1ZpcnR1YWw6IEJvb2xlYW4pIHtcclxuICAgICAgICAgIGNvbnRlc3RWMk15Q29udGVzdHMoc2tpcDogJHNraXAsIGxpbWl0OiAkbGltaXQsIGlzVmlydHVhbDogJGlzVmlydHVhbCkge1xyXG4gICAgICAgICAgICBjb250ZXN0cyB7XHJcbiAgICAgICAgICAgICAgdGl0bGVTbHVnXHJcbiAgICAgICAgICAgICAgdGl0bGVcclxuICAgICAgICAgICAgICBzdGFydFRpbWVcclxuICAgICAgICAgICAgICBmaW5pc2hUaW1lXHJcbiAgICAgICAgICAgICAgc29sdmVkXHJcbiAgICAgICAgICAgICAgcmFua2luZ1xyXG4gICAgICAgICAgICAgIHRvdGFsUXVlc3Rpb25zXHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgIH1cclxuICAgICAgICB9YCxcclxuICAgICAgICB2YXJpYWJsZXM6IHsgc2tpcDogMCwgbGltaXQ6IDEsIGlzVmlydHVhbDogZmFsc2UgfSxcclxuICAgICAgfSksXHJcbiAgICB9KTtcclxuXHJcbiAgICBpZiAoZ3FsUmVzLm9rKSB7XHJcbiAgICAgIGNvbnN0IGdxbERhdGEgPSBhd2FpdCBncWxSZXMuanNvbigpO1xyXG4gICAgICBjb25zdCBjb250ZXN0cyA9IGdxbERhdGE/LmRhdGE/LmNvbnRlc3RWMk15Q29udGVzdHM/LmNvbnRlc3RzIHx8IFtdO1xyXG4gICAgICBpZiAoY29udGVzdHMubGVuZ3RoID4gMCkge1xyXG4gICAgICAgIHJldHVybiBjb250ZXN0c1swXTtcclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH0gY2F0Y2ggKGVycikge1xyXG4gICAgTG9nZ2VyLndhcm4oTE9HX0NUWCwgXCJGYWlsZWQgdG8gZmV0Y2ggbGF0ZXN0IGF0dGVuZGVkIGNvbnRlc3RcIiwgeyBlcnJvcjogZXJyLm1lc3NhZ2UgfSk7XHJcbiAgfVxyXG4gIHJldHVybiBudWxsO1xyXG59XHJcblxyXG4vKipcclxuICogRmV0Y2ggZnJlc2ggaGlzdG9yeSBmcm9tIHRoZSBiYWNrZW5kIGFuZCBzYXZlIHRvIHN0b3JhZ2UuXHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiByZWZyZXNoSGlzdG9yeSh1c2VybmFtZSkge1xyXG4gIExvZ2dlci5pbmZvKExPR19DVFgsIFwiUmVmcmVzaGluZyBoaXN0b3J5IGZyb20gYmFja2VuZFwiLCB7IHVzZXJuYW1lIH0pO1xyXG4gIHRyeSB7XHJcbiAgICBjb25zdCBsYXRlc3RDb250ZXN0ID0gYXdhaXQgZmV0Y2hMYXRlc3RBdHRlbmRlZENvbnRlc3QoKTtcclxuXHJcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHtBUElfVVJMfS91c2VyLyR7dXNlcm5hbWV9L2hpc3RvcnlgLCB7XHJcbiAgICAgIG1ldGhvZDogXCJQT1NUXCIsXHJcbiAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcclxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgIGxhdGVzdF9hdHRlbmRlZF9jb250ZXN0OiBsYXRlc3RDb250ZXN0XHJcbiAgICAgIH0pXHJcbiAgICB9KTtcclxuXHJcbiAgICBpZiAocmVzLm9rKSB7XHJcbiAgICAgIGNvbnN0IGhpc3RvcnkgPSBhd2FpdCByZXMuanNvbigpO1xyXG4gICAgICBcclxuICAgICAgY29uc3QgbWFwcGVkSGlzdG9yeSA9IGhpc3RvcnkubWFwKHJlY29yZCA9PiAoe1xyXG4gICAgICAgIG5hbWU6IHJlY29yZC5jb250ZXN0X3RpdGxlLFxyXG4gICAgICAgIGFjdHVhbFJhdGluZzogcmVjb3JkLmFjdHVhbF9yYXRpbmcsXHJcbiAgICAgICAgcHJlZGljdGVkUmF0aW5nOiByZWNvcmQucHJlZGljdGVkX3JhdGluZyB8fCBcIi1cIixcclxuICAgICAgICBkZWx0YTogcmVjb3JkLmFjdHVhbF9kZWx0YSAhPT0gbnVsbCAmJiByZWNvcmQuYWN0dWFsX2RlbHRhICE9PSB1bmRlZmluZWQgXHJcbiAgICAgICAgICA/IHJlY29yZC5hY3R1YWxfZGVsdGEgXHJcbiAgICAgICAgICA6IChyZWNvcmQucHJlZGljdGVkX2RlbHRhICE9PSBudWxsICYmIHJlY29yZC5wcmVkaWN0ZWRfZGVsdGEgIT09IHVuZGVmaW5lZCA/IHJlY29yZC5wcmVkaWN0ZWRfZGVsdGEgOiBudWxsKSxcclxuICAgICAgICBzdGF0dXM6IHJlY29yZC5zdGF0dXNcclxuICAgICAgfSkpO1xyXG5cclxuICAgICAgYXdhaXQgU3RvcmFnZS5zYXZlSGlzdG9yeSh1c2VybmFtZSwgbWFwcGVkSGlzdG9yeSk7XHJcbiAgICAgIGF3YWl0IFN0b3JhZ2Uuc2V0TGFzdEVycm9yKG51bGwpO1xyXG4gICAgICBcclxuICAgICAgY29uc3QgcGVuZGluZ0l0ZW0gPSBtYXBwZWRIaXN0b3J5LmZpbmQociA9PiByLnN0YXR1cyA9PT0gJ3ByZWRpY3Rpb25fcGVuZGluZycpO1xyXG4gICAgICBpZiAocGVuZGluZ0l0ZW0pIHtcclxuICAgICAgICBhd2FpdCBTdG9yYWdlLnNldExhc3RFcnJvcihjcmVhdGVFcnJvcihFcnJvckNvZGUuUFJFRElDVElPTl9QRU5ESU5HKSk7XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIExvZ2dlci5pbmZvKExPR19DVFgsIFwiSGlzdG9yeSByZWZyZXNoZWQgc3VjY2Vzc2Z1bGx5XCIsIHtcclxuICAgICAgICB1c2VybmFtZSxcclxuICAgICAgICBjb3VudDogbWFwcGVkSGlzdG9yeS5sZW5ndGgsXHJcbiAgICAgIH0pO1xyXG5cclxuICAgICAgYnJvYWRjYXN0KGNyZWF0ZU1lc3NhZ2UoTWVzc2FnZVR5cGUuSElTVE9SWV9VUERBVEVELCB7IHVzZXJuYW1lIH0pKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQmFja2VuZCByZXR1cm5lZCAke3Jlcy5zdGF0dXN9YCk7XHJcbiAgICB9XHJcbiAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICBjb25zdCBlcnJvciA9IGNyZWF0ZUVycm9yKEVycm9yQ29kZS5ORVRXT1JLX0VSUk9SLCBlcnIubWVzc2FnZSk7XHJcbiAgICBhd2FpdCBTdG9yYWdlLnNldExhc3RFcnJvcihlcnJvcik7XHJcbiAgICBMb2dnZXIuZXJyb3IoTE9HX0NUWCwgXCJGYWlsZWQgdG8gcmVmcmVzaCBoaXN0b3J5XCIsIHsgdXNlcm5hbWUsIGVycm9yOiBlcnIubWVzc2FnZSB9KTtcclxuICB9XHJcbn1cclxuXHJcbi8vIFx1MjUwMFx1MjUwMCBCcm9hZGNhc3QgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHJcblxyXG4vKipcclxuICogQnJvYWRjYXN0IGEgdHlwZWQgbWVzc2FnZSB0byBwb3B1cCBhbmQgYWxsIExlZXRDb2RlIHRhYnMuXHJcbiAqL1xyXG5mdW5jdGlvbiBicm9hZGNhc3QobWVzc2FnZSkge1xyXG4gIC8vIE5vdGlmeSBwb3B1cCAobWF5IG5vdCBiZSBvcGVuIFx1MjAxNCB0aGF0J3MgZmluZSwgY2F0Y2ggc2lsZW50bHkpXHJcbiAgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2UobWVzc2FnZSkuY2F0Y2goKCkgPT4ge30pO1xyXG5cclxuICAvLyBOb3RpZnkgYWN0aXZlIExlZXRDb2RlIHRhYnNcclxuICBjaHJvbWUudGFicy5xdWVyeSh7IHVybDogXCIqOi8vbGVldGNvZGUuY29tLypcIiB9LCAodGFicykgPT4ge1xyXG4gICAgZm9yIChjb25zdCB0YWIgb2YgdGFicykge1xyXG4gICAgICBjaHJvbWUudGFicy5zZW5kTWVzc2FnZSh0YWIuaWQsIG1lc3NhZ2UpLmNhdGNoKCgpID0+IHt9KTtcclxuICAgIH1cclxuICB9KTtcclxufVxyXG5cclxuLy8gXHUyNTAwXHUyNTAwIExpZmVjeWNsZSBFdmVudHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHJcblxyXG5jaHJvbWUucnVudGltZS5vblN0YXJ0dXAuYWRkTGlzdGVuZXIoKCkgPT4ge1xyXG4gIExvZ2dlci5pbmZvKExPR19DVFgsIFwiRXh0ZW5zaW9uIHN0YXJ0dXAgXHUyMDE0IGNyZWF0aW5nIGFsYXJtXCIpO1xyXG4gIGNocm9tZS5hbGFybXMuY3JlYXRlKFwiY2hlY2tQZW5kaW5nUHJlZGljdGlvblwiLCB7IHBlcmlvZEluTWludXRlczogMjAgfSk7XHJcbn0pO1xyXG5cclxuY2hyb21lLnJ1bnRpbWUub25JbnN0YWxsZWQuYWRkTGlzdGVuZXIoYXN5bmMgKGRldGFpbHMpID0+IHtcclxuICBjaHJvbWUuYWxhcm1zLmNyZWF0ZShcImNoZWNrUGVuZGluZ1ByZWRpY3Rpb25cIiwgeyBwZXJpb2RJbk1pbnV0ZXM6IDIwIH0pO1xyXG5cclxuICBpZiAoZGV0YWlscy5yZWFzb24gPT09IFwiaW5zdGFsbFwiKSB7XHJcbiAgICBMb2dnZXIuaW5mbyhMT0dfQ1RYLCBcIkV4dGVuc2lvbiBpbnN0YWxsZWQgXHUyMDE0IGRldGVjdGluZyB1c2VyXCIpO1xyXG4gICAgY29uc3QgdXNlcm5hbWUgPSBhd2FpdCBnZXRMZWV0Q29kZVVzZXJuYW1lKCk7XHJcblxyXG4gICAgaWYgKHVzZXJuYW1lKSB7XHJcbiAgICAgIGF3YWl0IFN0b3JhZ2Uuc2V0VXNlcm5hbWUodXNlcm5hbWUpO1xyXG4gICAgICBMb2dnZXIuaW5mbyhMT0dfQ1RYLCBcIlVzZXIgZGV0ZWN0ZWRcIiwgeyB1c2VybmFtZSB9KTtcclxuXHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgYXdhaXQgZmV0Y2goYCR7QVBJX1VSTH0vdXNlci8ke3VzZXJuYW1lfS9yZWdpc3RlcmAsIHsgbWV0aG9kOiBcIlBPU1RcIiB9KTtcclxuICAgICAgfSBjYXRjaCAoXykge1xyXG4gICAgICAgIC8vIFJlZ2lzdGVyIGVuZHBvaW50IGlzIG9wdGlvbmFsOyBpZ25vcmUgZmFpbHVyZXNcclxuICAgICAgfVxyXG5cclxuICAgICAgYXdhaXQgcmVmcmVzaEhpc3RvcnkodXNlcm5hbWUpO1xyXG5cclxuICAgICAgYnJvYWRjYXN0KGNyZWF0ZU1lc3NhZ2UoTWVzc2FnZVR5cGUuTE9HSU5fQ0hBTkdFRCwgeyB1c2VybmFtZSB9KSk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICBMb2dnZXIud2FybihMT0dfQ1RYLCBcIk5vIExlZXRDb2RlIHVzZXIgZGV0ZWN0ZWQgZHVyaW5nIGluc3RhbGxcIik7XHJcbiAgICB9XHJcbiAgfVxyXG59KTtcclxuXHJcbi8vIFx1MjUwMFx1MjUwMCBBbGFybSBIYW5kbGVyIChTdWdnZXN0aW9uIDE6IENhY2hlIEV4cGlyeSArIFN1Z2dlc3Rpb24gMjogQmFja29mZikgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHJcblxyXG5jaHJvbWUuYWxhcm1zLm9uQWxhcm0uYWRkTGlzdGVuZXIoYXN5bmMgKGFsYXJtKSA9PiB7XHJcbiAgaWYgKGFsYXJtLm5hbWUgIT09IFwiY2hlY2tQZW5kaW5nUHJlZGljdGlvblwiKSByZXR1cm47XHJcblxyXG4gIGNvbnN0IHVzZXJuYW1lID0gYXdhaXQgU3RvcmFnZS5nZXRVc2VybmFtZSgpO1xyXG4gIGlmICghdXNlcm5hbWUpIHJldHVybjtcclxuXHJcbiAgTG9nZ2VyLmluZm8oTE9HX0NUWCwgXCJBbGFybSBmaXJlZCBcdTIwMTQgY2hlY2tpbmcgcHJlZGljdGlvbnNcIiwgeyB1c2VybmFtZSB9KTtcclxuXHJcbiAgdHJ5IHtcclxuICAgIGNvbnN0IGNhY2hlZEhpc3RvcnkgPSBhd2FpdCBTdG9yYWdlLmdldEhpc3RvcnkodXNlcm5hbWUpO1xyXG4gICAgaWYgKGNhY2hlZEhpc3RvcnkuaXNTdGFsZSkge1xyXG4gICAgICBMb2dnZXIuaW5mbyhMT0dfQ1RYLCBcIkhpc3RvcnkgY2FjaGUgaXMgc3RhbGUgXHUyMDE0IHJlZnJlc2hpbmdcIiwgeyB1c2VybmFtZSB9KTtcclxuICAgICAgYXdhaXQgcmVmcmVzaEhpc3RvcnkodXNlcm5hbWUpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcblxyXG4gICAgLy8gQWx3YXlzIGZldGNoIGxhdGVzdCB0byBzeW5jIHBlbmRpbmcgcHJlZGljdGlvbnMgcHJvYWN0aXZlbHkgaW4gYWxhcm1cclxuICAgIGF3YWl0IHJlZnJlc2hIaXN0b3J5KHVzZXJuYW1lKTtcclxuICB9IGNhdGNoIChlcnIpIHtcclxuICAgIGNvbnN0IGVycm9yQ29kZSA9XHJcbiAgICAgIGVyci5tZXNzYWdlICYmIGVyci5tZXNzYWdlLmluY2x1ZGVzKFwiTmV0d29ya0Vycm9yXCIpXHJcbiAgICAgICAgPyBFcnJvckNvZGUuTkVUV09SS19FUlJPUlxyXG4gICAgICAgIDogRXJyb3JDb2RlLlVOS05PV05fRVJST1I7XHJcblxyXG4gICAgY29uc3QgZXJyb3IgPSBjcmVhdGVFcnJvcihlcnJvckNvZGUsIGVyci5tZXNzYWdlKTtcclxuICAgIGF3YWl0IFN0b3JhZ2Uuc2V0TGFzdEVycm9yKGVycm9yKTtcclxuICAgIExvZ2dlci5lcnJvcihMT0dfQ1RYLCBcIkFsYXJtIGhhbmRsZXIgZmFpbGVkXCIsIHsgZXJyb3I6IGVyci5tZXNzYWdlIH0pO1xyXG5cclxuICAgIGJyb2FkY2FzdChjcmVhdGVNZXNzYWdlKE1lc3NhZ2VUeXBlLkVSUk9SX09DQ1VSUkVELCB7IGVycm9yIH0pKTtcclxuICB9XHJcbn0pO1xyXG5cclxuLy8gXHUyNTAwXHUyNTAwIE1lc3NhZ2UgSGFuZGxlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHJcblxyXG5jaHJvbWUucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoKHJlcXVlc3QsIHNlbmRlciwgc2VuZFJlc3BvbnNlKSA9PiB7XHJcbiAgaWYgKHJlcXVlc3QuYWN0aW9uID09PSBcImZldGNoUHJlZGljdGlvbnNcIikge1xyXG4gICAgaGFuZGxlRmV0Y2hQcmVkaWN0aW9ucyhyZXF1ZXN0LnVzZXJuYW1lcylcclxuICAgICAgLnRoZW4oKGRhdGEpID0+IHNlbmRSZXNwb25zZSh7IGRhdGEgfSkpXHJcbiAgICAgIC5jYXRjaCgoZXJyKSA9PiB7XHJcbiAgICAgICAgTG9nZ2VyLmVycm9yKExPR19DVFgsIFwiUHJlZGljdGlvbiBmZXRjaCBmYWlsZWRcIiwgeyBlcnJvcjogZXJyLm1lc3NhZ2UgfSk7XHJcbiAgICAgICAgc2VuZFJlc3BvbnNlKHsgZGF0YTogbnVsbCwgZXJyb3I6IGVyci5tZXNzYWdlIH0pO1xyXG4gICAgICB9KTtcclxuICAgIHJldHVybiB0cnVlOyAvLyBLZWVwIGNoYW5uZWwgb3BlbiBmb3IgYXN5bmMgcmVzcG9uc2VcclxuICB9XHJcblxyXG4gIGlmIChyZXF1ZXN0LmFjdGlvbiA9PT0gXCJmZXRjaFVzZXJDb250ZXN0SGlzdG9yeVwiKSB7XHJcbiAgICBoYW5kbGVGZXRjaFVzZXJDb250ZXN0SGlzdG9yeShyZXF1ZXN0LnVzZXJuYW1lKVxyXG4gICAgICAudGhlbigoZGF0YSkgPT4gc2VuZFJlc3BvbnNlKHsgZGF0YSB9KSlcclxuICAgICAgLmNhdGNoKChlcnIpID0+IHtcclxuICAgICAgICBMb2dnZXIuZXJyb3IoTE9HX0NUWCwgXCJIaXN0b3J5IGZldGNoIGZhaWxlZFwiLCB7IGVycm9yOiBlcnIubWVzc2FnZSB9KTtcclxuICAgICAgICBzZW5kUmVzcG9uc2UoeyBkYXRhOiBudWxsLCBlcnJvcjogZXJyLm1lc3NhZ2UgfSk7XHJcbiAgICAgIH0pO1xyXG4gICAgcmV0dXJuIHRydWU7XHJcbiAgfVxyXG59KTtcclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZUZldGNoVXNlckNvbnRlc3RIaXN0b3J5KHVzZXJuYW1lKSB7XHJcbiAgY29uc3QgeyBkYXRhIH0gPSBhd2FpdCBTdG9yYWdlLmdldEhpc3RvcnkodXNlcm5hbWUpO1xyXG4gIHJldHVybiBkYXRhO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVGZXRjaFByZWRpY3Rpb25zKHVzZXJuYW1lcykge1xyXG4gIGNvbnN0IHJlc3VsdHMgPSB7fTtcclxuICBjb25zdCB1c2Vyc1RvRmV0Y2ggPSBbXTtcclxuXHJcbiAgZm9yIChjb25zdCB1c2VybmFtZSBvZiB1c2VybmFtZXMpIHtcclxuICAgIGlmIChwcmVkaWN0aW9uQ2FjaGUuaGFzKHVzZXJuYW1lKSkge1xyXG4gICAgICByZXN1bHRzW3VzZXJuYW1lXSA9IHByZWRpY3Rpb25DYWNoZS5nZXQodXNlcm5hbWUpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgdXNlcnNUb0ZldGNoLnB1c2godXNlcm5hbWUpO1xyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgaWYgKHVzZXJzVG9GZXRjaC5sZW5ndGggPT09IDApIHtcclxuICAgIHJldHVybiByZXN1bHRzO1xyXG4gIH1cclxuXHJcbiAgdHJ5IHtcclxuICAgIC8vIEZvciBub3csIGdlbmVyYXRlIG1vY2sgZGF0YSB0byBkZW1vbnN0cmF0ZSBmdW5jdGlvbmFsaXR5IHdpdGhvdXQgYSBsaXZlIGJhY2tlbmRcclxuICAgIGZvciAoY29uc3QgdXNlcm5hbWUgb2YgdXNlcnNUb0ZldGNoKSB7XHJcbiAgICAgIGNvbnN0IG1vY2tEZWx0YSA9IE1hdGgucmFuZG9tKCkgKiAxMDAgLSA1MDtcclxuICAgICAgY29uc3QgZGF0YSA9IHtcclxuICAgICAgICBkZWx0YTogbW9ja0RlbHRhLFxyXG4gICAgICAgIG5ld1JhdGluZzogMTgwMCArIG1vY2tEZWx0YSxcclxuICAgICAgfTtcclxuICAgICAgcHJlZGljdGlvbkNhY2hlLnNldCh1c2VybmFtZSwgZGF0YSk7XHJcbiAgICAgIHJlc3VsdHNbdXNlcm5hbWVdID0gZGF0YTtcclxuICAgIH1cclxuICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgTG9nZ2VyLndhcm4oTE9HX0NUWCwgXCJGYWlsZWQgdG8gZmV0Y2ggZnJvbSBiYWNrZW5kLCB1c2luZyBtb2NrIGRhdGFcIiwge1xyXG4gICAgICBlcnJvcjogZXJyb3IubWVzc2FnZSxcclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgcmV0dXJuIHJlc3VsdHM7XHJcbn1cclxuIl0sCiAgIm1hcHBpbmdzIjogIjs7QUFPTyxNQUFNLGNBQWM7QUFBQTtBQUFBLElBRXpCLG9CQUFvQjtBQUFBO0FBQUEsSUFFcEIsaUJBQWlCO0FBQUE7QUFBQSxJQUVqQixlQUFlO0FBQUE7QUFBQSxJQUVmLGdCQUFnQjtBQUFBLEVBQ2xCO0FBUU8sV0FBUyxjQUFjLE1BQU0sVUFBVSxDQUFDLEdBQUc7QUFDaEQsV0FBTyxFQUFFLE1BQU0sU0FBUyxXQUFXLEtBQUssSUFBSSxFQUFFO0FBQUEsRUFDaEQ7OztBQ2xCQSxNQUFNLGVBQWUsS0FBSyxLQUFLLEtBQUs7QUFHcEMsTUFBTSxxQkFBcUIsS0FBSyxLQUFLO0FBR3JDLE1BQU0saUJBQWlCLElBQUks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
