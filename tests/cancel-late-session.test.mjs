// A batch's sub-delegations share the batch tools/call requestId. When
// notifications/cancelled fires, the handler snapshots `inflight` ONCE — a
// sub-delegation whose OpenCode session is created AFTER that snapshot would
// miss it and run to completion (its tokens still burning). registerSession now
// consults canceledRequests: a session created after the cancel self-cancels its
// job immediately instead of slipping past.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENCODE_COMPANION_DATA = mkdtempSync(join(tmpdir(), "oc-late-cancel-"));
process.env.OPENCODE_SERVER_PORT = "1"; // any stray abort hits a dead port and fails fast

const { registerSession, noteRequestCanceled, isRequestCanceled } = await import(
  "../plugins/opencode-companion/scripts/oc-companion.mjs"
);
const { upsertJob, loadState } = await import("../plugins/opencode-companion/scripts/lib/state.mjs");

function ws() {
  return mkdtempSync(join(tmpdir(), "oc-late-cancel-ws-"));
}

describe("late-registering session self-cancels when its request was already canceled", () => {
  it("isRequestCanceled flips only after noteRequestCanceled", () => {
    assert.equal(isRequestCanceled("req-A"), false);
    assert.equal(isRequestCanceled(undefined), false); // a missing requestId is never 'canceled'
    noteRequestCanceled("req-A");
    assert.equal(isRequestCanceled("req-A"), true);
  });

  it("a session registered AFTER the cancel is marked canceled immediately", () => {
    const w = ws();
    upsertJob(w, { id: "late1", type: "task", status: "running", sessionId: "S" });
    // Cancel arrives BEFORE this sub created its session (the race the fix closes).
    noteRequestCanceled("req-late");
    registerSession("req-late", w, "late1", "ses_late");
    // The job must be canceled, not left running to completion.
    assert.equal(loadState(w).jobs.find((j) => j.id === "late1").status, "canceled");
  });

  it("a session registered with no pending cancel keeps running", () => {
    const w = ws();
    upsertJob(w, { id: "ok1", type: "task", status: "running", sessionId: "S" });
    registerSession("req-ok", w, "ok1", "ses_ok");
    const j = loadState(w).jobs.find((x) => x.id === "ok1");
    assert.equal(j.status, "running");
    // It DID register its session id (so a later cancel can reach it).
    assert.equal(j.opencodeSessionId, "ses_ok");
  });
});
