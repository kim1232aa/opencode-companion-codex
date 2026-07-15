// oc_cancel must not hang on a wedged OpenCode server.
//
// client.abortSession goes through request(), whose default timeout is 300s. A
// server that ACCEPTS the abort POST but never answers would therefore block
// oc_cancel for five minutes — and this path is hit on EVERY cancel of a running
// in-process delegation (each carries an opencodeSessionId), not just the shared
// -store case. handleCancel now wraps the abort in a 4s withTimeout and cancels
// the job regardless. Injected deps (createClient + abortTimeoutMs) let us prove
// the bound without a real hanging socket.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENCODE_COMPANION_DATA = mkdtempSync(join(tmpdir(), "oc-cancel-timeout-"));
process.env.OPENCODE_SERVER_PORT = "1"; // never reach a real server even if a fallback slips

const { handleCancel } = await import("../plugins/opencode-companion/scripts/oc-companion.mjs");
const { upsertJob, loadState } = await import("../plugins/opencode-companion/scripts/lib/state.mjs");

function ws() {
  return mkdtempSync(join(tmpdir(), "oc-cancel-timeout-ws-"));
}

describe("oc_cancel — abort is time-bounded", () => {
  const SID = "OPENCODE_COMPANION_SESSION_ID";
  let savedSid;
  beforeEach(() => { savedSid = process.env[SID]; process.env[SID] = "TS1"; });
  afterEach(() => { if (savedSid === undefined) delete process.env[SID]; else process.env[SID] = savedSid; });

  it("does not hang when abortSession never resolves — cancels within the bound", async () => {
    const w = ws();
    upsertJob(w, { id: "hang1", type: "task", status: "running", sessionId: "TS1", opencodeSessionId: "ses_hang" });

    let abortCalled = false;
    const deps = {
      // A server that accepts the abort but never replies.
      createClient: () => ({ abortSession: () => { abortCalled = true; return new Promise(() => {}); } }),
      abortTimeoutMs: 50, // stand-in for the real 4000ms bound, kept small for the test
    };

    const start = Date.now();
    const res = await handleCancel({ workspace: w }, undefined, deps);
    const elapsed = Date.now() - start;

    assert.equal(abortCalled, true, "the abort must actually be attempted");
    assert.ok(elapsed < 2000, `cancel must return promptly, not wait out the 300s default (took ${elapsed}ms)`);
    assert.match(res.content[0].text, /Canceled 1 job: hang1/);
    // The job is canceled even though the abort timed out — CAS runs regardless.
    assert.equal(loadState(w).jobs.find((j) => j.id === "hang1").status, "canceled");
  });

  it("still cancels when abortSession rejects (server down)", async () => {
    const w = ws();
    upsertJob(w, { id: "down1", type: "task", status: "running", sessionId: "TS1", opencodeSessionId: "ses_down" });

    const deps = {
      createClient: () => ({ abortSession: () => Promise.reject(new Error("ECONNREFUSED")) }),
      abortTimeoutMs: 50,
    };

    const res = await handleCancel({ workspace: w }, undefined, deps);
    assert.match(res.content[0].text, /Canceled 1 job: down1/);
    assert.equal(loadState(w).jobs.find((j) => j.id === "down1").status, "canceled");
  });

  it("resolves fast on the happy path (abort returns immediately)", async () => {
    const w = ws();
    upsertJob(w, { id: "ok1", type: "task", status: "running", sessionId: "TS1", opencodeSessionId: "ses_ok" });

    let called = 0;
    const deps = {
      createClient: () => ({ abortSession: () => { called++; return Promise.resolve({}); } }),
      abortTimeoutMs: 4000,
    };

    const res = await handleCancel({ workspace: w }, undefined, deps);
    assert.equal(called, 1);
    assert.match(res.content[0].text, /Canceled 1 job: ok1/);
    assert.equal(loadState(w).jobs.find((j) => j.id === "ok1").status, "canceled");
  });
});
