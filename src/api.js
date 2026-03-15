const https = require("https");

const API_BASE = "https://vizoguard.com/api";

function apiCall(endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(`${API_BASE}${endpoint}`);

    const opts = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "User-Agent": "Vizoguard/1.1.0",
      },
    };

    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject({ status: res.statusCode, ...json });
          }
        } catch {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.setTimeout(15000, () => {
      req.destroy(new Error("Request timed out"));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { apiCall };
