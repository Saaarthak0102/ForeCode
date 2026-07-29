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

export const Storage = {
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
