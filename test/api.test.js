"use strict";

/**
 * API client tests — validates:
 * 1. Successful requests return parsed JSON
 * 2. Correct headers, method, and body sent
 * 3. 4xx errors reject immediately (no retry)
 * 4. 5xx errors retry with exponential backoff
 * 5. Network errors retry with exponential backoff
 * 6. Timeout configuration and behavior
 * 7. Non-JSON response handling
 */

const { describe, it, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const https = require("https");
const { EventEmitter } = require("events");
const pkg = require("../package.json");

// ── Save original ───────────────────────────────────────────────────────────

const originalRequest = https.request;

afterEach(() => {
  https.request = originalRequest;
  mock.timers.reset();
});

// ── Require module under test ───────────────────────────────────────────────

const { apiCall } = require("../src/api");

// ── Mock helpers ────────────────────────────────────────────────────────────

class MockResponse extends EventEmitter {
  constructor(statusCode) {
    super();
    this.statusCode = statusCode;
  }
}

class MockRequest extends EventEmitter {
  constructor() {
    super();
    this._timeout = null;
  }
  write() {}
  end() {}
  setTimeout(ms, cb) {
    this._timeout = { ms, cb };
  }
  destroy(err) {
    this.emit("error", err || new Error("destroyed"));
  }
}

function mockResponse(statusCode, body) {
  const req = new MockRequest();
  https.request = (opts, cb) => {
    process.nextTick(() => {
      const res = new MockResponse(statusCode);
      cb(res);
      process.nextTick(() => {
        res.emit("data", JSON.stringify(body));
        res.emit("end");
      });
    });
    return req;
  };
  return req;
}

// ── Flush helper — drains microtask queue ───────────────────────────────────

function flush() {
  return new Promise((r) => setImmediate(r));
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("apiCall", () => {
  it("successful POST returns parsed JSON", async () => {
    mockResponse(200, { ok: true });
    const result = await apiCall("/test", { foo: "bar" });
    assert.deepStrictEqual(result, { ok: true });
  });

  it("sends POST with correct headers", async () => {
    let capturedOpts;
    const req = new MockRequest();
    https.request = (opts, cb) => {
      capturedOpts = opts;
      process.nextTick(() => {
        const res = new MockResponse(200);
        cb(res);
        process.nextTick(() => {
          res.emit("data", JSON.stringify({ ok: true }));
          res.emit("end");
        });
      });
      return req;
    };

    await apiCall("/check", { key: "abc" });

    assert.equal(capturedOpts.method, "POST");
    assert.equal(capturedOpts.hostname, "vizoguard.com");
    assert.equal(capturedOpts.path, "/api/check");
    assert.equal(capturedOpts.port, 443);
    assert.equal(capturedOpts.headers["Content-Type"], "application/json");
    assert.equal(capturedOpts.headers["User-Agent"], `Vizoguard/${pkg.version}`);
  });

  it("sends JSON body via req.write()", async () => {
    let writtenData;
    const req = new MockRequest();
    req.write = (data) => {
      writtenData = data;
    };
    https.request = (opts, cb) => {
      process.nextTick(() => {
        const res = new MockResponse(200);
        cb(res);
        process.nextTick(() => {
          res.emit("data", JSON.stringify({ ok: true }));
          res.emit("end");
        });
      });
      return req;
    };

    const body = { license: "VIZO-1234", device: "test" };
    await apiCall("/activate", body);

    assert.equal(writtenData, JSON.stringify(body));
  });

  it("400 error rejects with httpStatus", async () => {
    mockResponse(400, { error: "bad request" });
    await assert.rejects(
      () => apiCall("/test", {}),
      (err) => {
        assert.equal(err.httpStatus, 400);
        assert.equal(err.error, "bad request");
        return true;
      }
    );
  });

  it("403 error never retries (call count = 1)", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    let callCount = 0;
    const req = new MockRequest();
    https.request = (opts, cb) => {
      callCount++;
      process.nextTick(() => {
        const res = new MockResponse(403);
        cb(res);
        process.nextTick(() => {
          res.emit("data", JSON.stringify({ error: "forbidden" }));
          res.emit("end");
        });
      });
      return req;
    };

    await assert.rejects(() => apiCall("/test", {}));
    assert.equal(callCount, 1);
  });

  it("500 error retries twice then rejects (3 total calls)", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    let callCount = 0;
    https.request = (opts, cb) => {
      callCount++;
      const req = new MockRequest();
      process.nextTick(() => {
        const res = new MockResponse(500);
        cb(res);
        process.nextTick(() => {
          res.emit("data", JSON.stringify({ error: "server error" }));
          res.emit("end");
        });
      });
      return req;
    };

    const promise = apiCall("/test", {});
    // Attach rejection handler immediately to prevent unhandledRejection
    const rejectPromise = assert.rejects(
      () => promise,
      (err) => {
        assert.equal(err.httpStatus, 500);
        return true;
      }
    );

    for (let i = 0; i < 10; i++) await flush();
    mock.timers.tick(1000);
    for (let i = 0; i < 10; i++) await flush();
    mock.timers.tick(2000);
    for (let i = 0; i < 10; i++) await flush();

    await rejectPromise;
    assert.equal(callCount, 3);
  });

  it("500 then success on retry", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    let callCount = 0;
    https.request = (opts, cb) => {
      callCount++;
      const req = new MockRequest();
      const statusCode = callCount === 1 ? 500 : 200;
      const body = callCount === 1 ? { error: "fail" } : { ok: true };
      process.nextTick(() => {
        const res = new MockResponse(statusCode);
        cb(res);
        process.nextTick(() => {
          res.emit("data", JSON.stringify(body));
          res.emit("end");
        });
      });
      return req;
    };

    const promise = apiCall("/test", {});
    for (let i = 0; i < 10; i++) await flush();
    mock.timers.tick(1000);
    for (let i = 0; i < 10; i++) await flush();

    const result = await promise;
    assert.deepStrictEqual(result, { ok: true });
    assert.equal(callCount, 2);
  });

  it("network error retries then rejects (3 total calls)", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    let callCount = 0;
    https.request = (opts, cb) => {
      callCount++;
      const req = new MockRequest();
      process.nextTick(() => {
        req.emit("error", new Error("ECONNRESET"));
      });
      return req;
    };

    const promise = apiCall("/test", {});
    const rejectPromise = assert.rejects(
      () => promise,
      (err) => {
        assert.equal(err.message, "ECONNRESET");
        return true;
      }
    );

    for (let i = 0; i < 10; i++) await flush();
    mock.timers.tick(1000);
    for (let i = 0; i < 10; i++) await flush();
    mock.timers.tick(2000);
    for (let i = 0; i < 10; i++) await flush();

    await rejectPromise;
    assert.equal(callCount, 3);
  });

  it("network error then success on retry", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    let callCount = 0;
    https.request = (opts, cb) => {
      callCount++;
      const req = new MockRequest();
      if (callCount === 1) {
        process.nextTick(() => {
          req.emit("error", new Error("ECONNREFUSED"));
        });
      } else {
        process.nextTick(() => {
          const res = new MockResponse(200);
          cb(res);
          process.nextTick(() => {
            res.emit("data", JSON.stringify({ recovered: true }));
            res.emit("end");
          });
        });
      }
      return req;
    };

    const promise = apiCall("/test", {});
    for (let i = 0; i < 10; i++) await flush();
    mock.timers.tick(1000);
    for (let i = 0; i < 10; i++) await flush();

    const result = await promise;
    assert.deepStrictEqual(result, { recovered: true });
    assert.equal(callCount, 2);
  });

  it("15s timeout configured on request", async () => {
    const req = mockResponse(200, { ok: true });
    await apiCall("/test", {});
    assert.equal(req._timeout.ms, 15000);
  });

  it("timeout triggers request destruction and rejects", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    let callCount = 0;
    https.request = (opts, cb) => {
      callCount++;
      const req = new MockRequest();
      // Simulate timeout on every attempt by firing the timeout callback
      process.nextTick(() => {
        req._timeout.cb();
      });
      return req;
    };

    const promise = apiCall("/test", {});
    const rejectPromise = assert.rejects(
      () => promise,
      (err) => {
        assert.ok(err.message.includes("timed out") || err.message.includes("destroyed"));
        return true;
      }
    );

    for (let i = 0; i < 10; i++) await flush();
    mock.timers.tick(1000);
    for (let i = 0; i < 10; i++) await flush();
    mock.timers.tick(2000);
    for (let i = 0; i < 10; i++) await flush();

    await rejectPromise;
    // Network-level errors are retryable, so 3 attempts
    assert.equal(callCount, 3);
  });

  it("non-JSON response rejects with HTTP status in message", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    let callCount = 0;
    https.request = (opts, cb) => {
      callCount++;
      const r = new MockRequest();
      process.nextTick(() => {
        const res = new MockResponse(502);
        cb(res);
        process.nextTick(() => {
          res.emit("data", "Bad Gateway");
          res.emit("end");
        });
      });
      return r;
    };

    const promise = apiCall("/test", {});
    const rejectPromise = assert.rejects(
      () => promise,
      (err) => {
        assert.ok(err.message.includes("HTTP 502"));
        assert.ok(err.message.includes("Bad Gateway"));
        return true;
      }
    );

    for (let i = 0; i < 10; i++) await flush();
    mock.timers.tick(1000);
    for (let i = 0; i < 10; i++) await flush();
    mock.timers.tick(2000);
    for (let i = 0; i < 10; i++) await flush();

    await rejectPromise;
  });
});
