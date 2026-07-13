import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { dispatchWithRetry } from "../plugins/opencode-companion/scripts/lib/opencode-server.mjs";

// A response's text is read via this extract; the fake client returns { text }.
const extract = (r) => (r && typeof r.text === "string" ? r.text : "");

/**
 * Minimal fake OpenCode client. `sendPrompt(callNo, ...)` lets a test decide
 * per-attempt behavior; `calls` records how many times each method ran so a
 * test can assert that an empty turn is NOT retried.
 */
function makeClient({ sendPrompt, usage } = {}) {
  const calls = { sendPrompt: 0, createSession: 0, abortSession: 0, getSessionUsage: 0 };
  let seq = 0;
  const client = {
    calls,
    createSession: async () => { calls.createSession++; return { id: `s${++seq}` }; },
    getSessionUsage: async () => { calls.getSessionUsage++; return usage ?? { total: 0, output: 0, turns: 0 }; },
    abortSession: async () => { calls.abortSession++; },
    sendPrompt: async (sessionId, prompt, opts) => {
      calls.sendPrompt++;
      return sendPrompt(calls.sendPrompt, sessionId, prompt, opts);
    },
  };
  return client;
}

// Shared opts: a huge beatMs keeps the stall watchdog dormant during a fast
// test, and a tiny backoffMs keeps retries instant.
const opts = (client, over = {}) => ({
  client,
  prompt: "do the thing",
  agent: "build",
  extract,
  makeSession: () => client.createSession(),
  beatMs: 60_000,
  backoffMs: 1,
  ...over,
});

describe("dispatchWithRetry", () => {
  it("retries a transient error and succeeds on the third attempt", async () => {
    const client = makeClient({
      sendPrompt: (n) => {
        if (n < 3) throw new Error(`boom ${n}`);
        return { text: "final answer" };
      },
    });
    const res = await dispatchWithRetry(opts(client));
    assert.equal(res.attempts, 3);
    assert.equal(res.empty, false);
    assert.equal(extract(res.response), "final answer");
    assert.equal(client.calls.sendPrompt, 3);
  });

  it("throws 'after 3 attempts' when every attempt errors", async () => {
    const client = makeClient({ sendPrompt: (n) => { throw new Error(`boom ${n}`); } });
    await assert.rejects(
      dispatchWithRetry(opts(client)),
      (err) => /Delegation failed after 3 attempts/.test(err.message) && /Last error: boom 3/.test(err.message),
    );
    assert.equal(client.calls.sendPrompt, 3);
  });

  it("returns on the first attempt when output is non-empty", async () => {
    const client = makeClient({ sendPrompt: () => ({ text: "hello world" }) });
    const res = await dispatchWithRetry(opts(client));
    assert.equal(res.attempts, 1);
    assert.equal(res.empty, false);
    assert.equal(extract(res.response), "hello world");
    assert.equal(client.calls.sendPrompt, 1);
  });

  it("does NOT retry an empty (non-stalled) turn and fails honestly", async () => {
    const client = makeClient({
      sendPrompt: () => ({ text: "   " }), // whitespace-only counts as empty
      usage: { total: 5000, output: 0, turns: 1 },
    });
    await assert.rejects(
      dispatchWithRetry(opts(client)),
      (err) =>
        /no output \(empty response\)/.test(err.message) &&
        /output token/i.test(err.message) &&
        /Not retried/.test(err.message),
    );
    // The whole point: an empty turn is deterministic, so exactly one call.
    assert.equal(client.calls.sendPrompt, 1);
  });

  it("omits the token note when usage is unavailable but still refuses to retry", async () => {
    const client = makeClient({ sendPrompt: () => ({ text: "" }) });
    client.getSessionUsage = async () => { throw new Error("usage unavailable"); };
    await assert.rejects(
      dispatchWithRetry(opts(client)),
      (err) =>
        /no output \(empty response\)/.test(err.message) &&
        /Not retried/.test(err.message) &&
        !/output token/i.test(err.message),
    );
    assert.equal(client.calls.sendPrompt, 1);
  });

  it("retries a stall (watchdog abort) and throws the stall message when every attempt stalls", async () => {
    // sendPrompt blocks until the session is aborted, then resolves EMPTY. The
    // watchdog must classify this as a retryable stall, NOT an empty result.
    const waiters = new Map();
    const calls = { sendPrompt: 0, abortSession: 0 };
    const client = {
      createSession: async () => ({ id: `s${Math.random().toString(36).slice(2)}` }),
      getSessionUsage: async () => ({ total: 0, output: 0, turns: 0 }), // never any progress
      abortSession: async (sessionId) => { calls.abortSession++; waiters.get(sessionId)?.(); },
      sendPrompt: async (sessionId) => {
        calls.sendPrompt++;
        await new Promise((res) => waiters.set(sessionId, res));
        return { text: "" }; // resolves empty AFTER the abort unblocks it
      },
    };
    await assert.rejects(
      dispatchWithRetry({
        client, prompt: "x", agent: "build", extract,
        makeSession: () => client.createSession(),
        beatMs: 10, stallMs: 20, backoffMs: 1,
      }),
      (err) => /Stalled \(no token progress\) on every one of 3 attempts/.test(err.message),
    );
    assert.equal(calls.sendPrompt, 3);
    assert.ok(calls.abortSession >= 3);
  });

  it("does NOT retry once shouldStop reports the job canceled (external cancel)", async () => {
    // A cancel arrives mid-attempt: sendPrompt throws (an aborted stream looks
    // like a transient fault), but shouldStop now reads canceled state, so the
    // task must NOT be re-run on a fresh session.
    let canceled = false;
    const client = makeClient({ sendPrompt: () => { canceled = true; throw new Error("aborted"); } });
    await assert.rejects(
      dispatchWithRetry(opts(client, { shouldStop: () => canceled })),
      (err) => /Delegation canceled/.test(err.message),
    );
    assert.equal(client.calls.sendPrompt, 1, "the write task ran once, not re-run after cancel");
  });

  it("bails before the first attempt when already canceled", async () => {
    const client = makeClient({ sendPrompt: () => ({ text: "should never run" }) });
    await assert.rejects(
      dispatchWithRetry(opts(client, { shouldStop: () => true })),
      (err) => /Delegation canceled/.test(err.message),
    );
    assert.equal(client.calls.sendPrompt, 0, "never dispatched a canceled job");
  });

  it("completes normally when shouldStop stays false", async () => {
    const client = makeClient({ sendPrompt: () => ({ text: "ok" }) });
    const res = await dispatchWithRetry(opts(client, { shouldStop: () => false }));
    assert.equal(res.attempts, 1);
    assert.equal(extract(res.response), "ok");
    assert.equal(client.calls.sendPrompt, 1);
  });
});
