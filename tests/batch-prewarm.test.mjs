// oc_delegate_batch must warm the OpenCode server exactly once BEFORE fanning
// out. Otherwise every concurrent handleDelegate calls connect()→ensureServer()
// and, on a cold start, they race to spawn `opencode serve` on the same port —
// the losers die with an earlyExit error. Pre-warming serializes only that
// first spawn; the injectable deps here let us assert it without a live server.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";

import { handleDelegateBatch } from "../plugins/opencode-companion/scripts/oc-companion.mjs";

const ok = () => ({ content: [{ type: "text", text: "ok" }] });

describe("handleDelegateBatch — cold-start pre-warm", () => {
  it("calls ensureServer exactly once before delegating, regardless of task count", async () => {
    let ensureCalls = 0;
    let delegateCalls = 0;
    const deps = {
      ensureServer: async () => { ensureCalls++; return { url: "http://x", alreadyRunning: false }; },
      handleDelegate: async () => { delegateCalls++; return ok(); },
    };
    const res = await handleDelegateBatch(
      { tasks: [{ task: "a" }, { task: "b" }, { task: "c" }], workspace: os.tmpdir() },
      undefined,
      deps
    );
    assert.equal(ensureCalls, 1, "server must be warmed exactly once");
    assert.equal(delegateCalls, 3, "each task must still be delegated");
    assert.equal(res.isError, undefined);
    assert.match(res.content[0].text, /3\/3 succeeded/);
  });

  it("does not pre-warm or fan out when validation fails (empty tasks)", async () => {
    let ensureCalls = 0;
    let delegateCalls = 0;
    const res = await handleDelegateBatch(
      { tasks: [] },
      undefined,
      {
        ensureServer: async () => { ensureCalls++; },
        handleDelegate: async () => { delegateCalls++; return ok(); },
      }
    );
    assert.equal(res.isError, true);
    assert.equal(ensureCalls, 0);
    assert.equal(delegateCalls, 0);
  });

  it("still fans out (best-effort) when the pre-warm rejects", async () => {
    let delegateCalls = 0;
    const deps = {
      ensureServer: async () => { throw new Error("cannot start"); },
      handleDelegate: async () => { delegateCalls++; return ok(); },
    };
    const res = await handleDelegateBatch(
      { tasks: [{ task: "a" }, { task: "b" }], workspace: os.tmpdir() },
      undefined,
      deps
    );
    assert.equal(delegateCalls, 2, "a failed pre-warm must not abort the batch");
    assert.match(res.content[0].text, /2\/2 succeeded/);
  });
});
