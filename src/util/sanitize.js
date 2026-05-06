/**
 * Sanitize strings before logging to prevent credential leakage.
 * Mirrors the Android VizoLogger.sanitize() logic.
 */
function sanitize(msg) {
  if (typeof msg !== "string") return msg;
  return msg
    .replace(/VIZO-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/g, "VIZO-****-****-****-****")
    .replace(/ss:\/\/[^\s]+/g, "ss://[REDACTED]")
    .replace(/vless:\/\/[^\s]+/g, "vless://[REDACTED]")
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, "[UUID_REDACTED]")
    .replace(/\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g, "[IP_REDACTED]")
    .replace(/[a-fA-F0-9]{64}/g, "[HASH_REDACTED]");
}

/**
 * Wrapper around console.log that sanitizes arguments.
 */
function safeLog(level, ...args) {
  const sanitized = args.map((a) => (typeof a === "string" ? sanitize(a) : a));
  console[level](...sanitized);
}

module.exports = { sanitize, safeLog };
