/**
 * LeetCode Contest Leaderboard Content Script
 *
 * Injects predicted rating badges next to usernames on the
 * contest leaderboard page.
 */

// ── Shared modules (inlined by build.cjs) ───────────────────────────────────
// {{INLINE:lib/messageTypes.js}}
// {{INLINE:lib/logger.js}}

const LOG_CTX = "Content";

Logger.info(LOG_CTX, "LeetCode Rating Predictor content script loaded");

const processedRows = new Set();
let debounceTimer;

// Observer to watch for DOM changes (since LC is a SPA and table loads dynamically)
const observer = new MutationObserver((mutations) => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    processLeaderboard();
  }, 500); // Wait for DOM to settle
});

// Start observing the body
observer.observe(document.body, { childList: true, subtree: true });

function processLeaderboard() {
  // Try to find ranking rows. LeetCode uses various class names,
  // but generally they are inside a table or list format.
  // We look for table rows that contain a user link.
  const rows = document.querySelectorAll("tr, .row-class"); // Adjust selector based on actual DOM

  const usersToFetch = [];
  const rowElements = [];

  rows.forEach((row) => {
    // Skip if already processed or header row
    if (processedRows.has(row) || row.querySelector("th")) return;

    // Find the username link (usually an anchor tag wrapping the username)
    const userLink = row.querySelector('a[href^="/"]');
    if (userLink) {
      let username = userLink.getAttribute("href").replace(/\//g, "");

      // Sometimes href is /username/
      if (username) {
        usersToFetch.push(username);
        rowElements.push({ row, username });
        processedRows.add(row);
      }
    }
  });

  if (usersToFetch.length > 0) {
    Logger.info(LOG_CTX, "Fetching predictions for leaderboard users", {
      count: usersToFetch.length,
    });

    // Send message to background to fetch predictions
    chrome.runtime.sendMessage(
      { action: "fetchPredictions", usernames: usersToFetch },
      (response) => {
        if (response && response.data) {
          injectPredictions(rowElements, response.data);
        }
      }
    );
  }
}

function injectPredictions(rowElements, predictionData) {
  rowElements.forEach(({ row, username }) => {
    const data = predictionData[username];
    if (data) {
      // Find the score or username container to inject our badge
      // As a fallback, we append it to the username link container
      const userLink = row.querySelector(`a[href="/${username}/"]`);
      if (userLink && !row.querySelector(".lc-predictor-badge")) {
        const badge = document.createElement("span");
        badge.className = "lc-predictor-badge";

        const delta = data.delta;
        const color =
          delta > 0 ? "#2cbb5d" : delta < 0 ? "#ef4743" : "#eff2f699";
        const sign = delta > 0 ? "+" : "";
        const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "-";

        badge.style.cssText = `
          margin-left: 8px;
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 600;
          background: rgba(255, 255, 255, 0.08);
          color: ${color};
        `;
        badge.innerHTML = `${sign}${Math.round(delta)} ${arrow}`;
        badge.title = `Predicted Rating: ${Math.round(data.newRating)}`;

        userLink.parentNode.appendChild(badge);
      }
    }
  });
}

// Listen for typed broadcast messages
chrome.runtime.onMessage.addListener((request) => {
  if (
    request.type === MessageType.HISTORY_UPDATED ||
    request.type === MessageType.PREDICTION_UPDATED
  ) {
    Logger.info(LOG_CTX, "Received update broadcast — reprocessing", {
      type: request.type,
    });
    processedRows.clear();
    processLeaderboard();
  }
});

// Initial run
setTimeout(processLeaderboard, 1000);
