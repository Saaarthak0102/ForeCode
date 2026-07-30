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
  var API_URL = "https://lc-rating-predictor-production.up.railway.app/api/v1";
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL3NjcmlwdHMvbGliL21lc3NhZ2VUeXBlcy5qcyIsICIuLi8uLi9zcmMvc2NyaXB0cy9saWIvc3RvcmFnZS5qcyIsICIuLi8uLi9zcmMvc2NyaXB0cy9saWIvZXJyb3JzLmpzIiwgIi4uLy4uL3NyYy9zY3JpcHRzL2xpYi9sb2dnZXIuanMiLCAiLi4vLi4vc3JjL3NjcmlwdHMvYmFja2dyb3VuZC5qcyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBUeXBlZCBicm9hZGNhc3QgbWVzc2FnZSBjb25zdGFudHMgYW5kIGZhY3RvcnkuXG4gKlxuICogQWxsIGludGVyLWNvbXBvbmVudCBtZXNzYWdpbmcgKGJhY2tncm91bmQgXHUyMTk0IHBvcHVwIFx1MjE5NCBjb250ZW50IHNjcmlwdHMpXG4gKiB1c2VzIHRoZXNlIHR5cGVzIHRvIGVuc3VyZSBjb25zaXN0ZW5jeSBhbmQgZnV0dXJlLXByb29maW5nLlxuICovXG5cbmV4cG9ydCBjb25zdCBNZXNzYWdlVHlwZSA9IHtcbiAgLyoqIFByZWRpY3Rpb24gZGF0YSB3YXMgdXBkYXRlZCBvciBuZXdseSBhdmFpbGFibGUgKi9cbiAgUFJFRElDVElPTl9VUERBVEVEOiBcIlBSRURJQ1RJT05fVVBEQVRFRFwiLFxuICAvKiogQ29udGVzdCBoaXN0b3J5IHdhcyByZWZyZXNoZWQgb3IgbW9kaWZpZWQgKi9cbiAgSElTVE9SWV9VUERBVEVEOiBcIkhJU1RPUllfVVBEQVRFRFwiLFxuICAvKiogVXNlciBsb2dpbiBzdGF0ZSBjaGFuZ2VkIChsb2dnZWQgaW4gLyBvdXQgLyBkaWZmZXJlbnQgdXNlcikgKi9cbiAgTE9HSU5fQ0hBTkdFRDogXCJMT0dJTl9DSEFOR0VEXCIsXG4gIC8qKiBBbiBlcnJvciBvY2N1cnJlZCB0aGF0IHRoZSBVSSBzaG91bGQgZGlzcGxheSAqL1xuICBFUlJPUl9PQ0NVUlJFRDogXCJFUlJPUl9PQ0NVUlJFRFwiLFxufTtcblxuLyoqXG4gKiBDcmVhdGUgYSB0eXBlZCBtZXNzYWdlIGVudmVsb3BlLlxuICogQHBhcmFtIHtzdHJpbmd9IHR5cGUgLSBPbmUgb2YgTWVzc2FnZVR5cGUgdmFsdWVzLlxuICogQHBhcmFtIHtvYmplY3R9IFtwYXlsb2FkPXt9XSAtIEFyYml0cmFyeSBwYXlsb2FkIGRhdGEuXG4gKiBAcmV0dXJucyB7eyB0eXBlOiBzdHJpbmcsIHBheWxvYWQ6IG9iamVjdCwgdGltZXN0YW1wOiBudW1iZXIgfX1cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZU1lc3NhZ2UodHlwZSwgcGF5bG9hZCA9IHt9KSB7XG4gIHJldHVybiB7IHR5cGUsIHBheWxvYWQsIHRpbWVzdGFtcDogRGF0ZS5ub3coKSB9O1xufVxuIiwgIi8qKlxuICogQ2VudHJhbCBDaHJvbWUgU3RvcmFnZSBNYW5hZ2VyLlxuICpcbiAqIFdyYXBzIGFsbCBjaHJvbWUuc3RvcmFnZS5sb2NhbCBvcGVyYXRpb25zIGJlaGluZCBhIGNsZWFuIEFQSS5cbiAqIEhhbmRsZXMgY2FjaGUgZXhwaXJhdGlvbiAoU3VnZ2VzdGlvbiAxKSBhbmQgcHJlZGljdGlvbiBiYWNrb2ZmIHN0YXRlIChTdWdnZXN0aW9uIDIpLlxuICovXG5cbi8qKiBDYWNoZSBUVEw6IDI0IGhvdXJzIGluIG1pbGxpc2Vjb25kcyAqL1xuY29uc3QgQ0FDSEVfVFRMX01TID0gMjQgKiA2MCAqIDYwICogMTAwMDtcblxuLyoqIEluaXRpYWwgYmFja29mZiBpbnRlcnZhbDogMjAgbWludXRlcyBpbiBtaWxsaXNlY29uZHMgKi9cbmNvbnN0IElOSVRJQUxfQkFDS09GRl9NUyA9IDIwICogNjAgKiAxMDAwO1xuXG4vKiogTWF4aW11bSBiYWNrb2ZmIGludGVydmFsOiA2IGhvdXJzIGluIG1pbGxpc2Vjb25kcyAqL1xuY29uc3QgTUFYX0JBQ0tPRkZfTVMgPSA2ICogNjAgKiA2MCAqIDEwMDA7XG5cbmV4cG9ydCBjb25zdCBTdG9yYWdlID0ge1xuICAvLyBcdTI1MDBcdTI1MDAgSGlzdG9yeSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICAvKipcbiAgICogR2V0IGNvbnRlc3QgaGlzdG9yeSBmb3IgYSB1c2VyLCBjaGVja2luZyBjYWNoZSBmcmVzaG5lc3MuXG4gICAqIEBwYXJhbSB7c3RyaW5nfSB1c2VybmFtZVxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTx7IGRhdGE6IEFycmF5LCB1cGRhdGVkQXQ6IG51bWJlciwgaXNTdGFsZTogYm9vbGVhbiB9Pn1cbiAgICovXG4gIGFzeW5jIGdldEhpc3RvcnkodXNlcm5hbWUpIHtcbiAgICBjb25zdCBrZXkgPSBgaGlzdG9yeV8ke3VzZXJuYW1lfWA7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoW2tleV0sIChyZXN1bHQpID0+IHtcbiAgICAgICAgY29uc3QgZW50cnkgPSByZXN1bHRba2V5XTtcbiAgICAgICAgaWYgKCFlbnRyeSB8fCAhZW50cnkudXBkYXRlZEF0KSB7XG4gICAgICAgICAgcmVzb2x2ZSh7IGRhdGE6IFtdLCB1cGRhdGVkQXQ6IDAsIGlzU3RhbGU6IHRydWUgfSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGlzU3RhbGUgPSBEYXRlLm5vdygpIC0gZW50cnkudXBkYXRlZEF0ID4gQ0FDSEVfVFRMX01TO1xuICAgICAgICByZXNvbHZlKHsgZGF0YTogZW50cnkuZGF0YSB8fCBbXSwgdXBkYXRlZEF0OiBlbnRyeS51cGRhdGVkQXQsIGlzU3RhbGUgfSk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSxcblxuICAvKipcbiAgICogU2F2ZSBjb250ZXN0IGhpc3Rvcnkgd2l0aCBhIGZyZXNoIHRpbWVzdGFtcC5cbiAgICogQHBhcmFtIHtzdHJpbmd9IHVzZXJuYW1lXG4gICAqIEBwYXJhbSB7QXJyYXl9IGRhdGFcbiAgICogQHJldHVybnMge1Byb21pc2U8dm9pZD59XG4gICAqL1xuICBhc3luYyBzYXZlSGlzdG9yeSh1c2VybmFtZSwgZGF0YSkge1xuICAgIGNvbnN0IGtleSA9IGBoaXN0b3J5XyR7dXNlcm5hbWV9YDtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICAgIGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldChcbiAgICAgICAgeyBba2V5XTogeyBkYXRhLCB1cGRhdGVkQXQ6IERhdGUubm93KCkgfSB9LFxuICAgICAgICByZXNvbHZlXG4gICAgICApO1xuICAgIH0pO1xuICB9LFxuXG4gIC8qKlxuICAgKiBDaGVjayBpZiBhIGhpc3RvcnkgY2FjaGUgZW50cnkgaXMgc3RhbGUgKD4yNGgpLlxuICAgKiBAcGFyYW0ge3sgdXBkYXRlZEF0OiBudW1iZXIgfX0gZW50cnlcbiAgICogQHJldHVybnMge2Jvb2xlYW59XG4gICAqL1xuICBpc0hpc3RvcnlTdGFsZShlbnRyeSkge1xuICAgIGlmICghZW50cnkgfHwgIWVudHJ5LnVwZGF0ZWRBdCkgcmV0dXJuIHRydWU7XG4gICAgcmV0dXJuIERhdGUubm93KCkgLSBlbnRyeS51cGRhdGVkQXQgPiBDQUNIRV9UVExfTVM7XG4gIH0sXG5cbiAgLy8gXHUyNTAwXHUyNTAwIFByZWRpY3Rpb24gU3RhdHVzIChFeHBvbmVudGlhbCBCYWNrb2ZmKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICAvKipcbiAgICogR2V0IHRoZSBjdXJyZW50IHByZWRpY3Rpb24gcG9sbGluZyBzdGF0dXMuXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPG9iamVjdHxudWxsPn1cbiAgICovXG4gIGFzeW5jIGdldFByZWRpY3Rpb25TdGF0dXMoKSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoW1wicHJlZGljdGlvbl9zdGF0dXNcIl0sIChyZXN1bHQpID0+IHtcbiAgICAgICAgcmVzb2x2ZShyZXN1bHQucHJlZGljdGlvbl9zdGF0dXMgfHwgbnVsbCk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSxcblxuICAvKipcbiAgICogU2F2ZSBwcmVkaWN0aW9uIHBvbGxpbmcgc3RhdHVzIHdpdGggYmFja29mZiBzdGF0ZS5cbiAgICogQHBhcmFtIHtvYmplY3R9IHN0YXR1cyAtIHsgY29udGVzdFNsdWcsIHN0YXR1cywgbGFzdENoZWNrZWQsIHJldHJ5Q291bnQsIG5leHRSZXRyeUF0IH1cbiAgICogQHJldHVybnMge1Byb21pc2U8dm9pZD59XG4gICAqL1xuICBhc3luYyBzYXZlUHJlZGljdGlvblN0YXR1cyhzdGF0dXMpIHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICAgIGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IHByZWRpY3Rpb25fc3RhdHVzOiBzdGF0dXMgfSwgcmVzb2x2ZSk7XG4gICAgfSk7XG4gIH0sXG5cbiAgLyoqXG4gICAqIENsZWFyIHByZWRpY3Rpb24gc3RhdHVzIChwcmVkaWN0aW9uIHJlc29sdmVkIG9yIGNvbmZpcm1lZCkuXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPHZvaWQ+fVxuICAgKi9cbiAgYXN5bmMgY2xlYXJQcmVkaWN0aW9uU3RhdHVzKCkge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgICAgY2hyb21lLnN0b3JhZ2UubG9jYWwucmVtb3ZlKFwicHJlZGljdGlvbl9zdGF0dXNcIiwgcmVzb2x2ZSk7XG4gICAgfSk7XG4gIH0sXG5cbiAgLyoqXG4gICAqIENhbGN1bGF0ZSB0aGUgbmV4dCByZXRyeSB0aW1lc3RhbXAgdXNpbmcgZXhwb25lbnRpYWwgYmFja29mZi5cbiAgICogU2NoZWR1bGU6IDIwbSBcdTIxOTIgNDBtIFx1MjE5MiA4MG0gXHUyMTkyIDE2MG0gXHUyMTkyIDMyMG0gXHUyMTkyIDM2MG0gKGNhcClcbiAgICogQHBhcmFtIHtudW1iZXJ9IHJldHJ5Q291bnQgLSBDdXJyZW50IHJldHJ5IGNvdW50ICgwLWluZGV4ZWQpLlxuICAgKiBAcmV0dXJucyB7bnVtYmVyfSBUaW1lc3RhbXAgKG1zKSBmb3IgbmV4dCBhbGxvd2VkIHJldHJ5LlxuICAgKi9cbiAgY2FsY3VsYXRlTmV4dFJldHJ5KHJldHJ5Q291bnQpIHtcbiAgICBjb25zdCBkZWxheU1zID0gTWF0aC5taW4oXG4gICAgICBJTklUSUFMX0JBQ0tPRkZfTVMgKiBNYXRoLnBvdygyLCByZXRyeUNvdW50KSxcbiAgICAgIE1BWF9CQUNLT0ZGX01TXG4gICAgKTtcbiAgICByZXR1cm4gRGF0ZS5ub3coKSArIGRlbGF5TXM7XG4gIH0sXG5cbiAgLy8gXHUyNTAwXHUyNTAwIFVzZXJuYW1lIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIC8qKlxuICAgKiBHZXQgdGhlIHN0b3JlZCBMZWV0Q29kZSB1c2VybmFtZS5cbiAgICogQHJldHVybnMge1Byb21pc2U8c3RyaW5nfG51bGw+fVxuICAgKi9cbiAgYXN5bmMgZ2V0VXNlcm5hbWUoKSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoW1wibGNfdXNlcm5hbWVcIl0sIChyZXN1bHQpID0+IHtcbiAgICAgICAgcmVzb2x2ZShyZXN1bHQubGNfdXNlcm5hbWUgfHwgbnVsbCk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSxcblxuICAvKipcbiAgICogU2F2ZSB0aGUgTGVldENvZGUgdXNlcm5hbWUuXG4gICAqIEBwYXJhbSB7c3RyaW5nfSB1c2VybmFtZVxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTx2b2lkPn1cbiAgICovXG4gIGFzeW5jIHNldFVzZXJuYW1lKHVzZXJuYW1lKSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBsY191c2VybmFtZTogdXNlcm5hbWUgfSwgcmVzb2x2ZSk7XG4gICAgfSk7XG4gIH0sXG5cbiAgLy8gXHUyNTAwXHUyNTAwIExhc3QgRXJyb3IgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgLyoqXG4gICAqIFNhdmUgdGhlIGxhc3QgZXJyb3Igc3RhdGUgZm9yIFVJIGRpc3BsYXkuXG4gICAqIEBwYXJhbSB7b2JqZWN0fG51bGx9IGVycm9yIC0gRXJyb3Igb2JqZWN0IGZyb20gY3JlYXRlRXJyb3IoKSwgb3IgbnVsbCB0byBjbGVhci5cbiAgICogQHJldHVybnMge1Byb21pc2U8dm9pZD59XG4gICAqL1xuICBhc3luYyBzZXRMYXN0RXJyb3IoZXJyb3IpIHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICAgIGlmIChlcnJvciA9PT0gbnVsbCkge1xuICAgICAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5yZW1vdmUoXCJsYXN0X2Vycm9yXCIsIHJlc29sdmUpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgbGFzdF9lcnJvcjogZXJyb3IgfSwgcmVzb2x2ZSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0sXG5cbiAgLyoqXG4gICAqIEdldCB0aGUgbGFzdCBzdG9yZWQgZXJyb3IuXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPG9iamVjdHxudWxsPn1cbiAgICovXG4gIGFzeW5jIGdldExhc3RFcnJvcigpIHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICAgIGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChbXCJsYXN0X2Vycm9yXCJdLCAocmVzdWx0KSA9PiB7XG4gICAgICAgIHJlc29sdmUocmVzdWx0Lmxhc3RfZXJyb3IgfHwgbnVsbCk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSxcbn07XG4iLCAiLyoqXG4gKiBTdHJ1Y3R1cmVkIGVycm9yIGNvZGVzIGZvciB0aGUgZXh0ZW5zaW9uLlxuICpcbiAqIFRoZXNlIGNvZGVzIGFsbG93IHRoZSBwb3B1cCBhbmQgY29udGVudCBzY3JpcHRzIHRvIGRpc3BsYXlcbiAqIG1lYW5pbmdmdWwsIHVzZXItZnJpZW5kbHkgc3RhdHVzIG1lc3NhZ2VzIGluc3RlYWQgb2YgZ2VuZXJpYyBlcnJvcnMuXG4gKi9cblxuZXhwb3J0IGNvbnN0IEVycm9yQ29kZSA9IHtcbiAgLyoqIE5ldHdvcmsgcmVxdWVzdCBmYWlsZWQgKG5vIGNvbm5lY3Rpdml0eSwgRE5TLCB0aW1lb3V0KSAqL1xuICBORVRXT1JLX0VSUk9SOiBcIk5FVFdPUktfRVJST1JcIixcbiAgLyoqIExlZXRDb2RlIEdyYXBoUUwgQVBJIHJldHVybmVkIGFuIGVycm9yIG9yIHVuZXhwZWN0ZWQgc2hhcGUgKi9cbiAgR1JBUEhRTF9GQUlMRUQ6IFwiR1JBUEhRTF9GQUlMRURcIixcbiAgLyoqIFByZWRpY3Rpb24gaXMgbm90IHlldCBhdmFpbGFibGUgXHUyMDE0IHN0aWxsIGJlaW5nIGNhbGN1bGF0ZWQgKi9cbiAgUFJFRElDVElPTl9QRU5ESU5HOiBcIlBSRURJQ1RJT05fUEVORElOR1wiLFxuICAvKiogVGhlIHJlcXVlc3RlZCB1c2VyIHdhcyBub3QgZm91bmQgb24gTGVldENvZGUgKi9cbiAgVVNFUl9OT1RfRk9VTkQ6IFwiVVNFUl9OT1RfRk9VTkRcIixcbiAgLyoqIFRvbyBtYW55IHJlcXVlc3RzIFx1MjAxNCBiZWluZyByYXRlIGxpbWl0ZWQgKi9cbiAgUkFURV9MSU1JVEVEOiBcIlJBVEVfTElNSVRFRFwiLFxuICAvKiogQ2F0Y2gtYWxsIGZvciB1bmV4cGVjdGVkIGVycm9ycyAqL1xuICBVTktOT1dOX0VSUk9SOiBcIlVOS05PV05fRVJST1JcIixcbn07XG5cbi8qKlxuICogVXNlci1mcmllbmRseSBlcnJvciBtZXNzYWdlcyBmb3IgZWFjaCBjb2RlLlxuICovXG5jb25zdCBFcnJvck1lc3NhZ2VzID0ge1xuICBbRXJyb3JDb2RlLk5FVFdPUktfRVJST1JdOiBcIk5ldHdvcmsgZXJyb3IgXHUyMDE0IHdpbGwgcmV0cnkgYXV0b21hdGljYWxseS5cIixcbiAgW0Vycm9yQ29kZS5HUkFQSFFMX0ZBSUxFRF06IFwiRmFpbGVkIHRvIHJlYWNoIExlZXRDb2RlIFx1MjAxNCB3aWxsIHJldHJ5LlwiLFxuICBbRXJyb3JDb2RlLlBSRURJQ1RJT05fUEVORElOR106IFwiUHJlZGljdGlvbiBpcyBzdGlsbCBiZWluZyBjYWxjdWxhdGVkXHUyMDI2XCIsXG4gIFtFcnJvckNvZGUuVVNFUl9OT1RfRk9VTkRdOiBcIkxlZXRDb2RlIHVzZXIgbm90IGZvdW5kLlwiLFxuICBbRXJyb3JDb2RlLlJBVEVfTElNSVRFRF06IFwiVG9vIG1hbnkgcmVxdWVzdHMgXHUyMDE0IHNsb3dpbmcgZG93bi5cIixcbiAgW0Vycm9yQ29kZS5VTktOT1dOX0VSUk9SXTogXCJTb21ldGhpbmcgd2VudCB3cm9uZy5cIixcbn07XG5cbi8qKlxuICogQ3JlYXRlIGEgc3RydWN0dXJlZCBlcnJvciBvYmplY3QuXG4gKiBAcGFyYW0ge3N0cmluZ30gY29kZSAtIE9uZSBvZiBFcnJvckNvZGUgdmFsdWVzLlxuICogQHBhcmFtIHtzdHJpbmd9IFtkZXRhaWxdIC0gT3B0aW9uYWwgdGVjaG5pY2FsIGRldGFpbCBmb3IgbG9nZ2luZy5cbiAqIEByZXR1cm5zIHt7IGNvZGU6IHN0cmluZywgbWVzc2FnZTogc3RyaW5nLCBkZXRhaWw/OiBzdHJpbmcsIHRpbWVzdGFtcDogbnVtYmVyIH19XG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVFcnJvcihjb2RlLCBkZXRhaWwpIHtcbiAgcmV0dXJuIHtcbiAgICBjb2RlLFxuICAgIG1lc3NhZ2U6IEVycm9yTWVzc2FnZXNbY29kZV0gfHwgRXJyb3JNZXNzYWdlc1tFcnJvckNvZGUuVU5LTk9XTl9FUlJPUl0sXG4gICAgLi4uKGRldGFpbCA/IHsgZGV0YWlsIH0gOiB7fSksXG4gICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICB9O1xufVxuIiwgIi8qKlxuICogU3RydWN0dXJlZCBsb2dnZXIgZm9yIHRoZSBDaHJvbWUgZXh0ZW5zaW9uLlxuICpcbiAqIFJlcGxhY2VzIHJhdyBjb25zb2xlLmxvZy9lcnJvci93YXJuIGNhbGxzIHdpdGggc3RydWN0dXJlZCBvdXRwdXRcbiAqIHRoYXQgaW5jbHVkZXMgdGltZXN0YW1wcywgY29udGV4dCBtb2R1bGVzLCBhbmQgcmVsZXZhbnQgZGF0YS5cbiAqL1xuXG5leHBvcnQgY29uc3QgTG9nZ2VyID0ge1xuICAvKipcbiAgICogQHBhcmFtIHtzdHJpbmd9IGNvbnRleHQgLSBNb2R1bGUgbmFtZSAoZS5nLiwgXCJCYWNrZ3JvdW5kXCIsIFwiUG9wdXBcIikuXG4gICAqIEBwYXJhbSB7c3RyaW5nfSBtZXNzYWdlIC0gTG9nIG1lc3NhZ2UuXG4gICAqIEBwYXJhbSB7b2JqZWN0fSBbZGF0YV0gLSBPcHRpb25hbCBzdHJ1Y3R1cmVkIGRhdGEuXG4gICAqL1xuICBpbmZvKGNvbnRleHQsIG1lc3NhZ2UsIGRhdGEpIHtcbiAgICBjb25zdCBlbnRyeSA9IExvZ2dlci5fZm9ybWF0KFwiSU5GT1wiLCBjb250ZXh0LCBtZXNzYWdlLCBkYXRhKTtcbiAgICBjb25zb2xlLmxvZyhlbnRyeSk7XG4gIH0sXG5cbiAgd2Fybihjb250ZXh0LCBtZXNzYWdlLCBkYXRhKSB7XG4gICAgY29uc3QgZW50cnkgPSBMb2dnZXIuX2Zvcm1hdChcIldBUk5cIiwgY29udGV4dCwgbWVzc2FnZSwgZGF0YSk7XG4gICAgY29uc29sZS53YXJuKGVudHJ5KTtcbiAgfSxcblxuICBlcnJvcihjb250ZXh0LCBtZXNzYWdlLCBkYXRhKSB7XG4gICAgY29uc3QgZW50cnkgPSBMb2dnZXIuX2Zvcm1hdChcIkVSUk9SXCIsIGNvbnRleHQsIG1lc3NhZ2UsIGRhdGEpO1xuICAgIGNvbnNvbGUuZXJyb3IoZW50cnkpO1xuICB9LFxuXG4gIC8qKlxuICAgKiBGb3JtYXQgYSBzdHJ1Y3R1cmVkIGxvZyBlbnRyeS5cbiAgICogQHByaXZhdGVcbiAgICovXG4gIF9mb3JtYXQobGV2ZWwsIGNvbnRleHQsIG1lc3NhZ2UsIGRhdGEpIHtcbiAgICBjb25zdCB0aW1lc3RhbXAgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG4gICAgY29uc3QgYmFzZSA9IGBbJHt0aW1lc3RhbXB9XSBbJHtsZXZlbH1dIFske2NvbnRleHR9XSAke21lc3NhZ2V9YDtcbiAgICBpZiAoZGF0YSAhPT0gdW5kZWZpbmVkICYmIGRhdGEgIT09IG51bGwpIHtcbiAgICAgIC8vIEtlZXAgaXQgcmVhZGFibGUgaW4gdGhlIGNvbnNvbGVcbiAgICAgIHJldHVybiBgJHtiYXNlfSB8ICR7SlNPTi5zdHJpbmdpZnkoZGF0YSl9YDtcbiAgICB9XG4gICAgcmV0dXJuIGJhc2U7XG4gIH0sXG59O1xuIiwgIi8qKlxuICogQmFja2dyb3VuZCBTZXJ2aWNlIFdvcmtlclxuICpcbiAqIFJlc3BvbnNpYmlsaXRpZXM6XG4gKiAtIFVzZXIgZGV0ZWN0aW9uIChMZWV0Q29kZSBHcmFwaFFMKVxuICogLSBBbGFybS1iYXNlZCBwb2xsaW5nIHdpdGggZXhwb25lbnRpYWwgYmFja29mZlxuICogLSBDaHJvbWUgU3RvcmFnZSBtYW5hZ2VtZW50ICh2aWEgU3RvcmFnZSBoZWxwZXIpXG4gKiAtIEFQSSBjb21tdW5pY2F0aW9uIHdpdGggdGhlIGJhY2tlbmQgcHJveHlcbiAqIC0gQnJvYWRjYXN0aW5nIHR5cGVkIG1lc3NhZ2VzIHRvIHBvcHVwICYgY29udGVudCBzY3JpcHRzXG4gKi9cblxuLy8gXHUyNTAwXHUyNTAwIFNoYXJlZCBtb2R1bGVzIChpbmxpbmVkIGJ5IGJ1aWxkLmNqcykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5pbXBvcnQgeyBNZXNzYWdlVHlwZSwgY3JlYXRlTWVzc2FnZSB9IGZyb20gXCIuL2xpYi9tZXNzYWdlVHlwZXMuanNcIjtcbmltcG9ydCB7IFN0b3JhZ2UgfSBmcm9tIFwiLi9saWIvc3RvcmFnZS5qc1wiO1xuaW1wb3J0IHsgRXJyb3JDb2RlLCBjcmVhdGVFcnJvciB9IGZyb20gXCIuL2xpYi9lcnJvcnMuanNcIjtcbmltcG9ydCB7IExvZ2dlciB9IGZyb20gXCIuL2xpYi9sb2dnZXIuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwIENvbnN0YW50cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY29uc3QgQVBJX1VSTCA9IFwiaHR0cHM6Ly9sYy1yYXRpbmctcHJlZGljdG9yLXByb2R1Y3Rpb24udXAucmFpbHdheS5hcHAvYXBpL3YxXCI7IC8vIENoYW5nZSB0byB5b3VyIGhvc3RlZCBiYWNrZW5kIFVSTFxuXG5jb25zdCBMT0dfQ1RYID0gXCJCYWNrZ3JvdW5kXCI7XG5cbi8vIFNpbXBsZSBpbi1tZW1vcnkgY2FjaGUgZm9yIGxlYWRlcmJvYXJkIHByZWRpY3Rpb24gbG9va3Vwc1xuY29uc3QgcHJlZGljdGlvbkNhY2hlID0gbmV3IE1hcCgpO1xuXG4vLyBcdTI1MDBcdTI1MDAgVXNlcm5hbWUgRGV0ZWN0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5hc3luYyBmdW5jdGlvbiBnZXRMZWV0Q29kZVVzZXJuYW1lKCkge1xuICB0cnkge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKFwiaHR0cHM6Ly9sZWV0Y29kZS5jb20vZ3JhcGhxbFwiLCB7XG4gICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgICAgY3JlZGVudGlhbHM6IFwiaW5jbHVkZVwiLFxuICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBxdWVyeTogXCJxdWVyeSBnbG9iYWxEYXRhIHsgdXNlclN0YXR1cyB7IHVzZXJuYW1lIH0gfVwiLFxuICAgICAgfSksXG4gICAgfSk7XG4gICAgY29uc3QgZGF0YSA9IGF3YWl0IHJlcy5qc29uKCk7XG4gICAgcmV0dXJuIGRhdGE/LmRhdGE/LnVzZXJTdGF0dXM/LnVzZXJuYW1lIHx8IG51bGw7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBMb2dnZXIuZXJyb3IoTE9HX0NUWCwgXCJGYWlsZWQgdG8gZGV0ZWN0IExlZXRDb2RlIHVzZXJuYW1lXCIsIHsgZXJyb3I6IGUubWVzc2FnZSB9KTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDAgSGlzdG9yeSBNYW5hZ2VtZW50IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIEZldGNoIGxhdGVzdCBhdHRlbmRlZCBjb250ZXN0IGZyb20gTGVldENvZGUuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGZldGNoTGF0ZXN0QXR0ZW5kZWRDb250ZXN0KCkge1xuICB0cnkge1xuICAgIGNvbnN0IGdxbFJlcyA9IGF3YWl0IGZldGNoKFwiaHR0cHM6Ly9sZWV0Y29kZS5jb20vZ3JhcGhxbFwiLCB7XG4gICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgICAgY3JlZGVudGlhbHM6IFwiaW5jbHVkZVwiLFxuICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBxdWVyeTogYHF1ZXJ5IGNvbnRlc3RWMk15Q29udGVzdHMoJHNraXA6IEludCEsICRsaW1pdDogSW50ISwgJGlzVmlydHVhbDogQm9vbGVhbikge1xuICAgICAgICAgIGNvbnRlc3RWMk15Q29udGVzdHMoc2tpcDogJHNraXAsIGxpbWl0OiAkbGltaXQsIGlzVmlydHVhbDogJGlzVmlydHVhbCkge1xuICAgICAgICAgICAgY29udGVzdHMge1xuICAgICAgICAgICAgICB0aXRsZVNsdWdcbiAgICAgICAgICAgICAgdGl0bGVcbiAgICAgICAgICAgICAgc3RhcnRUaW1lXG4gICAgICAgICAgICAgIGZpbmlzaFRpbWVcbiAgICAgICAgICAgICAgc29sdmVkXG4gICAgICAgICAgICAgIHJhbmtpbmdcbiAgICAgICAgICAgICAgdG90YWxRdWVzdGlvbnNcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1gLFxuICAgICAgICB2YXJpYWJsZXM6IHsgc2tpcDogMCwgbGltaXQ6IDEsIGlzVmlydHVhbDogZmFsc2UgfSxcbiAgICAgIH0pLFxuICAgIH0pO1xuXG4gICAgaWYgKGdxbFJlcy5vaykge1xuICAgICAgY29uc3QgZ3FsRGF0YSA9IGF3YWl0IGdxbFJlcy5qc29uKCk7XG4gICAgICBjb25zdCBjb250ZXN0cyA9IGdxbERhdGE/LmRhdGE/LmNvbnRlc3RWMk15Q29udGVzdHM/LmNvbnRlc3RzIHx8IFtdO1xuICAgICAgaWYgKGNvbnRlc3RzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgcmV0dXJuIGNvbnRlc3RzWzBdO1xuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgTG9nZ2VyLndhcm4oTE9HX0NUWCwgXCJGYWlsZWQgdG8gZmV0Y2ggbGF0ZXN0IGF0dGVuZGVkIGNvbnRlc3RcIiwgeyBlcnJvcjogZXJyLm1lc3NhZ2UgfSk7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKlxuICogRmV0Y2ggZnJlc2ggaGlzdG9yeSBmcm9tIHRoZSBiYWNrZW5kIGFuZCBzYXZlIHRvIHN0b3JhZ2UuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlZnJlc2hIaXN0b3J5KHVzZXJuYW1lKSB7XG4gIExvZ2dlci5pbmZvKExPR19DVFgsIFwiUmVmcmVzaGluZyBoaXN0b3J5IGZyb20gYmFja2VuZFwiLCB7IHVzZXJuYW1lIH0pO1xuICB0cnkge1xuICAgIGNvbnN0IGxhdGVzdENvbnRlc3QgPSBhd2FpdCBmZXRjaExhdGVzdEF0dGVuZGVkQ29udGVzdCgpO1xuXG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYCR7QVBJX1VSTH0vdXNlci8ke3VzZXJuYW1lfS9oaXN0b3J5YCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgbGF0ZXN0X2F0dGVuZGVkX2NvbnRlc3Q6IGxhdGVzdENvbnRlc3RcbiAgICAgIH0pXG4gICAgfSk7XG5cbiAgICBpZiAocmVzLm9rKSB7XG4gICAgICBjb25zdCBoaXN0b3J5ID0gYXdhaXQgcmVzLmpzb24oKTtcbiAgICAgIFxuICAgICAgY29uc3QgbWFwcGVkSGlzdG9yeSA9IGhpc3RvcnkubWFwKHJlY29yZCA9PiAoe1xuICAgICAgICBuYW1lOiByZWNvcmQuY29udGVzdF90aXRsZSxcbiAgICAgICAgYWN0dWFsUmF0aW5nOiByZWNvcmQuYWN0dWFsX3JhdGluZyxcbiAgICAgICAgcHJlZGljdGVkUmF0aW5nOiByZWNvcmQucHJlZGljdGVkX3JhdGluZyB8fCBcIi1cIixcbiAgICAgICAgZGVsdGE6IHJlY29yZC5hY3R1YWxfZGVsdGEgIT09IG51bGwgJiYgcmVjb3JkLmFjdHVhbF9kZWx0YSAhPT0gdW5kZWZpbmVkIFxuICAgICAgICAgID8gcmVjb3JkLmFjdHVhbF9kZWx0YSBcbiAgICAgICAgICA6IChyZWNvcmQucHJlZGljdGVkX2RlbHRhICE9PSBudWxsICYmIHJlY29yZC5wcmVkaWN0ZWRfZGVsdGEgIT09IHVuZGVmaW5lZCA/IHJlY29yZC5wcmVkaWN0ZWRfZGVsdGEgOiBudWxsKSxcbiAgICAgICAgc3RhdHVzOiByZWNvcmQuc3RhdHVzXG4gICAgICB9KSk7XG5cbiAgICAgIGF3YWl0IFN0b3JhZ2Uuc2F2ZUhpc3RvcnkodXNlcm5hbWUsIG1hcHBlZEhpc3RvcnkpO1xuICAgICAgYXdhaXQgU3RvcmFnZS5zZXRMYXN0RXJyb3IobnVsbCk7XG4gICAgICBcbiAgICAgIGNvbnN0IHBlbmRpbmdJdGVtID0gbWFwcGVkSGlzdG9yeS5maW5kKHIgPT4gci5zdGF0dXMgPT09ICdwcmVkaWN0aW9uX3BlbmRpbmcnKTtcbiAgICAgIGlmIChwZW5kaW5nSXRlbSkge1xuICAgICAgICBhd2FpdCBTdG9yYWdlLnNldExhc3RFcnJvcihjcmVhdGVFcnJvcihFcnJvckNvZGUuUFJFRElDVElPTl9QRU5ESU5HKSk7XG4gICAgICB9XG5cbiAgICAgIExvZ2dlci5pbmZvKExPR19DVFgsIFwiSGlzdG9yeSByZWZyZXNoZWQgc3VjY2Vzc2Z1bGx5XCIsIHtcbiAgICAgICAgdXNlcm5hbWUsXG4gICAgICAgIGNvdW50OiBtYXBwZWRIaXN0b3J5Lmxlbmd0aCxcbiAgICAgIH0pO1xuXG4gICAgICBicm9hZGNhc3QoY3JlYXRlTWVzc2FnZShNZXNzYWdlVHlwZS5ISVNUT1JZX1VQREFURUQsIHsgdXNlcm5hbWUgfSkpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEJhY2tlbmQgcmV0dXJuZWQgJHtyZXMuc3RhdHVzfWApO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgZXJyb3IgPSBjcmVhdGVFcnJvcihFcnJvckNvZGUuTkVUV09SS19FUlJPUiwgZXJyLm1lc3NhZ2UpO1xuICAgIGF3YWl0IFN0b3JhZ2Uuc2V0TGFzdEVycm9yKGVycm9yKTtcbiAgICBMb2dnZXIuZXJyb3IoTE9HX0NUWCwgXCJGYWlsZWQgdG8gcmVmcmVzaCBoaXN0b3J5XCIsIHsgdXNlcm5hbWUsIGVycm9yOiBlcnIubWVzc2FnZSB9KTtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDAgQnJvYWRjYXN0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIEJyb2FkY2FzdCBhIHR5cGVkIG1lc3NhZ2UgdG8gcG9wdXAgYW5kIGFsbCBMZWV0Q29kZSB0YWJzLlxuICovXG5mdW5jdGlvbiBicm9hZGNhc3QobWVzc2FnZSkge1xuICAvLyBOb3RpZnkgcG9wdXAgKG1heSBub3QgYmUgb3BlbiBcdTIwMTQgdGhhdCdzIGZpbmUsIGNhdGNoIHNpbGVudGx5KVxuICBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZShtZXNzYWdlKS5jYXRjaCgoKSA9PiB7fSk7XG5cbiAgLy8gTm90aWZ5IGFjdGl2ZSBMZWV0Q29kZSB0YWJzXG4gIGNocm9tZS50YWJzLnF1ZXJ5KHsgdXJsOiBcIio6Ly9sZWV0Y29kZS5jb20vKlwiIH0sICh0YWJzKSA9PiB7XG4gICAgZm9yIChjb25zdCB0YWIgb2YgdGFicykge1xuICAgICAgY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UodGFiLmlkLCBtZXNzYWdlKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgfVxuICB9KTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwIExpZmVjeWNsZSBFdmVudHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmNocm9tZS5ydW50aW1lLm9uU3RhcnR1cC5hZGRMaXN0ZW5lcigoKSA9PiB7XG4gIExvZ2dlci5pbmZvKExPR19DVFgsIFwiRXh0ZW5zaW9uIHN0YXJ0dXAgXHUyMDE0IGNyZWF0aW5nIGFsYXJtXCIpO1xuICBjaHJvbWUuYWxhcm1zLmNyZWF0ZShcImNoZWNrUGVuZGluZ1ByZWRpY3Rpb25cIiwgeyBwZXJpb2RJbk1pbnV0ZXM6IDIwIH0pO1xufSk7XG5cbmNocm9tZS5ydW50aW1lLm9uSW5zdGFsbGVkLmFkZExpc3RlbmVyKGFzeW5jIChkZXRhaWxzKSA9PiB7XG4gIGNocm9tZS5hbGFybXMuY3JlYXRlKFwiY2hlY2tQZW5kaW5nUHJlZGljdGlvblwiLCB7IHBlcmlvZEluTWludXRlczogMjAgfSk7XG5cbiAgaWYgKGRldGFpbHMucmVhc29uID09PSBcImluc3RhbGxcIikge1xuICAgIExvZ2dlci5pbmZvKExPR19DVFgsIFwiRXh0ZW5zaW9uIGluc3RhbGxlZCBcdTIwMTQgZGV0ZWN0aW5nIHVzZXJcIik7XG4gICAgY29uc3QgdXNlcm5hbWUgPSBhd2FpdCBnZXRMZWV0Q29kZVVzZXJuYW1lKCk7XG5cbiAgICBpZiAodXNlcm5hbWUpIHtcbiAgICAgIGF3YWl0IFN0b3JhZ2Uuc2V0VXNlcm5hbWUodXNlcm5hbWUpO1xuICAgICAgTG9nZ2VyLmluZm8oTE9HX0NUWCwgXCJVc2VyIGRldGVjdGVkXCIsIHsgdXNlcm5hbWUgfSk7XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGZldGNoKGAke0FQSV9VUkx9L3VzZXIvJHt1c2VybmFtZX0vcmVnaXN0ZXJgLCB7IG1ldGhvZDogXCJQT1NUXCIgfSk7XG4gICAgICB9IGNhdGNoIChfKSB7XG4gICAgICAgIC8vIFJlZ2lzdGVyIGVuZHBvaW50IGlzIG9wdGlvbmFsOyBpZ25vcmUgZmFpbHVyZXNcbiAgICAgIH1cblxuICAgICAgYXdhaXQgcmVmcmVzaEhpc3RvcnkodXNlcm5hbWUpO1xuXG4gICAgICBicm9hZGNhc3QoY3JlYXRlTWVzc2FnZShNZXNzYWdlVHlwZS5MT0dJTl9DSEFOR0VELCB7IHVzZXJuYW1lIH0pKTtcbiAgICB9IGVsc2Uge1xuICAgICAgTG9nZ2VyLndhcm4oTE9HX0NUWCwgXCJObyBMZWV0Q29kZSB1c2VyIGRldGVjdGVkIGR1cmluZyBpbnN0YWxsXCIpO1xuICAgIH1cbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMCBBbGFybSBIYW5kbGVyIChTdWdnZXN0aW9uIDE6IENhY2hlIEV4cGlyeSArIFN1Z2dlc3Rpb24gMjogQmFja29mZikgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmNocm9tZS5hbGFybXMub25BbGFybS5hZGRMaXN0ZW5lcihhc3luYyAoYWxhcm0pID0+IHtcbiAgaWYgKGFsYXJtLm5hbWUgIT09IFwiY2hlY2tQZW5kaW5nUHJlZGljdGlvblwiKSByZXR1cm47XG5cbiAgY29uc3QgdXNlcm5hbWUgPSBhd2FpdCBTdG9yYWdlLmdldFVzZXJuYW1lKCk7XG4gIGlmICghdXNlcm5hbWUpIHJldHVybjtcblxuICBMb2dnZXIuaW5mbyhMT0dfQ1RYLCBcIkFsYXJtIGZpcmVkIFx1MjAxNCBjaGVja2luZyBwcmVkaWN0aW9uc1wiLCB7IHVzZXJuYW1lIH0pO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgY2FjaGVkSGlzdG9yeSA9IGF3YWl0IFN0b3JhZ2UuZ2V0SGlzdG9yeSh1c2VybmFtZSk7XG4gICAgaWYgKGNhY2hlZEhpc3RvcnkuaXNTdGFsZSkge1xuICAgICAgTG9nZ2VyLmluZm8oTE9HX0NUWCwgXCJIaXN0b3J5IGNhY2hlIGlzIHN0YWxlIFx1MjAxNCByZWZyZXNoaW5nXCIsIHsgdXNlcm5hbWUgfSk7XG4gICAgICBhd2FpdCByZWZyZXNoSGlzdG9yeSh1c2VybmFtZSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gQWx3YXlzIGZldGNoIGxhdGVzdCB0byBzeW5jIHBlbmRpbmcgcHJlZGljdGlvbnMgcHJvYWN0aXZlbHkgaW4gYWxhcm1cbiAgICBhd2FpdCByZWZyZXNoSGlzdG9yeSh1c2VybmFtZSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnN0IGVycm9yQ29kZSA9XG4gICAgICBlcnIubWVzc2FnZSAmJiBlcnIubWVzc2FnZS5pbmNsdWRlcyhcIk5ldHdvcmtFcnJvclwiKVxuICAgICAgICA/IEVycm9yQ29kZS5ORVRXT1JLX0VSUk9SXG4gICAgICAgIDogRXJyb3JDb2RlLlVOS05PV05fRVJST1I7XG5cbiAgICBjb25zdCBlcnJvciA9IGNyZWF0ZUVycm9yKGVycm9yQ29kZSwgZXJyLm1lc3NhZ2UpO1xuICAgIGF3YWl0IFN0b3JhZ2Uuc2V0TGFzdEVycm9yKGVycm9yKTtcbiAgICBMb2dnZXIuZXJyb3IoTE9HX0NUWCwgXCJBbGFybSBoYW5kbGVyIGZhaWxlZFwiLCB7IGVycm9yOiBlcnIubWVzc2FnZSB9KTtcblxuICAgIGJyb2FkY2FzdChjcmVhdGVNZXNzYWdlKE1lc3NhZ2VUeXBlLkVSUk9SX09DQ1VSUkVELCB7IGVycm9yIH0pKTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMCBNZXNzYWdlIEhhbmRsZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jaHJvbWUucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoKHJlcXVlc3QsIHNlbmRlciwgc2VuZFJlc3BvbnNlKSA9PiB7XG4gIGlmIChyZXF1ZXN0LmFjdGlvbiA9PT0gXCJmZXRjaFByZWRpY3Rpb25zXCIpIHtcbiAgICBoYW5kbGVGZXRjaFByZWRpY3Rpb25zKHJlcXVlc3QudXNlcm5hbWVzKVxuICAgICAgLnRoZW4oKGRhdGEpID0+IHNlbmRSZXNwb25zZSh7IGRhdGEgfSkpXG4gICAgICAuY2F0Y2goKGVycikgPT4ge1xuICAgICAgICBMb2dnZXIuZXJyb3IoTE9HX0NUWCwgXCJQcmVkaWN0aW9uIGZldGNoIGZhaWxlZFwiLCB7IGVycm9yOiBlcnIubWVzc2FnZSB9KTtcbiAgICAgICAgc2VuZFJlc3BvbnNlKHsgZGF0YTogbnVsbCwgZXJyb3I6IGVyci5tZXNzYWdlIH0pO1xuICAgICAgfSk7XG4gICAgcmV0dXJuIHRydWU7IC8vIEtlZXAgY2hhbm5lbCBvcGVuIGZvciBhc3luYyByZXNwb25zZVxuICB9XG5cbiAgaWYgKHJlcXVlc3QuYWN0aW9uID09PSBcImZldGNoVXNlckNvbnRlc3RIaXN0b3J5XCIpIHtcbiAgICBoYW5kbGVGZXRjaFVzZXJDb250ZXN0SGlzdG9yeShyZXF1ZXN0LnVzZXJuYW1lKVxuICAgICAgLnRoZW4oKGRhdGEpID0+IHNlbmRSZXNwb25zZSh7IGRhdGEgfSkpXG4gICAgICAuY2F0Y2goKGVycikgPT4ge1xuICAgICAgICBMb2dnZXIuZXJyb3IoTE9HX0NUWCwgXCJIaXN0b3J5IGZldGNoIGZhaWxlZFwiLCB7IGVycm9yOiBlcnIubWVzc2FnZSB9KTtcbiAgICAgICAgc2VuZFJlc3BvbnNlKHsgZGF0YTogbnVsbCwgZXJyb3I6IGVyci5tZXNzYWdlIH0pO1xuICAgICAgfSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn0pO1xuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVGZXRjaFVzZXJDb250ZXN0SGlzdG9yeSh1c2VybmFtZSkge1xuICBjb25zdCB7IGRhdGEgfSA9IGF3YWl0IFN0b3JhZ2UuZ2V0SGlzdG9yeSh1c2VybmFtZSk7XG4gIHJldHVybiBkYXRhO1xufVxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVGZXRjaFByZWRpY3Rpb25zKHVzZXJuYW1lcykge1xuICBjb25zdCByZXN1bHRzID0ge307XG4gIGNvbnN0IHVzZXJzVG9GZXRjaCA9IFtdO1xuXG4gIGZvciAoY29uc3QgdXNlcm5hbWUgb2YgdXNlcm5hbWVzKSB7XG4gICAgaWYgKHByZWRpY3Rpb25DYWNoZS5oYXModXNlcm5hbWUpKSB7XG4gICAgICByZXN1bHRzW3VzZXJuYW1lXSA9IHByZWRpY3Rpb25DYWNoZS5nZXQodXNlcm5hbWUpO1xuICAgIH0gZWxzZSB7XG4gICAgICB1c2Vyc1RvRmV0Y2gucHVzaCh1c2VybmFtZSk7XG4gICAgfVxuICB9XG5cbiAgaWYgKHVzZXJzVG9GZXRjaC5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4gcmVzdWx0cztcbiAgfVxuXG4gIHRyeSB7XG4gICAgLy8gRm9yIG5vdywgZ2VuZXJhdGUgbW9jayBkYXRhIHRvIGRlbW9uc3RyYXRlIGZ1bmN0aW9uYWxpdHkgd2l0aG91dCBhIGxpdmUgYmFja2VuZFxuICAgIGZvciAoY29uc3QgdXNlcm5hbWUgb2YgdXNlcnNUb0ZldGNoKSB7XG4gICAgICBjb25zdCBtb2NrRGVsdGEgPSBNYXRoLnJhbmRvbSgpICogMTAwIC0gNTA7XG4gICAgICBjb25zdCBkYXRhID0ge1xuICAgICAgICBkZWx0YTogbW9ja0RlbHRhLFxuICAgICAgICBuZXdSYXRpbmc6IDE4MDAgKyBtb2NrRGVsdGEsXG4gICAgICB9O1xuICAgICAgcHJlZGljdGlvbkNhY2hlLnNldCh1c2VybmFtZSwgZGF0YSk7XG4gICAgICByZXN1bHRzW3VzZXJuYW1lXSA9IGRhdGE7XG4gICAgfVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIExvZ2dlci53YXJuKExPR19DVFgsIFwiRmFpbGVkIHRvIGZldGNoIGZyb20gYmFja2VuZCwgdXNpbmcgbW9jayBkYXRhXCIsIHtcbiAgICAgIGVycm9yOiBlcnJvci5tZXNzYWdlLFxuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIHJlc3VsdHM7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiOztBQU9PLE1BQU0sY0FBYztBQUFBO0FBQUEsSUFFekIsb0JBQW9CO0FBQUE7QUFBQSxJQUVwQixpQkFBaUI7QUFBQTtBQUFBLElBRWpCLGVBQWU7QUFBQTtBQUFBLElBRWYsZ0JBQWdCO0FBQUEsRUFDbEI7QUFRTyxXQUFTLGNBQWMsTUFBTSxVQUFVLENBQUMsR0FBRztBQUNoRCxXQUFPLEVBQUUsTUFBTSxTQUFTLFdBQVcsS0FBSyxJQUFJLEVBQUU7QUFBQSxFQUNoRDs7O0FDbEJBLE1BQU0sZUFBZSxLQUFLLEtBQUssS0FBSztBQUdwQyxNQUFNLHFCQUFxQixLQUFLLEtBQUs7QUFHckMsTUFBTSxpQkFBaUIsSUFBSSxLQUFLLEtBQUs7QUFFOUIsTUFBTSxVQUFVO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsSUFRckIsTUFBTSxXQUFXLFVBQVU7QUFDekIsWUFBTSxNQUFNLFdBQVcsUUFBUTtBQUMvQixhQUFPLElBQUksUUFBUSxDQUFDLFlBQVk7QUFDOUIsZUFBTyxRQUFRLE1BQU0sSUFBSSxDQUFDLEdBQUcsR0FBRyxDQUFDLFdBQVc7QUFDMUMsZ0JBQU0sUUFBUSxPQUFPLEdBQUc7QUFDeEIs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
