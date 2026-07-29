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
  var API_URL = "http://localhost:8000/api/v1";
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
  async function addOrUpdateHistoryEntry(record, username) {
    const { data: history } = await Storage.getHistory(username);
    const mappedRecord = {
      name: record.contest_title,
      actualRating: record.actual_rating,
      predictedRating: record.predicted_rating || "-",
      delta: record.actual_delta !== null ? record.actual_delta : record.predicted_delta
    };
    const existingIdx = history.findIndex((r) => r.name === mappedRecord.name);
    if (existingIdx >= 0) {
      history[existingIdx] = mappedRecord;
    } else {
      history.push(mappedRecord);
    }
    await Storage.saveHistory(username, history);
  }
  async function refreshHistory(username) {
    Logger.info(LOG_CTX, "Refreshing history from backend", { username });
    try {
      const res = await fetch(`${API_URL}/user/${username}/history?limit=5`);
      if (res.ok) {
        const history = await res.json();
        for (const record of history) {
          await addOrUpdateHistoryEntry(record, username);
        }
        await Storage.setLastError(null);
        Logger.info(LOG_CTX, "History refreshed successfully", {
          username,
          count: history.length
        });
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
      }
      const predStatus = await Storage.getPredictionStatus();
      if (predStatus && predStatus.status === "waiting") {
        if (Date.now() < predStatus.nextRetryAt) {
          Logger.info(LOG_CTX, "Skipping prediction poll \u2014 backoff active", {
            nextRetryAt: new Date(predStatus.nextRetryAt).toISOString(),
            retryCount: predStatus.retryCount
          });
          return;
        }
      }
      let prediction = null;
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
              ranking
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
          const recent = contests[0];
          if (recent.ranking) {
            Logger.info(LOG_CTX, "Found recent contest with ranking", {
              contest: recent.titleSlug,
              ranking: recent.ranking
            });
            const predRes = await fetch(
              `${API_URL}/user/${username}/predict`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  contest_slug: recent.titleSlug,
                  contest_title: recent.title
                })
              }
            );
            if (predRes.ok) {
              prediction = await predRes.json();
            } else if (predRes.status === 202) {
              const currentRetry = predStatus ? predStatus.retryCount : 0;
              const newStatus = {
                contestSlug: recent.titleSlug,
                status: "waiting",
                lastChecked: Date.now(),
                retryCount: currentRetry + 1,
                nextRetryAt: Storage.calculateNextRetry(currentRetry)
              };
              await Storage.savePredictionStatus(newStatus);
              await Storage.setLastError(
                createError(ErrorCode.PREDICTION_PENDING)
              );
              Logger.info(LOG_CTX, "Prediction pending \u2014 backoff updated", {
                retryCount: newStatus.retryCount,
                nextRetryAt: new Date(newStatus.nextRetryAt).toISOString()
              });
              broadcast(
                createMessage(MessageType.ERROR_OCCURRED, {
                  error: createError(ErrorCode.PREDICTION_PENDING)
                })
              );
              return;
            }
          }
        }
      } else {
        Logger.warn(LOG_CTX, "LeetCode GraphQL request failed", {
          status: gqlRes.status
        });
      }
      if (!prediction) return;
      Logger.info(LOG_CTX, "Prediction received", {
        contest: prediction.contest_title || prediction.contest_slug,
        rating: prediction.predicted_rating,
        delta: prediction.predicted_delta
      });
      await Storage.clearPredictionStatus();
      await Storage.setLastError(null);
      const { data: history } = await Storage.getHistory(username);
      const existingIdx = history.findIndex(
        (r) => r.name === prediction.contest_title
      );
      let changed = false;
      if (prediction.status === "pending" && existingIdx === -1) {
        const mappedRecord = {
          name: prediction.contest_title,
          actualRating: null,
          predictedRating: prediction.predicted_rating,
          delta: prediction.predicted_delta
        };
        history.unshift(mappedRecord);
        changed = true;
      } else if (prediction.status === "confirmed" && existingIdx >= 0) {
        if (history[existingIdx].actualRating === null || history[existingIdx].actualRating === void 0) {
          history[existingIdx].actualRating = prediction.actual_rating;
          history[existingIdx].delta = prediction.actual_delta;
          changed = true;
        }
      }
      if (changed) {
        await Storage.saveHistory(username, history);
        broadcast(
          createMessage(MessageType.PREDICTION_UPDATED, {
            username,
            contest: prediction.contest_title
          })
        );
        broadcast(createMessage(MessageType.HISTORY_UPDATED, { username }));
      }
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL3NjcmlwdHMvbGliL21lc3NhZ2VUeXBlcy5qcyIsICIuLi8uLi9zcmMvc2NyaXB0cy9saWIvc3RvcmFnZS5qcyIsICIuLi8uLi9zcmMvc2NyaXB0cy9saWIvZXJyb3JzLmpzIiwgIi4uLy4uL3NyYy9zY3JpcHRzL2xpYi9sb2dnZXIuanMiLCAiLi4vLi4vc3JjL3NjcmlwdHMvYmFja2dyb3VuZC5qcyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBUeXBlZCBicm9hZGNhc3QgbWVzc2FnZSBjb25zdGFudHMgYW5kIGZhY3RvcnkuXG4gKlxuICogQWxsIGludGVyLWNvbXBvbmVudCBtZXNzYWdpbmcgKGJhY2tncm91bmQgXHUyMTk0IHBvcHVwIFx1MjE5NCBjb250ZW50IHNjcmlwdHMpXG4gKiB1c2VzIHRoZXNlIHR5cGVzIHRvIGVuc3VyZSBjb25zaXN0ZW5jeSBhbmQgZnV0dXJlLXByb29maW5nLlxuICovXG5cbmV4cG9ydCBjb25zdCBNZXNzYWdlVHlwZSA9IHtcbiAgLyoqIFByZWRpY3Rpb24gZGF0YSB3YXMgdXBkYXRlZCBvciBuZXdseSBhdmFpbGFibGUgKi9cbiAgUFJFRElDVElPTl9VUERBVEVEOiBcIlBSRURJQ1RJT05fVVBEQVRFRFwiLFxuICAvKiogQ29udGVzdCBoaXN0b3J5IHdhcyByZWZyZXNoZWQgb3IgbW9kaWZpZWQgKi9cbiAgSElTVE9SWV9VUERBVEVEOiBcIkhJU1RPUllfVVBEQVRFRFwiLFxuICAvKiogVXNlciBsb2dpbiBzdGF0ZSBjaGFuZ2VkIChsb2dnZWQgaW4gLyBvdXQgLyBkaWZmZXJlbnQgdXNlcikgKi9cbiAgTE9HSU5fQ0hBTkdFRDogXCJMT0dJTl9DSEFOR0VEXCIsXG4gIC8qKiBBbiBlcnJvciBvY2N1cnJlZCB0aGF0IHRoZSBVSSBzaG91bGQgZGlzcGxheSAqL1xuICBFUlJPUl9PQ0NVUlJFRDogXCJFUlJPUl9PQ0NVUlJFRFwiLFxufTtcblxuLyoqXG4gKiBDcmVhdGUgYSB0eXBlZCBtZXNzYWdlIGVudmVsb3BlLlxuICogQHBhcmFtIHtzdHJpbmd9IHR5cGUgLSBPbmUgb2YgTWVzc2FnZVR5cGUgdmFsdWVzLlxuICogQHBhcmFtIHtvYmplY3R9IFtwYXlsb2FkPXt9XSAtIEFyYml0cmFyeSBwYXlsb2FkIGRhdGEuXG4gKiBAcmV0dXJucyB7eyB0eXBlOiBzdHJpbmcsIHBheWxvYWQ6IG9iamVjdCwgdGltZXN0YW1wOiBudW1iZXIgfX1cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZU1lc3NhZ2UodHlwZSwgcGF5bG9hZCA9IHt9KSB7XG4gIHJldHVybiB7IHR5cGUsIHBheWxvYWQsIHRpbWVzdGFtcDogRGF0ZS5ub3coKSB9O1xufVxuIiwgIi8qKlxuICogQ2VudHJhbCBDaHJvbWUgU3RvcmFnZSBNYW5hZ2VyLlxuICpcbiAqIFdyYXBzIGFsbCBjaHJvbWUuc3RvcmFnZS5sb2NhbCBvcGVyYXRpb25zIGJlaGluZCBhIGNsZWFuIEFQSS5cbiAqIEhhbmRsZXMgY2FjaGUgZXhwaXJhdGlvbiAoU3VnZ2VzdGlvbiAxKSBhbmQgcHJlZGljdGlvbiBiYWNrb2ZmIHN0YXRlIChTdWdnZXN0aW9uIDIpLlxuICovXG5cbi8qKiBDYWNoZSBUVEw6IDI0IGhvdXJzIGluIG1pbGxpc2Vjb25kcyAqL1xuY29uc3QgQ0FDSEVfVFRMX01TID0gMjQgKiA2MCAqIDYwICogMTAwMDtcblxuLyoqIEluaXRpYWwgYmFja29mZiBpbnRlcnZhbDogMjAgbWludXRlcyBpbiBtaWxsaXNlY29uZHMgKi9cbmNvbnN0IElOSVRJQUxfQkFDS09GRl9NUyA9IDIwICogNjAgKiAxMDAwO1xuXG4vKiogTWF4aW11bSBiYWNrb2ZmIGludGVydmFsOiA2IGhvdXJzIGluIG1pbGxpc2Vjb25kcyAqL1xuY29uc3QgTUFYX0JBQ0tPRkZfTVMgPSA2ICogNjAgKiA2MCAqIDEwMDA7XG5cbmV4cG9ydCBjb25zdCBTdG9yYWdlID0ge1xuICAvLyBcdTI1MDBcdTI1MDAgSGlzdG9yeSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICAvKipcbiAgICogR2V0IGNvbnRlc3QgaGlzdG9yeSBmb3IgYSB1c2VyLCBjaGVja2luZyBjYWNoZSBmcmVzaG5lc3MuXG4gICAqIEBwYXJhbSB7c3RyaW5nfSB1c2VybmFtZVxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTx7IGRhdGE6IEFycmF5LCB1cGRhdGVkQXQ6IG51bWJlciwgaXNTdGFsZTogYm9vbGVhbiB9Pn1cbiAgICovXG4gIGFzeW5jIGdldEhpc3RvcnkodXNlcm5hbWUpIHtcbiAgICBjb25zdCBrZXkgPSBgaGlzdG9yeV8ke3VzZXJuYW1lfWA7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoW2tleV0sIChyZXN1bHQpID0+IHtcbiAgICAgICAgY29uc3QgZW50cnkgPSByZXN1bHRba2V5XTtcbiAgICAgICAgaWYgKCFlbnRyeSB8fCAhZW50cnkudXBkYXRlZEF0KSB7XG4gICAgICAgICAgcmVzb2x2ZSh7IGRhdGE6IFtdLCB1cGRhdGVkQXQ6IDAsIGlzU3RhbGU6IHRydWUgfSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGlzU3RhbGUgPSBEYXRlLm5vdygpIC0gZW50cnkudXBkYXRlZEF0ID4gQ0FDSEVfVFRMX01TO1xuICAgICAgICByZXNvbHZlKHsgZGF0YTogZW50cnkuZGF0YSB8fCBbXSwgdXBkYXRlZEF0OiBlbnRyeS51cGRhdGVkQXQsIGlzU3RhbGUgfSk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSxcblxuICAvKipcbiAgICogU2F2ZSBjb250ZXN0IGhpc3Rvcnkgd2l0aCBhIGZyZXNoIHRpbWVzdGFtcC5cbiAgICogQHBhcmFtIHtzdHJpbmd9IHVzZXJuYW1lXG4gICAqIEBwYXJhbSB7QXJyYXl9IGRhdGFcbiAgICogQHJldHVybnMge1Byb21pc2U8dm9pZD59XG4gICAqL1xuICBhc3luYyBzYXZlSGlzdG9yeSh1c2VybmFtZSwgZGF0YSkge1xuICAgIGNvbnN0IGtleSA9IGBoaXN0b3J5XyR7dXNlcm5hbWV9YDtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICAgIGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldChcbiAgICAgICAgeyBba2V5XTogeyBkYXRhLCB1cGRhdGVkQXQ6IERhdGUubm93KCkgfSB9LFxuICAgICAgICByZXNvbHZlXG4gICAgICApO1xuICAgIH0pO1xuICB9LFxuXG4gIC8qKlxuICAgKiBDaGVjayBpZiBhIGhpc3RvcnkgY2FjaGUgZW50cnkgaXMgc3RhbGUgKD4yNGgpLlxuICAgKiBAcGFyYW0ge3sgdXBkYXRlZEF0OiBudW1iZXIgfX0gZW50cnlcbiAgICogQHJldHVybnMge2Jvb2xlYW59XG4gICAqL1xuICBpc0hpc3RvcnlTdGFsZShlbnRyeSkge1xuICAgIGlmICghZW50cnkgfHwgIWVudHJ5LnVwZGF0ZWRBdCkgcmV0dXJuIHRydWU7XG4gICAgcmV0dXJuIERhdGUubm93KCkgLSBlbnRyeS51cGRhdGVkQXQgPiBDQUNIRV9UVExfTVM7XG4gIH0sXG5cbiAgLy8gXHUyNTAwXHUyNTAwIFByZWRpY3Rpb24gU3RhdHVzIChFeHBvbmVudGlhbCBCYWNrb2ZmKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICAvKipcbiAgICogR2V0IHRoZSBjdXJyZW50IHByZWRpY3Rpb24gcG9sbGluZyBzdGF0dXMuXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPG9iamVjdHxudWxsPn1cbiAgICovXG4gIGFzeW5jIGdldFByZWRpY3Rpb25TdGF0dXMoKSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoW1wicHJlZGljdGlvbl9zdGF0dXNcIl0sIChyZXN1bHQpID0+IHtcbiAgICAgICAgcmVzb2x2ZShyZXN1bHQucHJlZGljdGlvbl9zdGF0dXMgfHwgbnVsbCk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSxcblxuICAvKipcbiAgICogU2F2ZSBwcmVkaWN0aW9uIHBvbGxpbmcgc3RhdHVzIHdpdGggYmFja29mZiBzdGF0ZS5cbiAgICogQHBhcmFtIHtvYmplY3R9IHN0YXR1cyAtIHsgY29udGVzdFNsdWcsIHN0YXR1cywgbGFzdENoZWNrZWQsIHJldHJ5Q291bnQsIG5leHRSZXRyeUF0IH1cbiAgICogQHJldHVybnMge1Byb21pc2U8dm9pZD59XG4gICAqL1xuICBhc3luYyBzYXZlUHJlZGljdGlvblN0YXR1cyhzdGF0dXMpIHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICAgIGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IHByZWRpY3Rpb25fc3RhdHVzOiBzdGF0dXMgfSwgcmVzb2x2ZSk7XG4gICAgfSk7XG4gIH0sXG5cbiAgLyoqXG4gICAqIENsZWFyIHByZWRpY3Rpb24gc3RhdHVzIChwcmVkaWN0aW9uIHJlc29sdmVkIG9yIGNvbmZpcm1lZCkuXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPHZvaWQ+fVxuICAgKi9cbiAgYXN5bmMgY2xlYXJQcmVkaWN0aW9uU3RhdHVzKCkge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgICAgY2hyb21lLnN0b3JhZ2UubG9jYWwucmVtb3ZlKFwicHJlZGljdGlvbl9zdGF0dXNcIiwgcmVzb2x2ZSk7XG4gICAgfSk7XG4gIH0sXG5cbiAgLyoqXG4gICAqIENhbGN1bGF0ZSB0aGUgbmV4dCByZXRyeSB0aW1lc3RhbXAgdXNpbmcgZXhwb25lbnRpYWwgYmFja29mZi5cbiAgICogU2NoZWR1bGU6IDIwbSBcdTIxOTIgNDBtIFx1MjE5MiA4MG0gXHUyMTkyIDE2MG0gXHUyMTkyIDMyMG0gXHUyMTkyIDM2MG0gKGNhcClcbiAgICogQHBhcmFtIHtudW1iZXJ9IHJldHJ5Q291bnQgLSBDdXJyZW50IHJldHJ5IGNvdW50ICgwLWluZGV4ZWQpLlxuICAgKiBAcmV0dXJucyB7bnVtYmVyfSBUaW1lc3RhbXAgKG1zKSBmb3IgbmV4dCBhbGxvd2VkIHJldHJ5LlxuICAgKi9cbiAgY2FsY3VsYXRlTmV4dFJldHJ5KHJldHJ5Q291bnQpIHtcbiAgICBjb25zdCBkZWxheU1zID0gTWF0aC5taW4oXG4gICAgICBJTklUSUFMX0JBQ0tPRkZfTVMgKiBNYXRoLnBvdygyLCByZXRyeUNvdW50KSxcbiAgICAgIE1BWF9CQUNLT0ZGX01TXG4gICAgKTtcbiAgICByZXR1cm4gRGF0ZS5ub3coKSArIGRlbGF5TXM7XG4gIH0sXG5cbiAgLy8gXHUyNTAwXHUyNTAwIFVzZXJuYW1lIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIC8qKlxuICAgKiBHZXQgdGhlIHN0b3JlZCBMZWV0Q29kZSB1c2VybmFtZS5cbiAgICogQHJldHVybnMge1Byb21pc2U8c3RyaW5nfG51bGw+fVxuICAgKi9cbiAgYXN5bmMgZ2V0VXNlcm5hbWUoKSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoW1wibGNfdXNlcm5hbWVcIl0sIChyZXN1bHQpID0+IHtcbiAgICAgICAgcmVzb2x2ZShyZXN1bHQubGNfdXNlcm5hbWUgfHwgbnVsbCk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSxcblxuICAvKipcbiAgICogU2F2ZSB0aGUgTGVldENvZGUgdXNlcm5hbWUuXG4gICAqIEBwYXJhbSB7c3RyaW5nfSB1c2VybmFtZVxuICAgKiBAcmV0dXJucyB7UHJvbWlzZTx2b2lkPn1cbiAgICovXG4gIGFzeW5jIHNldFVzZXJuYW1lKHVzZXJuYW1lKSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBsY191c2VybmFtZTogdXNlcm5hbWUgfSwgcmVzb2x2ZSk7XG4gICAgfSk7XG4gIH0sXG5cbiAgLy8gXHUyNTAwXHUyNTAwIExhc3QgRXJyb3IgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgLyoqXG4gICAqIFNhdmUgdGhlIGxhc3QgZXJyb3Igc3RhdGUgZm9yIFVJIGRpc3BsYXkuXG4gICAqIEBwYXJhbSB7b2JqZWN0fG51bGx9IGVycm9yIC0gRXJyb3Igb2JqZWN0IGZyb20gY3JlYXRlRXJyb3IoKSwgb3IgbnVsbCB0byBjbGVhci5cbiAgICogQHJldHVybnMge1Byb21pc2U8dm9pZD59XG4gICAqL1xuICBhc3luYyBzZXRMYXN0RXJyb3IoZXJyb3IpIHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICAgIGlmIChlcnJvciA9PT0gbnVsbCkge1xuICAgICAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5yZW1vdmUoXCJsYXN0X2Vycm9yXCIsIHJlc29sdmUpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgbGFzdF9lcnJvcjogZXJyb3IgfSwgcmVzb2x2ZSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0sXG5cbiAgLyoqXG4gICAqIEdldCB0aGUgbGFzdCBzdG9yZWQgZXJyb3IuXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPG9iamVjdHxudWxsPn1cbiAgICovXG4gIGFzeW5jIGdldExhc3RFcnJvcigpIHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICAgIGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChbXCJsYXN0X2Vycm9yXCJdLCAocmVzdWx0KSA9PiB7XG4gICAgICAgIHJlc29sdmUocmVzdWx0Lmxhc3RfZXJyb3IgfHwgbnVsbCk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSxcbn07XG4iLCAiLyoqXG4gKiBTdHJ1Y3R1cmVkIGVycm9yIGNvZGVzIGZvciB0aGUgZXh0ZW5zaW9uLlxuICpcbiAqIFRoZXNlIGNvZGVzIGFsbG93IHRoZSBwb3B1cCBhbmQgY29udGVudCBzY3JpcHRzIHRvIGRpc3BsYXlcbiAqIG1lYW5pbmdmdWwsIHVzZXItZnJpZW5kbHkgc3RhdHVzIG1lc3NhZ2VzIGluc3RlYWQgb2YgZ2VuZXJpYyBlcnJvcnMuXG4gKi9cblxuZXhwb3J0IGNvbnN0IEVycm9yQ29kZSA9IHtcbiAgLyoqIE5ldHdvcmsgcmVxdWVzdCBmYWlsZWQgKG5vIGNvbm5lY3Rpdml0eSwgRE5TLCB0aW1lb3V0KSAqL1xuICBORVRXT1JLX0VSUk9SOiBcIk5FVFdPUktfRVJST1JcIixcbiAgLyoqIExlZXRDb2RlIEdyYXBoUUwgQVBJIHJldHVybmVkIGFuIGVycm9yIG9yIHVuZXhwZWN0ZWQgc2hhcGUgKi9cbiAgR1JBUEhRTF9GQUlMRUQ6IFwiR1JBUEhRTF9GQUlMRURcIixcbiAgLyoqIFByZWRpY3Rpb24gaXMgbm90IHlldCBhdmFpbGFibGUgXHUyMDE0IHN0aWxsIGJlaW5nIGNhbGN1bGF0ZWQgKi9cbiAgUFJFRElDVElPTl9QRU5ESU5HOiBcIlBSRURJQ1RJT05fUEVORElOR1wiLFxuICAvKiogVGhlIHJlcXVlc3RlZCB1c2VyIHdhcyBub3QgZm91bmQgb24gTGVldENvZGUgKi9cbiAgVVNFUl9OT1RfRk9VTkQ6IFwiVVNFUl9OT1RfRk9VTkRcIixcbiAgLyoqIFRvbyBtYW55IHJlcXVlc3RzIFx1MjAxNCBiZWluZyByYXRlIGxpbWl0ZWQgKi9cbiAgUkFURV9MSU1JVEVEOiBcIlJBVEVfTElNSVRFRFwiLFxuICAvKiogQ2F0Y2gtYWxsIGZvciB1bmV4cGVjdGVkIGVycm9ycyAqL1xuICBVTktOT1dOX0VSUk9SOiBcIlVOS05PV05fRVJST1JcIixcbn07XG5cbi8qKlxuICogVXNlci1mcmllbmRseSBlcnJvciBtZXNzYWdlcyBmb3IgZWFjaCBjb2RlLlxuICovXG5jb25zdCBFcnJvck1lc3NhZ2VzID0ge1xuICBbRXJyb3JDb2RlLk5FVFdPUktfRVJST1JdOiBcIk5ldHdvcmsgZXJyb3IgXHUyMDE0IHdpbGwgcmV0cnkgYXV0b21hdGljYWxseS5cIixcbiAgW0Vycm9yQ29kZS5HUkFQSFFMX0ZBSUxFRF06IFwiRmFpbGVkIHRvIHJlYWNoIExlZXRDb2RlIFx1MjAxNCB3aWxsIHJldHJ5LlwiLFxuICBbRXJyb3JDb2RlLlBSRURJQ1RJT05fUEVORElOR106IFwiUHJlZGljdGlvbiBpcyBzdGlsbCBiZWluZyBjYWxjdWxhdGVkXHUyMDI2XCIsXG4gIFtFcnJvckNvZGUuVVNFUl9OT1RfRk9VTkRdOiBcIkxlZXRDb2RlIHVzZXIgbm90IGZvdW5kLlwiLFxuICBbRXJyb3JDb2RlLlJBVEVfTElNSVRFRF06IFwiVG9vIG1hbnkgcmVxdWVzdHMgXHUyMDE0IHNsb3dpbmcgZG93bi5cIixcbiAgW0Vycm9yQ29kZS5VTktOT1dOX0VSUk9SXTogXCJTb21ldGhpbmcgd2VudCB3cm9uZy5cIixcbn07XG5cbi8qKlxuICogQ3JlYXRlIGEgc3RydWN0dXJlZCBlcnJvciBvYmplY3QuXG4gKiBAcGFyYW0ge3N0cmluZ30gY29kZSAtIE9uZSBvZiBFcnJvckNvZGUgdmFsdWVzLlxuICogQHBhcmFtIHtzdHJpbmd9IFtkZXRhaWxdIC0gT3B0aW9uYWwgdGVjaG5pY2FsIGRldGFpbCBmb3IgbG9nZ2luZy5cbiAqIEByZXR1cm5zIHt7IGNvZGU6IHN0cmluZywgbWVzc2FnZTogc3RyaW5nLCBkZXRhaWw/OiBzdHJpbmcsIHRpbWVzdGFtcDogbnVtYmVyIH19XG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVFcnJvcihjb2RlLCBkZXRhaWwpIHtcbiAgcmV0dXJuIHtcbiAgICBjb2RlLFxuICAgIG1lc3NhZ2U6IEVycm9yTWVzc2FnZXNbY29kZV0gfHwgRXJyb3JNZXNzYWdlc1tFcnJvckNvZGUuVU5LTk9XTl9FUlJPUl0sXG4gICAgLi4uKGRldGFpbCA/IHsgZGV0YWlsIH0gOiB7fSksXG4gICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICB9O1xufVxuIiwgIi8qKlxuICogU3RydWN0dXJlZCBsb2dnZXIgZm9yIHRoZSBDaHJvbWUgZXh0ZW5zaW9uLlxuICpcbiAqIFJlcGxhY2VzIHJhdyBjb25zb2xlLmxvZy9lcnJvci93YXJuIGNhbGxzIHdpdGggc3RydWN0dXJlZCBvdXRwdXRcbiAqIHRoYXQgaW5jbHVkZXMgdGltZXN0YW1wcywgY29udGV4dCBtb2R1bGVzLCBhbmQgcmVsZXZhbnQgZGF0YS5cbiAqL1xuXG5leHBvcnQgY29uc3QgTG9nZ2VyID0ge1xuICAvKipcbiAgICogQHBhcmFtIHtzdHJpbmd9IGNvbnRleHQgLSBNb2R1bGUgbmFtZSAoZS5nLiwgXCJCYWNrZ3JvdW5kXCIsIFwiUG9wdXBcIikuXG4gICAqIEBwYXJhbSB7c3RyaW5nfSBtZXNzYWdlIC0gTG9nIG1lc3NhZ2UuXG4gICAqIEBwYXJhbSB7b2JqZWN0fSBbZGF0YV0gLSBPcHRpb25hbCBzdHJ1Y3R1cmVkIGRhdGEuXG4gICAqL1xuICBpbmZvKGNvbnRleHQsIG1lc3NhZ2UsIGRhdGEpIHtcbiAgICBjb25zdCBlbnRyeSA9IExvZ2dlci5fZm9ybWF0KFwiSU5GT1wiLCBjb250ZXh0LCBtZXNzYWdlLCBkYXRhKTtcbiAgICBjb25zb2xlLmxvZyhlbnRyeSk7XG4gIH0sXG5cbiAgd2Fybihjb250ZXh0LCBtZXNzYWdlLCBkYXRhKSB7XG4gICAgY29uc3QgZW50cnkgPSBMb2dnZXIuX2Zvcm1hdChcIldBUk5cIiwgY29udGV4dCwgbWVzc2FnZSwgZGF0YSk7XG4gICAgY29uc29sZS53YXJuKGVudHJ5KTtcbiAgfSxcblxuICBlcnJvcihjb250ZXh0LCBtZXNzYWdlLCBkYXRhKSB7XG4gICAgY29uc3QgZW50cnkgPSBMb2dnZXIuX2Zvcm1hdChcIkVSUk9SXCIsIGNvbnRleHQsIG1lc3NhZ2UsIGRhdGEpO1xuICAgIGNvbnNvbGUuZXJyb3IoZW50cnkpO1xuICB9LFxuXG4gIC8qKlxuICAgKiBGb3JtYXQgYSBzdHJ1Y3R1cmVkIGxvZyBlbnRyeS5cbiAgICogQHByaXZhdGVcbiAgICovXG4gIF9mb3JtYXQobGV2ZWwsIGNvbnRleHQsIG1lc3NhZ2UsIGRhdGEpIHtcbiAgICBjb25zdCB0aW1lc3RhbXAgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG4gICAgY29uc3QgYmFzZSA9IGBbJHt0aW1lc3RhbXB9XSBbJHtsZXZlbH1dIFske2NvbnRleHR9XSAke21lc3NhZ2V9YDtcbiAgICBpZiAoZGF0YSAhPT0gdW5kZWZpbmVkICYmIGRhdGEgIT09IG51bGwpIHtcbiAgICAgIC8vIEtlZXAgaXQgcmVhZGFibGUgaW4gdGhlIGNvbnNvbGVcbiAgICAgIHJldHVybiBgJHtiYXNlfSB8ICR7SlNPTi5zdHJpbmdpZnkoZGF0YSl9YDtcbiAgICB9XG4gICAgcmV0dXJuIGJhc2U7XG4gIH0sXG59O1xuIiwgIi8qKlxuICogQmFja2dyb3VuZCBTZXJ2aWNlIFdvcmtlclxuICpcbiAqIFJlc3BvbnNpYmlsaXRpZXM6XG4gKiAtIFVzZXIgZGV0ZWN0aW9uIChMZWV0Q29kZSBHcmFwaFFMKVxuICogLSBBbGFybS1iYXNlZCBwb2xsaW5nIHdpdGggZXhwb25lbnRpYWwgYmFja29mZlxuICogLSBDaHJvbWUgU3RvcmFnZSBtYW5hZ2VtZW50ICh2aWEgU3RvcmFnZSBoZWxwZXIpXG4gKiAtIEFQSSBjb21tdW5pY2F0aW9uIHdpdGggdGhlIGJhY2tlbmQgcHJveHlcbiAqIC0gQnJvYWRjYXN0aW5nIHR5cGVkIG1lc3NhZ2VzIHRvIHBvcHVwICYgY29udGVudCBzY3JpcHRzXG4gKi9cblxuLy8gXHUyNTAwXHUyNTAwIFNoYXJlZCBtb2R1bGVzIChpbmxpbmVkIGJ5IGJ1aWxkLmNqcykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5pbXBvcnQgeyBNZXNzYWdlVHlwZSwgY3JlYXRlTWVzc2FnZSB9IGZyb20gXCIuL2xpYi9tZXNzYWdlVHlwZXMuanNcIjtcbmltcG9ydCB7IFN0b3JhZ2UgfSBmcm9tIFwiLi9saWIvc3RvcmFnZS5qc1wiO1xuaW1wb3J0IHsgRXJyb3JDb2RlLCBjcmVhdGVFcnJvciB9IGZyb20gXCIuL2xpYi9lcnJvcnMuanNcIjtcbmltcG9ydCB7IExvZ2dlciB9IGZyb20gXCIuL2xpYi9sb2dnZXIuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwIENvbnN0YW50cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY29uc3QgQVBJX1VSTCA9IFwiaHR0cDovL2xvY2FsaG9zdDo4MDAwL2FwaS92MVwiOyAvLyBDaGFuZ2UgdG8geW91ciBob3N0ZWQgYmFja2VuZCBVUkxcblxuY29uc3QgTE9HX0NUWCA9IFwiQmFja2dyb3VuZFwiO1xuXG4vLyBTaW1wbGUgaW4tbWVtb3J5IGNhY2hlIGZvciBsZWFkZXJib2FyZCBwcmVkaWN0aW9uIGxvb2t1cHNcbmNvbnN0IHByZWRpY3Rpb25DYWNoZSA9IG5ldyBNYXAoKTtcblxuLy8gXHUyNTAwXHUyNTAwIFVzZXJuYW1lIERldGVjdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuYXN5bmMgZnVuY3Rpb24gZ2V0TGVldENvZGVVc2VybmFtZSgpIHtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChcImh0dHBzOi8vbGVldGNvZGUuY29tL2dyYXBocWxcIiwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGNyZWRlbnRpYWxzOiBcImluY2x1ZGVcIixcbiAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgcXVlcnk6IFwicXVlcnkgZ2xvYmFsRGF0YSB7IHVzZXJTdGF0dXMgeyB1c2VybmFtZSB9IH1cIixcbiAgICAgIH0pLFxuICAgIH0pO1xuICAgIGNvbnN0IGRhdGEgPSBhd2FpdCByZXMuanNvbigpO1xuICAgIHJldHVybiBkYXRhPy5kYXRhPy51c2VyU3RhdHVzPy51c2VybmFtZSB8fCBudWxsO1xuICB9IGNhdGNoIChlKSB7XG4gICAgTG9nZ2VyLmVycm9yKExPR19DVFgsIFwiRmFpbGVkIHRvIGRldGVjdCBMZWV0Q29kZSB1c2VybmFtZVwiLCB7IGVycm9yOiBlLm1lc3NhZ2UgfSk7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwIEhpc3RvcnkgTWFuYWdlbWVudCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBBZGQgb3IgdXBkYXRlIGEgc2luZ2xlIGNvbnRlc3QgcmVjb3JkIGluIHRoZSB1c2VyJ3MgaGlzdG9yeS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gYWRkT3JVcGRhdGVIaXN0b3J5RW50cnkocmVjb3JkLCB1c2VybmFtZSkge1xuICBjb25zdCB7IGRhdGE6IGhpc3RvcnkgfSA9IGF3YWl0IFN0b3JhZ2UuZ2V0SGlzdG9yeSh1c2VybmFtZSk7XG5cbiAgY29uc3QgbWFwcGVkUmVjb3JkID0ge1xuICAgIG5hbWU6IHJlY29yZC5jb250ZXN0X3RpdGxlLFxuICAgIGFjdHVhbFJhdGluZzogcmVjb3JkLmFjdHVhbF9yYXRpbmcsXG4gICAgcHJlZGljdGVkUmF0aW5nOiByZWNvcmQucHJlZGljdGVkX3JhdGluZyB8fCBcIi1cIixcbiAgICBkZWx0YTpcbiAgICAgIHJlY29yZC5hY3R1YWxfZGVsdGEgIT09IG51bGxcbiAgICAgICAgPyByZWNvcmQuYWN0dWFsX2RlbHRhXG4gICAgICAgIDogcmVjb3JkLnByZWRpY3RlZF9kZWx0YSxcbiAgfTtcblxuICBjb25zdCBleGlzdGluZ0lkeCA9IGhpc3RvcnkuZmluZEluZGV4KChyKSA9PiByLm5hbWUgPT09IG1hcHBlZFJlY29yZC5uYW1lKTtcbiAgaWYgKGV4aXN0aW5nSWR4ID49IDApIHtcbiAgICBoaXN0b3J5W2V4aXN0aW5nSWR4XSA9IG1hcHBlZFJlY29yZDtcbiAgfSBlbHNlIHtcbiAgICBoaXN0b3J5LnB1c2gobWFwcGVkUmVjb3JkKTtcbiAgfVxuXG4gIGF3YWl0IFN0b3JhZ2Uuc2F2ZUhpc3RvcnkodXNlcm5hbWUsIGhpc3RvcnkpO1xufVxuXG4vKipcbiAqIEZldGNoIGZyZXNoIGhpc3RvcnkgZnJvbSB0aGUgYmFja2VuZCBhbmQgc2F2ZSB0byBzdG9yYWdlLlxuICovXG5hc3luYyBmdW5jdGlvbiByZWZyZXNoSGlzdG9yeSh1c2VybmFtZSkge1xuICBMb2dnZXIuaW5mbyhMT0dfQ1RYLCBcIlJlZnJlc2hpbmcgaGlzdG9yeSBmcm9tIGJhY2tlbmRcIiwgeyB1c2VybmFtZSB9KTtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHtBUElfVVJMfS91c2VyLyR7dXNlcm5hbWV9L2hpc3Rvcnk/bGltaXQ9NWApO1xuICAgIGlmIChyZXMub2spIHtcbiAgICAgIGNvbnN0IGhpc3RvcnkgPSBhd2FpdCByZXMuanNvbigpO1xuICAgICAgZm9yIChjb25zdCByZWNvcmQgb2YgaGlzdG9yeSkge1xuICAgICAgICBhd2FpdCBhZGRPclVwZGF0ZUhpc3RvcnlFbnRyeShyZWNvcmQsIHVzZXJuYW1lKTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IFN0b3JhZ2Uuc2V0TGFzdEVycm9yKG51bGwpO1xuICAgICAgTG9nZ2VyLmluZm8oTE9HX0NUWCwgXCJIaXN0b3J5IHJlZnJlc2hlZCBzdWNjZXNzZnVsbHlcIiwge1xuICAgICAgICB1c2VybmFtZSxcbiAgICAgICAgY291bnQ6IGhpc3RvcnkubGVuZ3RoLFxuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQmFja2VuZCByZXR1cm5lZCAke3Jlcy5zdGF0dXN9YCk7XG4gICAgfVxuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zdCBlcnJvciA9IGNyZWF0ZUVycm9yKEVycm9yQ29kZS5ORVRXT1JLX0VSUk9SLCBlcnIubWVzc2FnZSk7XG4gICAgYXdhaXQgU3RvcmFnZS5zZXRMYXN0RXJyb3IoZXJyb3IpO1xuICAgIExvZ2dlci5lcnJvcihMT0dfQ1RYLCBcIkZhaWxlZCB0byByZWZyZXNoIGhpc3RvcnlcIiwgeyB1c2VybmFtZSwgZXJyb3I6IGVyci5tZXNzYWdlIH0pO1xuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBCcm9hZGNhc3QgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogQnJvYWRjYXN0IGEgdHlwZWQgbWVzc2FnZSB0byBwb3B1cCBhbmQgYWxsIExlZXRDb2RlIHRhYnMuXG4gKi9cbmZ1bmN0aW9uIGJyb2FkY2FzdChtZXNzYWdlKSB7XG4gIC8vIE5vdGlmeSBwb3B1cCAobWF5IG5vdCBiZSBvcGVuIFx1MjAxNCB0aGF0J3MgZmluZSwgY2F0Y2ggc2lsZW50bHkpXG4gIGNocm9tZS5ydW50aW1lLnNlbmRNZXNzYWdlKG1lc3NhZ2UpLmNhdGNoKCgpID0+IHt9KTtcblxuICAvLyBOb3RpZnkgYWN0aXZlIExlZXRDb2RlIHRhYnNcbiAgY2hyb21lLnRhYnMucXVlcnkoeyB1cmw6IFwiKjovL2xlZXRjb2RlLmNvbS8qXCIgfSwgKHRhYnMpID0+IHtcbiAgICBmb3IgKGNvbnN0IHRhYiBvZiB0YWJzKSB7XG4gICAgICBjaHJvbWUudGFicy5zZW5kTWVzc2FnZSh0YWIuaWQsIG1lc3NhZ2UpLmNhdGNoKCgpID0+IHt9KTtcbiAgICB9XG4gIH0pO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgTGlmZWN5Y2xlIEV2ZW50cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY2hyb21lLnJ1bnRpbWUub25TdGFydHVwLmFkZExpc3RlbmVyKCgpID0+IHtcbiAgTG9nZ2VyLmluZm8oTE9HX0NUWCwgXCJFeHRlbnNpb24gc3RhcnR1cCBcdTIwMTQgY3JlYXRpbmcgYWxhcm1cIik7XG4gIGNocm9tZS5hbGFybXMuY3JlYXRlKFwiY2hlY2tQZW5kaW5nUHJlZGljdGlvblwiLCB7IHBlcmlvZEluTWludXRlczogMjAgfSk7XG59KTtcblxuY2hyb21lLnJ1bnRpbWUub25JbnN0YWxsZWQuYWRkTGlzdGVuZXIoYXN5bmMgKGRldGFpbHMpID0+IHtcbiAgY2hyb21lLmFsYXJtcy5jcmVhdGUoXCJjaGVja1BlbmRpbmdQcmVkaWN0aW9uXCIsIHsgcGVyaW9kSW5NaW51dGVzOiAyMCB9KTtcblxuICBpZiAoZGV0YWlscy5yZWFzb24gPT09IFwiaW5zdGFsbFwiKSB7XG4gICAgTG9nZ2VyLmluZm8oTE9HX0NUWCwgXCJFeHRlbnNpb24gaW5zdGFsbGVkIFx1MjAxNCBkZXRlY3RpbmcgdXNlclwiKTtcbiAgICBjb25zdCB1c2VybmFtZSA9IGF3YWl0IGdldExlZXRDb2RlVXNlcm5hbWUoKTtcblxuICAgIGlmICh1c2VybmFtZSkge1xuICAgICAgYXdhaXQgU3RvcmFnZS5zZXRVc2VybmFtZSh1c2VybmFtZSk7XG4gICAgICBMb2dnZXIuaW5mbyhMT0dfQ1RYLCBcIlVzZXIgZGV0ZWN0ZWRcIiwgeyB1c2VybmFtZSB9KTtcblxuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgZmV0Y2goYCR7QVBJX1VSTH0vdXNlci8ke3VzZXJuYW1lfS9yZWdpc3RlcmAsIHsgbWV0aG9kOiBcIlBPU1RcIiB9KTtcbiAgICAgIH0gY2F0Y2ggKF8pIHtcbiAgICAgICAgLy8gUmVnaXN0ZXIgZW5kcG9pbnQgaXMgb3B0aW9uYWw7IGlnbm9yZSBmYWlsdXJlc1xuICAgICAgfVxuXG4gICAgICBhd2FpdCByZWZyZXNoSGlzdG9yeSh1c2VybmFtZSk7XG5cbiAgICAgIGJyb2FkY2FzdChjcmVhdGVNZXNzYWdlKE1lc3NhZ2VUeXBlLkxPR0lOX0NIQU5HRUQsIHsgdXNlcm5hbWUgfSkpO1xuICAgIH0gZWxzZSB7XG4gICAgICBMb2dnZXIud2FybihMT0dfQ1RYLCBcIk5vIExlZXRDb2RlIHVzZXIgZGV0ZWN0ZWQgZHVyaW5nIGluc3RhbGxcIik7XG4gICAgfVxuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwIEFsYXJtIEhhbmRsZXIgKFN1Z2dlc3Rpb24gMTogQ2FjaGUgRXhwaXJ5ICsgU3VnZ2VzdGlvbiAyOiBCYWNrb2ZmKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY2hyb21lLmFsYXJtcy5vbkFsYXJtLmFkZExpc3RlbmVyKGFzeW5jIChhbGFybSkgPT4ge1xuICBpZiAoYWxhcm0ubmFtZSAhPT0gXCJjaGVja1BlbmRpbmdQcmVkaWN0aW9uXCIpIHJldHVybjtcblxuICBjb25zdCB1c2VybmFtZSA9IGF3YWl0IFN0b3JhZ2UuZ2V0VXNlcm5hbWUoKTtcbiAgaWYgKCF1c2VybmFtZSkgcmV0dXJuO1xuXG4gIExvZ2dlci5pbmZvKExPR19DVFgsIFwiQWxhcm0gZmlyZWQgXHUyMDE0IGNoZWNraW5nIHByZWRpY3Rpb25zXCIsIHsgdXNlcm5hbWUgfSk7XG5cbiAgdHJ5IHtcbiAgICAvLyBcdTI1MDBcdTI1MDAgU3VnZ2VzdGlvbiAxOiBDaGVjayBpZiBoaXN0b3J5IGNhY2hlIGlzIHN0YWxlIFx1MjUwMFx1MjUwMFxuICAgIGNvbnN0IGNhY2hlZEhpc3RvcnkgPSBhd2FpdCBTdG9yYWdlLmdldEhpc3RvcnkodXNlcm5hbWUpO1xuICAgIGlmIChjYWNoZWRIaXN0b3J5LmlzU3RhbGUpIHtcbiAgICAgIExvZ2dlci5pbmZvKExPR19DVFgsIFwiSGlzdG9yeSBjYWNoZSBpcyBzdGFsZSBcdTIwMTQgcmVmcmVzaGluZ1wiLCB7IHVzZXJuYW1lIH0pO1xuICAgICAgYXdhaXQgcmVmcmVzaEhpc3RvcnkodXNlcm5hbWUpO1xuICAgIH1cblxuICAgIC8vIFx1MjUwMFx1MjUwMCBTdWdnZXN0aW9uIDI6IENoZWNrIGJhY2tvZmYgYmVmb3JlIHBvbGxpbmcgcHJlZGljdGlvbnMgXHUyNTAwXHUyNTAwXG4gICAgY29uc3QgcHJlZFN0YXR1cyA9IGF3YWl0IFN0b3JhZ2UuZ2V0UHJlZGljdGlvblN0YXR1cygpO1xuXG4gICAgaWYgKHByZWRTdGF0dXMgJiYgcHJlZFN0YXR1cy5zdGF0dXMgPT09IFwid2FpdGluZ1wiKSB7XG4gICAgICBpZiAoRGF0ZS5ub3coKSA8IHByZWRTdGF0dXMubmV4dFJldHJ5QXQpIHtcbiAgICAgICAgTG9nZ2VyLmluZm8oTE9HX0NUWCwgXCJTa2lwcGluZyBwcmVkaWN0aW9uIHBvbGwgXHUyMDE0IGJhY2tvZmYgYWN0aXZlXCIsIHtcbiAgICAgICAgICBuZXh0UmV0cnlBdDogbmV3IERhdGUocHJlZFN0YXR1cy5uZXh0UmV0cnlBdCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgICByZXRyeUNvdW50OiBwcmVkU3RhdHVzLnJldHJ5Q291bnQsXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gXHUyNTAwXHUyNTAwIEZldGNoIGxhdGVzdCBjb250ZXN0IGZyb20gTGVldENvZGUgXHUyNTAwXHUyNTAwXG4gICAgbGV0IHByZWRpY3Rpb24gPSBudWxsO1xuXG4gICAgY29uc3QgZ3FsUmVzID0gYXdhaXQgZmV0Y2goXCJodHRwczovL2xlZXRjb2RlLmNvbS9ncmFwaHFsXCIsIHtcbiAgICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgICBjcmVkZW50aWFsczogXCJpbmNsdWRlXCIsXG4gICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIHF1ZXJ5OiBgcXVlcnkgY29udGVzdFYyTXlDb250ZXN0cygkc2tpcDogSW50ISwgJGxpbWl0OiBJbnQhLCAkaXNWaXJ0dWFsOiBCb29sZWFuKSB7XG4gICAgICAgICAgY29udGVzdFYyTXlDb250ZXN0cyhza2lwOiAkc2tpcCwgbGltaXQ6ICRsaW1pdCwgaXNWaXJ0dWFsOiAkaXNWaXJ0dWFsKSB7XG4gICAgICAgICAgICBjb250ZXN0cyB7XG4gICAgICAgICAgICAgIHRpdGxlU2x1Z1xuICAgICAgICAgICAgICB0aXRsZVxuICAgICAgICAgICAgICBzdGFydFRpbWVcbiAgICAgICAgICAgICAgcmFua2luZ1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfWAsXG4gICAgICAgIHZhcmlhYmxlczogeyBza2lwOiAwLCBsaW1pdDogMSwgaXNWaXJ0dWFsOiBmYWxzZSB9LFxuICAgICAgfSksXG4gICAgfSk7XG5cbiAgICBpZiAoZ3FsUmVzLm9rKSB7XG4gICAgICBjb25zdCBncWxEYXRhID0gYXdhaXQgZ3FsUmVzLmpzb24oKTtcbiAgICAgIGNvbnN0IGNvbnRlc3RzID1cbiAgICAgICAgZ3FsRGF0YT8uZGF0YT8uY29udGVzdFYyTXlDb250ZXN0cz8uY29udGVzdHMgfHwgW107XG5cbiAgICAgIGlmIChjb250ZXN0cy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGNvbnN0IHJlY2VudCA9IGNvbnRlc3RzWzBdO1xuICAgICAgICBpZiAocmVjZW50LnJhbmtpbmcpIHtcbiAgICAgICAgICBMb2dnZXIuaW5mbyhMT0dfQ1RYLCBcIkZvdW5kIHJlY2VudCBjb250ZXN0IHdpdGggcmFua2luZ1wiLCB7XG4gICAgICAgICAgICBjb250ZXN0OiByZWNlbnQudGl0bGVTbHVnLFxuICAgICAgICAgICAgcmFua2luZzogcmVjZW50LnJhbmtpbmcsXG4gICAgICAgICAgfSk7XG5cbiAgICAgICAgICBjb25zdCBwcmVkUmVzID0gYXdhaXQgZmV0Y2goXG4gICAgICAgICAgICBgJHtBUElfVVJMfS91c2VyLyR7dXNlcm5hbWV9L3ByZWRpY3RgLFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgICAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgICAgICBjb250ZXN0X3NsdWc6IHJlY2VudC50aXRsZVNsdWcsXG4gICAgICAgICAgICAgICAgY29udGVzdF90aXRsZTogcmVjZW50LnRpdGxlLFxuICAgICAgICAgICAgICB9KSxcbiAgICAgICAgICAgIH1cbiAgICAgICAgICApO1xuXG4gICAgICAgICAgaWYgKHByZWRSZXMub2spIHtcbiAgICAgICAgICAgIHByZWRpY3Rpb24gPSBhd2FpdCBwcmVkUmVzLmpzb24oKTtcbiAgICAgICAgICB9IGVsc2UgaWYgKHByZWRSZXMuc3RhdHVzID09PSAyMDIpIHtcbiAgICAgICAgICAgIC8vIFByZWRpY3Rpb24gbm90IHlldCBhdmFpbGFibGUgXHUyMDE0IHVwZGF0ZSBiYWNrb2ZmXG4gICAgICAgICAgICBjb25zdCBjdXJyZW50UmV0cnkgPSBwcmVkU3RhdHVzID8gcHJlZFN0YXR1cy5yZXRyeUNvdW50IDogMDtcbiAgICAgICAgICAgIGNvbnN0IG5ld1N0YXR1cyA9IHtcbiAgICAgICAgICAgICAgY29udGVzdFNsdWc6IHJlY2VudC50aXRsZVNsdWcsXG4gICAgICAgICAgICAgIHN0YXR1czogXCJ3YWl0aW5nXCIsXG4gICAgICAgICAgICAgIGxhc3RDaGVja2VkOiBEYXRlLm5vdygpLFxuICAgICAgICAgICAgICByZXRyeUNvdW50OiBjdXJyZW50UmV0cnkgKyAxLFxuICAgICAgICAgICAgICBuZXh0UmV0cnlBdDogU3RvcmFnZS5jYWxjdWxhdGVOZXh0UmV0cnkoY3VycmVudFJldHJ5KSxcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBhd2FpdCBTdG9yYWdlLnNhdmVQcmVkaWN0aW9uU3RhdHVzKG5ld1N0YXR1cyk7XG4gICAgICAgICAgICBhd2FpdCBTdG9yYWdlLnNldExhc3RFcnJvcihcbiAgICAgICAgICAgICAgY3JlYXRlRXJyb3IoRXJyb3JDb2RlLlBSRURJQ1RJT05fUEVORElORylcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIExvZ2dlci5pbmZvKExPR19DVFgsIFwiUHJlZGljdGlvbiBwZW5kaW5nIFx1MjAxNCBiYWNrb2ZmIHVwZGF0ZWRcIiwge1xuICAgICAgICAgICAgICByZXRyeUNvdW50OiBuZXdTdGF0dXMucmV0cnlDb3VudCxcbiAgICAgICAgICAgICAgbmV4dFJldHJ5QXQ6IG5ldyBEYXRlKG5ld1N0YXR1cy5uZXh0UmV0cnlBdCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBicm9hZGNhc3QoXG4gICAgICAgICAgICAgIGNyZWF0ZU1lc3NhZ2UoTWVzc2FnZVR5cGUuRVJST1JfT0NDVVJSRUQsIHtcbiAgICAgICAgICAgICAgICBlcnJvcjogY3JlYXRlRXJyb3IoRXJyb3JDb2RlLlBSRURJQ1RJT05fUEVORElORyksXG4gICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBMb2dnZXIud2FybihMT0dfQ1RYLCBcIkxlZXRDb2RlIEdyYXBoUUwgcmVxdWVzdCBmYWlsZWRcIiwge1xuICAgICAgICBzdGF0dXM6IGdxbFJlcy5zdGF0dXMsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBpZiAoIXByZWRpY3Rpb24pIHJldHVybjtcblxuICAgIC8vIFx1MjUwMFx1MjUwMCBQcmVkaWN0aW9uIGZvdW5kISBVcGRhdGUgaGlzdG9yeSBhbmQgY2xlYXIgYmFja29mZiBcdTI1MDBcdTI1MDBcbiAgICBMb2dnZXIuaW5mbyhMT0dfQ1RYLCBcIlByZWRpY3Rpb24gcmVjZWl2ZWRcIiwge1xuICAgICAgY29udGVzdDogcHJlZGljdGlvbi5jb250ZXN0X3RpdGxlIHx8IHByZWRpY3Rpb24uY29udGVzdF9zbHVnLFxuICAgICAgcmF0aW5nOiBwcmVkaWN0aW9uLnByZWRpY3RlZF9yYXRpbmcsXG4gICAgICBkZWx0YTogcHJlZGljdGlvbi5wcmVkaWN0ZWRfZGVsdGEsXG4gICAgfSk7XG5cbiAgICBhd2FpdCBTdG9yYWdlLmNsZWFyUHJlZGljdGlvblN0YXR1cygpO1xuICAgIGF3YWl0IFN0b3JhZ2Uuc2V0TGFzdEVycm9yKG51bGwpO1xuXG4gICAgY29uc3QgeyBkYXRhOiBoaXN0b3J5IH0gPSBhd2FpdCBTdG9yYWdlLmdldEhpc3RvcnkodXNlcm5hbWUpO1xuICAgIGNvbnN0IGV4aXN0aW5nSWR4ID0gaGlzdG9yeS5maW5kSW5kZXgoXG4gICAgICAocikgPT4gci5uYW1lID09PSBwcmVkaWN0aW9uLmNvbnRlc3RfdGl0bGVcbiAgICApO1xuXG4gICAgbGV0IGNoYW5nZWQgPSBmYWxzZTtcblxuICAgIGlmIChwcmVkaWN0aW9uLnN0YXR1cyA9PT0gXCJwZW5kaW5nXCIgJiYgZXhpc3RpbmdJZHggPT09IC0xKSB7XG4gICAgICAvLyBOZXcgcGVuZGluZyBwcmVkaWN0aW9uIG5vdCBpbiBoaXN0b3J5XG4gICAgICBjb25zdCBtYXBwZWRSZWNvcmQgPSB7XG4gICAgICAgIG5hbWU6IHByZWRpY3Rpb24uY29udGVzdF90aXRsZSxcbiAgICAgICAgYWN0dWFsUmF0aW5nOiBudWxsLFxuICAgICAgICBwcmVkaWN0ZWRSYXRpbmc6IHByZWRpY3Rpb24ucHJlZGljdGVkX3JhdGluZyxcbiAgICAgICAgZGVsdGE6IHByZWRpY3Rpb24ucHJlZGljdGVkX2RlbHRhLFxuICAgICAgfTtcbiAgICAgIGhpc3RvcnkudW5zaGlmdChtYXBwZWRSZWNvcmQpO1xuICAgICAgY2hhbmdlZCA9IHRydWU7XG4gICAgfSBlbHNlIGlmIChwcmVkaWN0aW9uLnN0YXR1cyA9PT0gXCJjb25maXJtZWRcIiAmJiBleGlzdGluZ0lkeCA+PSAwKSB7XG4gICAgICAvLyBMb2NrIGluIGFjdHVhbCByYXRpbmdcbiAgICAgIGlmIChcbiAgICAgICAgaGlzdG9yeVtleGlzdGluZ0lkeF0uYWN0dWFsUmF0aW5nID09PSBudWxsIHx8XG4gICAgICAgIGhpc3RvcnlbZXhpc3RpbmdJZHhdLmFjdHVhbFJhdGluZyA9PT0gdW5kZWZpbmVkXG4gICAgICApIHtcbiAgICAgICAgaGlzdG9yeVtleGlzdGluZ0lkeF0uYWN0dWFsUmF0aW5nID0gcHJlZGljdGlvbi5hY3R1YWxfcmF0aW5nO1xuICAgICAgICBoaXN0b3J5W2V4aXN0aW5nSWR4XS5kZWx0YSA9IHByZWRpY3Rpb24uYWN0dWFsX2RlbHRhO1xuICAgICAgICBjaGFuZ2VkID0gdHJ1ZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoY2hhbmdlZCkge1xuICAgICAgYXdhaXQgU3RvcmFnZS5zYXZlSGlzdG9yeSh1c2VybmFtZSwgaGlzdG9yeSk7XG5cbiAgICAgIGJyb2FkY2FzdChcbiAgICAgICAgY3JlYXRlTWVzc2FnZShNZXNzYWdlVHlwZS5QUkVESUNUSU9OX1VQREFURUQsIHtcbiAgICAgICAgICB1c2VybmFtZSxcbiAgICAgICAgICBjb250ZXN0OiBwcmVkaWN0aW9uLmNvbnRlc3RfdGl0bGUsXG4gICAgICAgIH0pXG4gICAgICApO1xuXG4gICAgICBicm9hZGNhc3QoY3JlYXRlTWVzc2FnZShNZXNzYWdlVHlwZS5ISVNUT1JZX1VQREFURUQsIHsgdXNlcm5hbWUgfSkpO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgZXJyb3JDb2RlID1cbiAgICAgIGVyci5tZXNzYWdlICYmIGVyci5tZXNzYWdlLmluY2x1ZGVzKFwiTmV0d29ya0Vycm9yXCIpXG4gICAgICAgID8gRXJyb3JDb2RlLk5FVFdPUktfRVJST1JcbiAgICAgICAgOiBFcnJvckNvZGUuVU5LTk9XTl9FUlJPUjtcblxuICAgIGNvbnN0IGVycm9yID0gY3JlYXRlRXJyb3IoZXJyb3JDb2RlLCBlcnIubWVzc2FnZSk7XG4gICAgYXdhaXQgU3RvcmFnZS5zZXRMYXN0RXJyb3IoZXJyb3IpO1xuICAgIExvZ2dlci5lcnJvcihMT0dfQ1RYLCBcIkFsYXJtIGhhbmRsZXIgZmFpbGVkXCIsIHsgZXJyb3I6IGVyci5tZXNzYWdlIH0pO1xuXG4gICAgYnJvYWRjYXN0KGNyZWF0ZU1lc3NhZ2UoTWVzc2FnZVR5cGUuRVJST1JfT0NDVVJSRUQsIHsgZXJyb3IgfSkpO1xuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwIE1lc3NhZ2UgSGFuZGxlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmNocm9tZS5ydW50aW1lLm9uTWVzc2FnZS5hZGRMaXN0ZW5lcigocmVxdWVzdCwgc2VuZGVyLCBzZW5kUmVzcG9uc2UpID0+IHtcbiAgaWYgKHJlcXVlc3QuYWN0aW9uID09PSBcImZldGNoUHJlZGljdGlvbnNcIikge1xuICAgIGhhbmRsZUZldGNoUHJlZGljdGlvbnMocmVxdWVzdC51c2VybmFtZXMpXG4gICAgICAudGhlbigoZGF0YSkgPT4gc2VuZFJlc3BvbnNlKHsgZGF0YSB9KSlcbiAgICAgIC5jYXRjaCgoZXJyKSA9PiB7XG4gICAgICAgIExvZ2dlci5lcnJvcihMT0dfQ1RYLCBcIlByZWRpY3Rpb24gZmV0Y2ggZmFpbGVkXCIsIHsgZXJyb3I6IGVyci5tZXNzYWdlIH0pO1xuICAgICAgICBzZW5kUmVzcG9uc2UoeyBkYXRhOiBudWxsLCBlcnJvcjogZXJyLm1lc3NhZ2UgfSk7XG4gICAgICB9KTtcbiAgICByZXR1cm4gdHJ1ZTsgLy8gS2VlcCBjaGFubmVsIG9wZW4gZm9yIGFzeW5jIHJlc3BvbnNlXG4gIH1cblxuICBpZiAocmVxdWVzdC5hY3Rpb24gPT09IFwiZmV0Y2hVc2VyQ29udGVzdEhpc3RvcnlcIikge1xuICAgIGhhbmRsZUZldGNoVXNlckNvbnRlc3RIaXN0b3J5KHJlcXVlc3QudXNlcm5hbWUpXG4gICAgICAudGhlbigoZGF0YSkgPT4gc2VuZFJlc3BvbnNlKHsgZGF0YSB9KSlcbiAgICAgIC5jYXRjaCgoZXJyKSA9PiB7XG4gICAgICAgIExvZ2dlci5lcnJvcihMT0dfQ1RYLCBcIkhpc3RvcnkgZmV0Y2ggZmFpbGVkXCIsIHsgZXJyb3I6IGVyci5tZXNzYWdlIH0pO1xuICAgICAgICBzZW5kUmVzcG9uc2UoeyBkYXRhOiBudWxsLCBlcnJvcjogZXJyLm1lc3NhZ2UgfSk7XG4gICAgICB9KTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxufSk7XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZUZldGNoVXNlckNvbnRlc3RIaXN0b3J5KHVzZXJuYW1lKSB7XG4gIGNvbnN0IHsgZGF0YSB9ID0gYXdhaXQgU3RvcmFnZS5nZXRIaXN0b3J5KHVzZXJuYW1lKTtcbiAgcmV0dXJuIGRhdGE7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZUZldGNoUHJlZGljdGlvbnModXNlcm5hbWVzKSB7XG4gIGNvbnN0IHJlc3VsdHMgPSB7fTtcbiAgY29uc3QgdXNlcnNUb0ZldGNoID0gW107XG5cbiAgZm9yIChjb25zdCB1c2VybmFtZSBvZiB1c2VybmFtZXMpIHtcbiAgICBpZiAocHJlZGljdGlvbkNhY2hlLmhhcyh1c2VybmFtZSkpIHtcbiAgICAgIHJlc3VsdHNbdXNlcm5hbWVdID0gcHJlZGljdGlvbkNhY2hlLmdldCh1c2VybmFtZSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHVzZXJzVG9GZXRjaC5wdXNoKHVzZXJuYW1lKTtcbiAgICB9XG4gIH1cblxuICBpZiAodXNlcnNUb0ZldGNoLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiByZXN1bHRzO1xuICB9XG5cbiAgdHJ5IHtcbiAgICAvLyBGb3Igbm93LCBnZW5lcmF0ZSBtb2NrIGRhdGEgdG8gZGVtb25zdHJhdGUgZnVuY3Rpb25hbGl0eSB3aXRob3V0IGEgbGl2ZSBiYWNrZW5kXG4gICAgZm9yIChjb25zdCB1c2VybmFtZSBvZiB1c2Vyc1RvRmV0Y2gpIHtcbiAgICAgIGNvbnN0IG1vY2tEZWx0YSA9IE1hdGgucmFuZG9tKCkgKiAxMDAgLSA1MDtcbiAgICAgIGNvbnN0IGRhdGEgPSB7XG4gICAgICAgIGRlbHRhOiBtb2NrRGVsdGEsXG4gICAgICAgIG5ld1JhdGluZzogMTgwMCArIG1vY2tEZWx0YSxcbiAgICAgIH07XG4gICAgICBwcmVkaWN0aW9uQ2FjaGUuc2V0KHVzZXJuYW1lLCBkYXRhKTtcbiAgICAgIHJlc3VsdHNbdXNlcm5hbWVdID0gZGF0YTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgTG9nZ2VyLndhcm4oTE9HX0NUWCwgXCJGYWlsZWQgdG8gZmV0Y2ggZnJvbSBiYWNrZW5kLCB1c2luZyBtb2NrIGRhdGFcIiwge1xuICAgICAgZXJyb3I6IGVycm9yLm1lc3NhZ2UsXG4gICAgfSk7XG4gIH1cblxuICByZXR1cm4gcmVzdWx0cztcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7O0FBT08sTUFBTSxjQUFjO0FBQUE7QUFBQSxJQUV6QixvQkFBb0I7QUFBQTtBQUFBLElBRXBCLGlCQUFpQjtBQUFBO0FBQUEsSUFFakIsZUFBZTtBQUFBO0FBQUEsSUFFZixnQkFBZ0I7QUFBQSxFQUNsQjtBQVFPLFdBQVMsY0FBYyxNQUFNLFVBQVUsQ0FBQyxHQUFHO0FBQ2hELFdBQU8sRUFBRSxNQUFNLFNBQVMsV0FBVyxLQUFLLElBQUksRUFBRTtBQUFBLEVBQ2hEOzs7QUNsQkEsTUFBTSxlQUFlLEtBQUssS0FBSyxLQUFLO0FBR3BDLE1BQU0scUJBQXFCLEtBQUssS0FBSztBQUdyQyxNQUFNLGlCQUFpQixJQUFJLEtBQUssS0FBSztBQUU5QixNQUFNLFVBQVU7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxJQVFyQixNQUFNLFdBQVcsVUFBVTtBQUN6QixZQUFNLE1BQU0sV0FBVyxRQUFRO0FBQy9CLGFBQU8sSUFBSSxRQUFRLENBQUMsWUFBWTtBQUM5QixlQUFPLFFBQVEsTUFBTSxJQUFJLENBQUMsR0FBRyxHQUFHLENBQUMsV0FBVztBQUMxQyxnQkFBTSxR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
