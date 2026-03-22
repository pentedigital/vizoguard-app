const https = require("https");
const pkg = require("../package.json");

const API_BASE = "https://vizoguard.com/api";

function singleRequest(endpoint, body) {
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
        "User-Agent": `Vizoguard/${pkg.version}`,
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
            reject({ httpStatus: res.statusCode, ...json });
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

async function apiCall(endpoint, body) {
  const MAX_RETRIES = 2;
  const BASE_DELAY = 1000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await singleRequest(endpoint, body);
    } catch (err) {
      const isLastAttempt = attempt === MAX_RETRIES;
      // Only retry on 5xx or network errors, never on 4xx
      const isRetryable = !err.httpStatus || err.httpStatus >= 500;
      if (isLastAttempt || !isRetryable) throw err;
      await new Promise((r) => setTimeout(r, BASE_DELAY * Math.pow(2, attempt)));
    }
  }
}

module.exports = { apiCall };
