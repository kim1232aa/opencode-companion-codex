// The stall watchdog must end the ATTEMPT promptly, not just the session.
//
// Regression: on stall the watchdog called abortSession (server-side), relying
// on the server to end the in-flight POST. A wedged server that accepts the
// abort but never answers left the request — and the whole attempt — parked
// until the wall-clock prompt timeout (30 min default). The watchdog now also
// cuts the POST loose client-side via the httpPostJson aborter hook.
//
// This test runs a REAL local HTTP server that swallows the prompt POST forever
// and asserts the attempt fails in seconds, not minutes. Also covers the
// maxAttempts<1 guard (used to `throw null`).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createClient, dispatchWithRetry } from "../plugins/opencode-companion/scripts/lib/opencode-server.mjs";

let server;
let baseUrl;
let sawPrompt = false;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.method === "POST" && /\/session\/.+\/message$/.test(req.url)) {
      sawPrompt = true;
      req.resume(); // read the body, answer NEVER — the wedged-server case
      return;
    }
    // Everything else (permission/question pollers etc.): empty JSON.
    res.setHeader("content-type", "application/json");
    res.end("[]");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

describe("dispatchWithRetry — stall cuts the in-flight prompt POST loose", () => {
  it("a stalled attempt against a wedged server ends in seconds, not the 30-min wall clock", async () => {
    const real = createClient(baseUrl);
    const client = {
      ...real,
      // No token progress ever ⇒ the watchdog must trip at stallMs.
      getSessionUsage: async () => ({ total: 0, turns: 0 }),
      getSessionActivity: undefined,
      abortSession: async () => ({}), // server "accepts" the abort but the POST stays parked
      getLastTurnError: async () => null,
    };
    const start = Date.now();
    await assert.rejects(
      dispatchWithRetry({
        client,
        prompt: "hang forever",
        agent: "plan",
        extract: () => "",
        makeSession: () => ({ id: "ses_wedged" }),
        maxAttempts: 1,
        stallMs: 300,
        beatMs: 100,
        backoffMs: 1,
      }),
      /Stalled|no token progress/i
    );
    const elapsed = Date.now() - start;
    assert.equal(sawPrompt, true, "the prompt POST must actually have reached the server");
    assert.ok(elapsed < 5000, `attempt must end promptly after the stall (took ${elapsed}ms)`);
  });

  it("maxAttempts < 1 throws a real error, never null", async () => {
    await assert.rejects(
      dispatchWithRetry({
        client: {},
        prompt: "x",
        extract: () => "",
        makeSession: () => ({ id: "s" }),
        maxAttempts: 0,
      }),
      /maxAttempts must be >= 1/
    );
  });
});
