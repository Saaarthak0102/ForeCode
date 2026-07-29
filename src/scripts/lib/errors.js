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
