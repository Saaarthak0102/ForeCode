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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL3NjcmlwdHMvbGliL21lc3NhZ2VUeXBlcy5qcyIsICIuLi8uLi9zcmMvc2NyaXB0cy9saWIvc3RvcmFnZS5qcyIsICIuLi8uLi9zcmMvc2NyaXB0cy9saWIvZXJyb3JzLmpzIiwgIi4uLy4uL3NyYy9zY3JpcHRzL2xpYi9sb2dnZXIuanMiLCAiLi4vLi4vc3JjL3NjcmlwdHMvYmFja2dyb3VuZC5qcyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBUeXBlZCBicm9hZGNhc3QgbWVzc2FnZSBjb25zdGFudHMgYW5kIGZhY3RvcnkuXG4gKlxuICogQWxsIGludGVyLWNvbXBvbmVudCBtZXNzYWdpbmcgKGJhY2tncm91bmQgXHUyMTk0IHBvcHVwIFx1MjE5NCBjb250ZW50IHNjcmlwdHMpXG4gKiB1c2VzIHRoZXNlIHR5cGVzIHRvIGVuc3VyZSBjb25zaXN0ZW5jeSBhbmQgZnV0dXJlLXByb29maW5nLlxuICovXG5cbmV4cG9ydCBjb25zdCBNZXNzYWdlVHlwZSA9IHtcbiAgLyoqIFByZWRpY3Rpb24gZGF0YSB3YXMgdXBkYXRlZCBvciBuZXdseSBhdmFpbGFibGUgKi9cbiAgUFJFRElDVElPTl9VUERBVEVEOiBcIlBSRURJQ1RJT05fVVBEQVRFRFwiLFxuICAvKiogQ29udGVzdCBoaXN0b3J5IHdhcyByZWZyZXNoZWQgb3IgbW9kaWZpZWQgKi9cbiAgSElTVE9SWV9VUERBVEVEOiBcIkhJU1RPUllfVVBEQVRFRFwiLFxuICAvKiogVXNlciBsb2dpbiBzdGF0ZSBjaGFuZ2VkIChsb2dnZWQgaW4gLyBvdXQgLyBkaWZmZXJlbnQgdXNlcikgKi9cbiAgTE9HSU5fQ0hBTkdFRDogXCJMT0dJTl9DSEFOR0VEXCIsXG4gIC8qKiBBbiBlcnJvciBvY2N1cnJlZCB0aGF0IHRoZSBVSSBzaG91bGQgZGlzcGxheSAqL1xuICBFUlJPUl9PQ0NVUlJFRDogXCJFUlJPUl9PQ0NVUlJFRFwiLFxufTtcblxuLyoqXG4gKiBDcmVhdGUgYSB0eXBlZCBtZXNzYWdlIGVudmVsb3BlLlxuICogQHBhcmFtIHtzdHJpbmd9IHR5cGUgLSBPbmUgb2YgTWVzc2FnZVR5cGUgdmFsdWVzLlxuICogQHBhcmFtIHtvYmplY3R9IFtwYXlsb2FkPXt9XSAtIEFyYml0cmFyeSBwYXlsb2FkIGRhdGEuXG4gKiBAcmV0dXJucyB7eyB0eXBlOiBzdHJpbmcsIHBheWxvYWQ6IG9iamVjdCwgdGltZXN0YW1wOiBudW1iZXIgfX1cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZU1lc3NhZ2UodHlwZSwgcGF5bG9hZCA9IHt9KSB7XG4gIHJldHVybiB7IHR5cGUsIHBheWxvYWQsIHRpbWVzdGFtcDogRGF0ZS5ub3coKSB9O1xufVxuIiwgIi8qKlxuICogQ2VudHJhbCBDaHJvbWUgU3RvcmFnZSBNYW5hZ2VyLlxuICpcbiAqIFdyYXBzIGFsbCBjaHJvbWUuc3RvcmFnZS5sb2NhbCBvcGVyYXRpb25zIGJlaGluZCBhIGNsZWFuIEFQSS5cbiAqIEhhbmRsZXMgY2FjaGUgZXhwaXJhdGlvbiAoU3VnZ2VzdGlvbiAxKSBhbmQgcHJlZGljdGlvbiBiYWNrb2ZmIHN0YXRlIChTdWdnZXN0aW9uIDIpLlxuICovXG5cbi8qKiBDYWNoZSBUVEw6IDI0IGhvdXJzIGluIG1pbGxpc2Vjb25kcyAqL1xuY29uc3QgQ0FDSEVfVFRMX01TID0gMjQgKiA2MCAqIDYwICogMTAwMDtcblxuLyoqIEluaXRpYWwgYmFja29mZiBpbnRlcnZhbDogMjAgbWludXRlcyBpbiBtaWxsaXNlY29uZHMgKi9cbmNvbnN0IElOSVRJQUxfQkFDS09GRl9NUyA9IDIwICogNjAgKiAxMDAwO1xuXG4vKiogTWF4aW11bSBiYWNrb2ZmIGludGVydmFsOiA2IGhvdXJzIGluIG1pbGxpc2Vjb25kcyAqL1xuY29uc3QgTUFYX0JBQ0tPRkZfTVMgPSA2ICogNjAgKiA2MCAqIDEwMDA7XG5cbmV4cG9ydCBjb25zdCBTdG9yYWdlID0ge1xuICAvLyBcdTI1MDBcdTI1MDAgSGlzdG9yeSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICAvKipcbiAgICogR2V0IGNvbnRlc3QgaGlzdG9yeSBmb3IgYSB1c2VyLCBjaGVja2luZyBjYWNoZSBmcmVzaG5lc3MuXG4gICAqIEBwYXJhbSB7c3RyaW5nfSB1c2VybmFtZVxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTx7IGRhdGE6IEFycmF5LCB1cGRhdGVkQXQ6IG51bWJlciwgaXNTdGFsZTogYm9vbGVhbiB9Pn1cbiAgICovXG4gIGFzeW5jIGdldEhpc3RvcnkodXNlcm5hbWUpIHtcbiAgICBjb25zdCBrZXkgPSBgaGlzdG9yeV8ke3VzZXJuYW1lfWA7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoW2tleV0sIChyZXN1bHQpID0+IHtcbiAgICAgICAgY29uc3QgZW50cnkgPSByZXN1bHRba2V5XTtcbiAgICAgICAgaWYgKCFlbnRyeSB8fCAhZW50cnkudXBkYXRlZEF0KSB7XG4gICAgICAgICAgcmVzb2x2ZSh7IGRhdGE6IFtdLCB1cGRhdGVkQXQ6IDAsIGlzU3RhbGU6IHRydWUgfSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGlzU3RhbGUgPSBEYXRlLm5vdygpIC0gZW50cnkudXBkYXRlZEF0ID4gQ0FDSEVfVFRMX01TO1xuICAgICAgICByZXNvbHZlKHsgZGF0YTogZW50cnkuZGF0YSB8fCBbXSwgdXBkYXRlZEF0OiBlbnRyeS51cGRhdGVkQXQsIGlzU3RhbGUgfSk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSxcblxuICAvKipcbiAgICogU2F2ZSBjb250ZXN0IGhpc3Rvcnkgd2l0aCBhIGZyZXNoIHRpbWVzdGFtcC5cbiAgICogQHBhcmFtIHtzdHJpbmd9IHVzZXJuYW1lXG4gICAqIEBwYXJhbSB7QXJyYXl9IGRhdGFcbiAgICogQHJldHVybnMge1Byb21pc2U8dm9pZD59XG4gICAqL1xuICBhc3luYyBzYXZlSGlzdG9yeSh1c2VybmFtZSwgZGF0YSkge1xuICAgIGNvbnN0IGtleSA9IGBoaXN0b3J5XyR7dXNlcm5hbWV9YDtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICAgIGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldChcbiAgICAgICAgeyBba2V5XTogeyBkYXRhLCB1cGRhdGVkQXQ6IERhdGUubm93KCkgfSB9LFxuICAgICAgICByZXNvbHZlXG4gICAgICApO1xuICAgIH0pO1xuICB9LFxuXG4gIC8qKlxuICAgKiBDaGVjayBpZiBhIGhpc3RvcnkgY2FjaGUgZW50cnkgaXMgc3RhbGUgKD4yNGgpLlxuICAgKiBAcGFyYW0ge3sgdXBkYXRlZEF0OiBudW1iZXIgfX0gZW50cnlcbiAgICogQHJldHVybnMge2Jvb2xlYW59XG4gICAqL1xuICBpc0hpc3RvcnlTdGFsZShlbnRyeSkge1xuICAgIGlmICghZW50cnkgfHwgIWVudHJ5LnVwZGF0ZWRBdCkgcmV0dXJuIHRydWU7XG4gICAgcmV0dXJuIERhdGUubm93KCkgLSBlbnRyeS51cGRhdGVkQXQgPiBDQUNIRV9UVExfTVM7XG4gIH0sXG5cbiAgLy8gXHUyNTAwXHUyNTAwIFByZWRpY3Rpb24gU3RhdHVzIChFeHBvbmVudGlhbCBCYWNrb2ZmKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICAvKipcbiAgICogR2V0IHRoZSBjdXJyZW50IHByZWRpY3Rpb24gcG9sbGluZyBzdGF0dXMuXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPG9iamVjdHxudWxsPn1cbiAgICovXG4gIGFzeW5jIGdldFByZWRpY3Rpb25TdGF0dXMoKSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoW1wicHJlZGljdGlvbl9zdGF0dXNcIl0sIChyZXN1bHQpID0+IHtcbiAgICAgICAgcmVzb2x2ZShyZXN1bHQucHJlZGljdGlvbl9zdGF0dXMgfHwgbnVsbCk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSxcblxuICAvKipcbiAgICogU2F2ZSBwcmVkaWN0aW9uIHBvbGxpbmcgc3RhdHVzIHdpdGggYmFja29mZiBzdGF0ZS5cbiAgICogQHBhcmFtIHtvYmplY3R9IHN0YXR1cyAtIHsgY29udGVzdFNsdWcsIHN0YXR1cywgbGFzdENoZWNrZWQsIHJldHJ5Q291bnQsIG5leHRSZXRyeUF0IH1cbiAgICogQHJldHVybnMge1Byb21pc2U8dm9pZD59XG4gICAqL1xuICBhc3luYyBzYXZlUHJlZGljdGlvblN0YXR1cyhzdGF0dXMpIHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICAgIGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IHByZWRpY3Rpb25fc3RhdHVzOiBzdGF0dXMgfSwgcmVzb2x2ZSk7XG4gICAgfSk7XG4gIH0sXG5cbiAgLyoqXG4gICAqIENsZWFyIHByZWRpY3Rpb24gc3RhdHVzIChwcmVkaWN0aW9uIHJlc29sdmVkIG9yIGNvbmZpcm1lZCkuXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPHZvaWQ+fVxuICAgKi9cbiAgYXN5bmMgY2xlYXJQcmVkaWN0aW9uU3RhdHVzKCkge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgICAgY2hyb21lLnN0b3JhZ2UubG9jYWwucmVtb3ZlKFwicHJlZGljdGlvbl9zdGF0dXNcIiwgcmVzb2x2ZSk7XG4gICAgfSk7XG4gIH0sXG5cbiAgLyoqXG4gICAqIENhbGN1bGF0ZSB0aGUgbmV4dCByZXRyeSB0aW1lc3RhbXAgdXNpbmcgZXhwb25lbnRpYWwgYmFja29mZi5cbiAgICogU2NoZWR1bGU6IDIwbSBcdTIxOTIgNDBtIFx1MjE5MiA4MG0gXHUyMTkyIDE2MG0gXHUyMTkyIDMyMG0gXHUyMTkyIDM2MG0gKGNhcClcbiAgICogQHBhcmFtIHtudW1iZXJ9IHJldHJ5Q291bnQgLSBDdXJyZW50IHJldHJ5IGNvdW50ICgwLWluZGV4ZWQpLlxuICAgKiBAcmV0dXJucyB7bnVtYmVyfSBUaW1lc3RhbXAgKG1zKSBmb3IgbmV4dCBhbGxvd2VkIHJldHJ5LlxuICAgKi9cbiAgY2FsY3VsYXRlTmV4dFJldHJ5KHJldHJ5Q291bnQpIHtcbiAgICBjb25zdCBkZWxheU1zID0gTWF0aC5taW4oXG4gICAgICBJTklUSUFMX0JBQ0tPRkZfTVMgKiBNYXRoLnBvdygyLCByZXRyeUNvdW50KSxcbiAgICAgIE1BWF9CQUNLT0ZGX01TXG4gICAgKTtcbiAgICByZXR1cm4gRGF0ZS5ub3coKSArIGRlbGF5TXM7XG4gIH0sXG5cbiAgLy8gXHUyNTAwXHUyNTAwIFVzZXJuYW1lIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIC8qKlxuICAgKiBHZXQgdGhlIHN0b3JlZCBMZWV0Q29kZSB1c2VybmFtZS5cbiAgICogQHJldHVybnMge1Byb21pc2U8c3RyaW5nfG51bGw+fVxuICAgKi9cbiAgYXN5bmMgZ2V0VXNlcm5hbWUoKSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoW1wibGNfdXNlcm5hbWVcIl0sIChyZXN1bHQpID0+IHtcbiAgICAgICAgcmVzb2x2ZShyZXN1bHQubGNfdXNlcm5hbWUgfHwgbnVsbCk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSxcblxuICAvKipcbiAgICogU2F2ZSB0aGUgTGVldENvZGUgdXNlcm5hbWUuXG4gICAqIEBwYXJhbSB7c3RyaW5nfSB1c2VybmFtZVxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTx2b2lkPn1cbiAgICovXG4gIGFzeW5jIHNldFVzZXJuYW1lKHVzZXJuYW1lKSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBsY191c2VybmFtZTogdXNlcm5hbWUgfSwgcmVzb2x2ZSk7XG4gICAgfSk7XG4gIH0sXG5cbiAgLy8gXHUyNTAwXHUyNTAwIExhc3QgRXJyb3IgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgLyoqXG4gICAqIFNhdmUgdGhlIGxhc3QgZXJyb3Igc3RhdGUgZm9yIFVJIGRpc3BsYXkuXG4gICAqIEBwYXJhbSB7b2JqZWN0fG51bGx9IGVycm9yIC0gRXJyb3Igb2JqZWN0IGZyb20gY3JlYXRlRXJyb3IoKSwgb3IgbnVsbCB0byBjbGVhci5cbiAgICogQHJldHVybnMge1Byb21pc2U8dm9pZD59XG4gICAqL1xuICBhc3luYyBzZXRMYXN0RXJyb3IoZXJyb3IpIHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICAgIGlmIChlcnJvciA9PT0gbnVsbCkge1xuICAgICAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5yZW1vdmUoXCJsYXN0X2Vycm9yXCIsIHJlc29sdmUpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgbGFzdF9lcnJvcjogZXJyb3IgfSwgcmVzb2x2ZSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0sXG5cbiAgLyoqXG4gICAqIEdldCB0aGUgbGFzdCBzdG9yZWQgZXJyb3IuXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPG9iamVjdHxudWxsPn1cbiAgICovXG4gIGFzeW5jIGdldExhc3RFcnJvcigpIHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICAgIGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChbXCJsYXN0X2Vycm9yXCJdLCAocmVzdWx0KSA9PiB7XG4gICAgICAgIHJlc29sdmUocmVzdWx0Lmxhc3RfZXJyb3IgfHwgbnVsbCk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSxcbn07XG4iLCAiLyoqXG4gKiBTdHJ1Y3R1cmVkIGVycm9yIGNvZGVzIGZvciB0aGUgZXh0ZW5zaW9uLlxuICpcbiAqIFRoZXNlIGNvZGVzIGFsbG93IHRoZSBwb3B1cCBhbmQgY29udGVudCBzY3JpcHRzIHRvIGRpc3BsYXlcbiAqIG1lYW5pbmdmdWwsIHVzZXItZnJpZW5kbHkgc3RhdHVzIG1lc3NhZ2VzIGluc3RlYWQgb2YgZ2VuZXJpYyBlcnJvcnMuXG4gKi9cblxuZXhwb3J0IGNvbnN0IEVycm9yQ29kZSA9IHtcbiAgLyoqIE5ldHdvcmsgcmVxdWVzdCBmYWlsZWQgKG5vIGNvbm5lY3Rpdml0eSwgRE5TLCB0aW1lb3V0KSAqL1xuICBORVRXT1JLX0VSUk9SOiBcIk5FVFdPUktfRVJST1JcIixcbiAgLyoqIExlZXRDb2RlIEdyYXBoUUwgQVBJIHJldHVybmVkIGFuIGVycm9yIG9yIHVuZXhwZWN0ZWQgc2hhcGUgKi9cbiAgR1JBUEhRTF9GQUlMRUQ6IFwiR1JBUEhRTF9GQUlMRURcIixcbiAgLyoqIFByZWRpY3Rpb24gaXMgbm90IHlldCBhdmFpbGFibGUgXHUyMDE0IHN0aWxsIGJlaW5nIGNhbGN1bGF0ZWQgKi9cbiAgUFJFRElDVElPTl9QRU5ESU5HOiBcIlBSRURJQ1RJT05fUEVORElOR1wiLFxuICAvKiogVGhlIHJlcXVlc3RlZCB1c2VyIHdhcyBub3QgZm91bmQgb24gTGVldENvZGUgKi9cbiAgVVNFUl9OT1RfRk9VTkQ6IFwiVVNFUl9OT1RfRk9VTkRcIixcbiAgLyoqIFRvbyBtYW55IHJlcXVlc3RzIFx1MjAxNCBiZWluZyByYXRlIGxpbWl0ZWQgKi9cbiAgUkFURV9MSU1JVEVEOiBcIlJBVEVfTElNSVRFRFwiLFxuICAvKiogQ2F0Y2gtYWxsIGZvciB1bmV4cGVjdGVkIGVycm9ycyAqL1xuICBVTktOT1dOX0VSUk9SOiBcIlVOS05PV05fRVJST1JcIixcbn07XG5cbi8qKlxuICogVXNlci1mcmllbmRseSBlcnJvciBtZXNzYWdlcyBmb3IgZWFjaCBjb2RlLlxuICovXG5jb25zdCBFcnJvck1lc3NhZ2VzID0ge1xuICBbRXJyb3JDb2RlLk5FVFdPUktfRVJST1JdOiBcIk5ldHdvcmsgZXJyb3IgXHUyMDE0IHdpbGwgcmV0cnkgYXV0b21hdGljYWxseS5cIixcbiAgW0Vycm9yQ29kZS5HUkFQSFFMX0ZBSUxFRF06IFwiRmFpbGVkIHRvIHJlYWNoIExlZXRDb2RlIFx1MjAxNCB3aWxsIHJldHJ5LlwiLFxuICBbRXJyb3JDb2RlLlBSRURJQ1RJT05fUEVORElOR106IFwiUHJlZGljdGlvbiBpcyBzdGlsbCBiZWluZyBjYWxjdWxhdGVkXHUyMDI2XCIsXG4gIFtFcnJvckNvZGUuVVNFUl9OT1RfRk9VTkRdOiBcIkxlZXRDb2RlIHVzZXIgbm90IGZvdW5kLlwiLFxuICBbRXJyb3JDb2RlLlJBVEVfTElNSVRFRF06IFwiVG9vIG1hbnkgcmVxdWVzdHMgXHUyMDE0IHNsb3dpbmcgZG93bi5cIixcbiAgW0Vycm9yQ29kZS5VTktOT1dOX0VSUk9SXTogXCJTb21ldGhpbmcgd2VudCB3cm9uZy5cIixcbn07XG5cbi8qKlxuICogQ3JlYXRlIGEgc3RydWN0dXJlZCBlcnJvciBvYmplY3QuXG4gKiBAcGFyYW0ge3N0cmluZ30gY29kZSAtIE9uZSBvZiBFcnJvckNvZGUgdmFsdWVzLlxuICogQHBhcmFtIHtzdHJpbmd9IFtkZXRhaWxdIC0gT3B0aW9uYWwgdGVjaG5pY2FsIGRldGFpbCBmb3IgbG9nZ2luZy5cbiAqIEByZXR1cm5zIHt7IGNvZGU6IHN0cmluZywgbWVzc2FnZTogc3RyaW5nLCBkZXRhaWw/OiBzdHJpbmcsIHRpbWVzdGFtcDogbnVtYmVyIH19XG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVFcnJvcihjb2RlLCBkZXRhaWwpIHtcbiAgcmV0dXJuIHtcbiAgICBjb2RlLFxuICAgIG1lc3NhZ2U6IEVycm9yTWVzc2FnZXNbY29kZV0gfHwgRXJyb3JNZXNzYWdlc1tFcnJvckNvZGUuVU5LTk9XTl9FUlJPUl0sXG4gICAgLi4uKGRldGFpbCA/IHsgZGV0YWlsIH0gOiB7fSksXG4gICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICB9O1xufVxuIiwgIi8qKlxuICogU3RydWN0dXJlZCBsb2dnZXIgZm9yIHRoZSBDaHJvbWUgZXh0ZW5zaW9uLlxuICpcbiAqIFJlcGxhY2VzIHJhdyBjb25zb2xlLmxvZy9lcnJvci93YXJuIGNhbGxzIHdpdGggc3RydWN0dXJlZCBvdXRwdXRcbiAqIHRoYXQgaW5jbHVkZXMgdGltZXN0YW1wcywgY29udGV4dCBtb2R1bGVzLCBhbmQgcmVsZXZhbnQgZGF0YS5cbiAqL1xuXG5leHBvcnQgY29uc3QgTG9nZ2VyID0ge1xuICAvKipcbiAgICogQHBhcmFtIHtzdHJpbmd9IGNvbnRleHQgLSBNb2R1bGUgbmFtZSAoZS5nLiwgXCJCYWNrZ3JvdW5kXCIsIFwiUG9wdXBcIikuXG4gICAqIEBwYXJhbSB7c3RyaW5nfSBtZXNzYWdlIC0gTG9nIG1lc3NhZ2UuXG4gICAqIEBwYXJhbSB7b2JqZWN0fSBbZGF0YV0gLSBPcHRpb25hbCBzdHJ1Y3R1cmVkIGRhdGEuXG4gICAqL1xuICBpbmZvKGNvbnRleHQsIG1lc3NhZ2UsIGRhdGEpIHtcbiAgICBjb25zdCBlbnRyeSA9IExvZ2dlci5fZm9ybWF0KFwiSU5GT1wiLCBjb250ZXh0LCBtZXNzYWdlLCBkYXRhKTtcbiAgICBjb25zb2xlLmxvZyhlbnRyeSk7XG4gIH0sXG5cbiAgd2Fybihjb250ZXh0LCBtZXNzYWdlLCBkYXRhKSB7XG4gICAgY29uc3QgZW50cnkgPSBMb2dnZXIuX2Zvcm1hdChcIldBUk5cIiwgY29udGV4dCwgbWVzc2FnZSwgZGF0YSk7XG4gICAgY29uc29sZS53YXJuKGVudHJ5KTtcbiAgfSxcblxuICBlcnJvcihjb250ZXh0LCBtZXNzYWdlLCBkYXRhKSB7XG4gICAgY29uc3QgZW50cnkgPSBMb2dnZXIuX2Zvcm1hdChcIkVSUk9SXCIsIGNvbnRleHQsIG1lc3NhZ2UsIGRhdGEpO1xuICAgIGNvbnNvbGUuZXJyb3IoZW50cnkpO1xuICB9LFxuXG4gIC8qKlxuICAgKiBGb3JtYXQgYSBzdHJ1Y3R1cmVkIGxvZyBlbnRyeS5cbiAgICogQHByaXZhdGVcbiAgICovXG4gIF9mb3JtYXQobGV2ZWwsIGNvbnRleHQsIG1lc3NhZ2UsIGRhdGEpIHtcbiAgICBjb25zdCB0aW1lc3RhbXAgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG4gICAgY29uc3QgYmFzZSA9IGBbJHt0aW1lc3RhbXB9XSBbJHtsZXZlbH1dIFske2NvbnRleHR9XSAke21lc3NhZ2V9YDtcbiAgICBpZiAoZGF0YSAhPT0gdW5kZWZpbmVkICYmIGRhdGEgIT09IG51bGwpIHtcbiAgICAgIC8vIEtlZXAgaXQgcmVhZGFibGUgaW4gdGhlIGNvbnNvbGVcbiAgICAgIHJldHVybiBgJHtiYXNlfSB8ICR7SlNPTi5zdHJpbmdpZnkoZGF0YSl9YDtcbiAgICB9XG4gICAgcmV0dXJuIGJhc2U7XG4gIH0sXG59O1xuIiwgIi8qKlxuICogQmFja2dyb3VuZCBTZXJ2aWNlIFdvcmtlclxuICpcbiAqIFJlc3BvbnNpYmlsaXRpZXM6XG4gKiAtIFVzZXIgZGV0ZWN0aW9uIChMZWV0Q29kZSBHcmFwaFFMKVxuICogLSBBbGFybS1iYXNlZCBwb2xsaW5nIHdpdGggZXhwb25lbnRpYWwgYmFja29mZlxuICogLSBDaHJvbWUgU3RvcmFnZSBtYW5hZ2VtZW50ICh2aWEgU3RvcmFnZSBoZWxwZXIpXG4gKiAtIEFQSSBjb21tdW5pY2F0aW9uIHdpdGggdGhlIGJhY2tlbmQgcHJveHlcbiAqIC0gQnJvYWRjYXN0aW5nIHR5cGVkIG1lc3NhZ2VzIHRvIHBvcHVwICYgY29udGVudCBzY3JpcHRzXG4gKi9cblxuLy8gXHUyNTAwXHUyNTAwIFNoYXJlZCBtb2R1bGVzIChpbmxpbmVkIGJ5IGJ1aWxkLmNqcykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5pbXBvcnQgeyBNZXNzYWdlVHlwZSwgY3JlYXRlTWVzc2FnZSB9IGZyb20gXCIuL2xpYi9tZXNzYWdlVHlwZXMuanNcIjtcbmltcG9ydCB7IFN0b3JhZ2UgfSBmcm9tIFwiLi9saWIvc3RvcmFnZS5qc1wiO1xuaW1wb3J0IHsgRXJyb3JDb2RlLCBjcmVhdGVFcnJvciB9IGZyb20gXCIuL2xpYi9lcnJvcnMuanNcIjtcbmltcG9ydCB7IExvZ2dlciB9IGZyb20gXCIuL2xpYi9sb2dnZXIuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwIENvbnN0YW50cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY29uc3QgQVBJX1VSTCA9IFwiaHR0cDovL2xvY2FsaG9zdDo4MDAwL2FwaS92MVwiOyAvLyBDaGFuZ2UgdG8geW91ciBob3N0ZWQgYmFja2VuZCBVUkxcblxuY29uc3QgTE9HX0NUWCA9IFwiQmFja2dyb3VuZFwiO1xuXG4vLyBTaW1wbGUgaW4tbWVtb3J5IGNhY2hlIGZvciBsZWFkZXJib2FyZCBwcmVkaWN0aW9uIGxvb2t1cHNcbmNvbnN0IHByZWRpY3Rpb25DYWNoZSA9IG5ldyBNYXAoKTtcblxuLy8gXHUyNTAwXHUyNTAwIFVzZXJuYW1lIERldGVjdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuYXN5bmMgZnVuY3Rpb24gZ2V0TGVldENvZGVVc2VybmFtZSgpIHtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChcImh0dHBzOi8vbGVldGNvZGUuY29tL2dyYXBocWxcIiwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGNyZWRlbnRpYWxzOiBcImluY2x1ZGVcIixcbiAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgcXVlcnk6IFwicXVlcnkgZ2xvYmFsRGF0YSB7IHVzZXJTdGF0dXMgeyB1c2VybmFtZSB9IH1cIixcbiAgICAgIH0pLFxuICAgIH0pO1xuICAgIGNvbnN0IGRhdGEgPSBhd2FpdCByZXMuanNvbigpO1xuICAgIHJldHVybiBkYXRhPy5kYXRhPy51c2VyU3RhdHVzPy51c2VybmFtZSB8fCBudWxsO1xuICB9IGNhdGNoIChlKSB7XG4gICAgTG9nZ2VyLmVycm9yKExPR19DVFgsIFwiRmFpbGVkIHRvIGRldGVjdCBMZWV0Q29kZSB1c2VybmFtZVwiLCB7IGVycm9yOiBlLm1lc3NhZ2UgfSk7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwIEhpc3RvcnkgTWFuYWdlbWVudCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBGZXRjaCBsYXRlc3QgYXR0ZW5kZWQgY29udGVzdCBmcm9tIExlZXRDb2RlLlxuICovXG5hc3luYyBmdW5jdGlvbiBmZXRjaExhdGVzdEF0dGVuZGVkQ29udGVzdCgpIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBncWxSZXMgPSBhd2FpdCBmZXRjaChcImh0dHBzOi8vbGVldGNvZGUuY29tL2dyYXBocWxcIiwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGNyZWRlbnRpYWxzOiBcImluY2x1ZGVcIixcbiAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgcXVlcnk6IGBxdWVyeSBjb250ZXN0VjJNeUNvbnRlc3RzKCRza2lwOiBJbnQhLCAkbGltaXQ6IEludCEsICRpc1ZpcnR1YWw6IEJvb2xlYW4pIHtcbiAgICAgICAgICBjb250ZXN0VjJNeUNvbnRlc3RzKHNraXA6ICRza2lwLCBsaW1pdDogJGxpbWl0LCBpc1ZpcnR1YWw6ICRpc1ZpcnR1YWwpIHtcbiAgICAgICAgICAgIGNvbnRlc3RzIHtcbiAgICAgICAgICAgICAgdGl0bGVTbHVnXG4gICAgICAgICAgICAgIHRpdGxlXG4gICAgICAgICAgICAgIHN0YXJ0VGltZVxuICAgICAgICAgICAgICBmaW5pc2hUaW1lXG4gICAgICAgICAgICAgIHNvbHZlZFxuICAgICAgICAgICAgICByYW5raW5nXG4gICAgICAgICAgICAgIHRvdGFsUXVlc3Rpb25zXG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9YCxcbiAgICAgICAgdmFyaWFibGVzOiB7IHNraXA6IDAsIGxpbWl0OiAxLCBpc1ZpcnR1YWw6IGZhbHNlIH0sXG4gICAgICB9KSxcbiAgICB9KTtcblxuICAgIGlmIChncWxSZXMub2spIHtcbiAgICAgIGNvbnN0IGdxbERhdGEgPSBhd2FpdCBncWxSZXMuanNvbigpO1xuICAgICAgY29uc3QgY29udGVzdHMgPSBncWxEYXRhPy5kYXRhPy5jb250ZXN0VjJNeUNvbnRlc3RzPy5jb250ZXN0cyB8fCBbXTtcbiAgICAgIGlmIChjb250ZXN0cy5sZW5ndGggPiAwKSB7XG4gICAgICAgIHJldHVybiBjb250ZXN0c1swXTtcbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIExvZ2dlci53YXJuKExPR19DVFgsIFwiRmFpbGVkIHRvIGZldGNoIGxhdGVzdCBhdHRlbmRlZCBjb250ZXN0XCIsIHsgZXJyb3I6IGVyci5tZXNzYWdlIH0pO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG4vKipcbiAqIEZldGNoIGZyZXNoIGhpc3RvcnkgZnJvbSB0aGUgYmFja2VuZCBhbmQgc2F2ZSB0byBzdG9yYWdlLlxuICovXG5hc3luYyBmdW5jdGlvbiByZWZyZXNoSGlzdG9yeSh1c2VybmFtZSkge1xuICBMb2dnZXIuaW5mbyhMT0dfQ1RYLCBcIlJlZnJlc2hpbmcgaGlzdG9yeSBmcm9tIGJhY2tlbmRcIiwgeyB1c2VybmFtZSB9KTtcbiAgdHJ5IHtcbiAgICBjb25zdCBsYXRlc3RDb250ZXN0ID0gYXdhaXQgZmV0Y2hMYXRlc3RBdHRlbmRlZENvbnRlc3QoKTtcblxuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGAke0FQSV9VUkx9L3VzZXIvJHt1c2VybmFtZX0vaGlzdG9yeWAsIHtcbiAgICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGxhdGVzdF9hdHRlbmRlZF9jb250ZXN0OiBsYXRlc3RDb250ZXN0XG4gICAgICB9KVxuICAgIH0pO1xuXG4gICAgaWYgKHJlcy5vaykge1xuICAgICAgY29uc3QgaGlzdG9yeSA9IGF3YWl0IHJlcy5qc29uKCk7XG4gICAgICBcbiAgICAgIGNvbnN0IG1hcHBlZEhpc3RvcnkgPSBoaXN0b3J5Lm1hcChyZWNvcmQgPT4gKHtcbiAgICAgICAgbmFtZTogcmVjb3JkLmNvbnRlc3RfdGl0bGUsXG4gICAgICAgIGFjdHVhbFJhdGluZzogcmVjb3JkLmFjdHVhbF9yYXRpbmcsXG4gICAgICAgIHByZWRpY3RlZFJhdGluZzogcmVjb3JkLnByZWRpY3RlZF9yYXRpbmcgfHwgXCItXCIsXG4gICAgICAgIGRlbHRhOiByZWNvcmQuYWN0dWFsX2RlbHRhICE9PSBudWxsICYmIHJlY29yZC5hY3R1YWxfZGVsdGEgIT09IHVuZGVmaW5lZCBcbiAgICAgICAgICA/IHJlY29yZC5hY3R1YWxfZGVsdGEgXG4gICAgICAgICAgOiAocmVjb3JkLnByZWRpY3RlZF9kZWx0YSAhPT0gbnVsbCAmJiByZWNvcmQucHJlZGljdGVkX2RlbHRhICE9PSB1bmRlZmluZWQgPyByZWNvcmQucHJlZGljdGVkX2RlbHRhIDogbnVsbCksXG4gICAgICAgIHN0YXR1czogcmVjb3JkLnN0YXR1c1xuICAgICAgfSkpO1xuXG4gICAgICBhd2FpdCBTdG9yYWdlLnNhdmVIaXN0b3J5KHVzZXJuYW1lLCBtYXBwZWRIaXN0b3J5KTtcbiAgICAgIGF3YWl0IFN0b3JhZ2Uuc2V0TGFzdEVycm9yKG51bGwpO1xuICAgICAgXG4gICAgICBjb25zdCBwZW5kaW5nSXRlbSA9IG1hcHBlZEhpc3RvcnkuZmluZChyID0+IHIuc3RhdHVzID09PSAncHJlZGljdGlvbl9wZW5kaW5nJyk7XG4gICAgICBpZiAocGVuZGluZ0l0ZW0pIHtcbiAgICAgICAgYXdhaXQgU3RvcmFnZS5zZXRMYXN0RXJyb3IoY3JlYXRlRXJyb3IoRXJyb3JDb2RlLlBSRURJQ1RJT05fUEVORElORykpO1xuICAgICAgfVxuXG4gICAgICBMb2dnZXIuaW5mbyhMT0dfQ1RYLCBcIkhpc3RvcnkgcmVmcmVzaGVkIHN1Y2Nlc3NmdWxseVwiLCB7XG4gICAgICAgIHVzZXJuYW1lLFxuICAgICAgICBjb3VudDogbWFwcGVkSGlzdG9yeS5sZW5ndGgsXG4gICAgICB9KTtcblxuICAgICAgYnJvYWRjYXN0KGNyZWF0ZU1lc3NhZ2UoTWVzc2FnZVR5cGUuSElTVE9SWV9VUERBVEVELCB7IHVzZXJuYW1lIH0pKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBCYWNrZW5kIHJldHVybmVkICR7cmVzLnN0YXR1c31gKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnN0IGVycm9yID0gY3JlYXRlRXJyb3IoRXJyb3JDb2RlLk5FVFdPUktfRVJST1IsIGVyci5tZXNzYWdlKTtcbiAgICBhd2FpdCBTdG9yYWdlLnNldExhc3RFcnJvcihlcnJvcik7XG4gICAgTG9nZ2VyLmVycm9yKExPR19DVFgsIFwiRmFpbGVkIHRvIHJlZnJlc2ggaGlzdG9yeVwiLCB7IHVzZXJuYW1lLCBlcnJvcjogZXJyLm1lc3NhZ2UgfSk7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwIEJyb2FkY2FzdCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBCcm9hZGNhc3QgYSB0eXBlZCBtZXNzYWdlIHRvIHBvcHVwIGFuZCBhbGwgTGVldENvZGUgdGFicy5cbiAqL1xuZnVuY3Rpb24gYnJvYWRjYXN0KG1lc3NhZ2UpIHtcbiAgLy8gTm90aWZ5IHBvcHVwIChtYXkgbm90IGJlIG9wZW4gXHUyMDE0IHRoYXQncyBmaW5lLCBjYXRjaCBzaWxlbnRseSlcbiAgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2UobWVzc2FnZSkuY2F0Y2goKCkgPT4ge30pO1xuXG4gIC8vIE5vdGlmeSBhY3RpdmUgTGVldENvZGUgdGFic1xuICBjaHJvbWUudGFicy5xdWVyeSh7IHVybDogXCIqOi8vbGVldGNvZGUuY29tLypcIiB9LCAodGFicykgPT4ge1xuICAgIGZvciAoY29uc3QgdGFiIG9mIHRhYnMpIHtcbiAgICAgIGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKHRhYi5pZCwgbWVzc2FnZSkuY2F0Y2goKCkgPT4ge30pO1xuICAgIH1cbiAgfSk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBMaWZlY3ljbGUgRXZlbnRzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jaHJvbWUucnVudGltZS5vblN0YXJ0dXAuYWRkTGlzdGVuZXIoKCkgPT4ge1xuICBMb2dnZXIuaW5mbyhMT0dfQ1RYLCBcIkV4dGVuc2lvbiBzdGFydHVwIFx1MjAxNCBjcmVhdGluZyBhbGFybVwiKTtcbiAgY2hyb21lLmFsYXJtcy5jcmVhdGUoXCJjaGVja1BlbmRpbmdQcmVkaWN0aW9uXCIsIHsgcGVyaW9kSW5NaW51dGVzOiAyMCB9KTtcbn0pO1xuXG5jaHJvbWUucnVudGltZS5vbkluc3RhbGxlZC5hZGRMaXN0ZW5lcihhc3luYyAoZGV0YWlscykgPT4ge1xuICBjaHJvbWUuYWxhcm1zLmNyZWF0ZShcImNoZWNrUGVuZGluZ1ByZWRpY3Rpb25cIiwgeyBwZXJpb2RJbk1pbnV0ZXM6IDIwIH0pO1xuXG4gIGlmIChkZXRhaWxzLnJlYXNvbiA9PT0gXCJpbnN0YWxsXCIpIHtcbiAgICBMb2dnZXIuaW5mbyhMT0dfQ1RYLCBcIkV4dGVuc2lvbiBpbnN0YWxsZWQgXHUyMDE0IGRldGVjdGluZyB1c2VyXCIpO1xuICAgIGNvbnN0IHVzZXJuYW1lID0gYXdhaXQgZ2V0TGVldENvZGVVc2VybmFtZSgpO1xuXG4gICAgaWYgKHVzZXJuYW1lKSB7XG4gICAgICBhd2FpdCBTdG9yYWdlLnNldFVzZXJuYW1lKHVzZXJuYW1lKTtcbiAgICAgIExvZ2dlci5pbmZvKExPR19DVFgsIFwiVXNlciBkZXRlY3RlZFwiLCB7IHVzZXJuYW1lIH0pO1xuXG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBmZXRjaChgJHtBUElfVVJMfS91c2VyLyR7dXNlcm5hbWV9L3JlZ2lzdGVyYCwgeyBtZXRob2Q6IFwiUE9TVFwiIH0pO1xuICAgICAgfSBjYXRjaCAoXykge1xuICAgICAgICAvLyBSZWdpc3RlciBlbmRwb2ludCBpcyBvcHRpb25hbDsgaWdub3JlIGZhaWx1cmVzXG4gICAgICB9XG5cbiAgICAgIGF3YWl0IHJlZnJlc2hIaXN0b3J5KHVzZXJuYW1lKTtcblxuICAgICAgYnJvYWRjYXN0KGNyZWF0ZU1lc3NhZ2UoTWVzc2FnZVR5cGUuTE9HSU5fQ0hBTkdFRCwgeyB1c2VybmFtZSB9KSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIExvZ2dlci53YXJuKExPR19DVFgsIFwiTm8gTGVldENvZGUgdXNlciBkZXRlY3RlZCBkdXJpbmcgaW5zdGFsbFwiKTtcbiAgICB9XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDAgQWxhcm0gSGFuZGxlciAoU3VnZ2VzdGlvbiAxOiBDYWNoZSBFeHBpcnkgKyBTdWdnZXN0aW9uIDI6IEJhY2tvZmYpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jaHJvbWUuYWxhcm1zLm9uQWxhcm0uYWRkTGlzdGVuZXIoYXN5bmMgKGFsYXJtKSA9PiB7XG4gIGlmIChhbGFybS5uYW1lICE9PSBcImNoZWNrUGVuZGluZ1ByZWRpY3Rpb25cIikgcmV0dXJuO1xuXG4gIGNvbnN0IHVzZXJuYW1lID0gYXdhaXQgU3RvcmFnZS5nZXRVc2VybmFtZSgpO1xuICBpZiAoIXVzZXJuYW1lKSByZXR1cm47XG5cbiAgTG9nZ2VyLmluZm8oTE9HX0NUWCwgXCJBbGFybSBmaXJlZCBcdTIwMTQgY2hlY2tpbmcgcHJlZGljdGlvbnNcIiwgeyB1c2VybmFtZSB9KTtcblxuICB0cnkge1xuICAgIGNvbnN0IGNhY2hlZEhpc3RvcnkgPSBhd2FpdCBTdG9yYWdlLmdldEhpc3RvcnkodXNlcm5hbWUpO1xuICAgIGlmIChjYWNoZWRIaXN0b3J5LmlzU3RhbGUpIHtcbiAgICAgIExvZ2dlci5pbmZvKExPR19DVFgsIFwiSGlzdG9yeSBjYWNoZSBpcyBzdGFsZSBcdTIwMTQgcmVmcmVzaGluZ1wiLCB7IHVzZXJuYW1lIH0pO1xuICAgICAgYXdhaXQgcmVmcmVzaEhpc3RvcnkodXNlcm5hbWUpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIEFsd2F5cyBmZXRjaCBsYXRlc3QgdG8gc3luYyBwZW5kaW5nIHByZWRpY3Rpb25zIHByb2FjdGl2ZWx5IGluIGFsYXJtXG4gICAgYXdhaXQgcmVmcmVzaEhpc3RvcnkodXNlcm5hbWUpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zdCBlcnJvckNvZGUgPVxuICAgICAgZXJyLm1lc3NhZ2UgJiYgZXJyLm1lc3NhZ2UuaW5jbHVkZXMoXCJOZXR3b3JrRXJyb3JcIilcbiAgICAgICAgPyBFcnJvckNvZGUuTkVUV09SS19FUlJPUlxuICAgICAgICA6IEVycm9yQ29kZS5VTktOT1dOX0VSUk9SO1xuXG4gICAgY29uc3QgZXJyb3IgPSBjcmVhdGVFcnJvcihlcnJvckNvZGUsIGVyci5tZXNzYWdlKTtcbiAgICBhd2FpdCBTdG9yYWdlLnNldExhc3RFcnJvcihlcnJvcik7XG4gICAgTG9nZ2VyLmVycm9yKExPR19DVFgsIFwiQWxhcm0gaGFuZGxlciBmYWlsZWRcIiwgeyBlcnJvcjogZXJyLm1lc3NhZ2UgfSk7XG5cbiAgICBicm9hZGNhc3QoY3JlYXRlTWVzc2FnZShNZXNzYWdlVHlwZS5FUlJPUl9PQ0NVUlJFRCwgeyBlcnJvciB9KSk7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDAgTWVzc2FnZSBIYW5kbGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY2hyb21lLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKChyZXF1ZXN0LCBzZW5kZXIsIHNlbmRSZXNwb25zZSkgPT4ge1xuICBpZiAocmVxdWVzdC5hY3Rpb24gPT09IFwiZmV0Y2hQcmVkaWN0aW9uc1wiKSB7XG4gICAgaGFuZGxlRmV0Y2hQcmVkaWN0aW9ucyhyZXF1ZXN0LnVzZXJuYW1lcylcbiAgICAgIC50aGVuKChkYXRhKSA9PiBzZW5kUmVzcG9uc2UoeyBkYXRhIH0pKVxuICAgICAgLmNhdGNoKChlcnIpID0+IHtcbiAgICAgICAgTG9nZ2VyLmVycm9yKExPR19DVFgsIFwiUHJlZGljdGlvbiBmZXRjaCBmYWlsZWRcIiwgeyBlcnJvcjogZXJyLm1lc3NhZ2UgfSk7XG4gICAgICAgIHNlbmRSZXNwb25zZSh7IGRhdGE6IG51bGwsIGVycm9yOiBlcnIubWVzc2FnZSB9KTtcbiAgICAgIH0pO1xuICAgIHJldHVybiB0cnVlOyAvLyBLZWVwIGNoYW5uZWwgb3BlbiBmb3IgYXN5bmMgcmVzcG9uc2VcbiAgfVxuXG4gIGlmIChyZXF1ZXN0LmFjdGlvbiA9PT0gXCJmZXRjaFVzZXJDb250ZXN0SGlzdG9yeVwiKSB7XG4gICAgaGFuZGxlRmV0Y2hVc2VyQ29udGVzdEhpc3RvcnkocmVxdWVzdC51c2VybmFtZSlcbiAgICAgIC50aGVuKChkYXRhKSA9PiBzZW5kUmVzcG9uc2UoeyBkYXRhIH0pKVxuICAgICAgLmNhdGNoKChlcnIpID0+IHtcbiAgICAgICAgTG9nZ2VyLmVycm9yKExPR19DVFgsIFwiSGlzdG9yeSBmZXRjaCBmYWlsZWRcIiwgeyBlcnJvcjogZXJyLm1lc3NhZ2UgfSk7XG4gICAgICAgIHNlbmRSZXNwb25zZSh7IGRhdGE6IG51bGwsIGVycm9yOiBlcnIubWVzc2FnZSB9KTtcbiAgICAgIH0pO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG59KTtcblxuYXN5bmMgZnVuY3Rpb24gaGFuZGxlRmV0Y2hVc2VyQ29udGVzdEhpc3RvcnkodXNlcm5hbWUpIHtcbiAgY29uc3QgeyBkYXRhIH0gPSBhd2FpdCBTdG9yYWdlLmdldEhpc3RvcnkodXNlcm5hbWUpO1xuICByZXR1cm4gZGF0YTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gaGFuZGxlRmV0Y2hQcmVkaWN0aW9ucyh1c2VybmFtZXMpIHtcbiAgY29uc3QgcmVzdWx0cyA9IHt9O1xuICBjb25zdCB1c2Vyc1RvRmV0Y2ggPSBbXTtcblxuICBmb3IgKGNvbnN0IHVzZXJuYW1lIG9mIHVzZXJuYW1lcykge1xuICAgIGlmIChwcmVkaWN0aW9uQ2FjaGUuaGFzKHVzZXJuYW1lKSkge1xuICAgICAgcmVzdWx0c1t1c2VybmFtZV0gPSBwcmVkaWN0aW9uQ2FjaGUuZ2V0KHVzZXJuYW1lKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdXNlcnNUb0ZldGNoLnB1c2godXNlcm5hbWUpO1xuICAgIH1cbiAgfVxuXG4gIGlmICh1c2Vyc1RvRmV0Y2gubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHJlc3VsdHM7XG4gIH1cblxuICB0cnkge1xuICAgIC8vIEZvciBub3csIGdlbmVyYXRlIG1vY2sgZGF0YSB0byBkZW1vbnN0cmF0ZSBmdW5jdGlvbmFsaXR5IHdpdGhvdXQgYSBsaXZlIGJhY2tlbmRcbiAgICBmb3IgKGNvbnN0IHVzZXJuYW1lIG9mIHVzZXJzVG9GZXRjaCkge1xuICAgICAgY29uc3QgbW9ja0RlbHRhID0gTWF0aC5yYW5kb20oKSAqIDEwMCAtIDUwO1xuICAgICAgY29uc3QgZGF0YSA9IHtcbiAgICAgICAgZGVsdGE6IG1vY2tEZWx0YSxcbiAgICAgICAgbmV3UmF0aW5nOiAxODAwICsgbW9ja0RlbHRhLFxuICAgICAgfTtcbiAgICAgIHByZWRpY3Rpb25DYWNoZS5zZXQodXNlcm5hbWUsIGRhdGEpO1xuICAgICAgcmVzdWx0c1t1c2VybmFtZV0gPSBkYXRhO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBMb2dnZXIud2FybihMT0dfQ1RYLCBcIkZhaWxlZCB0byBmZXRjaCBmcm9tIGJhY2tlbmQsIHVzaW5nIG1vY2sgZGF0YVwiLCB7XG4gICAgICBlcnJvcjogZXJyb3IubWVzc2FnZSxcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiByZXN1bHRzO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIjs7QUFPTyxNQUFNLGNBQWM7QUFBQTtBQUFBLElBRXpCLG9CQUFvQjtBQUFBO0FBQUEsSUFFcEIsaUJBQWlCO0FBQUE7QUFBQSxJQUVqQixlQUFlO0FBQUE7QUFBQSxJQUVmLGdCQUFnQjtBQUFBLEVBQ2xCO0FBUU8sV0FBUyxjQUFjLE1BQU0sVUFBVSxDQUFDLEdBQUc7QUFDaEQsV0FBTyxFQUFFLE1BQU0sU0FBUyxXQUFXLEtBQUssSUFBSSxFQUFFO0FBQUEsRUFDaEQ7OztBQ2xCQSxNQUFNLGVBQWUsS0FBSyxLQUFLLEtBQUs7QUFHcEMsTUFBTSxxQkFBcUIsS0FBSyxLQUFLO0FBR3JDLE1BQU0saUJBQWlCLElBQUksS0FBSyxLQUFLO0FBRTlCLE1BQU0sVUFBVTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLElBUXJCLE1BQU0sV0FBVyxVQUFVO0FBQ3pCLFlBQU0sTUFBTSxXQUFXLFFBQVE7QUFDL0IsYUFBTyxJQUFJLFFBQVEsQ0FBQyxZQUFZO0FBQzlCLGVBQU8sUUFBUSxNQUFNLElBQUksQ0FBQyxHQUFHLEdBQUcsQ0FBQyxXQUFXO0FBQzFDLGdCQUFNLFFBQVEsT0FBTyxHQUFHO0FBQ3hCLGNBQUksQ0FBQyxTQUFTLENBQUMsTUFBTSxXQUFXO0FB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
