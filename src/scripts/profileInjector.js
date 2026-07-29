/**
 * LeetCode Profile Predictor Injector
 *
 * Injects the predicted rating on a user's LeetCode profile page.
 */

// ── Shared modules (inlined by build.cjs) ───────────────────────────────────
import { MessageType } from "./lib/messageTypes.js";
import { Logger } from "./lib/logger.js";

const LOG_CTX = "ProfileInjector";

function injectPredictedRating(predictedRating) {
  // If it already exists, update it
  const existing = document.getElementById("lc-predictor-injected-rating");
  if (existing) {
    const valueEl = existing.querySelector(".predicted-rating-value");
    if (valueEl) valueEl.textContent = Math.round(predictedRating);
    return;
  }

  // Find the "Attended" block. It's usually a div containing text "Attended"
  const walk = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );
  let attendedTextNode = null;
  let node;
  while ((node = walk.nextNode())) {
    if (node.nodeValue.trim() === "Attended") {
      attendedTextNode = node;
      break;
    }
  }

  if (!attendedTextNode) return; // Wait for it to render

  const attendedContainer = attendedTextNode.parentElement.parentElement;
  // Structure is typically:
  // <div>
  //   <div class="text-label">Attended</div>
  //   <div class="text-value">123</div>
  // </div>
  // Or similar. We will just clone the parent container.

  if (!attendedContainer) return;

  const siblingContainer = attendedContainer.parentElement;

  const newBlock = attendedContainer.cloneNode(true);
  newBlock.id = "lc-predictor-injected-rating";

  // The first div is usually the label, the second is the value
  const divs = newBlock.querySelectorAll("div");
  let labelDiv = null;
  let valueDiv = null;

  for (const d of divs) {
    if (d.textContent.trim() === "Attended") {
      labelDiv = d;
    } else if (!isNaN(parseInt(d.textContent.trim()))) {
      valueDiv = d;
    }
  }

  if (labelDiv && valueDiv) {
    labelDiv.textContent = "Predicted";
    newBlock.style.marginLeft = "1.5rem";
    
    // Remove any children of valueDiv if there are icons or spans, keep it simple
    valueDiv.textContent = Math.round(predictedRating);
    valueDiv.className += " predicted-rating-value"; // mark it for updates

    siblingContainer.appendChild(newBlock);
    Logger.info(LOG_CTX, "Injected predicted rating on profile", {
      rating: Math.round(predictedRating),
    });
  }
}

function removePredictedRating() {
  const existing = document.getElementById("lc-predictor-injected-rating");
  if (existing) {
    existing.remove();
    Logger.info(LOG_CTX, "Removed predicted rating from profile");
  }
}

function checkAndInject() {
  const urlParts = window.location.pathname.split("/").filter(Boolean);
  if (urlParts[0] !== "u" || !urlParts[1]) return;
  const usernameFromUrl = urlParts[1];

  chrome.storage.local.get(["lc_username"], (res) => {
    if (res.lc_username !== usernameFromUrl) {
      // Not the tracked user, or user not set up
      return;
    }

    // Ask background script for history
    chrome.runtime.sendMessage(
      { action: "fetchUserContestHistory", username: usernameFromUrl },
      (response) => {
        if (response && response.data && response.data.length > 0) {
          const latest = response.data[0];
          // actualRating is null if pending
          if (
            latest.actualRating === null ||
            latest.actualRating === undefined ||
            latest.actualRating === "-"
          ) {
            // It's pending, inject it!
            injectPredictedRating(latest.predictedRating);
          } else {
            // It's confirmed, remove if exists
            removePredictedRating();
          }
        }
      }
    );
  });
}

// Observe DOM changes for SPA navigation and lazy loading
const observer = new MutationObserver(() => {
  checkAndInject();
});

observer.observe(document.body, { childList: true, subtree: true });

// Initial check
checkAndInject();

// Listen for typed broadcast messages
chrome.runtime.onMessage.addListener((request) => {
  if (
    request.type === MessageType.HISTORY_UPDATED ||
    request.type === MessageType.PREDICTION_UPDATED
  ) {
    Logger.info(LOG_CTX, "Received update broadcast — rechecking profile", {
      type: request.type,
    });
    checkAndInject();
  }
});
