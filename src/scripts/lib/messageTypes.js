/**
 * Typed broadcast message constants and factory.
 *
 * All inter-component messaging (background ↔ popup ↔ content scripts)
 * uses these types to ensure consistency and future-proofing.
 */

export const MessageType = {
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
export function createMessage(type, payload = {}) {
  return { type, payload, timestamp: Date.now() };
}
