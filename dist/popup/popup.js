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

  // src/popup/popup.js
  var LOG_CTX = "Popup";
  document.addEventListener("DOMContentLoaded", () => {
    const contestsContainer = document.getElementById("contests-container");
    function renderStatusBanner(error) {
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
      if (error.code === ErrorCode.PREDICTION_PENDING) {
        banner.style.background = "rgba(255, 161, 22, 0.12)";
        banner.style.color = "#ffa116";
        banner.innerHTML = `<span>\u23F3</span><span>${error.message}</span>`;
      } else if (error.code === ErrorCode.NETWORK_ERROR || error.code === ErrorCode.GRAPHQL_FAILED) {
        banner.style.background = "rgba(239, 71, 67, 0.12)";
        banner.style.color = "#ef4743";
        banner.innerHTML = `<span>\u26A0\uFE0F</span><span>${error.message}</span>`;
      } else if (error.code === ErrorCode.RATE_LIMITED) {
        banner.style.background = "rgba(255, 161, 22, 0.12)";
        banner.style.color = "#ffa116";
        banner.innerHTML = `<span>\u{1F504}</span><span>${error.message}</span>`;
      } else {
        banner.style.background = "rgba(239, 71, 67, 0.08)";
        banner.style.color = "#ef4743";
        banner.innerHTML = `<span>\u274C</span><span>${error.message}</span>`;
      }
      contestsContainer.parentNode.insertBefore(banner, contestsContainer);
    }
    function fetchAndRenderHistory() {
      chrome.storage.local.get(["lc_username", "last_error"], (result) => {
        const username = result.lc_username;
        renderStatusBanner(result.last_error || null);
        if (!username) {
          contestsContainer.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--lc-text-secondary);">Please log in to LeetCode, then reopen this popup.</div>';
          return;
        }
        Logger.info(LOG_CTX, "Fetching history for popup", { username });
        chrome.runtime.sendMessage(
          { action: "fetchUserContestHistory", username },
          (response) => {
            if (response && response.data && response.data.length > 0) {
              renderContests(response.data.slice(0, 5));
            } else {
              contestsContainer.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--lc-text-secondary);">No contest history found.</div>';
            }
          }
        );
      });
    }
    chrome.runtime.onMessage.addListener((request) => {
      if (request.type === MessageType.HISTORY_UPDATED || request.type === MessageType.PREDICTION_UPDATED) {
        Logger.info(LOG_CTX, "Received update \u2014 refreshing popup", {
          type: request.type
        });
        fetchAndRenderHistory();
      }
      if (request.type === MessageType.ERROR_OCCURRED) {
        Logger.warn(LOG_CTX, "Received error broadcast", {
          error: request.payload?.error
        });
        renderStatusBanner(request.payload?.error || null);
      }
      if (request.type === MessageType.LOGIN_CHANGED) {
        Logger.info(LOG_CTX, "Login changed \u2014 refreshing popup");
        fetchAndRenderHistory();
      }
    });
    fetchAndRenderHistory();
    function renderContests(contests) {
      contestsContainer.innerHTML = "";
      contests.forEach((contest) => {
        const card = document.createElement("div");
        card.className = "contest-card";
        let deltaClass = "neutral";
        let deltaSign = "";
        let arrow = "";
        const deltaVal = contest.delta !== null && contest.delta !== void 0 && contest.delta !== "-" ? Math.round(contest.delta) : null;
        if (deltaVal !== null) {
          if (deltaVal > 0) {
            deltaClass = "positive";
            deltaSign = "+";
            arrow = "\u2191";
          } else if (deltaVal < 0) {
            deltaClass = "negative";
            arrow = "\u2193";
          } else {
            deltaSign = "";
            arrow = "-";
          }
        }
        const deltaHTML = deltaVal !== null ? `${deltaSign}${deltaVal} ${arrow}` : "\u2013";
        const actualText = contest.actualRating !== null && contest.actualRating !== void 0 && contest.actualRating !== "-" ? Math.round(contest.actualRating) : "\u2013";
        let predictedText;
        if (contest.status === "prediction_pending") {
          predictedText = '<span style="color: #ffa116; font-size: 12px; font-weight: normal;">Pending</span>';
        } else {
          predictedText = contest.predictedRating !== null && contest.predictedRating !== void 0 && contest.predictedRating !== "-" ? Math.round(contest.predictedRating) : "\u2013";
        }
        const pendingBadge = contest.status === "pending" || contest.status === "prediction_pending" ? '<span style="font-size: 10px; color: #ffa116; border: 1px solid rgba(255,161,22,0.5); background: rgba(255,161,22,0.1); border-radius: 4px; padding: 1px 4px; margin-left: 6px; font-weight: normal;">Pending</span>' : "";
        card.innerHTML = `
        <div class="contest-header">
          <div class="contest-title">${contest.name}${pendingBadge}</div>
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
})();
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL3NjcmlwdHMvbGliL21lc3NhZ2VUeXBlcy5qcyIsICIuLi8uLi9zcmMvc2NyaXB0cy9saWIvZXJyb3JzLmpzIiwgIi4uLy4uL3NyYy9zY3JpcHRzL2xpYi9sb2dnZXIuanMiLCAiLi4vLi4vc3JjL3BvcHVwL3BvcHVwLmpzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcclxuICogVHlwZWQgYnJvYWRjYXN0IG1lc3NhZ2UgY29uc3RhbnRzIGFuZCBmYWN0b3J5LlxyXG4gKlxyXG4gKiBBbGwgaW50ZXItY29tcG9uZW50IG1lc3NhZ2luZyAoYmFja2dyb3VuZCBcdTIxOTQgcG9wdXAgXHUyMTk0IGNvbnRlbnQgc2NyaXB0cylcclxuICogdXNlcyB0aGVzZSB0eXBlcyB0byBlbnN1cmUgY29uc2lzdGVuY3kgYW5kIGZ1dHVyZS1wcm9vZmluZy5cclxuICovXHJcblxyXG5leHBvcnQgY29uc3QgTWVzc2FnZVR5cGUgPSB7XHJcbiAgLyoqIFByZWRpY3Rpb24gZGF0YSB3YXMgdXBkYXRlZCBvciBuZXdseSBhdmFpbGFibGUgKi9cclxuICBQUkVESUNUSU9OX1VQREFURUQ6IFwiUFJFRElDVElPTl9VUERBVEVEXCIsXHJcbiAgLyoqIENvbnRlc3QgaGlzdG9yeSB3YXMgcmVmcmVzaGVkIG9yIG1vZGlmaWVkICovXHJcbiAgSElTVE9SWV9VUERBVEVEOiBcIkhJU1RPUllfVVBEQVRFRFwiLFxyXG4gIC8qKiBVc2VyIGxvZ2luIHN0YXRlIGNoYW5nZWQgKGxvZ2dlZCBpbiAvIG91dCAvIGRpZmZlcmVudCB1c2VyKSAqL1xyXG4gIExPR0lOX0NIQU5HRUQ6IFwiTE9HSU5fQ0hBTkdFRFwiLFxyXG4gIC8qKiBBbiBlcnJvciBvY2N1cnJlZCB0aGF0IHRoZSBVSSBzaG91bGQgZGlzcGxheSAqL1xyXG4gIEVSUk9SX09DQ1VSUkVEOiBcIkVSUk9SX09DQ1VSUkVEXCIsXHJcbn07XHJcblxyXG4vKipcclxuICogQ3JlYXRlIGEgdHlwZWQgbWVzc2FnZSBlbnZlbG9wZS5cclxuICogQHBhcmFtIHtzdHJpbmd9IHR5cGUgLSBPbmUgb2YgTWVzc2FnZVR5cGUgdmFsdWVzLlxyXG4gKiBAcGFyYW0ge29iamVjdH0gW3BheWxvYWQ9e31dIC0gQXJiaXRyYXJ5IHBheWxvYWQgZGF0YS5cclxuICogQHJldHVybnMge3sgdHlwZTogc3RyaW5nLCBwYXlsb2FkOiBvYmplY3QsIHRpbWVzdGFtcDogbnVtYmVyIH19XHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlTWVzc2FnZSh0eXBlLCBwYXlsb2FkID0ge30pIHtcclxuICByZXR1cm4geyB0eXBlLCBwYXlsb2FkLCB0aW1lc3RhbXA6IERhdGUubm93KCkgfTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIFN0cnVjdHVyZWQgZXJyb3IgY29kZXMgZm9yIHRoZSBleHRlbnNpb24uXHJcbiAqXHJcbiAqIFRoZXNlIGNvZGVzIGFsbG93IHRoZSBwb3B1cCBhbmQgY29udGVudCBzY3JpcHRzIHRvIGRpc3BsYXlcclxuICogbWVhbmluZ2Z1bCwgdXNlci1mcmllbmRseSBzdGF0dXMgbWVzc2FnZXMgaW5zdGVhZCBvZiBnZW5lcmljIGVycm9ycy5cclxuICovXHJcblxyXG5leHBvcnQgY29uc3QgRXJyb3JDb2RlID0ge1xyXG4gIC8qKiBOZXR3b3JrIHJlcXVlc3QgZmFpbGVkIChubyBjb25uZWN0aXZpdHksIEROUywgdGltZW91dCkgKi9cclxuICBORVRXT1JLX0VSUk9SOiBcIk5FVFdPUktfRVJST1JcIixcclxuICAvKiogTGVldENvZGUgR3JhcGhRTCBBUEkgcmV0dXJuZWQgYW4gZXJyb3Igb3IgdW5leHBlY3RlZCBzaGFwZSAqL1xyXG4gIEdSQVBIUUxfRkFJTEVEOiBcIkdSQVBIUUxfRkFJTEVEXCIsXHJcbiAgLyoqIFByZWRpY3Rpb24gaXMgbm90IHlldCBhdmFpbGFibGUgXHUyMDE0IHN0aWxsIGJlaW5nIGNhbGN1bGF0ZWQgKi9cclxuICBQUkVESUNUSU9OX1BFTkRJTkc6IFwiUFJFRElDVElPTl9QRU5ESU5HXCIsXHJcbiAgLyoqIFRoZSByZXF1ZXN0ZWQgdXNlciB3YXMgbm90IGZvdW5kIG9uIExlZXRDb2RlICovXHJcbiAgVVNFUl9OT1RfRk9VTkQ6IFwiVVNFUl9OT1RfRk9VTkRcIixcclxuICAvKiogVG9vIG1hbnkgcmVxdWVzdHMgXHUyMDE0IGJlaW5nIHJhdGUgbGltaXRlZCAqL1xyXG4gIFJBVEVfTElNSVRFRDogXCJSQVRFX0xJTUlURURcIixcclxuICAvKiogQ2F0Y2gtYWxsIGZvciB1bmV4cGVjdGVkIGVycm9ycyAqL1xyXG4gIFVOS05PV05fRVJST1I6IFwiVU5LTk9XTl9FUlJPUlwiLFxyXG59O1xyXG5cclxuLyoqXHJcbiAqIFVzZXItZnJpZW5kbHkgZXJyb3IgbWVzc2FnZXMgZm9yIGVhY2ggY29kZS5cclxuICovXHJcbmNvbnN0IEVycm9yTWVzc2FnZXMgPSB7XHJcbiAgW0Vycm9yQ29kZS5ORVRXT1JLX0VSUk9SXTogXCJOZXR3b3JrIGVycm9yIFx1MjAxNCB3aWxsIHJldHJ5IGF1dG9tYXRpY2FsbHkuXCIsXHJcbiAgW0Vycm9yQ29kZS5HUkFQSFFMX0ZBSUxFRF06IFwiRmFpbGVkIHRvIHJlYWNoIExlZXRDb2RlIFx1MjAxNCB3aWxsIHJldHJ5LlwiLFxyXG4gIFtFcnJvckNvZGUuUFJFRElDVElPTl9QRU5ESU5HXTogXCJQcmVkaWN0aW9uIGlzIHN0aWxsIGJlaW5nIGNhbGN1bGF0ZWRcdTIwMjZcIixcclxuICBbRXJyb3JDb2RlLlVTRVJfTk9UX0ZPVU5EXTogXCJMZWV0Q29kZSB1c2VyIG5vdCBmb3VuZC5cIixcclxuICBbRXJyb3JDb2RlLlJBVEVfTElNSVRFRF06IFwiVG9vIG1hbnkgcmVxdWVzdHMgXHUyMDE0IHNsb3dpbmcgZG93bi5cIixcclxuICBbRXJyb3JDb2RlLlVOS05PV05fRVJST1JdOiBcIlNvbWV0aGluZyB3ZW50IHdyb25nLlwiLFxyXG59O1xyXG5cclxuLyoqXHJcbiAqIENyZWF0ZSBhIHN0cnVjdHVyZWQgZXJyb3Igb2JqZWN0LlxyXG4gKiBAcGFyYW0ge3N0cmluZ30gY29kZSAtIE9uZSBvZiBFcnJvckNvZGUgdmFsdWVzLlxyXG4gKiBAcGFyYW0ge3N0cmluZ30gW2RldGFpbF0gLSBPcHRpb25hbCB0ZWNobmljYWwgZGV0YWlsIGZvciBsb2dnaW5nLlxyXG4gKiBAcmV0dXJucyB7eyBjb2RlOiBzdHJpbmcsIG1lc3NhZ2U6IHN0cmluZywgZGV0YWlsPzogc3RyaW5nLCB0aW1lc3RhbXA6IG51bWJlciB9fVxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUVycm9yKGNvZGUsIGRldGFpbCkge1xyXG4gIHJldHVybiB7XHJcbiAgICBjb2RlLFxyXG4gICAgbWVzc2FnZTogRXJyb3JNZXNzYWdlc1tjb2RlXSB8fCBFcnJvck1lc3NhZ2VzW0Vycm9yQ29kZS5VTktOT1dOX0VSUk9SXSxcclxuICAgIC4uLihkZXRhaWwgPyB7IGRldGFpbCB9IDoge30pLFxyXG4gICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxyXG4gIH07XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBTdHJ1Y3R1cmVkIGxvZ2dlciBmb3IgdGhlIENocm9tZSBleHRlbnNpb24uXHJcbiAqXHJcbiAqIFJlcGxhY2VzIHJhdyBjb25zb2xlLmxvZy9lcnJvci93YXJuIGNhbGxzIHdpdGggc3RydWN0dXJlZCBvdXRwdXRcclxuICogdGhhdCBpbmNsdWRlcyB0aW1lc3RhbXBzLCBjb250ZXh0IG1vZHVsZXMsIGFuZCByZWxldmFudCBkYXRhLlxyXG4gKi9cclxuXHJcbmV4cG9ydCBjb25zdCBMb2dnZXIgPSB7XHJcbiAgLyoqXHJcbiAgICogQHBhcmFtIHtzdHJpbmd9IGNvbnRleHQgLSBNb2R1bGUgbmFtZSAoZS5nLiwgXCJCYWNrZ3JvdW5kXCIsIFwiUG9wdXBcIikuXHJcbiAgICogQHBhcmFtIHtzdHJpbmd9IG1lc3NhZ2UgLSBMb2cgbWVzc2FnZS5cclxuICAgKiBAcGFyYW0ge29iamVjdH0gW2RhdGFdIC0gT3B0aW9uYWwgc3RydWN0dXJlZCBkYXRhLlxyXG4gICAqL1xyXG4gIGluZm8oY29udGV4dCwgbWVzc2FnZSwgZGF0YSkge1xyXG4gICAgY29uc3QgZW50cnkgPSBMb2dnZXIuX2Zvcm1hdChcIklORk9cIiwgY29udGV4dCwgbWVzc2FnZSwgZGF0YSk7XHJcbiAgICBjb25zb2xlLmxvZyhlbnRyeSk7XHJcbiAgfSxcclxuXHJcbiAgd2Fybihjb250ZXh0LCBtZXNzYWdlLCBkYXRhKSB7XHJcbiAgICBjb25zdCBlbnRyeSA9IExvZ2dlci5fZm9ybWF0KFwiV0FSTlwiLCBjb250ZXh0LCBtZXNzYWdlLCBkYXRhKTtcclxuICAgIGNvbnNvbGUud2FybihlbnRyeSk7XHJcbiAgfSxcclxuXHJcbiAgZXJyb3IoY29udGV4dCwgbWVzc2FnZSwgZGF0YSkge1xyXG4gICAgY29uc3QgZW50cnkgPSBMb2dnZXIuX2Zvcm1hdChcIkVSUk9SXCIsIGNvbnRleHQsIG1lc3NhZ2UsIGRhdGEpO1xyXG4gICAgY29uc29sZS5lcnJvcihlbnRyeSk7XHJcbiAgfSxcclxuXHJcbiAgLyoqXHJcbiAgICogRm9ybWF0IGEgc3RydWN0dXJlZCBsb2cgZW50cnkuXHJcbiAgICogQHByaXZhdGVcclxuICAgKi9cclxuICBfZm9ybWF0KGxldmVsLCBjb250ZXh0LCBtZXNzYWdlLCBkYXRhKSB7XHJcbiAgICBjb25zdCB0aW1lc3RhbXAgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XHJcbiAgICBjb25zdCBiYXNlID0gYFske3RpbWVzdGFtcH1dIFske2xldmVsfV0gWyR7Y29udGV4dH1dICR7bWVzc2FnZX1gO1xyXG4gICAgaWYgKGRhdGEgIT09IHVuZGVmaW5lZCAmJiBkYXRhICE9PSBudWxsKSB7XHJcbiAgICAgIC8vIEtlZXAgaXQgcmVhZGFibGUgaW4gdGhlIGNvbnNvbGVcclxuICAgICAgcmV0dXJuIGAke2Jhc2V9IHwgJHtKU09OLnN0cmluZ2lmeShkYXRhKX1gO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGJhc2U7XHJcbiAgfSxcclxufTtcclxuIiwgIi8qKlxyXG4gKiBQb3B1cCBTY3JpcHRcclxuICpcclxuICogUmVuZGVycyByZWNlbnQgY29udGVzdCBoaXN0b3J5IGFuZCBkaXNwbGF5cyBlcnJvci9zdGF0dXMgbWVzc2FnZXMuXHJcbiAqL1xyXG5cclxuLy8gXHUyNTAwXHUyNTAwIFNoYXJlZCBtb2R1bGVzIChpbmxpbmVkIGJ5IGJ1aWxkLmNqcykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHJcbmltcG9ydCB7IE1lc3NhZ2VUeXBlIH0gZnJvbSBcIi4uL3NjcmlwdHMvbGliL21lc3NhZ2VUeXBlcy5qc1wiO1xyXG5pbXBvcnQgeyBFcnJvckNvZGUgfSBmcm9tIFwiLi4vc2NyaXB0cy9saWIvZXJyb3JzLmpzXCI7XHJcbmltcG9ydCB7IExvZ2dlciB9IGZyb20gXCIuLi9zY3JpcHRzL2xpYi9sb2dnZXIuanNcIjtcclxuXHJcbmNvbnN0IExPR19DVFggPSBcIlBvcHVwXCI7XHJcblxyXG5kb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiRE9NQ29udGVudExvYWRlZFwiLCAoKSA9PiB7XHJcbiAgY29uc3QgY29udGVzdHNDb250YWluZXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImNvbnRlc3RzLWNvbnRhaW5lclwiKTtcclxuXHJcbiAgLy8gXHUyNTAwXHUyNTAwIEVycm9yIC8gU3RhdHVzIEJhbm5lciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcclxuXHJcbiAgZnVuY3Rpb24gcmVuZGVyU3RhdHVzQmFubmVyKGVycm9yKSB7XHJcbiAgICAvLyBSZW1vdmUgZXhpc3RpbmcgYmFubmVyIGlmIGFueVxyXG4gICAgY29uc3QgZXhpc3RpbmcgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInN0YXR1cy1iYW5uZXJcIik7XHJcbiAgICBpZiAoZXhpc3RpbmcpIGV4aXN0aW5nLnJlbW92ZSgpO1xyXG5cclxuICAgIGlmICghZXJyb3IpIHJldHVybjtcclxuXHJcbiAgICBjb25zdCBiYW5uZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xyXG4gICAgYmFubmVyLmlkID0gXCJzdGF0dXMtYmFubmVyXCI7XHJcbiAgICBiYW5uZXIuc3R5bGUuY3NzVGV4dCA9IGBcclxuICAgICAgcGFkZGluZzogOHB4IDEycHg7XHJcbiAgICAgIG1hcmdpbjogMCAxMnB4IDhweDtcclxuICAgICAgYm9yZGVyLXJhZGl1czogNnB4O1xyXG4gICAgICBmb250LXNpemU6IDEycHg7XHJcbiAgICAgIGRpc3BsYXk6IGZsZXg7XHJcbiAgICAgIGFsaWduLWl0ZW1zOiBjZW50ZXI7XHJcbiAgICAgIGdhcDogNnB4O1xyXG4gICAgYDtcclxuXHJcbiAgICAvLyBTdHlsZSBiYXNlZCBvbiBlcnJvciBjb2RlXHJcbiAgICBpZiAoZXJyb3IuY29kZSA9PT0gRXJyb3JDb2RlLlBSRURJQ1RJT05fUEVORElORykge1xyXG4gICAgICBiYW5uZXIuc3R5bGUuYmFja2dyb3VuZCA9IFwicmdiYSgyNTUsIDE2MSwgMjIsIDAuMTIpXCI7XHJcbiAgICAgIGJhbm5lci5zdHlsZS5jb2xvciA9IFwiI2ZmYTExNlwiO1xyXG4gICAgICBiYW5uZXIuaW5uZXJIVE1MID0gYDxzcGFuPlx1MjNGMzwvc3Bhbj48c3Bhbj4ke2Vycm9yLm1lc3NhZ2V9PC9zcGFuPmA7XHJcbiAgICB9IGVsc2UgaWYgKFxyXG4gICAgICBlcnJvci5jb2RlID09PSBFcnJvckNvZGUuTkVUV09SS19FUlJPUiB8fFxyXG4gICAgICBlcnJvci5jb2RlID09PSBFcnJvckNvZGUuR1JBUEhRTF9GQUlMRURcclxuICAgICkge1xyXG4gICAgICBiYW5uZXIuc3R5bGUuYmFja2dyb3VuZCA9IFwicmdiYSgyMzksIDcxLCA2NywgMC4xMilcIjtcclxuICAgICAgYmFubmVyLnN0eWxlLmNvbG9yID0gXCIjZWY0NzQzXCI7XHJcbiAgICAgIGJhbm5lci5pbm5lckhUTUwgPSBgPHNwYW4+XHUyNkEwXHVGRTBGPC9zcGFuPjxzcGFuPiR7ZXJyb3IubWVzc2FnZX08L3NwYW4+YDtcclxuICAgIH0gZWxzZSBpZiAoZXJyb3IuY29kZSA9PT0gRXJyb3JDb2RlLlJBVEVfTElNSVRFRCkge1xyXG4gICAgICBiYW5uZXIuc3R5bGUuYmFja2dyb3VuZCA9IFwicmdiYSgyNTUsIDE2MSwgMjIsIDAuMTIpXCI7XHJcbiAgICAgIGJhbm5lci5zdHlsZS5jb2xvciA9IFwiI2ZmYTExNlwiO1xyXG4gICAgICBiYW5uZXIuaW5uZXJIVE1MID0gYDxzcGFuPlx1RDgzRFx1REQwNDwvc3Bhbj48c3Bhbj4ke2Vycm9yLm1lc3NhZ2V9PC9zcGFuPmA7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICBiYW5uZXIuc3R5bGUuYmFja2dyb3VuZCA9IFwicmdiYSgyMzksIDcxLCA2NywgMC4wOClcIjtcclxuICAgICAgYmFubmVyLnN0eWxlLmNvbG9yID0gXCIjZWY0NzQzXCI7XHJcbiAgICAgIGJhbm5lci5pbm5lckhUTUwgPSBgPHNwYW4+XHUyNzRDPC9zcGFuPjxzcGFuPiR7ZXJyb3IubWVzc2FnZX08L3NwYW4+YDtcclxuICAgIH1cclxuXHJcbiAgICAvLyBJbnNlcnQgYmVmb3JlIHRoZSBjb250ZXN0cyBsaXN0XHJcbiAgICBjb250ZXN0c0NvbnRhaW5lci5wYXJlbnROb2RlLmluc2VydEJlZm9yZShiYW5uZXIsIGNvbnRlc3RzQ29udGFpbmVyKTtcclxuICB9XHJcblxyXG4gIC8vIFx1MjUwMFx1MjUwMCBMb2FkICYgUmVuZGVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxyXG5cclxuICBmdW5jdGlvbiBmZXRjaEFuZFJlbmRlckhpc3RvcnkoKSB7XHJcbiAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoW1wibGNfdXNlcm5hbWVcIiwgXCJsYXN0X2Vycm9yXCJdLCAocmVzdWx0KSA9PiB7XHJcbiAgICAgIGNvbnN0IHVzZXJuYW1lID0gcmVzdWx0LmxjX3VzZXJuYW1lO1xyXG5cclxuICAgICAgLy8gU2hvdyBlcnJvciBiYW5uZXIgaWYgb25lIGV4aXN0c1xyXG4gICAgICByZW5kZXJTdGF0dXNCYW5uZXIocmVzdWx0Lmxhc3RfZXJyb3IgfHwgbnVsbCk7XHJcblxyXG4gICAgICBpZiAoIXVzZXJuYW1lKSB7XHJcbiAgICAgICAgY29udGVzdHNDb250YWluZXIuaW5uZXJIVE1MID1cclxuICAgICAgICAgICc8ZGl2IHN0eWxlPVwicGFkZGluZzogMTZweDsgdGV4dC1hbGlnbjogY2VudGVyOyBjb2xvcjogdmFyKC0tbGMtdGV4dC1zZWNvbmRhcnkpO1wiPlBsZWFzZSBsb2cgaW4gdG8gTGVldENvZGUsIHRoZW4gcmVvcGVuIHRoaXMgcG9wdXAuPC9kaXY+JztcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIExvZ2dlci5pbmZvKExPR19DVFgsIFwiRmV0Y2hpbmcgaGlzdG9yeSBmb3IgcG9wdXBcIiwgeyB1c2VybmFtZSB9KTtcclxuXHJcbiAgICAgIGNocm9tZS5ydW50aW1lLnNlbmRNZXNzYWdlKFxyXG4gICAgICAgIHsgYWN0aW9uOiBcImZldGNoVXNlckNvbnRlc3RIaXN0b3J5XCIsIHVzZXJuYW1lOiB1c2VybmFtZSB9LFxyXG4gICAgICAgIChyZXNwb25zZSkgPT4ge1xyXG4gICAgICAgICAgaWYgKHJlc3BvbnNlICYmIHJlc3BvbnNlLmRhdGEgJiYgcmVzcG9uc2UuZGF0YS5sZW5ndGggPiAwKSB7XHJcbiAgICAgICAgICAgIHJlbmRlckNvbnRlc3RzKHJlc3BvbnNlLmRhdGEuc2xpY2UoMCwgNSkpO1xyXG4gICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgY29udGVzdHNDb250YWluZXIuaW5uZXJIVE1MID1cclxuICAgICAgICAgICAgICAnPGRpdiBzdHlsZT1cInBhZGRpbmc6IDE2cHg7IHRleHQtYWxpZ246IGNlbnRlcjsgY29sb3I6IHZhcigtLWxjLXRleHQtc2Vjb25kYXJ5KTtcIj5ObyBjb250ZXN0IGhpc3RvcnkgZm91bmQuPC9kaXY+JztcclxuICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICk7XHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIC8vIExpc3RlbiBmb3IgdHlwZWQgYnJvYWRjYXN0IG1lc3NhZ2VzXHJcbiAgY2hyb21lLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKChyZXF1ZXN0KSA9PiB7XHJcbiAgICBpZiAoXHJcbiAgICAgIHJlcXVlc3QudHlwZSA9PT0gTWVzc2FnZVR5cGUuSElTVE9SWV9VUERBVEVEIHx8XHJcbiAgICAgIHJlcXVlc3QudHlwZSA9PT0gTWVzc2FnZVR5cGUuUFJFRElDVElPTl9VUERBVEVEXHJcbiAgICApIHtcclxuICAgICAgTG9nZ2VyLmluZm8oTE9HX0NUWCwgXCJSZWNlaXZlZCB1cGRhdGUgXHUyMDE0IHJlZnJlc2hpbmcgcG9wdXBcIiwge1xyXG4gICAgICAgIHR5cGU6IHJlcXVlc3QudHlwZSxcclxuICAgICAgfSk7XHJcbiAgICAgIGZldGNoQW5kUmVuZGVySGlzdG9yeSgpO1xyXG4gICAgfVxyXG5cclxuICAgIGlmIChyZXF1ZXN0LnR5cGUgPT09IE1lc3NhZ2VUeXBlLkVSUk9SX09DQ1VSUkVEKSB7XHJcbiAgICAgIExvZ2dlci53YXJuKExPR19DVFgsIFwiUmVjZWl2ZWQgZXJyb3IgYnJvYWRjYXN0XCIsIHtcclxuICAgICAgICBlcnJvcjogcmVxdWVzdC5wYXlsb2FkPy5lcnJvcixcclxuICAgICAgfSk7XHJcbiAgICAgIHJlbmRlclN0YXR1c0Jhbm5lcihyZXF1ZXN0LnBheWxvYWQ/LmVycm9yIHx8IG51bGwpO1xyXG4gICAgfVxyXG5cclxuICAgIGlmIChyZXF1ZXN0LnR5cGUgPT09IE1lc3NhZ2VUeXBlLkxPR0lOX0NIQU5HRUQpIHtcclxuICAgICAgTG9nZ2VyLmluZm8oTE9HX0NUWCwgXCJMb2dpbiBjaGFuZ2VkIFx1MjAxNCByZWZyZXNoaW5nIHBvcHVwXCIpO1xyXG4gICAgICBmZXRjaEFuZFJlbmRlckhpc3RvcnkoKTtcclxuICAgIH1cclxuICB9KTtcclxuXHJcbiAgZmV0Y2hBbmRSZW5kZXJIaXN0b3J5KCk7XHJcblxyXG4gIC8vIFx1MjUwMFx1MjUwMCBSZW5kZXIgQ29udGVzdCBDYXJkcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcclxuXHJcbiAgZnVuY3Rpb24gcmVuZGVyQ29udGVzdHMoY29udGVzdHMpIHtcclxuICAgIGNvbnRlc3RzQ29udGFpbmVyLmlubmVySFRNTCA9IFwiXCI7XHJcblxyXG4gICAgY29udGVzdHMuZm9yRWFjaCgoY29udGVzdCkgPT4ge1xyXG4gICAgICBjb25zdCBjYXJkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcclxuICAgICAgY2FyZC5jbGFzc05hbWUgPSBcImNvbnRlc3QtY2FyZFwiO1xyXG5cclxuICAgICAgbGV0IGRlbHRhQ2xhc3MgPSBcIm5ldXRyYWxcIjtcclxuICAgICAgbGV0IGRlbHRhU2lnbiA9IFwiXCI7XHJcbiAgICAgIGxldCBhcnJvdyA9IFwiXCI7XHJcblxyXG4gICAgICBjb25zdCBkZWx0YVZhbCA9XHJcbiAgICAgICAgY29udGVzdC5kZWx0YSAhPT0gbnVsbCAmJlxyXG4gICAgICAgIGNvbnRlc3QuZGVsdGEgIT09IHVuZGVmaW5lZCAmJlxyXG4gICAgICAgIGNvbnRlc3QuZGVsdGEgIT09IFwiLVwiXHJcbiAgICAgICAgICA/IE1hdGgucm91bmQoY29udGVzdC5kZWx0YSlcclxuICAgICAgICAgIDogbnVsbDtcclxuXHJcbiAgICAgIGlmIChkZWx0YVZhbCAhPT0gbnVsbCkge1xyXG4gICAgICAgIGlmIChkZWx0YVZhbCA+IDApIHtcclxuICAgICAgICAgIGRlbHRhQ2xhc3MgPSBcInBvc2l0aXZlXCI7XHJcbiAgICAgICAgICBkZWx0YVNpZ24gPSBcIitcIjtcclxuICAgICAgICAgIGFycm93ID0gXCJcdTIxOTFcIjtcclxuICAgICAgICB9IGVsc2UgaWYgKGRlbHRhVmFsIDwgMCkge1xyXG4gICAgICAgICAgZGVsdGFDbGFzcyA9IFwibmVnYXRpdmVcIjtcclxuICAgICAgICAgIGFycm93ID0gXCJcdTIxOTNcIjtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgZGVsdGFTaWduID0gXCJcIjtcclxuICAgICAgICAgIGFycm93ID0gXCItXCI7XHJcbiAgICAgICAgfVxyXG4gICAgICB9XHJcblxyXG4gICAgICBjb25zdCBkZWx0YUhUTUwgPVxyXG4gICAgICAgIGRlbHRhVmFsICE9PSBudWxsID8gYCR7ZGVsdGFTaWdufSR7ZGVsdGFWYWx9ICR7YXJyb3d9YCA6IFwiXHUyMDEzXCI7XHJcblxyXG4gICAgICBjb25zdCBhY3R1YWxUZXh0ID1cclxuICAgICAgICBjb250ZXN0LmFjdHVhbFJhdGluZyAhPT0gbnVsbCAmJlxyXG4gICAgICAgIGNvbnRlc3QuYWN0dWFsUmF0aW5nICE9PSB1bmRlZmluZWQgJiZcclxuICAgICAgICBjb250ZXN0LmFjdHVhbFJhdGluZyAhPT0gXCItXCJcclxuICAgICAgICAgID8gTWF0aC5yb3VuZChjb250ZXN0LmFjdHVhbFJhdGluZylcclxuICAgICAgICAgIDogXCJcdTIwMTNcIjtcclxuXHJcbiAgICAgIGxldCBwcmVkaWN0ZWRUZXh0O1xyXG4gICAgICBpZiAoY29udGVzdC5zdGF0dXMgPT09ICdwcmVkaWN0aW9uX3BlbmRpbmcnKSB7XHJcbiAgICAgICAgcHJlZGljdGVkVGV4dCA9ICc8c3BhbiBzdHlsZT1cImNvbG9yOiAjZmZhMTE2OyBmb250LXNpemU6IDEycHg7IGZvbnQtd2VpZ2h0OiBub3JtYWw7XCI+UGVuZGluZzwvc3Bhbj4nO1xyXG4gICAgICB9IGVsc2Uge1xyXG4gICAgICAgIHByZWRpY3RlZFRleHQgPVxyXG4gICAgICAgICAgY29udGVzdC5wcmVkaWN0ZWRSYXRpbmcgIT09IG51bGwgJiZcclxuICAgICAgICAgIGNvbnRlc3QucHJlZGljdGVkUmF0aW5nICE9PSB1bmRlZmluZWQgJiZcclxuICAgICAgICAgIGNvbnRlc3QucHJlZGljdGVkUmF0aW5nICE9PSBcIi1cIlxyXG4gICAgICAgICAgICA/IE1hdGgucm91bmQoY29udGVzdC5wcmVkaWN0ZWRSYXRpbmcpXHJcbiAgICAgICAgICAgIDogXCJcdTIwMTNcIjtcclxuICAgICAgfVxyXG5cclxuICAgICAgY29uc3QgcGVuZGluZ0JhZGdlID0gKGNvbnRlc3Quc3RhdHVzID09PSAncGVuZGluZycgfHwgY29udGVzdC5zdGF0dXMgPT09ICdwcmVkaWN0aW9uX3BlbmRpbmcnKVxyXG4gICAgICAgID8gJzxzcGFuIHN0eWxlPVwiZm9udC1zaXplOiAxMHB4OyBjb2xvcjogI2ZmYTExNjsgYm9yZGVyOiAxcHggc29saWQgcmdiYSgyNTUsMTYxLDIyLDAuNSk7IGJhY2tncm91bmQ6IHJnYmEoMjU1LDE2MSwyMiwwLjEpOyBib3JkZXItcmFkaXVzOiA0cHg7IHBhZGRpbmc6IDFweCA0cHg7IG1hcmdpbi1sZWZ0OiA2cHg7IGZvbnQtd2VpZ2h0OiBub3JtYWw7XCI+UGVuZGluZzwvc3Bhbj4nXHJcbiAgICAgICAgOiAnJztcclxuXHJcbiAgICAgIGNhcmQuaW5uZXJIVE1MID0gYFxyXG4gICAgICAgIDxkaXYgY2xhc3M9XCJjb250ZXN0LWhlYWRlclwiPlxyXG4gICAgICAgICAgPGRpdiBjbGFzcz1cImNvbnRlc3QtdGl0bGVcIj4ke2NvbnRlc3QubmFtZX0ke3BlbmRpbmdCYWRnZX08L2Rpdj5cclxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJkZWx0YSAke2RlbHRhQ2xhc3N9XCI+XHJcbiAgICAgICAgICAgICR7ZGVsdGFIVE1MfVxyXG4gICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgPGRpdiBjbGFzcz1cImNvbnRlc3QtZGV0YWlsc1wiPlxyXG4gICAgICAgICAgPGRpdiBjbGFzcz1cInJhdGluZy1pbmZvXCI+XHJcbiAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwicmF0aW5nLWxhYmVsXCI+QWN0dWFsPC9zcGFuPlxyXG4gICAgICAgICAgICA8c3BhbiBjbGFzcz1cInJhdGluZy12YWx1ZVwiPiR7YWN0dWFsVGV4dH08L3NwYW4+XHJcbiAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJyYXRpbmctaW5mb1wiIHN0eWxlPVwidGV4dC1hbGlnbjogcmlnaHQ7XCI+XHJcbiAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwicmF0aW5nLWxhYmVsXCI+UHJlZGljdGVkPC9zcGFuPlxyXG4gICAgICAgICAgICA8c3BhbiBjbGFzcz1cInJhdGluZy12YWx1ZVwiPiR7cHJlZGljdGVkVGV4dH08L3NwYW4+XHJcbiAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICA8L2Rpdj5cclxuICAgICAgYDtcclxuXHJcbiAgICAgIGNvbnRlc3RzQ29udGFpbmVyLmFwcGVuZENoaWxkKGNhcmQpO1xyXG4gICAgfSk7XHJcbiAgfVxyXG59KTtcclxuIl0sCiAgIm1hcHBpbmdzIjogIjs7QUFPTyxNQUFNLGNBQWM7QUFBQTtBQUFBLElBRXpCLG9CQUFvQjtBQUFBO0FBQUEsSUFFcEIsaUJBQWlCO0FBQUE7QUFBQSxJQUVqQixlQUFlO0FBQUE7QUFBQSxJQUVmLGdCQUFnQjtBQUFBLEVBQ2xCOzs7QUNUTyxNQUFNLFlBQVk7QUFBQTtBQUFBLElBRXZCLGVBQWU7QUFBQTtBQUFBLElBRWYsZ0JBQWdCO0FBQUE7QUFBQSxJQUVoQixvQkFBb0I7QUFBQTtBQUFBLElBRXBCLGdCQUFnQjtBQUFBO0FBQUEsSUFFaEIsY0FBYztBQUFBO0FBQUEsSUFFZCxlQUFlO0FBQUEsRUFDakI7QUFLQSxNQUFNLGdCQUFnQjtBQUFBLElBQ3BCLENBQUMsVUFBVSxhQUFhLEdBQUc7QUFBQSxJQUMzQixDQUFDLFVBQVUsY0FBYyxHQUFHO0FBQUEsSUFDNUIsQ0FBQyxVQUFVLGtCQUFrQixHQUFHO0FBQUEsSUFDaEMsQ0FBQyxVQUFVLGNBQWMsR0FBRztBQUFBLElBQzVCLENBQUMsVUFBVSxZQUFZLEdBQUc7QUFBQSxJQUMxQixDQUFDLFVBQVUsYUFBYSxHQUFHO0FBQUEsRUFDN0I7OztBQ3pCTyxNQUFN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
