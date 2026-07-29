/**
 * Structured logger for the Chrome extension.
 *
 * Replaces raw console.log/error/warn calls with structured output
 * that includes timestamps, context modules, and relevant data.
 */

export const Logger = {
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
