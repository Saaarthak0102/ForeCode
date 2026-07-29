/**
 * Popup Script
 *
 * Renders recent contest history and displays error/status messages.
 */

// ── Shared modules (inlined by build.cjs) ───────────────────────────────────
import { MessageType } from "../scripts/lib/messageTypes.js";
import { ErrorCode } from "../scripts/lib/errors.js";
import { Logger } from "../scripts/lib/logger.js";

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
