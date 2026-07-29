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
import { MessageType, createMessage } from "./lib/messageTypes.js";
import { Storage } from "./lib/storage.js";
import { ErrorCode, createError } from "./lib/errors.js";
import { Logger } from "./lib/logger.js";

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
