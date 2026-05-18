// Transport error tagging — maps low-level connection failures to actionable
// codes that the renderer can map to user-friendly messages.
//
// Codes (kept in sync with ui/dashboard.html vpn:error handler):
//   TUN_NOT_LOADED         macOS utun unavailable / Network Extension permission missing
//   TUN_PERMISSION_DENIED  macOS sudo prompt rejected or no privileged helper
//   NDIS_INSTALL_FAILED    Windows TAP/WinTun driver missing
//   NETWORK_UNREACHABLE    Cannot reach VPN server (DNS or routing failure)
//   TIMEOUT                Handshake / probe did not complete
//   PROVISION_FAILED       Server returned an error provisioning VLESS credentials
//   UNKNOWN                Fallback

const PATTERNS = [
  // macOS TUN problems
  { code: "TUN_NOT_LOADED", re: /utun|tun(?:\d+)?\b.*(?:not found|unavailable|no such device)|network extension|cannot.*create.*tun/i },
  { code: "TUN_NOT_LOADED", re: /TUN interface did not appear|TUN inbound missing/i },
  // Permission denied on elevated commands
  { code: "TUN_PERMISSION_DENIED", re: /permission denied|operation not permitted|user cancelled|authoriz(?:ation|ed).*declin|sudo: a password is required|EACCES/i },
  // Windows driver issues
  { code: "NDIS_INSTALL_FAILED", re: /wintun|tap-windows|ndis|driver.*not.*(?:installed|loaded)|sing-box binary not found.*\.exe/i },
  // Network reachability failures
  { code: "NETWORK_UNREACHABLE", re: /ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|cannot resolve|getaddrinfo.*(?:ENOTFOUND|EAI)|network is unreachable|no route to host/i },
  // Provisioning failures (apiCall errors during VLESS UUID setup)
  { code: "PROVISION_FAILED", re: /VLESS (?:UUID|credential) provisioning failed|provisioning failed/i },
  // Handshake / timeout
  { code: "TIMEOUT", re: /ETIMEDOUT|timed out|timeout|connect ECONNREFUSED|ECONNRESET|connection (?:refused|reset)|handshake.*(?:fail|timeout)/i },
];

function tagTransportError(err) {
  if (!err) return err;
  // Already tagged — return as-is
  if (err.code && /^[A-Z_]+$/.test(err.code) && PATTERNS.some(p => p.code === err.code)) {
    return err;
  }
  const message = String(err.message || err);
  for (const { code, re } of PATTERNS) {
    if (re.test(message)) {
      err.code = code;
      return err;
    }
  }
  err.code = "UNKNOWN";
  return err;
}

// Renderer-facing user messages (mirror in ui/dashboard.html for i18n later).
// Kept here so main process can use them too if needed.
const USER_MESSAGES = {
  TUN_NOT_LOADED: "VPN driver not available. Reinstall the app or grant Network Extension permission in System Settings.",
  TUN_PERMISSION_DENIED: "Permission required to start the VPN tunnel.",
  NDIS_INSTALL_FAILED: "VPN driver not installed. Reinstall the app as Administrator.",
  NETWORK_UNREACHABLE: "Couldn't reach the VPN server. Check your internet.",
  TIMEOUT: "Connection timed out — try again.",
  PROVISION_FAILED: "Couldn't set up your VPN credentials. Try again in a moment.",
  UNKNOWN: null, // fall back to caller's message
};

module.exports = { tagTransportError, USER_MESSAGES };
