// recoverStrandedResults — finalize must be a guarded CAS, and a probe FAILURE
// must not be treated as "the server has no answer".
//
// Regressions covered:
//  1. The recovery salvage upserted status:"completed" with NO status guard —
//     the only unguarded finalize in the codebase. The candidate set is
//     snapshotted BEFORE the (up to 8s) probe await, so a user cancel landing
//     mid-probe was silently overwritten back to "completed" AND a result data
//     file was persisted for a canceled job (double contract violation).
//  2. getSessionResult swallowed probe errors into {text:null, active:false},
//     indistinguishable from "idle with no answer" — so a transient timeout
//     against a busy server let reconcile mark a still-generating job failed.
//     It now throws; recovery logs the reason and keeps the job alive.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENCODE_COMPANION_DATA = mkdtempSync(join(tmpdir(), "oc-recovery-cas-"));

const { recoverStrandedResults } = await import("../plugins/opencode-companion/scripts/lib/job-control.mjs");
const { upsertJob, loadState, jobDataPath, jobLogPath } = await import("../plugins/opencode-companion/scripts/lib/state.mjs");

function ws() {
  return mkdtempSync(join(tmpdir(), "oc-recovery-ws-"));
}

// A recovery candidate: non-terminal, has a session, and a provably-dead pid.
function seedCandidate(w, id) {
  upsertJob(w, {
    id,
    type: "task",
    status: "running",
    opencodeSessionId: `ses_${id}`,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    pid: 999999999, // never a live pid
    pidStart: "1",
  });
}

describe("recoverStrandedResults — CAS finalize", () => {
  it("recovers a finished session: completed + data file + recovered flag", async () => {
    const w = ws();
    seedCandidate(w, "ok1");
    const client = {
      getSessionResult: async () => ({ text: "the recovered answer", active: false }),
      getSessionUsage: async () => ({ total: 10, output: 5 }),
    };
    await recoverStrandedResults(w, loadState(w).jobs, "http://127.0.0.1:1", { client, healthy: true });
    const j = loadState(w).jobs.find((x) => x.id === "ok1");
    assert.equal(j.status, "completed");
    assert.equal(j.recovered, true);
    assert.equal(existsSync(jobDataPath(w, "ok1")), true, "completed recovery persists its data file");
  });

  it("a cancel landing MID-PROBE wins: stays canceled, NO data file", async () => {
    const w = ws();
    seedCandidate(w, "race1");
    const client = {
      // Simulate the user's cancel landing while the probe is in flight.
      getSessionResult: async () => {
        upsertJob(w, { id: "race1", status: "canceled", errorMessage: "Canceled by user" });
        return { text: "answer that must NOT be persisted", active: false };
      },
      getSessionUsage: async () => null,
    };
    await recoverStrandedResults(w, loadState(w).jobs, "http://127.0.0.1:1", { client, healthy: true });
    const j = loadState(w).jobs.find((x) => x.id === "race1");
    assert.equal(j.status, "canceled", "the explicit cancel must not be overwritten");
    assert.equal(existsSync(jobDataPath(w, "race1")), false, "a canceled job must not persist a result data file");
  });

  it("an UNREACHABLE server keeps candidates alive instead of letting them fail terminally", async () => {
    // Regression: `if (!healthy) return jobs` left dead-worker candidates
    // untouched, reconcile marked them failed (terminal), and a finished answer
    // that the server still held became unrecoverable after a transient blip.
    const w = ws();
    seedCandidate(w, "blip1");
    await recoverStrandedResults(w, loadState(w).jobs, "http://127.0.0.1:1", { healthy: false });
    const j = loadState(w).jobs.find((x) => x.id === "blip1");
    assert.equal(j.status, "running");
    assert.equal(j.awaitingServer, true, "kept alive for the next poll (bounded by AWAIT_SERVER_MAX_MS)");
  });

  it("a shared session (--resume-last) probes each job with an UNTIL bound so answers don't cross-attribute", async () => {
    const w = ws();
    // Older job B and newer job A share one session; both stranded.
    upsertJob(w, { id: "olderB", type: "task", status: "running", opencodeSessionId: "ses_shared",
      createdAt: new Date(Date.now() - 120_000).toISOString(), pid: 999999999, pidStart: "1" });
    upsertJob(w, { id: "newerA", type: "task", status: "running", opencodeSessionId: "ses_shared",
      createdAt: new Date(Date.now() - 30_000).toISOString(), pid: 999999998, pidStart: "1" });
    const seen = [];
    const client = {
      getSessionResult: async (sid, opts) => { seen.push({ sid, since: opts.since, until: opts.until }); return { text: null, active: false }; },
      getSessionUsage: async () => null,
    };
    await recoverStrandedResults(w, loadState(w).jobs, "http://127.0.0.1:1", { client, healthy: true });
    const forOlder = seen.find((s) => s.since && s.until);
    assert.ok(forOlder, "the OLDER job's probe must carry an until bound (= the newer job's start)");
    assert.ok(forOlder.until > forOlder.since, "window must be ordered");
    const forNewer = seen.find((s) => !s.until);
    assert.ok(forNewer, "the NEWEST job on the session probes unbounded");
  });

  it("a probe FAILURE keeps the job alive (awaitingServer) and logs the reason", async () => {
    const w = ws();
    seedCandidate(w, "flaky1");
    const client = {
      getSessionResult: async () => { throw new Error("probe timed out after 8000ms"); },
      getSessionUsage: async () => null,
    };
    await recoverStrandedResults(w, loadState(w).jobs, "http://127.0.0.1:1", { client, healthy: true });
    const j = loadState(w).jobs.find((x) => x.id === "flaky1");
    assert.equal(j.status, "running", "a transient probe failure must not fail the job");
    assert.equal(j.awaitingServer, true, "kept alive for the next poll to retry");
    const log = readFileSync(jobLogPath(w, "flaky1"), "utf8");
    assert.match(log, /recovery probe failed: probe timed out/, "the reason is preserved in the job log");
  });
});
