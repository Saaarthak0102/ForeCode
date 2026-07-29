/**
 * Popup Script
 *
 * Renders recent contest history and displays error/status messages.
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

const LOG_CTX = "Popup";

document.addEventListener("DOMContentLoaded", () => {
  const contestsContainer = document.getElementById("contests-container");

  // ── Error / Status Banner ───────────────────────────────────────────────

  function renderStatusBanner(error) {
    // Remove existing banner if any
    const existing = document.getElementById("status-banner");
    if (existing) existing.remove();

    if (!error) return;

    const banner = document.createElement("div");
    banner.id = "status-banner";
    banner.style.cssText = `
      padding: 8px 12px;
      margin: 0 12px 8px;
      border-radius: 6px;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
    `;

    // Style based on error code
    if (error.code === ErrorCode.PREDICTION_PENDING) {
      banner.style.background = "rgba(255, 161, 22, 0.12)";
      banner.style.color = "#ffa116";
      banner.innerHTML = `<span>⏳</span><span>${error.message}</span>`;
    } else if (
      error.code === ErrorCode.NETWORK_ERROR ||
      error.code === ErrorCode.GRAPHQL_FAILED
    ) {
      banner.style.background = "rgba(239, 71, 67, 0.12)";
      banner.style.color = "#ef4743";
      banner.innerHTML = `<span>⚠️</span><span>${error.message}</span>`;
    } else if (error.code === ErrorCode.RATE_LIMITED) {
      banner.style.background = "rgba(255, 161, 22, 0.12)";
      banner.style.color = "#ffa116";
      banner.innerHTML = `<span>🔄</span><span>${error.message}</span>`;
    } else {
      banner.style.background = "rgba(239, 71, 67, 0.08)";
      banner.style.color = "#ef4743";
      banner.innerHTML = `<span>❌</span><span>${error.message}</span>`;
    }

    // Insert before the contests list
    contestsContainer.parentNode.insertBefore(banner, contestsContainer);
  }

  // ── Load & Render ───────────────────────────────────────────────────────

  function fetchAndRenderHistory() {
    chrome.storage.local.get(["lc_username", "last_error"], (result) => {
      const username = result.lc_username;

      // Show error banner if one exists
      renderStatusBanner(result.last_error || null);

      if (!username) {
        contestsContainer.innerHTML =
          '<div style="padding: 16px; text-align: center; color: var(--lc-text-secondary);">Please log in to LeetCode, then reopen this popup.</div>';
        return;
      }

      Logger.info(LOG_CTX, "Fetching history for popup", { username });

      chrome.runtime.sendMessage(
        { action: "fetchUserContestHistory", username: username },
        (response) => {
          if (response && response.data && response.data.length > 0) {
            renderContests(response.data.slice(0, 5));
          } else {
            contestsContainer.innerHTML =
              '<div style="padding: 16px; text-align: center; color: var(--lc-text-secondary);">No contest history found.</div>';
          }
        }
      );
    });
  }

  // Listen for typed broadcast messages
  chrome.runtime.onMessage.addListener((request) => {
    if (
      request.type === MessageType.HISTORY_UPDATED ||
      request.type === MessageType.PREDICTION_UPDATED
    ) {
      Logger.info(LOG_CTX, "Received update — refreshing popup", {
        type: request.type,
      });
      fetchAndRenderHistory();
    }

    if (request.type === MessageType.ERROR_OCCURRED) {
      Logger.warn(LOG_CTX, "Received error broadcast", {
        error: request.payload?.error,
      });
      renderStatusBanner(request.payload?.error || null);
    }

    if (request.type === MessageType.LOGIN_CHANGED) {
      Logger.info(LOG_CTX, "Login changed — refreshing popup");
      fetchAndRenderHistory();
    }
  });

  fetchAndRenderHistory();

  // ── Render Contest Cards ────────────────────────────────────────────────

  function renderContests(contests) {
    contestsContainer.innerHTML = "";

    contests.forEach((contest) => {
      const card = document.createElement("div");
      card.className = "contest-card";

      let deltaClass = "neutral";
      let deltaSign = "";
      let arrow = "";

      const deltaVal =
        contest.delta !== null &&
        contest.delta !== undefined &&
        contest.delta !== "-"
          ? Math.round(contest.delta)
          : null;

      if (deltaVal !== null) {
        if (deltaVal > 0) {
          deltaClass = "positive";
          deltaSign = "+";
          arrow = "↑";
        } else if (deltaVal < 0) {
          deltaClass = "negative";
          arrow = "↓";
        } else {
          deltaSign = "";
          arrow = "-";
        }
      }

      const deltaHTML =
        deltaVal !== null ? `${deltaSign}${deltaVal} ${arrow}` : "–";

      const actualText =
        contest.actualRating !== null &&
        contest.actualRating !== undefined &&
        contest.actualRating !== "-"
          ? Math.round(contest.actualRating)
          : "–";

      const predictedText =
        contest.predictedRating !== null &&
        contest.predictedRating !== undefined &&
        contest.predictedRating !== "-"
          ? Math.round(contest.predictedRating)
          : "–";

      card.innerHTML = `
        <div class="contest-header">
          <div class="contest-title">${contest.name}</div>
          <div class="delta ${deltaClass}">
            ${deltaHTML}
          </div>
        </div>
        <div class="contest-details">
          <div class="rating-info">
            <span class="rating-label">Actual</span>
            <span class="rating-value">${actualText}</span>
          </div>
          <div class="rating-info" style="text-align: right;">
            <span class="rating-label">Predicted</span>
            <span class="rating-value">${predictedText}</span>
          </div>
        </div>
      `;

      contestsContainer.appendChild(card);
    });
  }
});
