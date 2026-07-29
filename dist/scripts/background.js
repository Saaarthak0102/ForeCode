/**
 * Background Service Worker
 *
 * Responsibilities:
 * - User detection (LeetCode GraphQL)
 * - Alarm-based polling with exponential backoff
 * - Chrome Storage management (via Storage helper)
 * - API communication with the backend proxy
 * - Broadcasting typed messages to popup & content scripts
 */

// ── Shared modules (inlined by build.cjs) ───────────────────────────────────
// ── BEGIN INLINED: messageTypes.js ──────────────────────────────────
/**
 * Typed broadcast message constants and factory.
 *
 * All inter-component messaging (background ↔ popup ↔ content scripts)
 * uses these types to ensure consistency and future-proofing.
 */

const MessageType = {
  /** Prediction data was updated or newly available */
  PREDICTION_UPDATED: "PREDICTION_UPDATED",
  /** Contest history was refreshed or modified */
  HISTORY_UPDATED: "HISTORY_UPDATED",
  /** User login state changed (logged in / out / different user) */
  LOGIN_CHANGED: "LOGIN_CHANGED",
  /** An error occurred that the UI should display */
  ERROR_OCCURRED: "ERROR_OCCURRED",
};

/**
 * Create a typed message envelope.
 * @param {string} type - One of MessageType values.
 * @param {object} [payload={}] - Arbitrary payload data.
 * @returns {{ type: string, payload: object, timestamp: number }}
 */
function createMessage(type, payload = {}) {
  return { type, payload, timestamp: Date.now() };
}
// ── END INLINED: messageTypes.js ────────────────────────────────────
// ── BEGIN INLINED: storage.js ──────────────────────────────────
/**
 * Central Chrome Storage Manager.
 *
 * Wraps all chrome.storage.local operations behind a clean API.
 * Handles cache expiration (Suggestion 1) and prediction backoff state (Suggestion 2).
 */

/** Cache TTL: 24 hours in milliseconds */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Initial backoff interval: 20 minutes in milliseconds */
const INITIAL_BACKOFF_MS = 20 * 60 * 1000;

/** Maximum backoff interval: 6 hours in milliseconds */
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

const Storage = {
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
  },
};
// ── END INLINED: storage.js ────────────────────────────────────
// ── BEGIN INLINED: errors.js ──────────────────────────────────
/**
 * Structured error codes for the extension.
 *
 * These codes allow the popup and content scripts to display
 * meaningful, user-friendly status messages instead of generic errors.
 */

const ErrorCode = {
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
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
};

/**
 * User-friendly error messages for each code.
 */
const ErrorMessages = {
  [ErrorCode.NETWORK_ERROR]: "Network error — will retry automatically.",
  [ErrorCode.GRAPHQL_FAILED]: "Failed to reach LeetCode — will retry.",
  [ErrorCode.PREDICTION_PENDING]: "Prediction is still being calculated…",
  [ErrorCode.USER_NOT_FOUND]: "LeetCode user not found.",
  [ErrorCode.RATE_LIMITED]: "Too many requests — slowing down.",
  [ErrorCode.UNKNOWN_ERROR]: "Something went wrong.",
};

/**
 * Create a structured error object.
 * @param {string} code - One of ErrorCode values.
 * @param {string} [detail] - Optional technical detail for logging.
 * @returns {{ code: string, message: string, detail?: string, timestamp: number }}
 */
function createError(code, detail) {
  return {
    code,
    message: ErrorMessages[code] || ErrorMessages[ErrorCode.UNKNOWN_ERROR],
    ...(detail ? { detail } : {}),
    timestamp: Date.now(),
  };
}
// ── END INLINED: errors.js ────────────────────────────────────
// ── BEGIN INLINED: logger.js ──────────────────────────────────
/**
 * Structured logger for the Chrome extension.
 *
 * Replaces raw console.log/error/warn calls with structured output
 * that includes timestamps, context modules, and relevant data.
 */

const Logger = {
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
    const timestamp = new Date().toISOString();
    const base = `[${timestamp}] [${level}] [${context}] ${message}`;
    if (data !== undefined && data !== null) {
      // Keep it readable in the console
      return `${base} | ${JSON.stringify(data)}`;
    }
    return base;
  },
};
// ── END INLINED: logger.js ────────────────────────────────────

// ── Constants ───────────────────────────────────────────────────────────────

const API_URL = "http://localhost:8000/api/v1"; // Change to your hosted backend URL

const LOG_CTX = "Background";

// Simple in-memory cache for leaderboard prediction lookups
const predictionCache = new Map();

// ── Username Detection ──────────────────────────────────────────────────────

async function getLeetCodeUsername() {
  try {
    const res = await fetch("https://leetcode.com/graphql", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "query globalData { userStatus { username } }",
      }),
    });
    const data = await res.json();
    return data?.data?.userStatus?.username || null;
  } catch (e) {
    Logger.error(LOG_CTX, "Failed to detect LeetCode username", { error: e.message });
    return null;
  }
}

// ── History Management ──────────────────────────────────────────────────────

/**
 * Add or update a single contest record in the user's history.
 */
async function addOrUpdateHistoryEntry(record, username) {
  const { data: history } = await Storage.getHistory(username);

  const mappedRecord = {
    name: record.contest_title,
    actualRating: record.actual_rating,
    predictedRating: record.predicted_rating || "-",
    delta:
      record.actual_delta !== null
        ? record.actual_delta
        : record.predicted_delta,
  };

  const existingIdx = history.findIndex((r) => r.name === mappedRecord.name);
  if (existingIdx >= 0) {
    history[existingIdx] = mappedRecord;
  } else {
    history.push(mappedRecord);
  }

  await Storage.saveHistory(username, history);
}

/**
 * Fetch fresh history from the backend and save to storage.
 */
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
        count: history.length,
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

// ── Broadcast ───────────────────────────────────────────────────────────────

/**
 * Broadcast a typed message to popup and all LeetCode tabs.
 */
function broadcast(message) {
  // Notify popup (may not be open — that's fine, catch silently)
  chrome.runtime.sendMessage(message).catch(() => {});

  // Notify active LeetCode tabs
  chrome.tabs.query({ url: "*://leetcode.com/*" }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
}

// ── Lifecycle Events ────────────────────────────────────────────────────────

chrome.runtime.onStartup.addListener(() => {
  Logger.info(LOG_CTX, "Extension startup — creating alarm");
  chrome.alarms.create("checkPendingPrediction", { periodInMinutes: 20 });
});

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.alarms.create("checkPendingPrediction", { periodInMinutes: 20 });

  if (details.reason === "install") {
    Logger.info(LOG_CTX, "Extension installed — detecting user");
    const username = await getLeetCodeUsername();

    if (username) {
      await Storage.setUsername(username);
      Logger.info(LOG_CTX, "User detected", { username });

      try {
        await fetch(`${API_URL}/user/${username}/register`, { method: "POST" });
      } catch (_) {
        // Register endpoint is optional; ignore failures
      }

      await refreshHistory(username);

      broadcast(createMessage(MessageType.LOGIN_CHANGED, { username }));
    } else {
      Logger.warn(LOG_CTX, "No LeetCode user detected during install");
    }
  }
});

// ── Alarm Handler (Suggestion 1: Cache Expiry + Suggestion 2: Backoff) ──────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "checkPendingPrediction") return;

  const username = await Storage.getUsername();
  if (!username) return;

  Logger.info(LOG_CTX, "Alarm fired — checking predictions", { username });

  try {
    // ── Suggestion 1: Check if history cache is stale ──
    const cachedHistory = await Storage.getHistory(username);
    if (cachedHistory.isStale) {
      Logger.info(LOG_CTX, "History cache is stale — refreshing", { username });
      await refreshHistory(username);
    }

    // ── Suggestion 2: Check backoff before polling predictions ──
    const predStatus = await Storage.getPredictionStatus();

    if (predStatus && predStatus.status === "waiting") {
      if (Date.now() < predStatus.nextRetryAt) {
        Logger.info(LOG_CTX, "Skipping prediction poll — backoff active", {
          nextRetryAt: new Date(predStatus.nextRetryAt).toISOString(),
          retryCount: predStatus.retryCount,
        });
        return;
      }
    }

    // ── Fetch latest contest from LeetCode ──
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
        variables: { skip: 0, limit: 1, isVirtual: false },
      }),
    });

    if (gqlRes.ok) {
      const gqlData = await gqlRes.json();
      const contests =
        gqlData?.data?.contestV2MyContests?.contests || [];

      if (contests.length > 0) {
        const recent = contests[0];
        if (recent.ranking) {
          Logger.info(LOG_CTX, "Found recent contest with ranking", {
            contest: recent.titleSlug,
            ranking: recent.ranking,
          });

          const predRes = await fetch(
            `${API_URL}/user/${username}/predict`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contest_slug: recent.titleSlug,
                contest_title: recent.title,
              }),
            }
          );

          if (predRes.ok) {
            prediction = await predRes.json();
          } else if (predRes.status === 202) {
            // Prediction not yet available — update backoff
            const currentRetry = predStatus ? predStatus.retryCount : 0;
            const newStatus = {
              contestSlug: recent.titleSlug,
              status: "waiting",
              lastChecked: Date.now(),
              retryCount: currentRetry + 1,
              nextRetryAt: Storage.calculateNextRetry(currentRetry),
            };
            await Storage.savePredictionStatus(newStatus);
            await Storage.setLastError(
              createError(ErrorCode.PREDICTION_PENDING)
            );

            Logger.info(LOG_CTX, "Prediction pending — backoff updated", {
              retryCount: newStatus.retryCount,
              nextRetryAt: new Date(newStatus.nextRetryAt).toISOString(),
            });

            broadcast(
              createMessage(MessageType.ERROR_OCCURRED, {
                error: createError(ErrorCode.PREDICTION_PENDING),
              })
            );
            return;
          }
        }
      }
    } else {
      Logger.warn(LOG_CTX, "LeetCode GraphQL request failed", {
        status: gqlRes.status,
      });
    }

    if (!prediction) return;

    // ── Prediction found! Update history and clear backoff ──
    Logger.info(LOG_CTX, "Prediction received", {
      contest: prediction.contest_title || prediction.contest_slug,
      rating: prediction.predicted_rating,
      delta: prediction.predicted_delta,
    });

    await Storage.clearPredictionStatus();
    await Storage.setLastError(null);

    const { data: history } = await Storage.getHistory(username);
    const existingIdx = history.findIndex(
      (r) => r.name === prediction.contest_title
    );

    let changed = false;

    if (prediction.status === "pending" && existingIdx === -1) {
      // New pending prediction not in history
      const mappedRecord = {
        name: prediction.contest_title,
        actualRating: null,
        predictedRating: prediction.predicted_rating,
        delta: prediction.predicted_delta,
      };
      history.unshift(mappedRecord);
      changed = true;
    } else if (prediction.status === "confirmed" && existingIdx >= 0) {
      // Lock in actual rating
      if (
        history[existingIdx].actualRating === null ||
        history[existingIdx].actualRating === undefined
      ) {
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
          contest: prediction.contest_title,
        })
      );

      broadcast(createMessage(MessageType.HISTORY_UPDATED, { username }));
    }
  } catch (err) {
    const errorCode =
      err.message && err.message.includes("NetworkError")
        ? ErrorCode.NETWORK_ERROR
        : ErrorCode.UNKNOWN_ERROR;

    const error = createError(errorCode, err.message);
    await Storage.setLastError(error);
    Logger.error(LOG_CTX, "Alarm handler failed", { error: err.message });

    broadcast(createMessage(MessageType.ERROR_OCCURRED, { error }));
  }
});

// ── Message Handlers ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "fetchPredictions") {
    handleFetchPredictions(request.usernames)
      .then((data) => sendResponse({ data }))
      .catch((err) => {
        Logger.error(LOG_CTX, "Prediction fetch failed", { error: err.message });
        sendResponse({ data: null, error: err.message });
      });
    return true; // Keep channel open for async response
  }

  if (request.action === "fetchUserContestHistory") {
    handleFetchUserContestHistory(request.username)
      .then((data) => sendResponse({ data }))
      .catch((err) => {
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
    // For now, generate mock data to demonstrate functionality without a live backend
    for (const username of usersToFetch) {
      const mockDelta = Math.random() * 100 - 50;
      const data = {
        delta: mockDelta,
        newRating: 1800 + mockDelta,
      };
      predictionCache.set(username, data);
      results[username] = data;
    }
  } catch (error) {
    Logger.warn(LOG_CTX, "Failed to fetch from backend, using mock data", {
      error: error.message,
    });
  }

  return results;
}
