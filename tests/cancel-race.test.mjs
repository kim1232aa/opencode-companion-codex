// oc_cancel vs an in-flight delegation: the REAL-path race.
//
// Regression (proven by live repro during audit): handleCancel awaited
// abortSession BEFORE CASing the job to "canceled". The abort unblocked the
// in-flight dispatch, runTrackedJob's finalize saw a still-"running" status,
// and the canceled job finalized "completed" WITH a result data file — while
// oc_cancel then reported "Already finished (not canceled)". handleCancel now
// CASes every target first (mirroring CC's cancelJobsAndCleanup), so the
// shared finalize CAS sees the cancel and skips.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENCODE_COMPANION_DATA = mkdtempSync(join(tmpdir(), "oc-cancel-race-"));
process.env.OPENCODE_SERVER_PORT = "1";

const { handleCancel } = await import("../plugins/opencode-companion/scripts/oc-companion.mjs");
const { runTrackedJob, createJobRecord } = await import("../plugins/opencode-companion/scripts/lib/tracked-jobs.mjs");
const { loadState, upsertJob, jobDataPath } = await import("../plugins/opencode-companion/scripts/lib/state.mjs");

function ws() {
  return mkdtempSync(join(tmpdir(), "oc-cancel-race-ws-"));
}

describe("oc_cancel racing a live runTrackedJob", () => {
  it("cancel wins: job ends canceled with NO data file, even when the aborted dispatch returns normally", async () => {
    const w = ws();
    const job = createJobRecord(w, "task", {});
    upsertJob(w, { id: job.id, opencodeSessionId: "ses_race" });

    // The in-flight dispatch: blocks until "the server aborts it", then RETURNS
    // NORMALLY with partial output (exactly how an aborted sendPrompt behaves).
    let releaseDispatch;
    const dispatchGate = new Promise((r) => { releaseDispatch = r; });
    const running = runTrackedJob(w, job, async () => {
      await dispatchGate;
      return { rendered: "partial output from the aborted turn", summary: "partial" };
    });

    // oc_cancel with a client whose abortSession "reaches the server" (unblocks
    // the dispatch) but whose HTTP response takes a moment to come back.
    const deps = {
      createClient: () => ({
        abortSession: async () => {
          releaseDispatch();
          await new Promise((r) => setTimeout(r, 100)); // response lag
          return {};
        },
      }),
      abortTimeoutMs: 4000,
    };

    const res = await handleCancel({ workspace: w }, undefined, deps);
    await running; // let the aborted dispatch finalize through runTrackedJob

    const j = loadState(w).jobs.find((x) => x.id === job.id);
    assert.equal(j.status, "canceled", "the cancel must not be overwritten by a bogus 'completed'");
    assert.equal(existsSync(jobDataPath(w, job.id)), false, "no result data file for a canceled job");
    assert.match(res.content[0].text, /Canceled 1 job/, "oc_cancel must report the cancel, not 'Already finished'");
  });
});
